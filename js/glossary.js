/**
 * glossary.js — قاموس المصطلحات الثابتة (Glossary)
 *
 * المسؤولية:
 *  - واجهة نافذة صغيرة يضيف فيها المستخدم أزواج "مصطلح أصلي → ترجمة ثابتة"
 *  - الحفظ في localStorage (مفتاح مستقل: srt_glossary_v1)
 *  - توفير getGlossaryPromptBlock() التي تُحقن في برومبت الترجمة داخل
 *    translate.js كقاعدة إلزامية رقم 6 (فقط عند وجود أزواج —
 *    القاموس الفارغ = برومبت مطابق للأصل حرفياً)
 *  - لا تؤثر على بنية الطلب الأساسية
 *
 * ميزة معزولة: كل العمليات داخل try/catch — فشلها لا يوقف التطبيق.
 */

import { $, toast, escapeHtml, setOverlay, bindOverlayDismiss } from './ui.js';

const GLOSSARY_KEY = 'srt_glossary_v1';

/** قراءة أزواج القاموس من localStorage. @returns {Array<{from:string,to:string}>} */
function loadGlossary(){
  try {
    const raw = localStorage.getItem(GLOSSARY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(p => p && p.from && p.to) : [];
  } catch(_) { return []; }
}

function saveGlossary(pairs){
  try { localStorage.setItem(GLOSSARY_KEY, JSON.stringify(pairs)); } catch(_) {}
}

/** أزواج القاموس ككائنات {from,to} — للاستخدام في تحقق الترجمة. */
export function getGlossaryPairs(){
  try { return loadGlossary().slice(); } catch(_) { return []; }
}

/**
 * كتلة القاموس النصية للبرومبت — فارغة إذا لا توجد أزواج.
 * تُستدعى من buildTranslationPrompt في translate.js.
 */
export function getGlossaryPromptBlock(){
  try {
    const pairs = loadGlossary();
    if(!pairs.length) return '';
    return pairs.map(p => `- "${p.from}" => "${p.to}"`).join('\n');
  } catch(_) { return ''; }
}

/** فتح/إغلاق نافذة القاموس. */
export function toggleGlossary(){
  const overlay = $('glossaryOverlay');
  if(!overlay) return;
  const open = !overlay.classList.contains('on');
  setOverlay(overlay, open);
  if(open) renderGlossaryList();
}

/** رسم قائمة الأزواج داخل النافذة. */
function renderGlossaryList(){
  const list = $('glossaryList');
  if(!list) return;
  const pairs = loadGlossary();
  if(!pairs.length){
    list.innerHTML = '<div class="glossary-empty">لا توجد مصطلحات بعد — أضف أول زوج من الحقول بالأسفل</div>';
    return;
  }
  list.innerHTML = pairs.map((pair, index) => `
    <div class="glossary-row">
      <span class="g-from">${escapeHtml(pair.from)}</span>
      <span class="g-arrow">←</span>
      <span class="g-to">${escapeHtml(pair.to)}</span>
      <button class="btn b-red b-sm" data-action="remove" data-index="${index}" title="حذف">🗑️</button>
    </div>`).join('');
}

/** إضافة زوج جديد من حقول الإدخال. */
export function addGlossaryPair(){
  try {
    const fromEl = $('glossFrom');
    const toEl = $('glossTo');
    const from = (fromEl.value || '').trim();
    const to = (toEl.value || '').trim();
    if(!from || !to) return toast('أدخل المصطلح والترجمة معاً','⚠️');
    const pairs = loadGlossary();
    if(pairs.some(p => p.from.toLowerCase() === from.toLowerCase())){
      return toast('هذا المصطلح موجود بالقاموس','⚠️');
    }
    pairs.push({ from, to });
    saveGlossary(pairs);
    fromEl.value = '';
    toEl.value = '';
    renderGlossaryList();
    toast('تمت إضافة المصطلح للقاموس','📖');
  } catch(_) {}
}

/** حذف زوج بالفهرس. */
export function removeGlossaryPair(index){
  try {
    const pairs = loadGlossary();
    if(index < 0 || index >= pairs.length) return;
    pairs.splice(index, 1);
    saveGlossary(pairs);
    renderGlossaryList();
    toast('تم حذف المصطلح','🗑️');
  } catch(_) {}
}

/**
 * التهيئة عند الإقلاع: رسم القائمة المحفوظة + إغلاق النافذة بالنقر خلفها.
 */
export function initGlossary(){
  try {
    renderGlossaryList();
    bindOverlayDismiss('glossaryOverlay', toggleGlossary);
    const list = $('glossaryList');
    if(list){
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove"]');
        if(btn) removeGlossaryPair(Number(btn.dataset.index));
      });
    }
  } catch(_) {}
}
