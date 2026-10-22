/**
 * theme.js — المظهر النهاري/الليلي
 *
 * - يتبع تفضيل النظام افتراضياً (prefers-color-scheme).
 * - عند اختيار المستخدم من زر ☀️/🌙 يُحفظ الاختيار في localStorage.
 * - السكربت الصغير في index.html يطبّق الثيم قبل الرسم لمنع الوميض.
 */

import { $ } from './ui.js';

const STORAGE_KEY = 'srt_theme';
const THEME_COLORS = { light: '#FCF9EA', dark: '#0d1526' };

function systemTheme(){
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch(_) {
    return 'light';
  }
}

function savedTheme(){
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return (value === 'dark' || value === 'light') ? value : '';
  } catch(_) {
    return '';
  }
}

function applyTheme(theme){
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);

  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', THEME_COLORS[next]);

  const switchEl = $('themeSwitch');
  if(switchEl){
    switchEl.querySelectorAll('[data-theme-choice]').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.themeChoice === next ? 'true' : 'false');
    });
  }
  return next;
}

/** تعيين الثيم صراحةً (زر المستخدم) وحفظه. */
export function setTheme(theme){
  const next = applyTheme(theme);
  try { localStorage.setItem(STORAGE_KEY, next); } catch(_) {}
  return next;
}

/** قراءة الثيم الحالي الفعلي. */
export function getTheme(){
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** تبديل الشمس/القمر. */
export function toggleTheme(){
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/** تهيئة زر الثيم ومتابعة تغيّر تفضيل النظام ما دام المستخدم لم يختر يدوياً. */
export function initTheme(){
  applyTheme(savedTheme() || systemTheme());

  const switchEl = $('themeSwitch');
  if(switchEl && switchEl.dataset.bound !== '1'){
    switchEl.dataset.bound = '1';
    switchEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-choice]');
      if(!btn) return;
      e.preventDefault();
      e.stopPropagation();
      setTheme(btn.dataset.themeChoice);
    });
  }

  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if(!savedTheme()) applyTheme(systemTheme());
    };
    if(typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else if(typeof media.addListener === 'function') media.addListener(onChange);
  } catch(_) {}
}
