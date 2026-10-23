/**
 * translate.js — محرك الترجمة (OpenRouter / Kie.ai)
 *
 * المحاور الأساسية:
 *  - دفعات: هدف 30 سطراً، سقف صلب 38، وسقف 4000 حرف مع القطع عند نهاية الجملة
 *  - سياق أصلي (10 سابقة + 3 لاحقة) وملف تعريف فيديو تمهيدي لتحسين الدقة
 *  - Worker pool (CONCURRENCY=3) بجدولة ديناميكية: أي دفعة تنتهي تبدأ التالية فوراً
 *  - تكيّف تلقائي عند 429: نزّل الحد الفعلي للتزامن، وارتفع تدريجياً بعد النجاحات
 *  - إرسال الأسطر ككائن مرقّم محلي {"1":"..","2":".."} لمنع انزلاق الأسطر
 *  - إيقاف فوري عبر AbortController مشترك يقطع كل الطلبات الجارية
 *  - معالجة الناقص: إعادة إرسال (حتى جولتين) + تقسيم الدفعة نصفين عند الفشل الكامل
 *  - زر «🔁 أعد ترجمة الناقص» للأسطر الفاشلة نهائياً (تبقى بنصها الأصلي)
 *
 * لا يحتوي على أي مفاتيح — كل الاستدعاءات عبر apiRequest() في apiClient.js.
 */

import { state, setActiveTab } from './state.js';
import { $, toast, setText, setBar, setVisible } from './ui.js';
import { renderCards, updateTranslatedCards, updateTabCounts } from './editor.js';
import { captureHistory } from './history.js';
import { scheduleAutoSave } from './autosave.js';
import { apiRequest, API_ENDPOINTS } from './apiClient.js';
import { getGlossaryPromptBlock, getGlossaryPairs } from './glossary.js';
import { getSelectedOrModel } from './models.js';

/* ═══════════════════════════════════════
   الثوابت وضبط الدفعات
═══════════════════════════════════════ */
const BATCH_SIZE = 30;           // الهدف الافتراضي لعدد أسطر الدفعة
const MAX_BATCH_CHARS = 4000;    // سقف الأحرف لكل دفعة
const BATCH_HARD_MAX = 38;       // السقف الصلب لعدد الأسطر
const BATCH_SENTENCE_MIN = 22;   // بداية نافذة البحث عن نهاية جملة
const CONTEXT_BEFORE = 10;       // أسطر أصلية سابقة تُرسل كسياق
const CONTEXT_AFTER = 3;         // أسطر أصلية لاحقة تُرسل كسياق
const BRIEF_MAX_CHARS = 12000;   // أقصى نص يُرسل لملف تعريف الفيديو
const CONCURRENCY = 3;           // الحد الأقصى للتزامن
const MIN_CONCURRENCY = 1;       // أدنى حد بعد انخفاض 429
const RECOVERY_HIT = 5;          // كل هذا العدد من النجاحات المتتالية → +1 تزامن
const RETRY_ROUNDS = 2;          // جولات إضافية لإعادة إرسال الناقص فقط
const SPLIT_DEPTH = 2;           // أعمق تقسيم للدفعة الفاشلة كاملة
const REQUEST_TIMEOUT = 60000;   // مهلة كل محاولة شبكة (ثواني → 60)
const RETRY_DELAYS = [1000, 2000, 4000];  // تأخيرات الإعادة + jitter صغير

/* ═══════════════════════════════════════
   حالة تشغيل المهمة (مشتركة بين الدفعات)
═══════════════════════════════════════ */
let runAbort = null;      // AbortController مشترك — يقطع كل الطلبات الجارية دفعة واحدة
let failedIds = [];       // معرّفات الأسطر التي فشلت نهائياً (زر إعادة الناقص)
let lastHardErr = null;   // آخر خطأ صلب/شبكي — يُعرض في رسالة النهاية (كان يُبتلع)

let adapt = { limit: CONCURRENCY, active: 0, okStreak: 0, saw429: false };
let doneCount = 0;
let totalCount = 0;
let fatalMsg = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ═══════════════════════════════════════
   أدوات الشبكة (مهلة + إجهاض + أخطاء)
═══════════════════════════════════════ */
function cancelledError(){
  const e = new Error('cancelled');
  e.cancelled = true;
  return e;
}

/** إشارة طلب واحدة: مهلة 60s + ربط بالإجهاض المركزي (runAbort) */
function requestSignal(){
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch(_){} }, REQUEST_TIMEOUT);
  const onCancel = () => { try { ctrl.abort(); } catch(_){} };
  if (runAbort && runAbort.signal) {
    if (runAbort.signal.aborted) { try { ctrl.abort(); } catch(_){} }
    else runAbort.signal.addEventListener('abort', onCancel);
  }
  return {
    ctrl,
    isTimeout: () => timedOut,
    cleanup(){
      clearTimeout(timer);
      if (runAbort && runAbort.signal) runAbort.signal.removeEventListener('abort', onCancel);
    }
  };
}

/** توحيد أخطاء الشبكة: إجهاض / مهلة / خطأ شبكة قابل للإعادة */
function normalizeRequestError(err, sig){
  if (err && (err.cancelled || err.fatal || err.status)) return err;
  if (runAbort && runAbort.signal && runAbort.signal.aborted) return cancelledError();
  if (sig && sig.isTimeout()){
    const e = new Error('انتهت مهلة الاستجابة (' + Math.round(REQUEST_TIMEOUT/1000) + ' ثانية)');
    e.status = 408; e.timeout = true; e.retryable = true;
    return e;
  }
  const msg = (err && err.message) ? err.message : 'فشل الاتصال بالشبكة';
  const e = new Error(msg);
  e.retryable = true;
  return e;
}

function isRetryable(err){
  if (!err) return false;
  if (err.timeout || err.retryable) return true;
  if (!err.status) return true;
  return err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504;
}

async function buildHttpError(res){
  let msg = 'HTTP ' + res.status;
  try {
    const d = await res.json();
    const cand = d?.error?.message || d?.error || d?.message || d?.detail || msg;
    msg = (typeof cand === 'string') ? cand : JSON.stringify(cand);
  } catch(_){}
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

function onStatus(status){
  if (status === 429) adapt.saw429 = true;
}

function backoff(baseMs){
  return sleep(baseMs + Math.floor(Math.random() * 150));
}

function kieFatalMessage(status, msg){
  if (status === 401) return 'مفتاح Kie.ai غير صحيح (401)';
  if (status === 402) return 'رصيد Kie.ai منتهٍ (402) — عبّئ رصيدك في لوحة Kie';
  if (status === 403) return 'غير مصرح بالوصول إلى Kie.ai (403)';
  if (status === 400) return 'طلب غير مقبول لدى Kie.ai (400): ' + (msg || '');
  return msg || ('فشل الاستدعاء من Kie.ai (' + status + ')');
}

/* ═══════════════════════════════════════
   واجهة التقدم والتحكم
═══════════════════════════════════════ */
export function checkTrReady(){
  const btnTr = $('trRunBtn');
  const kieIn = $('kieKeyIn');
  const orIn  = $('orKeyIn'); // حقل مفتاح OpenRouter في رأس القسم (يُحفظ تلقائياً)
  const hasKey = (state.trProvider === 'kie')
    ? !!(kieIn && kieIn.value.trim())
    : !!(orIn && orIn.value.trim());
  const hasBlocks = state.blocks.length > 0;
  if (btnTr) btnTr.disabled = !(hasKey && hasBlocks && !state.currentTask);
  updateRetryButton();
}

function setTrStatus(msg){
  setText('trProgStatus', msg);
}

function switchTaskUI(isRunning){
  setVisible('trStartBox', !isRunning, 'flex');
  setVisible('trStopBox', isRunning, 'flex');
}

/** الناقص الحقيقي من البيانات: سطر أصلي غير فارغ بلا ترجمة. */
function getMissingBlocks(){
  return state.blocks.filter(b => (b.text || '').trim() !== '' && (b.tr || '').trim() === '');
}

function updateRetryButton(){
  const missing = getMissingBlocks();
  setVisible('trRetryBtn', !state.currentTask && missing.length > 0, 'flex');
  const label = $('trRetryLabel');
  if(label) label.textContent = missing.length ? `أعد ترجمة الناقص (${missing.length})` : 'أعد ترجمة الناقص';
}

function updateProgress(){
  const pct = totalCount ? Math.min(100, Math.round((doneCount / totalCount) * 100)) : 0;
  setBar('trProgBar', pct);
  setTrStatus(`🌍 جارٍ الترجمة... <b>${doneCount}</b> / ${totalCount} سطراً &nbsp;•&nbsp; الحد الفعلي للتزامن: ${adapt.limit}`);
  updateTabCounts();
}

export function cancelAiTask(){
  if (!state.currentTask) return;
  state.cancelRequested = true;
  if (runAbort) runAbort.abort();
  setTrStatus('⏳ جاري إيقاف العملية... (تُقطع الطلبات الجارية الآن)');
  toast('جاري الإيقاف','⏹️');
}

/* ═══════════════════════════════════════
   بناء البرومبتات (كائن مرقّم لمنع انزلاق الأسطر)
═══════════════════════════════════════ */
const TARGET_LANGS = {
  'Arabic':   'Modern Standard Arabic (العربية الفصحى المعاصرة)',
  'English':  'natural, fluent English (English)',
  'Turkish':  'natural, fluent Turkish (Türkçe)',
  'Spanish':  'natural, fluent Spanish (Español)',
  'French':   'natural, fluent French (Français)',
  'German':   'natural, fluent German (Deutsch)',
  'Russian':  'natural, fluent Russian (Русский)'
};

function targetLangDesc(lang){
  return TARGET_LANGS[lang] || TARGET_LANGS['Arabic'];
}

function formatVideoBrief(brief){
  if(!brief || typeof brief !== 'object') return '';
  const lines = [];
  if(brief.topic) lines.push('Topic: ' + brief.topic);
  if(brief.tone) lines.push('Tone/style: ' + brief.tone);
  if(Array.isArray(brief.names) && brief.names.length){
    const names = brief.names.map(n => {
      if(typeof n === 'string') return n;
      const source = (n && (n.source || n.from || n.name)) || '';
      const target = (n && (n.target || n.to || n.translation)) || '';
      return source ? `${source} => ${target || source}` : '';
    }).filter(Boolean);
    if(names.length) lines.push('Names/places/brands (keep fixed): ' + names.join('; '));
  }
  if(brief.notes) lines.push('Notes: ' + brief.notes);
  if(!lines.length) return '';
  return `\nVIDEO BRIEF (context and style guide for consistency only — do not translate or add it to the output):\n${lines.join('\n')}\n`;
}

function buildTranslationPrompt(linesObj, srcLang, targetLang, context = {}, brief = null){
  const sourceLabel = (srcLang === 'auto') ? 'the source language (auto-detect)' : srcLang;
  const targetDesc = targetLangDesc(targetLang);
  const count = Object.keys(linesObj).length;

  // قاموس المصطلحات: أعلى أولوية دائماً، حتى فوق ملف تعريف الفيديو.
  const glossaryBlock = getGlossaryPromptBlock();
  const glossaryRule = glossaryBlock
    ? `\nGLOSSARY (HIGHEST PRIORITY — the fixed terminology below overrides VIDEO BRIEF and any other context):\n${glossaryBlock}`
    : '';
  const briefBlock = formatVideoBrief(brief);

  const systemPrompt =
`You are a world-class subtitle translator. Translate the source text into ${targetDesc} with high linguistic accuracy, fluency and naturalness (not literal).
Source language: ${sourceLabel}. Target language: ${targetLang}.

STRICT RULES:
1. Translate each subtitle line into ${targetDesc} naturally and contextually.
2. Keep personal/brand names in their recognizable form.
3. Return the EXACT SAME keys as the input object, with EXACTLY ONE translation per key. Do NOT merge, split, delete, reorder, or add any key.
4. For empty strings, return "".
5. Translate ONLY the keys inside LINES_TO_TRANSLATE. CONTEXT_BEFORE and CONTEXT_AFTER are for understanding only: do NOT translate them, repeat them, merge them, or include them in the output.
6. If a line continues a sentence that started in the previous line, translate that part so it connects naturally to the preceding line without repeating words.
7. Use ALREADY_TRANSLATED_CONTEXT (when present) to keep the same names, terminology and style.
8. Output ONLY a valid JSON object with a key "translations" that maps each input key (as a string) to its translated string.
${briefBlock}
${glossaryRule}
OUTPUT FORMAT:
{"translations": {"1": "line 1", "2": "line 2"}}`;

  const userParts = [];
  userParts.push(`CONTEXT_BEFORE (previous original lines — understanding only, never translate or repeat):\n${JSON.stringify(context.before || [], null, 2)}`);
  if(Array.isArray(context.translated) && context.translated.length){
    userParts.push(`ALREADY_TRANSLATED_CONTEXT (source => translation; keep these names/terms/style consistent):\n${JSON.stringify(context.translated, null, 2)}`);
  }
  userParts.push(`LINES_TO_TRANSLATE (translate ONLY these numbered keys):\n${JSON.stringify(linesObj, null, 2)}`);
  if(Array.isArray(context.after) && context.after.length){
    userParts.push(`CONTEXT_AFTER (next original lines — understanding only, never translate or repeat):\n${JSON.stringify(context.after, null, 2)}`);
  }
  userParts.push(`Translate the following ${count} subtitle lines from ${sourceLabel} to ${targetDesc}. Return exactly the same numbered keys, one translation per key, in one valid JSON object.`);

  return { systemPrompt, userPrompt: userParts.join('\n\n') };
}

/** تحويل الأسطر المرسلة إلى كائن مرقّم محلي — الأسطر الفارغة لا تُرسل أبداً */
function numberedObject(entries){
  const obj = {};
  for (const e of entries) obj[e.key] = (e.block.text || '').trim();
  return obj;
}

/** هل ينتهي السطر بعلامة نهاية جملة (مع اقتباس/قوس اختياري بعدها)؟ */
function endsSentence(text){
  return /[.!?؟…]["'”’»)\]]*\s*$/.test((text || '').trim());
}

/**
 * سياق الدفعة من النص الأصلي (block.text):
 * - 10 أسطر سابقة + 3 لاحقة
 * - أزواج (أصل ← ترجمة) للسابق المترجم فقط
 */
function buildBatchContext(pending, allBlocks){
  if(!Array.isArray(pending) || !pending.length) return { before: [], translated: [], after: [] };
  const blocks = Array.isArray(allBlocks) ? allBlocks : [];
  const first = Number.isInteger(pending[0].sourceIndex) ? pending[0].sourceIndex : 0;
  const last = Number.isInteger(pending[pending.length - 1].sourceIndex) ? pending[pending.length - 1].sourceIndex : first;

  const usable = (b) => b && (b.text || '').trim() !== '';
  const beforeBlocks = blocks.slice(0, Math.max(0, first)).filter(usable).slice(-CONTEXT_BEFORE);
  const afterBlocks = blocks.slice(last + 1).filter(usable).slice(0, CONTEXT_AFTER);

  return {
    before: beforeBlocks.map(b => (b.text || '').trim()),
    translated: beforeBlocks
      .filter(b => (b.tr || '').trim() !== '')
      .map(b => ({ source: (b.text || '').trim(), translation: (b.tr || '').trim() })),
    after: afterBlocks.map(b => (b.text || '').trim())
  };
}

/**
 * تقسيم الأسطر إلى دفعات: هدف 30 سطراً، بحث عن نهاية جملة بين 22 و38،
 * سقف صلب 38 سطراً، وسقف 4000 حرف. المفاتيح تُرقَّم محلياً 1..N لكل دفعة.
 */
function buildBatches(rows){
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row, i) => (row && row.block) ? row : { block: row, sourceIndex: i })
    .filter(row => row.block && (row.block.text || '').trim() !== '');
  const batches = [];
  let i = 0;

  while(i < normalized.length){
    const remaining = normalized.length - i;
    let end = Math.min(i + BATCH_SIZE, normalized.length);

    // نافذة نهاية الجملة: الأسطر 22..38 من بداية الدفعة
    if(remaining >= BATCH_SENTENCE_MIN){
      const windowStart = i + BATCH_SENTENCE_MIN - 1;
      const windowEnd = Math.min(i + BATCH_HARD_MAX, normalized.length) - 1;
      let sentenceEnd = -1;
      for(let j = windowEnd; j >= windowStart; j--){
        if(endsSentence(normalized[j].block.text)){
          sentenceEnd = j + 1;
          break;
        }
      }
      if(sentenceEnd > i) end = sentenceEnd;
    }

    // سقف الأحرف: نقلّص النهاية عند الحاجة (مع ضمان تقدّم سطر واحد على الأقل)
    let chars = 0;
    let capEnd = i;
    while(capEnd < end){
      const len = (normalized[capEnd].block.text || '').trim().length;
      if(capEnd > i && chars + len > MAX_BATCH_CHARS) break;
      chars += len;
      capEnd++;
    }
    if(capEnd === i) capEnd = i + 1;
    end = capEnd;

    const batch = normalized.slice(i, end).map((row, idx) => ({
      key: String(idx + 1),
      block: row.block,
      sourceIndex: row.sourceIndex
    }));
    batches.push(batch);
    i = end;
  }
  return batches;
}

/** نص موزّع بالتساوي لملف تعريف الفيديو (بحد 12000 حرف). */
function buildVideoBriefSample(blocks){
  const text = (Array.isArray(blocks) ? blocks : [])
    .map(b => (b && b.text ? b.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
  if(!text) return '';
  if(text.length <= BRIEF_MAX_CHARS) return text;

  const samples = 24;
  const chunk = Math.floor(BRIEF_MAX_CHARS / samples);
  const out = [];
  for(let i = 0; i < samples; i++){
    let start = Math.round(i * Math.max(0, text.length - chunk) / (samples - 1));
    const nl = text.indexOf('\n', start);
    if(nl !== -1 && nl < start + 80) start = nl + 1;
    out.push(text.slice(start, start + chunk));
  }
  return out.join('\n').slice(0, BRIEF_MAX_CHARS);
}

function parseVideoBrief(raw){
  if(!raw || typeof raw !== 'string') return null;
  let clean = raw.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let obj = null;
  try { obj = JSON.parse(clean); }
  catch(_) {
    const m = clean.match(/\{[\s\S]*\}/);
    if(m){ try { obj = JSON.parse(m[0]); } catch(_){} }
  }
  if(!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const names = Array.isArray(obj.names) ? obj.names.map(n => {
    if(typeof n === 'string') return { source: n, target: n };
    return {
      source: String((n && (n.source || n.from || n.name)) || '').trim(),
      target: String((n && (n.target || n.to || n.translation)) || '').trim()
    };
  }).filter(n => n.source) : [];
  return {
    topic: String(obj.topic || '').trim(),
    tone: String(obj.tone || '').trim(),
    names,
    notes: String(obj.notes || '').trim()
  };
}

/* ═══════════════════════════════════════
   التحقق من جودة الترجمة (قبل اعتبار السطر مكتملاً)
═══════════════════════════════════════ */
const LETTER_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F]/g;

function countLetters(value){
  return (String(value || '').match(LETTER_RE) || []).length;
}

function isNumberOnly(value){
  return /^[\p{N}\s.,،٬٫٪%+\-–—/:()٠-٩۰-۹]+$/u.test(String(value || '').trim());
}

function isTagOnly(value){
  return /^(\[[^\]]*\]\s*)+$/u.test(String(value || '').trim());
}

function isSymbolOnly(value){
  const text = String(value || '').trim();
  return text.length > 0 && !/[\p{L}\p{N}]/u.test(text);
}

/** هل النص اسم علم/علامة يُسمح ببقائه كما هو؟ */
function looksLikeProperName(value, brief){
  const source = String(value || '').trim();
  if(!source) return false;

  // أسماء ملف تعريف الفيديو (source => target)
  const briefNames = Array.isArray(brief && brief.names) ? brief.names : [];
  if(briefNames.some(n => String((n && n.source) || n || '').trim().toLowerCase() === source.toLowerCase())){
    return true;
  }

  // مصطلحات القاموس الثابتة
  try {
    if(getGlossaryPairs().some(p => String(p.from || '').trim().toLowerCase() === source.toLowerCase())) return true;
  } catch(_) {}

  const words = source.split(/\s+/).filter(Boolean);
  if(!words.length || words.length > 4) return false;

  // أسماء لاتينية بحروف كبيرة (Title Case) أو اختصارات
  if(words.every(w => /^[\p{Lu}][\p{L}'’\-.]*$/u.test(w))) return true;
  if(/^[\p{Lu}\p{N}&.\-]{2,10}$/u.test(source)) return true;

  // اسم مفرد واحد (احتمال اسم علم) — نسمح فقط بالحروف الكبيرة أو غير اللاتينية
  if(words.length === 1 && (/^[\p{Lu}]/u.test(source) || /[^\x00-\x7F]/.test(source))) return true;

  return false;
}

/**
 * نتيجة تحقق السطر:
 * - ok=true → تُطبَّق الترجمة على block.tr
 * - reason='identical' → مطابق للأصل (يُعاد إرساله ثم يُقبل كحل أخير)
 * - reason='ratio' أو 'empty' → يبقى ناقصاً لإعادة المحاولة/الزر اليدوي
 * @param {string} source النص الأصلي
 * @param {string} translated النص المترجم
 * @param {object|null} brief ملف تعريف الفيديو
 */
export function validateTranslation(source, translated, brief = null){
  const src = String(source || '').trim();
  const tr = String(translated || '').trim();
  if(!tr) return { ok: false, reason: 'empty', text: '' };

  if(tr === src){
    if(isNumberOnly(src) || isTagOnly(src) || isSymbolOnly(src) || looksLikeProperName(src, brief)){
      return { ok: true, text: tr };
    }
    if(countLetters(src) >= 3) return { ok: false, reason: 'identical', text: tr };
  }

  if(src.length > 15){
    const ratio = tr.length / src.length;
    if(ratio > 3 || ratio < 0.2) return { ok: false, reason: 'ratio', text: tr };
  }

  return { ok: true, text: tr };
}

/* ── طلب موحّد حسب المزوّد (يستخدمه ملف تعريف الفيديو والدفعات) ── */
async function requestText(ctx, promptData){
  if(ctx.isKie) return await executeKieRequest(promptData, ctx.model, ctx.apiKey);
  return await chatCompletion(promptData, ctx.model, ctx.apiKey);
}

/**
 * ملف تعريف الفيديو: طلب واحد رخيص قبل الدفعات (لا يوقف الترجمة عند فشله).
 * يستخدم النص كاملاً إن كان ≤12000 حرف، وإلا عينات موزعة بالتساوي.
 */
async function prepareVideoBrief(ctx){
  const sample = buildVideoBriefSample(state.blocks);
  if(!sample.trim()) return;

  try {
    setTrStatus('🧭 تجهيز ملف تعريف الفيديو...');
    const targetDesc = targetLangDesc(ctx.targetLang);
    const promptData = {
      systemPrompt:
`You are a subtitle translation analyst. Read the transcript and extract a compact consistency brief for a translator.
Return ONLY a valid JSON object with exactly these keys:
{"topic":"short topic","tone":"tone/style","names":[{"source":"original name/place/brand","target":"fixed spelling in ${targetDesc}"}],"notes":"short notes about continuity, register, or ambiguous terms"}
Do not translate the transcript. Do not add any text outside the JSON object.`,
      userPrompt:
`Target language: ${targetDesc}
Transcript (may be sampled if long):
${sample}`
    };
    const raw = await requestText(ctx, promptData);
    const brief = parseVideoBrief(raw);
    if(brief){
      ctx.brief = brief;
      console.info('[translate] video brief ready');
    }
  } catch(err){
    if(err && err.cancelled) return;
    // فشل الطلب التمهيدي لا يوقف الترجمة — نتجاهله بصمت
    console.warn('[translate] video brief skipped:', (err && err.message) || err);
  } finally {
    updateProgress();
  }
}


/* ═══════════════════════════════════════
   تحليل الاستجابات (JSON / SSE / نص خام)
═══════════════════════════════════════ */
function extractTextFromDataObj(data){
  if (!data) return '';
  let str = '';

  // 1) مسار Kie responses API: output → item من نوع message → content من نوع output_text
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && c.type === 'output_text' && typeof c.text === 'string') str += c.text;
        }
      }
    }
    if (str) return str;

    // 2) احتياط عام: أي نص في عناصر output
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && typeof c.text === 'string') str += c.text;
          else if (c && typeof c.delta === 'string') str += c.delta;
        }
      } else if (item && typeof item.text === 'string') {
        str += item.text;
      }
    }
  }
  if (str) return str;

  if (data.delta) {
    if (typeof data.delta === 'string') str += data.delta;
    else if (data.delta.text) str += data.delta.text;
  }
  if (Array.isArray(data.choices)) {
    for (const ch of data.choices) {
      if (ch.message && ch.message.content) {
        if (Array.isArray(ch.message.content)) {
          for (const part of ch.message.content) {
            if (typeof part === 'string') str += part;
            else if (part && typeof part === 'object' && part.text) str += part.text;
          }
        } else {
          str += ch.message.content;
        }
      }
      if (ch.delta && ch.delta.content) str += ch.delta.content;
    }
  }
  if (typeof data.text === 'string') str += data.text;
  if (typeof data.response === 'string') str += data.response;
  return str;
}

function extractTranslationText(rawText){
  if (!rawText) return '';
  const text = rawText.trim();
  try {
    const data = JSON.parse(text);
    const ext = extractTextFromDataObj(data);
    if (ext) return ext;
  } catch(e){}

  const lines = text.split('\n');
  let accumulated = '';
  let hasSse = false;
  for (const l of lines) {
    const ll = l.trim();
    if (!ll.startsWith('data:')) continue;
    hasSse = true;
    const jsonStr = ll.slice(5).trim();
    if (jsonStr === '[DONE]') continue;
    try {
      const chunk = JSON.parse(jsonStr);
      accumulated += extractTextFromDataObj(chunk);
    } catch(_){}
  }
  if (hasSse && accumulated) return accumulated;
  return text;
}

/**
 * تحويل رد الموديل إلى خريطة {مفتاح: نص} بأرقام الأسطر المحلية.
 *
 * - يقبل الكائن المرقّم مباشرة: {"1":".."} أو {"translations":{"1":".."}}
 * - يقبل المصفوفة كاحتياط (متحذات OpenRouter) فقط إذا كان طولها يساوي
 *   عدد الأسطر المرسلة تماماً — وإلا تُرفض كلها (ترجع null).
 * - المفاتيح الزائدة تُتجاهل عند التطبيق (لا نقرأ إلا مفاتيح أُرسلت).
 * - @param {number|null} expectedCount عدد المفاتيح المرسلة (لضبط شرط المصفوفة)
 */
export function parseResponseJSON(content, expectedCount){
  if (!content || typeof content !== 'string') return null;
  let clean = content.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed = null;
  try {
    parsed = JSON.parse(clean);
  } catch(e) {
    const mObj = clean.match(/\{[\s\S]*\}/);
    if (mObj) { try { parsed = JSON.parse(mObj[0]); } catch(e2){} }
    if (!parsed) {
      const mArr = clean.match(/\[[\s\S]*\]/);
      if (mArr) { try { parsed = JSON.parse(mArr[0]); } catch(e3){} }
    }
  }
  if (!parsed) return null;

  function fromArray(arr){
    if (typeof expectedCount === 'number' && arr.length !== expectedCount) return null;
    const map = {};
    arr.forEach((v, i) => { map[String(i + 1)] = toStringVal(v); });
    return map;
  }

  if (Array.isArray(parsed)) return fromArray(parsed);
  if (parsed === null || typeof parsed !== 'object') return null;

  const wrapper = (parsed.translations !== undefined) ? parsed.translations
    : (parsed.result !== undefined) ? parsed.result
    : (parsed.data !== undefined) ? parsed.data
    : (parsed.output !== undefined) ? parsed.output
    : (parsed.lines !== undefined) ? parsed.lines
    : undefined;

  if (wrapper !== undefined) {
    if (Array.isArray(wrapper)) return fromArray(wrapper);
    if (wrapper && typeof wrapper === 'object') {
      const map = {};
      for (const key of Object.keys(wrapper)) map[key] = toStringVal(wrapper[key]);
      return map;
    }
    return null;
  }

  // الكائن نفسه هو الخريطة: {"1":"..","2":".."}
  const map = {};
  for (const key of Object.keys(parsed)) map[key] = toStringVal(parsed[key]);
  return map;
}

function toStringVal(v){
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.text || v.translation || v.value || ''; // لا String(v) — كان ينتج '[object Object]' ويُطبَّق خطأً
  return v == null ? '' : String(v);
}

/* ═══════════════════════════════════════
   الاستدعاءات الفعلية (OpenRouter + Kie.ai)
═══════════════════════════════════════ */

/**
 * OpenRouter chat/completions — يعيد النص المستخرج خاماً.
 * مهلة 60 ثانية + ربط بالإيقاف، والخطأ مربوط بالحالة (err.status).
 * لا نعيد المحاولة بدون response_format إلا إذا كان الخطأ 400 حصراً.
 */
export async function chatCompletion(promptData, model, apiKey){
  const doRequest = async (withJsonMode) => {
    const sig = requestSignal();
    try {
      const res = await apiRequest('OPENROUTER_CHAT', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': window.location.href,
          'X-Title': 'SRT AI Tool'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: promptData.systemPrompt },
            { role: 'user',   content: promptData.userPrompt }
          ],
          response_format: withJsonMode ? { type: 'json_object' } : undefined,
          temperature: 0.3,
          max_tokens: 8192
        }),
        signal: sig.ctrl.signal
      });
      if (!res.ok) {
        const err = await buildHttpError(res);
        onStatus(err.status);
        throw err;
      }
      return extractTranslationText(await res.text());
    } catch(err){
      if (err.status || err.cancelled || err.fatal) throw err;
      throw normalizeRequestError(err, sig);
    } finally {
      sig.cleanup();
    }
  };

  try {
    return await doRequest(true);
  } catch(err){
    if (err.status === 400) {
      console.warn('[OpenRouter] retry without response_format:', err.message);
      return await doRequest(false);
    }
    throw err;
  }
}

/**
 * Kie.ai — يعيد النص المستخرج خاماً (يُحلَّل لاحقاً بـ parseResponseJSON).
 *
 * - مهلة 60 ثانية لكل محاولة + إجهاض فوري عند الإيقاف (إشارة مشتركة)
 * - حتى 3 إعادات (1ث/2ث/4ث + jitter) لـ 429 و500 و502 و503 و504 والـ Timeout
 *   وخطأ الشبكة — لا إعادة أبداً عند 400/401/402/403 (الخطأ فادح يوقف المهمة)
 * - الخطأ مربوط بالحالة (err.status) ليستخدمه منطق 429 التكيّفي
 * - لا نجدد الرصيد ولا نضيف reasoning — الجسم كما كان (stream:false + input_text)
 */
export async function executeKieRequest(promptData, model, apiKey, baseUrl){
  const combinedPrompt = `${promptData.systemPrompt}\n\n${promptData.userPrompt}`;
  const targetUrl = baseUrl || API_ENDPOINTS.KIE_RESPONSES;
  const isChatCompletions = targetUrl.includes('/chat/completions');

  const bodyData = isChatCompletions
    ? {
        model: 'gpt-6-luna',
        stream: false,
        messages: [
          { role: 'system', content: promptData.systemPrompt },
          { role: 'user', content: promptData.userPrompt }
        ]
      }
    : {
        model: model || 'gpt-5-6-luna',
        stream: false,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: combinedPrompt }] }
        ]
      };

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (runAbort && runAbort.signal.aborted) throw cancelledError();

    const sig = requestSignal();
    let res;
    try {
      res = await apiRequest('KIE_RESPONSES', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(bodyData),
        url: targetUrl,
        signal: sig.ctrl.signal
      });
    } catch(err){
      sig.cleanup();
      if (err.cancelled) throw err;
      const norm = normalizeRequestError(err, sig);
      onStatus(norm.status);
      if (isRetryable(norm) && attempt < RETRY_DELAYS.length) {
        await backoff(RETRY_DELAYS[attempt]);
        continue;
      }
      throw norm;
    }
    sig.cleanup();

    if (!res.ok) {
      const err = await buildHttpError(res);
      err.status = res.status;
      onStatus(err.status);
      if (err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504) {
        if (attempt < RETRY_DELAYS.length) {
          await backoff(RETRY_DELAYS[attempt]);
          continue;
        }
        throw err;
      }
      // 400/401/402/403 وغيرها: خطأ فادح — يوقف المهمة كلها
      err.fatal = true;
      err.fatalMessage = kieFatalMessage(err.status, err.message);
      throw err;
    }

    const rawText = await res.text();

    // حالة الرد (responses API): إن وُجدت ولم تكن completed فهي فشل قابل للإعادة
    const dataStatus = peekResponseStatus(rawText);
    if (dataStatus && dataStatus !== 'completed') {
      const err = new Error('حالة رد Kie.ai: ' + dataStatus);
      err.status = 502;
      err.retryable = true;
      if (attempt < RETRY_DELAYS.length) {
        await backoff(RETRY_DELAYS[attempt]);
        continue;
      }
      throw err;
    }

    return extractTranslationText(rawText);
  }
}

function peekResponseStatus(rawText){
  try {
    const j = JSON.parse(rawText);
    if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.status === 'string') return j.status;
  } catch(_){}
  return null;
}

/* ═══════════════════════════════════════
   تنفيذ الترجمة (دفعات + تجمّع عامل + تكيّف 429)
═══════════════════════════════════════ */
async function sendBatchRequest(ctx, payload, entries){
  const context = buildBatchContext(entries, state.blocks);
  const promptData = buildTranslationPrompt(payload, ctx.srcLang, ctx.targetLang, context, ctx.brief);
  return await requestText(ctx, promptData);
}

/**
 * ترجمة مجموعة أسطر مع جولات الناقص (نفس أرقامها الأصلية) وتقسيم النصف عند الفشل الكامل.
 * @param {Array<{key:string, block:object}>} pending أسطر الدفعة
 * @param {object} ctx سياق الطلب
 * @param {number} depth عمق التقسيم الحالي
 * @returns {Promise<{applied:Array, failed:Array}>}
 */
async function translateGroup(pending, ctx, depth){
  let current = pending.filter(e => (e.block.text || '').trim() !== '');
  if (!current.length) return { applied: [], failed: [] };
  const applied = [];
  const identicalFallback = new Map(); // key → آخر نص مطابق للأصل (يُقبل بعد استنفاد الجولات)

  for (let round = 0; round <= RETRY_ROUNDS; round++) {
    if (runAbort && runAbort.signal.aborted) return { applied, failed: [] };

    const payload = numberedObject(current);
    const keysCount = Object.keys(payload).length;
    if (!keysCount) return { applied, failed: [] };

    let raw = null;
    let hardError = null;
    try {
      raw = await sendBatchRequest(ctx, payload, current);
    } catch(err){
      if (err && err.cancelled) return { applied, failed: [] };
      if (err && err.fatal) throw err;
      hardError = err;
      lastHardErr = err;
    }

    const got = (!hardError && raw) ? (parseResponseJSON(raw, keysCount) || {}) : {};

    if (runAbort && runAbort.signal.aborted) return { applied, failed: [] };

    // نطبق فقط المفاتيح المرسلة، وبعد التحقق الذكي من الجودة.
    const appliedKeys = new Set();
    const roundIdentical = new Set();
    for (const e of current) {
      const t = got[e.key];
      if (typeof t !== 'string' || !t.trim()) continue;

      const verdict = validateTranslation(e.block.text, t, ctx.brief);
      if (verdict.ok) {
        e.block.tr = verdict.text;
        applied.push(e);
        appliedKeys.add(e.key);
        identicalFallback.delete(e.key);
      } else if (verdict.reason === 'identical') {
        roundIdentical.add(e.key);
        identicalFallback.set(e.key, verdict.text);
      } else {
        identicalFallback.delete(e.key);
      }
    }

    // لا نحتفظ بنتائج مطابقة قديمة لم تعد مطابقة في الجولة الحالية
    for (const key of Array.from(identicalFallback.keys())) {
      if (!roundIdentical.has(key)) identicalFallback.delete(key);
    }

    const missing = current.filter(e => !appliedKeys.has(e.key));
    const gotCount = got ? Object.keys(got).length : 0;

    // فشل كامل حقيقي (لا استجابة/خطأ صلب) أو صفر نتائج → تقسيم النصفين
    if (hardError || gotCount === 0) {
      if (missing.length > 10 && depth < SPLIT_DEPTH) {
        const mid = Math.ceil(missing.length / 2);
        const [a, b] = await Promise.all([
          translateGroup(missing.slice(0, mid), ctx, depth + 1),
          translateGroup(missing.slice(mid), ctx, depth + 1)
        ]);
        return { applied: applied.concat(a.applied, b.applied), failed: a.failed.concat(b.failed) };
      }
      return { applied, failed: missing };
    }

    if (!missing.length) return { applied, failed: [] };

    // إعادة إرسال الناقص فقط بنفس أرقامه الأصلية (جولة إضافية)
    current = missing;
    if (round < RETRY_ROUNDS) await sleep(150 + Math.round(Math.random() * 100));
  }

  // بعد استنفاد الجولات: المطابق للأصل يُقبل كما هو (لا يبقى ناقصاً للأبد).
  const finalMissing = [];
  for (const e of current) {
    if (identicalFallback.has(e.key)) {
      e.block.tr = identicalFallback.get(e.key);
      applied.push(e);
    } else {
      finalMissing.push(e);
    }
  }
  return { applied, failed: finalMissing };
}

/* ── تجمّع العامل (worker pool) بجدولة ديناميكية ── */
async function acquireSlot(){
  while (adapt.active >= adapt.limit) {
    if (runAbort && runAbort.signal.aborted) throw cancelledError();
    await sleep(30);
  }
  adapt.active++;
}

function releaseSlot(){
  adapt.active = Math.max(0, adapt.active - 1);
  if (adapt.saw429) {
    adapt.limit = Math.max(MIN_CONCURRENCY, adapt.limit - 1);
    adapt.okStreak = 0;
  } else {
    adapt.okStreak++;
    if (adapt.okStreak >= RECOVERY_HIT && adapt.limit < CONCURRENCY) {
      adapt.limit++;
      adapt.okStreak = 0;
    }
  }
  adapt.saw429 = false;
}

async function runTask(targetIds){
  const isKie = (state.trProvider === 'kie');
  const apiKey = isKie
    ? $('kieKeyIn').value.trim()
    : $('orKeyIn').value.trim();
  if (!apiKey) return toast(isKie ? 'أدخل Kie.ai API Key' : 'أدخل OpenRouter API Key', '⚠️');

  let candidateRows = state.blocks
    .map((block, sourceIndex) => ({ block, sourceIndex }))
    .filter(row => (row.block.text || '').trim() !== '');
  if (targetIds) {
    const wanted = new Set(targetIds);
    candidateRows = candidateRows.filter(row => wanted.has(row.block.id)); // الموجودة فعلاً فقط
  }
  if (!candidateRows.length) return toast(targetIds ? 'لا توجد أسطر ناقصة متبقية' : 'لا يوجد نص للمعالجة', '⚠️');

  // موديل OpenRouter المختار من القائمة المنسدلة — الحارس قبل تعديل أي حالة
  const orModel = isKie ? '' : getSelectedOrModel();
  if (!isKie && !orModel) return toast('أضف موديل OpenRouter أولاً', '⚠️');

  // إعادة ضبط سياق التشغيل
  failedIds = [];
  lastHardErr = null;
  doneCount = 0;
  totalCount = 0;
  fatalMsg = null;
  adapt = { limit: CONCURRENCY, active: 0, okStreak: 0, saw429: false };
  runAbort = new AbortController();
  state.currentTask = 'translate';
  state.cancelRequested = false;

  switchTaskUI(true);
  updateRetryButton();
  checkTrReady();
  setVisible('trProgress', true);
  updateProgress();

  // الانتقال إلى تبويب «مترجم» ليرى المستخدم النتائج تتدفق
  setActiveTab('translated');
  renderCards({ captureHistory: false });

  // لقطة واحدة قبل كل الترجمة → التراجع يعيد كل الأسطر بخطوة واحدة (لا لقطات للدفعات)
  captureHistory();

  const srcLang    = $('trSrcLang').value;
  const targetLang = $('trTargetLang').value;
  const model      = isKie ? 'gpt-6-luna' : orModel;
  const ctx = { isKie, apiKey, model, srcLang, targetLang, brief: null };

  const batches = buildBatches(candidateRows);
  totalCount = batches.reduce((s, b) => s + b.length, 0);
  updateProgress();

  // ملف تعريف الفيديو: طلب تمهيدي واحد (فشله لا يوقف الترجمة)
  await prepareVideoBrief(ctx);

  let nextIdx = 0;

  async function worker(){
    while (true) {
      if (runAbort && runAbort.signal.aborted) return;
      if (fatalMsg) return;
      const idx = nextIdx++;
      if (idx >= batches.length) return;

      try { await acquireSlot(); } catch(_) { return; }
      if ((runAbort && runAbort.signal.aborted) || fatalMsg) { releaseSlot(); return; }

      try {
        const res = await translateGroup(batches[idx], ctx, 0);
        const appliedIds = res.applied.map(e => e.block.id);
        doneCount += appliedIds.length;
        if (appliedIds.length) {
          // عرض فوري للدفعة المنتهية + حفظ تلقائي مجمّع (لا نعيد بناء القائمة)
          updateTranslatedCards(appliedIds);
          updateProgress();
          scheduleAutoSave(1200);
        }
        for (const e of res.failed) {
          if (!failedIds.includes(e.block.id)) failedIds.push(e.block.id);
        }
      } catch(err){
        if (err && err.fatal) {
          fatalMsg = err.fatalMessage || err.message;
          if (runAbort && !runAbort.signal.aborted) runAbort.abort();
        } else {
          console.warn('[translate] batch error:', (err && err.message) || err);
        }
      } finally {
        releaseSlot();
        updateProgress();
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, batches.length);
  const workers = [];
  for (let k = 0; k < workerCount; k++) workers.push(worker());
  await Promise.all(workers);

  // اجعل عدّاد الناقص مشتقاً من البيانات نفسها (لا من ذاكرة الدفعات)
  failedIds = getMissingBlocks().map(b => b.id);

  // عرض النتائج مرة واحدة فقط بعد انتهاء كل الدفعات (لتجنب إغراق سجل التراجع)
  if (fatalMsg) {
    setTrStatus('❌ ' + fatalMsg);
    toast(fatalMsg, '❌');
  } else if (runAbort && runAbort.signal.aborted) {
    setTrStatus(`⏹️ توقفت العملية — تُرجم فعلياً <b>${doneCount}</b> / ${totalCount} سطراً`);
    toast('تم إيقاف العملية','⏹️');
  } else if (failedIds.length) {
    setTrStatus(`✅ اكتملت — تُرجم <b>${doneCount}</b> / ${totalCount} سطراً • <b style="color:var(--rd)">${failedIds.length}</b> خط ناقص 🔁${lastHardErr ? ` <span dir="ltr" style="color:var(--rd)">• ${lastHardErr.message || lastHardErr}</span>` : ''}`);
    toast(`اكتملت الترجمة (${failedIds.length} سطراً ناقصاً — أعد ترجمتها)`, '⚠️');
  } else {
    setTrStatus(`✅ اكتملت الترجمة بنجاح! (${doneCount} سطر)`);
    toast('تمت الترجمة بنجاح!','🎉');
  }

  renderCards();
  scheduleAutoSave(0);

  state.currentTask = null;
  state.cancelRequested = false;
  runAbort = null;
  switchTaskUI(false);
  updateRetryButton();
  checkTrReady();
}

// تحديث زر «أعد ترجمة الناقص» عند أي إعادة رسم/تغيير في الأسطر
try {
  document.addEventListener('srt:blocks-updated', () => {
    if (!state.currentTask) updateRetryButton();
  });
} catch(_) {}

export function startTranslation(){
  if (state.currentTask) return;
  return runTask(null);
}

export async function retryMissingTranslation(){
  if (state.currentTask) return;
  const ids = getMissingBlocks().map(b => b.id);
  if (!ids.length) return toast('لا توجد أسطر ناقصة','ℹ️');
  await runTask(ids);
}

// أدوات نقية للاختبار والاستخدام الداخلي
export {
  buildBatches,
  buildBatchContext,
  buildTranslationPrompt,
  buildVideoBriefSample,
  parseVideoBrief
};
