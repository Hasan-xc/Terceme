/**
 * exporters.js — مصدّرات الترجمة (SRT / VTT / ASS)
 *
 * - SRT/VTT: يضيفان علامات RLM/LRM ويضبطان الترقيم قبل الكتابة.
 * - ASS: يبني ملفاً كاملاً بترويسة Styles يعكس إعدادات المظهر الحالية
 *   (الخط، الحجم، اللون، الحدود، الظل، الخلفية، والموضع).
 *
 * دوال نقية قدر الإمكان — لا تلمس DOM ولا ترسل أي طلب شبكة.
 */

import { formatMs } from './time.js';
import { blockDisplayText } from './state.js';
import { prepareSubtitleText } from './bidi.js';

const DEFAULT_STYLE = {
  size: '18px',
  font: "'Noto Naskh Arabic', serif",
  color: '#ffffff',
  shadowType: 'shadow',
  bg: 'rgba(0,0,0,0.45)',
  pos: 'bottom',
  outline: 2,
  shadowBlur: 4,
  bgOpacity: 45
};

const FONT_NAMES = {
  "'Noto Naskh Arabic', serif": 'Noto Naskh Arabic',
  "'Noto Sans Arabic', sans-serif": 'Noto Sans Arabic',
  "'Cairo', sans-serif": 'Cairo',
  "'Tajawal', sans-serif": 'Tajawal',
  "'Amiri', serif": 'Amiri',
  "'Noto Kufi Arabic', sans-serif": 'Noto Kufi Arabic',
  'system-ui, sans-serif': 'Arial'
};

function num(value, fallback, min, max){
  const n = Number(value);
  if(!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function styleWithDefaults(style){
  return { ...DEFAULT_STYLE, ...(style && typeof style === 'object' ? style : {}) };
}

function fontNameFromCss(font){
  return FONT_NAMES[font] || String(font || 'Noto Naskh Arabic').split(',')[0].replace(/['"]/g, '').trim() || 'Noto Naskh Arabic';
}

function parseHexColor(value){
  const raw = String(value || '').trim().replace(/^#/, '');
  if(/^[0-9a-f]{3}$/i.test(raw)){
    return {
      r: parseInt(raw[0] + raw[0], 16),
      g: parseInt(raw[1] + raw[1], 16),
      b: parseInt(raw[2] + raw[2], 16)
    };
  }
  if(/^[0-9a-f]{6}$/i.test(raw)){
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16)
    };
  }
  return { r: 255, g: 255, b: 255 };
}

/** ASS يستخدم BGR وبايت شفافية معاكس (00 = معتم، FF = شفاف). */
function toAssColor(hex, opacity = 0){
  const { r, g, b } = parseHexColor(hex);
  const alpha = Math.round(255 - (num(opacity, 0, 0, 100) / 100) * 255)
    .toString(16).padStart(2, '0').toUpperCase();
  const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
  return `&H${alpha}${hex2(b)}${hex2(g)}${hex2(r)}`;
}

function bgOpacityOf(style){
  if(String(style.bg) === 'transparent') return 0;
  const explicit = Number(style.bgOpacity);
  if(Number.isFinite(explicit) && explicit >= 0) return explicit;
  if(String(style.bg).includes('0.85')) return 85;
  if(String(style.bg).includes('0.45')) return 45;
  return 45;
}

/** HH:MM:SS.cc (ASS يستخدم سنتيثانية مفصولة بنقطة). */
export function formatAssTime(value){
  const ms = Math.max(0, Math.round(Number(value) || 0));
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** يحول توقيت HH:MM:SS,mmm المخزّن إلى مللي ثانية. */
function timeToMs(value){
  const parts = String(value || '00:00:00,000').replace(',', '.').split(':');
  if(parts.length === 3){
    return ((parseInt(parts[0], 10) || 0) * 3600
      + (parseInt(parts[1], 10) || 0) * 60
      + (parseFloat(parts[2]) || 0)) * 1000;
  }
  if(parts.length === 2){
    return ((parseInt(parts[0], 10) || 0) * 60 + (parseFloat(parts[1]) || 0)) * 1000;
  }
  return Math.max(0, (parseFloat(parts[0]) || 0) * 1000);
}

function textFor(block, tab){
  return blockDisplayText(block, tab);
}

function fallbackCount(blocks, tab){
  if(tab !== 'translated') return 0;
  return blocks.filter(b => !String(b.tr || '').trim()).length;
}

/**
 * SRT نصي كامل.
 * @param {Array} blocks
 * @param {'original'|'translated'} tab
 * @param {{bidi?:boolean}} opts
 */
export function buildSRT(blocks, tab = 'original', opts = {}){
  const withBidi = opts.bidi !== false;
  return (Array.isArray(blocks) ? blocks : []).map((block, i) => {
    let text = textFor(block, tab);
    if(withBidi) text = prepareSubtitleText(text);
    return `${i + 1}\n${block.start} --> ${block.end}\n${text}`;
  }).join('\n\n') + '\n';
}

/**
 * WebVTT نصي كامل.
 */
export function buildVTT(blocks, tab = 'original', opts = {}){
  const withBidi = opts.bidi !== false;
  const vttTime = (tc) => String(tc || '00:00:00,000').replace(',', '.');
  const body = (Array.isArray(blocks) ? blocks : []).map((block, i) => {
    let text = textFor(block, tab);
    if(withBidi) text = prepareSubtitleText(text);
    return `${i + 1}\n${vttTime(block.start)} --> ${vttTime(block.end)}\n${text}`;
  }).join('\n\n');
  return 'WEBVTT\n\n' + body + '\n';
}

/** ترويسة ASS مع انعكاس إعدادات المظهر. */
export function buildASSHeader(style = DEFAULT_STYLE){
  const s = styleWithDefaults(style);
  const fontName = fontNameFromCss(s.font);
  const fontSize = Math.round(num(parseFloat(s.size), 18, 8, 120) * 2.35);
  const outline = String(s.shadowType) === 'none' ? 0 : Math.round(num(s.outline, 2, 0, 12));
  const shadow = String(s.shadowType) === 'none' ? 0 : Math.round(num(s.shadowBlur, 4, 0, 24) / 4);
  const alignment = String(s.pos) === 'top' ? 8 : 2;
  const marginV = String(s.pos) === 'top' ? 48 : (String(s.pos) === 'bottom-low' ? 32 : 64);
  const primary = toAssColor(s.color, 0);
  const outlineColor = toAssColor('#000000', 0);
  const backColor = toAssColor('#000000', Math.max(0, bgOpacityOf(s)));

  return `[Script Info]
; Generated by Tercemeli
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primary},${primary},${outlineColor},${backColor},-1,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},48,48,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/** سطر Dialogue واحد — يهرب الأقواس حتى لا يفسّرها ASS كوسوم. */
export function buildASSDialogue(block, tab = 'original', opts = {}){
  const withBidi = opts.bidi !== false;
  let text = textFor(block, tab);
  if(withBidi) text = prepareSubtitleText(text, { assTags: true });
  text = text
    .replace(/\n/g, '\\N')
    .replace(/[{}]/g, (ch) => ch === '{' ? '｛' : '｝');
  const start = formatAssTime(timeToMs(block.start));
  const end = formatAssTime(timeToMs(block.end));
  return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
}

/**
 * ملف ASS كامل.
 * @param {Array} blocks
 * @param {'original'|'translated'} tab
 * @param {object} style إعدادات المظهر (getSubStyle)
 */
export function buildASS(blocks, tab = 'original', style = DEFAULT_STYLE, opts = {}){
  const body = (Array.isArray(blocks) ? blocks : [])
    .map((block) => buildASSDialogue(block, tab, opts))
    .join('\n');
  return buildASSHeader(style) + body + '\n';
}

/** عدد الأسطر التي ستُصدَّر بالأصل لأن الترجمة فارغة. */
export function countTranslationFallbacks(blocks, tab){
  return fallbackCount(Array.isArray(blocks) ? blocks : [], tab);
}

export { DEFAULT_STYLE, FONT_NAMES, fontNameFromCss, toAssColor, timeToMs };
