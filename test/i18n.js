'use strict';

// The UI is intentionally Chinese-only. Keep the dictionary complete for all
// user-visible keys without retaining a language-switching subsystem.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../shared/i18n');
const config = require('../backend/config');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const PLACEHOLDER = /\{(\w+)\}/g;

assert.deepStrictEqual(Object.keys(i18n.DICT), ['zh'], 'only the Chinese locale must remain');
const zhKeys = Object.keys(i18n.DICT.zh).sort();
assert(zhKeys.length > 150, 'zh dictionary looks truncated');
assert(!('lang.zh' in i18n.DICT.zh) && !('menu.mute' in i18n.DICT.zh) && !('dlg.later' in i18n.DICT.zh), 'removed settings must not leave dictionary keys');
assert(!('lang' in config.DEFAULTS) && !('muted' in config.DEFAULTS), 'removed settings must not remain in persisted defaults');

for (const key of zhKeys) {
  const value = i18n.DICT.zh[key];
  assert.strictEqual(typeof value, 'string', `${key} must be a string`);
  const placeholders = value.match(PLACEHOLDER) || [];
  assert.deepStrictEqual(i18n.t(key, Object.fromEntries(placeholders.map((p) => [p.slice(1, -1), 'x']))), value.replace(PLACEHOLDER, 'x'),
    `${key} placeholders must be substituted`);
}

const SOURCES = [
  'main.js', 'backend/adapter.js', 'renderer/pet.js', 'renderer/panel.js',
  'renderer/settings.js',
];
const DOTTED = /^[a-z]+\.[A-Za-z]\w*$/;
const usedKeys = new Set();
const collect = (re, src) => {
  for (const m of src.matchAll(re)) if (DOTTED.test(m[1])) usedKeys.add(m[1]);
};
for (const file of SOURCES) {
  const src = read(file);
  collect(/\bt\(\s*'([\w.]+)'/g, src);
  collect(/(?:labelKey|key):\s*'([\w.]+)'/g, src);
}
for (const file of ['renderer/pet.html', 'renderer/panel.html', 'renderer/settings.html']) {
  collect(/data-i18n(?:-title|-ph)?="([^"]+)"/g, read(file));
}
assert(usedKeys.size > 100, `key scan found suspiciously few usages: ${usedKeys.size}`);
const unknown = [...usedKeys].filter((key) => !(key in i18n.DICT.zh));
assert.deepStrictEqual(unknown, [], `t() uses keys absent from the dictionary: ${unknown.join(', ')}`);

for (const suffix of ['reply', 'plan', 'perm', 'default']) {
  for (const family of ['wait.', 'reason.']) {
    assert(family + suffix in i18n.DICT.zh, `missing ${family}${suffix}`);
  }
}
for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Read', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'Js', 'Wait', 'default']) {
  assert('tool.' + tool in i18n.DICT.zh, `missing tool.${tool}`);
}

assert.strictEqual(i18n.t('bub.bigDone', { ops: 7 }), '🎉 大任务搞定！(7步)');
assert.strictEqual(i18n.backgroundStatus({ backgroundTasksCount: 2 }), '后台任务 2 项');
assert.strictEqual(i18n.backgroundStatus({ sessionCronsCount: 1 }), '定时等待 1 项');
assert.strictEqual(i18n.backgroundStatus({ backgroundTasksCount: 2, sessionCronsCount: 1 }), '后台 2 项 · 定时 1 项');
assert.strictEqual(i18n.backgroundStatus({ backgroundTasksCount: -1, sessionCronsCount: NaN }), '');
assert.strictEqual(i18n.t('no.such.key'), 'no.such.key', 'unknown key must degrade to the key');
console.log('i18n checks passed');
