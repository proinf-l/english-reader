/* ============================================================
   主程序
   ============================================================ */

import { lookup, prefetch, suggest, EXCHANGE_LABEL, formatPhonetic } from './dict.js';
import {
  prepare, recognize, warmup, detectUprightRotation,
  rotateCanvas, rotateForDisplay, resultScore,
} from './ocr.js';
import * as wordbook from './wordbook.js';
import { translate } from './translate.js';

const $ = (sel) => document.querySelector(sel);

const el = {
  fileInput: $('#fileInput'),
  btnAdd: $('#btnAdd'),
  btnClear: $('#btnClear'),
  emptyState: $('#emptyState'),
  viewer: $('#viewer'),
  viewport: $('#viewport'),
  canvasWrap: $('#canvasWrap'),
  pageImg: $('#pageImg'),
  overlay: $('#overlay'),
  textLayer: $('#textLayer'),
  prevPage: $('#prevPage'),
  nextPage: $('#nextPage'),
  rotateBtn: $('#rotateBtn'),
  pageInfo: $('#pageInfo'),
  modeToggle: $('#modeToggle'),
  jumpToggle: $('#jumpToggle'),
  panel: $('#panel'),
  panelHandle: $('#panelHandle'),
  panelScroll: $('#panelScroll'),
  panelEmpty: $('#panelEmpty'),
  panelBody: $('#panelBody'),
  scrim: $('#scrim'),
  busy: $('#busy'),
  busyText: $('#busyText'),
  busyBar: $('#busyBar'),
  reader: $('#reader'),
  btnWordbook: $('#btnWordbook'),
  wbBadge: $('#wbBadge'),
  wordbook: $('#wordbook'),
  wbCount: $('#wbCount'),
  wbList: $('#wbList'),
  wbClose: $('#wbClose'),
  wbExportCsv: $('#wbExportCsv'),
  wbExportTsv: $('#wbExportTsv'),
  wbClear: $('#wbClear'),
};

const PHONE = () => window.matchMedia('(max-width: 860px)').matches;

const S = {
  pages: [],
  index: 0,
  mode: 'image',
  zoom: 1,
  fitWidth: 320,
  jumpMode: false,
  ctrl: false,
  selecting: false,
  sel: { segments: [], last: -1 },
  lookupSeq: 0,
  lastTap: { t: 0, x: 0, y: 0 },
};

/* ---------------- 小工具 ---------------- */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function currentPage() {
  return S.pages[S.index] || null;
}

/* ---------------- 图片导入 ---------------- */

async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;

  const wasEmpty = S.pages.length === 0;
  for (const file of files) {
    const url = URL.createObjectURL(file);
    S.pages.push({
      url,
      originalUrl: url,
      name: file.name,
      words: [],
      lines: [],
      status: 'new',
      error: '',
      manualRotation: 0,
    });
  }
  if (wasEmpty) S.index = 0;

  el.btnClear.hidden = false;
  await renderPage();
  updateChrome();
  processQueue();
}

function showEmpty() {
  el.emptyState.hidden = false;
  el.viewer.hidden = true;
  el.textLayer.hidden = true;
  el.btnClear.hidden = true;
  closePanel();
}

async function renderPage() {
  const page = currentPage();
  if (!page) { showEmpty(); return; }

  el.emptyState.hidden = true;
  el.viewer.hidden = false;

  if (S.mode === 'text') {
    el.viewport.hidden = true;
    el.textLayer.hidden = false;
    el.viewer.classList.add('text-mode');
    renderTextLayer();
    return;
  }

  el.viewport.hidden = false;
  el.textLayer.hidden = true;
  el.viewer.classList.remove('text-mode');

  if (el.pageImg.src !== page.url) {
    el.pageImg.src = page.url;
    try { await el.pageImg.decode(); } catch (_) { /* ignore */ }
  }
  computeFit();
  renderOverlay();
}

function computeFit() {
  const w = el.viewport.clientWidth - 24;
  S.fitWidth = Math.max(160, Math.min(w, 880));
  applyZoom();
}

function applyZoom() {
  el.canvasWrap.style.width = Math.round(S.fitWidth * S.zoom) + 'px';
}

/* ---------------- OCR 队列 ---------------- */

let queueRunning = false;
let queuePending = false;

async function processQueue() {
  if (queueRunning) {
    // 队列正在跑的时候又来了新任务，标记一下，收尾时再来一轮
    queuePending = true;
    return;
  }
  queueRunning = true;
  try {
    do {
      queuePending = false;
      for (;;) {
        const page = S.pages.find(p => p.status === 'new');
        if (!page) break;
        await ocrPage(page);
      }
    } while (queuePending);
  } finally {
    queueRunning = false;
    hideBusy();
    updateChrome();
  }
}

async function ocrPage(page) {
  const pageNo = S.pages.indexOf(page) + 1;
  page.status = 'ocr';
  updateChrome();
  showBusy(`正在识别第 ${pageNo} 页…`);
  setBusyProgress(0.02);

  try {
    const bitmap = await loadBitmap(page);
    const canvas = prepare(bitmap);

    setBusyProgress(0.05);
    let result;

    if (page.manualRotation) {
      // 用户手动转过：直接按这个角度来，不再自动判断
      const upright = rotateCanvas(canvas, page.manualRotation);
      await adoptRotatedDisplay(page, bitmap, page.manualRotation);
      result = await recognize(upright);
    } else {
      adoptOriginalDisplay(page);
      result = await recognize(canvas, (_status, progress) => {
        setBusyProgress(Math.max(0.05, progress));
      });

      // 先按正向识别；结果可疑（多半是图拍歪了）才去找方向，正常页面不付这笔时间。
      // 不能只看「置信度 × √词数」：方向全错时也会吐出一堆垃圾词把分数顶上去，
      // 所以平均置信度偏低也要触发（正常页面 85~96，歪掉的一般 30 以下）。
      const meanConf = result.words.length
        ? result.words.reduce((sum, w) => sum + (w.c || 0), 0) / result.words.length
        : 0;

      if (resultScore(result) < 500 || meanConf < 65) {
        showBusy(`正在识别第 ${pageNo} 页（检查图片方向）…`);
        const rotation = await detectUprightRotation(canvas);
        if (rotation) {
          // 记录到 manualRotation：显示和后续手点「旋转」都从同一个基准算
          page.manualRotation = rotation;
          const upright = rotateCanvas(canvas, rotation);
          await adoptRotatedDisplay(page, bitmap, rotation);
          showBusy(`正在重新识别（已自动旋转 ${rotation}°）…`);
          result = await recognize(upright);
        }
      }
    }
    page.words = result.words;
    page.lines = result.lines;
    page.bitmap = null;

    // 先渲染再改状态，避免外部看到 ready 却点不到词框
    if (page === currentPage()) {
      renderOverlay();
      if (S.mode === 'text') renderTextLayer();
    }
    page.status = 'ready';
    updateChrome();
    prefetch(page.words.map(w => w.t));
  } catch (err) {
    console.error(err);
    page.status = 'error';
    page.error = err && err.message ? err.message : String(err);
    updateChrome();
  }
}

async function loadBitmap(page) {
  if (page.bitmap) return page.bitmap;

  if (typeof createImageBitmap === 'function') {
    try {
      const res = await fetch(page.originalUrl || page.url);
      const blob = await res.blob();
      // 让浏览器按 EXIF 方向解码，避免手机照片被躺倒
      page.bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return page.bitmap;
    } catch (_) {
      // 落回 <img>，照顾不支持 createImageBitmap 的老浏览器
    }
  }

  page.bitmap = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = page.originalUrl || page.url;
  });
  return page.bitmap;
}

/** 识别时发现图是歪的：把显示用的图也换成摆正后的版本 */
async function adoptRotatedDisplay(page, bitmap, rotation) {
  const canvas = rotateForDisplay(bitmap, rotation, 2000);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) return;

  const url = URL.createObjectURL(blob);
  const previous = page.url;
  page.url = url;

  if (page === currentPage()) {
    el.pageImg.src = url;
    try { await el.pageImg.decode(); } catch (_) { /* ignore */ }
  }
  if (previous && previous.startsWith('blob:') && previous !== page.originalUrl) {
    URL.revokeObjectURL(previous);
  }
}

/** 转回 0° 时，把显示图换回原图 */
function adoptOriginalDisplay(page) {
  const previous = page.url;
  if (!page.originalUrl || previous === page.originalUrl) return;
  page.url = page.originalUrl;
  if (page === currentPage()) el.pageImg.src = page.url;
  if (previous && previous !== page.originalUrl) URL.revokeObjectURL(previous);
}

/* ---------------- 渲染：图上词框 ---------------- */

function renderOverlay() {
  const page = currentPage();
  el.overlay.textContent = '';
  if (!page || !page.words.length) return;

  const frag = document.createDocumentFragment();
  for (const word of page.words) {
    const box = document.createElement('div');
    box.className = 'wbox';
    box.dataset.i = word.i;
    box.style.left = (word.x * 100).toFixed(3) + '%';
    box.style.top = (word.y * 100).toFixed(3) + '%';
    box.style.width = (word.w * 100).toFixed(3) + '%';
    box.style.height = (word.h * 100).toFixed(3) + '%';
    frag.appendChild(box);
  }
  el.overlay.appendChild(frag);
  paintSelection();
}

/* ---------------- 渲染：文本层 ---------------- */

function renderTextLayer() {
  const page = currentPage();
  el.textLayer.textContent = '';
  if (!page) return;

  const label = document.createElement('p');
  label.className = 'tl-label';
  label.textContent = `第 ${S.index + 1} 页 · ${page.name || ''}`;
  el.textLayer.appendChild(label);

  if (!page.words.length) {
    const note = document.createElement('p');
    note.textContent = page.status === 'ocr' ? '正在识别…' : '这一页没有识别到文字。';
    el.textLayer.appendChild(note);
    return;
  }

  const lines = page.lines.length ? page.lines : [page.words.map(w => w.i)];
  for (const line of lines) {
    const p = document.createElement('p');
    for (const idx of line) {
      const word = page.words[idx];
      if (!word) continue;
      const span = document.createElement('span');
      span.className = 'tok';
      span.dataset.i = idx;
      span.textContent = word.t;
      p.appendChild(span);
      p.appendChild(document.createTextNode(' '));
    }
    el.textLayer.appendChild(p);
  }
  paintSelection();
}

/* ---------------- 选区 ---------------- */

function tokenIndexAt(node) {
  if (!node || !node.closest) return -1;
  const holder = node.closest('[data-i]');
  if (!holder) return -1;
  if (!el.reader.contains(holder)) return -1;
  const value = Number(holder.dataset.i);
  return Number.isFinite(value) ? value : -1;
}

function jumpActive() {
  return S.jumpMode || S.ctrl;
}

/** 跳选模式下，新的一次划选是「继续加段」而不是「重新开始」 */
function shouldAppend() {
  return S.jumpMode && S.sel.segments.length > 0;
}

function selectionRanges() {
  return S.sel.segments
    .filter(seg => Number.isFinite(seg.a) && Number.isFinite(seg.b))
    .map(seg => [Math.min(seg.a, seg.b), Math.max(seg.a, seg.b)]);
}

function selectionIndices() {
  const out = [];
  const seen = new Set();
  for (const [a, b] of selectionRanges()) {
    for (let i = a; i <= b; i++) {
      if (!seen.has(i)) { seen.add(i); out.push(i); }
    }
  }
  return out;
}

let markedNodes = [];

function clearMarks() {
  for (const node of markedNodes) node.classList.remove('sel');
  markedNodes = [];
}

function paintSelection() {
  clearMarks();
  if (!S.sel.segments.length) return;
  const container = S.mode === 'text' ? el.textLayer : el.overlay;
  if (!container) return;
  for (const i of selectionIndices()) {
    const node = container.querySelector(`[data-i="${i}"]`);
    if (node) {
      node.classList.add('sel');
      markedNodes.push(node);
    }
  }
}

function startSelection(index, append = false) {
  if (index < 0) return;
  if (!append) S.sel.segments = [];
  S.selecting = true;
  S.sel.segments.push({ a: index, b: index });
  S.sel.last = index;
  document.body.classList.add('selecting');
  paintSelection();
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
}

/** 中途按下 Ctrl：从这里断开，后面选的归到新的一段 */
function breakSegment() {
  if (!S.selecting) return;
  S.sel.segments.push({ a: S.sel.last, b: S.sel.last });
  paintSelection();
}

function extendSelection(index) {
  if (index < 0) return;
  const seg = S.sel.segments[S.sel.segments.length - 1];
  if (seg) seg.b = index;
  else S.sel.segments.push({ a: index, b: index });
  S.sel.last = index;
  paintSelection();
}

function cancelSelection() {
  S.selecting = false;
  S.sel.segments = [];
  S.sel.last = -1;
  document.body.classList.remove('selecting');
  clearMarks();
}

function finishSelection() {
  const indices = selectionIndices();
  const page = currentPage();
  document.body.classList.remove('selecting');
  S.selecting = false;

  if (!indices.length || !page) { cancelSelection(); return; }

  const ranges = selectionRanges();
  const segments = ranges.map(([a, b]) =>
    indices.filter(i => i >= a && i <= b).map(i => page.words[i] && page.words[i].t).filter(Boolean).join(' ')
  );

  // 只选了一个词，且不是加选模式：当成点词处理
  if (indices.length === 1 && S.sel.segments.length === 1 && !S.jumpMode) {
    const only = page.words[indices[0]];
    cancelSelection();
    if (only) showWord(only.t);
    return;
  }

  showPhrase(segments, indices.length);
  // 选区不清空：跳选模式下还要继续往上加段
}

/* ---------------- 指针交互：点词 / 划选 / 缩放 ---------------- */

const pointers = new Map();
let gesture = null;
let longPressTimer = null;
let pinch = null;

el.reader.addEventListener('pointerdown', (event) => {
  if (event.target.closest('button, .chip, input, textarea')) return;

  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size === 2) {
    clearTimeout(longPressTimer);
    gesture = null;
    startPinch();
    return;
  }
  if (pointers.size > 2) return;

  const index = tokenIndexAt(event.target);
  gesture = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    t: performance.now(),
    index,
    moved: false,
    type: event.pointerType,
  };

  if (event.pointerType === 'touch' && index >= 0) {
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (!gesture || gesture.moved) return;
      startSelection(index, shouldAppend());
      if (el.reader.setPointerCapture) {
        try { el.reader.setPointerCapture(event.pointerId); } catch (_) {}
      }
    }, 430);
  }
});

window.addEventListener('pointermove', (event) => {
  if (pointers.has(event.pointerId)) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  if (pinch && pointers.size >= 2) {
    updatePinch();
    return;
  }

  if (!gesture || gesture.id !== event.pointerId) return;

  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  const dist = Math.hypot(dx, dy);

  if (S.selecting) {
    const index = tokenIndexAt(document.elementFromPoint(event.clientX, event.clientY));
    if (index >= 0) extendSelection(index);
    if (event.cancelable) event.preventDefault();
    return;
  }

  if (!gesture.moved && dist > 8) {
    gesture.moved = true;
    clearTimeout(longPressTimer);

    // 鼠标：直接从词上拖 = 划选；手指：交给长按，滑动用于翻看
    if (gesture.type === 'mouse' && gesture.index >= 0) {
      startSelection(gesture.index, shouldAppend());
      const index = tokenIndexAt(document.elementFromPoint(event.clientX, event.clientY));
      if (index >= 0) extendSelection(index);
    }
  }
}, { passive: false });

window.addEventListener('pointerup', (event) => {
  pointers.delete(event.pointerId);
  clearTimeout(longPressTimer);

  if (pinch) {
    if (pointers.size < 2) pinch = null;
    if (!gesture) return;
  }

  if (!gesture || gesture.id !== event.pointerId) {
    if (!pointers.size) gesture = null;
    return;
  }

  const wasSelecting = S.selecting;
  const moved = gesture.moved;
  const index = gesture.index;
  const elapsed = performance.now() - gesture.t;
  gesture = null;

  if (wasSelecting) {
    finishSelection();
    return;
  }

  if (!moved && index >= 0 && elapsed < 700) {
    const page = currentPage();
    const word = page && page.words[index];
    if (word) showWord(word.t);
  }
});

window.addEventListener('pointercancel', () => {
  pointers.clear();
  clearTimeout(longPressTimer);
  pinch = null;
  gesture = null;
  if (S.selecting) cancelSelection();
});

// 选择过程中阻止页面滚动
el.reader.addEventListener('touchmove', (event) => {
  if (S.selecting && event.cancelable) event.preventDefault();
}, { passive: false });

function startPinch() {
  if (pointers.size < 2) return;
  const pts = [...pointers.values()];
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  if (!d) return;
  pinch = {
    d0: d,
    z0: S.zoom,
    cx: (pts[0].x + pts[1].x) / 2,
    cy: (pts[0].y + pts[1].y) / 2,
    sl: el.viewport.scrollLeft,
    st: el.viewport.scrollTop,
  };
  document.body.classList.add('pinching');
}

function updatePinch() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return;
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  const rect = el.viewport.getBoundingClientRect();
  const fx = pinch.cx - rect.left;
  const fy = pinch.cy - rect.top;
  const next = clamp(pinch.z0 * (d / pinch.d0), 1, 5);
  const k = next / pinch.z0;
  S.zoom = next;
  applyZoom();
  el.viewport.scrollLeft = (pinch.sl + fx) * k - fx;
  el.viewport.scrollTop = (pinch.st + fy) * k - fy;
}

document.body.addEventListener('pointerup', () => {
  document.body.classList.remove('pinching');
});

window.addEventListener('wheel', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (el.viewport.hidden) return;
  event.preventDefault();
  const rect = el.viewport.getBoundingClientRect();
  const fx = event.clientX - rect.left;
  const fy = event.clientY - rect.top;
  const next = clamp(S.zoom * (event.deltaY < 0 ? 1.12 : 0.89), 1, 5);
  const k = next / S.zoom;
  S.zoom = next;
  applyZoom();
  el.viewport.scrollLeft = (el.viewport.scrollLeft + fx) * k - fx;
  el.viewport.scrollTop = (el.viewport.scrollTop + fy) * k - fy;
}, { passive: false });

/* ---------------- 面板：词条 ---------------- */

let panelOpenedAt = 0;

function openPanel() {
  if (!PHONE()) return;
  panelOpenedAt = Date.now();
  el.panel.classList.add('open');
  el.scrim.hidden = false;
}

function closePanel() {
  el.panel.classList.remove('open');
  el.scrim.hidden = true;
}

function setPanelContent(html) {
  el.panelEmpty.hidden = true;
  el.panelBody.innerHTML = html;
  el.panelScroll.scrollTop = 0;
}

const FORM_ORDER = ['p', 'd', 'i', '3', 's', 'r', 't'];

async function showWord(rawWord) {
  cancelSelection();
  openPanel();
  const seq = ++S.lookupSeq;
  setPanelContent(`<div class="placeholder-box">正在查 <b>${escapeHtml(rawWord)}</b> …</div>`);

  let result;
  try {
    result = await lookup(rawWord);
  } catch (err) {
    console.error(err);
    if (seq === S.lookupSeq) {
      const offline = navigator.onLine === false;
      const tip = offline
        ? '这个词所在的词库分片还没缓存过。<b>联网查一次</b>，之后断网也能查了。'
        : '词库文件读取失败。如果你刚断网，这个词可能还没缓存过，<b>联网再查一次</b>即可；' +
          '如果一直这样，请确认 <b>data/</b> 目录存在，并且页面是通过 http 打开的。';
      setPanelContent(`<div class="placeholder-box">${tip}</div>`);
    }
    return;
  }
  if (seq !== S.lookupSeq) return;
  if (!result) renderNotFound(rawWord, seq);
  else {
    renderEntry(result);
    recordWord(result);
  }
}

/* ---------------- 生词本 ---------------- */

function recordWord(result) {
  try {
    wordbook.add(result.entry, result.query);
    refreshWordbookBadge();
  } catch (_) { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
}

function refreshWordbookBadge() {
  let total = 0;
  try { total = wordbook.count(); } catch (_) { total = 0; }
  el.btnWordbook.hidden = total === 0;
  el.wbBadge.textContent = String(total);
}

function openWordbook() {
  renderWordbook();
  el.wordbook.hidden = false;
}

function closeWordbook() {
  el.wordbook.hidden = true;
}

function renderWordbook() {
  const items = wordbook.list();
  el.wbCount.textContent = `${items.length} 个词`;
  el.wbClear.disabled = items.length === 0;

  if (!items.length) {
    el.wbList.innerHTML =
      '<div class="wb-empty">生词本还是空的。<br>点看图上的任意单词，它会自动记到这里。</div>';
    return;
  }

  el.wbList.innerHTML = items.map(item => `
    <div class="wb-item">
      <button class="wb-word" data-lookup="${escapeHtml(item.w)}">${escapeHtml(item.w)}${item.p ? `<small>/${escapeHtml(item.p)}/</small>` : ''}</button>
      <button class="wb-del" data-del="${escapeHtml(item.w)}" aria-label="删除 ${escapeHtml(item.w)}">×</button>
      <span class="wb-mean">${escapeHtml(item.m || '（无释义）')}</span>
    </div>`).join('');
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

el.btnWordbook.addEventListener('click', openWordbook);
el.wbClose.addEventListener('click', closeWordbook);
el.wordbook.addEventListener('click', (event) => {
  if (event.target === el.wordbook) closeWordbook();
});

el.wbList.addEventListener('click', (event) => {
  const del = event.target.closest('[data-del]');
  if (del) {
    wordbook.remove(del.dataset.del);
    renderWordbook();
    refreshWordbookBadge();
    return;
  }
  const word = event.target.closest('[data-lookup]');
  if (word) {
    closeWordbook();
    showWord(word.dataset.lookup);
  }
});

el.wbExportCsv.addEventListener('click', () => {
  if (!wordbook.count()) return;
  downloadText('生词本.csv', wordbook.toCsv(), 'text/csv;charset=utf-8');
});

el.wbExportTsv.addEventListener('click', () => {
  if (!wordbook.count()) return;
  downloadText('生词本-anki.txt', wordbook.toTsv(), 'text/plain;charset=utf-8');
});

el.wbClear.addEventListener('click', () => {
  if (!wordbook.count()) return;
  if (!confirm('清空生词本？这个操作不能撤销。')) return;
  wordbook.clear();
  renderWordbook();
  refreshWordbookBadge();
});

async function renderNotFound(rawWord, seq) {
  setPanelContent(`
    <div class="card">
      <div class="entry-head">
        <h2 class="entry-word">${escapeHtml(rawWord)}</h2>
      </div>
      <div id="suggestBox"></div>
      <div class="placeholder-box">
        <b>词库没有收录这个词。</b><br>
        可能是人名、专有名词、生僻词，或者 OCR 把词拆错了／认错了。
        可以切到「文本模式」看看原文，或者点上面的相近词。
      </div>
    </div>`);

  let candidates = [];
  try {
    candidates = await suggest(rawWord);
  } catch (_) {
    candidates = [];
  }
  if (!candidates.length) return;

  const box = el.panelBody.querySelector('#suggestBox');
  if (!box) return;   // 这期间用户已经点了别的词
  if (typeof seq === 'number' && seq !== S.lookupSeq) return;

  box.innerHTML = `
    <div class="section-title">你是不是要找</div>
    <div class="suggest-list">
      ${candidates.map(word =>
        `<button class="mini-btn" data-lookup="${escapeHtml(word)}">${escapeHtml(word)}</button>`
      ).join('')}
    </div>`;
}

function renderEntry(result) {
  const entry = result.entry;
  const isForm = result.formLabel && result.query !== entry.word;

  // ECDICT 用 ":" 表示长音、"'" 表示重音、"," 表示次重音，转成国际音标符号
  const phoneticText = formatPhonetic(entry.phonetic);
  const phon = phoneticText
    ? `<span class="entry-phon">/${escapeHtml(phoneticText)}/</span>`
    : '';

  const banner = isForm
    ? `<div class="form-banner">
         <span>你点的是 <b>${escapeHtml(result.query)}</b><span class="arrow"> → </span>原形 <b>${escapeHtml(entry.word)}</b></span>
         <span>·</span>
         <span>${escapeHtml(result.formLabel)}</span>
       </div>`
    : (result.query !== entry.word
      ? `<div class="form-banner"><span><b>${escapeHtml(result.query)}</b><span class="arrow"> → </span>原形 <b>${escapeHtml(entry.word)}</b></span></div>`
      : '');

  const senses = entry.senses.length
    ? `<ul class="senses">${entry.senses.map(sense => `
        <li class="sense">
          ${sense.pos ? `<span class="pos">${escapeHtml(sense.pos)}</span>` : ''}
          <span class="sense-text">${escapeHtml(sense.text)}</span>
        </li>`).join('')}</ul>`
    : `<p class="empty-note">这个词只有音标，词库里没有中文释义。</p>`;

  // 同一组变形可能同时是多行（如 stopped 既是过去式又是过去分词），合并成一行
  const grouped = [];
  for (const code of FORM_ORDER) {
    const forms = (entry.forms[code] || []).filter(f => f.toLowerCase() !== entry.word);
    if (!forms.length) continue;
    const key = forms.join(',');
    const hit = grouped.find(g => g.key === key);
    if (hit) hit.labels.push(EXCHANGE_LABEL[code] || code);
    else grouped.push({ key, labels: [EXCHANGE_LABEL[code] || code], forms });
  }

  const formRows = grouped.map(group =>
    `<dt>${escapeHtml(group.labels.join(' / '))}</dt>
     <dd>${group.forms.map(f =>
       `<button class="form-link" data-lookup="${escapeHtml(f)}">${escapeHtml(f)}</button>`
     ).join('')}</dd>`
  ).join('');

  const formsBlock = formRows
    ? `<div class="section-title">变形</div><dl class="forms-grid">${formRows}</dl>`
    : `<div class="section-title">变形</div>
       <p class="empty-note">这个词没有屈折变化，或词库未收录它的变形。</p>`;

  setPanelContent(`
    <div class="card">
      <div class="entry-head">
        <h2 class="entry-word">${escapeHtml(entry.word)}</h2>
        ${phon}
        <button class="speak" data-say="${escapeHtml(entry.word)}" title="朗读">♪</button>
      </div>
      ${banner}
      ${senses}
      ${formsBlock}
    </div>`);
}

/* ---------------- 面板：选区 ---------------- */

function showPhrase(segments, wordCount) {
  openPanel();
  S.lookupSeq++;
  const textHtml = segments
    .map(seg => escapeHtml(seg))
    .join('<span class="gap"> … </span>');
  const copyText = segments.join(' … ');
  const translateText = segments.join(' ');

  setPanelContent(`
    <div class="card">
      <div class="sel-head">
        <span class="sel-title">选区</span>
        <span class="sel-actions">
          <button class="mini-btn primary" data-act="translate" data-text="${escapeHtml(translateText)}">翻译</button>
          <button class="mini-btn" data-act="copy" data-text="${escapeHtml(copyText)}">复制</button>
          <button class="mini-btn" data-act="clear">取消</button>
        </span>
      </div>
      <div class="sel-text">${textHtml}</div>
      <div class="sel-meta">${segments.length} 段 · ${wordCount} 个词</div>
      <div id="transResult"></div>
      <div class="placeholder-box">
        <b>句子结构解析</b><br>
        拆主谓宾、标从句类型、判时态——这部分还需要接语言模型，当前版本先留位置。
      </div>
    </div>`);
}

/* ---------------- 面板事件 ---------------- */

el.panelBody.addEventListener('click', async (event) => {
  const speakBtn = event.target.closest('[data-say]');
  if (speakBtn) {
    speak(speakBtn.dataset.say);
    return;
  }

  const lookupBtn = event.target.closest('[data-lookup]');
  if (lookupBtn) {
    showWord(lookupBtn.dataset.lookup);
    return;
  }

  const action = event.target.closest('[data-act]');
  if (action) {
    if (action.dataset.act === 'translate') {
      runTranslation(action);
      return;
    }
    if (action.dataset.act === 'copy') {
      const text = action.dataset.text || '';
      try {
        await navigator.clipboard.writeText(text);
        action.textContent = '已复制';
        setTimeout(() => { action.textContent = '复制'; }, 1200);
      } catch (_) {
        action.textContent = '复制失败';
      }
    } else if (action.dataset.act === 'clear') {
      cancelSelection();
      el.panelEmpty.hidden = false;
      el.panelBody.innerHTML = '';
      if (PHONE()) closePanel();
    }
  }
});

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = 0.92;
    window.speechSynthesis.speak(utter);
  } catch (_) { /* ignore */ }
}

/* ---------------- 选区翻译 ---------------- */

async function runTranslation(button) {
  const text = button.dataset.text || '';
  const box = el.panelBody.querySelector('#transResult');
  if (!box) return;

  button.disabled = true;
  button.textContent = '翻译中…';
  box.innerHTML =
    '<div class="trans-block"><span class="trans-label">译文</span>' +
    '<p class="translation-text trans-pending">正在翻译…</p></div>';

  try {
    const result = await translate(text);
    box.innerHTML =
      `<div class="trans-block">
         <span class="trans-label">译文${result.cached ? ' · 来自缓存' : ''}</span>
         <p class="translation-text">${escapeHtml(result.text)}</p>
         <p class="trans-meta">MyMemory 机器翻译 · 仅供参考</p>
       </div>`;
    button.textContent = '重新翻译';
  } catch (err) {
    console.error(err);
    box.innerHTML = `<div class="trans-block"><p class="translation-text trans-error">${translateErrorText(err)}</p></div>`;
    button.textContent = '重试';
  } finally {
    button.disabled = false;
  }
}

function translateErrorText(err) {
  if (navigator.onLine === false) return '现在没有网络。翻译需要联网，查词和 OCR 不受影响。';
  if (err && err.name === 'AbortError') return '翻译超时了，稍后再试一次。';
  const raw = err && err.message ? String(err.message) : '未知错误';
  return '翻译没成功：' + escapeHtml(raw) + '。如果是网络受限，这个免费接口可能连不上。';
}

/* ---------------- 顶栏 / 翻页 ---------------- */

el.btnAdd.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});

el.btnClear.addEventListener('click', () => {
  if (!confirm('清空所有图片？')) return;
  for (const page of S.pages) {
    URL.revokeObjectURL(page.url);
    if (page.originalUrl && page.originalUrl !== page.url) URL.revokeObjectURL(page.originalUrl);
  }
  S.pages = [];
  S.index = 0;
  S.zoom = 1;
  cancelSelection();
  el.panelEmpty.hidden = false;
  el.panelBody.innerHTML = '';
  showEmpty();
});

el.prevPage.addEventListener('click', () => goPage(-1));
el.nextPage.addEventListener('click', () => goPage(1));

el.rotateBtn.addEventListener('click', () => {
  const page = currentPage();
  if (!page || page.status === 'ocr') return;
  page.manualRotation = ((page.manualRotation || 0) + 90) % 360;
  page.words = [];
  page.lines = [];
  page.bitmap = null;
  page.status = 'new';
  processQueue();
});

async function goPage(delta) {
  const next = clamp(S.index + delta, 0, S.pages.length - 1);
  if (next === S.index) return;
  S.index = next;
  S.zoom = 1;
  cancelSelection();
  await renderPage();
  // 换页后回到顶部，否则上一页的滚动位置会把词框顶出画面
  el.viewport.scrollTop = 0;
  el.viewport.scrollLeft = 0;
  el.textLayer.scrollTop = 0;
  updateChrome();
}

function updateChrome() {
  const page = currentPage();
  const total = S.pages.length;

  el.prevPage.disabled = !total || S.index <= 0;
  el.nextPage.disabled = !total || S.index >= total - 1;
  el.rotateBtn.disabled = !page || page.status === 'ocr';

  if (!total) {
    el.pageInfo.textContent = '';
    return;
  }

  const status = page && page.status === 'ocr' ? ' · 识别中'
    : page && page.status === 'error' ? ' · 识别失败'
    : '';

  el.pageInfo.textContent = `${S.index + 1} / ${total}${status}`;
  el.modeToggle.textContent = S.mode === 'image' ? '文本模式' : '图片模式';
  el.jumpToggle.setAttribute('aria-pressed', String(S.jumpMode));
  el.jumpToggle.textContent = S.jumpMode ? '跳选：开' : '跳选：关';
}

el.modeToggle.addEventListener('click', () => {
  S.mode = S.mode === 'image' ? 'text' : 'image';
  S.zoom = 1;
  renderPage();
  updateChrome();
});

el.jumpToggle.addEventListener('click', () => {
  S.jumpMode = !S.jumpMode;
  updateChrome();
});

el.panelHandle.addEventListener('click', closePanel);
// 遮罩是跟着点词那一刻出现的，浏览器随后补发的 click 会落在它身上，短暂忽略
el.scrim.addEventListener('click', () => {
  if (Date.now() - panelOpenedAt > 400) closePanel();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Control') {
    if (!S.ctrl) {
      S.ctrl = true;
      if (S.selecting) breakSegment();
    }
  }
  if (event.target.matches('input, textarea')) return;

  if (event.key === 'ArrowLeft') goPage(-1);
  if (event.key === 'ArrowRight') goPage(1);
  if (event.key === 'Escape') {
    if (!el.wordbook.hidden) { closeWordbook(); return; }
    cancelSelection();
    closePanel();
  }
});

document.addEventListener('keyup', (event) => {
  if (event.key === 'Control') S.ctrl = false;
});

window.addEventListener('blur', () => { S.ctrl = false; });

/* ---------------- 拖拽导入 / 尺寸 ---------------- */

['dragenter', 'dragover'].forEach(type => {
  window.addEventListener(type, (event) => {
    event.preventDefault();
    document.body.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach(type => {
  window.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'drop') {
      document.body.classList.remove('dragging');
      if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
    } else if (event.target === document.documentElement) {
      document.body.classList.remove('dragging');
    }
  });
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!el.viewport.hidden) { computeFit(); }
  }, 150);
});

/* ---------------- 忙碌遮罩 ---------------- */

function showBusy(text) {
  el.busyText.textContent = text;
  el.busyBar.style.width = '0%';
  el.busy.hidden = false;
}

function setBusyProgress(ratio) {
  el.busyBar.style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
}

function hideBusy() {
  el.busy.hidden = true;
}

/* ---------------- 启动 ---------------- */

warmup();
updateChrome();
refreshWordbookBadge();

// 调试/自测钩子（只读引用，不影响正常使用）
window.__reader = {
  state: S,
  showWord,
  goPage,
  renderPage,
  startSelection,
  extendSelection,
  finishSelection,
  setJumpMode: (on) => { S.jumpMode = !!on; updateChrome(); },
  wordbook: {
    count: wordbook.count,
    list: wordbook.list,
    clear: wordbook.clear,
    csv: wordbook.toCsv,
    tsv: wordbook.toTsv,
    open: openWordbook,
  },
};
