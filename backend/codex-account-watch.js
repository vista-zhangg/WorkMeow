'use strict';

// Account changes made by another Codex App Server are process-external, so
// its account/updated notification cannot reach our stdio connection. Watch
// only the auth store's directory entry (never its contents) and ask our App
// Server client to reconnect when Codex replaces it.

const fs = require('fs');
const path = require('path');
const { defaultCodexHome } = require('./codex-cli-resolver');

const AUTH_STORE_BASENAME = 'auth.json';
const DEFAULT_DEBOUNCE_MS = 750;

function isAuthStoreEvent(filename) {
  if (filename === null || filename === undefined) return true;
  const name = path.basename(String(filename)).toLowerCase();
  return name === AUTH_STORE_BASENAME || name.startsWith(`${AUTH_STORE_BASENAME}.`);
}

function createCodexAccountWatch(options = {}) {
  const watch = typeof options.watch === 'function' ? options.watch : fs.watch;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const codexHome = options.codexHome || defaultCodexHome(options.env);
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
  let watcher = null;
  let timer = null;

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
    if (watcher) {
      try { watcher.close(); } catch {}
    }
    watcher = null;
  }

  function start() {
    if (watcher) return true;
    try {
      watcher = watch(codexHome, { persistent: false }, (_eventType, filename) => {
        if (!isAuthStoreEvent(filename)) return;
        if (timer) clearTimer(timer);
        timer = setTimer(() => {
          timer = null;
          try { onChange(); } catch {}
        }, debounceMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      });
      if (watcher && typeof watcher.on === 'function') watcher.on('error', () => stop());
      return true;
    } catch {
      watcher = null;
      return false;
    }
  }

  return { start, stop };
}

module.exports = {
  AUTH_STORE_BASENAME,
  isAuthStoreEvent,
  createCodexAccountWatch,
};
