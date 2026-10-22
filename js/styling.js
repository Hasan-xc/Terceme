/**
 * styling.js — تخصيص مظهر الترجمة الحية على الفيديو
 *
 * المسؤولية:
 *  - فتح/إغلاق لوحة تخصيص المظهر
 *  - تطبيق اختيارات المستخدم (حجم/نوع/لون/ظل/خلفية/مكان) على متغيرات CSS
 *  - حفظ التفضيلات في localStorage واستعادتها عند التحميل
 *  - تحديث overlay الترجمة فوراً عند تعديل النص أو التوقيت في المحرر
 */

import { state } from './state.js';
import { parseTimeStringToMs } from './time.js';
import { $ } from './ui.js';

const PREFS_KEY = 'sub_style_prefs';

const SHADOWS = {
  shadow: '0px 2px 4px rgba(0,0,0,0.9), 0px 0px 2px #000',
  heavy: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0px 3px 6px rgba(0,0,0,0.9)',
  soft: '0px 0px 8px rgba(0,0,0,0.8)'
};

const POSITIONS = {
  top: ['10%', 'auto'],
  'bottom-low': ['auto', '5%'],
  default: ['auto', '12%']
};

const STYLE_INPUTS = {
  size: 'stSize',
  font: 'stFont',
  color: 'stColor',
  shadowType: 'stShadow',
  bg: 'stBg',
  pos: 'stPos'
};

export function toggleStylePanel(){
  const panel = $('stylePanel');
  if(!panel) return;
  const isHide = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = isHide ? 'block' : 'none';
  $('styleToggleIco').textContent = isHide ? '⚙️ إغلاق ▲' : '⚙️ إعدادات المظهر ▼';
}

function readSubStyle(){
  return Object.fromEntries(
    Object.entries(STYLE_INPUTS).map(([key, id]) => [key, ($(id) || {}).value || ''])
  );
}

function applySubStyle(pref){
  const root = document.documentElement.style;
  root.setProperty('--sub-font-size', pref.size);
  root.setProperty('--sub-font-family', pref.font);
  root.setProperty('--sub-color', pref.color);
  root.setProperty('--sub-shadow', SHADOWS[pref.shadowType] || 'none');
  root.setProperty('--sub-bg-color', pref.bg);

  const [top, bottom] = POSITIONS[pref.pos] || POSITIONS.default;
  root.setProperty('--sub-top', top);
  root.setProperty('--sub-bottom', bottom);
}

export function updateSubStyles(){
  const pref = readSubStyle();
  applySubStyle(pref);
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(pref)); } catch(_) {}
}

export function loadSavedSubStyles(){
  try {
    const pref = JSON.parse(localStorage.getItem(PREFS_KEY));
    if(!pref) return;
    Object.entries(STYLE_INPUTS).forEach(([key, id]) => {
      if(pref[key]) $(id).value = pref[key];
    });
    applySubStyle(readSubStyle());
  } catch(_) {}
}

/** مستمع واحد لتغييرات لوحة المظهر (بدل onchange مكرر على كل حقل). */
export function initStyleControls(){
  const panel = $('stylePanel');
  if(panel) panel.addEventListener('change', updateSubStyles);
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
  const text = active && active.text.trim() ? active.text : '';
  subDom.textContent = text;
  subDom.style.display = text ? 'inline-block' : 'none';
}
