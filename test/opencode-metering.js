'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenCodeMetering, normalizeUsage, usageCost, priceFor } = require('../backend/opencode-metering');

// normalizeUsage: cacheRead/cacheWrite are separate token categories (Claude
// semantics), reasoning is a subset of output.
const u = normalizeUsage({
  tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 30, cacheWrite: 20 },
  cost: 0.005,
});
assert.strictEqual(u.tokens, 200);
assert.strictEqual(u.input, 100);
assert.strictEqual(u.output, 50);
assert.strictEqual(u.reasoningOutput, 10);
assert.strictEqual(u.cachedInput, 30);
assert.strictEqual(u.cacheWrite, 20);

// Provider-reported cost wins; estimation kicks in when it's missing.
assert.strictEqual(usageCost({ ...u, cost: 0.009 }, priceFor('gpt-5.6-codex', null)), 0.009);
const noCost = normalizeUsage({ tokens: { input: 1000, output: 500 } });
const est = usageCost(noCost, priceFor('claude-sonnet-4-5', null));
assert(est > 0 && est < 0.1, `claude estimate sane: ${est}`);
assert.strictEqual(usageCost({ ...u, cost: 0.005 }, null), 0.005);

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-opencode-meter-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const usageFile = path.join(root, 'opencode-usage.jsonl');
  const now = Date.now();
  const rows = [
    { v: 1, ts: now, session_id: 's1', message_id: 'm1', model: 'gpt-5.6-codex', provider: 'openai',
      cost: 0.005, tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 30, cacheWrite: 20 } },
    // No provider cost → must be estimated from the pricing table.
    { v: 1, ts: now, session_id: 's1', message_id: 'm2', model: 'claude-sonnet-4-5', provider: 'anthropic',
      tokens: { input: 1000, output: 500, cacheRead: 200 } },
    // Duplicate message_id (file rewrite / rotation) → must be ignored.
    { v: 1, ts: now, session_id: 's1', message_id: 'm1', model: 'gpt-5.6-codex', cost: 0.005,
      tokens: { input: 100, output: 50 } },
    // Junk line must not break the tail.
    'not json',
  ];
  fs.writeFileSync(usageFile, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');

  const meter = createOpenCodeMetering({ usageFile, stateDir });
  await meter.scan();
  let stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 1900);
  assert.strictEqual(stats.today.input, 1100);
  assert.strictEqual(stats.today.output, 550);
  assert.strictEqual(stats.today.cachedInput, 230);
  assert.strictEqual(stats.today.cacheWrite, 20);
  assert.strictEqual(stats.today.msgs, 2);
  // m1 cost is provider-reported (0.005); m2 is estimated from the claude table.
  const m2Estimate = usageCost(
    normalizeUsage({ tokens: { input: 1000, output: 500, cacheRead: 200 } }),
    priceFor('claude-sonnet-4-5', null));
  assert(Math.abs(stats.today.cost - (0.005 + m2Estimate)) < 1e-9, `cost = ${stats.today.cost}`);
  assert.strictEqual(stats.lifetime.tokens, 1900);
  assert.strictEqual(stats.hourlyTok.reduce((a, b) => a + b, 0), 1900);
  const modelRow = stats.byModel['claude-sonnet-4-5'];
  assert(modelRow, 'byModel has claude-sonnet-4-5');
  assert.strictEqual(modelRow.cacheRead, 200, 'cacheRead mapped for the panel');
  assert.strictEqual(modelRow.cacheWrite5m, 0);

  // Second scan must not double count.
  await meter.scan();
  stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 1900, 'second scan must not double count');
  assert.strictEqual(stats.today.msgs, 2);

  // Appended row after restart: cursor persists via state file.
  fs.appendFileSync(usageFile, JSON.stringify({
    v: 1, ts: now, session_id: 's2', message_id: 'm3', model: 'gemini-2.5-pro',
    tokens: { input: 10, output: 5 },
  }) + '\n');
  await meter.scan();
  stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 1900 + 15);
  assert.strictEqual(stats.today.msgs, 3);

  // A rotated usage ledger starts from byte zero. Retained message ids remain
  // deduped and a fresh message after the rotation is still accepted.
  fs.writeFileSync(usageFile, [rows[0], {
    v: 1, ts: now + 1000, session_id: 's2', message_id: 'm4', model: 'gpt-5.6-codex',
    cost: 0.001, tokens: { input: 10, output: 5 },
  }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await meter.scan();
  assert.strictEqual(meter.getStats().today.tokens, 1930, 'rotated usage ledger resumes without replaying old rows');
  const lifetimeBeforeRebuild = meter.getStats().lifetime.tokens;
  fs.writeFileSync(usageFile, JSON.stringify(rows[0]) + '\n');
  await meter.rebuild();
  assert(meter.getStats().lifetime.tokens >= lifetimeBeforeRebuild,
    'rebuild preserves opencode lifetime when a rotated source is incomplete');

  meter.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('opencode metering checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
