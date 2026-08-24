'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const Registry = require('../shared/pet-assets');
const { normalizeGif, assertGifHeader, GifImportError } = require('../backend/gif-normalizer');
const { PetAssetStore, sanitizeManifest, isAssetId } = require('../backend/pet-assets');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-pet-assets-'));

async function main() {
  assert.strictEqual(new Set(Registry.SLOT_IDS).size, Registry.SLOT_IDS.length, 'visual slot ids must be unique');
  assert.strictEqual(Object.keys(Registry.defaultCatalog().slots).length, Registry.SLOTS.length);
  assert.strictEqual(Registry.slotForState('loved'), 'happy');
  assert.strictEqual(Registry.slotForState('sorry'), 'waiting');
  assert.strictEqual(Registry.slotForState('puzzled'), 'needsinput');
  assert(isAssetId('11111111-1111-4111-8111-111111111111'));
  assert(!isAssetId('11111111-1111-1111-1111-111111111111'), 'asset ids must be canonical UUIDs');
  assert(!isAssetId('11111111-1111-4111-8111-11111111111-'));
  for (const slot of Registry.SLOTS) {
    assert(slot.defaultFiles.length > 0, `${slot.id} must retain a default fallback`);
    for (const file of slot.defaultFiles) assert(fs.existsSync(path.join(root, 'assets', 'cat', file)), `${file} is missing`);
  }

  assert.throws(() => assertGifHeader(Buffer.from('not-a-gif')), GifImportError);
  const existing = await normalizeGif(path.join(root, 'assets', 'cat', 'cat-working.gif'));
  assert.strictEqual(existing.meta.width, 120);
  assert.strictEqual(existing.meta.height, 120);
  assert(existing.meta.frames > 1);
  assert.strictEqual(existing.meta.backgroundMode, 'preserved-transparency');
  assertGifHeader(existing.buffer);
  const existingMeta = await sharp(existing.buffer, { animated: true }).metadata();
  assert.strictEqual(existingMeta.pageHeight, 120);
  assert.strictEqual(existingMeta.pages, existing.meta.frames);

  const opaque = path.join(temp, 'white-background.gif');
  const subject = await sharp({ create: { width: 26, height: 34, channels: 4, background: '#24435f' } }).png().toBuffer();
  await sharp({ create: { width: 80, height: 60, channels: 4, background: '#ffffff' } })
    .composite([{ input: subject, left: 27, top: 18 }]).gif().toFile(opaque);
  const cleaned = await normalizeGif(opaque);
  assert.strictEqual(cleaned.meta.backgroundMode, 'removed-solid');
  const cleanedRaw = await sharp(cleaned.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.strictEqual(cleanedRaw.info.width, 120);
  assert.strictEqual(cleanedRaw.info.height, 120);
  assert.strictEqual(cleanedRaw.data[3], 0, 'solid border background must become transparent');
  const centerAlpha = cleanedRaw.data[((65 * 120 + 60) * 4) + 3];
  assert.strictEqual(centerAlpha, 255, 'foreground must remain visible after flood-fill cleanup');

  const bad = sanitizeManifest({ slots: {
    working: { mode: 'replace', assets: [{ id: '11111111-1111-1111-1111-111111111111', file: '../escape.gif' }] },
    unknown: { mode: 'replace', assets: [] },
  } });
  assert.deepStrictEqual(bad.slots, {}, 'manifest sanitization must reject traversal and unknown slots');

  const store = new PetAssetStore({ rootDir: path.join(temp, 'store') });
  const source = path.join(root, 'assets', 'cat', 'cat-idle.gif');
  await assert.rejects(
    store.importGif(path.join(temp, 'missing.gif'), 'working', 'append'),
    (error) => error instanceof GifImportError && error.code === 'source-missing' && !error.message.includes(temp),
  );
  let normalizedAtLimit = false;
  const fullStore = new PetAssetStore({
    rootDir: path.join(temp, 'full-store'),
    normalizer: async () => { normalizedAtLimit = true; return existing; },
  });
  fullStore.writeManifest({ version: 1, slots: { working: {
    mode: 'append',
    assets: Array.from({ length: 20 }, (_, index) => {
      const suffix = String(index).padStart(12, '0');
      const id = `00000000-0000-4000-8000-${suffix}`;
      return { id, file: `${id}.gif`, originalName: `${index}.gif`, createdAt: new Date(0).toISOString() };
    }),
  } } });
  await assert.rejects(fullStore.importGif(source, 'working', 'append'), (error) => error.code === 'slot-limit');
  assert.strictEqual(normalizedAtLimit, false, 'a full slot must reject before expensive GIF decoding');
  const appended = await store.importGif(source, 'working', 'append');
  assert.strictEqual(appended.catalog.slots.working.mode, 'append');
  assert.strictEqual(appended.catalog.slots.working.custom.length, 1);
  assert.strictEqual(appended.catalog.slots.working.active.length, Registry.SLOT_BY_ID.working.defaultFiles.length + 1);
  assert(store.assetPath(appended.imported.id));

  const replaced = await store.importGif(source, 'working', 'replace');
  assert.strictEqual(replaced.catalog.slots.working.mode, 'replace');
  assert.strictEqual(replaced.catalog.slots.working.active.length, 1);
  assert.strictEqual(store.assetPath(appended.imported.id), null, 'replace must remove superseded managed copies');

  const supplemented = await store.importGif(source, 'working', 'append');
  assert.strictEqual(supplemented.catalog.slots.working.mode, 'replace', 'adding after replace must not silently re-enable defaults');
  assert.strictEqual(supplemented.catalog.slots.working.active.length, 2);
  const removed = store.removeAsset('working', supplemented.imported.id);
  assert(removed.ok);
  assert.strictEqual(removed.catalog.slots.working.active.length, 1);
  const reset = store.resetSlot('working');
  assert(reset.ok);
  assert.strictEqual(reset.catalog.slots.working.mode, 'default');
  assert.strictEqual(reset.catalog.slots.working.custom.length, 0);
  assert.strictEqual(reset.catalog.slots.working.active.length, Registry.SLOT_BY_ID.working.defaultFiles.length);
  assert.strictEqual(store.assetPath(replaced.imported.id), null);

  console.log('pet asset normalization and storage checks passed');
}

main().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exit(1);
});
