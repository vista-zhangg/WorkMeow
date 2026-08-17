'use strict';

const assert = require('assert');
const { mergeUsageRows, mergeDaily } = require('../backend/usage-stats');

const merged = mergeUsageRows([
  ['claude', { input: 100, output: 10, cacheRead: 50, cacheWrite5m: 20, cacheWrite1h: 10, tokens: 190, msgs: 1 }],
  ['codex', { input: 200, output: 50, cachedInput: 100, tokens: 250, msgs: 2 }],
  ['opencode', { input: 30, output: 5, cachedInput: 10, cacheWrite: 4, tokens: 49, msgs: 1 }],
]);

assert.strictEqual(merged.inputTotal, 424, 'inputTotal includes separate Claude/opencode cache components once');
assert.strictEqual(merged.cacheRead, 160, 'cache reads are normalized across providers');
assert.strictEqual(merged.cacheWrite5m, 24, 'cache writes are normalized across providers');
assert.strictEqual(merged.tokens, 489, 'provider token totals are not double-counted');
assert.strictEqual(merged.messages, 4, 'message aliases are kept in sync');

const daily = mergeDaily([
  ['claude', { daily: { '2026-08-08': { input: 10, output: 2, cacheRead: 3, tokens: 5, msgs: 1 } } }],
  ['opencode', { daily: { '2026-08-08': { input: 4, output: 1, cachedInput: 2, tokens: 7, msgs: 1 } } }],
]);
assert.strictEqual(daily['2026-08-08'].inputTotal, 19, 'daily inputTotal uses the same semantics as today');
assert.strictEqual(daily['2026-08-08'].cacheRead, 5, 'daily cache reads are merged');

console.log('usage stats checks passed');
