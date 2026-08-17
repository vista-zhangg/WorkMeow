'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-config-'));
const electron = require('electron');
const configPath = path.join(home, '.workmeow', 'config.json');
const script = `
  const fs=require('fs');
  const c=require(${JSON.stringify(path.join(root, 'backend', 'config.js'))});
  c.save({hooksEnabled:true,petPosition:{x:1,y:2}});
  fs.writeFileSync(c.CONFIG_PATH, JSON.stringify({hooksEnabled:false,petPosition:{x:1,y:2}}));
  c.save({petPosition:{x:9,y:10}});
  process.stdout.write(JSON.stringify({cached:c.get(),fresh:c.reload()}));
`;

try {
  const result = spawnSync(electron, ['-e', script], {
    cwd: root,
    env: { ...process.env, USERPROFILE: home, HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  assert.strictEqual(result.status, 0, result.stderr || String(result.error || 'config probe failed'));
  const value = JSON.parse(result.stdout);
  assert.strictEqual(value.cached.hooksEnabled, false, 'later app saves must preserve an external hook uninstall');
  assert.deepStrictEqual(value.cached.petPosition, { x: 9, y: 10 });
  assert.strictEqual(value.fresh.hooksEnabled, false, 'watcher reload must observe external config changes');
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).hooksEnabled, false);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('external config merge checks passed');
