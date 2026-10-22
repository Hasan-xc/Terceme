/**
 * editor.js — محرر SRT (واجهة البطاقات + القائمة الزجاجية)
 *
 * المسؤولية:
 *  - رسم أسطر الترجمة كبطاقات (renderCards)
 *  - تعديل النص والتوقيتات لكل سطر (inline editing)
 *  - العمليات على السطر الواحد: حذف، إضافة، تقسيم، دمج
 *  - العمليات على الكل: إزاحة التوقيتات، بحث واستبدال، تنزيل SRT
 *  - القائمة المنسدلة (3 نقاط) وتفعيل السطر النشط
 */

import { state } from './state.js';
import { formatMs, parseTimeStringToMs, fmtTimeShort, toStandardTime } from './time.js';
import { $, $$, toast, escapeHtml } from './ui.js';
import { updateSubOverlayLive } from './styling.js';
import { captureHistory, scheduleTextCapture, undoHistory, redoHistory } from './history.js';
import { jumpToBlock } from './video.js';

/* ════════════════════════════════════════════════════════════════
   شارات سرعة القراءة (CPS) وطول السطر (CPL) — معايير الترجمة العالمية
   - CPS = عدد الأحرف ÷ مدة الظهور بالثواني: أخضر <17، أصفر 17-21، أحمر >21
   - CPL: تنبيه فقط إذا تجاوز أي سطر داخلي 42 حرفاً
   - الحساب عند الرسم فقط + debounce عند تعديل النص — صفر معالجة أثناء التشغيل
════════════════════════════════════════════════════════════════ */
const CPS_EASY = 17, CPS_HARD = 21, CPL_MAX = 42;
const badgeTimers = new Map();   // id → مؤقت debounce لكل بطاقة

function cpsClass(cps){
  if(cps < CPS_EASY) return 'cps-ok';
  if(cps <= CPS_HARD) return 'cps-mid';
  return 'cps-fast';
}

/** يحدّث شارة CPS/CPL لبطاقة واحدة (قراءة DOM محصورة داخل البطاقة) */
export function updateRowBadge(id){
  const b = state.blocks.find(x => x.id === id);
  const el = $('cps-' + id);
  if(!b || !el) return;
  const durSec = (parseTimeStringToMs(b.end) - parseTimeStringToMs(b.start)) / 1000;
  const chars = (b.text || '').replace(/\s+/g, ' ').trim().length;
  const cps = (durSec > 0.3 && chars > 0) ? Math.round(chars / durSec) : null;
  const maxLine = (b.text || '').split('\n').reduce((m, l) => Math.max(m, l.trim().length), 0);
  const cplOver = maxLine > CPL_MAX;
  if(cps === null){
    el.textContent = '⚡ —';
    el.className = 'cps-badge';
    el.title = 'سرعة القراءة غير محسوبة (مدة/نص غير صالح)';
  } else {
    el.textContent = '⚡' + cps + (cplOver ? ' ↵' + maxLine : '');
    el.className = 'cps-badge ' + cpsClass(cps);
    el.title = `سرعة القراءة: ${cps} حرف/ثانية (${cps < CPS_EASY ? 'مريح ✅' : cps <= CPS_HARD ? 'مقبول ⚠️' : 'سريع جداً ❌'})`
      + (cplOver ? ` — سطر طويل (${maxLine} حرفاً > ${CPL_MAX}) يُفضل تقسيمه` : '');
  }
}

/** debounce خفيف لتحديث شارة البطاقة عند انتهاء تعديل النص */
function scheduleBadgeUpdate(id){
  clearTimeout(badgeTimers.get(id));
  badgeTimers.set(id, setTimeout(() => { badgeTimers.delete(id); updateRowBadge(id); }, 500));
}

/* ════════════════════════════════════════════════════════════════
   CLEAN CARDS RENDERING (WITH GLASS 3-DOTS MENU)
══════════════════════════════════════════════════════════════ */

export function renderCards(){
  const container = $('subListContainer');
  if(!container) return;
  container.innerHTML = '';

  state.blocks.forEach((b, idx) => {
    const card = document.createElement('div');
    card.className = 'srt-card';
    card.id = 'row-' + b.id;
    if(state.activeRowId === b.id) card.classList.add('active-row');

    card.innerHTML = `
      <div class="srt-card-head">
        <div class="head-right">
          <span class="row-num-badge">#${idx + 1}</span>
          <span class="cps-badge" id="cps-${b.id}">⚡ —</span>
          <div class="row-menu-wrap">
            <button type="button" class="menu-dots-btn" data-action="menu" data-id="${b.id}" title="خيارات">⋮</button>
            <div class="row-dropdown-menu" id="menu-${b.id}">
              <button type="button" data-action="jump" data-id="${b.id}"><span>▶️</span> تشغيل من هنا</button>
              <button type="button" data-action="add-after" data-id="${b.id}"><span>➕</span> إضافة سطر تالٍ</button>
              <button type="button" data-action="split-line" data-id="${b.id}"><span>✂️</span> تقسيم السطر</button>
              <button type="button" data-action="merge-next" data-id="${b.id}"><span>🔗</span> دمج مع التالي</button>
              <div class="menu-divider"></div>
              <button type="button" class="menu-del-btn" data-action="delete-line" data-id="${b.id}"><span>🗑️</span> حذف السطر</button>
            </div>
          </div>
        </div>

        <div class="head-left">
          <div class="micro-time-box">
            <button type="button" class="m-step" data-action="step-time" data-id="${b.id}" data-field="start" data-delta="-100" title="-100ms">-</button>
            <input type="text" class="m-time-in" data-id="${b.id}" data-field="start" value="${fmtTimeShort(b.start)}">
            <button type="button" class="m-step" data-action="step-time" data-id="${b.id}" data-field="start" data-delta="100" title="+100ms">+</button>
          </div>
          <span class="time-arrow">→</span>
          <div class="micro-time-box">
            <button type="button" class="m-step" data-action="step-time" data-id="${b.id}" data-field="end" data-delta="-100" title="-100ms">-</button>
            <input type="text" class="m-time-in" data-id="${b.id}" data-field="end" value="${fmtTimeShort(b.end)}">
            <button type="button" class="m-step" data-action="step-time" data-id="${b.id}" data-field="end" data-delta="100" title="+100ms">+</button>
          </div>
        </div>
      </div>

      <div class="srt-card-body">
        <textarea class="inline-ta" id="ta-${b.id}" data-id="${b.id}">${escapeHtml(b.text || '')}</textarea>
      </div>
    `;
    container.appendChild(card);

    setTimeout(() => autoResizeTa($(`ta-${b.id}`)), 0);
    updateRowBadge(b.id);
  });

  // نقطة ربط سجل التراجع — فشلها صامت
  try { captureHistory(); } catch(_) {}

  if(typeof checkTrReady === 'function') checkTrReady();
}

export function toggleRowMenu(event, id) {
  event.stopPropagation();
  const currentMenu = $('menu-' + id);
  if(!currentMenu) return;
  const isOpen = currentMenu.classList.contains('show');

  // إغلاق باقي القوائم أولاً
  $$('.row-dropdown-menu.show').forEach(m => m.classList.remove('show'));

  if (!isOpen) currentMenu.classList.add('show');
}

function autoResizeTa(el) {
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(36, el.scrollHeight) + 'px';
}

/* ═══════════════ التعديل المباشر للنص والتوقيت ═══════════════ */

export function onTextInput(id, el) {
  const b = state.blocks.find(x => x.id === id);
  if(b) {
    b.text = el.value;
    autoResizeTa(el);
    updateSubOverlayLive();
    try { scheduleTextCapture(); scheduleBadgeUpdate(id); } catch(_) {}
  }
}

export function onRowClick(id) {
  state.activeRowId = id;
  $$('.srt-card').forEach(r => r.classList.remove('active-row'));
  const target = $('row-' + id);
  if(target) target.classList.add('active-row');
}

export function onTimeInputChange(id, field, el) {
  const b = state.blocks.find(x => x.id === id);
  if(b) {
    b[field] = toStandardTime(el.value);
    el.value = fmtTimeShort(b[field]);
    updateSubOverlayLive();
    try { captureHistory(); scheduleBadgeUpdate(id); } catch(_) {}
  }
}

export function stepBlockTime(id, field, deltaMs) {
  const b = state.blocks.find(x => x.id === id);
  if(!b) return;
  let ms = parseTimeStringToMs(b[field]) + deltaMs;
  ms = Math.max(0, ms);
  b[field] = formatMs(ms);

  const card = $('row-' + id);
  if(card) {
    const inputs = card.querySelectorAll('.m-time-in');
    if(field === 'start' && inputs[0]) inputs[0].value = fmtTimeShort(b.start);
    if(field === 'end' && inputs[1]) inputs[1].value = fmtTimeShort(b.end);
  }
  updateSubOverlayLive();
  try { captureHistory(); scheduleBadgeUpdate(id); } catch(_) {}
}

/* ═══════════════ عمليات السطر الواحد ═══════════════ */

export function delBlock(id){
  state.blocks = state.blocks.filter(x => x.id !== id);
  renderCards();
  toast('تم حذف السطر','🗑️');
}

export function addNewBlockAfter(id){
  const idx = state.blocks.findIndex(x => x.id === id);
  if(idx === -1) return;
  const current = state.blocks[idx];
  const curEndMs = parseTimeStringToMs(current.end);
  const nextStartMs = (idx + 1 < state.blocks.length) ? parseTimeStringToMs(state.blocks[idx+1].start) : curEndMs + 2500;

  const newStartMs = curEndMs;
  const newEndMs = Math.max(newStartMs + 1000, Math.min(newStartMs + 2500, nextStartMs));

  const newBlock = {
    id: ++state.uid,
    start: formatMs(newStartMs),
    end: formatMs(newEndMs),
    text: ''
  };

  state.blocks.splice(idx + 1, 0, newBlock);
  renderCards();
  const nextTa = $(`ta-${newBlock.id}`);
  if(nextTa) nextTa.focus();
  toast('تمت إضافة سطر جديد','➕');
}

export function addNewBlockEnd(){
  let startMs = 0;
  if(state.blocks.length > 0) {
    startMs = parseTimeStringToMs(state.blocks[state.blocks.length - 1].end);
  }
  const newBlock = {
    id: ++state.uid,
    start: formatMs(startMs),
    end: formatMs(startMs + 3000),
    text: ''
  };
  state.blocks.push(newBlock);
  renderCards();

  const container = $('subListContainer');
  container.scrollTop = container.scrollHeight;
  const nextTa = $(`ta-${newBlock.id}`);
  if(nextTa) nextTa.focus();
}

export function mergeWithNext(id){
  const idx = state.blocks.findIndex(x => x.id === id);
  if(idx === -1 || idx === state.blocks.length - 1) return toast('لا يوجد سطر تالٍ لدمجه','⚠️');

  const current = state.blocks[idx];
  const next = state.blocks[idx + 1];

  current.text = (current.text.trim() + ' ' + next.text.trim()).trim();
  current.end = next.end;

  state.blocks.splice(idx + 1, 1);
  renderCards();
  toast('تم دمج السطرين بنجاح','🔗');
}

export function splitBlock(id){
  const idx = state.blocks.findIndex(x => x.id === id);
  if(idx === -1) return;
  const current = state.blocks[idx];
  const ta = $(`ta-${id}`);

  let splitIndex = -1;
  if(ta && typeof ta.selectionStart === 'number' && ta.selectionStart > 0 && ta.selectionStart < current.text.length) {
    splitIndex = ta.selectionStart;
  } else {
    const mid = Math.floor(current.text.length / 2);
    const spaceBefore = current.text.lastIndexOf(' ', mid);
    const spaceAfter = current.text.indexOf(' ', mid);
    if(spaceBefore !== -1) splitIndex = spaceBefore;
    else if(spaceAfter !== -1) splitIndex = spaceAfter;
    else splitIndex = mid;
  }

  const text1 = current.text.substring(0, splitIndex).trim();
  const text2 = current.text.substring(splitIndex).trim();

  if(!text1 || !text2) return toast('ضع المؤشر داخل النص لتحديد مكان التقسيم','⚠️');

  const startMs = parseTimeStringToMs(current.start);
  const endMs = parseTimeStringToMs(current.end);
  const totalDuration = Math.max(500, endMs - startMs);
  const ratio = text1.length / (text1.length + text2.length || 1);
  const splitMs = Math.round(startMs + (totalDuration * ratio));

  current.text = text1;
  current.end = formatMs(splitMs);

  const newBlock = {
    id: ++state.uid,
    start: formatMs(splitMs),
    end: formatMs(endMs),
    text: text2
  };

  state.blocks.splice(idx + 1, 0, newBlock);
  renderCards();
  toast('تم تقسيم السطر بنجاح','✂️');
}

/* ═══════════════ التقسيم التلقائي للأسطر الطويلة (بدون AI) ═══════════════ */

const SPLIT_LIMIT_KEY = 'srt_split_limit';
const SPLIT_MIN_MS = 700; // أقل مدة عرض مقبولة لأي جزء — لا تقسيم دونها

function splitSmart(text, max) {
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return [text];
  for (const re of [/(?<=[.!?؟…])\s+/, /(?<=[,،;؛:])\s+/]) {
    const parts = text.split(re);
    if (parts.length > 1) return parts.flatMap(p => splitSmart(p, max));
  }
  const words = text.split(' ');
  if (words.length < 2) return [text];
  let best = 1, bestDiff = Infinity, len = 0;
  for (let i = 0; i < words.length - 1; i++) {
    len += words[i].length + 1;
    let diff = Math.abs(len - text.length / 2);
    if (words[i].length <= 2) diff += 8; // لا تنهِ السطر بكلمة قصيرة
    if (diff < bestDiff) { bestDiff = diff; best = i + 1; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')]
    .flatMap(p => splitSmart(p, max));
}

function mergeTiny(parts, max, min = 12) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && (p.length < min || last.length < min) && last.length + 1 + p.length <= max)
      out[out.length - 1] = last + ' ' + p;
    else out.push(p);
  }
  return out;
}

function applySplit(block, max) {
  const parts = mergeTiny(splitSmart(block.text, max), max);
  const s = parseTimeStringToMs(block.start), e = parseTimeStringToMs(block.end);
  const dur = e - s;
  if (parts.length < 2 || dur < parts.length * SPLIT_MIN_MS) return [block];
  const total = parts.reduce((a, p) => a + p.length, 0);
  let t = s;
  return parts.map((p, i) => {
    const end = i === parts.length - 1 ? e : t + Math.round(dur * p.length / total);
    const b = { id: ++state.uid, start: formatMs(t), end: formatMs(end), text: p };
    t = end;
    return b;
  });
}

export function saveSplitLimit(){
  try {
    const el = $('splitMaxIn');
    const v = parseInt(el && el.value, 10);
    if(Number.isFinite(v) && v >= 1) localStorage.setItem(SPLIT_LIMIT_KEY, String(v));
  } catch(_) {}
}

export function initSplitLimit(){
  try {
    const el = $('splitMaxIn');
    const saved = localStorage.getItem(SPLIT_LIMIT_KEY);
    if(el && saved && parseInt(saved, 10) >= 1) el.value = saved;
  } catch(_) {}
}

export function splitLongLines(){
  try {
    const el = $('splitMaxIn');
    const raw = parseInt(el && el.value, 10);
    if(!Number.isFinite(raw) || raw < 1 || raw > 500) return toast('حد أقصى الحروف غير صالح','⚠️');

    const originalIds = state.blocks.map(b => b.id);
    captureHistory(); // لقطة قبل التعديل — التراجع يعيد الأصل بضغطة واحدة
    state.blocks = state.blocks.flatMap(b => applySplit(b, raw));
    const newIds = new Set(state.blocks.map(b => b.id));
    const splitCount = originalIds.filter(id => !newIds.has(id)).length;
    renderCards();

    if(splitCount === 0) return toast('لا توجد أسطر طويلة','✂️');
    toast(`تم تقسيم ${splitCount} ${splitCount === 1 ? 'سطر' : 'أسطر'}`,'✂️');
  } catch(_) { toast('تعذر تنفيذ التقسيم','⚠️'); }
}

/* ═══════════════ عمليات الكل (إزاحة، بحث، تنزيل) ═══════════════ */

export function shiftAllTimes(direction) {
  const delta = parseInt($('shiftVal').value) || 500;
  const shiftAmount = delta * direction;

  state.blocks.forEach(b => {
    const s = Math.max(0, parseTimeStringToMs(b.start) + shiftAmount);
    const e = Math.max(0, parseTimeStringToMs(b.end) + shiftAmount);
    b.start = formatMs(s);
    b.end = formatMs(e);
  });
  renderCards();
  toast(`تمت إزاحة التوقيتات بمقدار ${shiftAmount > 0 ? '+' : ''}${shiftAmount}ms`,'⏱');
}

export function highlightMatches() {
  const q = $('findIn').value.trim().toLowerCase();
  $$('.srt-card').forEach(r => r.classList.remove('match-row'));
  if(!q) return;

  state.blocks.forEach(b => {
    if(b.text && b.text.toLowerCase().includes(q)) {
      const r = $('row-' + b.id);
      if(r) r.classList.add('match-row');
    }
  });
}

export function replaceAllMatches() {
  const findStr = $('findIn').value;
  const repStr = $('replaceIn').value;
  if(!findStr) return toast('أدخل نص البحث أولاً','⚠️');

  let count = 0;
  state.blocks.forEach(b => {
    if(b.text && b.text.includes(findStr)) {
      b.text = b.text.replaceAll(findStr, repStr);
      count++;
    }
  });

  renderCards();
  toast(`تم استبدال النصوص في ${count} سطر`,'✅');
}

function downloadText(text, extension, mime){
  const name = (($('fnIn') || {}).value || 'subtitle') + extension;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
}

export function dlSRT(){
  if(state.blocks.length === 0) return toast('لا يوجد محتوى لتنزيله','⚠️');
  const text = state.blocks.map((b,i) => `${i+1}\n${b.start} --> ${b.end}\n${b.text}`).join('\n\n') + '\n';
  downloadText(text, '.srt', 'text/plain;charset=utf-8');
}

/**
 * تصدير WebVTT — نفس منطق dlSRT لكن بصيغة WebVTT الصحيحة:
 * سطر "WEBVTT" في البداية + فواصل توقيت بنقطة بدل الفاصلة (00:00:01.000).
 */
export function dlVTT(){
  try {
    if(state.blocks.length === 0) return toast('لا يوجد محتوى لتنزيله','⚠️');
    const vttTime = (tc) => String(tc || '00:00:00,000').replace(',', '.');
    const text = 'WEBVTT\n\n' + state.blocks.map((b,i) => `${i+1}\n${vttTime(b.start)} --> ${vttTime(b.end)}\n${b.text}`).join('\n\n') + '\n';
    downloadText(text, '.vtt', 'text/vtt;charset=utf-8');
    toast('تم تنزيل ملف VTT','⬇️');
  } catch(_) { toast('تعذر تصدير VTT','⚠️'); }
}

/* ═══════════════ تفويض أحداث المحرر (مستمع واحد للبطاقات وشريط الأدوات) ═══════════════ */

/**
 * مستمع واحد على #edSec يغطي:
 *  - أزرار البطاقات المولدة ديناميكياً (قائمة، إضافة، تقسيم، دمج، حذف، خطوة زمنية)
 *  - شريط الأدوات (استبدال، إزاحة، إضافة سطر، تراجع/إعادة، تقسيم، تنزيل)
 *  - حقول النص والتوقيت والبحث والتقسيم
 * بدلاً من عشرات onclick/oninput المضمنة.
 */
export function initEditorControls(){
  const shell = $('edSec');
  if(!shell) return;

  const actions = {
    menu: (btn, event) => toggleRowMenu(event, Number(btn.dataset.id)),
    jump: (btn) => jumpToBlock(Number(btn.dataset.id)),
    'add-after': (btn) => addNewBlockAfter(Number(btn.dataset.id)),
    'split-line': (btn) => splitBlock(Number(btn.dataset.id)),
    'merge-next': (btn) => mergeWithNext(Number(btn.dataset.id)),
    'delete-line': (btn) => delBlock(Number(btn.dataset.id)),
    'step-time': (btn) => stepBlockTime(Number(btn.dataset.id), btn.dataset.field, Number(btn.dataset.delta)),
    replace: replaceAllMatches,
    'shift-back': () => shiftAllTimes(-1),
    'shift-fwd': () => shiftAllTimes(1),
    'add-end': addNewBlockEnd,
    undo: undoHistory,
    redo: redoHistory,
    'split-long': splitLongLines,
    'download-srt': dlSRT,
    'download-vtt': dlVTT
  };

  shell.addEventListener('click', (event) => {
    const textarea = event.target.closest('.inline-ta');
    if(textarea) onRowClick(Number(textarea.dataset.id));

    const btn = event.target.closest('[data-action]');
    if(!btn) return;
    const action = actions[btn.dataset.action];
    if(action) action(btn, event);
  });

  shell.addEventListener('input', (event) => {
    const textarea = event.target.closest('.inline-ta');
    if(textarea) return onTextInput(Number(textarea.dataset.id), textarea);
    if(event.target.id === 'findIn') return highlightMatches();
    if(event.target.id === 'splitMaxIn') return saveSplitLimit();
  });

  shell.addEventListener('change', (event) => {
    const input = event.target.closest('.m-time-in');
    if(input) onTimeInputChange(Number(input.dataset.id), input.dataset.field, input);
  });
}
