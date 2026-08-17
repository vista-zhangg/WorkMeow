'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-detect-'));
const electron = require('electron');
const token = 'a'.repeat(64);

function runInPortableNode(code) {
  const result = spawnSync(electron, ['-e', code], {
    cwd: root,
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      ELECTRON_RUN_AS_NODE: '1',
    },
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.error || 'portable integration probe failed');
  return result.stdout.trim();
}

try {
  const first = JSON.parse(runInPortableNode(
    `const h=require(${JSON.stringify(path.join(root, 'backend', 'hooks.js'))});` +
    `process.stdout.write(JSON.stringify(h.install(41330, ${JSON.stringify(token)}).integrations));`
  ));
  assert(first.every((row) => row.detected === false));
  for (const dir of ['.claude', '.trae-cn', '.workbuddy']) {
    assert.strictEqual(fs.existsSync(path.join(home, dir)), false, `must not create ${dir} for an absent tool`);
  }
  assert.strictEqual(fs.existsSync(path.join(home, '.config', 'opencode')), false,
    'must not create opencode config for an absent tool');

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  const second = JSON.parse(runInPortableNode(
    `const h=require(${JSON.stringify(path.join(root, 'backend', 'hooks.js'))});` +
    `process.stdout.write(JSON.stringify(h.install(41330, ${JSON.stringify(token)}).integrations));`
  ));
  assert.strictEqual(second.find((row) => row.id === 'claude').connected, true);
  assert.strictEqual(second.find((row) => row.id === 'opencode').connected, true);
  assert.strictEqual(second.find((row) => row.id === 'trae').detected, false);
  assert.strictEqual(fs.existsSync(path.join(home, '.trae-cn')), false);
  assert.strictEqual(fs.existsSync(path.join(home, '.workbuddy')), false);

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert(command.includes("ELECTRON_RUN_AS_NODE='1'"));
  assert(command.includes(path.join(home, '.workmeow', 'hook-runtime', 'hook', 'workmeow-hook.js')));
  assert(!command.includes(path.join(root, 'hook', 'workmeow-hook.js')),
    'installed hook must not point into the movable ZIP directory');

  runInPortableNode(
    `const h=require(${JSON.stringify(path.join(root, 'backend', 'hooks.js'))});h.uninstall();`
  );
  assert.strictEqual(fs.existsSync(path.join(home, '.workmeow', 'hook-runtime')), false);
  const cleaned = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(cleaned.hooks, undefined);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('portable integration detection checks passed');
