'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { STATE_DIR } = require('./paths');
const REGISTRY = require('../shared/pet-assets');
const { PetAssetStore, sanitizeRecord, isAssetId } = require('./pet-assets');
const { normalizeGif, GifImportError } = require('./gif-normalizer');

const DEFAULT_ID = 'salary-cat';
const MAX_CHARACTERS = 30;
const MAX_PACK_FILES = 64;
const fail = (code, message) => { throw new GifImportError(code, message); };
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function characterName(value) {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim() : '';
  if (!name || name.length > 40) fail('invalid-name', '角色名称需要 1～40 个字');
  return name;
}

// The existing pet-assets directory stays attached to Salary Cat. Each new
// character owns immutable starting poses plus its independent edit manifest.
class PetCharacterStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.join(STATE_DIR, 'pet-assets');
    this.charactersDir = path.join(this.rootDir, 'characters');
    this.indexPath = path.join(this.rootDir, 'characters.json');
    this.normalizer = options.normalizer || normalizeGif;
    this.salaryCat = new PetAssetStore({ rootDir: this.rootDir, normalizer: this.normalizer });
    this.busy = false;
  }

  readProfile(id) {
    if (!isAssetId(id)) return null;
    try {
      const folder = path.join(this.charactersDir, id);
      if (fs.lstatSync(folder).isSymbolicLink()) return null;
      const profile = JSON.parse(fs.readFileSync(path.join(folder, 'character.json'), 'utf8'));
      if (profile.version !== 1 || profile.id !== id || !Array.isArray(profile.records) || profile.records.length > MAX_PACK_FILES) return null;
      const records = profile.records.map(sanitizeRecord).filter(Boolean);
      const validIds = new Set(records.map((r) => r.id));
      const slots = {};
      for (const slotId of REGISTRY.SLOT_IDS) {
        slots[slotId] = Array.isArray(profile.slots?.[slotId])
          ? [...new Set(profile.slots[slotId].filter((key) => validIds.has(key)))].slice(0, 20) : [];
      }
      if (!slots.idle.length) return null;
      for (const slotId of REGISTRY.SLOT_IDS) if (!slots[slotId].length) slots[slotId] = slots.idle.slice();
      return { version: 1, id, name: characterName(profile.name), records, slots,
        removeBackground: profile.removeBackground === true,
        notes: Object.fromEntries(REGISTRY.SLOT_IDS.map((s) => [s, typeof profile.notes?.[s] === 'string' ? profile.notes[s].slice(0, 240) : ''])),
      };
    } catch { return null; }
  }

  profiles() {
    try {
      return fs.readdirSync(this.charactersDir).filter(isAssetId).map((id) => this.readProfile(id)).filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    } catch { return []; }
  }

  activeId() {
    try {
      const id = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')).activeId;
      if (Object.hasOwn(REGISTRY.BUILTIN_CHARACTERS, id) || this.readProfile(id)) return id;
    } catch {}
    return DEFAULT_ID;
  }

  store(id = this.activeId()) {
    if (id === DEFAULT_ID) return this.salaryCat;
    if (Object.hasOwn(REGISTRY.BUILTIN_CHARACTERS, id)) return new PetAssetStore({
      rootDir: path.join(this.rootDir, 'builtins', id), normalizer: this.normalizer,
      defaultsBySlot: REGISTRY.characterDefaults(id),
    });
    const profile = this.readProfile(id);
    if (!profile) fail('missing-character', '这个角色已不存在，请重新选择');
    const records = new Map(profile.records.map((r) => [r.id, r]));
    const ref = (key) => ({ ...this.salaryCat.customRef(records.get(key)), id: `preset:${key}`, kind: 'preset' });
    return new PetAssetStore({ rootDir: path.join(this.charactersDir, id), normalizer: this.normalizer,
      defaultsBySlot: Object.fromEntries(REGISTRY.SLOT_IDS.map((s) => [s, profile.slots[s].map(ref)])),
      presetRecords: profile.records,
    });
  }

  catalog() {
    const id = this.activeId();
    const builtin = REGISTRY.BUILTIN_CHARACTERS[id];
    const profile = builtin || this.readProfile(id);
    const store = this.store(id);
    const catalog = store.catalog();
    catalog.character = { id, name: profile.name, removeBackground: profile.removeBackground, canDelete: !builtin, credit: builtin?.credit || '' };
    catalog.fallbackAsset = builtin ? REGISTRY.characterDefaults(id).idle[0] : store.defaultsBySlot.idle[0];
    catalog.characters = [...REGISTRY.defaultCatalog().characters,
      ...this.profiles().map((p) => ({ id: p.id, name: p.name, thumbnail: this.store(p.id).defaultsBySlot.idle[0].url }))];
    for (const slotId of REGISTRY.SLOT_IDS) catalog.slots[slotId].note = profile?.notes?.[slotId] || '';
    return catalog;
  }

  assertIdle() { if (this.busy) fail('busy', '正在处理角色素材，请稍候'); }

  select(id) {
    this.assertIdle();
    if (!Object.hasOwn(REGISTRY.BUILTIN_CHARACTERS, id) && !this.readProfile(id)) fail('missing-character', '请选择已有角色');
    atomicJson(this.indexPath, { version: 1, activeId: id });
    return { ok: true, catalog: this.catalog() };
  }

  async importGif(sourcePath, slotId, mode, options = {}) {
    this.assertIdle();
    const id = options.characterId || this.activeId();
    const store = this.store(id);
    this.busy = true;
    try {
      const result = await store.importGif(sourcePath, slotId, mode, options);
      return { ...result, catalog: this.catalog() };
    } finally { this.busy = false; }
  }

  removeAsset(slotId, assetId, id = this.activeId()) {
    this.assertIdle();
    const result = this.store(id).removeAsset(slotId, assetId);
    return { ...result, catalog: this.catalog() };
  }

  resetSlot(slotId, id = this.activeId()) {
    this.assertIdle();
    const result = this.store(id).resetSlot(slotId);
    return { ...result, catalog: this.catalog() };
  }

  assetPath(assetId) {
    if (!isAssetId(assetId)) return null;
    return Object.keys(REGISTRY.BUILTIN_CHARACTERS).map((id) => this.store(id).assetPath(assetId)).find(Boolean)
      || this.profiles().map((p) => this.store(p.id).assetPath(assetId)).find(Boolean) || null;
  }

  async createFromGif(name, sourcePath, options = {}) {
    return this.create(name, { idle: [sourcePath] }, options);
  }

  async importPack(manifestPath) {
    this.assertIdle();
    const absolute = fs.realpathSync(manifestPath);
    if (fs.statSync(absolute).size > 256 * 1024) fail('pack-limit', '角色配置文件过大');
    let pack;
    try { pack = JSON.parse(fs.readFileSync(absolute, 'utf8')); }
    catch { fail('invalid-pack', '请选择有效的角色 JSON 配置'); }
    if (!['agentpaw-character', ...require('./character-compat')].includes(pack?.format) || pack.version !== 1 || !pack.slots || typeof pack.slots !== 'object') {
      fail('invalid-pack', '这不是 AgentPaw 角色包配置');
    }
    const baseDir = path.dirname(absolute);
    const slots = {};
    for (const [slot, names] of Object.entries(pack.slots)) {
      if (!REGISTRY.SLOT_BY_ID[slot] || !Array.isArray(names) || names.length > 20) fail('invalid-pack', '角色包包含未知状态或过多表情');
      slots[slot] = names.map((name) => {
        if (typeof name !== 'string' || path.isAbsolute(name) || !/\.gif$/i.test(name)) fail('invalid-pack', '角色素材必须是包内的 GIF 文件');
        const resolved = fs.realpathSync(path.resolve(baseDir, name));
        const relative = path.relative(baseDir, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('invalid-pack', '角色素材不能引用包目录之外的文件');
        return resolved;
      });
    }
    return this.create(pack.name, slots, { removeBackground: pack.removeBackground === true, notes: pack.notes });
  }

  async create(name, sources, options = {}) {
    this.assertIdle();
    name = characterName(name);
    if (this.profiles().length >= MAX_CHARACTERS) fail('character-limit', `最多创建 ${MAX_CHARACTERS} 个角色`);
    if (!sources.idle?.length) fail('missing-idle', '角色需要至少一张待命 GIF，其他状态可以稍后补充');
    const files = [...new Set(Object.values(sources).flat())];
    if (files.length > MAX_PACK_FILES || files.reduce((n, f) => n + fs.statSync(f).size, 0) > 128 * 1024 * 1024) fail('pack-limit', '角色包最多 64 个 GIF、总大小不超过 128 MB');
    this.busy = true;
    const id = randomUUID();
    const folder = path.join(this.charactersDir, id);
    const written = [];
    let published = false;
    try {
      const records = [], recordBySource = new Map();
      fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
      for (const file of files) {
        const result = await this.normalizer(file, { removeBackground: options.removeBackground === true });
        const assetId = randomUUID();
        const record = { id: assetId, file: `${assetId}.gif`, originalName: path.basename(file), createdAt: new Date().toISOString(), meta: result.meta };
        const dest = path.join(folder, 'assets', record.file);
        fs.writeFileSync(dest, result.buffer, { flag: 'wx', mode: 0o600 });
        written.push(dest); records.push(record); recordBySource.set(file, assetId);
      }
      const slots = {}, notes = {};
      for (const slot of REGISTRY.SLOT_IDS) {
        const provided = sources[slot]?.length ? sources[slot] : sources.idle;
        slots[slot] = [...new Set(provided.map((f) => recordBySource.get(f)))];
        notes[slot] = typeof options.notes?.[slot] === 'string' ? options.notes[slot].slice(0, 240)
          : !sources[slot]?.length ? '暂用这个角色的待命动作，可在下方替换。' : '';
      }
      atomicJson(path.join(folder, 'character.json'), { version: 1, id, name, removeBackground: options.removeBackground === true, records, slots, notes });
      published = true;
      atomicJson(this.indexPath, { version: 1, activeId: id });
      return { ok: true, characterId: id, catalog: this.catalog() };
    } catch (error) {
      if (!published) {
        for (const file of written) { try { fs.unlinkSync(file); } catch {} }
        try { fs.rmdirSync(path.join(folder, 'assets')); fs.rmdirSync(folder); } catch {}
      }
      throw error;
    } finally { this.busy = false; }
  }

  removeCharacter(id) {
    this.assertIdle();
    if (!isAssetId(id) || !this.readProfile(id)) fail('invalid-character', '只能删除自建角色');
    if (id === this.activeId()) atomicJson(this.indexPath, { version: 1, activeId: DEFAULT_ID });
    // Rename out of the visible UUID registry first. Keep a recoverable archive;
    // in-flight image requests can fail without affecting another character.
    fs.renameSync(path.join(this.charactersDir, id), path.join(this.charactersDir, `.removed-${id}-${Date.now()}`));
    return { ok: true, catalog: this.catalog() };
  }
}

module.exports = { PetCharacterStore, DEFAULT_ID };
