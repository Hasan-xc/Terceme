/**
 * main.js — نقطة الدخول الرئيسية للتطبيق
 *
 * المسؤولية:
 *  - استيراد كل الوحدات وربطها ببعضها
 *  - تهيئة المستمعات (رفع الملفات، الفيديو، التفريغ) مرة واحدة
 *  - استعادة الإعدادات والمفاتيح المحفوظة من localStorage عند الإقلاع
 *  - تعريض الدوال التي تستخدمها معالجات HTML الضمنية (onclick/oninput/...)
 *    على نطاق window، لأن ES Modules لا تضع الدوال في النطاق العام تلقائياً.
 */

import { $, toast, toggleAiBody, escapeHtml, setOverlay, bindOverlayDismiss } from './ui.js';
import { initTheme } from './theme.js';
import {
  DEFAULT_OR_MODEL, getOrModels, getSelectedOrModel,
  selectOrModel, addOrModel, removeOrModel
} from './models.js';
import {
  saveApiKey, saveOrApiKey, saveKieApiKey, saveTargetLangPref,
  setTrProvider, setSttProvider, saveGeminiPrefs, saveGeminiApiKey,
  onPA, processInput, initCoreEvents, refreshKeyBadges, toggleSectionKey
} from './core.js';
import { initEditorControls, initSplitLimit } from './editor.js';
import { togglePlay, skipVid, removeVideo, showVidSec, initVideoEvents } from './video.js';
import { toggleStylePanel, loadSavedSubStyles, initStyleControls } from './styling.js';
import {
  checkAiReady, startAi, pauseAi, resumeAi, cancelAi,
  onAudioQualityChange, cancelExtraction,
  aiPlayExtracted, aiDownloadExtracted, initTranscribeEvents
} from './transcribe.js';
import {
  checkTrReady, startTranslation,
  cancelAiTask, retryMissingTranslation
} from './translate.js';
import { initAutosave, saveDraftNow } from './autosave.js';
import { initHistory } from './history.js';
import { initGlossary, toggleGlossary, addGlossaryPair } from './glossary.js';
import {
  toggleDrawer, closeDrawer, saveProjectAs, clearAllProjects, initProjects
} from './projects.js';

/* ═══════════════════════════════════════
   تعريض الدوال لمعالجات HTML الضمنية
   (أزرار البطاقات والبحث وشريط الأدوات تُدار بتفويض داخل editor.js)
═════════════════════════════════════ */
Object.assign(window, {
  // ui
  toggleAiBody,
  // core (الإعدادات والإدخال)
  onPA, processInput, saveApiKey, saveOrApiKey, saveKieApiKey,
  saveGeminiApiKey, saveGeminiPrefs, setSttProvider,
  saveTargetLangPref, setTrProvider, toggleSectionKey,
  // video (المشغل والمزامنة)
  togglePlay, skipVid, removeVideo, showVidSec,
  // styling (مظهر الترجمة)
  toggleStylePanel,
  // transcribe (التفريغ واستخراج الصوت)
  checkAiReady, startAi, pauseAi, resumeAi, cancelAi,
  onAudioQualityChange, cancelExtraction,
  aiPlayExtracted, aiDownloadExtracted,
  // translate (الترجمة)
  checkTrReady, startTranslation,
  cancelAiTask, retryMissingTranslation,
  // ميزات إضافية (الحفظ اليدوي، قاموس المصطلحات)
  saveDraftNow, toggleGlossary, addGlossaryPair,
  // القائمة الجانبية للمسودات والمشاريع
  closeDrawer, saveProjectAs, clearAllProjects
});

/* ═══════════════════════════════════════
   تسجيل Service Worker (PWA) — فشله لا يوقف التطبيق
═══════════════════════════════════════ */
try {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => {
        console.warn('sw register:', e && e.message);
      });
    });
  }
} catch (e) { console.warn('sw:', e && e.message); }

/* ═══════════════════════════════════════
   قائمة الهمبرغر (Overlay off-canvas) + زر «تثبيت التطبيق» (PWA)
═══════════════════════════════════════ */
let navOverlayEl = null;
let navBtnEl = null;

function navIsOpen(){ return !!navOverlayEl && navOverlayEl.classList.contains('on'); }

function openNav(){
  if(!navOverlayEl) return;
  setOverlay(navOverlayEl, true);
  if(navBtnEl){ navBtnEl.textContent = '✕'; navBtnEl.setAttribute('aria-expanded', 'true'); }
}

function closeNav(){
  if(!navOverlayEl) return;
  setOverlay(navOverlayEl, false);
  if(navBtnEl){ navBtnEl.textContent = '☰'; navBtnEl.setAttribute('aria-expanded', 'false'); }
}

function initNavMenu(){
  navOverlayEl = $('hamburgerOverlay');
  navBtnEl = $('menuBtn');
  const menuDrawer = $('menuDrawer');
  const menuInstall = $('menuInstall');
  const iosHint = $('iosInstallHint');
  const textMode = $('menuTextMode');
  if(!navOverlayEl || !navBtnEl) return;

  // الزر ☰ نفسه = toggle، ويتحول إلى ✕ أثناء الفتح (نفس مكانه)
  navBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    navIsOpen() ? closeNav() : openNav();
  });

  // «أعمالي المحفوظة» — نفس الدرج الحالي بلا تغيير منطقه
  if(menuDrawer) menuDrawer.addEventListener('click', () => {
    closeNav();
    toggleDrawer();
  });

  // «تفريغ نصي» — مخفي حتى يُبنى مسار #/text لاحقاً
  if(textMode) textMode.hidden = true;

  bindOverlayDismiss(navOverlayEl, closeNav);
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && navIsOpen()) closeNav();
  });

  /* ── زر التثبيت: يظهر فقط عند توفر beforeinstallprompt ── */
  let deferredPrompt = null;
  const isStandalone = () => {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    } catch(_) { return false; }
  };
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if(!isStandalone() && menuInstall) menuInstall.hidden = false;
  });

  if(menuInstall) menuInstall.addEventListener('click', async () => {
    if(deferredPrompt){
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if(outcome === 'accepted') menuInstall.hidden = true;
      deferredPrompt = null;
    }
    closeNav();
  });

  // iOS لا يدعم beforeinstallprompt → إرشاد نصي (وليس في وضع standalone)
  if(isIOS() && !isStandalone() && iosHint) iosHint.hidden = false;

  // مُثبّت بالفعل → أخفِ كل ما يتعلق بالتثبيت
  window.addEventListener('appinstalled', () => {
    if(menuInstall) menuInstall.hidden = true;
    if(iosHint) iosHint.hidden = true;
  });

  if(isStandalone()){
    if(menuInstall) menuInstall.hidden = true;
    if(iosHint) iosHint.hidden = true;
  }
}

/* ═══════════════════════════════════════
   إدارة نماذج OpenRouter: قائمة منسدلة + إضافة/حذف مع تأكيد
═══════════════════════════════════════ */
let confirmCardEl = null;

function setOrMenuOpen(open){
  const menu = $('orModelMenu');
  const btn = $('orModelCurrent');
  const picker = $('orModelPicker');
  if(!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if(picker) picker.classList.toggle('open', !!open);
}

function renderOrModelPicker(){
  const current = $('orModelCurrentName');
  const list = $('orModelMenu');
  if(!current || !list) return;

  const models = getOrModels();
  const selected = getSelectedOrModel();
  current.textContent = selected;

  const currentBtn = $('orModelCurrent');
  if(currentBtn) currentBtn.title = 'النموذج الحالي: ' + selected;

  list.innerHTML = models.map((name) => {
    const safe = escapeHtml(name);
    const active = name === selected;
    const isDefault = name === DEFAULT_OR_MODEL;
    return '<div class="or-model-item-row' + (active ? ' active' : '') + '">' +
      '<button type="button" class="or-model-item' + (active ? ' active' : '') + '" data-model="' + safe + '" role="option" aria-selected="' + (active ? 'true' : 'false') + '">' +
        '<span class="or-model-name" dir="ltr">' + safe + '</span>' +
        (isDefault ? '<span class="or-model-badge">افتراضي</span>' : '') +
        (active ? '<span class="or-model-check" aria-hidden="true">✓</span>' : '') +
      '</button>' +
      (isDefault ? '' : '<button type="button" class="or-model-del" data-delete-model="' + safe + '" aria-label="حذف النموذج" title="حذف النموذج">🗑️</button>') +
    '</div>';
  }).join('');
}

function showOrAddCard(show){
  const card = $('orAddModelCard');
  const trigger = $('orModelAddBtn');
  const input = $('orModelNameIn');
  if(!card) return;
  card.hidden = !show;
  if(trigger) trigger.hidden = !!show;
  if(show){
    setOrMenuOpen(false);
    if(input){ input.value = ''; input.focus(); }
  }
}

function submitOrModel(){
  const input = $('orModelNameIn');
  if(!input) return;
  const name = input.value.trim();
  if(!name) return toast('اكتب اسم النموذج أولاً', '⚠️');

  const result = addOrModel(name);
  if(!result.ok){
    if(result.reason === 'duplicate') toast('هذا النموذج موجود في القائمة بالفعل', 'ℹ️');
    return;
  }

  input.value = '';
  showOrAddCard(false);
  renderOrModelPicker();
  toast('تمت إضافة النموذج: ' + name, '✅');
}

function closeOrConfirm(){
  if(confirmCardEl) confirmCardEl.remove();
  confirmCardEl = null;
}

function confirmDeleteOrModel(name){
  if(!name) return toast('لا يوجد نموذج محدد للحذف', '⚠️');
  if(name === DEFAULT_OR_MODEL){
    return toast('النموذج الافتراضي محمي من الحذف', '🔒');
  }
  closeOrConfirm();
  setOrMenuOpen(false);

  const ov = document.createElement('div');
  ov.className = 'confirm-overlay';
  ov.innerHTML =
    '<div class="confirm-card">' +
      '<div class="confirm-title">🗑️ حذف النموذج</div>' +
      '<div class="confirm-text">سيُحذف من القائمة: <b dir="ltr">' + escapeHtml(name) + '</b></div>' +
      '<div class="confirm-actions">' +
        '<button type="button" class="btn b-ghost b-sm" id="orDelCancel">إلغاء</button>' +
        '<button type="button" class="btn b-red b-sm" id="orDelConfirm">تأكيد الحذف</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  confirmCardEl = ov;

  bindOverlayDismiss(ov, closeOrConfirm);
  $('orDelCancel').addEventListener('click', closeOrConfirm);
  $('orDelConfirm').addEventListener('click', () => {
    const result = removeOrModel(name);
    closeOrConfirm();
    renderOrModelPicker();
    toast(result.ok ? 'حُذف النموذج: ' + name : 'تعذّر حذف النموذج', result.ok ? '🗑️' : '⚠️');
  });
}

function initOrModelManager(){
  const currentBtn = $('orModelCurrent');
  const menu = $('orModelMenu');
  const addBtn = $('orModelAddBtn');
  const saveBtn = $('orModelSaveBtn');
  const cancelBtn = $('orModelCancelBtn');
  const input = $('orModelNameIn');
  if(!currentBtn || !menu) return;

  // ضمان وجود اختيار محفوظ صالح (الافتراضي عند أول استخدام).
  selectOrModel(getSelectedOrModel());
  renderOrModelPicker();

  currentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOrMenuOpen(menu.hidden);
  });

  menu.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-model]');
    if(del){
      e.stopPropagation();
      confirmDeleteOrModel(del.dataset.deleteModel);
      return;
    }
    const item = e.target.closest('[data-model]');
    if(!item) return;
    if(selectOrModel(item.dataset.model)){
      setOrMenuOpen(false);
      renderOrModelPicker();
    }
  });

  if(addBtn) addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showOrAddCard(true);
  });
  if(saveBtn) saveBtn.addEventListener('click', submitOrModel);
  if(cancelBtn) cancelBtn.addEventListener('click', () => showOrAddCard(false));
  if(input) input.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); submitOrModel(); }
    else if(e.key === 'Escape'){ e.preventDefault(); showOrAddCard(false); }
  });

  // إغلاق القائمة عند النقر خارجها أو Escape (مرة واحدة فقط).
  if(document.documentElement.dataset.orModelOutsideBound !== '1'){
    document.documentElement.dataset.orModelOutsideBound = '1';
    document.addEventListener('click', (e) => {
      if(!e.target.closest('#orModelPicker') && !e.target.closest('#orAddModelCard') && !e.target.closest('#orModelAddBtn')){
        setOrMenuOpen(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape') setOrMenuOpen(false);
    });
  }
}

function restoreValue(id, key){
  const value = localStorage.getItem(key);
  const el = $(id);
  if(value && el) el.value = value;
}

window.addEventListener('DOMContentLoaded', () => {
  // ── المظهر النهاري/الليلي (يتبع النظام ما لم يختر المستخدم) ──
  try { initTheme(); } catch(e) { console.warn('theme init:', e); }

  // ── استعادة المفاتيح المحفوظة ──
  restoreValue('aiKeyIn', 'groq_api_key');
  restoreValue('geminiKeyIn', 'gemini_api_key');
  restoreValue('orKeyIn', 'openrouter_api_key');
  restoreValue('kieKeyIn', 'kie_api_key');

  // ── استعادة التفضيلات المحفوظة ──
  restoreValue('trTargetLang', 'tr_target_lang');

  // ── مزوّد التفريغ: Groq افتراضيًا، أو Gemini إذا اختاره المستخدم ──
  if(localStorage.getItem('gemini_word_ts') === '0'){
    const wordTs = $('geminiWordTs');
    if(wordTs) wordTs.checked = false;
  }
  if(localStorage.getItem('gemini_diarization') === '0'){
    const diarization = $('geminiDiarization');
    if(diarization) diarization.checked = false;
  }
  const savedStt = (localStorage.getItem('stt_provider') === 'gemini') ? 'gemini' : 'groq';
  try { setSttProvider(savedStt); } catch(e) { console.warn('stt provider:', e); }
  try { checkAiReady(); } catch(_) {}

  // ── مزوّد الترجمة: استعادة المحفوظ أو Kie.ai افتراضياً ──
  const savedProvider = (localStorage.getItem('tr_provider') === 'openrouter') ? 'openrouter' : 'kie';
  setTrProvider(savedProvider);
  try { initOrModelManager(); } catch(e) { console.warn('or models:', e); }

  loadSavedSubStyles();
  checkTrReady();
  try { refreshKeyBadges(); } catch(e) { console.warn('key badges:', e); }
  try { initSplitLimit(); } catch(e) { console.warn('split limit:', e); }

  // ── ربط المستمعات (مرة واحدة) ──
  initCoreEvents();
  initTranscribeEvents();
  initVideoEvents();
  initStyleControls();
  initEditorControls();

  // ── قائمة الهيدر (همبرغر): فتح/إغلاق بالنقر خارجه أو Escape ──
  try { initNavMenu(); } catch(e) { console.warn('nav menu:', e); }

  // ── تهيئة الميزات الإضافية — فشل أي منها لا يوقف الباقي ──
  try { initAutosave(); } catch(e) { console.warn('autosave init:', e); }
  try { initHistory(); } catch(e) { console.warn('history init:', e); }
  try { initGlossary(); } catch(e) { console.warn('glossary init:', e); }
  try { initProjects(); } catch(e) { console.warn('projects init:', e); }
});
