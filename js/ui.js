/**
 * ui.js — عناصر واجهة الاستخدام العامة (Generic UI Helpers)
 *
 * المسؤولية: دوال مساعدة صغيرة عامة لا تنتمي لوحدة منطقية محددة،
 * تستخدمها عدة وحدات (إشعارات، تقدم، نوافذ، DOM مختصر).
 */

/** اختصار آمن لعنصر واحد. */
export const $ = (id) => document.getElementById(id);

/** اختصار آمن لعدة عناصر. */
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** تهريب النصوص قبل حقنها في HTML (نصوص المستخدم/أسماء المشاريع/المصطلحات). */
export function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/** كتابة HTML في عنصر (يتجاهل العنصر غير الموجود). */
export function setText(target, html){
  const el = typeof target === 'string' ? $(target) : target;
  if(el) el.innerHTML = html;
}

/** ضبط عرض شريط تقدم بنسبة مئوية آمنة. */
export function setBar(target, pct){
  const el = typeof target === 'string' ? $(target) : target;
  if(!el) return;
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.width = value + '%';
}

/** إظهار/إخفاء عنصر مع نوع العرض المطلوب. */
export function setVisible(target, show, display = 'block'){
  const el = typeof target === 'string' ? $(target) : target;
  if(el) el.style.display = show ? display : 'none';
}

/** فتح/إغلاق نافذة/درج يعتمد على الصنف on + خاصية hidden. */
export function setOverlay(target, open){
  const el = typeof target === 'string' ? $(target) : target;
  if(!el) return;
  el.hidden = !open;
  el.classList.toggle('on', open);
}

/** إغلاق النافذة عند النقر على الخلفية المعتمة نفسها. */
export function bindOverlayDismiss(target, close){
  const el = typeof target === 'string' ? $(target) : target;
  if(el) el.addEventListener('click', (e) => { if(e.target === el) close(); });
}

/**
 * إظهار إشعار toast مؤقت في أسفل الشاشة.
 * @param {string} msg نص الرسالة
 * @param {string} ico الأيقونة (افتراضي ✅)
 */
export function toast(msg, ico = '✅'){
  const el = $('toast');
  if(!el) return;
  $('tMsg').textContent = msg;
  $('tIco').textContent = ico;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 2600);
}

/** فتح/إغلاق لوحة محركات الذكاء الاصطناعي القابلة للطي. */
export function toggleAiBody(){
  const body = $('aiBody');
  if(!body) return;
  const isHide = body.style.display === 'none';
  body.style.display = isHide ? 'block' : 'none';
  $('aiHeadArrow').textContent = isHide ? '▲' : '▼';
}

// إغلاق أي قائمة منسدلة مفتوحة عند النقر خارجها (مستمع واحد عام).
document.addEventListener('click', (e) => {
  if(!e.target.closest('.row-menu-wrap')){
    $$('.row-dropdown-menu.show').forEach(menu => menu.classList.remove('show'));
  }
});
