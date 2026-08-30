'use strict';

// Pure integration-health projection shared by the Electron main process and
// regression tests. Installers/watchers report facts; this module decides how
// those facts become the compact settings-page contract.

const Agents = require('../shared/agents');
const { SOURCE_REGISTRY } = require('./source-registry');

const MODES = Object.freeze({
  claude: 'hook',
  codex: 'watcher',
  workbuddy: 'hook',
  trae: 'watcher',
  opencode: 'plugin',
});

const HOOK_MANAGED = new Set(['claude', 'workbuddy', 'opencode']);

function latestEventBySource(snapshot) {
  const latest = {};
  for (const session of Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : []) {
    if (!session || !Agents.isKnownAgentId(session.agentId)) continue;
    const id = Agents.shortKey(session.agentId);
    const updatedAt = Number(session.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
    latest[id] = Math.max(latest[id] || 0, updatedAt);
  }
  return latest;
}

function buildIntegrationHealth(options = {}) {
  const hookRows = new Map((Array.isArray(options.hookIntegrations) ? options.hookIntegrations : [])
    .filter((row) => row && typeof row.id === 'string')
    .map((row) => [row.id, row]));
  const watchers = options.watchers && typeof options.watchers === 'object' ? options.watchers : {};
  const latest = latestEventBySource(options.snapshot);
  const hooksEnabled = options.hooksEnabled !== false;
  const codexDetected = options.codexDetected === true;
  const checkedAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  const integrations = SOURCE_REGISTRY.map((source) => {
    const hook = hookRows.get(source.id) || null;
    const watcher = watchers[source.id] && typeof watchers[source.id] === 'object'
      ? watchers[source.id] : {};
    const mode = MODES[source.id] || 'hook';
    // Read-only sources may be discovered from their live sessions even when
    // they do not own a hook config directory. Managed hooks/plugins keep the
    // installer's directory check so repair never creates an absent tool.
    const detected = mode === 'watcher'
      ? ((source.id === 'codex' ? codexDetected : !!(hook && hook.detected)) || !!latest[source.id])
      : !!(hook && hook.detected);
    const connected = mode === 'watcher' ? watcher.running === true : !!(hook && hook.connected);
    const available = mode === 'watcher' ? watcher.available === true : true;
    const disabled = HOOK_MANAGED.has(source.id) && !hooksEnabled;
    const state = !detected
      ? 'not-detected'
      : disabled
        ? 'disabled'
        : connected
          ? 'ready'
          : 'needs-repair';
    return {
      id: source.id,
      label: source.label,
      mode,
      detected,
      connected: state === 'ready',
      state,
      repairable: detected && state !== 'ready' && available,
      lastEventAt: latest[source.id] || null,
    };
  });

  const detected = integrations.filter((row) => row.detected).length;
  const ready = integrations.filter((row) => row.state === 'ready').length;
  const needsRepair = integrations.filter((row) => row.detected && row.state !== 'ready').length;
  const repairable = integrations.filter((row) => row.repairable).length;
  return {
    checkedAt,
    hooksEnabled,
    integrations,
    summary: {
      total: integrations.length,
      detected,
      ready,
      needsRepair,
      repairable,
      notDetected: integrations.length - detected,
    },
  };
}

module.exports = { MODES, latestEventBySource, buildIntegrationHealth };
