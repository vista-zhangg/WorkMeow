'use strict';

// Merge-safe hook installer factory, shared by Claude Code / WorkBuddy / TRAE.
//
// Each tool stores its hooks in a slightly different file:
//   • Claude Code  ~/.claude/settings.json          (hooks at top level)
//   • WorkBuddy    ~/.workbuddy/settings.json        (hooks at top level)
//   • TRAE         ~/.trae-cn/hooks.json             (version:1 + hooks)
// All three use the SAME `hooks` object shape, so one base handles all of them.
// Only entries whose command contains our MARKER (or whose http url is our
// /permission) are ever touched — every other hook the user has is preserved
// byte-for-byte. Writes are atomic (tmp + rename); uninstall backs the file up.

const fs = require('fs');
const path = require('path');
const {
  buildPermissionUrl,
  readRuntimeConfig,
  validToken,
  PORTS,
  BASE_PORT,
} = require('./transport');
const hookRuntime = require('./hook-runtime');
const LEGACY_MARKERS = require('./hook-compat');

function createInstaller(cfg) {
  const SETTINGS_PATH = cfg.settingsPath;
  const HOOK_SCRIPT = cfg.hookScript;
  const MARKER = cfg.marker;
  const COMMAND_EVENTS = cfg.events;
  const WITH_PERMISSION = cfg.withPermission !== false; // Claude only, by default
  const INTEGRATION_ID = cfg.integrationId || MARKER;
  const INTEGRATION_LABEL = cfg.integrationLabel || INTEGRATION_ID;
  const DETECT_PATH = cfg.detectPath || path.dirname(SETTINGS_PATH);

  const STATE_TIMEOUT_S = 5;
  const PERMISSION_TIMEOUT_S = 600;

  function readSettings() {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw new Error(`read ${path.basename(SETTINGS_PATH)}: ${err.message}`);
    }
  }

  function writeAtomic(obj) {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    const tmp = path.join(path.dirname(SETTINGS_PATH), `.${path.basename(SETTINGS_PATH)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, SETTINGS_PATH);
  }

  function commandHook(event) {
    return {
      type: 'command',
      shell: 'powershell',
      command: hookRuntime.buildHookCommand(HOOK_SCRIPT, event),
      timeout: STATE_TIMEOUT_S,
    };
  }

  function isOurCommand(hook) {
    return hook && typeof hook.command === 'string' && hook.command.includes(MARKER);
  }
  function isOurHttp(hook) {
    if (!hook || hook.type !== 'http' || typeof hook.url !== 'string') return false;
    try {
      const url = new URL(hook.url);
      return url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        PORTS.includes(Number(url.port)) &&
        url.pathname === '/permission';
    } catch {
      return false;
    }
  }

  // Only OUR OWN earlier hook name. We deliberately do NOT touch any other
  // app's hooks — removing another tool's hooks is the user's call.
  function isLegacyCommand(hook) {
    return hook && typeof hook.command === 'string' && LEGACY_MARKERS.some((m) => hook.command.includes(m));
  }
  function purgeLegacy(hooks) {
    let removed = 0;
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      const groups = [];
      for (const group of hooks[event]) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { groups.push(group); continue; }
        const kept = group.hooks.filter((h) => {
          if (isLegacyCommand(h)) { removed++; return false; }
          return true;
        });
        if (kept.length) groups.push({ ...group, hooks: kept });
      }
      if (groups.length) hooks[event] = groups;
      else delete hooks[event];
    }
    return removed;
  }

  // Ensure `event` has exactly one of our hooks (matching `match`), kept in sync
  // with `desired`. Leaves all non-matching entries untouched.
  function syncEvent(hooks, event, desired, match) {
    if (!Array.isArray(hooks[event])) {
      const existing = hooks[event];
      hooks[event] = existing && typeof existing === 'object' ? [existing] : [];
    }
    for (const group of hooks[event]) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) {
        if (match(h)) {
          let changed = false;
          for (const k of Object.keys(desired)) {
            if (h[k] !== desired[k]) { h[k] = desired[k]; changed = true; }
          }
          return changed ? 'updated' : 'skipped';
        }
      }
    }
    hooks[event].push({ matcher: '', hooks: [desired] });
    return 'added';
  }

  function registerHooks(port, token) {
    if (!validToken(token)) throw new Error('runtime authentication token unavailable');
    const settings = readSettings();
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    const result = { added: 0, updated: 0, skipped: 0, purged: purgeLegacy(settings.hooks) };

    for (const event of COMMAND_EVENTS) {
      const r = syncEvent(settings.hooks, event, commandHook(event), isOurCommand);
      result[r]++;
    }
    if (WITH_PERMISSION) {
      const httpDesired = { type: 'http', url: buildPermissionUrl(port || BASE_PORT, token), timeout: PERMISSION_TIMEOUT_S };
      const r = syncEvent(settings.hooks, 'PermissionRequest', httpDesired, isOurHttp);
      result[r]++;
    }

    writeAtomic(settings);
    const runtime = hookRuntime.readHookRuntime();
    return { ...result, runner: runtime && runtime.executable };
  }

  function removeOurHooks(hooks) {
    let removed = 0;
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      const groups = [];
      for (const group of hooks[event]) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { groups.push(group); continue; }
        const kept = group.hooks.filter((h) => {
          if (isOurCommand(h) || (WITH_PERMISSION && isOurHttp(h))) { removed++; return false; }
          return true;
        });
        if (kept.length) groups.push({ ...group, hooks: kept });
        else if (typeof group.command === 'string' && !group.command.includes(MARKER)) groups.push(group);
      }
      if (groups.length) hooks[event] = groups;
      else delete hooks[event];
    }
    return removed;
  }

  function unregisterHooks(options = {}) {
    let settings;
    try { settings = readSettings(); } catch { return { removed: 0 }; }
    if (!settings.hooks) return { removed: 0 };
    const removed = removeOurHooks(settings.hooks) + purgeLegacy(settings.hooks);
    if (!removed) return { removed: 0 };
    let backupPath = null;
    if (options.backup) {
      try {
        backupPath = `${SETTINGS_PATH}.pet-backup-${Date.now()}.bak`;
        fs.copyFileSync(SETTINGS_PATH, backupPath);
      } catch { backupPath = null; }
    }
    // Drop an empty hooks object so we don't leave `{ "hooks": {} }` cruft.
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeAtomic(settings);
    return { removed, backupPath };
  }

  function hooksCurrent(port, token) {
    if (!validToken(token)) return false;
    try {
      const settings = readSettings();
      const hooks = settings.hooks || {};
      const commandsOk = COMMAND_EVENTS.every((event) =>
        Array.isArray(hooks[event]) &&
        hooks[event].some((group) => Array.isArray(group && group.hooks) && group.hooks.some(isOurCommand)));
      if (!commandsOk) return false;
      if (!WITH_PERMISSION) return true;
      const desiredUrl = buildPermissionUrl(port || BASE_PORT, token);
      return Array.isArray(hooks.PermissionRequest) &&
        hooks.PermissionRequest.some((group) => Array.isArray(group && group.hooks) &&
          group.hooks.some((hook) => isOurHttp(hook) && hook.url === desiredUrl));
    } catch {
      return false;
    }
  }

  return {
    registerHooks,
    unregisterHooks,
    hooksCurrent,
    SETTINGS_PATH,
    HOOK_SCRIPT,
    MARKER,
    COMMAND_EVENTS,
    INTEGRATION_ID,
    INTEGRATION_LABEL,
    DETECT_PATH,
  };
}

module.exports = { createInstaller };
