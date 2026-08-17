'use strict';

// Small, provider-agnostic helpers shared by the pet renderer and regression
// tests. The backend already merges every supported AI tool into one snapshot;
// these helpers deliberately consume only that merged contract.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkMeowPetInsights = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  const BUSY_STATES = Object.freeze(['working', 'juggling', 'sweeping', 'thinking', 'loafing']);
  const STATE_PRIORITY = Object.freeze({
    waiting: 0,
    error: 1,
    needsinput: 2,
    sweeping: 3,
    juggling: 4,
    working: 5,
    thinking: 6,
    loafing: 7,
  });

  function number(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function sessionsOf(stats) {
    return Array.isArray(stats && stats.sessions)
      ? stats.sessions.filter((session) => session && !session.headless && session.state !== 'sleeping')
      : [];
  }

  function countOf(stats, key, state) {
    const value = stats && stats[key];
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
      return Math.max(0, Number(value));
    }
    return sessionsOf(stats).filter((session) => session.state === state).length;
  }

  function primaryActive(sessions) {
    return sessions
      .filter((session) => BUSY_STATES.includes(session.state))
      .slice()
      .sort((a, b) => {
        const pa = STATE_PRIORITY[a.state] == null ? 99 : STATE_PRIORITY[a.state];
        const pb = STATE_PRIORITY[b.state] == null ? 99 : STATE_PRIORITY[b.state];
        if (pa !== pb) return pa - pb;
        return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
      })[0] || null;
  }

  // Return semantic state only. User-facing copy stays in shared/i18n.js so
  // the renderer remains the sole owner of presentation and localization.
  function context(stats, options = {}) {
    const sessions = sessionsOf(stats);
    const waiting = countOf(stats, 'waitingCount', 'waiting');
    const needsinput = countOf(stats, 'needsinputCount', 'needsinput');
    const error = countOf(stats, 'errorCount', 'error');
    const sweeping = countOf(stats, 'sweepingCount', 'sweeping');
    const juggling = countOf(stats, 'jugglingCount', 'juggling');
    const working = countOf(stats, 'workingCount', 'working');
    const thinking = countOf(stats, 'thinkingCount', 'thinking');
    const loafing = countOf(stats, 'loafingCount', 'loafing');
    const activeCount = sweeping + juggling + working + thinking + loafing;
    const primary = primaryActive(sessions);
    const sleepMs = Number.isFinite(Number(options.sleepMs)) ? Number(options.sleepMs) : 6 * 60 * 1000;
    const idleMs = stats && stats.idleMs;
    const sleeping = idleMs == null || Number(idleMs) > sleepMs;
    // Only an explicit per-session completion badge means “done”. The global
    // idle timer also becomes very small on startup and on watcher refreshes,
    // so it is not evidence that a turn just completed.
    const recentDone = sessions.some((session) => session.state === 'idle' && session.badge === 'done');

    if (waiting > 0) return { kind: 'waiting', state: 'waiting', count: waiting, needsinput, error, activeCount, primary, sleeping, recentDone };
    if (error > 0) return { kind: 'error', state: 'error', count: error, waiting, needsinput, activeCount, primary, sleeping, recentDone };
    if (needsinput > 0) return { kind: 'needsinput', state: 'needsinput', count: needsinput, waiting, error, activeCount, primary, sleeping, recentDone };
    if (sweeping > 0) return { kind: 'active', state: 'sweeping', count: activeCount, waiting, needsinput, error, activeCount, primary, sleeping, recentDone };
    if (juggling > 0) return { kind: 'active', state: 'juggling', count: activeCount, waiting, needsinput, error, activeCount, primary, sleeping, recentDone };
    if (working > 0) return { kind: 'active', state: 'working', count: activeCount, waiting, needsinput, error, activeCount, primary, sleeping, recentDone };
    if (thinking > 0) return { kind: 'active', state: 'thinking', count: activeCount, waiting, needsinput, error, activeCount, primary, sleeping, recentDone };
    if (loafing > 0) return { kind: 'active', state: 'loafing', count: activeCount, waiting, needsinput, error, activeCount, primary, sleeping, recentDone };
    return { kind: sleeping ? 'sleeping' : 'idle', state: sleeping ? 'sleeping' : 'idle', count: 0, waiting, needsinput, error, activeCount, primary, sleeping, recentDone };
  }

  function usage(stats) {
    const today = (stats && stats.today) || {};
    const cacheRead = Math.max(0, number(today.cacheRead) || number(today.cachedInput));
    const cacheWrite5m = Math.max(0, number(today.cacheWrite5m) || number(today.cacheWrite));
    const cacheWrite1h = Math.max(0, number(today.cacheWrite1h));
    const hasInputTotal = today.inputTotal !== undefined && today.inputTotal !== null
      && Number.isFinite(Number(today.inputTotal));
    const inputTotal = hasInputTotal
      ? Math.max(0, Number(today.inputTotal))
      : Math.max(0, number(today.input) + cacheRead + cacheWrite5m + cacheWrite1h);
    return {
      rounds: Math.max(0, number(today.messages) || number(today.msgs)),
      tokens: number(today.tokens),
      cost: number(today.cost),
      cacheRead,
      inputTotal,
      cacheRate: inputTotal > 0 ? Math.min(100, (cacheRead / inputTotal) * 100) : null,
    };
  }

  function hasActiveWork(stats, options = {}) {
    const info = context(stats, options);
    return info.waiting > 0 || info.needsinput > 0 || info.error > 0 || info.activeCount > 0;
  }

  return { BUSY_STATES, context, usage, hasActiveWork };
});
