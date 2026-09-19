#!/usr/bin/env node
'use strict';

// WorkMeow hook for ZCode — thin wrapper around the shared hook logic.
// ZCode runs this as a `process` hook and, unlike Claude Code, never appends
// the event name to argv: the event arrives only in the stdin JSON as
// `hook_event_name`. Everything else (state mapping, enrichment, POST) runs
// through backend/hook-common.js, shared with Claude Code / WorkBuddy / TRAE.

const hook = require('../backend/hook-common');

if (require.main === module) {
  hook.runHookStdinEvent('zcode');
}

module.exports = {
  runHookStdinEvent: hook.runHookStdinEvent,
  buildBody: hook.buildBody,
  EVENT_STATE: hook.EVENT_STATE,
};
