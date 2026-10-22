/**
 * projects.js — القائمة الجانبية للمسودات والمشاريع (Sidebar Project Manager)
 *
 * المسؤولية:
 *  - درج جانبي ينزلق بنعومة (Off-canvas) مع خلفية معتمة وإغلاق بالنقر خارجه
 *  - حفظ "مشروع جديد" باسم مخصص + قائمة مشاريع ببطاقات (اسم/عدد أسطر/تاريخ)
 *  - استرجاع فوري للمحرر + حذف سريع بتأكيد + تفريغ كامل
 *  - يخزّن نصوص وتوقيتات SRT فقط {id,start,end,text} + وصفية — لا فيديو أبداً
 *    (الفيديو Object URL مؤقت ولا يتسع في حد 5MB لـ localStorage)
 *
 * ميزة معزولة: كل العمليات داخل try/catch — فشلها لا يوقف التطبيق.
 */

import { state } from './state.js';
import { $, toast, escapeHtml, setOverlay, bindOverlayDismiss } from './ui.js';
import { renderCards } from './editor.js';
import { showEditor } from './core.js';

const PROJECTS_KEY = 'srt_projects_v1';     // قائمة المشاريع المحفوظة
const MAX_PROJECTS = 30;                    // حد منطقي يحفظ مساحة localStorage

/* ════════════════════════════════════════════════════════════════
   محرك التخزين (Storage Engine) — نصوص وتوقيتات فقط، بلا فيديو
════════════════════════════════════════════════════════════════ */

/** بيانات المشروع النقية فقط (بلا أي Blob/ObjectURL) */
function snapshotPayload(name){
  return {
    name: name || 'بدون اسم',
    savedAt: Date.now(),
    count: state.blocks.length,
    uid: state.uid,
    blocks: state.blocks.map(b => ({ id: b.id, start: b.start, end: b.end, text: b.text }))
  };
}

function readProjects(){
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if(!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch(_){ return []; }
}

function writeProjects(list){
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
    return true;
  } catch(_){
    toast('مساحة التخزين ممتلئة — احذف مشاريع قديمة','⚠️');
    return false;
  }
}

/**
 * حفظ كمشروع جديد باسم مخصص (زر يدوي).
 */
export function saveProjectAs(){
  if(!state.blocks.length) return toast('لا يوجد محتوى لحفظه كمشروع','⚠️');
  const defaultName = ($('fnIn')?.value.trim()) || 'مشروع ' + new Date().toLocaleDateString('ar');
  const name = (window.prompt('اسم المشروع الجديد:', defaultName) || '').trim();
  if(!name) return;

  const list = readProjects();
  list.unshift(snapshotPayload(name));
  if(list.length > MAX_PROJECTS) list.length = MAX_PROJECTS;
  if(writeProjects(list)){
    renderProjectsList();
    toast(`تم حفظ المشروع: ${name}`,'💾');
  }
}

/**
 * استرجاع مشروع إلى المحرر فوراً (أسطر + مزامنة العرض).
 * @param {number} index
 */
export function openProject(index){
  try {
    const project = readProjects()[index];
    if(!project || !Array.isArray(project.blocks) || !project.blocks.length){
      return toast('المشروع فارغ أو تالف','⚠️');
    }
    state.blocks = project.blocks.map(b => ({ id: b.id, start: b.start, end: b.end, text: b.text || '' }));
    state.uid = project.uid || state.blocks.reduce((max, b) => Math.max(max, b.id || 0), 0);
    state.activeRowId = null;
    const nameInput = $('fnIn');
    if(nameInput) nameInput.value = project.name || 'subtitle';
    renderCards();
    showEditor();
    closeDrawer();
    toast(`تم فتح "${project.name}" (${project.blocks.length} سطر)`,'📂');
  } catch(_){ toast('تعذر فتح المشروع','⚠️'); }
}

/**
 * حذف مشروع بتأكيد سريع (confirm).
 * @param {number} index
 */
export function deleteProject(index){
  const list = readProjects();
  const project = list[index];
  if(!project) return;
  if(!window.confirm(`حذف المشروع "${project.name}" نهائياً؟`)) return;
  list.splice(index, 1);
  writeProjects(list);
  renderProjectsList();
  toast('تم حذف المشروع','🗑️');
}

/**
 * تفريغ كافة المسودات والمشاريع — بتأكيد مزدوج بسيط.
 */
export function clearAllProjects(){
  const count = readProjects().length;
  if(!count) return toast('لا توجد مشاريع محفوظة','📂');
  if(!window.confirm(`حذف كل المشاريع (${count}) نهائياً؟ لا يمكن التراجع.`)) return;
  try { localStorage.removeItem(PROJECTS_KEY); } catch(_){}
  renderProjectsList();
  toast('تم تفريغ كل المشاريع','🗑️');
}

/* ════════════════════════════════════════════════════════════════
   واجهة الدرج (Drawer UI)
════════════════════════════════════════════════════════════════ */

export function openDrawer(){
  if(!$('projectsDrawer')) return;
  renderProjectsList();
  setOverlay('projectsDrawer', true);
}

export function closeDrawer(){
  setOverlay('projectsDrawer', false);
}

export function toggleDrawer(){
  const overlay = $('projectsDrawer');
  if(!overlay) return;
  overlay.classList.contains('on') ? closeDrawer() : openDrawer();
}

/**
 * رسم بطاقات المشاريع (اسم/أسطر/تاريخ + استرجاع/حذف).
 */
export function renderProjectsList(){
  const box = $('projectsList');
  if(!box) return;
  const list = readProjects();
  if(!list.length){
    box.innerHTML = '<div class="projects-empty">📂 لا توجد مشاريع محفوظة بعد.<br>احفظ عملك الحالي بزر «حفظ كمشروع جديد».</div>';
    return;
  }
  box.innerHTML = list.map((project, index) => {
    const when = project.savedAt ? new Date(project.savedAt).toLocaleString('ar') : '';
    const count = Array.isArray(project.blocks) ? project.blocks.length : 0;
    return `<div class="project-card">
      <div class="proj-info">
        <div class="proj-name">${escapeHtml(project.name || 'بدون اسم')}</div>
        <div class="proj-meta">${count} سطر • ${when}</div>
      </div>
      <div class="proj-actions">
        <button class="btn b-green b-sm" data-action="open" data-index="${index}">📂 فتح</button>
        <button class="btn b-red b-sm" data-action="delete" data-index="${index}">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

/**
 * التهيئة: ربط الإغلاق بالنقر خارج الدرج + تفويض أزرار البطاقات.
 * يُستدعى من main.js عند الإقلاع.
 */
export function initProjects(){
  try {
    const overlay = $('projectsDrawer');
    const list = $('projectsList');
    bindOverlayDismiss(overlay, closeDrawer);
    if(list){
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if(!btn) return;
        const index = Number(btn.dataset.index);
        if(btn.dataset.action === 'open') openProject(index);
        else if(btn.dataset.action === 'delete') deleteProject(index);
      });
    }
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape') closeDrawer();
    });
    renderProjectsList();
  } catch(_){}
}
