'use strict';

// Permission registry for Claude Code's blocking PermissionRequest HTTP hook.
//
// Claude Code POSTs to /permission and holds the connection open until we write
// a decision. We park the `res`, stamp a permId, surface the pending request to
// the frontend (which renders allow/deny in the pet bubble and calls
// decidePermission(permId, behavior)), then write the byte-exact response CC
// expects:
//   { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {...} } }
//
// The pet renders the bubble (no separate window). AskUserQuestion elicitation
// requests use the same held-open channel and return an updatedInput payload.

const crypto = require('crypto');
const { serverHeaders } = require('./transport');

// Tools Claude Code may ask permission for but which are pure orchestration —
// auto-allow so the pet never blocks them.
const PASSTHROUGH_TOOLS = new Set([
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
]);

// Resolve a hair before CC's own 600s hook timeout so a forgotten bubble lets
// CC fall back to its in-terminal prompt instead of hanging.
const AUTO_CLOSE_MS = 8 * 60 * 1000;

// AskUserQuestion (elicitation): Claude Code sends it through the same
// PermissionRequest HTTP hook with tool_input.questions[]. We answer it by
// replying { behavior:"allow", updatedInput:{...toolInput, answers} } where
// answers maps each question text → the chosen option label / custom text.

// Clean the questions for the UI (titles + descriptions per option).
function parseElicitationQuestions(toolInput) {
  const qs = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return qs.slice(0, 10).map((q) => {
    if (!q || typeof q !== 'object') return null;
    const question = String(q.question || q.prompt || '').trim();
    if (!question) return null;
    const options = Array.isArray(q.options) ? q.options.slice(0, 12).map((o) => {
      if (typeof o === 'string') return { label: o, description: '' };
      if (o && typeof o === 'object') return { label: String(o.label || '').trim(), description: String(o.description || '').trim() };
      return null;
    }).filter((o) => o && o.label) : [];
    return { header: String(q.header || '').trim(), question, options, multiSelect: q.multiSelect === true };
  }).filter(Boolean);
}

// Build the updatedInput Claude Code applies as the answer.
function buildElicitationUpdatedInput(toolInput, answers) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const norm = {};
  for (const q of questions) {
    if (!q || typeof q.question !== 'string' || !q.question) continue;
    const a = answers && Object.prototype.hasOwnProperty.call(answers, q.question) ? answers[q.question] : undefined;
    if (typeof a === 'string' && a.trim()) norm[q.question] = a.trim();
  }
  return { ...input, questions, answers: norm };
}

// Identity of a permission request, for collapsing duplicate re-sends. Distinct
// requests can overlap when parallel/background agents share a session_id, so
// only an identical session+tool+input signature is merged as the same retry.
function requestSig(sessionId, toolName, requestId, identityInput) {
  // Authorization identity must never be derived from display text.  The
  // server deliberately clips large values before they reach the renderer,
  // while two real requests can share an arbitrarily long prefix.  Hash the
  // complete decoded JSON payload (or use Claude's stable tool-use id) so a
  // decision can only fan out to byte-equivalent retries of the same request.
  if (typeof requestId === 'string' && requestId) {
    return `${sessionId}|${toolName}|id:${requestId}`;
  }
  let inp = '';
  try { inp = JSON.stringify(identityInput); } catch { inp = ''; }
  const digest = crypto.createHash('sha256').update(inp, 'utf8').digest('hex');
  return `${sessionId}|${toolName}|sha256:${digest}`;
}

function sendPermissionResponse(res, decision) {
  const body = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });
  try {
    res.writeHead(200, serverHeaders({ 'Content-Type': 'application/json' }));
    res.end(body);
  } catch {}
}

function createPermissions(options = {}) {
  const onAdded = typeof options.onAdded === 'function' ? options.onAdded : () => {};
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  /** @type {Map<string, object>} */
  const pending = new Map();

  function destroy(res) {
    try { res.destroy(); } catch {}
  }

  // Keep a pending card alive while any duplicate/retry HTTP connection for
  // the same PermissionRequest is still open. Claude Code can briefly have
  // more than one identical hook connection during retries or when an old
  // duplicate hook is still installed; losing the first connection must not
  // turn into a deny for the surviving copy.
  function attachPrimary(entry, res) {
    entry.res = res;
    entry.abortHandler = () => {
      if (!pending.has(entry.id) || res.writableFinished) return;
      while (entry.dupes.length) {
        const next = entry.dupes.shift();
        try { if (next.res && next.closeHandler) next.res.off('close', next.closeHandler); } catch {}
        if (!next.res || next.res.destroyed || next.res.writableEnded) continue;
        attachPrimary(entry, next.res);
        return;
      }
      resolveEntry(entry, 'no-decision', 'Client disconnected');
    };
    if (!res || res.destroyed || res.writableEnded) {
      entry.abortHandler();
      return;
    }
    try { res.on('close', entry.abortHandler); } catch {}
  }

  // Resolve a pending entry: write the decision (or drop), clean up, notify.
  // behavior: 'allow' | 'deny' | 'no-decision'
  function resolveEntry(entry, behavior, message) {
    if (!entry || !pending.has(entry.id)) return false;
    pending.delete(entry.id);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (entry.res && entry.abortHandler) {
      try { entry.res.off('close', entry.abortHandler); } catch {}
    }

    // Build the decision once, then mirror it to the main connection AND any
    // duplicate/retry connections of the SAME request (Claude Code re-sent it —
    // e.g. a second, dead PermissionRequest hook made it retry). One user click
    // therefore answers every copy, so the card can't "reset + ask again".
    let decision = null;
    if (behavior !== 'no-decision') {
      decision = { behavior: behavior === 'deny' ? 'deny' : 'allow' };
      if (behavior === 'deny' && message) decision.message = message;
      if (entry.resolvedSuggestion) decision.updatedPermissions = [entry.resolvedSuggestion];
      if (behavior === 'allow' && entry.isElicitation && entry.resolvedUpdatedInput) {
        decision.updatedInput = entry.resolvedUpdatedInput;
      }
    }
    const writeTo = (res) => {
      if (!res || res.writableEnded || res.destroyed) return;
      if (decision === null) destroy(res); // CC falls back to terminal prompt
      else sendPermissionResponse(res, decision);
    };
    writeTo(entry.res);
    if (Array.isArray(entry.dupes)) {
      for (const d of entry.dupes) {
        try { if (d.res && d.closeHandler) d.res.off('close', d.closeHandler); } catch {}
        writeTo(d.res);
      }
    }
    onChange();
    return true;
  }

  // Ingress from the HTTP /permission route. `parsed` is already normalized by
  // server.js: { toolName, toolInput, suggestions, sessionId, agentId, headless }.
  function addPermission(res, parsed) {
    parsed = parsed && typeof parsed === 'object' ? parsed : {};
    const toolName = parsed.toolName || 'Unknown';
    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim() : null;

    // Keep the authorization invariant at the registry boundary too. The HTTP
    // route rejects malformed payloads, but direct/injected callers must not
    // be able to create a shared "default" card that another session answers.
    if (!sessionId) {
      sendPermissionResponse(res, { behavior: 'deny', message: 'missing session_id' });
      return;
    }

    // Pure orchestration tools → auto-allow.
    if (PASSTHROUGH_TOOLS.has(toolName)) {
      sendPermissionResponse(res, { behavior: 'allow' });
      return;
    }
    // Headless (claude -p) → can't ask a human; auto-deny.
    if (parsed.headless === true) {
      sendPermissionResponse(res, { behavior: 'deny', message: 'Non-interactive session; auto-denied' });
      return;
    }

    const toolInput = parsed.toolInput && typeof parsed.toolInput === 'object' ? parsed.toolInput : {};
    const isElicitation = toolName === 'AskUserQuestion';

    // De-dup retries: if an IDENTICAL request (same session+tool+input) is already
    // pending and unanswered, attach this connection to the existing card.
    // Different inputs remain separate because parallel agents can legitimately
    // wait on more than one permission inside the same session.
    const sig = requestSig(sessionId, toolName, parsed.requestId, parsed.identityInput || toolInput);
    for (const e of pending.values()) {
      if (e.sig === sig) {
        const dup = { res, closeHandler: null };
        dup.closeHandler = () => { const i = e.dupes.indexOf(dup); if (i >= 0) e.dupes.splice(i, 1); };
        e.dupes.push(dup);
        try { res.on('close', dup.closeHandler); } catch {}
        return;
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      res,
      sig,
      dupes: [],
      sessionId,
      toolName,
      toolInput,
      isElicitation,
      questions: isElicitation ? parseElicitationQuestions(toolInput) : null,
      resolvedUpdatedInput: null,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      resolvedSuggestion: null,
      agentId: parsed.agentId || 'claude-code',
      createdAt: Date.now(),
      timer: null,
      abortHandler: null,
    };

    pending.set(entry.id, entry);
    attachPrimary(entry, res);
    // attachPrimary may immediately remove an already-disconnected response.
    if (!pending.has(entry.id)) return;
    entry.timer = setTimeout(() => resolveEntry(entry, 'no-decision', 'auto-close'), AUTO_CLOSE_MS);
    if (entry.timer.unref) entry.timer.unref();

    try { onAdded(entry); } catch {}
    onChange();
  }

  // Frontend decision:
  //   permission   → decidePermission(permId, 'allow' | 'deny')
  //   elicitation  → decidePermission(permId, { type:'elicitation-submit', answers })
  //                  or 'deny' (Go to Terminal → CC re-asks in the terminal)
  function decide(permId, behavior) {
    const entry = pending.get(permId);
    if (!entry) return false;
    if (entry.isElicitation) {
      if (behavior && typeof behavior === 'object' && behavior.type === 'elicitation-submit') {
        entry.resolvedUpdatedInput = buildElicitationUpdatedInput(entry.toolInput, behavior.answers);
        return resolveEntry(entry, 'allow');
      }
      return resolveEntry(entry, 'deny', 'Answer in terminal');
    }
    // ExitPlanMode: reject with feedback → deny carrying the feedback as the
    // message so Claude revises the plan; approve → allow.
    if (behavior && typeof behavior === 'object' && behavior.type === 'plan-feedback') {
      const fb = String(behavior.feedback || '').trim();
      return resolveEntry(entry, 'deny', fb || 'Plan rejected — please revise');
    }
    // "Always allow" suggestion button → allow + persist the rule via updatedPermissions.
    if (typeof behavior === 'string' && behavior.startsWith('suggestion:')) {
      const i = parseInt(behavior.slice('suggestion:'.length), 10);
      const sg = Array.isArray(entry.suggestions) ? entry.suggestions[i] : null;
      if (sg && typeof sg === 'object') {
        entry.resolvedSuggestion = { ...sg, destination: sg.destination || 'localSettings', behavior: sg.behavior || 'allow' };
      }
      return resolveEntry(entry, 'allow');
    }
    return resolveEntry(entry, behavior === 'allow' ? 'allow' : 'deny');
  }

  // Only an actual session end proves every pending card for that session is
  // stale. PostToolUse / Stop / UserPromptSubmit are not proof: parallel and
  // background agents share the same session_id, so their lifecycle events
  // must never remove another agent's live permission card. If the user answers
  // in the terminal, Claude Code closes the held HTTP connection and the close
  // handler above performs the no-decision cleanup.
  const SWEEP_EVENTS = new Set(['SessionEnd']);
  function sweepForSessionEvent(sessionId, event) {
    if (!SWEEP_EVENTS.has(event)) return;
    for (const entry of [...pending.values()]) {
      if (entry.sessionId === sessionId) {
        resolveEntry(entry, 'no-decision', 'Session ended');
      }
    }
  }

  function getPending() {
    return [...pending.values()].map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      toolName: e.toolName,
      toolInput: e.toolInput,
      suggestions: e.suggestions,
      isElicitation: !!e.isElicitation,
      questions: e.questions || null,
      createdAt: e.createdAt,
    }));
  }

  function cleanup() {
    for (const entry of [...pending.values()]) resolveEntry(entry, 'deny', 'Pet is quitting');
  }

  return {
    addPermission,
    decide,
    sweepForSessionEvent,
    getPending,
    cleanup,
    PASSTHROUGH_TOOLS,
  };
}

module.exports = { createPermissions, sendPermissionResponse, PASSTHROUGH_TOOLS };
