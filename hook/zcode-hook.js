#!/usr/bin/env node
'use strict';

// WorkMeow hook for ZCode — thin wrapper around the shared hook logic.
// ZCode runs this as a `process` hook and, unlike Claude Code, never appends
// the event name to argv: the event arrives only in the stdin JSON as
// `hook_event_name`. Everything else (state mapping, enrichment, POST) runs
// through backend/hook-common.js, shared with Claude Code / WorkBuddy / TRAE.
//
// One ZCode-specific difference: the transcript_path ZCode hands every hook is
// a scratch file deleted when the hook returns, so the Stop 事件的 💬 气泡 can't
// come from a transcript. The enrich step below fills assistant_last_output
// from ZCode's own db.sqlite (message/part tables) instead. WORKMEOW_ZCODE_DB
// overrides the database path (tests / unusual setups); read-only, best-effort.

const hook = require('../backend/hook-common');
const zcodeDb = require('../backend/zcode-db');
const { detectEmotion } = require('../backend/emotion');

if (require.main === module) {
  hook.runHookStdinEvent('zcode', {
    enrich(body, payload) {
      if (body.event !== 'Stop' || body.assistant_last_output) return;
      const db = zcodeDb.openReadOnly(process.env.WORKMEOW_ZCODE_DB || undefined);
      if (!db) return;
      try {
        const text = zcodeDb.lastAssistantText(db, body.session_id);
        if (!text) return;
        body.assistant_last_output = text;
        const emo = detectEmotion(text, 'assistant');
        if (emo) body.assistant_emotion = emo;
      } catch {} finally {
        try { db.close(); } catch {}
      }
    },
  });
}

module.exports = {
  runHookStdinEvent: hook.runHookStdinEvent,
  buildBody: hook.buildBody,
  EVENT_STATE: hook.EVENT_STATE,
};
