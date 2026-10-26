/**
 * styling.js — تخصيص مظهر الترجمة الحية على الفيديو
 *
 * المسؤولية:
 *  - فتح/إغلاق لوحة تخصيص المظهر
 *  - تطبيق اختيارات المستخدم (حجم/نوع/لون/ظل/خلفية/موضع/حدود) على متغيرات CSS
 *  - حفظ التفضيلات في localStorage واستعادتها عند التحميل
 *  - تحديث overlay الترجمة فوراً عند تعديل النص أو التوقيت في المحرر
 *  - توفير getSubStyle() لمصدّر ASS ولحرق الفيديو
 */

import { state, blockDisplayText } from './state.js';
import { parseTimeStringToMs } from './time.js';
import { $ } from './ui.js';
import { prepareOverlayText, detectTextDirection } from './bidi.js';

const PREFS_KEY = 'sub_style_prefs';

const DEFAULTS = {
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

const STYLE_INPUTS = {
  size: 'stSize',
  font: 'stFont',
  color: 'stColor',
  shadowType: 'stShadow',
  bg: 'stBg',
  pos: 'stPos',
  outline: 'stOutline',
  shadowBlur: 'stShadowBlur',
  bgOpacity: 'stBgOpacity'
};

function clampNumber(value, fallback, min, max){
  const n = Number(value);
  if(!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readSubStyle(){
  const pref = {};
  for(const [key, id] of Object.entries(STYLE_INPUTS)){
    const el = $(id);
    pref[key] = el && el.value !== undefined ? el.value : DEFAULTS[key];
  }
  pref.outline = clampNumber(pref.outline, DEFAULTS.outline, 0, 12);
  pref.shadowBlur = clampNumber(pref.shadowBlur, DEFAULTS.shadowBlur, 0, 24);
  pref.bgOpacity = clampNumber(pref.bgOpacity, DEFAULTS.bgOpacity, 0, 100);
  if(!pref.size) pref.size = DEFAULTS.size;
  if(!pref.font) pref.font = DEFAULTS.font;
  if(!pref.color) pref.color = DEFAULTS.color;
  if(!pref.shadowType) pref.shadowType = DEFAULTS.shadowType;
  if(!pref.bg) pref.bg = DEFAULTS.bg;
  if(!pref.pos) pref.pos = DEFAULTS.pos;
  return pref;
}

/** بناء ظل النص حسب الإعدادات (يُستخدم أيضاً في ASS/Canvas). */
function buildShadow(pref){
  if(String(pref.shadowType) === 'none') return 'none';
  const blur = clampNumber(pref.shadowBlur, 4, 0, 24);
  const outline = clampNumber(pref.outline, 2, 0, 12);
  if(String(pref.shadowType) === 'heavy'){
    const ring = Math.max(1, outline);
    return [
      `-${ring}px -${ring}px 0 #000`,
      `${ring}px -${ring}px 0 #000`,
      `-${ring}px ${ring}px 0 #000`,
      `${ring}px ${ring}px 0 #000`,
      `0 3px ${blur + 2}px rgba(0,0,0,.95)`
    ].join(', ');
  }
  if(String(pref.shadowType) === 'soft'){
    return `0 0 ${Math.max(4, blur + 4)}px rgba(0,0,0,.88)`;
  }
  return `0 2px ${Math.max(1, blur)}px rgba(0,0,0,.94), 0 0 2px #000`;
}

function opacityFromBg(bg){
  if(String(bg) === 'transparent') return 0;
  const match = String(bg || '').match(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([0-9.]+)\s*\)/);
  if(match) return Math.round(Number(match[1]) * 100);
  return 45;
}

function backgroundOf(pref){
  if(String(pref.bg) === 'transparent') return 'transparent';
  const opacity = clampNumber(pref.bgOpacity, 45, 0, 100) / 100;
  return `rgba(0,0,0,${opacity})`;
}

function applySubStyle(pref){
  const root = document.documentElement.style;
  root.setProperty('--sub-font-size', pref.size || DEFAULTS.size);
  root.setProperty('--sub-font-family', pref.font || DEFAULTS.font);
  root.setProperty('--sub-color', pref.color || DEFAULTS.color);
  root.setProperty('--sub-shadow', buildShadow(pref));
  root.setProperty('--sub-outline', String(clampNumber(pref.outline, 2, 0, 12)) + 'px');
  root.setProperty('--sub-bg-color', backgroundOf(pref));

  const top = String(pref.pos) === 'top' ? '10%' : 'auto';
  const bottom = String(pref.pos) === 'top'
    ? 'auto'
    : (String(pref.pos) === 'bottom-low' ? '5%' : '12%');
  root.setProperty('--sub-top', top);
  root.setProperty('--sub-bottom', bottom);
}

/** إعدادات المظهر الحالية — كائن مستقل يستخدمه ASS وCanvas. */
export function getSubStyle(){
  const pref = readSubStyle();
  return {
    ...pref,
    outline: clampNumber(pref.outline, 2, 0, 12),
    shadowBlur: clampNumber(pref.shadowBlur, 4, 0, 24),
    bgOpacity: clampNumber(pref.bgOpacity, 45, 0, 100)
  };
}

/** تنسيق النص للعرض على الفيديو — يضيف علامات الاتجاه ويضبط dir. */
export function formatOverlayText(text){
  return prepareOverlayText(String(text || ''));
}

/** يضبط اتجاه عنصر الترجمة (rtl/ltr) حسب النص. */
export function applyOverlayDirection(el, text){
  if(!el) return;
  el.dir = detectTextDirection(text);
  const hasAr = /[\u0600-\u06FF]/.test(text);
  const hasLat = /[A-Za-z]/.test(text);
  el.classList.toggle('bidi-pure-rtl', hasAr && !hasLat);
  el.classList.toggle('bidi-mixed', hasAr && hasLat);
}

export function toggleStylePanel(){
  const panel = $('stylePanel');
  if(!panel) return;
  const isHide = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = isHide ? 'block' : 'none';
  const ico = $('styleToggleIco');
  if(ico) ico.textContent = isHide ? '⚙️ إغلاق ▲' : '⚙️ إعدادات المظهر ▼';
}

export function updateSubStyles(){
  const pref = readSubStyle();
  applySubStyle(pref);
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(pref)); } catch(_) {}
}

export function loadSavedSubStyles(){
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
    const pref = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    if(saved && saved.bgOpacity === undefined && saved.bg) pref.bgOpacity = opacityFromBg(saved.bg);
    for(const [key, id] of Object.entries(STYLE_INPUTS)){
      const el = $(id);
      if(el && pref[key] !== undefined) el.value = pref[key];
    }
    applySubStyle(readSubStyle());
  } catch(_) {
    applySubStyle({ ...DEFAULTS });
  }
}

/** مستمع واحد لتغييرات لوحة المظهر (بدل onchange مكرر على كل حقل). */
export function initStyleControls(){
  const panel = $('stylePanel');
  if(panel) panel.addEventListener('change', updateSubStyles);
  const bgEl = $('stBg');
  const opacityEl = $('stBgOpacity');
  if(bgEl && opacityEl){
    bgEl.addEventListener('change', () => {
      opacityEl.value = String(opacityFromBg(bgEl.value));
      const out = $('stBgOpacityVal');
      if(out) out.textContent = opacityEl.value;
    });
  }
  const ranges = ['stOutline', 'stShadowBlur', 'stBgOpacity'];
  ranges.forEach((id) => {
    const el = $(id);
    if(el){
      const out = document.getElementById(id + 'Val');
      const sync = () => { if(out) out.textContent = el.value; };
      el.addEventListener('input', () => { sync(); updateSubStyles(); });
      sync();
    }
  });
}

/**
 * يحدّث نص الترجمة الظاهر على الفيديو بناءً على زمن التشغيل الحالي.
 * تُستدعى من المحرر عند كل تعديل للنص أو التوقيت (تحديث لحظي).
 */
export function updateSubOverlayLive(){
  const video = $('mainVideo');
  const subDom = $('subTextDom');
  if(!video || !subDom) return;
  const ct = video.currentTime;
  const active = state.blocks.find((b) => {
    const s = parseTimeStringToMs(b.start) / 1000;
    const e = parseTimeStringToMs(b.end) / 1000;
    return s <= ct && ct <= e;
  });
  const raw = active ? blockDisplayText(active) : '';
  const text = raw.trim() ? formatOverlayText(raw) : '';
  subDom.textContent = text;
  applyOverlayDirection(subDom, raw);
  subDom.style.display = text ? 'inline-block' : 'none';
}

export { DEFAULTS as SUB_STYLE_DEFAULTS, buildShadow, backgroundOf };
