/**
 * align.js — محاذاة أسطر الترجمة مع أوقات كلمات التفريغ الصوتي
 *
 * المسؤولية (منطق نقي بلا DOM أو شبكة):
 *  - تطبيع الكلمات العربية/التركية/اللاتينية للمقارنة
 *  - مطابقة كلمات كل سطر مع كلمات Whisper بالترتيب (بلا رجوع للخلف)
 *  - اشتقاق بداية/نهاية السطر من أول وآخر كلمة مطابقة
 *  - إضافة هوامش، حد أدنى للمدة، ومنع التداخل
 *  - حذف السطر الفارغ تماماً، ووسم السطر بلا كلام بـ noSpeech
 *
 * لا تعتمد على نص Whisper نفسه — فقط على أوقات الكلمات.
 */

import { formatMs } from './time.js';

const PAD_BEFORE_MS = 200;
const PAD_AFTER_MS = 300;
const MIN_DURATION_MS = 800;
const NO_OVERLAP_MS = 50;
const MATCH_THRESHOLD = 0.78;
const STRONG_THRESHOLD = 0.86;

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** يحوّل نصاً إلى كلمات مطبّعة (يتجاهل الترقيم والتشكيل). */
export function tokenizeText(text){
  const clean = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064B-\u0652\u0670\u0640]/g, '')
    .normalize('NFKC');
  const list = clean.match(TOKEN_RE);
  return list ? list.map(normalizeToken).filter(Boolean) : [];
}

/** تطبيع كلمة للمقارنة: حروف صغيرة، بلا تشكيل/علامات، بلا ترقيم. */
export function normalizeToken(token){
  return String(token || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[’']/g, '')
    .toLocaleLowerCase()
    .replace(/ı/g, 'i')          // Turkish dotless ı
    .replace(/[أإآٱ]/g, 'ا')     // Arabic alef forms
    .replace(/ى/g, 'ي')          // Arabic alef maqsura
    .replace(/ة/g, 'ه')          // Arabic ta marbuta
    .replace(/ی/g, 'ي')          // Persian/Urdu yeh
    .replace(/ک/g, 'ك')          // Persian/Urdu kaf
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * يستخرج أوقات الكلمات من رد Groq (words أو segments[].words).
 * @param {object} data رد JSON من Groq
 * @param {number} offsetMs إزاحة المقطع داخل الصوت الكامل
 * @returns {Array<{text:string,startMs:number,endMs:number}>}
 */
export function extractWordTimings(data, offsetMs = 0){
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if(!item || typeof item !== 'object') return;
    const text = String(item.word || item.text || '').trim();
    if(!text || !/[\p{L}\p{N}]/u.test(text)) return;
    const start = Number(item.start);
    const end = Number(item.end);
    if(!Number.isFinite(start) || !Number.isFinite(end)) return;
    const startMs = Math.max(0, Math.round(start * 1000) + Math.round(offsetMs));
    const endMs = Math.max(startMs, Math.round(end * 1000) + Math.round(offsetMs));
    const key = `${startMs}|${endMs}|${text}`;
    if(seen.has(key)) return;
    seen.add(key);
    out.push({ text, startMs, endMs });
  };

  if(data && Array.isArray(data.words)) data.words.forEach(push);
  if(data && Array.isArray(data.segments)){
    data.segments.forEach(seg => {
      if(seg && Array.isArray(seg.words)) seg.words.forEach(push);
    });
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

/** مسافة ليفنشتاين محدودة (تتوقف مبكراً إذا تجاوزت الحد). */
function levenshtein(a, b, limit){
  const n = a.length, m = b.length;
  if(Math.abs(n - m) > limit) return limit + 1;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for(let j = 0; j <= m; j++) prev[j] = j;
  for(let i = 1; i <= n; i++){
    curr[0] = i;
    let rowMin = curr[0];
    const from = Math.max(1, i - limit);
    const to = Math.min(m, i + limit);
    for(let j = 1; j <= m; j++){
      if(j < from || j > to){
        curr[j] = limit + 1;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if(curr[j] < rowMin) rowMin = curr[j];
    }
    if(rowMin > limit) return limit + 1;
    const tmp = prev; prev = curr; curr = tmp;
  }
  return Math.min(prev[m], limit + 1);
}

/** تشابه بين كلمتين (0..1). الكلمات القصيرة لا تُطابق إلا بدقة. */
export function tokenSimilarity(a, b){
  if(!a || !b) return 0;
  if(a === b) return 1;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if(minLen <= 2) return 0;
  const limit = Math.max(2, Math.floor(maxLen * 0.32));
  const dist = levenshtein(a, b, limit);
  if(dist > limit) return 0;
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * يطابق كلمات سطر واحد مع نافذة من كلمات الصوت.
 * خوارزمية DP أحادية الاتجاه: مطابقة/تخطي كلمة صوت/تخطي كلمة سطر.
 *
 * @param {string[]} tokens كلمات السطر المطبّعة
 * @param {Array<{text:string,startMs:number,endMs:number}>} words كلمات الصوت
 * @param {number} from أول فهرس مسموح في words
 * @param {number} maxAhead أقصى عدد كلمات صوت نفحصها
 * @returns {{matches:Array<{tokenIndex:number,wordIndex:number,score:number}>,
 *            first:object,last:object,strong:number}|null}
 */
export function alignBlockTokens(tokens, words, from, maxAhead = 160){
  if(!tokens.length || !words.length || from >= words.length) return null;
  const windowLen = Math.min(words.length - from, Math.max(80, maxAhead));
  const n = tokens.length, m = windowLen;
  const MATCH = 1, SKIP_TOKEN = 2, SKIP_WORD = 3;

  // dp[i][j] = أفضل نتيجة لـ i كلمات سطر و j كلمات صوت
  const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  const bt = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  for(let i = 1; i <= n; i++){
    dp[i][0] = dp[i - 1][0] - 1.0;
    bt[i][0] = SKIP_TOKEN;
  }
  for(let j = 1; j <= m; j++){
    dp[0][j] = dp[0][j - 1] - 0.25;
    bt[0][j] = SKIP_WORD;
  }

  for(let i = 1; i <= n; i++){
    const token = tokens[i - 1];
    for(let j = 1; j <= m; j++){
      let best = -Infinity;
      let move = SKIP_TOKEN;

      const word = words[from + j - 1];
      const sim = tokenSimilarity(token, (word && (word.norm || normalizeToken(word.text))) || '');
      if(sim >= MATCH_THRESHOLD){
        const score = dp[i - 1][j - 1] + (sim >= 0.999 ? 3.0 : sim >= STRONG_THRESHOLD ? 2.2 : 1.2);
        if(score > best){ best = score; move = MATCH; }
      }
      const skipToken = dp[i - 1][j] - 1.0;
      if(skipToken > best){ best = skipToken; move = SKIP_TOKEN; }
      const skipWord = dp[i][j - 1] - 0.25;
      if(skipWord > best){ best = skipWord; move = SKIP_WORD; }

      dp[i][j] = best;
      bt[i][j] = move;
    }
  }

  // نختار أفضل نهاية داخل النافذة (لا نُلزم آخر كلمة في النافذة)
  // مع ترجيح البداية الأقرب عند التعادل — يمنع القفز إلى تكرار لاحق.
  let bestJ = 0;
  let bestScore = -Infinity;
  for(let j = 0; j <= m; j++){
    const score = dp[n][j] - j * 0.001;
    if(score > bestScore){ bestScore = score; bestJ = j; }
  }

  // التتبع الخلفي — نجمع المطابقات بترتيب تصاعدي
  const matches = [];
  let i = n, j = bestJ;
  while(i > 0 && j > 0){
    const move = bt[i][j];
    if(move === MATCH){
      const word = words[from + j - 1];
      const sim = tokenSimilarity(tokens[i - 1], (word && (word.norm || normalizeToken(word.text))) || '');
      matches.push({ tokenIndex: i - 1, wordIndex: from + j - 1, score: sim });
      i--; j--;
    } else if(move === SKIP_TOKEN){
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();
  if(!matches.length) return null;

  const strong = matches.filter(m => {
    const norm = tokens[m.tokenIndex] || '';
    return norm.length >= 3 && m.score >= STRONG_THRESHOLD;
  }).length;
  const ratio = matches.length / tokens.length;

  // سطر قصير (كلمة أو كلمتان) يُقبل فقط إذا طابق بدقة أول كلمة صوتية متوقعة
  // (مثل "OK" أو "No") — يمنع ضياع المداخلات القصيرة.
  const shortExact = tokens.length <= 2
    && matches.length === tokens.length
    && matches.every(m => m.score >= 0.999)
    && matches[0].wordIndex === from;

  // حماية من المطابقة الوهمية: سطر من 3 كلمات أو أكثر يحتاج كلمتين مطابقتين على الأقل
  if(!strong && !shortExact) return null;
  if(tokens.length >= 3 && matches.length < 2) return null;
  if(ratio < 0.4) return null;
  // سطر من 4 كلمات أو أكثر يحتاج دعامتين قويتين أو تغطية جيدة
  if(tokens.length >= 4 && strong < 2 && ratio < 0.6) return null;

  const first = words[matches[0].wordIndex];
  const last = words[matches[matches.length - 1].wordIndex];
  if(!first || !last) return null;

  return {
    matches,
    first,
    last,
    firstIndex: matches[0].wordIndex,
    lastIndex: matches[matches.length - 1].wordIndex,
    strong
  };
}

function isCompletelyEmpty(block){
  return !String((block && block.text) || '').trim() && !String((block && block.tr) || '').trim();
}

/**
 * كلمة "مميزة" للسطر: رقم، أو كلمة نادرة الظهور في كل الأسطر.
 * تُستخدم كمرساة حتى لا يسرق سطرٌ صامت كلمات السطر التالي المتشابه.
 */
function isSpecificToken(token, docFreq, totalBlocks){
  if(!token) return false;
  if(/^\d+$/.test(token)) return true;
  if(token.length < 3) return false;
  const limit = Math.max(2, Math.min(5, Math.ceil(totalBlocks * 0.02)));
  return docFreq > 0 && docFreq <= limit;
}

/**
 * يطبّق المحاذاة على كل الأسطر ويعيد نسخة جديدة + إحصاءات.
 *
 * @param {Array<object>} blocks أسطر state.blocks
 * @param {Array<{text:string,startMs:number,endMs:number}>} words كلمات الصوت مرتّبة
 * @param {number} durationMs مدة الصوت الكلية
 * @returns {{blocks:Array<object>, stats:object}}
 */
export function alignBlocksToWords(blocks, words, durationMs){
  const stats = {
    removedEmpty: 0,
    matched: 0,
    noSpeech: 0,
    changed: 0,
    total: 0
  };
  const input = Array.isArray(blocks) ? blocks : [];
  const wordList = (Array.isArray(words) ? words : [])
    .filter(w => w && Number.isFinite(w.startMs) && Number.isFinite(w.endMs))
    .map(w => ({ ...w, norm: w.norm || normalizeToken(w.text) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const kept = [];
  for(const block of input){
    if(isCompletelyEmpty(block)){
      stats.removedEmpty++;
      continue;
    }
    kept.push(block);
  }
  if(!wordList.length){
    const out = kept.map(block => {
      if(!!block.noSpeech !== true) stats.changed++;
      stats.noSpeech++;
      return { ...block, noSpeech: true };
    });
    stats.total = out.length;
    return { blocks: out, stats };
  }

  // تكرار كل كلمة عبر الأسطر — لتمييز الكلمات النادرة/الأرقام كمراسٍ
  const tokenDocFreq = new Map();
  for(const block of kept){
    const seen = new Set(tokenizeText(block.text));
    for(const token of seen){
      tokenDocFreq.set(token, (tokenDocFreq.get(token) || 0) + 1);
    }
  }

  let asrPos = 0;
  const matched = [];
  const out = [];

  for(const block of kept){
    const tokens = tokenizeText(block.text);
    let aligned = null;
    if(tokens.length){
      const maxAhead = Math.min(800, Math.max(120, tokens.length * 6));
      aligned = alignBlockTokens(tokens, wordList, asrPos, maxAhead);
    }

    // حماية إضافية: الكلمات النادرة/الأرقام هي مراسي السطر.
    // إذا لم تُطابق أغلبها، فالسطر على الأرجح بلا صوت (وليس سطراً مجاوراً).
    if(aligned){
      const matchedTokens = new Set(aligned.matches.map(m => m.tokenIndex));
      let specificTotal = 0;
      let specificMatched = 0;
      tokens.forEach((token, idx) => {
        if(isSpecificToken(token, tokenDocFreq.get(token) || 0, kept.length)){
          specificTotal++;
          if(matchedTokens.has(idx)) specificMatched++;
        }
      });
      if(specificTotal > 0 && specificMatched / specificTotal < 0.5){
        aligned = null;
      }
    }

    if(!aligned){
      const next = { ...block, noSpeech: true };
      if(!!block.noSpeech !== true) stats.changed++;
      stats.noSpeech++;
      out.push(next);
      continue;
    }

    stats.matched++;
    if(Number.isFinite(aligned.lastIndex)) asrPos = aligned.lastIndex + 1;

    let startMs = Math.max(0, aligned.first.startMs - PAD_BEFORE_MS);
    if(durationMs > 0) startMs = Math.min(startMs, Math.max(0, durationMs - 100));
    let endMs = Math.max(aligned.last.endMs, aligned.first.startMs) + PAD_AFTER_MS;
    if(endMs < startMs + MIN_DURATION_MS) endMs = startMs + MIN_DURATION_MS;
    if(durationMs > 0) endMs = Math.min(endMs, durationMs);
    if(endMs <= startMs) endMs = startMs + 100;

    const next = {
      ...block,
      start: formatMs(startMs),
      end: formatMs(endMs),
      noSpeech: false
    };
    if(next.start !== block.start || next.end !== block.end || !!block.noSpeech !== false){
      stats.changed++;
    }
    matched.push({ index: out.length, startMs, endMs });
    out.push(next);
  }

  // منع التداخل بين الأسطر التي تمت محاذاتها فقط
  for(let i = 0; i < matched.length - 1; i++){
    const a = matched[i];
    const b = matched[i + 1];
    const maxEnd = b.startMs - NO_OVERLAP_MS;
    if(a.endMs > maxEnd){
      a.endMs = Math.max(a.startMs + 100, maxEnd);
      const block = out[a.index];
      const nextEnd = formatMs(a.endMs);
      if(block.end !== nextEnd){
        block.end = nextEnd;
        stats.changed++;
      }
    }
  }

  stats.total = out.length;
  return { blocks: out, stats };
}

export {
  PAD_BEFORE_MS,
  PAD_AFTER_MS,
  MIN_DURATION_MS,
  NO_OVERLAP_MS,
  MATCH_THRESHOLD,
  STRONG_THRESHOLD
};
