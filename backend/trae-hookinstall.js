'use strict';

// Merge-safe TRAE IDE hook installer.
//
// Writes lifecycle hooks into ~/.trae-cn/hooks.json (Windows:
// %userprofile%/.trae-cn/hooks.json). TRAE's hooks.json sits beside a `version`
// field; the base installer preserves it. We install into TRAE's OWN config
// (not ~/.claude/settings.json) because TRAE also reads Claude's hooks and would
// otherwise double-fire the same session event.

const os = require('os');
const path = require('path');
const { createInstaller } = require('./hookinstall-base');
const hookRuntime = require('./hook-runtime');

const SETTINGS_PATH = path.join(os.homedir(), '.trae-cn', 'hooks.json');
const HOOK_SCRIPT = hookRuntime.runtimeHookPath('trae-hook.js');
const MARKER = 'trae-hook.js';

const COMMAND_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'Notification', 'Elicitation',
];

module.exports = createInstaller({
  integrationId: 'trae',
  integrationLabel: 'TRAE',
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
