'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { STATE_DIR } = require('./paths');
const REGISTRY = require('../shared/pet-assets');
const { normalizeGif, GifImportError } = require('./gif-normalizer');

const MANIFEST_VERSION = 1;
const MAX_CUSTOM_PER_SLOT = 20;

function cloneDefaultManifest() { return { version: MANIFEST_VERSION, slots: {} }; }
function isAssetId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function safeName(value) {
  if (typeof value !== 'string') return '自定义表情.gif';
  const name = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim();
  return (name || '自定义表情.gif').slice(0, 120);
}

function sanitizeRecord(value) {
  if (!value || typeof value !== 'object' || !isAssetId(value.id)) return null;
  if (value.file !== `${value.id}.gif`) return null;
  return {
    id: value.id,
    file: value.file,
    originalName: safeName(value.originalName),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    meta: value.meta && typeof value.meta === 'object' ? {
      sourceWidth: Number(value.meta.sourceWidth) || 0,
      sourceHeight: Number(value.meta.sourceHeight) || 0,
      width: Number(value.meta.width) || 120,
      height: Number(value.meta.height) || 120,
      frames: Number(value.meta.frames) || 1,
      durationMs: Number(value.meta.durationMs) || 0,
      backgroundMode: typeof value.meta.backgroundMode === 'string' ? value.meta.backgroundMode : 'unknown',
      sourceBytes: Number(value.meta.sourceBytes) || 0,
      outputBytes: Number(value.meta.outputBytes) || 0,
    } : null,
  };
}

function sanitizeManifest(value) {
  const out = cloneDefaultManifest();
  if (!value || typeof value !== 'object' || !value.slots || typeof value.slots !== 'object') return out;
  for (const slotId of REGISTRY.SLOT_IDS) {
    const source = value.slots[slotId];
    if (!source || typeof source !== 'object' || !Array.isArray(source.assets)) continue;
    const assets = source.assets.map(sanitizeRecord).filter(Boolean).slice(0, MAX_CUSTOM_PER_SLOT);
    if (!assets.length) continue;
    out.slots[slotId] = {
      mode: source.mode === 'replace' ? 'replace' : 'append',
      assets,
    };
  }
  return out;
}

class PetAssetStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(STATE_DIR, 'pet-assets');
    this.assetsDir = path.join(this.rootDir, 'assets');
    this.manifestPath = path.join(this.rootDir, 'manifest.json');
    this.normalizer = options.normalizer || normalizeGif;
  }

  readManifest() {
    try { return sanitizeManifest(JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'))); }
    catch { return cloneDefaultManifest(); }
  }

  writeManifest(manifest) {
    const clean = sanitizeManifest(manifest);
    fs.mkdirSync(this.rootDir, { recursive: true });
    const temp = path.join(this.rootDir, `.manifest.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(clean, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.manifestPath);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
    try { fs.chmodSync(this.manifestPath, 0o600); } catch {}
    return clean;
  }

  customRef(record) {
    return {
      id: record.id,
      kind: 'custom',
      name: record.originalName,
      createdAt: record.createdAt,
      meta: record.meta,
      url: `workmeow-asset://asset/${record.id}.gif?v=${encodeURIComponent(record.createdAt)}`,
    };
  }

  catalog(manifest = this.readManifest()) {
    const slots = {};
    for (const slot of REGISTRY.SLOTS) {
      const saved = manifest.slots[slot.id];
      const custom = saved ? saved.assets.map((record) => this.customRef(record)) : [];
      const builtins = slot.defaultFiles.map((file) => ({
        id: `builtin:${file}`,
        kind: 'builtin',
        name: file,
        url: `../assets/cat/${file}`,
      }));
      const replace = !!(saved && saved.mode === 'replace' && custom.length);
      slots[slot.id] = {
        id: slot.id,
        mode: replace ? 'replace' : custom.length ? 'append' : 'default',
        usingDefaults: !replace,
        active: replace ? custom : [...builtins, ...custom],
        custom,
      };
    }
    return { version: MANIFEST_VERSION, slots };
  }

  async importGif(sourcePath, slotId, mode = 'append', options = {}) {
    if (!REGISTRY.SLOT_BY_ID[slotId]) throw new GifImportError('invalid-slot', '请选择要应用的状态');
    if (!['append', 'replace'].includes(mode)) throw new GifImportError('invalid-mode', '不支持的添加方式');
    const manifest = this.readManifest();
    const current = manifest.slots[slotId] || { mode: 'append', assets: [] };
    if (mode === 'append' && current.assets.length >= MAX_CUSTOM_PER_SLOT) {
      throw new GifImportError('slot-limit', `每个状态最多添加 ${MAX_CUSTOM_PER_SLOT} 个自定义表情`);
    }
    let resolvedSource;
    try { resolvedSource = fs.realpathSync(sourcePath); }
    catch { throw new GifImportError('source-missing', '找不到所选 GIF，请重新选择'); }
    const result = await this.normalizer(resolvedSource, { removeBackground: options.removeBackground !== false });
    const id = randomUUID();
    const record = {
      id,
      file: `${id}.gif`,
      originalName: safeName(result.meta.originalName || sourcePath),
      createdAt: new Date().toISOString(),
      meta: result.meta,
    };
    fs.mkdirSync(this.assetsDir, { recursive: true });
    const finalPath = path.join(this.assetsDir, record.file);
    const tempPath = path.join(this.assetsDir, `.${id}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tempPath, result.buffer, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, finalPath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
    const stale = mode === 'replace' ? current.assets.slice() : [];
    const nextMode = mode === 'replace' ? 'replace' : current.mode === 'replace' ? 'replace' : 'append';
    manifest.slots[slotId] = {
      mode: nextMode,
      assets: mode === 'replace' ? [record] : [...current.assets, record],
    };
    try {
      this.writeManifest(manifest);
    } catch (error) {
      try { fs.unlinkSync(finalPath); } catch {}
      throw error;
    }
    for (const old of stale) this.deleteRecordFile(old);
    return { ok: true, catalog: this.catalog(), imported: this.customRef(record), warnings: result.warnings || [] };
  }

  removeAsset(slotId, assetId) {
    if (!REGISTRY.SLOT_BY_ID[slotId] || !isAssetId(assetId)) return { ok: false, error: 'invalid' };
    const manifest = this.readManifest();
    const current = manifest.slots[slotId];
    if (!current) return { ok: false, error: 'missing' };
    const removed = current.assets.find((record) => record.id === assetId);
    if (!removed) return { ok: false, error: 'missing' };
    current.assets = current.assets.filter((record) => record.id !== assetId);
    if (!current.assets.length) delete manifest.slots[slotId];
    this.writeManifest(manifest);
    this.deleteRecordFile(removed);
    return { ok: true, catalog: this.catalog() };
  }

  resetSlot(slotId) {
    if (!REGISTRY.SLOT_BY_ID[slotId]) return { ok: false, error: 'invalid' };
    const manifest = this.readManifest();
    const current = manifest.slots[slotId];
    if (!current) return { ok: true, catalog: this.catalog(manifest) };
    delete manifest.slots[slotId];
    this.writeManifest(manifest);
    for (const record of current.assets) this.deleteRecordFile(record);
    return { ok: true, catalog: this.catalog() };
  }

  deleteRecordFile(record) {
    if (!record || !isAssetId(record.id) || record.file !== `${record.id}.gif`) return;
    try { fs.unlinkSync(path.join(this.assetsDir, record.file)); } catch {}
  }

  assetPath(assetId) {
    if (!isAssetId(assetId)) return null;
    const manifest = this.readManifest();
    for (const slot of Object.values(manifest.slots)) {
      const record = slot.assets.find((item) => item.id === assetId);
      if (!record) continue;
      const candidate = path.join(this.assetsDir, record.file);
      try {
        const stat = fs.statSync(candidate);
        return stat.isFile() ? candidate : null;
      } catch { return null; }
    }
    return null;
  }
}

module.exports = { PetAssetStore, sanitizeManifest, isAssetId, MAX_CUSTOM_PER_SLOT };
