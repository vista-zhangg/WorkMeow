'use strict';

// Portable hook runtime deployment.
//
// A ZIP build may live anywhere and the target computer may not have Node.js.
// On every WorkMeow start we copy the small, self-contained hook payload to a
// stable per-user directory and remember the current GUI executable. Electron
// can run that payload with ELECTRON_RUN_AS_NODE=1, so hooks do not depend on a
// system-wide `node.exe` or on the ZIP's resource layout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { statePath } = require('./paths');

const RUNTIME_FILES = Object.freeze([
  'hook/workmeow-hook.js',
  'hook/trae-hook.js',
  'hook/workbuddy-hook.js',
  'backend/hook-common.js',
  'backend/transport.js',
  'backend/transcript.js',
  'backend/pidwalk.js',
  'backend/emotion.js',
  'backend/notify-policy.js',
  'backend/metering.js',
  'backend/meter-queue.js',
  'backend/metering-common.js',
  'backend/paths.js',
  'backend/protocol-compat.js',
  'shared/agents.js',
  'shared/brand.js',
]);

function runtimeDir(homeDir = os.homedir()) {
  return statePath('hook-runtime', homeDir);
}

function runtimeHookPath(name, homeDir = os.homedir()) {
  return path.join(runtimeDir(homeDir), 'hook', name);
}

function manifestPath(homeDir = os.homedir()) {
  return path.join(runtimeDir(homeDir), 'runtime.json');
}

function sameFile(source, target) {
  try {
    const a = fs.statSync(source);
    const b = fs.statSync(target);
    if (a.size !== b.size) return false;
    return fs.readFileSync(source).equals(fs.readFileSync(target));
  } catch {
    return false;
  }
}

function copyAtomic(source, target) {
  if (sameFile(source, target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, target);
  return true;
}

function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  try {
    if (fs.readFileSync(target, 'utf8') === text) return false;
  } catch {}
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, target);
  return true;
}

function stageHookRuntime(options = {}) {
  const sourceRoot = options.sourceRoot || path.join(__dirname, '..');
  const homeDir = options.homeDir || os.homedir();
  const executable = path.resolve(options.executable || process.execPath);
  const runAsNode = options.runAsNode !== undefined
    ? options.runAsNode === true
    : Boolean(process.versions && process.versions.electron);
  const root = runtimeDir(homeDir);
  const copied = [];

  for (const relative of RUNTIME_FILES) {
    const source = path.join(sourceRoot, ...relative.split('/'));
    const target = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(source)) throw new Error(`hook runtime source missing: ${relative}`);
    if (copyAtomic(source, target)) copied.push(relative);
  }

  const manifest = { schema: 1, executable, runAsNode };
  writeJsonAtomic(manifestPath(homeDir), manifest);
  return { root, copied, ...manifest };
}

function readHookRuntime(homeDir = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(homeDir), 'utf8'));
    if (!raw || raw.schema !== 1 || typeof raw.executable !== 'string') return null;
    return {
      root: runtimeDir(homeDir),
      executable: raw.executable,
      runAsNode: raw.runAsNode === true,
    };
  } catch {
    return null;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildHookCommand(script, event, runtime = readHookRuntime()) {
  if (!runtime) throw new Error('portable hook runtime is not staged');
  const launch = `& ${psQuote(runtime.executable)} ${psQuote(script)} ${psQuote(event)}`;
  return runtime.runAsNode
    ? `$env:ELECTRON_RUN_AS_NODE='1'; ${launch}`
    : launch;
}

function removeHookRuntime(homeDir = os.homedir()) {
  const target = runtimeDir(homeDir);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  RUNTIME_FILES,
  runtimeDir,
  runtimeHookPath,
  manifestPath,
  stageHookRuntime,
  readHookRuntime,
  buildHookCommand,
  removeHookRuntime,
};
