'use strict';

// AgentPaw-owned filesystem paths and the one-time upgrade bridge from earlier
// project names. New runtime code only writes to ~/.agentpaw. Migration copies
// missing files and leaves the old directories untouched as a recovery backup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const BRAND = require('../shared/brand');

const LEGACY_STATE_DIR_NAMES = Object.freeze(['.workmeow', '.octopus', '.llmpet']);

function stateDir(homeDir = os.homedir()) {
  return path.join(homeDir, BRAND.stateDirName);
}

const STATE_DIR = stateDir();

function statePath(name, homeDir = os.homedir()) {
  return path.join(stateDir(homeDir), name);
}

function legacyStateDirs(homeDir = os.homedir()) {
  return LEGACY_STATE_DIR_NAMES.map((name) => path.join(homeDir, name));
}

function copyMissing(source, target, copied) {
  let stat;
  try { stat = fs.lstatSync(source); } catch { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyMissing(path.join(source, name), path.join(target, name), copied);
    }
    return;
  }
  if (!stat.isFile() || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied.push(target);
}

function migrateLegacyState(homeDir = os.homedir()) {
  const target = stateDir(homeDir);
  const copied = [];
  const marker = path.join(target, '.completed-migrations.json');
  let completed = [];
  try { const saved = JSON.parse(fs.readFileSync(marker, 'utf8')); if (Array.isArray(saved)) completed = saved; } catch {}
  for (const source of legacyStateDirs(homeDir)) {
    const name = path.basename(source);
    if (completed.includes(name) || !fs.existsSync(source)) continue;
    try {
      copyMissing(source, target, copied);
      completed.push(name);
      const temp = `${marker}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(completed), { mode: 0o600 });
      fs.renameSync(temp, marker);
    } catch {}
  }
  return { stateDir: target, copied };
}

module.exports = {
  STATE_DIR,
  LEGACY_STATE_DIR_NAMES,
  stateDir,
  statePath,
  legacyStateDirs,
  migrateLegacyState,
};
