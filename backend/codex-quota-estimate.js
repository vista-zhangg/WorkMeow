'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TOLERANCE_SECONDS = 5 * 60;
const MAX_QUOTA_AGE_MS = 5 * 60 * 1000;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

// A token_count event may carry the latest snapshot of an unrelated limit
// bucket (e.g. Spark while the request used Astra). It is NOT an attribution
// of that request's cost. Only timestamps select monetary records here.
function cycleCost(history, start, end) {
  if (!Array.isArray(history)) return 0;
  return history.reduce((total, row) => total + (row && finite(row.at) !== null
    && row.at >= start && row.at <= end && finite(row.cost) !== null && row.cost > 0 ? row.cost : 0), 0);
}

function validCalibration(value) {
  return value && value.version === 1 && typeof value.accountKey === 'string'
    && typeof value.windowId === 'string' && ['cycle', 'sample'].includes(value.basis)
    && ['resetsAt', 'startAt', 'anchorCost', 'anchorUsed', 'anchorAt', 'lastUsed', 'lastAt'].every(k => finite(value[k]) !== null)
    && value.anchorCost >= 0 && value.anchorUsed >= 0 && value.anchorUsed <= 100
    && value.lastUsed >= 0 && value.lastUsed <= 100 && value.resetsAt > 0;
}

function createWeeklyQuotaEstimator(options = {}) {
  const statePath = options.statePath;
  let calibration = null;
  if (statePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (validCalibration(saved)) calibration = saved;
    } catch {}
  }
  function persist() {
    if (!statePath || !calibration) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(calibration), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch {}
  }

  function observe(usage, state, now = Date.now()) {
    const window = state && state.windows && state.windows.weekly;
    const updatedAt = finite(state && state.updatedAt);
    const used = finite(window && window.usedPercent)
      ?? (finite(window && window.remainingPercent) === null ? null : 100 - window.remainingPercent);
    // A reconnect/stale read is not a quota reset. Keep calibration intact.
    if (!state || state.status !== 'ready' || !state.account || state.account.type !== 'chatgpt'
      || !window || window.windowDurationMins !== 10080 || finite(window.resetsAt) === null
      || used === null || used < 0 || used > 100 || updatedAt === null || updatedAt > now
      || now - updatedAt > MAX_QUOTA_AGE_MS || window.resetsAt * 1000 <= now) return null;
    if (calibration && updatedAt < calibration.lastAt) return null;

    const accountKey = createHash('sha256').update(JSON.stringify([
      state.account.email || '', state.account.planType || '',
    ])).digest('hex');
    const windowId = window.windowId || 'codex:10080';
    const changedAccount = calibration && calibration.accountKey !== accountKey;
    const changedCycle = !calibration || calibration.windowId !== windowId
      || Math.abs(calibration.resetsAt - window.resetsAt) > RESET_TOLERANCE_SECONDS;
    const fresh = !calibration || updatedAt > calibration.lastAt;
    // Ignore one-point rounding noise. A substantial recovery, or a return
    // to zero, marks a manual reset even if the deadline stayed the same.
    const recovered = calibration && fresh && (calibration.lastUsed - used >= 3
      || (used === 0 && calibration.lastUsed >= 1));
    const startAt = changedCycle ? window.resetsAt * 1000 - WEEK_MS : calibration.startAt;
    const totalCost = cycleCost(usage && usage.quotaHistory, startAt, now);
    if (changedCycle || changedAccount || recovered) {
      const basis = changedAccount || (!changedCycle && recovered) ? 'sample' : 'cycle';
      calibration = {
        version: 1, accountKey, windowId, resetsAt: window.resetsAt, startAt, basis,
        anchorCost: basis === 'sample' ? totalCost : 0,
        anchorUsed: basis === 'sample' ? used : 0,
        anchorAt: basis === 'sample' ? now : startAt,
        lastUsed: used, lastAt: updatedAt,
      };
      persist();
    } else if (updatedAt < calibration.lastAt) {
      return null; // an out-of-order response must not undo a newer reset
    }
    if (calibration.basis === 'sample' && totalCost < calibration.anchorCost) {
      calibration.anchorCost = totalCost;
      calibration.anchorUsed = used;
      calibration.anchorAt = now;
      delete calibration.exhausted;
      persist();
    }
    // At 100% the quota counter is capped and cannot calibrate extra spend.
    if (used === 100 && calibration.lastUsed === 100 && calibration.exhausted) return calibration.exhausted;

    const cost = Math.max(0, totalCost - calibration.anchorCost);
    const samplePercent = Math.max(0, used - calibration.anchorUsed);
    const ready = samplePercent > 0 && cost > 0;
    const estimatedTotalCost = ready ? cost * 100 / samplePercent : null;
    const result = {
      status: ready ? 'ready' : 'collecting', basis: calibration.basis,
      confidence: samplePercent < 5 ? 'early' : 'reference',
      reason: samplePercent <= 0 ? 'no-percent' : cost <= 0 ? 'no-cost' : null,
      cost, usedPercent: used, samplePercent, cycleCost: totalCost,
      startAt: calibration.anchorAt / 1000, resetsAt: window.resetsAt,
      estimatedTotalCost,
      estimatedRemainingCost: ready ? estimatedTotalCost * (100 - used) / 100 : null,
      // Sensitivity to one percentage point, not a statistical confidence interval.
      rangeLow: ready ? cost * 100 / Math.min(100, samplePercent + 1) : null,
      rangeHigh: ready && samplePercent > 1 ? cost * 100 / (samplePercent - 1) : null,
      updatedAt: now,
    };
    const shouldSave = calibration.lastAt !== updatedAt;
    calibration.lastUsed = used;
    calibration.lastAt = updatedAt;
    if (used === 100 && ready) calibration.exhausted = result;
    else delete calibration.exhausted;
    if (shouldSave || used === 100) persist();
    return result;
  }
  return { observe };
}

module.exports = { createWeeklyQuotaEstimator, cycleCost, RESET_TOLERANCE_SECONDS, MAX_QUOTA_AGE_MS };
