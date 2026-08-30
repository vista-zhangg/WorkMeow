'use strict';

// Persisted app config. The pet is intentionally fixed to the Salary Cat
// renderer; there is no persisted appearance, display-mode, or rolling-budget choice.
// Stored atomically under ~/.workmeow/config.json.

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./paths');

const CONFIG_DIR = STATE_DIR;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_XIABAN_TIMES = Object.freeze({
  lunch: '10:55',
  evening: '16:55',
});

const DEFAULTS = Object.freeze({
  petPosition: null,      // {x,y} | null
  onboardingVersion: 0,  // portable integration summary shown once
  hooksEnabled: true,
  autoUpdateEnabled: true,
  xiabanTimes: DEFAULT_XIABAN_TIMES,
});

let cache = null;

function isClockTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function sanitize(raw) {
  const out = { ...DEFAULTS, xiabanTimes: { ...DEFAULT_XIABAN_TIMES } };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.petPosition && Number.isFinite(raw.petPosition.x) && Number.isFinite(raw.petPosition.y)) {
    out.petPosition = { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) };
  }
  if (Number.isInteger(raw.onboardingVersion) && raw.onboardingVersion >= 0) {
    out.onboardingVersion = raw.onboardingVersion;
  }
  if (typeof raw.hooksEnabled === 'boolean') out.hooksEnabled = raw.hooksEnabled;
  if (typeof raw.autoUpdateEnabled === 'boolean') out.autoUpdateEnabled = raw.autoUpdateEnabled;
  if (raw.xiabanTimes && isClockTime(raw.xiabanTimes.lunch) && isClockTime(raw.xiabanTimes.evening)) {
    out.xiabanTimes = {
      lunch: raw.xiabanTimes.lunch,
      evening: raw.xiabanTimes.evening,
    };
  }
  return out;
}

function readDisk() {
  try {
    const value = sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
    return value;
  } catch { return { ...DEFAULTS }; }
}

function load() {
  if (!cache) cache = readDisk();
  return cache;
}

function save(partial) {
  // Another process can toggle integrations while the app is running. Merge
  // against disk, not the in-process cache, so a later window-position save
  // cannot silently re-enable hooks that the CLI just uninstalled.
  cache = sanitize({ ...readDisk(), ...partial });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = path.join(CONFIG_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch {}
  return cache;
}

function get() { return load(); }
function reload() { cache = readDisk(); return cache; }

module.exports = {
  get, reload, save, sanitize, CONFIG_PATH, DEFAULTS, DEFAULT_XIABAN_TIMES, isClockTime,
};
