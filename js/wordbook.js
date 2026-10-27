/* ============================================================
   生词本
   - 存在 localStorage，纯本地，不上传
   - 按「原形」去重：先点 played 再点 play，只记一条 play
   - 导出 CSV（Excel 用，带 BOM）与 Anki 制表符格式
   ============================================================ */

import { formatPhonetic } from './dict.js';

const KEY = 'english-reader.wordbook.v1';
const MAX_ITEMS = 5000;

function safeGet() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function safeSet(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch (_) {
    return false;
  }
}

export function list() {
  return safeGet().sort((a, b) => (b.t || 0) - (a.t || 0));
}

export function count() {
  return safeGet().length;
}

function firstMeaning(entry) {
  const sense = entry.senses && entry.senses[0];
  if (sense && sense.text) {
    return (sense.pos ? sense.pos + ' ' : '') + sense.text;
  }
  const line = String(entry.translation || '').split('\n')[0] || '';
  return line.trim();
}

/** 记录一次查词；返回最新总数 */
export function add(entry, query) {
  if (!entry || !entry.word) return count();
  const items = safeGet();
  const now = Date.now();
  const hit = items.find(item => item.w === entry.word);

  if (hit) {
    hit.n = (hit.n || 1) + 1;
    hit.t = now;
    if (query && query !== entry.word) hit.q = query;
  } else {
    items.push({
      w: entry.word,
      p: formatPhonetic(entry.phonetic || ''),
      m: firstMeaning(entry),
      q: query || entry.word,
      n: 1,
      t: now,
    });
    if (items.length > MAX_ITEMS) {
      items.sort((a, b) => (b.t || 0) - (a.t || 0));
      items.length = MAX_ITEMS;
    }
  }
  safeSet(items);
  return items.length;
}

export function remove(word) {
  const items = safeGet().filter(item => item.w !== word);
  safeSet(items);
  return items.length;
}

export function clear() {
  safeSet([]);
  return 0;
}

export function has(word) {
  return safeGet().some(item => item.w === word);
}

/* ---------------- 导出 ---------------- */

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function toCsv() {
  const rows = [['单词', '音标', '释义', '查询次数', '最近查询']];
  for (const item of list()) {
    rows.push([
      item.w,
      item.p ? '/' + item.p + '/' : '',
      item.m || '',
      String(item.n || 1),
      new Date(item.t || Date.now()).toLocaleString('zh-CN'),
    ]);
  }
  const body = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  // BOM 让 Excel 正确识别 UTF-8
  return '\ufeff' + body + '\r\n';
}

export function toTsv() {
  // Anki 导入：正面 \t 背面
  return list()
    .map(item => {
      const front = item.w + (item.p ? ' /' + item.p + '/' : '');
      const back = item.m || '';
      return front + '\t' + back;
    })
    .join('\n');
}
