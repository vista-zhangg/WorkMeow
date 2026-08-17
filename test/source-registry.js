'use strict';

const assert = require('assert');
const { SOURCE_REGISTRY, SOURCE_IDS, withValues } = require('../backend/source-registry');
const { SOURCES: rebuildSources } = require('../backend/meter-rebuild');

assert.deepStrictEqual(SOURCE_IDS, ['claude', 'codex', 'workbuddy', 'trae', 'opencode']);
assert.deepStrictEqual(SOURCE_REGISTRY.map((source) => source.id), [...SOURCE_IDS]);
assert.deepStrictEqual(rebuildSources.map((source) => source.id), [...SOURCE_IDS]);
assert.deepStrictEqual(withValues({ codex: 42 }).map((source) => source.value), [null, 42, null, null, null]);
assert.strictEqual(withValues({ opencode: null })[4].value, null);
assert.deepStrictEqual(withValues(null).map((source) => source.value), [null, null, null, null, null]);

console.log('source registry checks passed');
