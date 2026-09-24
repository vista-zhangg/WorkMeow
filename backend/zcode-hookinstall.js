'use strict';

// Merge-safe ZCode hook installer.
//
// ZCode stores hooks in ~/.zcode/cli/config.json under a top-level `hooks` key
// shaped differently from Claude Code's settings.json:
//   { enabled?, timeoutMs?, maxOutputBytes?, events: { <Event>: [ { matcher?, hooks: [...] } ] } }
// Configuration-file hooks are DISABLED by default in ZCode — the runner only
// exists when `hooks.enabled` is true or a plugin contributes a hook — so
// registering also flips that flag.
//
// ZCode supports exactly seven hook events and two hook types. We use the
// `process` type (an argv vector, no shell): the doc-recommended portable
// choice, immune to Windows cmd quoting rules. ELECTRON_RUN_AS_NODE cannot be
// injected into a process hook's environment, so the argv wraps PowerShell
// (launched by absolute path) around the same run-as-node invocation the other
// installers build — see backend/hook-runtime.js.
//
// Only entries whose command/args contain our MARKER are ever touched; every
// other hook the user has is preserved. Writes are atomic; uninstall backs the
// file up. ZCode fires no SessionEnd/Notification/PreCompact events, so the
// pet never receives them for this source (hook-common simply never maps them).

const fs = require('fs');
const os = require('os');
const path = require('path');
const hookRuntime = require('./hook-runtime');

const CONFIG_PATH = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const DETECT_PATH = path.join(os.homedir(), '.zcode');
const HOOK_SCRIPT = hookRuntime.runtimeHookPath('zcode-hook.js');
const MARKER = 'zcode-hook.js';

// The exact event set ZCode's hook runner supports — anything else is
// unsupported and dropped by ZCode itself.
const COMMAND_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Stop',
]);

const STATE_TIMEOUT_MS = 5000;

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powershellExecutable() {
  if (process.platform !== 'win32') return 'powershell';
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Same launch string as hook-runtime.buildHookCommand, minus the event argv:
// ZCode hooks read the event name from stdin instead.
function buildProcessHook(runtime = hookRuntime.readHookRuntime()) {
  if (!runtime) throw new Error('portable hook runtime is not staged');
  const launch = (runtime.runAsNode ? "$env:ELECTRON_RUN_AS_NODE='1'; " : '')
    + `& ${psQuote(runtime.executable)} ${psQuote(HOOK_SCRIPT)}`;
  return {
    type: 'process',
    command: powershellExecutable(),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launch],
    timeoutMs: STATE_TIMEOUT_MS,
  };
}

function isOurHook(hook) {
  const haystack = [hook && hook.command, ...((hook && hook.args) || [])]
    .filter((v) => typeof v === 'string').join(' ');
  return haystack.includes(MARKER);
}

function createZcodeHookInstaller(options = {}) {
  const configPath = options.configPath || CONFIG_PATH;
  const detectPath = options.detectPath || DETECT_PATH;
  const injectedRuntime = options.runtime || null; // tests: hermetic runtime manifest

  function readConfig() {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw new Error(`read ${path.basename(configPath)}: ${err.message}`);
    }
  }

  function writeAtomic(obj) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, configPath);
  }

  function registerHooks() {
    const desired = buildProcessHook(injectedRuntime || undefined);
    const config = readConfig();
    if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
    const hooksCfg = config.hooks;
    if (!hooksCfg.events || typeof hooksCfg.events !== 'object') hooksCfg.events = {};
    if (hooksCfg.enabled !== true) hooksCfg.enabled = true; // config-file hooks are off by default
    const result = { added: 0, updated: 0, skipped: 0 };

    for (const event of COMMAND_EVENTS) {
      if (!Array.isArray(hooksCfg.events[event])) hooksCfg.events[event] = [];
      let touched = false;
      for (const group of hooksCfg.events[event]) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue;
        const ours = group.hooks.filter(isOurHook);
        if (!ours.length) continue;
        touched = true;
        // ZCode's schema rejects `matcher: ""` (min 1 char) and rejects the
        // whole config file over it — an omitted matcher is the documented
        // catch-all. Heal groups an earlier AgentPaw install wrote broken.
        if (group.matcher === '') {
          delete group.matcher;
          result.updated++;
        }
        for (const hook of ours) {
          const before = JSON.stringify(hook);
          // Refresh only our own fields; keep the group's matcher and any
          // user-added keys on the entry itself.
          hook.type = desired.type;
          hook.command = desired.command;
          hook.args = desired.args.slice();
          hook.timeoutMs = desired.timeoutMs;
          if (JSON.stringify(hook) === before) result.skipped++;
          else result.updated++;
        }
      }
      if (!touched) {
        // No matcher key at all: ZCode treats an omitted matcher as
        // match-everything (an empty string would invalidate the file).
        hooksCfg.events[event].push({ hooks: [{ ...desired, args: desired.args.slice() }] });
        result.added++;
      }
    }

    writeAtomic(config);
    return result;
  }

  function unregisterHooks(options = {}) {
    let config;
    try { config = readConfig(); } catch { return { removed: 0 }; }
    const hooksCfg = config.hooks;
    if (!hooksCfg || typeof hooksCfg !== 'object' || !hooksCfg.events
      || typeof hooksCfg.events !== 'object') return { removed: 0 };
    let removed = 0;
    for (const event of Object.keys(hooksCfg.events)) {
      const list = hooksCfg.events[event];
      if (!Array.isArray(list)) continue;
      const groups = [];
      for (const group of list) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { groups.push(group); continue; }
        const kept = group.hooks.filter((hook) => {
          if (isOurHook(hook)) { removed++; return false; }
          return true;
        });
        if (kept.length) groups.push({ ...group, hooks: kept });
      }
      if (groups.length) hooksCfg.events[event] = groups;
      else delete hooksCfg.events[event];
    }
    if (!removed) return { removed: 0 };
    let backupPath = null;
    if (options.backup) {
      try {
        backupPath = `${configPath}.pet-backup-${Date.now()}.bak`;
        fs.copyFileSync(configPath, backupPath);
      } catch { backupPath = null; }
    }
    // Once no hook groups remain, the whole block is inert in ZCode (enabled
    // alone does nothing) — drop it instead of leaving `{ enabled: true }`
    // cruft behind. Non-empty blocks keep whatever the user had.
    if (Object.keys(hooksCfg.events).length === 0) delete config.hooks;
    writeAtomic(config);
    return { removed, backupPath };
  }

  function hooksCurrent() {
    try {
      const config = readConfig();
      const events = config.hooks && config.hooks.events;
      if (!events || typeof events !== 'object') return false;
      return COMMAND_EVENTS.every((event) => Array.isArray(events[event])
        && events[event].some((group) => Array.isArray(group && group.hooks)
          && group.hooks.some(isOurHook)));
    } catch {
      return false;
    }
  }

  return {
    registerHooks,
    unregisterHooks,
    hooksCurrent,
    buildProcessHook,
    isOurHook,
    COMMAND_EVENTS,
    SETTINGS_PATH: configPath,
    HOOK_SCRIPT,
    MARKER,
    INTEGRATION_ID: 'zcode',
    INTEGRATION_LABEL: 'ZCode',
    DETECT_PATH: detectPath,
  };
}

const defaultInstaller = createZcodeHookInstaller();

// CLI: `node backend/zcode-hookinstall.js` installs; `--uninstall` removes.
if (require.main === module) {
  if (process.argv.includes('--uninstall')) {
    console.log(defaultInstaller.unregisterHooks({ backup: true }));
  } else {
    hookRuntime.stageHookRuntime();
    console.log(defaultInstaller.registerHooks());
  }
}

module.exports = {
  createZcodeHookInstaller,
  registerHooks: (...args) => defaultInstaller.registerHooks(...args),
  unregisterHooks: (...args) => defaultInstaller.unregisterHooks(...args),
  hooksCurrent: (...args) => defaultInstaller.hooksCurrent(...args),
  SETTINGS_PATH: CONFIG_PATH,
  HOOK_SCRIPT,
  MARKER,
  INTEGRATION_ID: 'zcode',
  INTEGRATION_LABEL: 'ZCode',
  DETECT_PATH,
  COMMAND_EVENTS,
};
