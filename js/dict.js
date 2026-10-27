/* ============================================================
   词典客户端
   - 按首字母分片加载（点到才下载），加载后常驻内存
   - 支持变形反查：played -> play，并告诉调用方是哪种变形
   - 分片内查不到时，按常见词尾规则再猜一轮
   ============================================================ */

const BASE = 'data/';
const chunks = new Map();          // letter -> Promise<{ e, v }>
const entryCache = new Map();      // word -> entry

export const EXCHANGE_LABEL = {
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  '3': '第三人称单数',
  s: '复数',
  r: '比较级',
  t: '最高级',
  '0': '原形',
  '1': '变形',
};

/* 只有这些词性缩写才被当作「词性标签」，避免把 U.S. 之类误拆 */
const POS_WORDS = new Set([
  'n', 'v', 'vt', 'vi', 'adj', 'adv', 'prep', 'conj', 'pron', 'num',
  'art', 'int', 'interj', 'aux', 'abbr', 'a', 'ad', 'pl', 'pref', 'suf',
  'modal', 'det', 'phr',
]);

export function normalizeWord(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z'\-]+$/, '')
    .replace(/^'+|'+$/g, '');
}

/** ECDICT 的音标用 ":" 表长音、"'" 表重音、"," 表次重音，转成国际音标符号 */
export function formatPhonetic(raw) {
  return String(raw || '')
    .replace(/:/g, 'ː')
    .replace(/'/g, 'ˈ')
    .replace(/,/g, 'ˌ')
    .replace(/ә/g, 'ə');   // 词库里混用了西里尔字母的 schwa
}

export function parseExchange(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split('/')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const code = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!code || !value) continue;
    const forms = value.split(',').map(s => s.trim()).filter(Boolean);
    if (!forms.length) continue;
    (out[code] = out[code] || []).push(...forms);
  }
  return out;
}

/** 把 ECDICT 的一行中文释义拆成「词性 + 释义」的条目 */
export function parseSenses(translation) {
  const lines = String(translation || '')
    // 兼容词库里残留的字面量 \n
    .replace(/\\r\\n|\\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return lines.map(line => {
    const match = line.match(/^([A-Za-z&/.]+\.)\s*(.*)$/);
    if (match && match[2]) {
      const words = match[1].toLowerCase().replace(/[./&]/g, ' ').trim().split(/\s+/);
      if (words.length && words.every(w => POS_WORDS.has(w))) {
        return { pos: match[1], text: match[2] };
      }
    }
    return { pos: '', text: line };
  });
}

function chunkUrl(letter) {
  return BASE + letter + '.json';
}

export function loadChunk(letter) {
  const key = String(letter || '').toLowerCase();
  if (!/^[a-z]$/.test(key)) return Promise.resolve({ e: {}, v: {} });
  if (!chunks.has(key)) {
    const promise = fetch(chunkUrl(key), { cache: 'force-cache' })
      .then(res => {
        if (!res.ok) throw new Error('词库分片加载失败：' + key + ' (' + res.status + ')');
        return res.json();
      })
      .catch(err => {
        chunks.delete(key);
        throw err;
      });
    chunks.set(key, promise);
  }
  return chunks.get(key);
}

/** 预热：把一批词涉及的首字母分片先拉下来 */
export function prefetch(words) {
  const letters = new Set();
  for (const word of words) {
    const norm = normalizeWord(word);
    if (norm.length >= 1) letters.add(norm[0]);
  }
  // 只预热常用字母，避免一上来就拉 26 个分片
  const common = 'etaoinshrdlucmfwypvbgkjqxz';
  const ordered = [...letters].sort((a, b) => common.indexOf(a) - common.indexOf(b));
  ordered.slice(0, 8).forEach(letter => {
    loadChunk(letter).catch(() => {});
  });
}

function makeEntry(word, raw, letter) {
  return {
    word,
    phonetic: raw[0] || '',
    translation: raw[1] || '',
    exchangeRaw: raw[2] || '',
    senses: parseSenses(raw[1] || ''),
    forms: parseExchange(raw[2] || ''),
    letter,
  };
}

function cacheEntry(entry) {
  entryCache.set(entry.word, entry);
  return entry;
}

/** 直查某个词形（不做变形猜测） */
async function findExact(word) {
  if (!word || !/^[a-z]/.test(word)) return null;
  if (entryCache.has(word)) return { kind: 'exact', entry: entryCache.get(word) };

  const letter = word[0];
  const chunk = await loadChunk(letter);
  const raw = chunk.e[word];
  if (raw) return { kind: 'exact', entry: cacheEntry(makeEntry(word, raw, letter)) };

  const base = chunk.v[word];
  if (base && base !== word) {
    const baseLetter = base[0];
    const baseChunk = baseLetter === letter ? chunk : await loadChunk(baseLetter);
    const baseRaw = baseChunk.e[base];
    if (baseRaw) {
      return {
        kind: 'form',
        entry: cacheEntry(makeEntry(base, baseRaw, baseLetter)),
        query: word,
      };
    }
  }
  return null;
}

/** 词尾规则兜底：词库的变形表没覆盖到时再猜 */
function guessBases(word) {
  const out = [];
  const push = w => {
    if (w && w.length >= 2 && w !== word && !out.includes(w)) out.push(w);
  };

  if (word.endsWith("'s")) push(word.slice(0, -2));
  if (word.endsWith('ies')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('ied')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('ier')) push(word.slice(0, -3) + 'y');
  if (word.endsWith('iest')) push(word.slice(0, -4) + 'y');
  if (word.endsWith('es')) push(word.slice(0, -2));
  if (word.endsWith('s')) push(word.slice(0, -1));
  if (word.endsWith('ed')) {
    push(word.slice(0, -2));
    push(word.slice(0, -1));
    if (/([b-df-hj-np-tv-z])\1ed$/.test(word)) push(word.slice(0, -3));
  }
  if (word.endsWith('ing')) {
    push(word.slice(0, -3));
    push(word.slice(0, -3) + 'e');
    if (/([b-df-hj-np-tv-z])\1ing$/.test(word)) push(word.slice(0, -4));
  }
  if (word.endsWith('ly')) {
    push(word.slice(0, -2));
    push(word.slice(0, -2) + 'e');
  }
  if (word.endsWith('er')) push(word.slice(0, -2));
  if (word.endsWith('est')) push(word.slice(0, -3));
  if (word.endsWith('n\'t')) push(word.slice(0, -3));
  return out;
}

/**
 * 查词。
 * @returns {Promise<null | {query, entry, formLabel?:string, formCode?:string}>}
 */
export async function lookup(rawWord) {
  const query = normalizeWord(rawWord);
  if (!query) return null;

  // 直接查不吞异常：分片还没缓存 / 断网时要让上层提示，而不是谎报「未收录」
  const direct = await findExact(query);
  if (direct) {
    if (direct.kind === 'exact') return { query, entry: direct.entry };
    return withFormLabel(query, direct.entry);
  }

  for (const candidate of guessBases(query)) {
    const hit = await findExact(candidate);
    if (hit) return withFormLabel(query, hit.entry);
  }

  // 连字符词：整词没有，就试后半截（well-known -> known）
  if (query.includes('-')) {
    for (const part of query.split('-').slice().reverse()) {
      const hit = await findExact(part);
      if (hit) return withFormLabel(query, hit.entry);
    }
  }

  return null;
}

function withFormLabel(query, entry) {
  const forms = entry.forms || {};
  let code = null;
  for (const [c, list] of Object.entries(forms)) {
    if (list.some(form => form.toLowerCase() === query)) { code = c; break; }
  }
  return {
    query,
    entry,
    formCode: code,
    formLabel: code ? (EXCHANGE_LABEL[code] || '变形') : null,
  };
}

export function getMeta() {
  return fetch('data/meta.json').then(r => r.json());
}

/* ============================================================
   模糊建议：查不到时给「你是不是要找…」
   - 用全部词头索引跨首字母搜索（evertheless -> nevertheless）
   - 支持增删改和相邻字母颠倒（mornign -> morning）
   ============================================================ */

let wordIndexPromise = null;

function loadWordIndex() {
  if (!wordIndexPromise) {
    wordIndexPromise = fetch('data/words.json', { cache: 'force-cache' })
      .then(res => {
        if (!res.ok) throw new Error('词头索引加载失败');
        return res.json();
      })
      .catch(err => {
        wordIndexPromise = null;
        throw err;
      });
  }
  return wordIndexPromise;
}

/** 编辑距离（含相邻换位），超过 max 直接返回 max+1 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const m = a.length;
  const n = b.length;
  let prev2 = null;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      cur[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array(n + 1);
  }
  return prev[n];
}

/**
 * 给一个查不到的词找相近候选。
 * @param {string} raw 用户点的词（可能是 OCR 错字）
 * @param {number} limit 最多返回几个
 * @returns {Promise<string[]>}
 */
export async function suggest(raw, limit = 6) {
  const word = normalizeWord(raw);
  if (!word || word.length < 3) return [];

  let index;
  try {
    index = await loadWordIndex();
  } catch (_) {
    return [];
  }

  const hits = [];
  for (const candidate of index) {
    if (candidate === word) continue;
    const lengthGap = candidate.length - word.length;
    if (Math.abs(lengthGap) > 2) continue;

    const distance = editDistance(word, candidate, 2);

    let score;
    if (distance <= 2) {
      score = distance;
      // 首字母一致的错字更可能是同一个词
      if (distance === 1 && candidate[0] === word[0]) score -= 0.25;
    } else if (lengthGap > 0 && lengthGap <= 3 && candidate.startsWith(word)) {
      // 只打了前缀，比如 recogn -> recognize
      score = 1.6;
    } else {
      continue;
    }
    hits.push({ word: candidate, score });
  }

  hits.sort((a, b) => a.score - b.score
    || a.word.length - b.word.length
    || a.word.localeCompare(b.word));

  return hits.slice(0, limit).map(hit => hit.word);
}
