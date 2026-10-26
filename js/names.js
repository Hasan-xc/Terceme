/**
 * names.js — كشف الأسماء والمصطلحات وإضافتها إلى القاموس
 *
 * الفكرة:
 *  - بعد التفريغ، يقرأ النموذج الحالي (OpenRouter/Kie) عيّنة موزّعة من النص الأصلي.
 *  - يستخرج أسماء الأشخاص والأماكن والجهات والعلامات التجارية وصيغها المختصرة.
 *  - يضيفها كأزواج (من المصدر → الترجمة الثابتة) في قاموس المصطلحات.
 *
 * الميزة معزولة: أي فشل هنا لا يمس التفريغ أو الترجمة أو القاموس المحفوظ.
 */

import { state } from './state.js';
import { $, toast } from './ui.js';
import { getSelectedOrModel } from './models.js';
import {
  buildVideoBriefSample, chatCompletion, executeKieRequest
} from './translate.js';
import {
  addGlossaryPairs, getGlossaryPairs, openGlossary
} from './glossary.js';

// واجهة الشخصيات المتقدمة (الاسم/الجنس/الأسلوب) — تنفيذها في personas.js
// ونعيد تصديرها هنا حتى تبقى نقطة الدخول المنطقية للأسماء في names.js.
export { getPersonas, getPersonaPromptBlock, addPersona, removePersona, initPersonas } from './personas.js';

let namesBusy = false;

/** ينظّف رد النموذج من أسوار Markdown ويستخرج أول كائن JSON. */
function extractJson(raw){
  if(!raw || typeof raw !== 'string') return null;
  const text = raw.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(text); }
  catch(_) {
    const obj = text.match(/\{[\s\S]*\}/);
    if(obj){ try { return JSON.parse(obj[0]); } catch(_){} }
    const arr = text.match(/\[[\s\S]*\]/);
    if(arr){ try { return JSON.parse(arr[0]); } catch(_){} }
  }
  return null;
}

function cleanPair(item){
  if(!item || typeof item !== 'object') return null;
  const source = String(
    item.source || item.from || item.name || item.term || ''
  ).replace(/\s+/g, ' ').trim();
  const target = String(
    item.target || item.to || item.translation || item.translated || ''
  ).replace(/\s+/g, ' ').trim();
  if(!source || !target) return null;
  if(source.length > 160 || target.length > 160) return null;
  if(!/\p{L}/u.test(source) || !/\p{L}/u.test(target)) return null;
  return { source, target };
}

/** تطبيع بسيط للبحث عن الاسم داخل النص (حروف صغيرة + مسافات موحّدة). */
function normalizeForMatch(value){
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** هل الاسم موجود فعلاً في النص الذي رآه النموذج؟ (حماية من الهلوسة). */
function existsInTranscript(source, transcript){
  const hay = normalizeForMatch(transcript);
  const needle = normalizeForMatch(source);
  if(!hay || !needle) return false;
  if(hay.includes(needle)) return true;
  // تجاهل علامات الترقيم المحيطة بالاسم عند المقارنة
  const looseHay = ' ' + hay.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const looseNeedle = ' ' + needle.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
  return looseNeedle.trim().length > 1 && looseHay.includes(looseNeedle);
}

/**
 * يحوّل رد النموذج إلى أزواج قاموس صالحة.
 * يقبل: {"pairs":[...]} أو {"names":[...]} أو مصفوفة مباشرة.
 * @param {string} raw رد النموذج
 * @param {string} transcript النص الذي أُرسل للنموذج (للتحقق)
 * @returns {Array<{source:string,target:string}>}
 */
export function parseDetectedNamePairs(raw, transcript = ''){
  const data = extractJson(raw);
  if(!data) return [];

  let list = [];
  if(Array.isArray(data)) list = data;
  else if(Array.isArray(data.pairs)) list = data.pairs;
  else if(Array.isArray(data.names)) list = data.names;
  else if(Array.isArray(data.terms)) list = data.terms;
  else return [];

  const out = [];
  const seen = new Set();
  for(const item of list){
    const pair = cleanPair(item);
    if(!pair) continue;
    if(transcript && !existsInTranscript(pair.source, transcript)) continue;
    const key = pair.source.toLowerCase();
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
    if(out.length >= 40) break;
  }
  return out;
}

/** يبني برومبت كشف الأسماء (نقي — قابل للاختبار). */
export function buildNameDetectionPrompt(sample, srcLang, targetLang, existingPairs = []){
  const sourceLabel = (srcLang === 'auto') ? 'the source language (auto-detect)' : srcLang;
  const existing = (Array.isArray(existingPairs) ? existingPairs : [])
    .slice(0, 80)
    .map(p => `- "${p.from}" => "${p.to}"`)
    .join('\n');

  return {
    systemPrompt:
`You are a meticulous proper-noun extractor for subtitle translation glossaries.
Read the transcript sample and identify proper nouns that should have a fixed translation: people's names, place names, cities, countries, organizations, brands, titles, and named entities.

Rules:
- Only proper nouns and named terms. Never include common words, verbs, adjectives, or generic phrases.
- Use the source spelling exactly as it appears in the transcript.
- The target must be the established spelling or natural transliteration in the target language. Do not translate people's names literally.
- Include shorter variants that appear independently as separate pairs. Example: "Haydar Ali" => "حيدر علي", "Haydar" => "حيدر", "Ali" => "علي".
- Do not invent names that are not present in the transcript.
- Skip anything already listed in the existing glossary.
- Return at most 40 pairs.
- Return ONLY a valid JSON object with this exact shape:
{"pairs":[{"source":"source spelling","target":"fixed translation"}]}
Do not add any text outside the JSON object.`,
    userPrompt:
`Source language: ${sourceLabel}
Target language: ${targetLang}
${existing ? `\nExisting glossary (skip these):\n${existing}\n` : ''}
Transcript sample:
${sample}`
  };
}

function friendlyError(err){
  if(err && err.status === 401) return 'المفتاح غير صحيح (401)';
  if(err && err.status === 402) return 'الرصيد منتهٍ (402) — عبّئ رصيدك أولاً';
  if(err && err.status === 403) return 'غير مصرح بالوصول (403)';
  if(err && err.status === 429) return 'تجاوزت حد الطلبات (429) — انتظر قليلاً ثم أعد المحاولة';
  if(err && err.status === 408) return 'انتهت مهلة الاستجابة — أعد المحاولة';
  return (err && err.message) ? err.message : 'خطأ غير معروف';
}

/**
 * الزر الرئيسي: يكشف الأسماء من النص الحالي ويضيفها للقاموس.
 * لا يعمل أثناء الترجمة، ولا يرسل أي طلب بلا مفتاح أو نص.
 */
export async function detectNamesToGlossary(){
  if(namesBusy) return;
  if(state.currentTask){
    return toast(state.currentTask === 'align'
      ? 'انتظر انتهاء مزامنة التوقيت أولاً'
      : 'انتظر انتهاء الترجمة الحالية أولاً', '⏳');
  }

  const hasText = state.blocks.some(b => (b.text || '').trim() !== '');
  if(!hasText) return toast('لا يوجد نص أصلي — فرّغ الصوت أو ألصق نصاً أولاً', '⚠️');

  const isKie = state.trProvider === 'kie';
  const apiKey = ($(isKie ? 'kieKeyIn' : 'orKeyIn')?.value || '').trim();
  if(!apiKey) return toast(isKie ? 'أدخل Kie.ai API Key أولاً' : 'أدخل OpenRouter API Key أولاً', '⚠️');

  const model = isKie ? 'gpt-6-luna' : getSelectedOrModel();
  if(!isKie && !model) return toast('أضف موديل OpenRouter أولاً', '⚠️');

  const sample = buildVideoBriefSample(state.blocks);
  if(!sample.trim()) return toast('لا يوجد نص كافٍ لكشف الأسماء', '⚠️');

  const srcLang = $('trSrcLang')?.value || 'auto';
  const targetLang = $('trTargetLang')?.value || 'Arabic';
  const promptData = buildNameDetectionPrompt(sample, srcLang, targetLang, getGlossaryPairs());

  const btn = $('detectNamesBtn');
  const previousLabel = btn ? btn.textContent : '';
  const previousDisabled = btn ? btn.disabled : false;
  namesBusy = true;
  if(btn){
    btn.disabled = true;
    btn.textContent = '⏳ جاري كشف الأسماء...';
  }
  toast('جارٍ البحث عن الأسماء والمصطلحات...', '🔎');

  try {
    const raw = isKie
      ? await executeKieRequest(promptData, model, apiKey)
      : await chatCompletion(promptData, model, apiKey);

    const pairs = parseDetectedNamePairs(raw, sample);
    if(!pairs.length){
      toast('لم أجد أسماء واضحة في النص', 'ℹ️');
      return;
    }

    const result = addGlossaryPairs(pairs);
    if(result.added > 0){
      toast(`تمت إضافة ${result.added} ${result.added === 1 ? 'اسم/مصطلح' : 'أسماء/مصطلحات'} إلى القاموس`, '📖');
      openGlossary();
    } else {
      toast('كل الأسماء المكتشفة موجودة في القاموس مسبقاً', 'ℹ️');
    }
  } catch(err){
    console.warn('[names] detect failed:', (err && err.message) || err);
    toast('تعذر كشف الأسماء: ' + friendlyError(err), '❌');
  } finally {
    namesBusy = false;
    if(btn){
      btn.disabled = previousDisabled;
      btn.textContent = previousLabel;
    }
  }
}
