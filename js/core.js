/**
 * core.js — النواة: الإعدادات، المفاتيح، ومعالجة الإدخال
 *
 * المسؤولية:
 *  - قراءة/حفظ مفاتيح API وإعدادات التفريغ والترجمة من localStorage
 *  - معالجة النص أو ملف SRT الملصق وتحويله إلى blocks
 *  - التحكم في مزود الترجمة (OpenRouter / Kie.ai)
 *  - إظهار المحرر
 *
 * لا يحتوي على أي منطق استدعاء شبكة (يوجد في transcribe.js / translate.js).
 */

import { state, makeBlock, setActiveTab } from './state.js';
import { $, toast } from './ui.js';
import { parseSubtitlesAnyFormat } from './parsers.js';
import { renderCards } from './editor.js';
import { checkTrReady } from './translate.js';

/* ═══════════════ حفظ المفاتيح والإعدادات ═══════════════ */

/* ── مفاتيح API: زر مصغّر في رأس القسم + لوحة إدخال قابلة للطي ── */
const KEY_MAP = {
  groq:   { panel: 'keyPanelGroq',   input: 'aiKeyIn',     ls: 'groq_api_key',       label: 'Groq' },
  gemini: { panel: 'keyPanelGemini', input: 'geminiKeyIn', ls: 'gemini_api_key',     label: 'Gemini' },
  or:     { panel: 'keyPanelOr',     input: 'orKeyIn',     ls: 'openrouter_api_key', label: 'OpenRouter' },
  kie:    { panel: 'keyPanelKie',    input: 'kieKeyIn',    ls: 'kie_api_key',        label: 'Kie.ai' }
};

function keyEls(which){
  const m = KEY_MAP[which];
  return {
    panel: m ? $(m.panel) : null,
    input: m ? $(m.input) : null,
    ls: m ? m.ls : null,
    label: m ? m.label : which
  };
}

/**
 * فتح/إغلاق درع إدخال مفتاح (Toggle). فتح واحد يغلق الباقي
 * لتبقى الواجهة مضغوطة على الهاتف.
 */
export function toggleKeyPanel(which){
  const els = keyEls(which);
  if(!els.panel) return;
  const willOpen = !els.panel.classList.contains('open');
  // Accordion: إغلاق بقية الأدرع
  Object.keys(KEY_MAP).forEach(k => setKeyPanelOpen(k, false));
  setKeyPanelOpen(which, willOpen);
}

/**
 * ضبط حالة درع المفتاح (مفتوح/مغلق) + تحديث شارة الحالة.
 */
export function setKeyPanelOpen(which, open){
  const els = keyEls(which);
  if(!els.panel) return;
  els.panel.classList.toggle('open', !!open);
  if(open && els.input) els.input.focus();
  refreshKeyBadges();
}

/** هل يوجد مفتاح محفوظ فعلاً في localStorage؟ */
function keyIsSet(which){
  const els = keyEls(which);
  if(!els.ls) return false;
  const saved = localStorage.getItem(els.ls);
  return !!(saved && String(saved).trim());
}

/**
 * تحديث زر المفتاح المصغّر في رأس القسم: 🔑 + ✓/✕
 * الزر يعرض مفتاح المزوّد النشط حالياً فقط، ويتغير مع التبويب.
 */
function updateSectionKeyBtn(btnId, flagId, which){
  const btn = $(btnId);
  const flag = $(flagId);
  if(!btn || !flag) return;

  const els = keyEls(which);
  const set = keyIsSet(which);
  const text = `مفتاح ${els.label}: ${set ? 'مُعيّن' : 'غير متوفر'} — اضغط للإدخال أو التعديل`;

  flag.textContent = set ? '✓' : '✕';
  flag.classList.toggle('ok', set);
  flag.classList.toggle('miss', !set);
  btn.title = text;
  btn.setAttribute('aria-label', text);

  const open = !!(els.panel && els.panel.classList.contains('open'));
  btn.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * تحديث زرّي المفاتيح في رأسَي القسمين حسب المزوّد النشط.
 * (تقرأ من localStorage — مصدر الحقيقة الفعلي)
 */
export function refreshKeyBadges(){
  const stt = state.sttProvider === 'gemini' ? 'gemini' : 'groq';
  const tr = state.trProvider === 'openrouter' ? 'or' : 'kie';
  updateSectionKeyBtn('sttKeyBtn', 'sttKeyState', stt);
  updateSectionKeyBtn('trKeyBtn', 'trKeyState', tr);
}

/** فتح/إغلاق لوحة مفتاح المزوّد النشط في القسم المطلوب. */
export function toggleSectionKey(section){
  const which = section === 'stt'
    ? (state.sttProvider === 'gemini' ? 'gemini' : 'groq')
    : (state.trProvider === 'openrouter' ? 'or' : 'kie');
  toggleKeyPanel(which);
}

/** تحديث أزرار الجاهزية بعد أي تغيير في المفتاح. */
function refreshReady(which){
  if(which === 'groq' || which === 'gemini'){
    if(typeof window.checkAiReady === 'function') window.checkAiReady();
  } else {
    checkTrReady();
  }
}

/**
 * حفظ فوري للمفتاح في localStorage أثناء الكتابة (بلا زر حفظ).
 * مسح الحقل = مسح المفتاح من التخزين، مع تحديث الشارة والحالة مباشرة.
 */
function persistKey(which){
  const els = keyEls(which);
  if(!els.input || !els.ls) return false;
  const key = els.input.value.trim();
  try {
    if(key) localStorage.setItem(els.ls, key);
    else localStorage.removeItem(els.ls);
  } catch(_) {}

  refreshKeyBadges();
  refreshReady(which);
  return !!key;
}

function saveKey(which, emptyMessage, successMessage){
  if(!persistKey(which)) return toast(emptyMessage, '⚠️');
  toast(successMessage, '🔐');
  setKeyPanelOpen(which, false);
}

export function saveApiKey(){
  saveKey('groq', 'أدخل المفتاح أولاً', 'تم حفظ مفتاح Groq');
}
export function saveGeminiApiKey(){
  saveKey('gemini', 'أدخل مفتاح Gemini أولاً', 'تم حفظ مفتاح Gemini');
}
export function saveOrApiKey(){
  saveKey('or', 'أدخل المفتاح أولاً', 'تم حفظ مفتاح OpenRouter');
}
export function saveKieApiKey(){
  saveKey('kie', 'أدخل المفتاح أولاً', 'تم حفظ إعدادات Kie.ai');
}
export function saveTargetLangPref(){
  const select = $('trTargetLang');
  if(!select) return;
  try { localStorage.setItem('tr_target_lang', select.value); } catch(_) {}
}

/* ═══════════════ مزوّد التفريغ الصوتي (Groq / Gemini) ═══════════════ */

/**
 * تبديل مزوّد التفريغ وحفظ الاختيار.
 * يتحكم بإظهار كتلة المفتاح المناسبة فقط، ويترك خيارات الملف والصوت مشتركة.
 */
export function setSttProvider(p){
  const provider = (p === 'gemini') ? 'gemini' : 'groq';
  state.sttProvider = provider;
  try { localStorage.setItem('stt_provider', provider); } catch(_) {}

  const isGroq = provider === 'groq';
  const groqBlock = $('sttGroqBlock');
  const geminiBlock = $('sttGeminiBlock');
  const groqBtn = $('sttBtnGroq');
  const geminiBtn = $('sttBtnGemini');

  if(groqBlock) groqBlock.style.display = isGroq ? '' : 'none';
  if(geminiBlock) geminiBlock.style.display = isGroq ? 'none' : '';
  if(groqBtn) { groqBtn.classList.toggle('active', isGroq); groqBtn.setAttribute('aria-selected', isGroq ? 'true' : 'false'); }
  if(geminiBtn) { geminiBtn.classList.toggle('active', !isGroq); geminiBtn.setAttribute('aria-selected', isGroq ? 'false' : 'true'); }

  // إغلاق لوحتي مفتاح التفريغ عند تبديل المزوّد حتى لا يبقى حقل مخفي مفتوحاً.
  setKeyPanelOpen('groq', false);
  setKeyPanelOpen('gemini', false);

  const dropSub = document.querySelector('#aiDrop .ai-drop-sub');
  if(dropSub){
    dropSub.textContent = provider === 'gemini'
      ? 'تفريغ Gemini 3.5 — أجزاء 20 دقيقة مع طوابع زمنية وتمييز متحدثين'
      : 'تفريغ دفعات زمنية (20 دقيقة لكل جزء) مع ضغط MP3 وإرسال متوازٍ';
  }

  refreshKeyBadges();
  // checkAiReady معرّفة عالميًا في main.js (نمط التطبيق الحالي)
  if(typeof window.checkAiReady === 'function') window.checkAiReady();
}

/** حفظ تفضيلات Gemini (الطوابع الزمنية وتمييز المتحدثين). */
export function saveGeminiPrefs(){
  const words = $('geminiWordTs');
  const diar = $('geminiDiarization');
  try {
    localStorage.setItem('gemini_word_ts', words && words.checked ? '1' : '0');
    localStorage.setItem('gemini_diarization', diar && diar.checked ? '1' : '0');
  } catch(_) {}
}

/* ═══════════════ تبديل مزود الترجمة ═══════════════ */

export function setTrProvider(p){
  const provider = p === 'openrouter' ? 'openrouter' : 'kie';
  state.trProvider = provider;
  try { localStorage.setItem('tr_provider', provider); } catch(_) {}

  const isOr = provider === 'openrouter';
  const provOR = $('provBtnOR'), provKie = $('provBtnKie');
  if(provOR){ provOR.classList.toggle('active', isOr); provOR.setAttribute('aria-selected', isOr ? 'true' : 'false'); }
  if(provKie){ provKie.classList.toggle('active', !isOr); provKie.setAttribute('aria-selected', isOr ? 'false' : 'true'); }
  const orBlock = $('orBlock'), kieBlock = $('kieBlock');
  if(orBlock) orBlock.style.display = isOr ? 'block' : 'none';
  if(kieBlock) kieBlock.style.display = isOr ? 'none' : 'block';

  // إغلاق لوحتي مفتاح الترجمة عند تبديل المزوّد.
  setKeyPanelOpen('or', false);
  setKeyPanelOpen('kie', false);

  refreshKeyBadges();
  checkTrReady();
}

/* ═══════════════ معالجة الإدخال (نص أو SRT) ═══════════════ */

export function onPA(){
  const paste = $('pasteArea');
  const btn = $('procBtn');
  if(btn) btn.disabled = !(paste && paste.value.trim());
}

/**
 * يحوّل نص textarea الملصق (أو محتوى ملف مرفوع) إلى state.blocks.
 * يدعم الآن جميع الصيغ الشائعة عبر parseSubtitlesAnyFormat (المرحلة 1):
 * SRT / VTT / ASS / SSA / SBV / SUB / LRC / نص عادي — يُكتشف تلقائياً.
 * @param {string} [filename] اسم الملف الأصلي (يساعد الكشف عند رفع ملف؛
 *   يُترك فارغاً عند اللصق اليدوي فيعتمد الكشف على محتوى النص فقط)
 */
export function processInput(filename = ''){
  const paste = $('pasteArea');
  const raw = paste ? paste.value : '';
  if(!raw.trim()) return;

  state.blocks = []; state.uid = 0;
  parseSubtitlesAnyFormat(raw, filename).forEach((item) => {
    state.blocks.push(makeBlock({ start: item.start, end: item.end, text: item.text, tr: item.tr }));
  });

  setActiveTab('original');
  showEditor(); renderCards();
  checkTrReady();
  toast('تم تحميل الأسطر بنجاح','✅');
}

export function showEditor(){
  const inputCard = $('inputCard');
  const editor = $('edSec');
  const uploadBar = $('vidUploadBar');
  if(inputCard) inputCard.style.display = 'none';
  if(editor) editor.style.display = 'block';
  if(uploadBar) uploadBar.style.display = 'block';
}

/* ═══════════════ تهيئة مستمعات رفع الملفات النصية ═══════════════ */

/**
 * يربط مستمع change لحقل رفع ملفات SRT/TXT (النصية فقط).
 * يُستدعى مرة واحدة من main.js عند بدء التشغيل.
 */
export function initCoreEvents(){
  const fileInput = $('fileIn');
  if(fileInput){
    fileInput.addEventListener('change', function(){
      const file = this.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const paste = $('pasteArea');
        if(paste) paste.value = e.target.result;
        onPA(); processInput(file.name);
        toast('تم رفع "' + file.name + '"','📂');
      };
      reader.readAsText(file, 'UTF-8');
      this.value = '';
    });
  }

  // حفظ تلقائي فوري لمفاتيح API — لا يوجد زر حفظ.
  Object.keys(KEY_MAP).forEach((which) => {
    const input = keyEls(which).input;
    if(!input || input.dataset.autosaveBound === '1') return;
    input.dataset.autosaveBound = '1';
    input.addEventListener('input', () => persistKey(which));
    input.addEventListener('change', () => persistKey(which));
    input.addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){
        e.preventDefault();
        persistKey(which);
        setKeyPanelOpen(which, false);
      } else if(e.key === 'Escape'){
        e.preventDefault();
        setKeyPanelOpen(which, false);
      }
    });
  });

  // النقر خارج حقل المفتاح أو زرّه يطوي اللوحة المفتوحة.
  if(document.documentElement.dataset.keyOutsideBound !== '1'){
    document.documentElement.dataset.keyOutsideBound = '1';
    document.addEventListener('click', (e) => {
      if(e.target.closest('.key-panel') || e.target.closest('.key-icon-btn')) return;
      Object.keys(KEY_MAP).forEach((which) => {
        const panel = keyEls(which).panel;
        if(panel && panel.classList.contains('open')) setKeyPanelOpen(which, false);
      });
    });
  }
}
