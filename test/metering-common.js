'use strict';

const assert = require('assert');
const { num, dayKey, mergeUsageMax, mergeLifetime } = require('../backend/metering-common');

assert.strictEqual(num(12), 12);
assert.strictEqual(num('3.5'), 3.5);
assert.strictEqual(num(0), 0);
assert.strictEqual(num(-1), 0);
assert.strictEqual(num(Number.NaN), 0);
assert.strictEqual(num(Number.POSITIVE_INFINITY), 0);

const sample = new Date(2026, 7, 9, 12, 0, 0).getTime();
assert.strictEqual(dayKey(sample), '2026-08-09');
assert.deepStrictEqual(mergeUsageMax({ tokens: 10, msgs: 2 }, { tokens: 4, msgs: 1 }), { tokens: 10, msgs: 2 });
assert.deepStrictEqual(mergeUsageMax({ tokens: 10 }, { tokens: 12 }), { tokens: 12 });
assert.strictEqual(mergeLifetime({ tokens: 10, cost: 5 }, { tokens: 4, cost: 1 }).cost, 5);
assert.strictEqual(mergeLifetime({ tokens: 10, cost: 5 }, { tokens: 12, cost: 1 }).cost, 1);

console.log('metering common checks passed');
