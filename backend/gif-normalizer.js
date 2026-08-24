'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const TARGET_SIZE = 120;
const PADDING = 7;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 2048;
const MAX_FRAMES = 180;
const MAX_DECODED_PIXELS = 36 * 1024 * 1024;
const MAX_DURATION_MS = 60 * 1000;
const BG_TOLERANCE = 54;
const MIN_BACKGROUND_DOMINANCE = 0.62;

class GifImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GifImportError';
    this.code = code;
  }
}

function assertGifHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) throw new GifImportError('invalid-gif', '文件不是有效的 GIF');
  const header = buffer.subarray(0, 6).toString('ascii');
  if (header !== 'GIF87a' && header !== 'GIF89a') throw new GifImportError('invalid-gif', '请选择 GIF87a 或 GIF89a 文件');
}

function clampDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 80;
  return Math.max(20, Math.min(5000, Math.round(n)));
}

function frameDelays(metadata, pages) {
  const source = Array.isArray(metadata.delay) ? metadata.delay : [];
  const delays = Array.from({ length: pages }, (_, index) => clampDelay(source[index] ?? source[source.length - 1] ?? 80));
  const total = delays.reduce((sum, delay) => sum + delay, 0);
  if (total > MAX_DURATION_MS) throw new GifImportError('duration-limit', 'GIF 单次循环不能超过 60 秒');
  return delays;
}

function borderSamples(data, width, height, pages) {
  const samples = [];
  const stride = width * height * 4;
  const step = Math.max(1, Math.ceil((2 * width + 2 * height) * pages / 24000));
  const add = (offset) => {
    if (data[offset + 3] < 250) return;
    samples.push([data[offset], data[offset + 1], data[offset + 2]]);
  };
  for (let page = 0; page < pages; page++) {
    const base = page * stride;
    for (let x = 0; x < width; x += step) {
      add(base + x * 4);
      add(base + ((height - 1) * width + x) * 4);
    }
    for (let y = 0; y < height; y += step) {
      add(base + y * width * 4);
      add(base + (y * width + width - 1) * 4);
    }
  }
  return samples;
}

function detectBackground(data, width, height, pages) {
  const samples = borderSamples(data, width, height, pages);
  if (!samples.length) return null;
  const buckets = new Map();
  for (const rgb of samples) {
    const key = `${rgb[0] >> 4},${rgb[1] >> 4},${rgb[2] >> 4}`;
    let item = buckets.get(key);
    if (!item) { item = { count: 0, r: 0, g: 0, b: 0 }; buckets.set(key, item); }
    item.count++;
    item.r += rgb[0]; item.g += rgb[1]; item.b += rgb[2];
  }
  const winner = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
  const candidate = [Math.round(winner.r / winner.count), Math.round(winner.g / winner.count), Math.round(winner.b / winner.count)];
  let close = 0;
  for (const rgb of samples) {
    const distance = Math.abs(rgb[0] - candidate[0]) + Math.abs(rgb[1] - candidate[1]) + Math.abs(rgb[2] - candidate[2]);
    if (distance <= BG_TOLERANCE) close++;
  }
  const dominance = close / samples.length;
  return dominance >= MIN_BACKGROUND_DOMINANCE ? { rgb: candidate, dominance } : null;
}

function similarAt(data, offset, bg) {
  return Math.abs(data[offset] - bg[0]) + Math.abs(data[offset + 1] - bg[1]) + Math.abs(data[offset + 2] - bg[2]) <= BG_TOLERANCE;
}

function removeConnectedBackground(data, width, height, pages, bg) {
  const pixels = width * height;
  const stride = pixels * 4;
  let removed = 0;
  for (let page = 0; page < pages; page++) {
    const base = page * stride;
    const seen = new Uint8Array(pixels);
    const queue = new Int32Array(pixels);
    let head = 0, tail = 0;
    const push = (index) => {
      if (seen[index]) return;
      const offset = base + index * 4;
      if (data[offset + 3] < 250 || !similarAt(data, offset, bg)) return;
      seen[index] = 1;
      queue[tail++] = index;
    };
    for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      const offset = base + index * 4;
      data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0; data[offset + 3] = 0;
      removed++;
      if (x > 0) push(index - 1);
      if (x + 1 < width) push(index + 1);
      if (y > 0) push(index - width);
      if (y + 1 < height) push(index + width);
    }
  }
  return removed;
}

function alphaStats(data) {
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent++;
  return { transparent, ratio: transparent / Math.max(1, data.length / 4) };
}

function unionBounds(data, width, height, pages) {
  const stride = width * height * 4;
  let left = width, top = height, right = -1, bottom = -1;
  for (let page = 0; page < pages; page++) {
    const base = page * stride;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[base + (y * width + x) * 4 + 3] < 16) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left || bottom < top) throw new GifImportError('empty-gif', 'GIF 中没有可见内容');
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function cropFrame(data, frameOffset, sourceWidth, bounds) {
  const out = Buffer.alloc(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) {
    const from = frameOffset + ((bounds.top + y) * sourceWidth + bounds.left) * 4;
    const to = y * bounds.width * 4;
    data.copy(out, to, from, from + bounds.width * 4);
  }
  return out;
}

function placeFrame(target, resized, width, height, left, top) {
  for (let y = 0; y < height; y++) {
    const from = y * width * 4;
    const to = ((top + y) * TARGET_SIZE + left) * 4;
    resized.copy(target, to, from, from + width * 4);
  }
  for (let i = 3; i < target.length; i += 4) {
    if (target[i] < 96) {
      target[i - 3] = 0; target[i - 2] = 0; target[i - 1] = 0; target[i] = 0;
    } else {
      target[i] = 255;
    }
  }
}

async function normalizeGif(sourcePath, options = {}) {
  let stat;
  try { stat = fs.statSync(sourcePath); }
  catch { throw new GifImportError('source-missing', '找不到所选 GIF，请重新选择'); }
  if (!stat.isFile()) throw new GifImportError('not-file', '请选择一个 GIF 文件');
  if (stat.size > MAX_FILE_BYTES) throw new GifImportError('file-limit', 'GIF 文件不能超过 12 MB');
  const header = Buffer.alloc(10);
  let fd;
  try {
    fd = fs.openSync(sourcePath, 'r');
    fs.readSync(fd, header, 0, header.length, 0);
  } catch {
    throw new GifImportError('read-failed', '无法读取所选 GIF，请检查文件权限');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  assertGifHeader(header);

  let metadata;
  try {
    metadata = await sharp(sourcePath, { animated: true, failOn: 'warning', limitInputPixels: MAX_DECODED_PIXELS }).metadata();
  } catch {
    throw new GifImportError('decode-failed', 'GIF 解码失败，文件可能已损坏或使用了不兼容的编码');
  }
  const width = Number(metadata.width);
  const height = Number(metadata.pageHeight || metadata.height);
  const pages = Number(metadata.pages || 1);
  if (metadata.format !== 'gif' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new GifImportError('invalid-gif', '文件不是有效的 GIF 动画');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new GifImportError('dimension-limit', 'GIF 画布不能超过 2048×2048');
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_FRAMES) throw new GifImportError('frame-limit', `GIF 帧数不能超过 ${MAX_FRAMES}`);
  if (width * height * pages > MAX_DECODED_PIXELS) throw new GifImportError('pixel-limit', 'GIF 解码后的总像素过大');
  const delays = frameDelays(metadata, pages);

  let decoded;
  try {
    decoded = await sharp(sourcePath, { animated: true, failOn: 'warning', limitInputPixels: MAX_DECODED_PIXELS })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    throw new GifImportError('decode-failed', 'GIF 帧读取失败，文件可能已损坏');
  }
  const data = Buffer.from(decoded.data);
  const before = alphaStats(data);
  let backgroundMode = before.transparent ? 'preserved-transparency' : 'kept-opaque';
  let backgroundDominance = null;
  if (!before.transparent && options.removeBackground !== false) {
    const detected = detectBackground(data, width, height, pages);
    if (detected) {
      const removed = removeConnectedBackground(data, width, height, pages, detected.rgb);
      if (removed > 0) {
        backgroundMode = 'removed-solid';
        backgroundDominance = detected.dominance;
      }
    }
  }

  const bounds = unionBounds(data, width, height, pages);
  const available = TARGET_SIZE - PADDING * 2;
  const scale = Math.min(available / bounds.width, available / bounds.height);
  const targetWidth = Math.max(1, Math.min(available, Math.round(bounds.width * scale)));
  const targetHeight = Math.max(1, Math.min(available, Math.round(bounds.height * scale)));
  const left = Math.floor((TARGET_SIZE - targetWidth) / 2);
  const top = TARGET_SIZE - PADDING - targetHeight;
  const frameStride = width * height * 4;
  const outputFrames = [];
  for (let page = 0; page < pages; page++) {
    const cropped = cropFrame(data, page * frameStride, width, bounds);
    const resized = await sharp(cropped, { raw: { width: bounds.width, height: bounds.height, channels: 4 } })
      .resize(targetWidth, targetHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .raw().toBuffer();
    const target = Buffer.alloc(TARGET_SIZE * TARGET_SIZE * 4);
    placeFrame(target, resized, targetWidth, targetHeight, left, top);
    outputFrames.push(target);
  }

  let encoded;
  try {
    encoded = await sharp(Buffer.concat(outputFrames), {
      raw: { width: TARGET_SIZE, height: TARGET_SIZE * pages, channels: 4, pageHeight: TARGET_SIZE },
    }).gif({
      loop: Number.isInteger(metadata.loop) ? metadata.loop : 0,
      delay: delays,
      colours: 256,
      effort: 7,
      dither: 0.75,
      keepDuplicateFrames: true,
    }).toBuffer();
  } catch {
    throw new GifImportError('encode-failed', 'GIF 适配失败，请换一个文件重试');
  }
  if (encoded.length > MAX_OUTPUT_BYTES) throw new GifImportError('output-limit', '适配后的 GIF 仍超过 10 MB，请减少帧数或时长');
  const warnings = [];
  if (backgroundMode === 'kept-opaque') warnings.push('背景较复杂，已保留原背景，避免误删主体');
  if (pages === 1) warnings.push('这是单帧 GIF，将作为静态表情播放');
  return {
    buffer: encoded,
    warnings,
    meta: {
      originalName: path.basename(sourcePath),
      sourceWidth: width,
      sourceHeight: height,
      width: TARGET_SIZE,
      height: TARGET_SIZE,
      frames: pages,
      durationMs: delays.reduce((sum, delay) => sum + delay, 0),
      backgroundMode,
      backgroundDominance,
      sourceBytes: stat.size,
      outputBytes: encoded.length,
    },
  };
}

module.exports = {
  TARGET_SIZE,
  MAX_FILE_BYTES,
  MAX_FRAMES,
  GifImportError,
  normalizeGif,
  assertGifHeader,
};
