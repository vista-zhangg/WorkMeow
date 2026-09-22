'use strict';

const { MAX_MINUTES, sanitizePreferences } = require('../shared/rest-preferences');

const KINDS = Object.freeze(['water', 'stretch', 'eyes']);
const MINUTE_MS = 60_000;
const IDLE_BREAK_SECONDS = 5 * 60;
const MAX_TICK_GAP_MS = 2 * MINUTE_MS;
const SNOOZE_MS = 10 * MINUTE_MS;

function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function nextLocalMidnight(timestamp) {
  const date = new Date(timestamp);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

// Human-use timing only: no agent/session state belongs in this controller.
// Short input gaps count as reading/thinking; five minutes idle counts as a
// stretch/eye break. Water accumulates across those breaks. Locks and suspended
// periods accrue no use; missing ticks never catch up elapsed wall-clock time.
// Fullscreen/quiet are presentation decisions and must NOT be passed as paused.
function createRestReminderController({ now = Date.now, preferences, onChange, runtime } = {}) {
  let prefs = sanitizePreferences(preferences);
  let lastTick = now();
  let day = localDay(lastTick);
  let pending = null;
  let sequence = 0;
  let skippedUntil = 0;
  let snoozedUntil = 0;
  let snoozedKinds = [];
  let pausedSince = null;
  let wasInactive = false;
  const elapsed = { water: 0, stretch: 0, eyes: 0 };

  const enabled = (kind) => prefs.enabled && prefs[`${kind}Enabled`];
  const interval = (kind) => prefs[`${kind}Minutes`] * MINUTE_MS;

  // Persist user choices, not active time: closing the app is a fresh session.
  // Today-skip is date-bound; an explicit future snooze can cross midnight.
  // Validation avoids stale reminders or an arbitrary persisted date silencing
  // the app indefinitely. Existing snoozes preserve the chosen end time when
  // settings change, bounded by the maximum supported duration.
  if (runtime && runtime.version === 1 && prefs.enabled) {
    if (runtime.day === day && Number.isFinite(runtime.skippedUntil) && runtime.skippedUntil > lastTick) {
      skippedUntil = Math.min(runtime.skippedUntil, nextLocalMidnight(lastTick));
    }
    if (!skippedUntil && Number.isFinite(runtime.snoozedUntil) && runtime.snoozedUntil > lastTick) {
      snoozedKinds = Array.isArray(runtime.snoozedKinds)
        ? KINDS.filter((kind) => runtime.snoozedKinds.includes(kind) && enabled(kind)) : [];
      if (snoozedKinds.length) {
        snoozedUntil = Math.min(runtime.snoozedUntil, lastTick + MAX_MINUTES * MINUTE_MS);
        for (const kind of snoozedKinds) elapsed[kind] = interval(kind);
      }
    }
  }

  function getState() {
    return {
      preferences: { ...prefs },
      pending: pending ? { ...pending, kinds: [...pending.kinds] } : null,
      skippedUntil,
      snoozedUntil,
    };
  }

  const stateSignature = (state) => JSON.stringify({ ...state, snoozedKinds });
  let previousState = stateSignature(getState());
  function publish() {
    const state = getState();
    // Snoozed kinds also affect persistence: an idle break can satisfy stretch
    // while a water snooze stays in place, without changing the visible card.
    const signature = stateSignature(state);
    if (signature !== previousState) {
      previousState = signature;
      if (typeof onChange === 'function') onChange(state);
    }
    return state;
  }

  function removeKinds(kinds) {
    if (pending) {
      pending.kinds = pending.kinds.filter((kind) => !kinds.includes(kind));
      if (!pending.kinds.length) pending = null;
    }
    snoozedKinds = snoozedKinds.filter((kind) => !kinds.includes(kind));
    if (!snoozedKinds.length) snoozedUntil = 0;
  }

  function resetKinds(kinds) {
    for (const kind of kinds) elapsed[kind] = 0;
    removeKinds(kinds);
  }

  function reconcileDay(timestamp) {
    const currentDay = localDay(timestamp);
    if (currentDay !== day) {
      day = currentDay;
      const carrySnoozeUntil = snoozedUntil > timestamp ? snoozedUntil : 0;
      const carrySnoozeKinds = carrySnoozeUntil ? [...snoozedKinds] : [];
      resetKinds(KINDS);
      skippedUntil = 0;
      if (carrySnoozeKinds.length) {
        snoozedUntil = carrySnoozeUntil;
        snoozedKinds = carrySnoozeKinds;
        for (const kind of snoozedKinds) elapsed[kind] = interval(kind);
      }
      return true;
    }
    if (skippedUntil && skippedUntil <= timestamp) skippedUntil = 0;
    return false;
  }

  function tick({ idleSeconds = 0, paused = false } = {}) {
    const timestamp = now();
    if (!Number.isFinite(timestamp)) return getState();
    const delta = timestamp - lastTick;
    const changedDay = reconcileDay(timestamp);
    lastTick = timestamp;
    const longGap = delta > MAX_TICK_GAP_MS;
    if (delta < 0) {
      resetKinds(KINDS);
      pausedSince = null;
      wasInactive = false;
      return publish();
    }
    if (longGap) resetKinds(['stretch', 'eyes']);

    const idle = Number.isFinite(Number(idleSeconds)) ? Math.max(0, Number(idleSeconds)) : 0;
    if (paused) {
      if (pausedSince === null) pausedSince = timestamp;
      if (timestamp - pausedSince >= IDLE_BREAK_SECONDS * 1000) resetKinds(['stretch', 'eyes']);
      wasInactive = true;
      return publish();
    }
    if (pausedSince !== null) {
      if (timestamp - pausedSince >= IDLE_BREAK_SECONDS * 1000) resetKinds(['stretch', 'eyes']);
      pausedSince = null;
    }
    if (idle >= IDLE_BREAK_SECONDS) {
      resetKinds(['stretch', 'eyes']);
      wasInactive = true;
      return publish();
    }
    const activeDelta = changedDay || longGap || wasInactive ? 0 : Math.max(0, delta);
    wasInactive = false;
    if (!prefs.enabled || skippedUntil > timestamp) return publish();

    for (const kind of KINDS) {
      if (enabled(kind)) elapsed[kind] = Math.min(interval(kind), elapsed[kind] + activeDelta);
    }
    // Snoozing the card defers all kinds, including another kind becoming due.
    if (snoozedUntil > timestamp) return publish();
    snoozedUntil = 0;
    snoozedKinds = [];
    const due = KINDS.filter((kind) => enabled(kind) && elapsed[kind] >= interval(kind));
    if (due.length) {
      if (!pending) pending = { id: `rest-${timestamp}-${++sequence}`, kinds: due, createdAt: timestamp };
      else pending.kinds = KINDS.filter((kind) => pending.kinds.includes(kind) || due.includes(kind));
    }
    return publish();
  }

  function setPreferences(raw) {
    const next = sanitizePreferences({ ...prefs, ...(raw && typeof raw === 'object' ? raw : {}) });
    // Turning reminders back on is an explicit request to resume today too.
    if (!prefs.enabled && next.enabled) skippedUntil = 0;
    const changed = KINDS.filter((kind) => prefs.enabled !== next.enabled
      || prefs[`${kind}Enabled`] !== next[`${kind}Enabled`]
      || prefs[`${kind}Minutes`] !== next[`${kind}Minutes`]);
    prefs = next;
    resetKinds(changed);
    return publish();
  }

  function act({ id, action } = {}) {
    const timestamp = now();
    reconcileDay(timestamp);
    if (!pending || id !== pending.id) return { ok: false, reason: 'stale-reminder', state: publish() };
    if (!['done', 'snooze', 'skip-today'].includes(action)) {
      return { ok: false, reason: 'invalid-action', state: getState() };
    }
    const kinds = [...pending.kinds];
    pending = null;
    if (action === 'done') resetKinds(kinds);
    if (action === 'snooze') {
      snoozedKinds = kinds;
      snoozedUntil = timestamp + prefs.snoozeMinutes * MINUTE_MS;
    }
    if (action === 'skip-today') {
      resetKinds(KINDS);
      skippedUntil = nextLocalMidnight(timestamp);
    }
    lastTick = timestamp;
    return { ok: true, state: publish() };
  }

  function serialize() {
    return { version: 1, day, skippedUntil, snoozedUntil, snoozedKinds: [...snoozedKinds] };
  }

  return { tick, getState, setPreferences, act, serialize };
}

module.exports = { createRestReminderController, IDLE_BREAK_SECONDS, MAX_TICK_GAP_MS, SNOOZE_MS };
