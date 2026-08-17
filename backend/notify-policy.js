'use strict';

// Per-tool semantics for the single `Notification` hook event.
//
// WHY THIS FILE EXISTS
// Claude Code / WorkBuddy / TRAE all fire ONE event named `Notification`, and
// hook-common used to map it straight to the pet's `notification` state
// (「等你回复」) no matter what it carried. But that event name is overloaded:
// it covers BOTH "I am blocked on you" AND "nothing happened here for a while".
//
// WorkBuddy (CodeBuddy core) is the loud one. Its SessionManager.resetIdleTimer
// arms a 60s timer per session and, if the session is still idle when it fires:
//     executeNotificationHooks(session,
//       "CodeBuddy is waiting for your input", NotificationType.IDLE_PROMPT)
// So EVERY finished conversation flipped to 「等你回复」 60 seconds after it
// finished. And because `notification` is deliberately excluded from the oneshot
// TTL decay (a real "waiting for you" must survive until the user acts), it then
// never went away. That is the「面板里几个等我回复、其实全都结束了」现象。
//
// GROUND TRUTH PER TOOL — each tool declares its own vocabulary below, so a new
// tool is forced to state its semantics instead of silently inheriting Claude's.
//
//   • workbuddy — payload carries `notification_type`, exactly 4 values:
//       permission_prompt   → really blocked on the user (WorkBuddy has no
//                             blocking PermissionRequest hook, so this is the
//                             only permission signal we get)
//       elicitation_dialog  → AskUserQuestion card is open → really blocked
//       idle_prompt         → 60s idle timer AFTER the turn ended → NOT blocked
//       auth_success        → login toast → pure noise, must not touch the pet
//   • claude — no notification_type. Two known messages:
//       "… needs your permission to use X" → blocked (also arrives through the
//                                            blocking PermissionRequest hook)
//       "… is waiting for your input"      → 60s idle timer → NOT blocked
//   • trae — no documented contract: message heuristics, default to blocked.
//   • codex / opencode — never reach here. Their watchers already emit the
//     `notification` state ONLY for approval / elicitation events, and opencode
//     explicitly ignores pure `session.idle`. Entries kept for completeness.
//
// Verdicts:
//   'blocking' → real 「等你回复」, keep the notification state
//   'idle'     → the turn is simply over; settle, never nag
//   'info'     → cosmetic toast; drop the event entirely

const BLOCKING = 'blocking';
const IDLE = 'idle';
const INFO = 'info';

// Message fallbacks, used when a tool sends no (or an unknown) notification_type.
// Both the English strings the tools actually ship and the obvious Chinese
// equivalents, so a localized build does not silently fall through to blocking.
const IDLE_MESSAGE_RE =
  /waiting for (?:your|the user'?s?|user) input|idle (?:prompt|timeout)|等待(?:你|您|用户)(?:的)?(?:输入|回复)/i;
const BLOCKING_MESSAGE_RE =
  /needs? (?:your |the user'?s? |user )?permission|permission to use|requires? approval|approval required|需要(?:你|您)?(?:的)?(?:授权|许可|批准|确认)/i;

// agent short key → { types, unknown }
//   types   : this tool's OWN notification_type vocabulary (null = tool sends none)
//   unknown : verdict when neither the type nor the message identifies the kind.
//             Always 'blocking' — a spurious 「等你回复」 is annoying, a swallowed
//             one loses work.
const AGENT_NOTIFY = {
  workbuddy: {
    types: {
      permission_prompt: BLOCKING,
      elicitation_dialog: BLOCKING,
      idle_prompt: IDLE,
      auth_success: INFO,
    },
    unknown: BLOCKING,
  },
  claude: { types: null, unknown: BLOCKING },
  trae: { types: null, unknown: BLOCKING },
  codex: { types: null, unknown: BLOCKING },
  opencode: { types: null, unknown: BLOCKING },
};

const FALLBACK_POLICY = { types: null, unknown: BLOCKING };

function policyFor(agentKey) {
  return Object.prototype.hasOwnProperty.call(AGENT_NOTIFY, agentKey)
    ? AGENT_NOTIFY[agentKey]
    : FALLBACK_POLICY;
}

// Classify one Notification payload. Never throws.
//   agentKey         short key from shared/agents.js ('workbuddy' | 'claude' | …)
//   notificationType raw `notification_type` field, if the tool sends one
//   message          raw `message` field, if the tool sends one
function classifyNotification(input = {}) {
  const policy = policyFor(input.agentKey);

  // 1. The tool's own typed vocabulary is authoritative.
  const type = typeof input.notificationType === 'string' ? input.notificationType.trim().toLowerCase() : '';
  if (policy.types && type && Object.prototype.hasOwnProperty.call(policy.types, type)) {
    return policy.types[type];
  }

  // 2. Message heuristics — the only handle on Claude / TRAE.
  const msg = typeof input.message === 'string' ? input.message : '';
  if (msg) {
    if (IDLE_MESSAGE_RE.test(msg)) return IDLE;
    if (BLOCKING_MESSAGE_RE.test(msg)) return BLOCKING;
  }

  // 3. Unclassifiable → err on the side of telling the user.
  return policy.unknown;
}

// Does this tool ship a typed notification vocabulary? (used by the test to keep
// the registry and the real payload contract from drifting apart)
function notificationTypes(agentKey) {
  const policy = policyFor(agentKey);
  return policy.types ? { ...policy.types } : null;
}

module.exports = {
  BLOCKING,
  IDLE,
  INFO,
  AGENT_NOTIFY,
  classifyNotification,
  notificationTypes,
};
