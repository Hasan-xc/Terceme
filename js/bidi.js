/**
 * bidi.js — ضبط اتجاه النص العربي/المختلط (Unicode Bidi)
 *
 * المشكلة التي يحلها:
 *  - علامات الترقيم في نهاية السطر العربي قد تنقلب إلى بدايته داخل
 *    مشغلات الفيديو القديمة (VLC/بعض مشغلات Android/TV).
 *  - الأسماء والأرقام اللاتينية داخل جملة عربية قد تتقافز عند حدود
 *    الكلمات إذا لم تكن معزولة باتجاه صريح.
 *
 * الحل:
 *  - إضافة RLM/LRM حول المقاطع اللاتينية وعلامات الترقيم الطرفية.
 *  - عزل كل سطر بصرياً عند التصدير SRT/VTT/ASS، دون لمس التوقيتات.
 *  - إزالة العلامات القديمة قبل إعادة توليدها حتى لا تتراكم.
 *
 * دوال نقية بلا DOM — قابلة للاختبار مباشرة.
 */

export const RLM = '\u200F';   // Right-to-Left Mark
export const LRM = '\u200E';   // Left-to-Right Mark
export const FSI = '\u2068';   // First Strong Isolate
export const PDI = '\u2069';   // Pop Directional Isolate

const BIDI_MARKS_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF]/;
const LATIN_RUN_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF][A-Za-z0-9\u00C0-\u024F\u0400-\u04FF'’._-]*/g;

/** هل النص يحتوي حروفاً عربية؟ */
export function hasArabic(value){
  return ARABIC_RE.test(String(value || ''));
}

/** هل النص يحتوي حروفاً لاتينية/سيريلية؟ */
export function hasLatin(value){
  return LATIN_RE.test(String(value || ''));
}

/**
 * اتجاه النص التقريبي: rtl إذا وُجد عربي، وإلا ltr.
 * نستخدمه في العارض (dir) وفي CSS بدل الاعتماد على اتجاه الصفحة فقط.
 */
export function detectTextDirection(value){
  return hasArabic(value) ? 'rtl' : 'ltr';
}

/** إزالة كل علامات التوجيه السابقة (حتى لا تتراكم عند التصدير). */
export function stripBidi(value){
  return String(value ?? '').replace(BIDI_MARKS_RE, '');
}

/**
 * تنظيف المسافات حول الترقيم العربي/العالمي مع الحفاظ على الأرقام
 * مثل "1,000" و"12:30" و"3.14" سليمة.
 */
export function normalizeSubtitlePunctuation(value){
  const lines = stripBidi(value).replace(/\r\n?/g, '\n').split('\n');
  return lines.map((rawLine) => {
    let line = rawLine.replace(/[ \t]+/g, ' ').trim();
    if(!line) return '';
    // مسافة زائدة قبل الفاصلة/النقطة/علامة الاستفهام
    line = line.replace(/\s+([،,.;:!?؟…])/g, '$1');
    // مسافة زائدة بعد القوس الافتتاحي
    line = line.replace(/([(\[«])\s+/g, '$1');
    // مسافة زائدة قبل القوس الختامي
    line = line.replace(/\s+([)\]}»])/g, '$1');
    // مسافة بعد الفاصلة/الفاصلة المنقوطة العربية فقط (لا نلمس 1,000)
    line = line.replace(/([،؛])(?=\S)/g, '$1 ');
    // إذا بدأ سطر عربي بترقيم طرفي بسبب لصق RTL، أعده إلى نهايته.
    if(hasArabic(line)){
      const leading = line.match(/^[.!?؟…،,;:]+/);
      if(leading){
        const marks = leading[0];
        const rest = line.slice(marks.length).trim();
        if(rest) line = rest + marks;
      }
    }
    return line.trim();
  }).join('\n').trim();
}

/** حماية وسوم ASS/SSA من إدخال علامات داخل معاملاتها. */
function protectAssTags(text){
  const tags = [];
  const safe = String(text || '').replace(/\{[^}]*\}/g, (tag) => {
    const key = `\uE000${tags.length}\uE001`;
    tags.push(tag);
    return key;
  });
  return { safe, restore: (value) => value.replace(/\uE000(\d+)\uE001/g, (_, i) => tags[Number(i)] || '') };
}

/**
 * يعزل سطراً واحداً بصرياً:
 *  - يضيف RLM في بداية/نهاية السطر العربي.
 *  - يغلّف المقاطع اللاتينية بـ LRM من الجانبين.
 *  - يضع RLM قبل/بعد الترقيم الطرفي.
 */
function isolateLine(line, { assTags = false } = {}){
  if(!line) return '';
  const guard = assTags ? protectAssTags(line) : { safe: line, restore: (v) => v };
  let value = guard.safe;

  if(hasArabic(value)){
    // الأسماء/الأرقام اللاتينية تُعزل حتى لا تُسحب إلى ترتيب عربي معاكس.
    value = value.replace(LATIN_RUN_RE, (run) => `${LRM}${run}${LRM}`);
    // علامات الترقيم الطرفية تبقى ملتصقة بالجملة العربية.
    value = value.replace(/([.!?؟…])(?=\s|$)/g, `$1${RLM}`);
    value = `${RLM}${value}${RLM}`;
  } else if(hasLatin(value)){
    // سطر لاتيني خالص: LRM يثبّت الترقيم في نهايته داخل مشغل عربي.
    value = `${LRM}${value}${LRM}`;
  }

  return guard.restore(value);
}

/**
 * تجهيز نص الترجمة للتصدير أو العرض:
 *  - تنظيف الترقيم.
 *  - عزل كل سطر (RLM/LRM).
 *  - لا يلمس الأسطر الفارغة أو التوقيتات.
 *
 * @param {string} text
 * @param {{assTags?:boolean}} [opts]
 */
export function prepareSubtitleText(text, opts = {}){
  const normalized = normalizeSubtitlePunctuation(text);
  if(!normalized) return '';
  return normalized
    .split('\n')
    .map((line) => isolateLine(line, opts))
    .join('\n');
}

/** نسخة خفيفة للعرض داخل الواجهة (لا تضيف RLM حول كل سطر إذا لا يحتاج). */
export function prepareOverlayText(text){
  return prepareSubtitleText(text);
}

/** تحويل الأرقام العربية/الفارسية إلى لاتينية (مفيد لحسابات التوقيت اليدوية). */
export function toWesternDigits(value){
  return String(value || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

export default {
  RLM,
  LRM,
  FSI,
  PDI,
  hasArabic,
  hasLatin,
  detectTextDirection,
  stripBidi,
  normalizeSubtitlePunctuation,
  prepareSubtitleText,
  prepareOverlayText,
  toWesternDigits
};
