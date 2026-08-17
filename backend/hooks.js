'use strict';

// Hook lifecycle for all backends — install/uninstall via the per-tool
// installers, plus a settings watcher that re-registers our hooks if another
// tool (CC-Switch, manual edits, …) overwrites the file without them.
//
// Backends managed:
//   • Claude Code  ~/.claude/settings.json     (hooks.js → hookinstall.js)
//   • TRAE         ~/.trae-cn/hooks.json       (trae-hookinstall.js)
//   • WorkBuddy    ~/.workbuddy/settings.json  (workbuddy-hookinstall.js)
//   • opencode     ~/.config/opencode/plugins/opencode-plugin.js (opencode-install.js)

const fs = require('fs');
const path = require('path');
const cc = require('./hookinstall');
const trae = require('./trae-hookinstall');
const workbuddy = require('./workbuddy-hookinstall');
const opencode = require('./opencode-install');
const hookRuntime = require('./hook-runtime');
const config = require('./config');

// All hook installers. Each module owns its settings path and merge policy.
const INSTALLERS = [
  cc,
  trae,
  workbuddy,
  opencode,
];

function installOne(mod, port, token) {
  try {
    const r = mod.registerHooks(port, token);
    return r;
  } catch {
    return null;
  }
}

function uninstallOne(mod) {
  try {
    const r = mod.unregisterHooks({ backup: true });
    return r;
  } catch {
    return null;
  }
}

function isDetected(mod) {
  try { return fs.existsSync(mod.DETECT_PATH || path.dirname(mod.SETTINGS_PATH)); } catch { return false; }
}

function integrationStatus(port, token) {
  return INSTALLERS.map((mod) => {
    const detected = isDetected(mod);
    let connected = false;
    if (detected) {
      try { connected = mod.hooksCurrent(port, token); } catch {}
    }
    return {
      id: mod.INTEGRATION_ID,
      label: mod.INTEGRATION_LABEL,
      detected,
      connected,
    };
  });
}

function install(port, token) {
  config.save({ hooksEnabled: true });
  const runtime = hookRuntime.stageHookRuntime();
  const results = [];
  for (const mod of INSTALLERS) {
    results.push(isDetected(mod) ? installOne(mod, port, token) : null);
  }
  return { runtime, results, integrations: integrationStatus(port, token) };
}

function uninstall() {
  config.save({ hooksEnabled: false });
  const results = INSTALLERS.map(uninstallOne);
  if (results.every((result) => result !== null)) hookRuntime.removeHookRuntime();
  return results;
}

// Watch each settings directory; re-register our hooks if the file is
// overwritten without them (atomic renames swap the inode, so watch the dir).
function startWatcher(getRuntime) {
  const closers = [];
  const watched = new Set();
  let stopped = false;

  const attach = (mod) => {
    if (stopped || config.reload().hooksEnabled === false || watched.has(mod) || !isDetected(mod)) return;
    const settingsPath = mod.SETTINGS_PATH;
    const dir = path.dirname(settingsPath);
    const basename = path.basename(settingsPath);
    const runtime = getRuntime();
    if (runtime && !mod.hooksCurrent(runtime.port, runtime.token)) {
      installOne(mod, runtime.port, runtime.token);
    }
    if (!fs.existsSync(dir)) return;
    let debounce = null;
    try {
      const watcher = fs.watch(dir, (_e, filename) => {
        if (filename && filename !== basename) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (config.reload().hooksEnabled === false) return;
          const current = getRuntime();
          if (!current || !mod.hooksCurrent(current.port, current.token)) {
            if (current) installOne(mod, current.port, current.token);
          }
        }, 800);
        if (debounce.unref) debounce.unref();
      });
      watched.add(mod);
      closers.push(() => {
        if (debounce) clearTimeout(debounce);
        try { watcher.close(); } catch {}
      });
    } catch {}
  };

  for (const mod of INSTALLERS) {
    attach(mod);
  }
  const detectTimer = setInterval(() => {
    for (const mod of INSTALLERS) attach(mod);
  }, 15000);
  if (detectTimer.unref) detectTimer.unref();
  return () => {
    stopped = true;
    clearInterval(detectTimer);
    for (const close of closers) close();
  };
}

module.exports = {
  install,
  uninstall,
  startWatcher,
  integrationStatus,
  isDetected,
  hooksCurrent: cc.hooksCurrent,
  SETTINGS_PATH: cc.SETTINGS_PATH,
};
