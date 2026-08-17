'use strict';

// Shared hook logic for EVERY agent entry script.
//
// workmeow-hook.js (Claude Code), workbuddy-hook.js (WorkBuddy), trae-hook.js
// (TRAE) are all thin wrappers that call runHook(event, agentId). Keeping the
// heavy lifting here means adding a new tool = one tiny wrapper file, no logic
// duplication, and the transcript/pidwalk/emotion enrichment stays in one place.
//
// The hook is run by the host tool as: node <entry-script> <Event>
// It must be fast and never throw — Claude Code / TRAE / WorkBuddy wait on it.

const transport = require('./transport');
const transcript = require('./transcript');
const pidwalk = require('./pidwalk');
const { detectEmotion } = require('./emotion');
const { isKnownAgentId, shortKey } = require('../shared/agents');
const notifyPolicy = require('./notify-policy');

// Event → pet state. Shared across all Claude-Code-compatible tools (Claude Code,
// WorkBuddy, TRAE all fire this same vocabulary). Unknown events are ignored.
//
// CAUTION: the event NAME being shared does not mean the SEMANTICS are shared.
// `Notification` in particular means different things per tool and is therefore
// re-classified below through backend/notify-policy.js — never map it blindly.
const EVENT_STATE = {
  SessionStart: 'idle',
  SessionEnd: 'sleeping',
  UserPromptSubmit: 'thinking',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'error',
  Stop: 'attention',
  StopFailure: 'error',
  SubagentStart: 'juggling',
  SubagentStop: 'working',
  PreCompact: 'sweeping',
  PostCompact: 'thinking',
  Notification: 'notification',
  Elicitation: 'notification',
  // WorkBuddy-only: the user answered the AskUserQuestion card → the wait is
  // over and the agent resumes. Tools that never fire it simply never hit this.
  ElicitationResult: 'thinking',
};
const FOCUS_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      let payload = {};
      try { const raw = Buffer.concat(chunks).toString('utf8'); if (raw.trim()) payload = JSON.parse(raw); } catch {}
      resolve(payload);
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 300);
  });
}

function count(v) { return Array.isArray(v) ? v.length : 0; }

function buildBody(event, p, agentId) {
  let state = EVENT_STATE[event];
  if (!state) return null;
  let outEvent = event;
  // A subagent launch may surface as PreToolUse(Task) without SubagentStart.
  if (event === 'PreToolUse' && p.tool_name === 'Task') state = 'juggling';
  // /clear shows up as SessionEnd(source=clear) → context sweep, not sleep.
  if (event === 'SessionEnd' && (p.source === 'clear' || p.reason === 'clear')) state = 'sweeping';
  // Manual /compact ends a turn (settle to idle); auto-compact keeps working.
  if (event === 'PostCompact' && p.trigger === 'manual') state = 'idle';

  // `Notification` is overloaded — classify it against THIS tool's vocabulary
  // before it is allowed to park the cat in 「等你回复」. See notify-policy.js.
  // (A dedicated `Elicitation` event is unambiguous and skips the check.)
  let notificationType = null;
  if (event === 'Notification') {
    notificationType = typeof p.notification_type === 'string' && p.notification_type.trim()
      ? p.notification_type.trim().toLowerCase()
      : null;
    const verdict = notifyPolicy.classifyNotification({
      agentKey: shortKey(agentId),
      notificationType,
      message: typeof p.message === 'string' ? p.message : '',
    });
    // Cosmetic toast (auth_success …) → never reaches the pet at all.
    if (verdict === notifyPolicy.INFO) return null;
    // The host tool's 60s idle timer. It only proves the session went quiet —
    // it is NOT a request for a reply. Report it under its own event name so
    // core can softly settle a stuck session without faking a completion.
    if (verdict === notifyPolicy.IDLE) {
      state = 'idle';
      outEvent = 'IdleNotification';
    }
  } else if (event === 'Elicitation') {
    notificationType = 'elicitation_dialog'; // unambiguous by construction
  }

  // No session_id → drop (would forge a ghost session named "efault").
  if (typeof p.session_id !== 'string' || !p.session_id.trim()) return null;
  const sid = p.session_id.trim();
  const body = { state, event: outEvent, session_id: sid };
  if (notificationType) body.notification_type = notificationType;
  if (isKnownAgentId(agentId)) body.agent_id = agentId;
  if (typeof p.cwd === 'string' && p.cwd) body.cwd = p.cwd;
  if (typeof p.transcript_path === 'string' && p.transcript_path) body.transcript_path = p.transcript_path;
  if (typeof p.tool_name === 'string' && p.tool_name) body.tool_name = p.tool_name;
  if (typeof p.model === 'string' && p.model) body.model = p.model;
  if (p.stop_hook_active === true) body.stop_hook_active = true;
  if (event === 'StopFailure') {
    const t = p.api_error_type || p.error || p.reason || p.failure_kind;
    if (typeof t === 'string' && t) body.api_error_type = t;
  }
  body.background_tasks_count = count(p.background_tasks);
  body.session_crons_count = count(p.session_crons);

  // Transcript-derived enrichment (read the tail once). Best-effort: a tool whose
  // transcript isn't Claude-Code-shaped simply skips these fields — the pet still
  // gets live state from the hook events.
  const entries = transcript.readTail(p.transcript_path);

  if (event === 'SessionStart') {
    body.session_source = (typeof p.source === 'string' && p.source)
      ? p.source
      : (transcript.hasHistory(entries) ? 'resume' : 'startup');
  }

  if (entries) {
    const ctx = transcript.contextUsage(entries, p.session_id || null);
    if (ctx) body.context_usage = ctx;
    const title = transcript.sessionTitle(entries);
    if (title) body.session_title = title;
    if (event === 'Stop') {
      const err = transcript.apiError(entries, sid);
      if (err) {
        body.state = 'error';
        body.event = 'ApiError';
        body.api_error_type = err.api_error_type;
      } else {
        const text = transcript.lastAssistantText(entries, sid);
        if (text) body.assistant_last_output = text;
      }
    }
  }
  if (!body.session_title && event === 'UserPromptSubmit') {
    const pt = transcript.promptTitle(p.prompt);
    if (pt) body.session_title = pt;
  }

  if (event === 'UserPromptSubmit' && typeof p.prompt === 'string') {
    const emo = detectEmotion(p.prompt, 'user');
    if (emo) body.user_emotion = emo;
  } else if (event === 'Stop' && body.assistant_last_output) {
    const emo = detectEmotion(body.assistant_last_output, 'assistant');
    if (emo) body.assistant_emotion = emo;
  }

  if (FOCUS_EVENTS.has(event)) {
    try {
      const r = pidwalk.resolve(process.ppid, 10, sid);
      if (r.sourcePid) body.source_pid = r.sourcePid;
      if (r.pidChain && r.pidChain.length) body.pid_chain = r.pidChain;
      if (r.editor) body.editor = r.editor;
      body.headless = r.headless === true;
    } catch {}
  }
  return body;
}

function runHook(event, agentId) {
  if (!EVENT_STATE[event]) process.exit(0);
  readStdin().then((payload) => {
    let body;
    try { body = buildBody(event, payload || {}, agentId); } catch { body = null; }
    if (!body) process.exit(0);
    transport.postState(body, () => process.exit(0));
    setTimeout(() => process.exit(0), 250); // never hang the host tool
  }).catch(() => process.exit(0));
}

module.exports = { runHook, EVENT_STATE, buildBody, readStdin };
