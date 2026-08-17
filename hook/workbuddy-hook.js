#!/usr/bin/env node
'use strict';

// 打工喵 WorkMeow hook for WorkBuddy — thin wrapper around shared hook logic.
// WorkBuddy fires Claude-Code-compatible hooks from ~/.workbuddy/settings.json
// (events: SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop /
// Notification / Elicitation, payloads carry session_id + transcript_path).
// Install via backend/workbuddy-hookinstall.js.

const hook = require('../backend/hook-common');

if (require.main === module) {
  hook.runHook(process.argv[2], 'workbuddy');
}

module.exports = { runHook: hook.runHook, EVENT_STATE: hook.EVENT_STATE };
