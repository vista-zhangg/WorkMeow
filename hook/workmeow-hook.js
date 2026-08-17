#!/usr/bin/env node
'use strict';

// WorkMeow hook for Claude Code — thin wrapper around the shared hook logic.
// Claude Code runs this as: node workmeow-hook.js <Event>
// All the real work (state mapping, transcript enrichment, POST) lives in
// backend/hook-common.js so WorkBuddy / TRAE reuse it unchanged.

const hook = require('../backend/hook-common');

if (require.main === module) {
  hook.runHook(process.argv[2], 'claude-code');
}

module.exports = {
  runHook: hook.runHook,
  buildBody: hook.buildBody,
  EVENT_STATE: hook.EVENT_STATE,
};
