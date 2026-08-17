'use strict';

// Pure primitives shared by every provider ledger. Provider-specific usage
// shapes, pricing policies, parsers and persistence stay in their own modules.
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// A rebuild is allowed to reprice a complete retained ledger, but it must
// never turn a source outage/partial transcript into a lower all-time total.
// These are the usage fields shared by the provider ledgers (unknown fields
// are intentionally ignored so old state files remain forward-compatible).
const MONOTONIC_USAGE_FIELDS = Object.freeze([
  'tokens', 'input', 'output', 'inputTotal', 'cachedInput', 'cacheRead', 'cacheWrite',
  'cacheWrite5m', 'cacheWrite1h', 'cacheCreate', 'reasoningOutput', 'msgs',
  'messages',
]);

function mergeUsageMax(previous, current) {
  const before = previous && typeof previous === 'object' ? previous : {};
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  for (const key of MONOTONIC_USAGE_FIELDS) {
    const a = Number(before[key]);
    const b = Number(out[key]);
    if (Number.isFinite(a) && a > 0 && (!Number.isFinite(b) || b < a)) out[key] = a;
  }
  return out;
}

function usageHasLoss(previous, current) {
  const before = previous && typeof previous === 'object' ? previous : {};
  const after = current && typeof current === 'object' ? current : {};
  return MONOTONIC_USAGE_FIELDS.some((key) => {
    const a = Number(before[key]);
    const b = Number(after[key]);
    return Number.isFinite(a) && a > 0 && (!Number.isFinite(b) || b < a);
  });
}

function mergeLifetime(previous, current) {
  const out = mergeUsageMax(previous, current);
  // Pricing can legitimately move down during a refresh. Preserve cost only
  // when the source itself lost rows; otherwise use the newly repriced value.
  if (usageHasLoss(previous, current)) {
    const before = Number(previous && previous.cost);
    const after = Number(out.cost);
    if (Number.isFinite(before) && before > after) out.cost = before;
  }
  return out;
}

module.exports = { num, dayKey, MONOTONIC_USAGE_FIELDS, usageHasLoss, mergeUsageMax, mergeLifetime };
