'use strict';

// Merge-safe WorkBuddy hook installer.
//
// Writes lifecycle hooks into ~/.workbuddy/settings.json (same `hooks` shape as
// Claude Code). WorkBuddy does NOT use the blocking PermissionRequest hook — the
// pet just monitors WorkBuddy's activity, it doesn't approve actions for it.
//
// WorkBuddy's hook vocabulary is a SUPERSET of Claude Code's. We subscribe to
// ElicitationResult on top of the shared set because it is WorkBuddy's only
// explicit "the user answered, the wait is over" signal — without it the cat
// keeps asking for a reply until the next tool call happens to land.

const os = require('os');
const path = require('path');
const { createInstaller } = require('./hookinstall-base');
const hookRuntime = require('./hook-runtime');

const SETTINGS_PATH = path.join(os.homedir(), '.workbuddy', 'settings.json');
const HOOK_SCRIPT = hookRuntime.runtimeHookPath('workbuddy-hook.js');
const MARKER = 'workbuddy-hook.js';

const COMMAND_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'Notification', 'Elicitation', 'ElicitationResult',
];

module.exports = createInstaller({
  integrationId: 'workbuddy',
  integrationLabel: 'WorkBuddy',
  detectPath: path.dirname(SETTINGS_PATH),
  settingsPath: SETTINGS_PATH,
  hookScript: HOOK_SCRIPT,
  marker: MARKER,
  events: COMMAND_EVENTS,
  withPermission: false,
});

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
