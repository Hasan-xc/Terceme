/**
 * time.js — دوال مساعدة للتوقيتات (Time Helpers)
 *
 * المسؤولية: التحويل بين الصيغ الزمنية المختلفة المستخدمة في ملفات SRT
 * وواجهة المحرر. لا تعتمد على أي DOM أو حالة — دوال نقية قابلة لإعادة الاستخدام.
 */

const pad = (value, size = 2) => String(value).padStart(size, '0');

/**
 * يحوّل المللي ثانية إلى صيغة SRT القياسية: HH:MM:SS,mmm
 */
export const formatMs = (ms) => {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  return [
    pad(Math.floor(total / 3600000)),
    pad(Math.floor(total % 3600000 / 60000)),
    pad(Math.floor(total % 60000 / 1000))
  ].join(':') + ',' + pad(total % 1000, 3);
};

/**
 * يحوّل نص توقيت (مثل "01:23,5" أو "1:02:03.456" أو "12.5") إلى مللي ثانية.
 */
export function parseTimeStringToMs(timeStr){
  if(!timeStr) return 0;
  const parts = String(timeStr).replace(',', '.').split(':');
  let ms = 0;
  if(parts.length === 3){
    ms = (parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])) * 1000;
  } else if(parts.length === 2){
    ms = (parseInt(parts[0]) * 60 + parseFloat(parts[1])) * 1000;
  } else {
    ms = parseFloat(parts[0]) * 1000;
  }
  return Math.max(0, Math.round(ms || 0));
}

/**
 * صيغة مختصرة للعرض داخل بطاقات المحرر: MM:SS.s (أو H:MM:SS.s للأطول من ساعة).
 */
export function fmtTimeShort(tc){
  if(!tc) return '00:00.0';
  const parts = String(tc).split(':');
  if(parts.length !== 3) return tc;
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const seconds = parts[2].replace(',', '.').substring(0, 4);
  const minutes = pad(m);
  return h > 0 ? `${h}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * يحوّل أي صيغة توقيت مدخلة يدوياً إلى الصيغة القياسية HH:MM:SS,mmm.
 */
export function toStandardTime(tc){
  if(!tc) return '00:00:00,000';
  const parts = String(tc).replace('.', ',').split(':');
  let h = 0, m = 0, seconds = '00,000';
  if(parts.length === 3){
    h = parseInt(parts[0]) || 0;
    m = parseInt(parts[1]) || 0;
    seconds = parts[2];
  } else if(parts.length === 2){
    m = parseInt(parts[0]) || 0;
    seconds = parts[1];
  } else {
    seconds = parts[0];
  }
  const [sec = '0', fraction = '000'] = seconds.split(',');
  return `${pad(h)}:${pad(m)}:${pad(parseInt(sec) || 0)},${fraction.padEnd(3, '0').substring(0, 3)}`;
}
