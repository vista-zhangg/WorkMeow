'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPricingSync, _readFetchBody } = require('../backend/pricing-sync');

const TABLE = {
  anthropic: {
    models: {
      'claude-sonnet-4-5': {
        name: 'Claude Sonnet 4.5',
        release_date: '2025-09-29',
        modalities: { output: ['text'] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  openai: {
    models: {
      'gpt-5': {
        name: 'GPT-5',
        modalities: { output: ['text'] },
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
      },
    },
  },
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-pricing-sync-'));
  const cachePath = path.join(dir, 'pricing-cache.json');
  const statuses = [];
  let updated = 0;
  let clock = 1776556800000;

  const sync = createPricingSync({
    cachePath,
    fetcher: async () => TABLE,
    now: () => clock,
    refreshMs: 86400000,
    retryDelaysMs: [60000],
    onStatus: (status) => statuses.push(status),
    onUpdate: async () => {
      updated += 1;
      assert(fs.existsSync(cachePath), 'onUpdate must run after the new cache is durable');
    },
  });

  const first = await sync.refresh();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(updated, 1);
  let cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.strictEqual(cache.source, 'models.dev');
  assert.strictEqual(cache.ts, clock);
  assert.strictEqual(cache.openaiModels['gpt-5'].input, 1.25);
  assert.strictEqual(sync.getStatus().phase, 'success');
  assert.strictEqual(sync.getStatus().nextAttemptTs, clock + 86400000);

  // A second successful refresh must replace an existing cache on Windows.
  clock += 1000;
  const replacement = JSON.parse(JSON.stringify(TABLE));
  replacement.openai.models['gpt-5'].cost.input = 2;
  const replacing = createPricingSync({
    cachePath,
    fetcher: async () => replacement,
    now: () => clock,
    refreshMs: 86400000,
  });
  assert.strictEqual((await replacing.refresh()).ok, true);
  cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.strictEqual(cache.openaiModels['gpt-5'].input, 2);

  // Failure keeps the last known-good cache and schedules a short retry.
  clock += 1000;
  const failing = createPricingSync({
    cachePath,
    fetcher: async () => {
      const error = new Error('socket hang up');
      error.code = 'ECONNRESET';
      throw error;
    },
    now: () => clock,
    retryDelaysMs: [60000],
  });
  const failed = await failing.refresh();
  assert.strictEqual(failed.ok, false);
  assert.match(failed.error, /ECONNRESET/);
  assert.strictEqual(failing.getStatus().phase, 'error');
  assert.strictEqual(failing.getStatus().nextAttemptTs, clock + 60000);
  cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.strictEqual(cache.openaiModels['gpt-5'].input, 2);
  assert(statuses.some((status) => status.phase === 'syncing'));
  assert(statuses.some((status) => status.phase === 'success'));

  // Electron responses without Content-Length must still stop at the hard cap
  // instead of buffering an arbitrarily large response before validation.
  let reads = 0;
  let cancelled = false;
  const oversizedResponse = {
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => ({ done: false, value: Buffer.alloc(++reads === 1 ? 5 * 1024 * 1024 : 4 * 1024 * 1024) }),
      cancel: async () => { cancelled = true; },
    }) },
  };
  await assert.rejects(() => _readFetchBody(oversizedResponse), /body too large/);
  assert.strictEqual(cancelled, true);

  sync.stop();
  replacing.stop();
  failing.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('pricing sync: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
