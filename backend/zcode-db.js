'use strict';

// Read-only helpers over ZCode's own SQLite database (~/.zcode/cli/db/db.sqlite).
// Two consumers:
//   · backend/zcode-metering.js — the 30s in-app poller: usage ledger + session
//     liveness heartbeat (model_usage completions + in-flight tool_usage rows)
//     + boot backfill of sessions/titles from the session table;
//   · hook/zcode-hook.js — the Stop 事件 💬 气泡: ZCode's transcript_path is a
//     scratch file created per hook call and deleted when the hook returns, so
//     there is no Claude-style transcript to enrich from; the last assistant
//     text is taken from the local message/part tables instead.
//
// Every helper degrades to null/[] instead of throwing when node:sqlite, the
// database or a table is missing — ZCode presence is optional for AgentPaw and
// the app/runtimes pin different Node versions. All access is read-only; the
// database runs in WAL mode, so readers coexist with the live CLI.

const path = require('path');
const os = require('os');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

const DEFAULT_DB_PATH = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

// Same ceiling as backend/transcript.js ASSISTANT_MAX, so the payload the hook
// ships (and the app stores per session) stays bounded like Claude Code's.
const ASSISTANT_TEXT_MAX = 2200;

function openReadOnly(dbPath = DEFAULT_DB_PATH) {
  if (!DatabaseSync) return null;
  try { return new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
}

// Last assistant text of the session: nearest assistant message (role lives in
// the message.data JSON) joined with its text parts. Mirrors the semantics of
// transcript.lastAssistantText for agents without a transcript.
function lastAssistantText(db, sessionId) {
  if (!db || !sessionId) return null;
  let msg;
  try {
    msg = db.prepare(
      `SELECT id FROM message
        WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
        ORDER BY time_created DESC, sequence DESC LIMIT 1`
    ).get(sessionId);
  } catch { return null; }
  if (!msg) return null;
  try {
    const parts = db.prepare(
      `SELECT data FROM part
        WHERE message_id = ? AND json_extract(data, '$.type') = 'text'
        ORDER BY sequence ASC`
    ).all(msg.id);
    let text = '';
    for (const p of parts) {
      try {
        const d = JSON.parse(p.data);
        if (typeof d.text === 'string') text += d.text;
      } catch {}
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > ASSISTANT_TEXT_MAX ? text.slice(0, ASSISTANT_TEXT_MAX) + '…' : text;
  } catch { return null; }
}

// Recently-touched, non-archived sessions (boot backfill). ZCode's session
// table is the only place a session title exists before the next hook fires.
function readRecentSessions(db, options = {}) {
  const out = [];
  if (!db) return out;
  const cutoffMs = Number(options.cutoffMs) || 30 * 60 * 1000;
  const limit = Number(options.limit) || 15;
  try {
    const rows = db.prepare(
      `SELECT id, directory, title, time_updated FROM session
        WHERE time_archived IS NULL AND time_updated > ?
        ORDER BY time_updated DESC LIMIT ?`
    ).all(Date.now() - cutoffMs, limit);
    for (const r of rows) {
      out.push({
        id: r.id,
        cwd: typeof r.directory === 'string' ? r.directory : '',
        title: typeof r.title === 'string' && r.title ? r.title : null,
        updatedAt: Number(r.time_updated) || 0,
      });
    }
  } catch {}
  return out;
}

// Sessions with a tool still in flight. tool_usage rows are written when the
// tool STARTS (status running, completed_at NULL) and updated when it ends —
// the authoritative "this session genuinely has a tool executing right now"
// signal, which covers a single multi-minute Bash/Agent dispatch that produces
// no model_usage rows in between. Bounded by sinceMs so a stale 'running' row
// left behind by a crashed ZCode cannot keep a session alive forever.
function inFlightTools(db, sinceMs = 0) {
  const out = [];
  if (!db) return out;
  try {
    const rows = db.prepare(
      `SELECT session_id, MAX(started_at) AS started_at FROM tool_usage
        WHERE status = 'running' AND completed_at IS NULL AND started_at > ?
        GROUP BY session_id`
    ).all(Number(sinceMs) || 0);
    for (const r of rows) {
      if (r && r.session_id) out.push({ sessionId: r.session_id, startedAt: Number(r.started_at) || 0 });
    }
  } catch {}
  return out;
}

module.exports = { DEFAULT_DB_PATH, openReadOnly, lastAssistantText, readRecentSessions, inFlightTools };
