'use strict';
const assert = require('assert');
const { createWeeklyQuotaEstimator, usageInCycle } = require('../backend/codex-quota-estimate');
let now = new Date('2026-09-16T12:00:00Z').getTime();
let total = 9000000;
let dollars = 90;
let resetAt = now / 1000 + 604800;
let email = 'test@example.com';
let planType = 'pro';
const estimator = createWeeklyQuotaEstimator();
function sample(used, delta = 0, options = {}) {
  now += options.gap || 30000;
  total += delta;
  dollars += delta / 100000;
  const state = { status: 'ready', updatedAt: now, account: { type: 'chatgpt', email, planType },
    windows: { weekly: { usedPercent: used, resetsAt: resetAt, windowDurationMins: 10080 } }, ...options.state };
  return estimator.observe({ lifetime: { tokens: total, cost: dollars } }, state, now);
}
assert.strictEqual(sample(0).estimatedTotalCost, null);
assert.strictEqual(sample(1, 1000).estimatedTotalCost, null);
let result = sample(5, 4000);
assert.strictEqual(Math.round(result.estimatedTotalCost * 100000), 100000, 'exclude historical usage even on the reset day');
assert(Math.abs(result.estimatedRemainingCost - 0.95) < 1e-8);
assert(Math.abs(result.estimatedTotalCost - 1) < 1e-8);
assert.strictEqual(sample(0, 7000).estimatedTotalCost, null, 'manual reset with unchanged deadline');
assert.strictEqual(Math.round(sample(5, 10000).estimatedTotalCost * 100000), 200000);
resetAt += 604800;
assert.strictEqual(sample(20, 40000).estimatedTotalCost, null, 'new cycle may already have consumption');
assert.strictEqual(Math.round(sample(25, 5000).estimatedTotalCost * 100000), 100000, 'mid-cycle delta extrapolates to 100%');
email = 'other@example.com';
assert.strictEqual(sample(30, 9000).estimatedTotalCost, null);
assert.strictEqual(Math.round(sample(35, 5000).estimatedTotalCost * 100000), 100000);
planType = 'plus';
assert.strictEqual(sample(40).estimatedTotalCost, null);
assert.strictEqual(Math.round(sample(45, 5000).estimatedTotalCost * 100000), 100000);
assert.strictEqual(sample(50, 5000, { gap: 360000 }).estimatedTotalCost, null, 'offline gaps rebaseline');
assert.strictEqual(sample(55, -1000).estimatedTotalCost, null, 'ledger rollback rebaseline');
assert.strictEqual(sample(null), null);
assert.strictEqual(sample(60, 0, { state: { status: 'error' } }), null);
assert.strictEqual(sample(65, 5000).estimatedTotalCost, null);
assert.strictEqual(sample(70, 0).estimatedTotalCost, null, 'remote-only consumption cannot imply zero capacity');
resetAt = now / 1000 - 1;
assert.strictEqual(sample(80), null, 'expired quota cannot be used');
resetAt = now / 1000 + 604800;
sample(90);
assert.strictEqual(Math.round(sample(100, 10000).estimatedTotalCost * 100000), 100000);
assert.strictEqual(Math.round(sample(100, 50000).estimatedTotalCost * 100000), 100000, 'capped usage cannot inflate capacity');

// Already at 93% remaining on startup: use the historical 7%, not a new 5%.
const cycleNow = new Date('2026-09-16T10:00:00Z').getTime();
const cycleStart = cycleNow - 12 * 3600000;
const cycleWindow = { windowDurationMins: 10080, resetsAt: (cycleStart + 604800000) / 1000,
  remainingPercent: 93, windowId: 'codex:10080' };
const cycleState = { status: 'ready', updatedAt: cycleNow,
  account: { type: 'chatgpt', email: 'cycle@example.com', planType: 'pro' }, windows: { weekly: cycleWindow } };
const history = [
  { at: cycleStart - 1, cost: 999 }, // same calendar day, before cycle start
  { at: cycleStart, cost: 2 },
  { at: cycleNow - 1000, cost: 5, resetsAt: cycleWindow.resetsAt, usedPercent: 7, limitId: 'codex' },
  { at: cycleNow - 500, cost: 999, resetsAt: cycleWindow.resetsAt, usedPercent: 9, limitId: 'codex_bengalfox' },
  { at: cycleNow + 1, cost: 999 }, // exclude events newer than official observation
];
const historicalUsage = { lifetime: { tokens: 1000000, cost: 1000 }, quotaHistory: history };
const cycleEstimator = createWeeklyQuotaEstimator();
let cycleResult = cycleEstimator.observe(historicalUsage, cycleState, cycleNow);
assert.strictEqual(cycleResult.basis, 'cycle');
assert.strictEqual(cycleResult.estimatedTotalCost, 100);
assert.strictEqual(cycleResult.estimatedRemainingCost, 93);
assert.strictEqual(createWeeklyQuotaEstimator().observe(historicalUsage, cycleState, cycleNow).estimatedTotalCost, 100,
  'restarting the app does not require another 5%');
const laterState = { ...cycleState, updatedAt: cycleNow + 30000,
  windows: { weekly: { ...cycleWindow, remainingPercent: 90 } } };
cycleResult = cycleEstimator.observe({ ...historicalUsage,
  quotaHistory: [...history.slice(0, 4), { at: cycleNow + 20000, cost: 5 }] }, laterState, laterState.updatedAt);
assert.strictEqual(cycleResult.estimatedTotalCost, 120, 'new cycle costs and percentage update the estimate');
assert.strictEqual(cycleResult.estimatedRemainingCost, 108);
const smallWindow = { ...cycleWindow, remainingPercent: 96 };
const smallHistory = [{ at: cycleStart, cost: 4 }];
assert.strictEqual(createWeeklyQuotaEstimator().observe({ ...historicalUsage, quotaHistory: smallHistory },
  { ...cycleState, windows: { weekly: smallWindow } }, cycleNow).estimatedTotalCost, null);
assert.strictEqual(createWeeklyQuotaEstimator().observe({ ...historicalUsage, quotaHistory: [{ at: cycleStart, cost: 5 }] },
  { ...cycleState, windows: { weekly: { ...smallWindow, remainingPercent: 95 } } }, cycleNow).estimatedTotalCost, 100,
  'the cycle threshold is inclusive at exactly 5%');
const resetHistory = [
  { at: cycleStart, cost: 50, usedPercent: 80, resetsAt: cycleWindow.resetsAt },
  { at: cycleNow - 3000, cost: 0, usedPercent: 0, resetsAt: cycleWindow.resetsAt },
  { at: cycleNow - 1000, cost: 7, usedPercent: 7, resetsAt: cycleWindow.resetsAt },
];
assert.strictEqual(usageInCycle(resetHistory, cycleWindow, 7, cycleNow).cost, 7,
  'historical manual reset excludes earlier costs without requiring a new sample');
assert.strictEqual(usageInCycle(resetHistory, cycleWindow, 2, cycleNow), null,
  'a reset newer than available history cannot reuse its costs');
console.log('codex quota estimate checks passed');
