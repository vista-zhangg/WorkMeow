'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRAND = require('../shared/brand');
const env = require('../backend/env');
const paths = require('../backend/paths');
const transport = require('../backend/transport');

assert.strictEqual(BRAND.name, 'WorkMeow');
assert.strictEqual(BRAND.displayName, '打工喵');
assert.strictEqual(BRAND.appId, 'io.github.vista-zhangg.workmeow');
assert.strictEqual(BRAND.serverId, transport.SERVER_ID);
assert.strictEqual(BRAND.serverHeader, transport.SERVER_HEADER);
assert.strictEqual(BRAND.tokenHeader, transport.TOKEN_HEADER);
assert.strictEqual(path.basename(paths.STATE_DIR), '.workmeow');

const sampleEnv = {
  WORKMEOW_NO_CODEX: '0',
  LLMPET_NO_CODEX: '1',
  OCTOPUS_NO_NET: '1',
};
assert.strictEqual(env.value('NO_CODEX', sampleEnv), '0', 'canonical env must override a legacy alias');
assert.strictEqual(env.flag('NO_CODEX', sampleEnv), false);
assert.strictEqual(env.flag('NO_NET', sampleEnv), true, 'legacy env remains readable during upgrade');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-migration-'));
try {
  const oldest = path.join(root, '.llmpet');
  const previous = path.join(root, '.octopus');
  const current = path.join(root, '.workmeow');
  fs.mkdirSync(oldest, { recursive: true });
  fs.mkdirSync(previous, { recursive: true });
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(oldest, 'oldest.json'), '{"ok":1}');
  fs.writeFileSync(path.join(previous, 'usage.json'), '{"source":"previous"}');
  fs.writeFileSync(path.join(previous, 'config.json'), '{"source":"previous"}');
  fs.writeFileSync(path.join(current, 'config.json'), '{"source":"current"}');

  const result = paths.migrateLegacyState(root);
  assert.strictEqual(result.stateDir, current);
  assert.strictEqual(fs.readFileSync(path.join(current, 'config.json'), 'utf8'), '{"source":"current"}',
    'migration must never overwrite current WorkMeow data');
  assert.strictEqual(fs.readFileSync(path.join(current, 'usage.json'), 'utf8'), '{"source":"previous"}');
  assert.strictEqual(fs.readFileSync(path.join(current, 'oldest.json'), 'utf8'), '{"ok":1}');
  assert(fs.existsSync(path.join(previous, 'usage.json')), 'legacy data must remain as a recovery backup');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

assert(fs.existsSync(path.join(__dirname, '..', 'hook', 'workmeow-hook.js')));
assert(!fs.existsSync(path.join(__dirname, '..', 'hook', 'octopus-hook.js')));

console.log('WorkMeow migration checks passed');
