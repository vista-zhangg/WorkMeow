'use strict';

// Privacy mode is a presentation boundary. Core state, metering, permissions,
// and local persistence keep working normally; only renderer-bound snapshots
// and events are stripped of content that is unsafe on a shared screen.

const { t } = require('../shared/i18n');

function privateProject() {
  return t('privacy.project');
}

function protectStats(stats, enabled) {
  if (!stats || typeof stats !== 'object') return stats;
  const privacyMode = enabled === true;
  if (!privacyMode) return { ...stats, privacyMode: false };

  const sessions = Array.isArray(stats.sessions)
    ? stats.sessions.map((session) => ({
      ...session,
      project: privateProject(),
      op: null,
      choice: null,
    }))
    : [];
  const actions = Array.isArray(stats.actions)
    ? stats.actions.map((action) => ({ ...action, choice: null }))
    : [];
  const lastOps = Array.isArray(stats.lastOps)
    ? stats.lastOps.map((op) => ({
      ...op,
      detail: t('privacy.hiddenDetail'),
      file: '',
      project: privateProject(),
    }))
    : [];

  return {
    ...stats,
    privacyMode: true,
    active: stats.active ? { ...stats.active, project: privateProject() } : stats.active,
    sessions,
    actions,
    lastOps,
    // Diagnostics are not currently rendered, but may contain local source
    // paths. Keep them out of the renderer contract while privacy mode is on.
    diagnostics: null,
  };
}

function protectEvent(event, enabled) {
  if (!event || typeof event !== 'object' || enabled !== true) return event;
  const safe = {
    ...event,
    project: privateProject(),
    choice: null,
  };

  if (event.kind === 'operation') {
    safe.detail = t('privacy.hiddenDetail');
    safe.file = '';
  } else if (event.kind === 'say') {
    safe.text = t('privacy.newMessage');
    safe.emotion = null;
  } else if (event.kind === 'user-turn') {
    safe.emotion = null;
  } else if (event.kind === 'error') {
    safe.text = t('err.default');
    safe.errorType = null;
  }
  return safe;
}

module.exports = { protectStats, protectEvent };
