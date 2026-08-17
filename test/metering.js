'use strict';

// Regression coverage for the two expensive metering bugs:
// 1) Claude emits the same message id repeatedly while output_tokens grows;
// 2) 5-minute and 1-hour cache writes have different prices.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMetering } = require('../backend/metering');

async function main() {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-metering-'));
const projectsDir = path.join(root, 'projects');
const stateDir = path.join(root, 'state');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const pricingOverridePath = path.join(stateDir, 'pricing.json');
const meter = createMetering({ projectsDir, stateDir, pricingOverridePath });
const now = Date.now();
const first = {
  input_tokens: 4,
  output_tokens: 2,
  cache_creation_input_tokens: 120,
  cache_read_input_tokens: 50,
  cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 100 },
};
const final = { ...first, output_tokens: 372 };

assert.strictEqual(meter._ingest('message-1|request-1', now, 'claude-opus-4-1', first), true);
assert.strictEqual(meter._ingest('message-1|request-1', now, 'claude-opus-4-1', final), true);
assert.strictEqual(meter._ingest('message-1|request-1', now, 'claude-opus-4-1', final), false);

const stats = meter.getStats();
assert.strictEqual(stats.today.msgs, 1, 'streaming updates must remain one turn');
assert.strictEqual(stats.today.output, 372, 'final output usage must win over the first partial row');
assert.strictEqual(stats.today.cacheWrite5m, 20);
assert.strictEqual(stats.today.cacheWrite1h, 100);
assert.strictEqual(stats.today.cacheCreate, 120);
assert.strictEqual(stats.today.tokens, 4 + 372 + 20 + 100 + 50);
assert.strictEqual(stats.lifetime.tokens, stats.today.tokens, 'Claude lifetime must advance with deduplicated usage');
assert.strictEqual(stats.lifetime.msgs, 1, 'streaming corrections must not create lifetime turns');
assert.strictEqual(stats.hourlyTok.reduce((a, b) => a + b, 0), stats.today.tokens);
assert.strictEqual(stats.diagnostics.streamingCorrections, 1);
assert.strictEqual(stats.diagnostics.records, 1);

// Opus 4.1 fallback: input 15, output 75, 5m write 18.75, 1h write 30, read 1.5.
const expectedCost = (4 * 15 + 372 * 75 + 20 * 18.75 + 100 * 30 + 50 * 1.5) / 1e6;
assert(Math.abs(stats.today.cost - expectedCost) < 1e-12);

const lifetimeBeforeReprice = meter.getStats().lifetime.tokens;
const costBeforeReprice = meter.getStats().today.cost;
fs.writeFileSync(pricingOverridePath, JSON.stringify({
  models: { 'claude-opus-4-1': { input: 30, output: 150, cacheWrite5m: 37.5, cacheWrite1h: 60, cacheRead: 3 } },
}));
await meter.reloadPricing();
assert.strictEqual(
  meter.getStats().lifetime.tokens,
  lifetimeBeforeReprice,
  'repricing retained records must not double-count lifetime progression',
);
assert(meter.getStats().today.cost > costBeforeReprice, 'awaited pricing reload must reprice retained history');

const lifetimeBeforeRebuild = meter.getStats().lifetime.tokens;
await meter.rebuild();
assert.strictEqual(meter.getStats().lifetime.tokens, lifetimeBeforeRebuild,
  'rebuild must preserve lifetime when source transcripts are unavailable');

meter.stop();
fs.rmSync(root, { recursive: true, force: true });
console.log('metering streaming/TTL checks passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
