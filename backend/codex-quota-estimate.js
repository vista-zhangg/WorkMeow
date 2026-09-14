'use strict';

// The App Server exposes Codex subscription usage as a percentage, while the
// local rollout ledger exposes absolute token/cost totals.  This module joins
// the two only for an explicitly labelled estimate; it must never be treated
// as an official quota value.

const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = finite(value);
  return n !== null && n > 0 ? n : 0;
}

function clampPercent(value) {
  const n = finite(value);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

function localDayStart(day) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(day || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(0, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function cycleBounds(window, now = Date.now()) {
  if (!window || typeof window !== 'object') return null;
  const durationMins = finite(window.windowDurationMins);
  const resetsAt = finite(window.resetsAt);
  if (durationMins === null || durationMins <= 0 || resetsAt === null || resetsAt <= 0) return null;
  const endMs = resetsAt * 1000;
  const startMs = endMs - durationMins * 60 * 1000;
  const currentMs = finite(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
    || currentMs === null || currentMs < startMs) return null;
  return { startMs, endMs, nowMs: Math.min(currentMs, endMs) };
}

function addUsage(target, row) {
  if (!row || typeof row !== 'object') return;
  target.tokens += positive(row.tokens);
  target.cost += positive(row.cost);
  target.messages += positive(row.messages ?? row.msgs);
}

function usageInCycle(codexUsage, window, now = Date.now()) {
  const bounds = cycleBounds(window, now);
  if (!bounds) return null;
  const daily = codexUsage && codexUsage.daily && typeof codexUsage.daily === 'object'
    ? codexUsage.daily
    : {};
  const usage = { tokens: 0, cost: 0, messages: 0, days: 0 };
  for (const [day, row] of Object.entries(daily)) {
    const start = localDayStart(day);
    if (start === null) continue;
    const end = start + DAY_MS;
    // The ledger is day-granular, so include a day when any part of it falls
    // inside the official reset window. This is deliberately conservative for
    // a reset that happens in the middle of a local day.
    if (end <= bounds.startMs || start > bounds.nowMs) continue;
    addUsage(usage, row);
    usage.days++;
  }
  return {
    ...usage,
    startAt: Math.floor(bounds.startMs / 1000),
    resetsAt: Math.floor(bounds.endMs / 1000),
  };
}

function estimateWeeklyQuota(codexUsage, weeklyWindow, now = Date.now()) {
  const usage = usageInCycle(codexUsage, weeklyWindow, now);
  if (!usage || (usage.tokens <= 0 && usage.cost <= 0)) return null;

  const remaining = clampPercent(weeklyWindow && weeklyWindow.remainingPercent);
  const reportedUsed = clampPercent(weeklyWindow && weeklyWindow.usedPercent);
  const usedPercent = reportedUsed === null && remaining !== null
    ? 100 - remaining
    : reportedUsed;
  const fraction = usedPercent === null ? null : usedPercent / 100;

  return {
    ...usage,
    usedPercent,
    estimatedTotalTokens: fraction && fraction > 0 ? Math.round(usage.tokens / fraction) : null,
    estimatedTotalCost: fraction && fraction > 0 ? usage.cost / fraction : null,
  };
}

module.exports = {
  DAY_MS,
  cycleBounds,
  usageInCycle,
  estimateWeeklyQuota,
};
