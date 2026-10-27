/* ============================================================
   OCR 封装
   - 全部本地：worker / wasm / 语言包都在 vendor/ 下，不依赖 CDN
   - 识别前做灰度 + 对比度拉伸，专门对付手机拍纸页的阴影
   - 结果用 TSV 解析，拿到每个词的包围盒（跨版本最稳）
   ============================================================ */

const CFG = {
  workerPath: 'vendor/tesseract/worker.min.js',
  corePath: 'vendor/tesseract/core',
  langPath: 'vendor/tesseract/lang',
  // 识别分辨率上限：越高越准、越慢（可用 window.__OCR_MAX_WIDTH 覆盖，方便调参）
  maxWidth: (typeof window !== 'undefined' && window.__OCR_MAX_WIDTH) || 2400,
  // 太小的图片放大后再识别。实测把 1279px 的卷子照片放大到 2200px，
  // 置信度 85.8→89.1、词库命中 94.2%→95.5%，值得多花 1.5 秒。
  minWidth: (typeof window !== 'undefined' && window.__OCR_MIN_WIDTH) || 2200,
};

let workerPromise = null;
let progressHandler = null;

function makeWorker() {
  if (workerPromise) return workerPromise;

  workerPromise = window.Tesseract.createWorker('eng', 1, {
    workerPath: CFG.workerPath,
    corePath: CFG.corePath,
    langPath: CFG.langPath,
    workerBlobURL: false,
    logger: msg => {
      if (progressHandler && typeof msg.progress === 'number') {
        progressHandler(msg.status || '', msg.progress);
      }
    },
  }).then(async (worker) => {
    // 版面分析模式：3=全自动（默认），4=单列文本，6=单个文本块
    const psm = (typeof window !== 'undefined' && window.__OCR_PSM) || 0;
    if (psm) {
      try { await worker.setParameters({ tessedit_pageseg_mode: String(psm) }); } catch (_) {}
    }
    return worker;
  }).catch(err => {
    workerPromise = null;
    throw err;
  });

  return workerPromise;
}

/** 提前把 worker 拉起来（首次识别能快一点） */
export function warmup() {
  makeWorker().catch(() => {});
}

/** 用大半径模糊估出背景亮度并减掉它，抹平光照不均 */
function subtractBackdrop(canvas, ctx, img) {
  const width = canvas.width;
  const height = canvas.height;
  const radius = Math.max(12, Math.round(width / 32));

  const backdropCanvas = document.createElement('canvas');
  backdropCanvas.width = width;
  backdropCanvas.height = height;
  const bctx = backdropCanvas.getContext('2d', { willReadFrequently: true });
  if (!('filter' in bctx)) return;

  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(canvas, 0, 0);
  bctx.filter = 'none';
  const backdrop = bctx.getImageData(0, 0, width, height).data;

  const data = img.data;
  // 1.25 是扫参得到的：再大反而会削掉细笔画
  const gain = (typeof window !== 'undefined' && window.__OCR_GAIN) || 1.25;
  for (let i = 0; i < data.length; i += 4) {
    const value = 128 + (data[i] - backdrop[i]) * gain;
    const clamped = value < 0 ? 0 : value > 255 ? 255 : value;
    data[i] = data[i + 1] = data[i + 2] = clamped;
  }
  ctx.putImageData(img, 0, 0);
}

/** 把图片画到 canvas，并做对比度拉伸预处理 */
export function prepare(bitmap) {
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  let targetW = srcW;
  if (srcW > CFG.maxWidth) targetW = CFG.maxWidth;
  else if (srcW < CFG.minWidth) targetW = Math.min(CFG.minWidth, srcW * 3);
  const scale = targetW / srcW;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const hist = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 4) {
    const gray = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    data[i] = data[i + 1] = data[i + 2] = gray;
    hist[gray]++;
  }
  ctx.putImageData(img, 0, 0);

  // 拍书页最常见的问题是「一半亮一半暗」。先用大半径模糊估出背景亮度，
  // 减掉它，只留下笔画——这一步对强阴影的样本效果最明显。
  const mode = (typeof window !== 'undefined' && window.__OCR_PREPROCESS) || 'local';
  if (mode === 'local') {
    try {
      subtractBackdrop(canvas, ctx, img);
    } catch (_) { /* 浏览器不支持滤镜就算了，退回全局拉伸 */ }
  }

  // 取 2% / 98% 分位做黑场白场，抵消阴影和灰底
  hist.fill(0);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;

  const total = canvas.width * canvas.height;
  const lowCut = total * 0.02;
  const highCut = total * 0.98;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= lowCut) { lo = v; break; }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= highCut) { hi = v; break; }
  }
  if (hi - lo < 12) { lo = 0; hi = 255; }
  const span = hi - lo;

  for (let i = 0; i < data.length; i += 4) {
    const v = ((data[i] - lo) * 255) / span;
    const clamped = v < 0 ? 0 : v > 255 ? 255 : v;
    data[i] = data[i + 1] = data[i + 2] = clamped;
  }
  ctx.putImageData(img, 0, 0);

  return canvas;
}

/** TSV -> 词列表（坐标归一化到 0..1） */
function parseTsv(tsv, width, height) {
  const lineMap = new Map();
  if (!tsv) return { words: [], lines: [] };

  const rows = tsv.split('\n');
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r].split('\t');
    if (cols.length < 12) continue;
    if (cols[0] !== '5') continue;

    const text = (cols[11] || '').trim();
    if (!text) continue;
    if (!/[A-Za-z0-9]/.test(text)) continue;

    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const w = Number(cols[8]);
    const h = Number(cols[9]);
    if (!Number.isFinite(left) || !Number.isFinite(top) || w <= 0 || h <= 0) continue;

    const conf = Number(cols[10]);
    const lineKey = cols[1] + ':' + cols[2] + ':' + cols[3] + ':' + cols[4];

    if (!lineMap.has(lineKey)) lineMap.set(lineKey, []);
    lineMap.get(lineKey).push({
      t: text,
      x: left / width,
      y: top / height,
      w: w / width,
      h: h / height,
      c: Number.isFinite(conf) ? conf : 0,
    });
  }

  // tesseract 有时把缩写拆到不同 block，所以这里按几何位置合并，不依赖行分组
  const flat = [];
  for (const [lineKey, tokens] of lineMap) {
    for (const token of tokens) flat.push(Object.assign(token, { lineKey }));
  }

  const merged = mergeApostrophes(flat);

  // 用 tesseract 自己的行分组。曾经试过按几何位置重建行来纠正顺序，
  // 但真实书页有轻微倾斜，同一行左右两端 y 不同，重建反而把顺序搞乱，已回退。
  const words = [];
  const linesByKey = new Map();
  for (const token of merged) {
    const index = words.length;
    token.i = index;
    words.push(token);
    if (!linesByKey.has(token.lineKey)) linesByKey.set(token.lineKey, []);
    linesByKey.get(token.lineKey).push(index);
  }
  const lines = [...linesByKey.values()].filter(line => line.length);

  return { words, lines };
}

/** 重叠率：两个框在垂直方向上的重合程度 */
function verticalOverlap(a, b) {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = bottom - top;
  const minH = Math.min(a.h, b.h) || 1;
  return overlap / minH;
}

function mergeApostrophes(tokens) {
  const out = [];
  for (const word of tokens) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = word.x - (prev.x + prev.w);
      const startsApos = /^['\u2019\u2018]/.test(word.t);
      const endsApos = /['\u2019\u2018]$/.test(prev.t);
      const sameLine = verticalOverlap(prev, word) > 0.5;
      const tight = gap <= Math.max(prev.h, word.h) * 0.45;
      if ((startsApos || endsApos) && sameLine && tight) {
        const right = Math.max(prev.x + prev.w, word.x + word.w);
        const bottom = Math.max(prev.y + prev.h, word.y + word.h);
        prev.t = joinPair(prev.t, word.t);
        prev.w = right - prev.x;
        prev.y = Math.min(prev.y, word.y);
        prev.h = bottom - prev.y;
        prev.c = Math.min(prev.c, word.c);
        continue;
      }
    }
    out.push(word);
  }
  return out;
}

/** 拼接两段被切开的词，顺带处理引号和重复字母 */
function joinPair(left, right) {
  if (/^n['\u2018\u2019]t$/i.test(right)) {
    // 左边词尾可能是被误识成引号的撇号，先摘掉
    const head = left.replace(/['\u2018\u2019]+$/, '');
    // wasn + n't -> wasn't（两边各有一个 n）；Did + n't -> Didn't
    return /n$/i.test(head) ? head + right.slice(1) : head + right;
  }
  // don' + 't：两边各带一个引号，去掉一个
  if (/['\u2018\u2019]$/.test(left) && /^['\u2018\u2019]/.test(right)) {
    return left + right.slice(1);
  }
  return (left + right).replace(/['\u2018\u2019]{2,}/g, "'");
}

/** 顺时针旋转画布（90 的倍数） */
export function rotateCanvas(source, deg) {
  const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  if (d === 0) return source;

  const swap = d === 90 || d === 270;
  const width = swap ? source.height : source.width;
  const height = swap ? source.width : source.height;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.translate(width / 2, height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return out;
}

function downscaleCanvas(source, maxWidth) {
  if (source.width <= maxWidth) return source;
  const scale = maxWidth / source.width;
  const out = document.createElement('canvas');
  out.width = Math.round(source.width * scale);
  out.height = Math.round(source.height * scale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/**
 * 判断图片需要顺时针转多少度才能把文字摆正。
 * 做法：四个朝向各在小图上识别一次，用「置信度 × √词数」打分，取最高者。
 * 歪着的文字识别结果会明显又少又差，这个分数区分度很大。
 */
export async function detectUprightRotation(canvas) {
  const worker = await makeWorker();
  const small = downscaleCanvas(canvas, 640);

  let best = { deg: 0, score: -1 };
  for (const deg of [0, 90, 180, 270]) {
    const candidate = deg === 0 ? small : rotateCanvas(small, deg);
    try {
      const { data } = await worker.recognize(candidate, {}, { text: true });
      const words = String(data.text || '').trim().split(/\s+/).filter(w => /[A-Za-z]{2,}/.test(w)).length;
      const conf = Number(data.confidence) || 0;
      const score = conf * Math.sqrt(Math.max(1, words));
      if (score > best.score) best = { deg, score };
    } catch (_) { /* 单个朝向失败不影响 */ }
  }
  return best.score > 0 ? best.deg : 0;
}

/** 把原图（彩色）旋转成用于显示的画布，顺带限一下尺寸 */
export function rotateForDisplay(bitmap, deg, maxWidth = 2000) {
  const scale = Math.min(1, maxWidth / bitmap.width);
  const base = document.createElement('canvas');
  base.width = Math.round(bitmap.width * scale);
  base.height = Math.round(bitmap.height * scale);
  const ctx = base.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, base.width, base.height);
  return rotateCanvas(base, deg);
}

/**
 * 识别结果的可信度评分：平均置信度 × √词数。
 * 方向不对时这个分数会塌到几百以下，方向正确时通常在 800 以上。
 */
export function resultScore(result) {
  const words = (result && result.words) || [];
  if (!words.length) return 0;
  const meanConf = words.reduce((sum, w) => sum + (w.c || 0), 0) / words.length;
  return meanConf * Math.sqrt(words.length);
}

/**
 * 识别一张已经预处理好的 canvas。
 * @returns {Promise<{words:Array, lines:Array, text:string}>}
 */
export async function recognize(canvas, onProgress) {
  const worker = await makeWorker();
  progressHandler = onProgress || null;

  const { data } = await worker.recognize(canvas, {}, { text: true, tsv: true });
  progressHandler = null;

  const { words, lines } = parseTsv(data.tsv, canvas.width, canvas.height);
  return { words, lines, text: data.text || '' };
}

export async function terminate() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch (_) { /* ignore */ }
  workerPromise = null;
}
