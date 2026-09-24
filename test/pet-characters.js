'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { PetCharacterStore } = require('../backend/pet-characters');
const Registry = require('../shared/pet-assets');
const { loadRenderer } = require('./dom-stub');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpaw-characters-'));
  const input = path.join(temp, 'idle.gif');
  const fixture = fs.readFileSync(path.join(__dirname, '../assets/cat/cat-idle.gif'));
  fs.writeFileSync(input, fixture);
  const backgrounds = [];
  const normalizer = async (_file, options) => {
    backgrounds.push(options.removeBackground);
    return { buffer: fixture, meta: { width: 120, height: 120, frames: 3, durationMs: 300 }, warnings: [] };
  };
  try {
    const rootDir = path.join(temp, 'store');
    const manager = new PetCharacterStore({ rootDir, normalizer });
    const old = await manager.importGif(input, 'working', 'replace', { removeBackground: true });
    const legacyManifest = fs.readFileSync(path.join(rootDir, 'manifest.json'));
    const oldAssetPath = manager.assetPath(old.imported.id);
    const created = await manager.createFromGif('奶茶鼠', input, { removeBackground: false });
    const id = created.characterId;
    assert.equal(backgrounds.at(-1), false, 'character creation must honor preserved background');
    assert.deepEqual(fs.readFileSync(path.join(rootDir, 'manifest.json')), legacyManifest, 'old cat config stays byte-identical');
    assert(fs.existsSync(oldAssetPath));
    const milk = Registry.normalizeCatalog(created.catalog);
    assert.equal(milk.character.id, id);
    for (const slot of Registry.SLOT_IDS) {
      assert(milk.slots[slot].active.every((asset) => asset.kind === 'preset' && asset.url.startsWith('agentpaw-asset:')), slot + ' must never mix cat defaults');
      if (slot !== 'idle') assert(milk.slots[slot].note.includes('待命'));
    }
    const preset = milk.slots.working.active[0];
    const presetFile = manager.assetPath(preset.id.slice('preset:'.length));
    assert(presetFile && fs.existsSync(presetFile));
    const edited = await manager.importGif(input, 'working', 'replace-one', { assetId: preset.id, removeBackground: false });
    assert.equal(edited.catalog.slots.working.active.length, 1);
    assert.equal(edited.catalog.slots.working.active[0].kind, 'custom');
    assert(fs.existsSync(presetFile), 'replacing a preset never deletes its reset source');
    const appended = await manager.importGif(input, 'working', 'append', { removeBackground: false });
    assert.equal(appended.catalog.slots.working.active.length, 2);
    assert(manager.removeAsset('working', edited.imported.id).ok);
    assert.equal(manager.removeAsset('working', appended.imported.id).error, 'last-asset');
    const restored = manager.resetSlot('working').catalog;
    assert.equal(restored.slots.working.active[0].id, preset.id);
    assert(fs.existsSync(presetFile));
    assert(!manager.assetPath(appended.imported.id));
    manager.select('salary-cat');
    assert.equal(manager.catalog().slots.working.active[0].id, old.imported.id);
    manager.select(id);
    assert.equal(new PetCharacterStore({ rootDir, normalizer }).activeId(), id, 'role survives restart');

    const world = loadRenderer(['shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js', 'shared/pet-insights.js', 'renderer/pet.js']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    world.handlers.petAssets(restored);
    for (const state of ['idle', 'working', 'thinking', 'talking', 'juggling', 'sweeping', 'loafing', 'waiting', 'needsinput', 'happy', 'greet', 'error', 'sad', 'sleeping']) {
      vm.runInContext(`setState(${JSON.stringify(state)})`, world.sandbox);
      assert(world.elements('cat-img').src.startsWith('agentpaw-asset:'), 'state '+state+' stays in character');
    }
    const img = world.elements('cat-img');
    img.src = 'agentpaw-asset://asset/missing.gif'; img.onerror();
    assert.equal(img.src, restored.fallbackAsset.url, 'broken GIF falls back to own character');
    img.onerror(); assert.equal(img.hidden, true, 'failed own fallback does not show a cat');
    world.handlers.petAssets(restored); assert.equal(img.hidden, false);
    vm.runInContext('stopPoolRot(); ambientStop();', world.sandbox);

    const packDir = path.join(temp, 'pack'); fs.mkdirSync(packDir);
    fs.copyFileSync(input, path.join(packDir, 'base.gif'));
    const manifestPath = path.join(packDir, 'character.json');
    const pack = { format: 'agentpaw-character', version: 1, name: '另一只伙伴', removeBackground: false, slots: { idle: ['base.gif'], working: ['base.gif'] } };
    fs.writeFileSync(manifestPath, JSON.stringify(pack));
    const packResult = await manager.importPack(manifestPath);
    assert.equal(backgrounds.at(-1), false);
    assert.equal(manager.readProfile(packResult.characterId).records.length, 1, 'shared source is normalized once');
    pack.slots.idle = ['../idle.gif']; fs.writeFileSync(manifestPath, JSON.stringify(pack));
    await assert.rejects(manager.importPack(manifestPath), (e) => e.code === 'invalid-pack');
    assert.equal(manager.activeId(), packResult.characterId, 'invalid pack leaves current role unchanged');
    assert.throws(() => manager.select('../outside'), (e) => e.code === 'missing-character');
    assert.equal(manager.assetPath('../outside'), null);
    assert.throws(() => manager.removeCharacter('salary-cat'));
    manager.select(id);
    manager.removeCharacter(id);
    assert.equal(manager.activeId(), 'salary-cat');
    assert.equal(manager.catalog().slots.working.active[0].id, old.imported.id);
    assert(!manager.profiles().find((p) => p.id === id));

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slow = new PetCharacterStore({ rootDir, normalizer: async (...args) => { await gate; return normalizer(...args); } });
    const pending = slow.createFromGif('慢动作', input);
    assert.throws(() => slow.select(packResult.characterId), (e) => e.code === 'busy');
    release(); await pending;
    const before = slow.profiles().length;
    slow.normalizer = async () => { throw Error('decode failed'); };
    await assert.rejects(slow.createFromGif('坏素材', input));
    assert.equal(slow.profiles().length, before, 'failed import is not published');
    assert.equal(slow.busy, false);
    manager.select('milktea-mouse');
    const builtin = manager.catalog();
    assert.equal(builtin.character.canDelete, false);
    assert.equal(builtin.character.removeBackground, false);
    assert.equal(builtin.characters.filter((c) => c.builtin).length, 3);
    assert.throws(() => manager.removeCharacter('milktea-mouse'));
    for (const slot of Registry.SLOT_IDS) for (const asset of builtin.slots[slot].active) {
      assert(asset.url.startsWith('../assets/characters/milktea-mouse/'));
      assert(fs.existsSync(path.resolve(__dirname, '../renderer', asset.url)), 'bundled GIF exists');
    }
    const ownDefault = builtin.slots.working.active[0];
    await manager.importGif(input, 'working', 'replace-one', { assetId: ownDefault.id, removeBackground: false });
    assert.equal(manager.catalog().slots.working.active[0].kind, 'custom');
    manager.select('salary-cat');
    assert.equal(manager.catalog().slots.working.active[0].id, old.imported.id, 'builtin role edits are isolated');
    manager.select('milktea-mouse');
    assert.equal(manager.resetSlot('working').catalog.slots.working.active[0].id, ownDefault.id);
    assert.deepEqual(fs.readFileSync(path.join(rootDir, 'manifest.json')), legacyManifest);
    manager.select('mimi-bee');
    const bee = Registry.normalizeCatalog(manager.catalog());
    assert.equal(bee.character.canDelete, false);
    assert.equal(bee.character.removeBackground, false);
    assert(bee.character.credit.includes('花栗鼠发发'));
    assert.throws(() => manager.removeCharacter('mimi-bee'));
    const beeFiles = new Set();
    for (const slot of Registry.SLOT_IDS) for (const asset of bee.slots[slot].active) {
      assert(asset.url.startsWith('../assets/characters/mimi-bee/'), slot + ' stays in the bee character');
      assert(fs.existsSync(path.resolve(__dirname, '../renderer', asset.url)));
      beeFiles.add(asset.url);
    }
    assert.equal(beeFiles.size, 16, 'all 16 original animations are assigned');
    const beeDefault = bee.slots.working.active[0];
    await manager.importGif(input, 'working', 'replace-one', { assetId: beeDefault.id, removeBackground: false });
    const beeEdit = manager.catalog().slots.working.active[0];
    manager.select('milktea-mouse');
    assert.equal(manager.catalog().slots.working.active[0].id, ownDefault.id);
    manager.select('mimi-bee');
    assert.equal(manager.catalog().slots.working.active[0].id, beeEdit.id);
    assert.equal(manager.resetSlot('working').catalog.slots.working.active[0].id, beeDefault.id);
    assert.equal(new PetCharacterStore({ rootDir, normalizer }).activeId(), 'mimi-bee');
    console.log('Character isolation, migration, pack validation, renderer fallback and editing checks passed');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
