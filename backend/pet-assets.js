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
    const defaults = REGISTRY.SLOT_BY_ID[slotId].defaultFiles;
    let excludedDefaults = Array.isArray(source.excludedDefaults)
      ? [...new Set(source.excludedDefaults.filter((file) => defaults.includes(file)))]
      : [];
    // A damaged or hand-edited manifest must never leave a state with no GIF.
    if (!assets.length && excludedDefaults.length >= defaults.length) excludedDefaults = excludedDefaults.slice(0, -1);
    if (!assets.length && !excludedDefaults.length) continue;
    out.slots[slotId] = {
      mode: source.mode === 'replace' && assets.length ? 'replace' : 'append',
      assets,
      excludedDefaults,
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
      const excluded = new Set(saved ? saved.excludedDefaults : []);
      const builtins = slot.defaultFiles.filter((file) => !excluded.has(file)).map((file) => ({
        id: `builtin:${file}`,
        kind: 'builtin',
        name: file,
        url: `../assets/cat/${file}`,
      }));
      const replace = !!(saved && saved.mode === 'replace' && custom.length);
      const modified = !!(saved && (custom.length || excluded.size));
      slots[slot.id] = {
        id: slot.id,
        mode: replace ? 'replace' : modified ? 'append' : 'default',
        usingDefaults: !replace && builtins.length > 0,
        active: replace ? custom : [...builtins, ...custom],
        custom,
      };
    }
    return { version: MANIFEST_VERSION, slots };
  }

  async importGif(sourcePath, slotId, mode = 'append', options = {}) {
    if (!REGISTRY.SLOT_BY_ID[slotId]) throw new GifImportError('invalid-slot', '请选择要应用的状态');
    if (!['append', 'replace', 'replace-one'].includes(mode)) throw new GifImportError('invalid-mode', '不支持的添加方式');
    const manifest = this.readManifest();
    const current = manifest.slots[slotId] || { mode: 'append', assets: [], excludedDefaults: [] };
    const targetId = typeof options.assetId === 'string' ? options.assetId : '';
    const target = mode === 'replace-one'
      ? this.catalog(manifest).slots[slotId].active.find((asset) => asset.id === targetId)
      : null;
    if (mode === 'replace-one' && !target) throw new GifImportError('invalid-target', '请选择当前播放列表中的一个表情');
    const addsCustom = mode === 'append' || (mode === 'replace-one' && target.kind === 'builtin');
    if (addsCustom && current.assets.length >= MAX_CUSTOM_PER_SLOT) {
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
    let stale = [];
    if (mode === 'replace') {
      stale = current.assets.slice();
      manifest.slots[slotId] = { mode: 'replace', assets: [record], excludedDefaults: [] };
    } else if (mode === 'replace-one' && target.kind === 'custom') {
      const old = current.assets.find((item) => item.id === target.id);
      if (!old) {
        try { fs.unlinkSync(finalPath); } catch {}
        throw new GifImportError('invalid-target', '要替换的表情已不在当前播放列表中');
      }
      stale = [old];
      manifest.slots[slotId] = {
        mode: current.mode,
        assets: current.assets.map((item) => item.id === target.id ? record : item),
        excludedDefaults: current.excludedDefaults,
      };
    } else if (mode === 'replace-one') {
      const file = target.id.slice('builtin:'.length);
      manifest.slots[slotId] = {
        mode: current.mode,
        assets: [...current.assets, record],
        excludedDefaults: [...new Set([...current.excludedDefaults, file])],
      };
    } else {
      manifest.slots[slotId] = {
        mode: current.mode === 'replace' ? 'replace' : 'append',
        assets: [...current.assets, record],
        excludedDefaults: current.excludedDefaults,
      };
    }
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
    const definition = REGISTRY.SLOT_BY_ID[slotId];
    if (!definition || typeof assetId !== 'string') return { ok: false, error: 'invalid' };
    const manifest = this.readManifest();
    const slot = this.catalog(manifest).slots[slotId];
    const active = slot.active.find((asset) => asset.id === assetId);
    if (!active) return { ok: false, error: 'missing' };
    if (slot.active.length <= 1) return { ok: false, error: 'last-asset' };
    const current = manifest.slots[slotId] || { mode: 'append', assets: [], excludedDefaults: [] };
    let removed = null;
    if (active.kind === 'custom') {
      removed = current.assets.find((record) => record.id === assetId);
      if (!removed) return { ok: false, error: 'missing' };
      current.assets = current.assets.filter((record) => record.id !== assetId);
    } else {
      const file = assetId.slice('builtin:'.length);
      if (!definition.defaultFiles.includes(file) || current.mode === 'replace') return { ok: false, error: 'invalid' };
      current.excludedDefaults = [...new Set([...current.excludedDefaults, file])];
    }
    if (!current.assets.length && !current.excludedDefaults.length) delete manifest.slots[slotId];
    else manifest.slots[slotId] = current;
    this.writeManifest(manifest);
    if (removed) this.deleteRecordFile(removed);
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
