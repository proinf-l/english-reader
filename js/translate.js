/* ============================================================
   选区翻译
   - 只用免 key 的 MyMemory 接口（浏览器可直接跨域调用）
   - 显式点击才发请求，结果本地缓存，避免重复消耗每日额度
   - 长文本按句子切块（接口单次上限约 500 字符）
   ============================================================ */

const API = 'https://api.mymemory.translated.net/get';
const CACHE_KEY = 'english-reader.translations.v1';
const MAX_CACHE = 400;
const MAX_CHUNK = 450;
const TIMEOUT_MS = 12000;

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE) {
      keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
      for (const key of keys.slice(0, keys.length - MAX_CACHE)) delete cache[key];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (_) { /* 存不下就算了 */ }
}

function keyOf(text) {
  // 简单稳定哈希，够用
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return 'k' + (hash >>> 0).toString(36) + ':' + text.length;
}

/** 按句子切块，保证每块不超过接口上限 */
export function splitChunks(text, limit = MAX_CHUNK) {
  const sentences = String(text).match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [String(text)];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length > limit) {
      if (current) { chunks.push(current.trim()); current = ''; }
      // 超长单句：按逗号或空格硬切
      let rest = s;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(', ', limit);
        if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
        if (cut <= 0) cut = limit;
        chunks.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      if (rest.trim()) current = rest.trim() + ' ';
      continue;
    }
    if ((current + s).length > limit) {
      chunks.push(current.trim());
      current = s + ' ';
    } else {
      current += s + ' ';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [String(text).trim()];
}

function decodeEntities(text) {
  if (!/[&<>]/.test(text)) return text;
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

async function translateChunk(chunk, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);

  try {
    const url = `${API}?q=${encodeURIComponent(chunk)}&langpair=en|zh-CN`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('接口返回 ' + response.status);

    const data = await response.json();
    const text = data?.responseData?.translatedText;
    if (!text) throw new Error('接口没有返回译文');
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(text)) throw new Error(text);

    return decodeEntities(String(text)).trim();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 翻译一段英文。
 * @returns {Promise<{text:string, cached:boolean, chunks:number}>}
 */
export async function translate(text, options = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('没有可翻译的内容');
  if (!/[A-Za-z]/.test(clean)) throw new Error('选区里没有英文');

  const store = loadCache();
  const key = keyOf(clean);
  if (store[key]) return { text: store[key].t, cached: true, chunks: 1 };

  const chunks = splitChunks(clean);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = await translateChunk(chunks[i], options.signal);
    parts.push(part);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 250));
  }

  const result = parts.join('\n');
  store[key] = { t: result, at: Date.now() };
  saveCache();

  return { text: result, cached: false, chunks: chunks.length };
}

export function clearCache() {
  cache = {};
  try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
}
