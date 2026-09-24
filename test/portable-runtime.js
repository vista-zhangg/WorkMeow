'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runtime = require('../backend/hook-runtime');

const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpaw-portable-'));

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

  // Regression guard (1.7.11 shipped a zcode-hook requiring backend/zcode-db,
  // which the whitelist missed → every staged ZCode hook died at require time
  // and ZCode state went silent). Every relative require of every staged hook
  // script must resolve to a file that staging actually deploys.
  const stagedSet = new Set(runtime.RUNTIME_FILES);
  for (const relative of runtime.RUNTIME_FILES) {
    if (!relative.startsWith('hook/')) continue;
    const source = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
    for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      assert(
        stagedSet.has(resolved) || stagedSet.has(`${resolved}.js`),
        `${relative} requires ${match[1]} → ${resolved}, which is not in RUNTIME_FILES`
      );
    }
  }

  const manifest = runtime.readHookRuntime(home);
  assert.strictEqual(manifest.executable, path.resolve(electron));
  assert.strictEqual(manifest.runAsNode, true);

  const script = runtime.runtimeHookPath('agentpaw-hook.js', home);
  const command = runtime.buildHookCommand(script, 'SessionStart', manifest);
  assert(command.startsWith("$env:ELECTRON_RUN_AS_NODE='1'; & "));
  assert(command.includes("'SessionStart'"));

  const quoted = runtime.buildHookCommand("C:\\Users\\O'Brien\\hook.js", 'Stop', {
    executable: "C:\\Apps\\Cat's Home\\打工伙伴.exe",
    runAsNode: true,
  });
  assert(quoted.includes("Cat''s Home"), 'PowerShell executable path must escape apostrophes');
  assert(quoted.includes("O''Brien"), 'PowerShell script path must escape apostrophes');

  // Load the complete deployed dependency graph through Electron's built-in
  // Node mode. An unknown event exits immediately after all modules load.
  // Probe every staged hook entry point — zcode-hook.js pulls in backend
  // modules the others don't, and a missing staged file only fails here.
  for (const hookName of ['agentpaw-hook.js', 'zcode-hook.js', 'trae-hook.js', 'workbuddy-hook.js']) {
    const hookScript = runtime.runtimeHookPath(hookName, home);
    const probe = spawnSync(electron, [hookScript, 'PortableRuntimeProbe'], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    assert.strictEqual(probe.status, 0,
      `${hookName} probe failed: ${probe.stderr || probe.error || 'unknown error'}`);
  }

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
