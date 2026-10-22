/**
 * models.js — نماذج OpenRouter المخصّصة
 *
 * مصدر الحقيقة الوحيد هو localStorage:
 *   or_custom_models : مصفوفة أسماء النماذج
 *   or_selected_model: النموذج المختار حالياً
 *
 * النموذج الافتراضي محمي من الحذف ويظهر دائماً في أعلى القائمة.
 */

export const DEFAULT_OR_MODEL = 'anthropic/claude-haiku-5.5';

const MODELS_KEY = 'or_custom_models';
const SELECTED_KEY = 'or_selected_model';

function cleanName(value){
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueNames(list){
  const seen = new Set();
  const out = [];
  for(const raw of list){
    const name = cleanName(raw);
    if(!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** القائمة الكاملة: الافتراضي أولاً ثم المخصّصون بلا تكرار. */
export function getOrModels(){
  let saved = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]');
    if(Array.isArray(parsed)) saved = parsed;
  } catch(_) {}
  return uniqueNames([DEFAULT_OR_MODEL, ...saved]);
}

/** حفظ القائمة (يضمن بقاء الافتراضي في المقدمة). */
export function saveOrModels(list){
  const models = uniqueNames([DEFAULT_OR_MODEL, ...(Array.isArray(list) ? list : [])]);
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(models)); } catch(_) {}
  return models;
}

/** النموذج المختار، مع الرجوع للافتراضي إذا كان المحفوظ غير موجود. */
export function getSelectedOrModel(){
  const models = getOrModels();
  let saved = '';
  try { saved = cleanName(localStorage.getItem(SELECTED_KEY)); } catch(_) {}
  return models.includes(saved) ? saved : DEFAULT_OR_MODEL;
}

/** اختيار نموذج موجود فقط. */
export function selectOrModel(name){
  const model = cleanName(name);
  if(!getOrModels().includes(model)) return false;
  try { localStorage.setItem(SELECTED_KEY, model); } catch(_) {}
  return true;
}

/** إضافة نموذج جديد. يعيد { ok, model, reason }. */
export function addOrModel(name){
  const model = cleanName(name);
  if(!model) return { ok: false, reason: 'empty', model: '' };

  const models = getOrModels();
  if(models.includes(model)) return { ok: false, reason: 'duplicate', model };

  models.push(model);
  saveOrModels(models);
  selectOrModel(model);
  return { ok: true, reason: '', model };
}

/** حذف نموذج مخصّص (الافتراضي محمي). */
export function removeOrModel(name){
  const model = cleanName(name);
  if(model === DEFAULT_OR_MODEL) return { ok: false, reason: 'default', model };

  const models = getOrModels();
  if(!models.includes(model)) return { ok: false, reason: 'missing', model };

  const wasSelected = getSelectedOrModel() === model;
  const next = models.filter((item) => item !== model);
  saveOrModels(next);

  if(wasSelected) selectOrModel(DEFAULT_OR_MODEL);
  return { ok: true, reason: '', model };
}
