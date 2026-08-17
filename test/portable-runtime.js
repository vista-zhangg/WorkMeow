'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runtime = require('../backend/hook-runtime');

const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-portable-'));

try {
  const electron = require('electron');
  const staged = runtime.stageHookRuntime({
    sourceRoot: root,
    homeDir: home,
    executable: electron,
    runAsNode: true,
  });

  assert.strictEqual(staged.copied.length, runtime.RUNTIME_FILES.length);
  for (const relative of runtime.RUNTIME_FILES) {
    assert(fs.existsSync(path.join(staged.root, ...relative.split('/'))), `staged ${relative}`);
  }

  const manifest = runtime.readHookRuntime(home);
  assert.strictEqual(manifest.executable, path.resolve(electron));
  assert.strictEqual(manifest.runAsNode, true);

  const script = runtime.runtimeHookPath('workmeow-hook.js', home);
  const command = runtime.buildHookCommand(script, 'SessionStart', manifest);
  assert(command.startsWith("$env:ELECTRON_RUN_AS_NODE='1'; & "));
  assert(command.includes("'SessionStart'"));

  const quoted = runtime.buildHookCommand("C:\\Users\\O'Brien\\hook.js", 'Stop', {
    executable: "C:\\Apps\\Cat's Home\\打工喵.exe",
    runAsNode: true,
  });
  assert(quoted.includes("Cat''s Home"), 'PowerShell executable path must escape apostrophes');
  assert(quoted.includes("O''Brien"), 'PowerShell script path must escape apostrophes');

  // Load the complete deployed dependency graph through Electron's built-in
  // Node mode. An unknown event exits immediately after all modules load.
  const probe = spawnSync(electron, [script, 'PortableRuntimeProbe'], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.strictEqual(probe.status, 0, probe.stderr || probe.error || 'Electron Node-mode hook probe failed');

  const unchanged = runtime.stageHookRuntime({
    sourceRoot: root,
    homeDir: home,
    executable: electron,
    runAsNode: true,
  });
  assert.deepStrictEqual(unchanged.copied, [], 'unchanged hook payload should not be rewritten');

  assert.strictEqual(runtime.removeHookRuntime(home), true);
  assert.strictEqual(fs.existsSync(runtime.runtimeDir(home)), false);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('portable hook runtime checks passed');
