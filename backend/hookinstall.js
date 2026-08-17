'use strict';

// Merge-safe Claude Code hook installer (original implementation).
//
// Now a thin config over the shared installer base — see backend/hookinstall-base.js.
// Registers, into ~/.claude/settings.json, lifecycle hooks that run our
// workmeow-hook.js, plus one blocking HTTP hook for PermissionRequest.

const os = require('os');
const path = require('path');
const { createInstaller } = require('./hookinstall-base');
const hookRuntime = require('./hook-runtime');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT = hookRuntime.runtimeHookPath('workmeow-hook.js');
const MARKER = 'workmeow-hook.js';

const COMMAND_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'Notification', 'Elicitation',
];

module.exports = createInstaller({
  integrationId: 'claude',
  integrationLabel: 'Claude Code',
  detectPath: path.dirname(SETTINGS_PATH),
  settingsPath: SETTINGS_PATH,
  hookScript: HOOK_SCRIPT,
  marker: MARKER,
  events: COMMAND_EVENTS,
  withPermission: true, // Claude Code supports the blocking PermissionRequest hook
});

// CLI: `node backend/hookinstall.js` installs; `--uninstall` removes.
if (require.main === module) {
  const { readRuntimeConfig } = require('./transport');
  if (process.argv.includes('--uninstall')) {
    console.log(module.exports.unregisterHooks({ backup: true }));
  } else {
    hookRuntime.stageHookRuntime();
    const runtime = readRuntimeConfig();
    console.log(module.exports.registerHooks(runtime && runtime.port, runtime && runtime.token));
  }
}
