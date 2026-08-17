'use strict';

// One registry for the sources that feed the merged pet/panel contract.
// Source-specific watchers and metering parsers stay in their own modules;
// this file only owns the stable identity and display label used when those
// modules are combined. Adding a source here keeps the aggregation lists in
// main.js and usage-stats.js in sync.
const SOURCE_REGISTRY = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude' }),
  Object.freeze({ id: 'codex', label: 'Codex' }),
  Object.freeze({ id: 'workbuddy', label: 'WorkBuddy' }),
  Object.freeze({ id: 'trae', label: 'TRAE' }),
  Object.freeze({ id: 'opencode', label: 'opencode' }),
]);

const SOURCE_IDS = Object.freeze(SOURCE_REGISTRY.map(({ id }) => id));

function withValues(values = {}) {
  return SOURCE_REGISTRY.map((source) => ({
    ...source,
    value: values && typeof values === 'object' ? values[source.id] ?? null : null,
  }));
}

module.exports = { SOURCE_REGISTRY, SOURCE_IDS, withValues };
