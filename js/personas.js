/**
 * personas.js — شخصيات العمل وقواعد الجنس/الأسلوب (Character Persona & Gender Lock)
 *
 * لكل شخصية:
 *  - source: الاسم الأصلي كما يظهر في النص
 *  - target: الاسم المترجم الثابت
 *  - gender: male | female | unspecified
 *  - style: formal | colloquial | sarcastic | neutral
 *
 * التخزين محلي فقط (localStorage) ولا يُرسل إلا داخل برومبت الترجمة.
 * هذا الملف نقي من ناحية الشبكة، ويحتوي واجهة صغيرة داخل نافذة القاموس.
 */

import { $, toast, escapeHtml } from './ui.js';

const PERSONA_KEY = 'srt_personas_v1';

const GENDERS = {
  male: 'ذكر',
  female: 'أنثى',
  unspecified: 'غير محدد'
};

const STYLES = {
  formal: 'رسمي',
  colloquial: 'عامي',
  sarcastic: 'ساخر',
  neutral: 'محايد'
};

function clean(value, max = 160){
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeGender(value){
  return Object.prototype.hasOwnProperty.call(GENDERS, value) ? value : 'unspecified';
}

function normalizeStyle(value){
  return Object.prototype.hasOwnProperty.call(STYLES, value) ? value : 'neutral';
}

export function normalizePersona(item){
  if(!item || typeof item !== 'object') return null;
  const source = clean(item.source || item.from || item.name);
  const target = clean(item.target || item.to || item.translation) || source;
  if(!source || !/[\p{L}]/u.test(source)) return null;
  return {
    source,
    target,
    gender: normalizeGender(item.gender),
    style: normalizeStyle(item.style)
  };
}

/** قراءة الشخصيات المحفوظة. */
export function getPersonas(){
  try {
    const raw = localStorage.getItem(PERSONA_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return (Array.isArray(list) ? list : []).map(normalizePersona).filter(Boolean);
  } catch(_) { return []; }
}

function savePersonas(list){
  const safe = (Array.isArray(list) ? list : []).map(normalizePersona).filter(Boolean);
  try { localStorage.setItem(PERSONA_KEY, JSON.stringify(safe)); } catch(_) {}
  return safe;
}

/**
 * كتلة قواعد صارمة تُحقن في برومبت الترجمة قبل القاموس.
 * @param {Array} [personas]
 */
export function getPersonaPromptBlock(personas = getPersonas()){
  const list = (Array.isArray(personas) ? personas : []).map(normalizePersona).filter(Boolean);
  if(!list.length) return '';
  const lines = list.map((p, i) => {
    return `${i + 1}. "${p.source}" => "${p.target}" | gender: ${p.gender} | speech style: ${p.style}`;
  });
  return `CHARACTER LOCK (STRICT — overrides all other instructions):
- Every character below has a fixed translated name, grammatical gender, and speech register.
- Never address, describe, or conjugate a female character with masculine forms, or a male character with feminine forms. Use the target language's natural gender agreement (verbs, adjectives, pronouns, titles).
- Keep each character's speech style consistent: formal = polite/standard, colloquial = everyday spoken, sarcastic = ironic/playful, neutral = natural.
- If the source leaves gender ambiguous, follow the gender listed here. Do not guess or change it.
${lines.join('\n')}`;
}

/**
 * إضافة شخصية جديدة أو تحديث شخصية موجودة بنفس الاسم الأصلي.
 * @returns {{ok:boolean, reason?:string, persona?:object}}
 */
export function addPersona(){
  const fromEl = $('personaFrom');
  const toEl = $('personaTo');
  const genderEl = $('personaGender');
  const styleEl = $('personaStyle');
  const persona = normalizePersona({
    source: fromEl ? fromEl.value : '',
    target: toEl ? toEl.value : '',
    gender: genderEl ? genderEl.value : 'unspecified',
    style: styleEl ? styleEl.value : 'neutral'
  });
  if(!persona){
    toast('أدخل اسم الشخصية الأصلي أولاً', '⚠️');
    return { ok: false, reason: 'empty' };
  }

  const list = getPersonas();
  const idx = list.findIndex(p => p.source.toLocaleLowerCase() === persona.source.toLocaleLowerCase());
  if(idx >= 0) list[idx] = persona;
  else list.push(persona);
  savePersonas(list);
  if(fromEl) fromEl.value = '';
  if(toEl) toEl.value = '';
  renderPersonaList();
  toast(idx >= 0 ? 'تم تحديث الشخصية' : 'أُضيفت الشخصية بنجاح', '🎭');
  return { ok: true, persona };
}

/** حذف شخصية بالفهرس. */
export function removePersona(index){
  const list = getPersonas();
  if(index < 0 || index >= list.length) return;
  list.splice(index, 1);
  savePersonas(list);
  renderPersonaList();
  toast('تم حذف الشخصية', '🗑️');
}

/** رسم قائمة الشخصيات داخل نافذة القاموس. */
export function renderPersonaList(){
  const list = $('personaList');
  if(!list) return;
  const personas = getPersonas();
  if(!personas.length){
    list.innerHTML = '<div class="persona-empty">لا توجد شخصيات بعد — أضف شخصيات العمل لتثبيت الجنس والأسلوب.</div>';
    return;
  }
  list.innerHTML = personas.map((p, index) => `
    <div class="persona-row">
      <span class="persona-name">${escapeHtml(p.source)} → ${escapeHtml(p.target)}</span>
      <span class="persona-tag gender-${p.gender}">${escapeHtml(GENDERS[p.gender] || GENDERS.unspecified)}</span>
      <span class="persona-tag style-${p.style}">${escapeHtml(STYLES[p.style] || STYLES.neutral)}</span>
      <button type="button" class="btn b-red b-sm" data-persona-remove="${index}" title="حذف الشخصية">🗑️</button>
    </div>`).join('');
}

/** ربط أزرار الحذف (مستمع واحد داخل نافذة القاموس). */
export function initPersonas(){
  try {
    renderPersonaList();
    const list = $('personaList');
    if(list){
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-persona-remove]');
        if(!btn) return;
        removePersona(Number(btn.dataset.personaRemove));
      });
    }
  } catch(_) {}
}

export { GENDERS, STYLES };
