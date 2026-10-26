/**
 * burn.js — حرق الترجمة المنسّقة على الفيديو محلياً
 *
 * الطريقة:
 *  - Canvas يرسم إطارات الفيديو + الترجمة بنفس إعدادات المظهر.
 *  - MediaRecorder يسجّل canvas.captureStream مع صوت الفيديو عبر Web Audio.
 *  - لا يُرفع أي شيء إلى خادم، والنتيجة WebM تُنزّل مباشرة.
 *
 * ملاحظة: المتصفحات تختلف في دعم MediaRecorder وترميز VP9/VP8.
 * نختار أفضل صيغة متاحة، ونعرض رسالة عربية واضحة عند عدم الدعم.
 */

import { state, blockDisplayText, getActiveTab } from './state.js';
import { parseTimeStringToMs } from './time.js';
import { $, toast } from './ui.js';
import { getSubStyle, backgroundOf } from './styling.js';
import { hasArabic } from './bidi.js';

let burnRunning = false;
let burnAbort = false;
let burnRecorder = null;
let burnTimer = null;

function setBurnUI(running, msg = ''){
  const btn = $('burnVideoBtn');
  const status = $('burnStatus');
  if(btn){
    btn.disabled = false;
    btn.textContent = running ? '⏹ إيقاف الحرق والاحتفاظ بالجزء المسجّل' : '🎬 حرق الترجمة على الفيديو (WebM)';
    btn.classList.toggle('burning', running);
  }
  if(status){
    status.textContent = msg || '';
    status.style.display = msg ? 'block' : 'none';
  }
}

function pickMime(){
  if(!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function waitMetadata(video){
  if(video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { cleanup(); resolve(); };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('canplay', done);
    };
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener('canplay', done, { once: true });
    setTimeout(done, 3000);
  });
}

function activeBlockAt(ms){
  const list = state.blocks;
  if(!list.length) return null;
  let lo = 0, hi = list.length - 1, found = null;
  while(lo <= hi){
    const mid = (lo + hi) >> 1;
    const s = parseTimeStringToMs(list[mid].start);
    const e = parseTimeStringToMs(list[mid].end);
    if(ms < s) hi = mid - 1;
    else if(ms > e) lo = mid + 1;
    else { found = list[mid]; break; }
  }
  return found;
}

function wrapCanvasLines(ctx, text, maxWidth){
  const out = [];
  for(const rawLine of String(text || '').split('\n')){
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if(!words.length){ out.push(''); continue; }
    let line = '';
    for(const word of words){
      const next = line ? line + ' ' + word : word;
      if(line && ctx.measureText(next).width > maxWidth){
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if(line) out.push(line);
  }
  return out;
}

function roundedRect(ctx, x, y, w, h, r){
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawSubtitle(ctx, text, style, width, height){
  const clean = String(text || '').trim();
  if(!clean) return;

  const baseSize = Number.parseFloat(style.size) || 18;
  const fontSize = Math.max(12, Math.round((height / 360) * baseSize));
  const fontFamily = style.font || "'Noto Naskh Arabic', serif";
  const isRtl = hasArabic(clean);
  const lineHeight = Math.round(fontSize * 1.42);
  const maxWidth = width * 0.86;

  ctx.save();
  ctx.font = `700 ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = isRtl ? 'rtl' : 'ltr';

  const lines = wrapCanvasLines(ctx, clean, maxWidth);
  const blockHeight = Math.max(lineHeight, lines.length * lineHeight);
  const padX = Math.round(fontSize * 0.65);
  const padY = Math.round(fontSize * 0.3);
  const boxW = Math.min(width * 0.94, Math.max(...lines.map(l => ctx.measureText(l).width), 1) + padX * 2);
  const boxH = blockHeight + padY * 2;
  const x = (width - boxW) / 2;

  let y;
  if(style.pos === 'top') y = Math.round(height * 0.10);
  else if(style.pos === 'bottom-low') y = Math.round(height * 0.95 - boxH);
  else y = Math.round(height * 0.88 - boxH);

  const bg = backgroundOf(style);
  if(bg !== 'transparent'){
    ctx.fillStyle = bg;
    roundedRect(ctx, x, y, boxW, boxH, Math.round(fontSize * 0.35));
    ctx.fill();
  }

  const outline = Math.max(0, Number(style.outline) || 0);
  if(outline > 0){
    ctx.lineJoin = 'round';
    ctx.lineWidth = outline * (height / 720);
    ctx.strokeStyle = 'rgba(0,0,0,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = Math.max(0, Number(style.shadowBlur) || 0) * (height / 720);
  } else if(style.shadowType !== 'none'){
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = Math.max(2, Number(style.shadowBlur) || 4) * (height / 720);
    ctx.shadowOffsetY = Math.max(1, height / 720 * 2);
  }

  ctx.fillStyle = style.color || '#ffffff';
  const startY = y + padY + lineHeight / 2;
  lines.forEach((line, i) => {
    const ty = startY + i * lineHeight;
    if(outline > 0) ctx.strokeText(line, width / 2, ty);
    ctx.fillText(line, width / 2, ty);
  });
  ctx.restore();
}

function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function makeAudioTrack(video){
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx) return null;
    if(!video.__burnAudioCtx){
      video.__burnAudioCtx = new AudioCtx();
      video.__burnSource = video.__burnAudioCtx.createMediaElementSource(video);
      video.__burnDest = video.__burnAudioCtx.createMediaStreamDestination();
      video.__burnSource.connect(video.__burnDest);
      video.__burnSource.connect(video.__burnAudioCtx.destination);
    }
    if(video.__burnAudioCtx.state === 'suspended'){
      video.__burnAudioCtx.resume().catch(() => {});
    }
    return video.__burnDest.stream;
  } catch(err){
    console.warn('[burn] audio capture unavailable:', err && err.message);
    return null;
  }
}

/** إيقاف الحرق مع إنهاء الملف الجزئي وتسجيل ما تم. */
export function cancelBurnedVideo(){
  if(!burnRunning) return;
  burnAbort = true;
  setBurnUI(true, '⏳ جاري إيقاف التسجيل وحفظ الجزء المسجّل...');
  try { if(burnRecorder && burnRecorder.state !== 'inactive') burnRecorder.stop(); } catch(_) {}
}

/**
 * يبدأ حرق الترجمة على الفيديو الحالي. الضغط أثناء التشغيل يوقف الحرق.
 */
export async function burnSubtitleVideo(){
  if(burnRunning){ cancelBurnedVideo(); return; }
  const video = $('mainVideo');
  if(!video || !video.src){
    return toast('ارفع فيديو أولاً من قسم المشاهدة ثم أعد المحاولة', '⚠️');
  }
  if(!state.blocks.length){
    return toast('لا توجد أسطر لحرقها', '⚠️');
  }
  if(state.currentTask){
    return toast('انتظر انتهاء العملية الجارية أولاً', '⏳');
  }
  if(!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream){
    return toast('متصفحك لا يدعم تسجيل Canvas/MediaRecorder — جرّب Chrome أو Edge حديثاً', '⚠️');
  }

  // ننشئ سياق الصوت داخل إيماءة المستخدم قبل أي await حتى لا يعلّقه المتصفح.
  const audioStream = makeAudioTrack(video);

  await waitMetadata(video);
  const duration = Number(video.duration);
  if(!(duration > 0)){
    return toast('تعذر قراءة مدة الفيديو — انتظر تحميله ثم أعد المحاولة', '⚠️');
  }
  if(duration > 300 && !window.confirm(`مدة الفيديو ${Math.round(duration / 60)} دقيقة. الحرق يتم بالزمن الحقيقي وقد يستغرق وقتاً طويلاً. هل تريد المتابعة؟`)){
    return;
  }

  const mime = pickMime();
  if(!mime){
    return toast('لا توجد صيغة WebM مدعومة في هذا المتصفح', '⚠️');
  }

  const width = Math.max(320, Math.min(1920, video.videoWidth || 1280));
  const height = Math.max(180, Math.min(1080, video.videoHeight || 720));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if(!ctx) return toast('تعذر إنشاء Canvas للحرق', '❌');

  const stream = canvas.captureStream(30);
  if(audioStream){
    audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
  }

  burnRunning = true;
  burnAbort = false;
  state.currentTask = 'burn';
  setBurnUI(true, '🔴 جاري الحرق بالزمن الحقيقي... لا تغلق الصفحة.');

  const chunks = [];
  let stopped = false;
  let finalized = false;
  let rafId = 0;
  const oldTime = video.currentTime;
  const oldMuted = video.muted;

  try {
    video.pause();
    video.currentTime = 0;
    video.muted = false;

    burnRecorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.min(8_000_000, Math.max(1_500_000, width * height * 4))
    });
    burnRecorder.ondataavailable = (e) => { if(e.data && e.data.size) chunks.push(e.data); };

    const finish = () => {
      if(stopped) return;
      stopped = true;
      clearTimeout(burnTimer);
      cancelAnimationFrame(rafId);
      try { video.pause(); } catch(_) {}
      if(burnRecorder && burnRecorder.state !== 'inactive'){
        try { burnRecorder.stop(); } catch(_) {}
      } else {
        finalize();
      }
    };

    const finalize = () => {
      if(finalized) return;
      finalized = true;
      if(!chunks.length){
        toast('لم يُسجَّل أي إطار — قد يكون الفيديو محمياً أو غير قابل للرسم', '⚠️');
        cleanupBurn();
        return;
      }
      const blob = new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' });
      const base = (($('fnIn') || {}).value || 'subtitle').trim() || 'subtitle';
      downloadBlob(blob, `${base}-hardsub.webm`);
      toast('تم إنشاء الفيديو بالترجمة المحروقة وتنزيله', '🎬');
      cleanupBurn();
    };

    burnRecorder.onstop = finalize;
    burnRecorder.onerror = () => {
      toast('توقف تسجيل الفيديو بسبب خطأ في المتصفح', '❌');
      cleanupBurn();
    };

    function cleanupBurn(){
      if(!burnRunning && !burnRecorder) return;
      burnRunning = false;
      burnAbort = false;
      burnRecorder = null;
      state.currentTask = null;
      video.muted = oldMuted;
      try { video.currentTime = Math.min(oldTime, duration); } catch(_) {}
      setBurnUI(false, '');
      try { document.dispatchEvent(new CustomEvent('srt:task-finished')); } catch(_) {}
    }

    const draw = () => {
      if(!burnRunning) return;
      if(burnAbort){
        finish();
        return;
      }
      const ct = Number(video.currentTime) || 0;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      if(video.readyState >= 2){
        const vw = video.videoWidth || width;
        const vh = video.videoHeight || height;
        const scale = Math.min(width / vw, height / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
      }
      const block = activeBlockAt(ct * 1000);
      if(block) drawSubtitle(ctx, blockDisplayText(block, getActiveTab()), getSubStyle(), width, height);

      const status = $('burnStatus');
      if(status){
        const pct = Math.max(0, Math.min(100, Math.round((ct / duration) * 100)));
        status.textContent = `🔴 جاري الحرق... ${pct}% — ${Math.floor(ct)} / ${Math.floor(duration)} ثانية`;
      }

      if(video.ended || ct >= duration - 0.03){
        finish();
        return;
      }
      rafId = requestAnimationFrame(draw);
    };

    // بدء التسجيل قبل التشغيل حتى لا يفوت الإطار الأول.
    burnRecorder.start(1000);
    await video.play();
    rafId = requestAnimationFrame(draw);

    // شبكة أمان: لا تتجاوز مدة الفيديو + 5 ثوانٍ.
    burnTimer = setTimeout(finish, Math.max(5000, duration * 1000 + 5000));
  } catch(err){
    console.warn('[burn] failed:', err);
    burnRunning = false;
    burnAbort = false;
    state.currentTask = null;
    try { video.pause(); } catch(_) {}
    setBurnUI(false, '');
    toast('تعذر حرق الترجمة: ' + ((err && err.message) || 'خطأ غير معروف'), '❌');
  }
}

export { setBurnUI };
