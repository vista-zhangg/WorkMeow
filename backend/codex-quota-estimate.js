'use strict';

// Prefer timestamped cycle history, including usage before app startup.
// Paired observations remain a fallback when a reset cannot be reconstructed.
const MIN_SAMPLE_PERCENT = 5;
const MAX_SAMPLE_GAP_MS = 5 * 60 * 1000;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function usageInCycle(history, window, used, now) {
  if (!Array.isArray(history)) return null;
  let start = window.resetsAt * 1000 - window.windowDurationMins * 60000;
  const limitId = (window.windowId || 'codex:10080').replace(/:10080$/, '');
  const rows = history.filter(row => row && finite(row.at) !== null && row.at >= start && row.at <= now
    && (!row.limitId || row.limitId === limitId)).sort((a, b) => a.at - b.at);
  let lastUsed = null;
  let oldWindowSeen = false;
  for (const row of rows) {
    if (finite(row.resetsAt) !== null && row.resetsAt !== window.resetsAt) {
      oldWindowSeen = true;
      continue;
    }
    if (row.resetsAt === window.resetsAt && finite(row.usedPercent) !== null) {
      // A changed deadline or an increased remaining percentage marks a reset.
      if (oldWindowSeen || (lastUsed !== null && row.usedPercent < lastUsed)) start = row.at;
      oldWindowSeen = false;
      lastUsed = row.usedPercent;
    }
  }
  // The official snapshot indicates a newer reset than the retained history.
  if (oldWindowSeen || (lastUsed !== null && used < lastUsed)) return null;
  const cost = rows.reduce((sum, row) => sum + (row.at >= start
    && (finite(row.resetsAt) === null || row.resetsAt === window.resetsAt)
    && finite(row.cost) !== null && row.cost > 0 ? row.cost : 0), 0);
  return cost > 0 ? { cost, startAt: start / 1000 } : null;
}

function createWeeklyQuotaEstimator() {
  let baseline = null;
  let previous = null;
  let result = null;
  let blockedHistoryKey = null;
  function reset() { baseline = previous = result = null; }
  function observe(usage, state, now = Date.now()) {
    const window = state && state.windows && state.windows.weekly;
    const account = state && state.account;
    const updatedAt = finite(state && state.updatedAt);
    const tokens = finite(usage && usage.lifetime && usage.lifetime.tokens);
    const cost = finite(usage && usage.lifetime && usage.lifetime.cost);
    const used = finite(window && window.usedPercent)
      ?? (finite(window && window.remainingPercent) === null ? null : 100 - window.remainingPercent);
    if (!state || state.status !== 'ready' || !account || account.type !== 'chatgpt'
      || !account.email || !window || finite(window.resetsAt) === null
      || window.windowDurationMins !== 10080 || used === null || used < 0 || used > 100
      || updatedAt === null || now - updatedAt > MAX_SAMPLE_GAP_MS || updatedAt > now
      || window.resetsAt * 1000 <= now || tokens === null || cost === null || tokens < 0 || cost < 0) {
      reset();
      return null;
    }
    const key = JSON.stringify([account.email, account.planType, window.windowId, window.resetsAt]);
    if (previous && previous.key === key && updatedAt === previous.at) return result;
    const sample = { key, at: updatedAt, used, tokens, cost };
    if (previous && ((previous.key === key && used < previous.used)
      || previous.accountKey !== JSON.stringify([account.email, account.planType]))) blockedHistoryKey = key;
    sample.accountKey = JSON.stringify([account.email, account.planType]);
    // At 100% used the percentage is capped; further local usage cannot
    // calibrate capacity. Keep the last paired estimate until a reset.
    if (previous && previous.key === key && previous.used === 100 && used === 100
      && updatedAt > previous.at && updatedAt - previous.at <= MAX_SAMPLE_GAP_MS
      && tokens >= previous.tokens && cost >= previous.cost) {
      previous = sample;
      return result;
    }
    const discontinuity = !previous || key !== previous.key || used < previous.used
      || tokens < previous.tokens || cost < previous.cost || updatedAt <= previous.at
      || updatedAt - previous.at > MAX_SAMPLE_GAP_MS;
    if (discontinuity) baseline = sample;
    previous = sample;
    const cycle = blockedHistoryKey === key ? null : usageInCycle(usage.quotaHistory, window, used, updatedAt);
    if (cycle) {
      const ready = used >= MIN_SAMPLE_PERCENT;
      const totalCost = ready ? cycle.cost * 100 / used : null;
      result = {
        status: ready ? 'ready' : 'collecting', basis: 'cycle',
        cost: cycle.cost, usedPercent: used, samplePercent: used,
        startAt: cycle.startAt, resetsAt: window.resetsAt,
        estimatedTotalCost: totalCost,
        estimatedRemainingCost: ready ? totalCost * (100 - used) / 100 : null,
      };
      return result;
    }
    const samplePercent = used - baseline.used;
    const sampleTokens = tokens - baseline.tokens;
    const sampleCost = cost - baseline.cost;
    const ready = samplePercent >= MIN_SAMPLE_PERCENT && sampleTokens > 0 && sampleCost > 0;
    const totalCost = ready ? sampleCost * 100 / samplePercent : null;
    result = {
      status: ready ? 'ready' : 'collecting',
      basis: 'sample',
      tokens: sampleTokens, cost: sampleCost, usedPercent: used, samplePercent,
      baselineRemainingPercent: 100 - baseline.used, startAt: baseline.at / 1000,
      resetsAt: window.resetsAt,
      estimatedTotalCost: totalCost,
      estimatedRemainingCost: ready ? totalCost * (100 - used) / 100 : null,
    };
    return result;
  }
  return { observe, reset };
}

module.exports = { createWeeklyQuotaEstimator, usageInCycle, MIN_SAMPLE_PERCENT, MAX_SAMPLE_GAP_MS };
