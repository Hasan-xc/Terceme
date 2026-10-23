/**
 * state.js — الحالة المشتركة (Shared State)
 *
 * المسؤولية: يحتوي على كل المتغيرات العامة التي تقرأها/تكتبها عدة وحدات معاً.
 * لو لم نضعها في مكان واحد، لما استطاعت الوحدات المختلفة رؤية نفس البيانات
 * (لأن كل ملف ES Module له نطاق مستقل).
 *
 * ملاحظة: التصميم على هيئة كائن واحد قابل للتعديل (mutable object) متعمد،
 * لأن الكود الأصلي كان يستخدم متغيرات عامة مباشرة (blocks, uid, ...)،
 * ولم نغيّر أي سلوك — فقط نقلنا مكان التخزين.
 */

export const TAB_KEY = 'srt_editor_tab';

function readActiveTab(){
  try { return localStorage.getItem(TAB_KEY) === 'translated' ? 'translated' : 'original'; }
  catch(_) { return 'original'; }
}

export const state = {
  blocks: [],            // مصفوفة الأسطر الحالية {id, start, end, text, tr, noSpeech}
  uid: 0,                // عدّاد المعرّفات الفريدة لكل سطر (id)
  activeRowId: null,     // معرّف السطر النشط حالياً في المحرر
  activeTab: readActiveTab(), // 'original' | 'translated' — التبويب النشط في المحرر
  currentTask: null,     // المهمة الجارية حالياً: 'translate' | 'align' | null
  cancelRequested: false,// هل طلب المستخدم إيقاف المهمة الحالية؟
  videoURL: null,        // رابط الفيديو الحالي (Object URL)
  sttProvider: 'groq',   // مزوّد التفريغ الصوتي: 'groq' | 'gemini'
  trProvider: 'kie'      // مزوّد الترجمة: 'openrouter' | 'kie'
};

/** التبويب الفعلي (original/translated) مع قيمة افتراضية آمنة. */
export function getActiveTab(){
  return state.activeTab === 'translated' ? 'translated' : 'original';
}

/** تبديل التبويب النشط وحفظه في localStorage. */
export function setActiveTab(tab){
  state.activeTab = tab === 'translated' ? 'translated' : 'original';
  try { localStorage.setItem(TAB_KEY, state.activeTab); } catch(_) {}
  return state.activeTab;
}

/** نص الحقل الخاص بالتبويب (بدون احتياط) — للتحرير والعرض. */
export function blockFieldText(block, tab = getActiveTab()){
  if(!block) return '';
  return tab === 'translated' ? (block.tr || '') : (block.text || '');
}

/** نص العرض/التصدير: الترجمة الفارغة ترجع للأصل كاحتياط. */
export function blockDisplayText(block, tab = getActiveTab()){
  const value = blockFieldText(block, tab);
  if(tab === 'translated' && !value.trim()) return block.text || '';
  return value;
}

/**
 * مصنع السطر الموحّد — يضمن وجود text (الأصل) و tr (الترجمة) معاً
 * في كل مسارات إنشاء الأسطر. text لا تتغيّر بعد الترجمة أبداً.
 * noSpeech: وسم اختياري من مزامنة التوقيت (لم يُعثر على كلام مطابق).
 *
 * @param {{start?:string,end?:string,text?:string,tr?:string,noSpeech?:boolean}} data
 * @returns {{id:number,start:string,end:string,text:string,tr:string,noSpeech:boolean}}
 */
export function makeBlock(data = {}) {
  const start = data.start || '00:00:00,000';
  const end = data.end || start;
  return {
    id: ++state.uid,
    start,
    end,
    text: typeof data.text === 'string' ? data.text : '',
    tr: typeof data.tr === 'string' ? data.tr : '',
    noSpeech: data.noSpeech === true
  };
}

/**
 * تطبيع سطر قادم من تخزين قديم أو مشروع محفوظ (قد لا يحتوي tr).
 * يحافظ على id إن وُجد، ويعيد '' لأي tr مفقود.
 */
export function normalizeBlock(block, fallbackId = 0) {
  const src = block && typeof block === 'object' ? block : {};
  const numericId = Number(src.id);
  const id = Number.isFinite(numericId) && numericId > 0 ? numericId : fallbackId;
  const start = typeof src.start === 'string' ? src.start : '00:00:00,000';
  return {
    id,
    start,
    end: typeof src.end === 'string' ? src.end : start,
    text: typeof src.text === 'string' ? src.text : '',
    tr: typeof src.tr === 'string' ? src.tr : '',
    noSpeech: src.noSpeech === true
  };
}

/** تطبيع مصفوفة أسطر كاملة (الملفات القديمة بدون tr تُقرأ كـ ''). */
export function normalizeBlocks(list) {
  return (Array.isArray(list) ? list : []).map((b, i) => normalizeBlock(b, i + 1));
}
