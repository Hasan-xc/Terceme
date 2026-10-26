/**
 * gemini.js — تفريغ صوتي عبر Gemini 3.5 Transcribe
 *
 * لماذا REST وليس @google/genai؟
 *  - التطبيق ثابت (Static) بلا Node أو bundler، ولا يمكنه تشغيل SDK الخاص بـ Node
 *    ولا قراءة process.env. لذلك نستدعي نقطة generateContent مباشرة من المتصفح
 *    باستخدام مفتاح المستخدم نفسه (يبقى في جهازه مثل مفاتيح Groq/Kie).
 *
 * المزايا المدعومة (مطابقة لإعدادات Gemini 3.5 Transcribe):
 *  - كشف اللغة تلقائيًا.
 *  - wordTimestamp: طوابع زمنية على مستوى الكلمة لبناء SRT دقيق.
 *  - diarization: تمييز المتحدثين (spk_1 / spk_2 ...) وإضافة بادئة [1] لكل سطر.
 *
 * حدود API:
 *  - 20MB لكل طلب عند الإرسال inline (بعد ترميز base64) — لذلك نضغط كل جزء MP3
 *    بجودة 48kbps قبل الإرسال، ونتحقق من الحجم هنا أيضًا.
 *  - عند تفعيل الطوابع الزمنية أو تمييز المتحدثين: 30 دقيقة كحد أقصى للطلب.
 *    التطبيق يقسّم إلى أجزاء 20 دقيقة افتراضيًا، فهو داخل الحد.
 *
 * لا يحتوي هذا الملف على أي مفاتيح، ولا يخزّن أي شيء.
 */

import { apiRequest, API_ENDPOINTS } from './apiClient.js';
import { getPersonaPromptBlock, getPersonas } from './personas.js';

export const GEMINI_MODEL = 'gemini-3.5-transcribe';

// 13MB خام → ~17.3MB بعد base64، ويبقى هامش للـ JSON تحت حد 20MB.
const MAX_INLINE_BYTES = 13 * 1024 * 1024;

const MIME_ALIASES = {
  'audio/mpeg': 'audio/mp3',
  'audio/mp3': 'audio/mp3',
  'audio/x-mp3': 'audio/mp3',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/aiff': 'audio/aiff',
  'audio/x-aiff': 'audio/aiff',
  'audio/aac': 'audio/aac',
  'audio/ogg': 'audio/ogg',
  'audio/oga': 'audio/ogg',
  'audio/flac': 'audio/flac',
  'audio/x-flac': 'audio/flac',
  'audio/mp4': 'audio/m4a',
  'audio/m4a': 'audio/m4a',
  'audio/x-m4a': 'audio/m4a',
  'audio/webm': 'audio/webm',
  'audio/opus': 'audio/opus',
  'audio/l16': 'audio/l16',
  'audio/alaw': 'audio/alaw',
  'audio/mulaw': 'audio/mulaw'
};

function normalizeMime(blob){
  const raw = String((blob && blob.type) || '').split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[raw] || 'audio/mp3';
}

/** تحويل Blob إلى base64 دون تجميع سلسلة عملاقة دفعة واحدة. */
async function blobToBase64(blob){
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const step = 0x8000; // 32KB
  for(let i = 0; i < bytes.length; i += step){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * تحويل الطوابع الزمنية لـ Gemini إلى مللي ثانية.
 * الصيغ المحتملة: "1.250s" أو "250ms" أو 1.25 (ثوانٍ) أو {seconds, nanos}.
 */
function parseOffset(value){
  if(value == null) return NaN;
  if(typeof value === 'number') return Number.isFinite(value) ? value * 1000 : NaN;
  if(typeof value === 'string'){
    const s = value.trim();
    if(!s) return NaN;
    const hms = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if(hms) return (parseInt(hms[1],10)*3600 + parseInt(hms[2],10)*60 + parseFloat(hms[3])) * 1000;
    const clock = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
    if(clock) return (parseInt(clock[1], 10) * 60 + parseFloat(clock[2])) * 1000;
    if(/ms$/i.test(s)) return parseFloat(s);
    if(/s$/i.test(s)) return parseFloat(s) * 1000;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n * 1000 : NaN;
  }
  if(typeof value === 'object'){
    const sec = Number(value.seconds);
    const nanos = Number(value.nanos || 0);
    if(Number.isFinite(sec)) return sec * 1000 + nanos / 1e6;
  }
  return NaN;
}

/**
 * استخراج كلمات Gemini الموقّتة من رد generateContent (بلا تجميع أسطر).
 * تُستخدم في مزامنة التوقيت عند اختيار Gemini، لأن المحاذاة تحتاج أوقات
 * الكلمات نفسها لا نص المقاطع التقريبي.
 */
export function extractGeminiWordTimings(data, offsetMs = 0){
  const parts = [];
  const candidates = Array.isArray(data && data.candidates) ? data.candidates : [];
  for(const candidate of candidates){
    const contentParts = candidate && candidate.content && candidate.content.parts;
    if(Array.isArray(contentParts)) parts.push(...contentParts);
  }
  const out = [];
  for(const part of parts){
    const tx = part && (part.audioTranscription || part.audio_transcription);
    if(!tx || !Array.isArray(tx.words)) continue;
    for(const item of tx.words){
      const text = String((item && (item.word ?? item.text)) || '').trim();
      if(!text || !/[\p{L}\p{N}]/u.test(text)) continue;
      const start = parseOffset(item.startOffset ?? item.start_offset);
      const end = parseOffset(item.endOffset ?? item.end_offset);
      if(!Number.isFinite(start)) continue;
      const startMs = Math.max(0, Math.round(start + offsetMs));
      const endMs = Math.max(startMs, Math.round((Number.isFinite(end) ? end : start) + offsetMs));
      out.push({ text, startMs, endMs });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

/** قواعد الشخصيات بصيغة قابلة للحقن في أي برومبت Gemini مستقبلي. */
export function buildGeminiGenderRules(){
  return getPersonaPromptBlock(getPersonas());
}

function isCjk(ch){
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(ch || '');
}

/** وصل كلمات Gemini مع مراعاة اللغات التي لا تستخدم مسافات (الصينية/اليابانية...). */
function joinWords(words){
  let out = '';
  for(const word of words){
    if(!out){ out = word; continue; }
    const prev = out[out.length - 1];
    const next = word[0] || '';
    out += (isCjk(prev) || isCjk(next)) ? word : ' ' + word;
  }
  return out;
}

function normalizeText(text){
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([،,.!?;:…])/g, '$1')
    .replace(/([(\[«])\s+/g, '$1')
    .trim();
}

/** spk_1 → 1، speaker 2 → 2، وأي اسم آخر يبقى مختصرًا. */
function shortSpeaker(label){
  const s = String(label || '').trim();
  if(!s || /^unknown$/i.test(s)) return '';
  const num = s.match(/(\d+)/);
  if(num) return num[1];
  return s.replace(/^spk[_-]?/i, '').slice(0, 12);
}

/**
 * تجميع كلمات Gemini في أسطر SRT:
 * - تغيير المتحدث.
 * - صمت أطول من 800ms.
 * - سطر أطول من 42 حرفًا أو 7 ثوانٍ.
 * - نهاية جملة واضحة.
 */
function groupWords(words, offsetMs, includeSpeakers){
  const out = [];
  let line = [];
  let lineSpeaker = '';

  function flush(){
    if(!line.length) return;
    const text = normalizeText(joinWords(line.map(w => w.word)));
    if(text){
      let start = line[0].start;
      let end = line[line.length - 1].end;
      if(!(end > start)) end = start + Math.max(300, Math.min(3000, text.length * 80));
      const sp = includeSpeakers ? shortSpeaker(lineSpeaker) : '';
      out.push({
        sMs: Math.round(offsetMs + start),
        eMs: Math.round(offsetMs + end),
        text: (sp ? `[${sp}] ` : '') + text
      });
    }
    line = [];
  }

  for(const w of words){
    const speaker = w.speaker || '';
    if(line.length && speaker !== lineSpeaker) flush();
    if(!line.length) lineSpeaker = speaker;

    if(line.length){
      const prev = line[line.length - 1];
      const gap = w.start - prev.end;
      const chars = line.reduce((n, x) => n + x.word.length + 1, 0);
      const duration = w.end - line[0].start;
      const sentenceEnd = /[.!?؟…]$/.test(prev.word);
      if(gap > 800 || chars + w.word.length > 42 || duration > 7000 || sentenceEnd) flush();
    }
    line.push(w);
  }
  flush();

  return out.filter(s => s.text && s.eMs > s.sMs);
}

/** احتياط أخير: توزيع النص على مدة الجزء تقريبيًا إذا لم تُرجع API أي طوابع. */
function approximateSegments(text, offsetMs, durationMs){
  const clean = String(text || '').replace(/\r/g, '').trim();
  if(!clean) return [];

  const pieces = [];
  for(const line of clean.split(/\n+/)){
    const matches = line.match(/[^.!?؟…]+[.!?؟…]*/g) || [line];
    for(const part of matches){
      const t = part.trim();
      if(!t) continue;
      // جملة طويلة بلا علامات ترقيم: نقسمها عند حدود الكلمات حتى لا تصبح بطاقة واحدة ضخمة.
      if(t.length > 90){
        let rest = t;
        while(rest.length > 90){
          let cut = rest.lastIndexOf(' ', 80);
          if(cut < 40) cut = 80;
          pieces.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if(rest) pieces.push(rest);
      } else {
        pieces.push(t);
      }
    }
  }

  // دمج القطع القصيرة حتى لا تتكوّن عشرات الأسطر من كلمة واحدة.
  const merged = [];
  for(const piece of pieces){
    const last = merged[merged.length - 1];
    if(last && (last.length < 20 || piece.length < 20) && last.length + piece.length + 1 <= 90){
      merged[merged.length - 1] = last + ' ' + piece;
    } else {
      merged.push(piece);
    }
  }
  if(!merged.length) return [];

  const totalChars = merged.reduce((n, p) => n + p.length, 0) || 1;
  const totalMs = durationMs > 0 ? durationMs : Math.max(3000, merged.length * 3000);
  let cursor = offsetMs;
  const out = [];
  for(const piece of merged){
    const dur = Math.max(400, Math.round(totalMs * piece.length / totalChars));
    out.push({ sMs: Math.round(cursor), eMs: Math.round(cursor + dur), text: piece });
    cursor += dur;
  }
  return out;
}

/**
 * تحليل رد generateContent إلى مقاطع {sMs,eMs,text}.
 * مُصدَّرة للاختبار المستقل.
 *
 * @param {object} data رد JSON من Gemini
 * @param {number} offsetMs بداية الجزء داخل الملف الكامل
 * @param {{includeSpeakers?: boolean, durationMs?: number}} opts
 * @returns {Array<{sMs:number,eMs:number,text:string}>}
 */
export function parseGeminiResponse(data, offsetMs = 0, opts = {}){
  const includeSpeakers = opts.includeSpeakers !== false;
  const durationMs = Number(opts.durationMs) || 0;

  const parts = [];
  const candidates = Array.isArray(data && data.candidates) ? data.candidates : [];
  for(const candidate of candidates){
    const contentParts = candidate && candidate.content && candidate.content.parts;
    if(Array.isArray(contentParts)) parts.push(...contentParts);
  }

  const words = [];
  const textParts = [];

  for(const part of parts){
    if(!part) continue;
    const tx = part.audioTranscription || part.audio_transcription;
    let partSpeaker = '';
    if(tx){
      // قد يكون speakerLabel على مستوى الجزء، وقد يوجد أيضًا على الكلمة نفسها.
      partSpeaker = tx.speakerLabel || tx.speaker_label || '';
      const txWords = Array.isArray(tx.words) ? tx.words : [];
      for(const item of txWords){
        const word = String((item && (item.word ?? item.text)) || '').trim();
        if(!word) continue;
        const start = parseOffset(item.startOffset ?? item.start_offset);
        const end = parseOffset(item.endOffset ?? item.end_offset);
        if(!Number.isFinite(start)) continue;
        words.push({
          word,
          start,
          end: Number.isFinite(end) ? Math.max(end, start) : start,
          speaker: item.speakerLabel || item.speaker_label || item.speaker || partSpeaker
        });
      }
    }
    if(typeof part.text === 'string' && part.text.trim()){
      textParts.push({ text: part.text.trim(), speaker: partSpeaker });
    }
  }

  if(words.length) return groupWords(words, offsetMs, includeSpeakers);

  // لا كلمات موقّتة (مثلاً wordTimestamp=false مع diarization=true):
  // نوزّع نص كل جزء على مدة الطلب ونحافظ على بادئة المتحدث إن وُجدت.
  if(textParts.length){
    const anySpeaker = includeSpeakers && textParts.some(p => shortSpeaker(p.speaker));
    if(anySpeaker){
      const totalChars = textParts.reduce((n, p) => n + p.text.length, 0) || 1;
      const totalMs = durationMs > 0 ? durationMs : Math.max(3000, totalChars * 80);
      let cursor = offsetMs;
      const out = [];
      for(const p of textParts){
        const share = Math.max(300, Math.round(totalMs * p.text.length / totalChars));
        const segs = approximateSegments(p.text, cursor, share);
        const sp = shortSpeaker(p.speaker);
        for(const seg of segs){
          out.push({ ...seg, text: (sp ? `[${sp}] ` : '') + seg.text });
        }
        cursor += share;
      }
      if(out.length) return out;
    }
    return approximateSegments(textParts.map(p => p.text).join('\n'), offsetMs, durationMs);
  }

  return [];
}

/**
 * إرسال جزء صوتي واحد إلى Gemini وإرجاع مقاطع جاهزة لـ SRT.
 *
 * @param {object} params
 * @param {Blob} params.blob الجزء الصوتي (MP3/WAV عادة)
 * @param {string} params.apiKey مفتاح Gemini
 * @param {number} params.offsetMs بداية الجزء داخل الملف
 * @param {number} params.durationMs مدة الجزء
 * @param {boolean} params.wordTimestamp
 * @param {boolean} params.diarization
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Array<{sMs:number,eMs:number,text:string}>>}
 */
/**
 * إرسال جزء صوتي إلى Gemini وإرجاع أوقات الكلمات فقط.
 * مسار اختياري لمزامنة التوقيت (Gemini Multimodal) — لا يغيّر المسار الافتراضي Groq.
 */
export async function transcribeAudioWords({
  blob, apiKey, offsetMs = 0, durationMs = 0, signal
}){
  if(!blob || !blob.size) throw new Error('لا يوجد صوت للإرسال إلى Gemini');
  if(!apiKey){
    const err = new Error('أدخل مفتاح Gemini أولاً');
    err.status = 401; err.fatal = true;
    throw err;
  }
  if(blob.size > MAX_INLINE_BYTES){
    const err = new Error('حجم الجزء أكبر من حد Gemini المباشر (20MB).');
    err.code = 'TOO_LARGE'; err.fatal = true;
    throw err;
  }

  const mimeType = normalizeMime(blob);
  const data = await blobToBase64(blob);
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data } }] }],
    generationConfig: { audioTranscriptionConfig: { wordTimestamp: true, diarization: false } }
  };

  const res = await apiRequest('GEMINI_GENERATE', {
    url: `${API_ENDPOINTS.GEMINI_GENERATE}/${GEMINI_MODEL}:generateContent`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal
  });

  if(!res.ok){
    let message = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      message = (errJson && errJson.error && errJson.error.message) || message;
    } catch(_){}
    const err = new Error(message);
    err.status = res.status;
    if([400, 401, 403, 404, 413].includes(res.status)) err.fatal = true;
    throw err;
  }

  let json = null;
  try { json = await res.json(); } catch(_){}
  if(!json) {
    const err = new Error('رد Gemini غير صالح (ليس JSON)');
    err.retryable = true; throw err;
  }
  if(json.error){
    const err = new Error(json.error.message || 'خطأ من Gemini');
    err.fatal = true; throw err;
  }

  const words = extractGeminiWordTimings(json, offsetMs);
  if(!words.length){
    const err = new Error('لم يرجع Gemini أي طوابع زمنية للكلمات');
    err.retryable = true;
    throw err;
  }
  return words;
}

export async function transcribeAudioBlob({
  blob, apiKey, offsetMs = 0, durationMs = 0,
  wordTimestamp = true, diarization = true, signal
}){
  if(!blob || !blob.size) throw new Error('لا يوجد صوت للإرسال إلى Gemini');
  if(!apiKey) {
    const err = new Error('أدخل مفتاح Gemini أولاً');
    err.status = 401;
    err.fatal = true;
    throw err;
  }
  if(blob.size > MAX_INLINE_BYTES){
    const err = new Error('حجم الجزء أكبر من حد Gemini المباشر (20MB). جرّب جودة صوت أقل أو أوقف الطوابع الزمنية.');
    err.code = 'TOO_LARGE';
    err.fatal = true;
    throw err;
  }

  const mimeType = normalizeMime(blob);
  const data = await blobToBase64(blob);

  const transcriptionConfig = {};
  if(wordTimestamp) transcriptionConfig.wordTimestamp = true;
  if(diarization) transcriptionConfig.diarization = true;

  const body = {
    contents: [{
      role: 'user',
      parts: [{ inlineData: { mimeType, data } }]
    }]
  };
  if(wordTimestamp || diarization){
    body.generationConfig = { audioTranscriptionConfig: transcriptionConfig };
  }

  const res = await apiRequest('GEMINI_GENERATE', {
    url: `${API_ENDPOINTS.GEMINI_GENERATE}/${GEMINI_MODEL}:generateContent`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if(!res.ok){
    let message = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      message = (errJson && errJson.error && errJson.error.message) || message;
    } catch(_){}
    const err = new Error(message);
    err.status = res.status;
    if([400, 401, 403, 404, 413].includes(res.status)) err.fatal = true;
    throw err;
  }

  let json = null;
  try { json = await res.json(); } catch(_){}
  if(!json){
    const err = new Error('رد Gemini غير صالح (ليس JSON)');
    err.retryable = true;
    throw err;
  }
  if(json.error){
    const err = new Error(json.error.message || 'خطأ من Gemini');
    err.fatal = true;
    throw err;
  }

  const segments = parseGeminiResponse(json, offsetMs, {
    includeSpeakers: diarization,
    durationMs
  });

  if(!segments.length){
    const finish = json.candidates && json.candidates[0] && json.candidates[0].finishReason;
    const blocked = json.promptFeedback && json.promptFeedback.blockReason;
    const err = new Error(
      blocked ? `تم حظر طلب Gemini: ${blocked}`
        : `لم يُرجع Gemini أي نص${finish ? ` (${finish})` : ''}`
    );
    err.retryable = true;
    throw err;
  }

  return segments;
}
