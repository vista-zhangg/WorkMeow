'use strict';

// Live Codex subscription quota via the official Codex App Server.
//
// This intentionally does not share code or state with codex-metering.js:
// metering reads local rollout token history, while this module owns one
// long-lived authenticated App Server connection and only consumes the
// account/rateLimits protocol.

const fs = require('fs');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
const { statePath } = require('./paths');
const { resolveCodexCommand, defaultCodexHome } = require('./codex-cli-resolver');
const { createCodexAccountWatch } = require('./codex-account-watch');

const FIVE_HOUR_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const AMBER_REMAINING_PERCENT = 20;
const RED_REMAINING_PERCENT = 5;
const DEFAULT_RETRY_MS = 1000;
const MAX_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const DEFAULT_POLL_MS = 30 * 1000;
const DEFAULT_SESSION_MAX_AGE_MS = 15 * 60 * 1000;
const ALERT_FILE = statePath('codex-rate-limit-alerts.json');

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mergeWindow(previous, incoming) {
  if (incoming === null) return null;
  if (!incoming || typeof incoming !== 'object') return previous || null;
  return { ...(previous && typeof previous === 'object' ? previous : {}), ...incoming };
}

function mergeLimit(previous, incoming) {
  if (incoming === null) return null;
  if (!incoming || typeof incoming !== 'object') return previous || null;
  const out = { ...(previous && typeof previous === 'object' ? previous : {}), ...incoming };
  for (const slot of ['primary', 'secondary']) {
    if (Object.prototype.hasOwnProperty.call(incoming, slot)) {
      out[slot] = mergeWindow(previous && previous[slot], incoming[slot]);
    }
  }
  return out;
}

// Notifications may contain only the window that changed. Preserve fields
// from the initial read unless the server explicitly sends null.
function mergeRateLimitPayload(previous, incoming, replace = false) {
  const base = replace || !previous || typeof previous !== 'object' ? {} : previous;
  if (!incoming || typeof incoming !== 'object') return base;
  const out = { ...base, ...incoming };

  if (Object.prototype.hasOwnProperty.call(incoming, 'rateLimits')) {
    out.rateLimits = mergeLimit(base.rateLimits, incoming.rateLimits);
  }

  if (Object.prototype.hasOwnProperty.call(incoming, 'rateLimitsByLimitId')) {
    if (incoming.rateLimitsByLimitId === null) {
      out.rateLimitsByLimitId = null;
    } else if (incoming.rateLimitsByLimitId && typeof incoming.rateLimitsByLimitId === 'object') {
      const previousById = base.rateLimitsByLimitId && typeof base.rateLimitsByLimitId === 'object'
        ? base.rateLimitsByLimitId
        : {};
      const nextById = { ...previousById };
      for (const [limitId, limit] of Object.entries(incoming.rateLimitsByLimitId)) {
        nextById[limitId] = mergeLimit(previousById[limitId], limit);
      }
      out.rateLimitsByLimitId = nextById;
    }
  }
  return out;
}

function canonicalLimit(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const byId = payload.rateLimitsByLimitId;
  if (byId && typeof byId === 'object' && byId.codex && typeof byId.codex === 'object') {
    return byId.codex;
  }
  if (payload.rateLimits && typeof payload.rateLimits === 'object') return payload.rateLimits;
  return null;
}

function normalizeWindow(raw, limitId) {
  if (!raw || typeof raw !== 'object') return null;
  const windowDurationMins = finite(raw.windowDurationMins);
  if (windowDurationMins === null) return null;
  const usedPercent = finite(raw.usedPercent);
  const resetsAt = finite(raw.resetsAt);
  return {
    // Duration is the stable logical window identity even when a server/plan
    // moves it between primary and secondary slots.
    windowId: `${limitId || 'codex'}:${windowDurationMins}`,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    windowDurationMins,
    resetsAt,
  };
}

function severityFor(windows) {
  const remaining = Object.values(windows)
    .map((window) => window && window.remainingPercent)
    .filter((value) => value !== null && value !== undefined && Number.isFinite(value));
  if (!remaining.length) return 'unavailable';
  const lowest = Math.min(...remaining);
  if (lowest <= RED_REMAINING_PERCENT) return 'red';
  if (lowest <= AMBER_REMAINING_PERCENT) return 'amber';
  return 'neutral';
}

function normalizeAccount(payload) {
  const raw = payload && typeof payload === 'object' ? payload.account : null;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'chatgpt') {
    return {
      type: 'chatgpt',
      email: typeof raw.email === 'string' && raw.email ? raw.email : null,
      planType: typeof raw.planType === 'string' && raw.planType ? raw.planType : null,
    };
  }
  if (raw.type === 'apiKey') return { type: 'apiKey', email: null, planType: null };
  if (raw.type === 'amazonBedrock') return { type: 'amazonBedrock', email: null, planType: null };
  return { type: String(raw.type || 'unknown'), email: null, planType: null };
}

function accountFingerprint(account) {
  if (!account) return 'none';
  return `${account.type || ''}|${account.email || ''}|${account.planType || ''}`;
}

function normalizeRateLimits(payload, updatedAt = Date.now(), account = null, source = null) {
  const limit = canonicalLimit(payload);
  const limitId = limit && typeof limit.limitId === 'string' && limit.limitId ? limit.limitId : 'codex';
  const slots = limit ? [
    normalizeWindow(limit.primary, limitId),
    normalizeWindow(limit.secondary, limitId),
  ].filter(Boolean) : [];
  const findDuration = (duration) => slots.find((window) => window.windowDurationMins === duration) || null;
  const windows = {
    fiveHour: findDuration(FIVE_HOUR_MINS),
    weekly: findDuration(WEEK_MINS),
  };
  return {
    status: 'ready',
    windows,
    severity: severityFor(windows),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    account,
    source,
    error: null,
  };
}

function unavailableState(status = 'unavailable', error = null, account = null, source = null) {
  return {
    status,
    windows: { fiveHour: null, weekly: null },
    severity: 'unavailable',
    updatedAt: null,
    account,
    source,
    error,
  };
}

function readAlertRecords(file) {
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter((record) => record && typeof record.key === 'string'
      && Number.isFinite(record.resetsAt));
  } catch {
    return [];
  }
}

function writeAlertRecords(file, records) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), `.codex-rate-limit-alerts.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify({ records }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch {}
}

function createAlertDeduper(options = {}) {
  const file = Object.prototype.hasOwnProperty.call(options, 'file') ? options.file : ALERT_FILE;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let records = readAlertRecords(file);
  const seen = new Set(records.map((record) => record.key));

  function keyFor(window) {
    if (!window || typeof window.windowId !== 'string' || !window.windowId) return false;
    if (!Number.isFinite(window.resetsAt)) return false;
    return `${window.windowId}|${window.resetsAt}`;
  }

  function has(window) {
    const key = keyFor(window);
    return !!key && seen.has(key);
  }

  function claim(window) {
    const key = keyFor(window);
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    records.push({ key, resetsAt: window.resetsAt });
    const cutoff = Math.floor(now() / 1000) - WEEK_MINS * 60;
    records = records.filter((record) => record.resetsAt >= cutoff).slice(-64);
    writeAlertRecords(file, records);
    return true;
  }

  return { keyFor, has, claim, records: () => records.slice() };
}

function createCodexRateLimits(options = {}) {
  const spawn = typeof options.spawn === 'function' ? options.spawn : nodeSpawn;
  const resolveCommand = typeof options.resolveCommand === 'function'
    ? options.resolveCommand
    : () => resolveCodexCommand({ command: options.command, env: options.env });
  const version = options.version || '0.0.0';
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const onAlert = typeof options.onAlert === 'function' ? options.onAlert : () => {};
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? options.requestTimeoutMs
    : REQUEST_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? options.pollIntervalMs
    : DEFAULT_POLL_MS;
  const sessionMaxAgeMs = Number.isFinite(options.sessionMaxAgeMs)
    ? options.sessionMaxAgeMs
    : DEFAULT_SESSION_MAX_AGE_MS;
  const deduper = createAlertDeduper({
    file: Object.prototype.hasOwnProperty.call(options, 'dedupePath') ? options.dedupePath : ALERT_FILE,
    now,
  });

  let state = unavailableState('idle');
  let rawPayload = {};
  let account = null;
  let accountKey = 'none';
  let commandSource = null;
  let child = null;
  let stopped = true;
  let initialized = false;
  let generation = 0;
  let requestId = 0;
  let initializeId = null;
  let accountReadId = null;
  let readId = null;
  let lineBuffer = '';
  let retryMs = DEFAULT_RETRY_MS;
  let retryTimer = null;
  let requestTimer = null;
  let pollTimer = null;
  let recycleTimer = null;
  let syncQueued = false;
  const pendingAlerts = new Map();

  const accountWatch = options.watchAccount === false
    ? null
    : (options.accountWatch || createCodexAccountWatch({
      codexHome: options.codexHome || defaultCodexHome(options.env),
      onChange: () => restartForAccountChange(),
    }));

  function publish(next) {
    state = next;
    try { onUpdate(state); } catch {}
  }

  function emitAlerts(next) {
    for (const [kind, window] of Object.entries(next.windows || {})) {
      if (!window || !Number.isFinite(window.remainingPercent)) continue;
      if (window.remainingPercent > AMBER_REMAINING_PERCENT) continue;
      const alertId = deduper.keyFor(window);
      if (!alertId || deduper.has(window) || pendingAlerts.has(alertId)) continue;
      pendingAlerts.set(alertId, window);
      try {
        // The UI acknowledges only after the bubble is actually visible. Until
        // then this cycle remains unclaimed and can be retried after a restart.
        onAlert({ kind, ...window, alertId });
      } catch {
        pendingAlerts.delete(alertId);
      }
    }
  }

  function acknowledgeAlert(alertId) {
    const window = typeof alertId === 'string' ? pendingAlerts.get(alertId) : null;
    if (!window) return false;
    if (!deduper.claim(window) && !deduper.has(window)) return false;
    pendingAlerts.delete(alertId);
    return true;
  }

  function accept(payload, replace) {
    rawPayload = mergeRateLimitPayload(rawPayload, payload, replace);
    const next = normalizeRateLimits(rawPayload, now(), account, commandSource);
    publish(next);
    emitAlerts(next);
  }

  function send(message) {
    if (!child || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function clearRequestTimer() {
    if (requestTimer) clearTimer(requestTimer);
    requestTimer = null;
  }

  function clearSyncTimers() {
    clearRequestTimer();
    if (pollTimer) clearTimer(pollTimer);
    if (recycleTimer) clearTimer(recycleTimer);
    pollTimer = null;
    recycleTimer = null;
  }

  function armRequestTimeout(expectedId, phase, currentGeneration) {
    clearRequestTimer();
    requestTimer = setTimer(() => {
      requestTimer = null;
      if (stopped || currentGeneration !== generation) return;
      const pending = phase === 'initialize'
        ? initializeId
        : (phase === 'account' ? accountReadId : readId);
      if (pending !== expectedId) return;
      if (phase === 'account') accountReadId = null;
      if (phase === 'read') readId = null;
      publish(unavailableState('unavailable', `${phase}-timeout`, account, commandSource));
      if (phase === 'initialize' && child) {
        try { child.kill(); } catch {}
      }
    }, requestTimeoutMs);
    if (requestTimer && typeof requestTimer.unref === 'function') requestTimer.unref();
  }

  function requestAccount(currentGeneration = generation) {
    if (!child || !initialized) return;
    if (accountReadId !== null || readId !== null) {
      syncQueued = true;
      return;
    }
    accountReadId = ++requestId;
    if (!send({ method: 'account/read', id: accountReadId, params: { refreshToken: false } })) {
      accountReadId = null;
      publish(unavailableState('unavailable', 'app-server-stdio-unavailable', account, commandSource));
      if (child) try { child.kill(); } catch {}
      return;
    }
    armRequestTimeout(accountReadId, 'account', currentGeneration);
  }

  function requestRead(currentGeneration = generation) {
    if (!child || readId !== null) return;
    readId = ++requestId;
    if (!send({ method: 'account/rateLimits/read', id: readId })) {
      readId = null;
      publish(unavailableState('unavailable', 'app-server-stdio-unavailable', account, commandSource));
      if (child) try { child.kill(); } catch {}
      return;
    }
    armRequestTimeout(readId, 'read', currentGeneration);
  }

  function completeSync(currentGeneration) {
    if (!syncQueued || currentGeneration !== generation || stopped) return;
    syncQueued = false;
    requestAccount(currentGeneration);
  }

  function schedulePoll(currentGeneration) {
    if (pollTimer || stopped || pollIntervalMs <= 0) return;
    pollTimer = setTimer(() => {
      pollTimer = null;
      if (currentGeneration !== generation || stopped) return;
      requestAccount(currentGeneration);
      schedulePoll(currentGeneration);
    }, pollIntervalMs);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function scheduleRecycle(currentGeneration) {
    if (recycleTimer || stopped || sessionMaxAgeMs <= 0) return;
    recycleTimer = setTimer(() => {
      recycleTimer = null;
      if (currentGeneration !== generation || stopped) return;
      restartForAccountChange();
    }, sessionMaxAgeMs);
    if (recycleTimer && typeof recycleTimer.unref === 'function') recycleTimer.unref();
  }

  function handleMessage(message, currentGeneration) {
    if (!message || typeof message !== 'object' || currentGeneration !== generation) return;

    if (initializeId !== null && message.id === initializeId) {
      clearRequestTimer();
      initializeId = null;
      if (message.error || !message.result) {
        publish(unavailableState('unavailable', 'initialize-failed', account, commandSource));
        if (child) try { child.kill(); } catch {}
        return;
      }
      retryMs = DEFAULT_RETRY_MS;
      initialized = true;
      if (!send({ method: 'initialized', params: {} })) {
        publish(unavailableState('unavailable', 'app-server-stdio-unavailable', account, commandSource));
        if (child) try { child.kill(); } catch {}
        return;
      }
      requestAccount(currentGeneration);
      schedulePoll(currentGeneration);
      scheduleRecycle(currentGeneration);
      return;
    }

    if (accountReadId !== null && message.id === accountReadId) {
      clearRequestTimer();
      accountReadId = null;
      if (message.error || !message.result || typeof message.result !== 'object') {
        account = null;
        accountKey = 'none';
        rawPayload = {};
        publish(unavailableState('unavailable', 'account-unavailable', null, commandSource));
        completeSync(currentGeneration);
        return;
      }
      const nextAccount = normalizeAccount(message.result);
      const nextAccountKey = accountFingerprint(nextAccount);
      if (nextAccountKey !== accountKey) {
        rawPayload = {};
        account = nextAccount;
        accountKey = nextAccountKey;
        publish(unavailableState('connecting', null, account, commandSource));
      } else {
        account = nextAccount;
      }
      if (!account) {
        rawPayload = {};
        publish(unavailableState('unavailable', 'not-signed-in', null, commandSource));
        completeSync(currentGeneration);
        return;
      }
      if (account.type !== 'chatgpt') {
        rawPayload = {};
        publish(unavailableState('unavailable', 'chatgpt-account-required', account, commandSource));
        completeSync(currentGeneration);
        return;
      }
      requestRead(currentGeneration);
      return;
    }

    if (readId !== null && message.id === readId) {
      clearRequestTimer();
      readId = null;
      if (message.error || !message.result || typeof message.result !== 'object') {
        publish(unavailableState('unavailable', 'rate-limits-unavailable', account, commandSource));
        completeSync(currentGeneration);
        return;
      }
      accept(message.result, true);
      completeSync(currentGeneration);
      return;
    }

    if (message.method === 'account/rateLimits/updated') {
      if (message.params && typeof message.params === 'object') accept(message.params, false);
      return;
    }

    if (message.method === 'account/updated') {
      // Never leave the previous account's quota visible while identity is in
      // transition. The following account/read is authoritative.
      rawPayload = {};
      account = null;
      accountKey = 'none';
      publish(unavailableState('connecting', null, null, commandSource));
      requestAccount(currentGeneration);
    }
  }

  function handleStdout(chunk, currentGeneration) {
    if (currentGeneration !== generation) return;
    lineBuffer += chunk.toString('utf8');
    let newline;
    while ((newline = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line), currentGeneration); } catch {}
    }
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const delay = retryMs;
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
    retryTimer = setTimer(() => {
      retryTimer = null;
      launch();
    }, delay);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  function disconnected(currentGeneration, error) {
    if (currentGeneration !== generation) return;
    clearSyncTimers();
    child = null;
    initialized = false;
    initializeId = null;
    accountReadId = null;
    readId = null;
    lineBuffer = '';
    rawPayload = {};
    account = null;
    accountKey = 'none';
    syncQueued = false;
    if (stopped) return;
    publish(unavailableState('unavailable', error || 'app-server-exited', null, commandSource));
    scheduleRetry();
  }

  function restartForAccountChange() {
    if (stopped) return;
    const proc = child;
    generation++;
    clearSyncTimers();
    child = null;
    initialized = false;
    initializeId = null;
    accountReadId = null;
    readId = null;
    lineBuffer = '';
    rawPayload = {};
    account = null;
    accountKey = 'none';
    syncQueued = false;
    publish(unavailableState('connecting', null, null, commandSource));
    if (proc) {
      try { proc.stdin.end(); } catch {}
      try { proc.kill(); } catch {}
    }
    launch();
  }

  function launch() {
    if (stopped || child) return;
    const currentGeneration = ++generation;
    rawPayload = {};
    lineBuffer = '';
    initialized = false;
    let executable;
    try {
      executable = resolveCommand();
    } catch {
      commandSource = null;
      disconnected(currentGeneration, 'codex-not-found');
      return;
    }
    if (!executable || !executable.command || !Array.isArray(executable.args)) {
      commandSource = null;
      disconnected(currentGeneration, 'codex-not-found');
      return;
    }
    commandSource = executable.source || null;
    publish(unavailableState('connecting', null, null, commandSource));
    let proc;
    try {
      proc = spawn(executable.command, executable.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch {
      disconnected(currentGeneration, 'codex-not-found');
      return;
    }
    child = proc;
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      disconnected(currentGeneration, reason);
    };
    if (proc.stdout && typeof proc.stdout.on === 'function') {
      proc.stdout.on('data', (chunk) => handleStdout(chunk, currentGeneration));
    }
    // App Server diagnostics belong to Codex. Drain stderr so a chatty child
    // can never block on a full pipe, without copying auth-adjacent logs into
    // WorkMeow's UI or persistence.
    if (proc.stderr && typeof proc.stderr.on === 'function') proc.stderr.on('data', () => {});
    if (typeof proc.once === 'function') {
      proc.once('error', () => finish('codex-not-found'));
      proc.once('exit', () => finish('app-server-exited'));
    }
    initializeId = ++requestId;
    if (!send({
      method: 'initialize',
      id: initializeId,
      params: { clientInfo: { name: 'workmeow', title: 'WorkMeow', version } },
    })) {
      try { proc.kill(); } catch {}
      finish('app-server-stdio-unavailable');
      return;
    }
    armRequestTimeout(initializeId, 'initialize', currentGeneration);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    retryMs = DEFAULT_RETRY_MS;
    if (accountWatch) accountWatch.start();
    launch();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation++;
    clearSyncTimers();
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
    if (accountWatch) accountWatch.stop();
    const proc = child;
    child = null;
    initialized = false;
    initializeId = null;
    accountReadId = null;
    readId = null;
    if (proc) {
      try { proc.stdin.end(); } catch {}
      try { proc.kill(); } catch {}
    }
  }

  return {
    start,
    stop,
    acknowledgeAlert,
    getState: () => state,
    _accept: accept,
    _handleMessage: (message) => handleMessage(message, generation),
    _restartForAccountChange: restartForAccountChange,
  };
}

module.exports = {
  FIVE_HOUR_MINS,
  WEEK_MINS,
  AMBER_REMAINING_PERCENT,
  RED_REMAINING_PERCENT,
  DEFAULT_POLL_MS,
  mergeRateLimitPayload,
  normalizeAccount,
  accountFingerprint,
  normalizeRateLimits,
  unavailableState,
  createAlertDeduper,
  createCodexRateLimits,
};
