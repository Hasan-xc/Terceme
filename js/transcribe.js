/**
 * transcribe.js — التفريغ الصوتي (Groq Whisper / Gemini 3.5 Transcribe) + استخراج الصوت من الفيديو
 *
 * المسؤولية:
 *  - استخراج المسار الصوتي من ملفات الفيديو (مسار أصلي سريع + بديل FFmpeg.wasm)
 *  - فك تشفير الصوت، تحويله إلى WAV أحادي 16kHz، وتقسيمه لأجزاء حسب الحجم
 *  - استدعاء Groq Whisper أو Gemini 3.5 Transcribe لتفريغ كل جزء ودمج النتائج في blocks
 *  - التحكم في التفريغ: بدء/إيقاف مؤقت/إكمال/إلغاء
 *
 * كل الاستدعاءات الآن عبر apiRequest() الموحدة في apiClient.js
 * (نفس الهيدرات، نفس الجسم، نفس معالجة الأخطاء — صفر تغيير سلوكي).
 */

import { state, makeBlock, setActiveTab } from './state.js';
import { formatMs } from './time.js';
import { $, toast, setText, setBar, setVisible } from './ui.js';
import { showEditor } from './core.js';
import { renderCards } from './editor.js';
import { apiRequest } from './apiClient.js';
import { transcribeAudioBlob, transcribeAudioWords } from './gemini.js';
import { alignBlocksToWords, extractWordTimings } from './align.js';
import { captureHistory } from './history.js';
import { scheduleAutoSave } from './autosave.js';

/* ════════════════════════════════════════════════════════════════
   🎙️ GROQ WHISPER (20-Min Time Chunks + Direct Fast Path + Auto-Retry)
══════════════════════════════════════════════════════════════ */
// رابط Groq أصبح مركزياً في apiClient.js (المفتاح: GROQ_TRANSCRIBE)
const TARGET_SR      = 16000;

// ── الموديل ثابت واحد لأجل التفريغ كله (whisper-large-v3 المتوازن، كشف لغة تلقائي) ──
const WHISPER_MODEL  = 'whisper-large-v3';

// ── مزامنة التوقيت: موديل Turbo الرخيص + توقيت الكلمات فقط (لا Gemini) ──
const ALIGN_MODEL = 'whisper-large-v3-turbo';
const ALIGN_COST_PER_HOUR = 0.04;
const ALIGN_CONCURRENCY = 2;
const ALIGN_MAX_ATTEMPTS = 3;
const ALIGN_GEMINI_KEY = 'align_gemini_mode'; // مسار اختياري: Gemini Multimodal لمزامنة الكلمات

function isAlignGeminiMode(){
  try { return localStorage.getItem(ALIGN_GEMINI_KEY) === '1'; } catch(_) { return false; }
}

/** حفظ اختيار مسار Gemini لمزامنة التوقيت. */
export function saveAlignGeminiPref(){
  const el = $('alignGeminiMode');
  try { localStorage.setItem(ALIGN_GEMINI_KEY, el && el.checked ? '1' : '0'); } catch(_) {}
}

// ── التقطيع زمني ثابت: 20 دقيقة لكل جزء (كما تعلن الواجهة) ──
// كل جزء يُضغط MP3 48kbps → ≈7.2MB لكل 20 دقيقة (أقل بكثير من حد الخادم 25MB)
const CHUNK_SECONDS  = 20 * 60;
// احتياطي WAV: نبقى ≤10MB خام (~13.4MB بعد base64) كي يصلح أيضًا لـ Gemini inline.
const CHUNK_SECONDS_WAV_FALLBACK = 10 * 1024 * 1024 / (TARGET_SR * 2); // ≈327ث إذا فشل lamejs

// حجم WAV الخام للمدة (ثابت رياضي: المدة × 32000 بايت/ثانية)
const BYTES_PER_SEC_16K_MONO = TARGET_SR * 2;

let aiFile            = null;
let aiAudioBuffer     = null;
let aiTotalDurationMs = 0;
let aiTotalChunks     = 0;
let aiCurrentChunk    = 0;
let aiIsRunning       = false;
let aiIsPaused        = false;
let aiChunkSeconds    = CHUNK_SECONDS; // يُعاد حسابه لكل ملف حسب حجمه الفعلي
let aiDirectSend      = false; // ⚡ إرسال الملف الأصلي كما هو (صوت ≤24MB و≤20د) بلا ضغط
let aiGroqWaitUntil   = 0;     // ⏳ تبريد بعد 429 — يكافئ انخفاض التزامن إلى 1 خلال النافذة
let aiGeminiWaitUntil = 0;     // ⏳ تبريد خاص بـ Gemini بعد 429
let aiInflight        = 0;     // عدد الطلبات الجارية فعلياً (لأجل الاستئناف الآمن)
let aiActiveCtrls     = new Set(); // متحكمات الطلبات الحية — الإلغاء يجهضها
let aiRunGen          = 0;     // جيل الجولة — الإلغاء يزيده فتموت عمال الجولات القديمة (لا يعيدون الإرسال بعد جولة جديدة)

// ── حالة مزامنة التوقيت (مستقلة تماماً عن التفريغ) ──
let alignRunning   = false;
let alignAbort     = null;
let alignCtrls     = new Set();
let alignDone      = 0;
let alignTotal     = 0;
let alignRunGen    = 0; // جيل المزامنة — يمنع عمال جولة قديمة من إعادة الإرسال بعد جولة جديدة

function setAlignButton(label){
  const btn = $('alignTimingBtn');
  if(btn) btn.textContent = label;
}

/** يحدّث زر المزامنة حسب وجود الصوت والأسطر وحالة التشغيل. */
export function checkAlignReady(){
  const btn = $('alignTimingBtn');
  if(!btn) return;
  if(alignRunning){
    btn.disabled = false;
    btn.title = 'اضغط لإيقاف المزامنة الجارية';
    return;
  }
  const hasAudio = !!aiFile;
  const hasBlocks = state.blocks.length > 0;
  const busy = aiIsRunning || aiExtractRunning || !!state.currentTask;
  btn.disabled = !(hasAudio && hasBlocks) || busy;
  btn.title = !hasAudio
    ? 'ارفع الصوت أو الفيديو أولاً — المزامنة تحتاج الملف الأصلي'
    : (!hasBlocks ? 'فرّغ الصوت أو ألصق نصاً أولاً'
      : (busy ? 'انتظر انتهاء التفريغ أو الترجمة الجارية أولاً'
        : (isAlignGeminiMode()
          ? 'يعيد إرسال الصوت إلى Gemini Multimodal ويضبط بداية/نهاية كل سطر من توقيت الكلمات'
          : 'يعيد إرسال الصوت إلى Groq Turbo ويضبط بداية/نهاية كل سطر من توقيت الكلمات')));
}

export function checkAiReady(){
  const isGemini = state.sttProvider === 'gemini';
  const keyEl = $(isGemini ? 'geminiKeyIn' : 'aiKeyIn');
  const runBtn = $('aiRunBtn');
  if(runBtn) runBtn.disabled = !(keyEl && keyEl.value.trim() && aiFile);
  try { checkAlignReady(); } catch(_) {}
}
function setStatus(msg){ setText('aiProgStatus', msg); }

// ملاحظة: المعامل اسمه st وليس state حتى لا يحجب استيراد state المشترك
function switchAiUI(st) {
  setVisible('ctrlStartBox', st === 'start', 'flex');
  setVisible('ctrlPauseBox', st === 'running', 'flex');
  setVisible('ctrlResumeBox', st === 'paused', 'flex');
}

async function decodeAudioFile(file, onProgress) {
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  if(!AudioCtxClass) throw new Error('المتصفح لا يدعم Web Audio API');
  if(onProgress) onProgress('⏳ جاري قراءة الملف في الذاكرة...');
  let arrayBuffer = await file.arrayBuffer();
  let ctx;
  try { ctx = new AudioCtxClass({ sampleRate: TARGET_SR }); }
  catch(_) { ctx = new AudioCtxClass(); }
  if(onProgress) onProgress('🔧 جاري فك تشفير الصوت...');
  const decoded = await new Promise((resolve, reject) => {
    try { ctx.decodeAudioData(arrayBuffer, resolve, reject); }
    catch(e) { reject(e); }
  });
  arrayBuffer = null;
  try { ctx.close(); } catch(_){}
  return decoded;
}

function extractMonoChunk(audioBuffer, startSec, endSec) {
  const sr          = audioBuffer.sampleRate;
  const startSample = Math.floor(startSec * sr);
  const endSample   = Math.min(Math.floor(endSec * sr), audioBuffer.length);
  const length      = Math.max(0, endSample - startSample);
  if(length === 0) return { samples: new Float32Array(0), sampleRate: sr };
  const numCh = audioBuffer.numberOfChannels;
  const mono  = new Float32Array(length);
  if(numCh === 1) {
    mono.set(audioBuffer.getChannelData(0).subarray(startSample, endSample));
  } else {
    for(let ch = 0; ch < numCh; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for(let i = 0; i < length; i++) mono[i] += data[startSample + i] / numCh;
    }
  }
  return { samples: mono, sampleRate: sr };
}

function resampleTo16k(samples, inputRate) {
  if(inputRate === TARGET_SR) return samples;
  const ratio  = inputRate / TARGET_SR;
  const outLen = Math.round(samples.length / ratio);
  const out    = new Float32Array(outLen);
  for(let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0  = Math.floor(idx);
    const i1  = Math.min(i0 + 1, samples.length - 1);
    const t   = idx - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

function audioBufferToWav(samples, sampleRate) {
  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = samples.length * 2;
  const buffer        = new ArrayBuffer(44 + dataSize);
  const view          = new DataView(buffer);
  const writeStr = (off, s) => { for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true); writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for(let i = 0; i < samples.length; i++, off += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/* ════════════════════════════════════════════════════════════════
   VIDEO → AUDIO EXTRACTION LAYER (Layer مستقلة، لا تلمس نظام الترجمة)
   المسار 1: فك تشفير أصلي بالمتصفح (سريع وخفيف)
   المسار 2 (fallback): FFmpeg.wasm عند فشل المسار الأول فقط
══════════════════════════════════════════════════════════════ */
let aiOriginalVideoFile = null;
let aiAudioQualityKbps  = 48;  // مطابق للراديو الافتراضي (48 checked) في الواجهة
let aiExtractRunning    = false;
let aiExtractCancelled  = false;
let aiExtractGen        = 0;
let aiExtractedBlob     = null;
let aiExtractObjectURL  = null;
let ffmpegInstance      = null;
let ffmpegLoadPromise   = null;
let lamejsLoadPromise   = null;

const VIDEO_EXTS = ['mp4','mov','mkv','webm','avi','m4v','wmv','flv','3gp','ts','mts'];

function isVideoFile(file){
  if(file.type && file.type.startsWith('video/')) return true;
  if(file.type && file.type.startsWith('audio/')) return false;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

function setExtractStatus(msg){ setText('aiExtractStatus', msg); }
function setExtractProgress(pct){ setBar('aiExtractBar', pct); }

function resetExtractUI(){
  aiExtractCancelled = true; // يوقف أي عملية سابقة قيد التنفيذ
  aiExtractGen++; // يُبطل أي نتيجة متأخرة من عملية سابقة (حتى لو تحول المستخدم لملف صوتي)
  setVisible('aiExtractBox', false);
  setVisible('aiExtractActions', false);
  setVisible('aiExtractCancelBtn', true, 'inline-flex');
  setVisible('aiQualityBox', false);
  const player = $('aiExtractAudioPlayer');
  if(player){ try{ player.pause(); }catch(_){} player.remove(); }
  if(aiExtractObjectURL){ URL.revokeObjectURL(aiExtractObjectURL); aiExtractObjectURL = null; }
  aiExtractedBlob = null;
}

export function onAudioQualityChange(kbps){
  aiAudioQualityKbps = kbps;
  if(aiOriginalVideoFile && !aiExtractRunning) startVideoExtraction(aiOriginalVideoFile);
}

async function startVideoExtraction(file){
  const myGen = ++aiExtractGen;
  aiExtractCancelled = false;
  aiExtractRunning = true;
  aiExtractedBlob = null;
  if(aiExtractObjectURL){ URL.revokeObjectURL(aiExtractObjectURL); aiExtractObjectURL = null; }
  const player = $('aiExtractAudioPlayer');
  if(player) player.remove();

  setVisible('aiExtractBox', true);
  setVisible('aiExtractActions', false);
  setVisible('aiExtractCancelBtn', true, 'inline-flex');
  const sizeInfo = $('aiExtractSizeInfo');
  if(sizeInfo) sizeInfo.textContent = '';
  setExtractProgress(0);
  setExtractStatus('🎬 جاري استخراج الصوت...');
  const runBtn = $('aiRunBtn');
  if(runBtn) runBtn.disabled = true;

  try {
    let mp3Blob;
    try {
      mp3Blob = await extractAudioNative(file, aiAudioQualityKbps);
    } catch(nativeErr) {
      if(aiExtractCancelled) throw new Error('CANCELLED');
      console.warn('فشل المسار السريع، الانتقال إلى المحرك البديل:', nativeErr);
      setExtractStatus('📦 جاري تجهيز محرك معالجة بديل...');
      mp3Blob = await extractAudioFFmpeg(file, aiAudioQualityKbps);
    }
    if(aiExtractCancelled) throw new Error('CANCELLED');
    if(myGen !== aiExtractGen) return; // تم استبدال هذه العملية بعملية أحدث، لا تلمس الواجهة

    aiExtractedBlob = mp3Blob;
    const outName = file.name.replace(/\.[^.]+$/, '') + '.mp3';
    aiFile = new File([mp3Blob], outName, { type: 'audio/mp3' });
    aiAudioBuffer = null;

    setExtractStatus('✓ تم تجهيز الصوت');
    setExtractProgress(100);
    const sizeMB = (aiFile.size / 1048576).toFixed(2);
    const sizeInfo = $('aiExtractSizeInfo');
    if(sizeInfo) sizeInfo.textContent = `Audio: ${outName}  —  ${sizeMB} MB`;
    setVisible('aiExtractActions', true, 'flex');
    setVisible('aiExtractCancelBtn', false);
    $('aiDropTxt').innerHTML =
      `<span style="color:var(--gr)">✅ تم استخراج الصوت:</span><br>${outName}<br><small style="color:var(--t2)">${sizeMB} MB</small>`;
    toast('تم تجهيز الصوت من الفيديو','🎧');
  } catch(err) {
    if(myGen !== aiExtractGen) return; // نتيجة عملية قديمة مُستبدَلة، تجاهلها بصمت
    if(err && err.message === 'CANCELLED'){
      setExtractStatus('⏹️ تم الإلغاء');
      toast('تم إلغاء استخراج الصوت','⏹️');
    } else {
      console.error('Extraction error:', err);
      setExtractStatus('❌ تعذر معالجة هذا الفيديو على جهازك. جرّب فيديو أصغر أو صيغة MP4.');
      toast('تعذر استخراج الصوت من الفيديو','⚠️');
    }
    setVisible('aiExtractCancelBtn', false);
    aiFile = null;
  } finally {
    if(myGen === aiExtractGen){ aiExtractRunning = false; checkAiReady(); }
  }
}

export function cancelExtraction(){
  aiExtractCancelled = true;
  if(ffmpegInstance){
    try{ ffmpegInstance.terminate(); }catch(_){}
    ffmpegInstance = null; ffmpegLoadPromise = null;
  }
  setExtractStatus('⏹️ جاري الإلغاء...');
}

/* ── المسار السريع: فك تشفير أصلي بالمتصفح + ضغط MP3 بمكتبة JS خفيفة ── */
async function extractAudioNative(file, kbps){
  const audioBuffer = await decodeAudioFile(file, setExtractStatus);
  if(aiExtractCancelled) throw new Error('CANCELLED');
  setExtractStatus('⚙️ جاري ضغط الصوت...');
  const { samples, sampleRate } = extractMonoChunk(audioBuffer, 0, audioBuffer.duration);
  return await encodeMonoToMp3(samples, sampleRate, kbps, setExtractProgress);
}

function loadLamejs(){
  if(window.lamejs) return Promise.resolve(window.lamejs);
  if(!lamejsLoadPromise){
    lamejsLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
      s.onload = () => resolve(window.lamejs);
      s.onerror = () => reject(new Error('تعذر تحميل مكتبة ضغط الصوت'));
      document.head.appendChild(s);
    });
  }
  return lamejsLoadPromise;
}

async function encodeMonoToMp3(samplesFloat32, sampleRate, kbps, onProgress){
  const lamejs = await loadLamejs();
  if(aiExtractCancelled) throw new Error('CANCELLED');
  const validRates = [8000,11025,12000,16000,22050,24000,32000,44100,48000];
  const sr = validRates.includes(sampleRate) ? sampleRate : 16000;
  const encoder = new lamejs.Mp3Encoder(1, sr, kbps);
  const blockSize = 1152;
  const total = samplesFloat32.length;
  const int16 = new Int16Array(total);
  for(let i = 0; i < total; i++){
    const s = Math.max(-1, Math.min(1, samplesFloat32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const chunks = [];
  let i = 0, lastYield = Date.now();
  while(i < total){
    if(aiExtractCancelled) throw new Error('CANCELLED');
    const chunk = int16.subarray(i, i + blockSize);
    const buf = encoder.encodeBuffer(chunk);
    if(buf.length > 0) chunks.push(new Int8Array(buf));
    i += blockSize;
    if(onProgress) onProgress(Math.min(99, Math.round(i / total * 100)));
    if(Date.now() - lastYield > 16){ await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
  }
  const endBuf = encoder.flush();
  if(endBuf.length > 0) chunks.push(new Int8Array(endBuf));
  if(onProgress) onProgress(100);
  return new Blob(chunks, { type: 'audio/mp3' });
}

/* ── المسار البديل (Fallback): FFmpeg.wasm — يُحمَّل فقط عند فشل المسار السريع ──
   نسخة single-thread، لا تحتاج SharedArrayBuffer أو هيدرز COOP/COEP خاصة بالسيرفر */
async function loadFFmpegEngine(){
  if(ffmpegInstance) return ffmpegInstance;
  if(!ffmpegLoadPromise){
    ffmpegLoadPromise = (async () => {
      const ffmpegMod = await import('https://esm.sh/@ffmpeg/ffmpeg@0.12.10');
      const utilMod   = await import('https://esm.sh/@ffmpeg/util@0.12.1');
      const ffmpeg = new ffmpegMod.FFmpeg();
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await utilMod.toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await utilMod.toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      window.__ffmpegUtil = utilMod;
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }
  return ffmpegLoadPromise;
}

async function extractAudioFFmpeg(file, kbps){
  const ffmpeg = await loadFFmpegEngine();
  if(aiExtractCancelled) throw new Error('CANCELLED');
  const util = window.__ffmpegUtil;
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inName  = 'input.' + ext;
  const outName = 'output.mp3';

  const progressHandler = ({ progress }) => {
    if(progress >= 0 && progress <= 1) setExtractProgress(Math.round(progress * 100));
  };
  ffmpeg.on('progress', progressHandler);

  try {
    setExtractStatus('🎬 جاري استخراج الصوت...');
    await ffmpeg.writeFile(inName, await util.fetchFile(file));
    if(aiExtractCancelled) throw new Error('CANCELLED');
    setExtractStatus('⚙️ جاري ضغط الصوت...');
    await ffmpeg.exec(['-i', inName, '-vn', '-ac', '1', '-ar', '16000', '-b:a', kbps + 'k', outName]);
    if(aiExtractCancelled) throw new Error('CANCELLED');
    const data = await ffmpeg.readFile(outName);
    return new Blob([data.buffer], { type: 'audio/mp3' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    try{ await ffmpeg.deleteFile(inName); }catch(_){}
    try{ await ffmpeg.deleteFile(outName); }catch(_){}
  }
}

export function aiPlayExtracted(){
  if(!aiExtractedBlob) return;
  if(!aiExtractObjectURL) aiExtractObjectURL = URL.createObjectURL(aiExtractedBlob);
  let player = $('aiExtractAudioPlayer');
  if(!player){
    player = document.createElement('audio');
    player.id = 'aiExtractAudioPlayer';
    player.controls = true;
    player.style.width = '100%';
    player.style.marginTop = '8px';
    $('aiExtractBox').appendChild(player);
  }
  player.src = aiExtractObjectURL;
  player.play();
}

export function aiDownloadExtracted(){
  if(!aiExtractedBlob) return;
  if(!aiExtractObjectURL) aiExtractObjectURL = URL.createObjectURL(aiExtractedBlob);
  const a = document.createElement('a');
  a.href = aiExtractObjectURL;
  a.download = (aiFile && aiFile.name) || 'audio.mp3';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ════════════════════════════════════════════════════════════════
   تدفّق التفريغ الصوتي (بدء/إيقاف/إكمال/إلغاء)
══════════════════════════════════════════════════════════════ */

export async function startAi() {
  state.blocks = []; state.uid = 0; setActiveTab('original'); renderCards(); showEditor();
  aiCurrentChunk = 0; aiTotalDurationMs = 0; aiTotalChunks = 0; aiAudioBuffer = null;
  aiRunGen++; aiIsPaused = false; aiGroqWaitUntil = 0; aiGeminiWaitUntil = 0; // جيل جديد — أي عمال قدامى يموتون
  await prepareAndRunAi();
}
export function pauseAi() {
  aiIsPaused = true; aiIsRunning = false;
  switchAiUI('paused');
  setStatus('⏸️ تم الإيقاف المؤقت');
  try { checkAlignReady(); } catch(_) {}
}
export async function resumeAi() {
  // انتظار استقرار الطلبات الطائرة من الجولة المتوقفة (تُلحق نتائجها وتُحدَّث المؤشرات أولاً)
  // — بدون هذا كانت الاستئناف يعيد إرسال أجزاء جارية/يكرر النتائج
  while (aiInflight > 0) await new Promise(r => setTimeout(r, 40));
  aiIsPaused = false;
  await prepareAndRunAi();
}
export function cancelAi() {
  aiIsPaused = true; aiIsRunning = false; aiCurrentChunk = 0; aiAudioBuffer = null; aiChunkSeconds = CHUNK_SECONDS;
  aiGeminiWaitUntil = 0;
  aiRunGen++; // جيل جديد — عمال الجولة الملغاة يموتون فور استيقاظهم (لا يعيدون الإرسال)
  // ⏹️ إجهاض كل الطلبات الحية فعلياً (الخادم يرى الاتصالات مقطوعة)
  for (const c of aiActiveCtrls) { try { c.abort(); } catch(_){} }
  aiActiveCtrls.clear();
  switchAiUI('start');
  setVisible('aiProgress', false);
  try { checkAlignReady(); } catch(_) {}
  toast('تم الإلغاء','⏹️');
}

async function prepareAndRunAi() {
  const isGemini = state.sttProvider === 'gemini';
  const keyEl = $(isGemini ? 'geminiKeyIn' : 'aiKeyIn');
  const apiKey = keyEl ? keyEl.value.trim() : '';
  if(!apiKey){ toast(isGemini ? 'أدخل Gemini API Key' : 'أدخل Groq API Key','⚠️'); return; }
  if(!aiFile){ toast('اختر ملفاً أولاً','⚠️'); return; }

  aiIsRunning = true; aiIsPaused = false;
  switchAiUI('running');
  setVisible('aiProgress', true);
  try { checkAlignReady(); } catch(_) {}

  try {
    // نحتاج المدة دائماً → فك تشفير مرة واحدة (يقرر المسار المباشر والتقطيع)
    if(!aiAudioBuffer) {
      aiAudioBuffer     = await decodeAudioFile(aiFile, setStatus);
      aiTotalDurationMs = aiAudioBuffer.duration * 1000;

      // التقطيع زمني ثابت 20 دقيقة؛ وإذا تعذر lamejs → أجزاء WAV أصغر (≈327ث ≤10MB)
      let lameOk = true;
      try { await loadLamejs(); } catch(_) { lameOk = false; }
      aiChunkSeconds = lameOk ? CHUNK_SECONDS : Math.floor(CHUNK_SECONDS_WAV_FALLBACK);

      if (aiAudioBuffer.duration <= aiChunkSeconds) {
        aiChunkSeconds = aiAudioBuffer.duration || 1;
        // ⚡ المسار السريع لـ Groq فقط: أصل صوتي ≤24MB يُرسل كما هو — بلا ضغط.
        // Gemini يحتاج إعادة ترميز 48kbps للبقاء داخل حد inline الآمن.
        aiDirectSend = !isGemini && !isVideoFile(aiFile) && aiFile.size <= 24 * 1024 * 1024;
        toast(`📦 المدة ${Math.round(aiAudioBuffer.duration/60)} دقيقة — إرسال دفعة واحدة${aiDirectSend ? ' مباشرة (بلا ضغط)' : ''}`, '✅');
      } else {
        aiDirectSend = false;
        const estChunks = Math.max(1, Math.ceil(aiAudioBuffer.duration / aiChunkSeconds));
        toast(`📦 المدة ${Math.round(aiAudioBuffer.duration/60)} دقيقة — سيُقسَّم إلى ${estChunks} أجزاء (~${Math.round(aiChunkSeconds/60)} دقيقة لكل جزء)`, 'ℹ️');
      }

      aiTotalChunks = Math.max(1, Math.ceil(aiAudioBuffer.duration / aiChunkSeconds));
      $('fnIn').value = aiFile.name.replace(/\.[^.]+$/,'');
    }
    await executeChunksLoop(apiKey);
  } catch (err) {
    console.error('AI Error:', err);
    setStatus('❌ خطأ: ' + (err.message || err));
    aiIsRunning = false;
    switchAiUI('paused');
    try { checkAlignReady(); } catch(_) {}
    toast('حدث خطأ — يمكنك الإكمال مجدداً','❌');
  }
}

async function executeChunksLoop(apiKey) {
  const myGen = aiRunGen; // جيل هذه الجولة — إن تغيّر (إلغاء/جولة جديدة) نموت فورًا
  const isGemini = state.sttProvider === 'gemini';

  const POOL = isGemini ? 2 : 3;  // Gemini: تزامن أقل احتياطًا لحدود الحصة
  const MAX_ATTEMPTS = 3;         // إعادة محاولة عند ضعف الاتصال/الوقت الكامل
  const kbps = (typeof aiAudioQualityKbps === 'number' && aiAudioQualityKbps > 0) ? aiAudioQualityKbps : 48;

  const wordTsEl = $('geminiWordTs');
  const diarEl   = $('geminiDiarization');
  const geminiWordTs = wordTsEl ? wordTsEl.checked : true;
  const geminiDiar   = diarEl ? diarEl.checked : true;

  // تجهيز قائمة الأجزاء — أو المسار المباشر (جزء واحد = الملف الأصلي)
  let jobs;
  if(aiDirectSend){
    aiTotalChunks = 1;
    jobs = [{ index: 0, start: 0, end: aiAudioBuffer ? aiAudioBuffer.duration : 0, offsetMs: 0, direct: true }];
  } else {
    aiTotalChunks = Math.max(1, Math.ceil(aiAudioBuffer.duration / aiChunkSeconds));
    jobs = [];
    for(let i = 0; i < aiTotalChunks; i++){
      const startSec0 = i * aiChunkSeconds;
      const endSec0   = Math.min(startSec0 + aiChunkSeconds, aiAudioBuffer.duration);
      jobs.push({ index: i, start: startSec0, end: endSec0, offsetMs: Math.round(startSec0 * 1000) });
    }
  }

  // سجل تقدمي توضيحي (console.table)
  const chunkLog = [];

  // ترميز جزء إلى MP3 (الافتراضي مع lamejs) مع الاحتياطي WAV
  // forcedKbps: Gemini يفرض 48kbps كي يبقى كل جزء داخل حد inline الآمن.
  async function encodeChunk(job, forcedKbps){
    if(job.direct && !forcedKbps) return { blob: aiFile, usedMp3: true }; // ⚡ الملف الأصلي كما هو — صفر معالجة
    let { samples, sampleRate } = extractMonoChunk(aiAudioBuffer, job.start, job.end);
    if(sampleRate !== TARGET_SR) { samples = resampleTo16k(samples, sampleRate); sampleRate = TARGET_SR; }
    let blob = null, usedMp3 = true;
    try { blob = await encodeMonoToMp3(samples, sampleRate, forcedKbps || kbps, null); }
    catch(_) {
      usedMp3 = false;
      blob = audioBufferToWav(samples, sampleRate);
    }
    samples = null;
    return { blob, usedMp3 };
  }

  // إرسال جزء إلى Groq مع إعادة محاولة (Backoff) ومعالجة رموز الحالة المعروفة
  async function sendGroqChunk(job){
    const { blob, usedMp3 } = await encodeChunk(job);
    let res = null, lastErr = '', attemptTimeMs = 0;
    // ⏱️ مهلة ديناميكية: 45 ثانية لكل ميغابايت (حد أدنى 3 دقائق)
    // رفع ~12MB من شبكة الجوال + معالجة Whisper قد يتجاوز 180s بسهولة
    const sizeMB = Math.max(1, Math.ceil(blob.size / 1048576));
    const baseTimeoutMs = Math.max(180000, sizeMB * 45000);
    let attemptTimeoutMs = baseTimeoutMs;
    ADD: for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
      if(aiIsPaused || myGen !== aiRunGen) break;
      const startedAt = Date.now();
      const ctrl = new AbortController();
      aiActiveCtrls.add(ctrl); // يُجهض تلقائياً عند cancelAi
      attemptTimeoutMs = baseTimeoutMs * (1 + (attempt - 1) * 0.5); // كل محاولة أطول 50%
      const tid  = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        // ⏳ نافذة تبريد بعد 429 — كل الأجزاء تنتظر (= تزامن فعلي 1 خلال النافذة)
        const cooldownMs = aiGroqWaitUntil - Date.now();
        if (cooldownMs > 0) await new Promise(r => setTimeout(r, cooldownMs));
        if (myGen !== aiRunGen) break;

        const fd = new FormData();
        // ⚠️ الامتداد بنقطة إلزامية — Groq يستنتج النوع من الامتداد (chunk_001_mp3 كان يُرفض!)
        const fname = job.direct ? (aiFile.name || 'audio.mp3')
                                 : `chunk_${String(job.index+1).padStart(3,'0')}.${usedMp3 ? 'mp3' : 'wav'}`;
        fd.append('file', blob, fname);
        fd.append('model', WHISPER_MODEL);
        fd.append('response_format', 'verbose_json');
        fd.append('temperature', '0');
        // ملاحظة: لا نرسل language — حذف الحقل = كشف تلقائي للغة (قيمة 'auto' غير صالحة وتسبب 400)

        res = await apiRequest('GROQ_TRANSCRIBE', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: fd,
          signal: ctrl.signal
        });
        attemptTimeMs = Date.now() - startedAt;
        if(res.ok) break ADD;

        const status = res.status;
        if(status === 429 || status === 486) {
          // ضغط الخادم — ننتظر قبل إعادة المحاولة ونفتح نافذة تبريد لكل الأجزاء
          const retryAfter = Number(res.headers?.get?.('retry-after') || 0);
          const waitMs = (retryAfter || 2) * 1000 * attempt;
          aiGroqWaitUntil = Math.max(aiGroqWaitUntil, Date.now() + waitMs);
          lastErr = `ضغط الخادم (HTTP ${status})`;
          await new Promise(r => setTimeout(r, waitMs));
          if (myGen !== aiRunGen) break;
        } else if(status === 401 || status === 403) {
          // رفض مرتبط بالموديل يفحص أولاً (قد يأتي بصيغة 403 أيضاً)
          let dm = null; try { dm = await res.json(); } catch(_){}
          const mMsg = dm?.error?.message || '';
          if (/model/i.test(mMsg)) {
            lastErr = 'الموديل غير مفعّل في حساب Groq — أضفه من Settings > Limits > Allowed Models';
            break;
          }
          lastErr = 'مفتاح API غير صالح أو منتهي';
          break; // لا فائدة من الإعادة
        } else {
          let d = null; try { d = await res.json(); } catch(_){}
          lastErr = d?.error?.message || `HTTP ${status}`;
          // رفض مرتبط بالموديل (400/404 ونصه يذكر model) → رسالة واضحة بلا إعادة
          if ((status === 400 || status === 404) && /model/i.test(lastErr)) {
            lastErr = 'الموديل غير مفعّل في حساب Groq — أضفه من Settings > Limits > Allowed Models';
            break;
          }
          await new Promise(r => setTimeout(r, 800 * attempt));
          if (myGen !== aiRunGen) break;
        }
      } catch(err) {
        lastErr = err?.name === 'AbortError'
          ? `انتهت المهلة (${Math.round(attemptTimeoutMs/1000)}s) — ${sizeMB}MB على سرعة شبكتك، المحاولة التالية ستكون أطول`
          : (err.message || 'خطأ في الاتصال');
        await new Promise(r => setTimeout(r, 1000 * attempt));
        if (myGen !== aiRunGen) throw new Error('أُلغيت');
        attemptTimeMs = Date.now() - startedAt
      } finally {
        clearTimeout(tid);
        aiActiveCtrls.delete(ctrl);
      }
    }

    chunkLog.push({ 'الجزء': job.index+1, 'النطاق': formatMs(job.offsetMs).substring(0,8)+'→'+formatMs(Math.round(job.end*1000)).substring(0,8), 'الحالة': res?.ok ? '✅' : '❌', 'الحجم': (blob.size/1024).toFixed(0)+'KB', 'المحاولات': Math.min(MAX_ATTEMPTS, 3), 'الزمن': (attemptTimeMs/1000).toFixed(1)+'s', 'المدة': job.direct ? 'مباشر' : 'جزء' });
    try { console.table([chunkLog[chunkLog.length - 1]]); } catch(_){}

    if(!res || !res.ok) throw new Error(lastErr || 'فشل إرسال الجزء');

    const data = await res.json();
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const out = [];
    if(segments.length > 0){
      segments.forEach(seg => {
        if(!seg) return;
        const sMs = Math.round((Number(seg.start) || 0) * 1000) + job.offsetMs;
        const eMs = Math.round((Number(seg.end) || seg.start || 0) * 1000) + job.offsetMs;
        const text = (seg.text || '').trim();
        if(!text) return;
        out.push({ sMs, eMs, text });
      });
    } else if(data.text && data.text.trim()){
      out.push({ sMs: job.offsetMs, eMs: Math.round(job.end*1000), text: data.text.trim() });
    }
    return out;
  }

  // إرسال جزء إلى Gemini 3.5 Transcribe (REST) مع إعادة محاولة وتبريد 429
  async function sendGeminiChunk(job){
    // نعيد الترميز دائمًا على 48kbps: 20 دقيقة ≈ 7.2MB → ≈9.6MB base64، داخل حد inline.
    const { blob } = await encodeChunk(job, 48);
    const sizeMB = Math.max(1, Math.ceil(blob.size / 1048576));
    // مهلة سخية: Gemini قد يستغرق وقتًا في ملف طويل، لكن نمنع التعليق إلى الأبد.
    const timeoutMs = Math.max(300000, sizeMB * 90000);
    let lastErr = '';

    for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
      if(aiIsPaused || myGen !== aiRunGen) break;

      const cooldownMs = aiGeminiWaitUntil - Date.now();
      if(cooldownMs > 0) await new Promise(r => setTimeout(r, cooldownMs));
      if(myGen !== aiRunGen) break;

      const ctrl = new AbortController();
      aiActiveCtrls.add(ctrl);
      const tid = setTimeout(() => { try { ctrl.abort(); } catch(_){} }, timeoutMs);

      try {
        const segs = await transcribeAudioBlob({
          blob,
          apiKey,
          offsetMs: job.offsetMs,
          durationMs: Math.max(0, Math.round(job.end * 1000) - job.offsetMs),
          wordTimestamp: geminiWordTs,
          diarization: geminiDiar,
          signal: ctrl.signal
        });
        chunkLog.push({
          'الجزء': job.index + 1,
          'النطاق': formatMs(job.offsetMs).substring(0,8) + '→' + formatMs(Math.round(job.end*1000)).substring(0,8),
          'الحالة': '✅', 'الحجم': (blob.size/1024).toFixed(0) + 'KB',
          'المحاولات': attempt, 'الزمن': '-', 'المدة': 'Gemini'
        });
        return segs;
      } catch(err) {
        if(myGen !== aiRunGen) throw new Error('أُلغيت');
        if(aiIsPaused) break;

        const status = err && err.status;
        lastErr = (err && err.message) || 'فشل الاتصال بـ Gemini';
        if(!status && /failed to fetch|networkerror|load failed|fetch/i.test(lastErr)){
          lastErr = 'تعذر الاتصال بخادم Gemini — تحقق من الشبكة أو مانع الإعلانات';
        }

        if(status === 401 || status === 403){
          lastErr = 'مفتاح Gemini غير صالح أو غير مصرح به';
          break;
        }
        if(status === 404){
          lastErr = 'موديل Gemini غير متاح لهذا المفتاح أو في منطقتك';
          break;
        }
        if(err && err.fatal){
          break; // 400/413 وغيرها — إعادة المحاولة لن تفيد
        }
        if(status === 429){
          const waitMs = Math.max(5000, 5000 * attempt);
          aiGeminiWaitUntil = Math.max(aiGeminiWaitUntil, Date.now() + waitMs);
          lastErr = `ضغط على Gemini (429) — انتظار ${Math.round(waitMs/1000)}ث`;
          await new Promise(r => setTimeout(r, waitMs));
        } else if(ctrl.signal.aborted){
          lastErr = `انتهت مهلة Gemini (${Math.round(timeoutMs/1000)}ث)`;
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          await new Promise(r => setTimeout(r, 1200 * attempt));
        }
        if(myGen !== aiRunGen) throw new Error('أُلغيت');
      } finally {
        clearTimeout(tid);
        aiActiveCtrls.delete(ctrl);
      }
    }

    throw new Error(lastErr || `فشل تفريغ الجزء ${job.index+1} عبر Gemini`);
  }

  // موزّع المزوّد: كل المنطق المشترك (التوازي/الترتيب/التقدم) يبقى كما هو
  async function sendChunk(job){
    return isGemini ? await sendGeminiChunk(job) : await sendGroqChunk(job);
  }

  // تنفيذ متوازٍ مع ترتيب الإلحاق النهائي (يُحفظ بالترتيب مهما اختلفت سرعة الردود)
  // ملاحظة الاستئناف: نكمل من aiCurrentChunk المحفوظ — الأجزاء المكتملة لا تُعاد
  const ordered = new Array(aiTotalChunks);
  let cursor = Math.min(aiCurrentChunk, aiTotalChunks);   // أول جزء غير ملحق بعد
  let nextJob = cursor;
  let lastChunkErr = '';   // آخر رسالة خطأ لجزء فاشل (كانت مسببة ReferenceError)

  async function pump(){
    while(nextJob < jobs.length){
      if(myGen !== aiRunGen) return;
      if(aiIsPaused) return;
      const job = jobs[nextJob++];
      if(job.index < cursor) continue; // مكتمل سابقاً (استئناف) — لا يعاد
      aiInflight++;
      try {
        const segs = await sendChunk(job);
        ordered[job.index] = segs || [];
      } catch(err) {
        ordered[job.index] = null; // علامة فشل
        lastChunkErr = err.message || 'فشل';
      } finally {
        aiInflight--;
      }
      // إلحاق متسلسل (ordered): نلحق كل الأجزاء المكتملة المتتالية
      while(cursor < aiTotalChunks){
        const v = ordered[cursor];
        if(v === undefined) break; // لا يزال قيد التنفيذ
        if(v === null){
          throw new Error(`فشل تفريغ الجزء ${cursor+1}: ${lastChunkErr}`);
        }
        v.forEach(o => {
          state.blocks.push(makeBlock({ start: formatMs(o.sMs), end: formatMs(o.eMs), text: o.text }));
        });
        cursor++;
      }
      aiCurrentChunk = cursor;
      const pct = cursor / aiTotalChunks * 100;
      setBar('aiProgBar', pct);
      // نطاق زمن آخر جزء أُلحق — داخل span باتجاه ltr كي تظهر الأرقام صحيحة في RTL
      const doneJob = jobs[cursor - 1];
      const oS = doneJob ? formatMs(doneJob.offsetMs).substring(0,8) : '';
      const oE = doneJob ? formatMs(Math.round(doneJob.end * 1000)).substring(0,8) : '';
      setStatus(`🔄 تفريغ ${cursor}/${aiTotalChunks} — ${Math.round(pct)}% &nbsp;•&nbsp; <span dir="ltr" style="font-family:var(--mono);color:var(--yw)">${oS} → ${oE}</span>`);
      renderCards();
    }
  }

  const workers = [];
  for(let w = 0; w < POOL; w++) workers.push(pump());
  await Promise.all(workers);

  // إيقاف حقيقي (ما زالت أجزاء ناقصة) → يُكمل عند الاستئناف
  if(aiIsPaused && aiCurrentChunk < aiTotalChunks) return;

  renderCards();
  if(aiCurrentChunk >= aiTotalChunks){
    aiIsPaused = false; // اكتمل حتى لو صدر أمر إيقاف عند آخر جزء
    setStatus(`✅ اكتمل التفريغ الصوتي! (${state.blocks.length} مقطع)`);
    aiAudioBuffer = null;
    switchAiUI('start');
    aiIsRunning = false;
    try { checkAlignReady(); } catch(_) {}
    // ⚠️ لا نصفر aiCurrentChunk هنا — الاستئناف بعد اكتمال أثناء الإيقاف يعتمد عليه
    // (startAi يصفّره عند بدء تفريغ جديد على أي حال)
    toast('SRT جاهز! يمكنك الآن مراجعته أو ترجمته','🎉');
  }
}

/* ════════════════════════════════════════════════════════════════
   🎯 مزامنة التوقيت مع الصوت (Groq Whisper Turbo — توقيت الكلمات)
   - تعيد إرسال الصوت مرة واحدة، وتستخدم أوقات الكلمات فقط.
   - النص الأصلي block.text هو ما يُطابق، لا الترجمة.
══════════════════════════════════════════════════════════════ */
let alignGroqWaitUntil = 0;

function alignCancelledError(){
  const e = new Error('cancelled');
  e.cancelled = true;
  return e;
}

function alignSleep(ms, signal){
  if(signal && signal.aborted) return Promise.reject(alignCancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    const onAbort = () => { cleanup(); reject(alignCancelledError()); };
    const cleanup = () => {
      clearTimeout(timer);
      if(signal) signal.removeEventListener('abort', onAbort);
    };
    if(signal) signal.addEventListener('abort', onAbort);
  });
}

/** إيقاف المزامنة الجارية (يُستدعى من الزر نفسه). */
export function cancelTimingSync(){
  if(!alignRunning) return;
  setAlignButton('⏹ جاري إلغاء المزامنة...');
  try { if(alignAbort) alignAbort.abort(); } catch(_) {}
  for(const ctrl of alignCtrls){ try { ctrl.abort(); } catch(_) {} }
}

function friendlyAlignError(err){
  const viaGemini = isAlignGeminiMode();
  if(viaGemini){
    if(err && err.status === 401) return 'مفتاح Gemini غير صحيح (401)';
    if(err && err.status === 403) return 'موديل Gemini غير مفعّل أو غير مصرح (403)';
    if(err && err.status === 404) return 'موديل Gemini غير متاح لهذا المفتاح أو في منطقتك (404)';
    if(err && err.status === 429) return 'تجاوزت حد Gemini (429) — انتظر قليلاً ثم أعد المحاولة';
    if(err && err.status === 413) return 'المقطع الصوتي أكبر من حد Gemini المباشر';
    if(err && err.status >= 500) return 'خطأ مؤقت في خادم Gemini — أعد المحاولة';
    const gm = (err && err.message) || '';
    if(/[\u0600-\u06FF]/.test(gm)) return gm;
    return 'تعذر الاتصال بـ Gemini — تحقق من الشبكة والمفتاح ثم أعد المحاولة';
  }
  if(err && err.status === 401) return 'مفتاح Groq غير صحيح (401)';
  if(err && err.status === 403) return 'الموديل غير مفعّل أو غير مصرح (403)';
  if(err && err.status === 408) return 'انتهت مهلة Groq — أعد المحاولة';
  if(err && err.status === 413) return 'المقطع الصوتي أكبر من الحد المسموح في Groq';
  if(err && err.status === 429) return 'تجاوزت حد Groq (429) — انتظر قليلاً ثم أعد المحاولة';
  if(err && err.status === 400){
    return /[\u0600-\u06FF]/.test(err.message || '')
      ? err.message
      : 'طلب Groq غير صالح (400) — تحقق من المفتاح والموديل';
  }
  if(err && err.status >= 500) return 'خطأ مؤقت في خادم Groq — أعد المحاولة';
  const msg = (err && err.message) || '';
  if(/[\u0600-\u06FF]/.test(msg)) return msg;
  return 'تعذر الاتصال بـ Groq — تحقق من الشبكة والمفتاح ثم أعد المحاولة';
}

function buildAlignJobs(durationSec, chunkSeconds){
  const total = Math.max(1, Math.ceil(durationSec / chunkSeconds));
  const jobs = [];
  for(let i = 0; i < total; i++){
    const start = i * chunkSeconds;
    const end = Math.min(start + chunkSeconds, durationSec);
    jobs.push({ index: i, start, end, offsetMs: Math.round(start * 1000) });
  }
  return jobs;
}

async function encodeAlignChunk(job){
  let { samples, sampleRate } = extractMonoChunk(aiAudioBuffer, job.start, job.end);
  if(sampleRate !== TARGET_SR){
    samples = resampleTo16k(samples, sampleRate);
    sampleRate = TARGET_SR;
  }
  let blob = null;
  let ext = 'mp3';
  try {
    blob = await encodeMonoToMp3(samples, sampleRate, 48, null);
  } catch(_) {
    // لا نرسل WAV ضخماً قد يتجاوز حد Groq: المقاطع نفسها صغيرة فقط عند فشل lamejs
    if(samples.length * 2 > 20 * 1024 * 1024){
      throw new Error('تعذر ضغط المقطع الصوتي (MP3) — أعد المحاولة');
    }
    ext = 'wav';
    blob = audioBufferToWav(samples, sampleRate);
  }
  samples = null;
  return { blob, ext };
}

/** يرسل مقطعاً واحداً إلى Gemini Multimodal ويستخرج أوقات الكلمات. */
async function transcribeGeminiWordsChunk(job, apiKey, myGen){
  const isCurrent = () => myGen === alignRunGen && alignRunning;
  if(!isCurrent()) throw alignCancelledError();
  setAlignButton(`⏳ تجهيز Gemini ${job.index + 1}/${alignTotal || 1}`);
  const { blob } = await encodeAlignChunk(job);
  if(!isCurrent()) throw alignCancelledError();

  let lastErr = null;
  for(let attempt = 1; attempt <= ALIGN_MAX_ATTEMPTS; attempt++){
    if(!isCurrent() || (alignAbort && alignAbort.signal.aborted)) throw alignCancelledError();
    setAlignButton(`⏳ Gemini ${job.index + 1}/${alignTotal || 1}`);
    const ctrl = new AbortController();
    alignCtrls.add(ctrl);
    const onAbort = () => { try { ctrl.abort(); } catch(_) {} };
    if(alignAbort && alignAbort.signal){
      if(alignAbort.signal.aborted) onAbort();
      else alignAbort.signal.addEventListener('abort', onAbort);
    }
    const timeoutMs = Math.max(180000, Math.ceil(blob.size / 1048576) * 60000);
    const tid = setTimeout(() => { try { ctrl.abort(); } catch(_) {} }, timeoutMs);
    try {
      const words = await transcribeAudioWords({
        blob,
        apiKey,
        offsetMs: job.offsetMs,
        durationMs: Math.round((job.end - job.start) * 1000),
        signal: ctrl.signal
      });
      return words;
    } catch(err){
      if(!isCurrent() || (alignAbort && alignAbort.signal.aborted)) throw alignCancelledError();
      lastErr = err;
      if(err && err.fatal) throw err;
      if(err && err.status === 429){
        const waitMs = 2000 * attempt;
        await alignSleep(waitMs, alignAbort && alignAbort.signal);
        continue;
      }
      if(err && err.status >= 500){
        await alignSleep(1000 * attempt, alignAbort && alignAbort.signal);
        continue;
      }
      if(err && err.name === 'AbortError'){
        lastErr = new Error(`انتهت مهلة Gemini (${Math.round(timeoutMs / 1000)}ث)`);
      }
      if(attempt < ALIGN_MAX_ATTEMPTS) await alignSleep(1000 * attempt, alignAbort && alignAbort.signal);
    } finally {
      clearTimeout(tid);
      if(alignAbort && alignAbort.signal) alignAbort.signal.removeEventListener('abort', onAbort);
      alignCtrls.delete(ctrl);
    }
  }
  throw lastErr || new Error(`فشل إرسال المقطع ${job.index + 1} إلى Gemini`);
}

/** يرسل مقطعاً واحداً إلى Groq Turbo ويستخرج أوقات الكلمات. */
async function transcribeWordsChunk(job, apiKey, myGen, useGemini = false){
  if(useGemini) return await transcribeGeminiWordsChunk(job, apiKey, myGen);
  const isCurrent = () => myGen === alignRunGen && alignRunning;
  if(!isCurrent()) throw alignCancelledError();
  setAlignButton(`⏳ تجهيز ${job.index + 1}/${alignTotal || 1}`);
  const { blob, ext } = await encodeAlignChunk(job);
  if(!isCurrent()) throw alignCancelledError();
  const sizeMB = Math.max(1, Math.ceil(blob.size / 1048576));
  const timeoutMs = Math.max(180000, sizeMB * 45000);
  let lastErr = null;

  for(let attempt = 1; attempt <= ALIGN_MAX_ATTEMPTS; attempt++){
    if(!isCurrent() || (alignAbort && alignAbort.signal.aborted)) throw alignCancelledError();

    const cooldown = alignGroqWaitUntil - Date.now();
    if(cooldown > 0) await alignSleep(cooldown, alignAbort && alignAbort.signal);

    setAlignButton(`⏳ إرسال ${job.index + 1}/${alignTotal || 1}`);
    const ctrl = new AbortController();
    alignCtrls.add(ctrl);
    const onAbort = () => { try { ctrl.abort(); } catch(_) {} };
    if(alignAbort && alignAbort.signal){
      if(alignAbort.signal.aborted) onAbort();
      else alignAbort.signal.addEventListener('abort', onAbort);
    }
    const tid = setTimeout(() => { try { ctrl.abort(); } catch(_) {} }, timeoutMs);

    try {
      const fd = new FormData();
      fd.append('file', blob, `align_${String(job.index + 1).padStart(3, '0')}.${ext}`);
      fd.append('model', ALIGN_MODEL);
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('temperature', '0');

      const res = await apiRequest('GROQ_TRANSCRIBE', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: fd,
        signal: ctrl.signal
      });

      if(res.ok){
        const data = await res.json();
        return extractWordTimings(data, job.offsetMs);
      }

      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        msg = data?.error?.message || data?.message || msg;
      } catch(_) {}

      lastErr = new Error(msg);
      lastErr.status = res.status;

      if(res.status === 401 || res.status === 403){
        throw lastErr;
      }
      if(res.status === 400 && /timestamp|granular|word/i.test(msg)){
        lastErr.message = 'Groq رفض توقيت الكلمات لهذا الموديل — تحقق من دعم الموديل ثم أعد المحاولة';
        lastErr.fatal = true;
        throw lastErr;
      }
      if(res.status === 429){
        const retryAfter = Number(res.headers?.get?.('retry-after') || 0);
        const waitMs = Math.max(2000, (retryAfter || 2) * 1000 * attempt);
        alignGroqWaitUntil = Math.max(alignGroqWaitUntil, Date.now() + waitMs);
        await alignSleep(waitMs, alignAbort && alignAbort.signal);
        continue;
      }
      if(res.status >= 500){
        await alignSleep(1000 * attempt, alignAbort && alignAbort.signal);
        continue;
      }
      throw lastErr;
    } catch(err) {
      if(err && err.fatal) throw err;
      if(!isCurrent() || (alignAbort && alignAbort.signal.aborted)) throw alignCancelledError();
      if(err && err.name === 'AbortError'){
        lastErr = new Error(`انتهت مهلة المقطع (${Math.round(timeoutMs / 1000)}ث)`);
      } else {
        lastErr = err;
      }
      if(err && err.status && err.status !== 429 && err.status < 500) throw err;
      if(attempt < ALIGN_MAX_ATTEMPTS) await alignSleep(1000 * attempt, alignAbort && alignAbort.signal);
    } finally {
      clearTimeout(tid);
      if(alignAbort && alignAbort.signal) alignAbort.signal.removeEventListener('abort', onAbort);
      alignCtrls.delete(ctrl);
    }
  }

  throw lastErr || new Error(`فشل إرسال المقطع ${job.index + 1}`);
}

/**
 * الزر الرئيسي: يعيد إرسال الصوت إلى Groq Turbo ويطبّق التوقيتات مباشرة.
 * الضغط مرة ثانية أثناء التشغيل = إلغاء.
 */
export async function syncTimingWithAudio(){
  if(alignRunning){ cancelTimingSync(); return; }

  if(!state.blocks.length) return toast('لا توجد أسطر لمزامنتها', '⚠️');
  if(aiIsRunning || aiExtractRunning) return toast('انتظر انتهاء التفريغ أو استخراج الصوت أولاً', '⏳');
  if(state.currentTask) return toast('انتظر انتهاء العملية الجارية أولاً', '⏳');
  if(!aiFile) return toast('ارفع الصوت أو الفيديو أولاً — المزامنة تحتاج الملف الأصلي', '⚠️');
  const useGemini = isAlignGeminiMode();
  const apiKey = ($(useGemini ? 'geminiKeyIn' : 'aiKeyIn')?.value || '').trim();
  if(!apiKey) return toast(useGemini ? 'أدخل Gemini API Key أولاً (المزامنة عبر Gemini مفعّلة)' : 'أدخل Groq API Key أولاً', '⚠️');

  const myGen = ++alignRunGen;
  alignRunning = true;
  try { checkAlignReady(); } catch(_) {} // يحوّل الزر إلى «إيقاف» أثناء التشغيل
  state.currentTask = 'align'; // يمنع بدء ترجمة/كشف أسماء أثناء المزامنة
  try { window.checkTrReady?.(); } catch(_) {}
  alignAbort = new AbortController();
  alignCtrls.clear();
  alignDone = 0;
  alignTotal = 0;
  alignGroqWaitUntil = 0;
  setAlignButton('⏳ فك تشفير الصوت...');

  try {
    if(!aiAudioBuffer){
      aiAudioBuffer = await decodeAudioFile(aiFile, msg => setAlignButton(msg));
    }
    if(alignAbort.signal.aborted) throw alignCancelledError();
    const durationSec = Number(aiAudioBuffer && aiAudioBuffer.duration);
    if(!(durationSec > 0)) throw new Error('تعذر قراءة مدة الصوت');
    aiTotalDurationMs = Math.round(durationSec * 1000);

    let lameOk = true;
    try {
      await Promise.race([
        loadLamejs(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('lame timeout')), 15000))
      ]);
    } catch(_) { lameOk = false; }
    if(alignAbort.signal.aborted) throw alignCancelledError();
    const chunkSeconds = lameOk ? CHUNK_SECONDS : Math.floor(CHUNK_SECONDS_WAV_FALLBACK);
    const jobs = buildAlignJobs(durationSec, chunkSeconds);
    alignTotal = jobs.length;

    const cost = Math.max(0.01, (aiTotalDurationMs / 3600000) * ALIGN_COST_PER_HOUR);
    toast(useGemini
      ? `🎯 إعادة إرسال الصوت إلى Gemini (~${Math.ceil(durationSec / 60)} دقيقة • يستهلك حصة Gemini)`
      : `🎯 إعادة إرسال الصوت إلى Groq Turbo (~${Math.ceil(durationSec / 60)} دقيقة • ~${cost.toFixed(2)})`, '💵');

    const results = new Array(jobs.length);
    let nextJob = 0;
    async function worker(){
      const isCurrent = () => myGen === alignRunGen && alignRunning;
      while(true){
        if(!isCurrent() || !alignAbort || alignAbort.signal.aborted) throw alignCancelledError();
        const idx = nextJob++;
        if(idx >= jobs.length) return;
        results[idx] = await transcribeWordsChunk(jobs[idx], apiKey, myGen, useGemini);
        if(!isCurrent()) throw alignCancelledError();
        alignDone++;
        setAlignButton(`⏳ مزامنة ${alignDone}/${alignTotal}`);
      }
    }
    const workers = [];
    for(let i = 0; i < Math.min(ALIGN_CONCURRENCY, jobs.length); i++) workers.push(worker());
    await Promise.all(workers);

    if(alignAbort.signal.aborted) throw alignCancelledError();

    const words = results
      .flat()
      .filter(w => w && Number.isFinite(w.startMs) && Number.isFinite(w.endMs))
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    if(!words.length){
      throw new Error(useGemini
        ? 'لم يرجع Gemini أي توقيت كلمات — قد يكون المقطع صامتاً أو الموديل لا يدعم توقيت الكلمات'
        : 'لم يرجع Groq أي توقيت كلمات — قد يكون المقطع صامتاً أو الموديل لا يدعم توقيت الكلمات');
    }

    const oldById = new Map(state.blocks.map(b => [b.id, {
      start: b.start, end: b.end, noSpeech: !!b.noSpeech
    }]));
    const { blocks, stats } = alignBlocksToWords(state.blocks, words, aiTotalDurationMs, { respectSilence: useGemini });

    if(stats.matched === 0){
      // لا نطبّق وسوم "لا صوت" على كل الأسطر إذا فشلت المطابقة كلياً؛
      // لكن نحذف السطور الفارغة تماماً إن وُجدت.
      if(stats.removedEmpty > 0){
        captureHistory();
        state.blocks = state.blocks.filter(b => String(b.text || '').trim() || String(b.tr || '').trim());
        renderCards();
        scheduleAutoSave(0);
        toast(`حُذف ${stats.removedEmpty} سطر فارغ — لكن لم أجد كلاماً مطابقاً (تأكد أن النص بلغة الصوت)`, '⚠️');
      } else {
        toast('لم أجد كلاماً مطابقاً — تأكد أن النص الأصلي بلغة الصوت', '⚠️');
      }
      return;
    }

    if(alignAbort.signal.aborted) throw alignCancelledError();
    captureHistory();
    state.blocks = blocks;
    renderCards();
    const changedIds = state.blocks
      .filter(b => {
        const old = oldById.get(b.id);
        return old && (old.start !== b.start || old.end !== b.end || old.noSpeech !== !!b.noSpeech);
      })
      .map(b => b.id);
    for(const id of changedIds){
      const card = $('row-' + id);
      if(card) card.classList.add('tr-flash');
    }
    scheduleAutoSave(0);

    const bits = [`تمت مزامنة ${stats.matched} سطراً`];
    if(stats.noSpeech) bits.push(`${stats.noSpeech} بلا صوت`);
    if(stats.removedEmpty) bits.push(`حُذف ${stats.removedEmpty} فارغ`);
    toast(bits.join(' • '), '🎯');
  } catch(err) {
    if(err && err.cancelled){
      toast('تم إلغاء مزامنة التوقيت', '⏹️');
    } else {
      console.warn('[align] failed:', (err && err.message) || err);
      toast('تعذرت مزامنة التوقيت: ' + friendlyAlignError(err), '❌');
    }
  } finally {
    if(myGen === alignRunGen){
      alignRunning = false;
      for(const ctrl of alignCtrls){ try { ctrl.abort(); } catch(_) {} }
      alignCtrls.clear();
      alignAbort = null;
      aiAudioBuffer = null;
      if(state.currentTask === 'align') state.currentTask = null;
      setAlignButton('🎯 مزامنة التوقيت');
      try { checkAlignReady(); } catch(_) {}
      try { window.checkTrReady?.(); } catch(_) {}
      try { document.dispatchEvent(new CustomEvent('srt:task-finished')); } catch(_) {}
    }
  }
}

/* ════════════════════════════════════════════════════════════════
   مستمع رفع ملفات الصوت/الفيديو للتفريغ
══════════════════════════════════════════════════════════════ */

/**
 * يربط مستمع change لحقل رفع الوسائط (aiFileIn).
 * يُستدعى مرة واحدة من main.js عند بدء التشغيل.
 */
export function initTranscribeEvents(){
  $('aiFileIn').addEventListener('change', function(){
    const f = this.files[0];
    if(!f) return;
    aiCurrentChunk = 0; aiTotalChunks = 0; aiTotalDurationMs = 0; aiAudioBuffer = null;
    setVisible('aiProgress', false);
    resetExtractUI();

    if(isVideoFile(f)){
      // ── مسار الفيديو: استخراج الصوت تلقائيًا ──
      aiOriginalVideoFile = f;
      aiFile = null;
      checkAiReady();
      setVisible('aiQualityBox', true, 'flex');
      setText('aiDropTxt', `<span style="color:var(--pu)">🎬 فيديو:</span><br>${f.name}`);
      switchAiUI('start');
      startVideoExtraction(f);
    } else {
      // ── مسار الصوت: يعمل تمامًا كما كان ──
      aiOriginalVideoFile = null;
      aiExtractCancelled = false; // كان true من resetExtractUI — كان يجعل كل ترميز MP3 يرمي CANCELLED ويسقط إلى WAV!
      setVisible('aiQualityBox', false);
      aiFile = f;
      checkAiReady();
      const sizeMB = (aiFile.size / 1048576).toFixed(2);
      setText('aiDropTxt',
        `<span style="color:var(--gr)">✅ تم الاختيار:</span><br>${aiFile.name}<br><small style="color:var(--t2)">${sizeMB} MB</small>`);
      toast('تم اختيار الملف','🎵');
      switchAiUI('start');
    }
  });
}

// أي تغيير في الأسطر (تفريغ/لصق/فتح مشروع) أو انتهاء مهمة يحدّث جاهزية زر المزامنة
try {
  const refreshAlignReady = () => { try { checkAlignReady(); } catch(_) {} };
  document.addEventListener('srt:blocks-updated', refreshAlignReady);
  document.addEventListener('srt:task-finished', refreshAlignReady);
} catch(_) {}
