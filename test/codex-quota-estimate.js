'use strict';

const assert = require('assert');
const { estimateWeeklyQuota, usageInCycle } = require('../backend/codex-quota-estimate');

const now = new Date(2026, 8, 7, 12, 0, 0).getTime();
const resetsAt = Math.floor(new Date(2026, 8, 10, 12, 0, 0).getTime() / 1000);
const weekly = {
  windowDurationMins: 7 * 24 * 60,
  resetsAt,
  remainingPercent: 75,
};

const usage = {
  daily: {
    '2026-09-02': { tokens: 999999, cost: 99 }, // before the reset window
    '2026-09-03': { tokens: 100000, cost: 1.25, msgs: 2 },
    '2026-09-04': { tokens: 50000, cost: 0.75, messages: 1 },
    '2026-09-07': { tokens: 50000, cost: 0.5, msgs: 1 },
    '2026-09-11': { tokens: 999999, cost: 99 }, // after the current window
  },
};

const inCycle = usageInCycle(usage, weekly, now);
assert.strictEqual(inCycle.tokens, 200000);
assert.strictEqual(inCycle.cost, 2.5);
assert.strictEqual(inCycle.messages, 4);
assert.strictEqual(inCycle.days, 3);

const estimate = estimateWeeklyQuota(usage, weekly, now);
assert.strictEqual(estimate.usedPercent, 25);
assert.strictEqual(estimate.estimatedTotalTokens, 800000);
assert.strictEqual(estimate.estimatedTotalCost, 10);

assert.strictEqual(estimateWeeklyQuota({ daily: {} }, weekly, now), null,
  'without local Codex usage there is no absolute quota estimate');
assert.strictEqual(estimateWeeklyQuota(usage, { ...weekly, remainingPercent: 100 }, now).estimatedTotalTokens, null,
  'zero reported usage must wait for more samples instead of dividing by zero');

console.log('codex quota estimate checks passed');
