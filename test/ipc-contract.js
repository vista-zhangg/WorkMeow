'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { IPC, PUSH_CHANNELS, INVOKE_CHANNELS, COMMAND_CHANNELS } = require('../shared/ipc-channels');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const groups = [...PUSH_CHANNELS, ...INVOKE_CHANNELS, ...COMMAND_CHANNELS];

assert.strictEqual(new Set(groups).size, groups.length, 'IPC group membership must be unique');
assert.strictEqual(new Set(Object.values(IPC)).size, Object.keys(IPC).length, 'IPC channel values must be unique');
assert.deepStrictEqual(new Set(groups), new Set(Object.keys(IPC)), 'every IPC channel must have one direction');
for (const [key, value] of Object.entries(IPC)) {
  assert(preload.includes(`${key}: '${value}'`), `sandboxed preload channel ${key} must match shared IPC`);
}

for (const key of PUSH_CHANNELS) {
  assert(main.includes(`IPC.${key}`), `main process must publish ${key}`);
  assert(preload.includes(`IPC.${key}`), `preload must expose ${key}`);
}
for (const key of [...INVOKE_CHANNELS, ...COMMAND_CHANNELS]) {
  assert(main.includes(`IPC.${key}`), `main process must handle ${key}`);
  assert(preload.includes(`IPC.${key}`), `preload must expose ${key}`);
}

console.log('IPC contract checks passed');
