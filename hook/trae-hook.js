#!/usr/bin/env node
'use strict';

// 打工喵 WorkMeow hook for TRAE IDE — thin wrapper around shared hook logic.
// TRAE fires Claude-Code-compatible hooks from ~/.trae-cn/hooks.json
// (Windows: %userprofile%/.trae-cn/hooks.json). Same event vocabulary as
// Claude Code. Install via backend/trae-hookinstall.js.
//
// NOTE: TRAE also reads ~/.claude/settings.json hooks — so we install into
// TRAE's OWN config to avoid double-firing the same session event twice.

const hook = require('../backend/hook-common');

if (require.main === module) {
  hook.runHook(process.argv[2], 'trae');
}

module.exports = { runHook: hook.runHook, EVENT_STATE: hook.EVENT_STATE };
