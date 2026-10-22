/**
 * autosave.js — حفظ المسودة محلياً (يدوي) + استرجاعها عند الإقلاع
 *
 * المسؤولية:
 *  - حفظ state.blocks في localStorage عند الضغط على زر الحفظ (حفظ يدوي)
 *  - عند تحميل الصفحة: لو توجد مسودة محفوظة، يعرض شريطاً صغيراً يسأل
 *    "فيه مسودة محفوظة، تبي تسترجعها؟" مع زرين (نعم / تجاهل)
 *  - لا يستبدل بيانات المستخدم تلقائياً أبداً بدون تأكيده
 *
 * ميزة معزولة: كل العمليات داخل try/catch — فشلها لا يوقف التطبيق.
 */

import { state } from './state.js';
import { $, toast } from './ui.js';
import { renderCards } from './editor.js';
import { showEditor } from './core.js';

const AUTOSAVE_KEY = 'srt_autosave_v1';

let lastSavedJson = '';

/** حفظ فوري للمسودة (زر الحفظ اليدوي). */
export function saveDraftNow(){
  try {
    if(!state.blocks.length) { toast('لا يوجد نص لحفظه بعد','⚠️'); return; }
    const payload = JSON.stringify({ savedAt: Date.now(), blocks: state.blocks });
    if(payload === lastSavedJson) { toast('تم الحفظ 💾','💾'); return; } // محفوظ أصلاً
    localStorage.setItem(AUTOSAVE_KEY, payload);
    lastSavedJson = payload;
    toast('تم الحفظ 💾','💾');
  } catch(_) {}
}

/**
 * قراءة المسودة إن وجدت (بدون تعديل أي شيء).
 * @returns {object|null} {savedAt, blocks} أو null
 */
function peekDraft(){
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if(!raw) return null;
    const data = JSON.parse(raw);
    if(!Array.isArray(data.blocks) || !data.blocks.length) return null;
    return data;
  } catch(_) { return null; }
}

/**
 * استرجاع المسودة إلى المحرر (يُستدعى فقط بعد تأكيد المستخدم).
 * @returns {boolean} نجاح الاسترجاع
 */
export function restoreDraft(){
  try {
    const data = peekDraft();
    if(!data) return false;
    state.blocks = data.blocks;
    state.uid = state.blocks.reduce((m, b) => Math.max(m, b.id || 0), 0);
    renderCards();
    showEditor();
    toast('تم استرجاع المسودة المحفوظة','💾');
    return true;
  } catch(_) { return false; }
}

/* ═══════════════ شريط سؤال الاسترجاع (توست صغير بزرين) ═══════════════ */

function dismissDraftBar(){
  const bar = $('draftBar');
  if(bar) bar.classList.remove('on');
}

function showDraftPrompt(draft){
  if($('draftBar')) return;
  const count = draft.blocks.length;
  const when = draft.savedAt ? new Date(draft.savedAt).toLocaleTimeString() : '';
  const bar = document.createElement('div');
  bar.id = 'draftBar';
  bar.className = 'draft-bar';
  bar.innerHTML =
    `<span>💾 فيه مسودة محفوظة (${count} سطر${when ? ' — ' + when : ''})، تبي تسترجعها؟</span>` +
    '<button class="btn b-green b-sm" id="draftYes">نعم</button>' +
    '<button class="btn b-ghost b-sm" id="draftNo">تجاهل</button>';
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('on'));
  $('draftYes').addEventListener('click', () => {
    dismissDraftBar();
    restoreDraft();
  });
  $('draftNo').addEventListener('click', () => {
    dismissDraftBar();
    toast('تم تجاهل المسودة (ما زالت محفوظة)','👌');
  });
}

/**
 * التهيئة عند إقلاع الصفحة — يعرض سؤال الاسترجاع إن وُجدت مسودة.
 */
export function initAutosave(){
  try {
    const draft = peekDraft();
    if(draft) showDraftPrompt(draft);
  } catch(_) {}
}
