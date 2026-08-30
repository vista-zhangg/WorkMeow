'use strict';

const fs = require('fs');
const path = require('path');

const RELEASES_URL = 'https://github.com/vista-zhangg/WorkMeow/releases/latest';
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 15 * 1000;

function detectDistribution(app, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return 'unsupported';
  if (!app || !app.isPackaged) return 'development';
  const fileSystem = options.fs || fs;
  const pathApi = options.path || path;
  const executable = options.execPath || process.execPath;
  try {
    const names = fileSystem.readdirSync(pathApi.dirname(executable));
    // electron-builder NSIS always writes this beside the installed app:
    // "Uninstall ${PRODUCT_FILENAME}.exe". The ZIP build has no uninstaller.
    if (names.some((name) => /^Uninstall .+\.exe$/i.test(name))) return 'installer';
  } catch {}
  return 'portable';
}

function errorMessage(error) {
  const text = String(error && (error.message || error) || '').replace(/\s+/g, ' ').trim();
  if (!text) return '检查更新失败，请稍后重试';
  if (/404|latest\.yml|no published versions/i.test(text)) return '更新信息尚未发布，请稍后重试';
  if (/ENOTFOUND|ETIMEDOUT|ECONN|network|internet|net::/i.test(text)) return '无法连接更新服务器，请检查网络后重试';
  return text.slice(0, 180);
}

function createUpdateService(options) {
  const app = options.app;
  const updater = options.updater || null;
  const config = options.config;
  const shell = options.shell;
  const setTimer = options.setTimeout || setTimeout;
  const setRepeatingTimer = options.setInterval || setInterval;
  const mode = options.mode || detectDistribution(app, options);
  const supported = mode === 'installer' || mode === 'portable';
  const currentVersion = app && typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0';
  const listeners = new Set();
  let started = false;
  let startTimer = null;
  let intervalTimer = null;
  let downloadPromise = null;
  let promptedVersion = null;
  const saved = config && typeof config.get === 'function' ? config.get() : {};

  const state = {
    supported,
    mode,
    autoCheck: saved.autoUpdateEnabled !== false,
    currentVersion,
    latestVersion: null,
    phase: supported ? 'idle' : mode,
    progress: null,
    checkedAt: null,
    error: null,
    releaseUrl: RELEASES_URL,
  };

  function snapshot() { return { ...state }; }
  function publish() {
    const value = snapshot();
    for (const listener of listeners) {
      try { listener(value); } catch {}
    }
    if (typeof options.onState === 'function') {
      try { options.onState(value); } catch {}
    }
    return value;
  }
  function update(patch) { Object.assign(state, patch); return publish(); }

  async function download() {
    if (!supported || mode !== 'installer' || !updater) return snapshot();
    if (state.phase === 'downloaded' || state.phase === 'downloading') return snapshot();
    if (!state.latestVersion) return check(true).then(() => snapshot());
    if (downloadPromise) return downloadPromise;
    update({ phase: 'downloading', progress: 0, error: null });
    downloadPromise = Promise.resolve(updater.downloadUpdate())
      .catch((error) => update({ phase: 'error', error: errorMessage(error), progress: null }))
      .finally(() => { downloadPromise = null; });
    await downloadPromise;
    return snapshot();
  }

  async function check(manual = false) {
    if (!supported || !updater) return snapshot();
    if (state.phase === 'checking' || state.phase === 'downloading') return snapshot();
    update({ phase: 'checking', progress: null, error: null });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      update({ phase: 'error', error: errorMessage(error), checkedAt: Date.now(), progress: null });
    }
    // The updater events are authoritative. `manual` is kept explicit at the
    // API boundary so a future UI can distinguish user and scheduled checks.
    void manual;
    return snapshot();
  }

  function install() {
    if (mode !== 'installer' || !updater || state.phase !== 'downloaded') return false;
    try {
      updater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      update({ phase: 'error', error: errorMessage(error) });
      return false;
    }
  }

  async function openReleasePage() {
    if (!shell || typeof shell.openExternal !== 'function') return false;
    const versionUrl = state.latestVersion
      ? `https://github.com/vista-zhangg/WorkMeow/releases/tag/v${encodeURIComponent(state.latestVersion)}`
      : RELEASES_URL;
    try { await shell.openExternal(versionUrl); return true; } catch { return false; }
  }

  function setAutoCheck(enabled) {
    state.autoCheck = !!enabled;
    if (config && typeof config.save === 'function') config.save({ autoUpdateEnabled: state.autoCheck });
    publish();
    if (state.autoCheck && state.phase === 'available' && mode === 'installer') void download();
    return snapshot();
  }

  function bindUpdater() {
    if (!updater || typeof updater.on !== 'function') return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => update({ phase: 'checking', error: null, progress: null }));
    updater.on('update-available', (info) => {
      const latestVersion = info && info.version ? String(info.version) : null;
      update({ phase: 'available', latestVersion, checkedAt: Date.now(), error: null, progress: null });
      if (state.autoCheck && mode === 'installer') void download();
    });
    updater.on('update-not-available', (info) => update({
      phase: 'up-to-date',
      latestVersion: info && info.version ? String(info.version) : currentVersion,
      checkedAt: Date.now(), error: null, progress: null,
    }));
    updater.on('download-progress', (progress) => update({
      phase: 'downloading',
      progress: Math.max(0, Math.min(100, Number(progress && progress.percent) || 0)),
      error: null,
    }));
    updater.on('update-downloaded', (info) => {
      const latestVersion = info && info.version ? String(info.version) : state.latestVersion;
      update({ phase: 'downloaded', latestVersion, progress: 100, error: null });
      if (latestVersion !== promptedVersion && typeof options.onDownloaded === 'function') {
        promptedVersion = latestVersion;
        try { options.onDownloaded(snapshot()); } catch {}
      }
    });
    updater.on('error', (error) => update({ phase: 'error', error: errorMessage(error), progress: null, checkedAt: Date.now() }));
  }

  function start(schedule = true) {
    if (started) return snapshot();
    started = true;
    bindUpdater();
    if (schedule && supported) {
      startTimer = setTimer(() => { if (state.autoCheck) void check(false); }, options.startDelayMs ?? DEFAULT_START_DELAY_MS);
      if (startTimer && typeof startTimer.unref === 'function') startTimer.unref();
      intervalTimer = setRepeatingTimer(() => { if (state.autoCheck) void check(false); }, options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
      if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
    }
    return snapshot();
  }

  function onState(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { start, snapshot, check, download, install, openReleasePage, setAutoCheck, onState };
}

module.exports = {
  RELEASES_URL,
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_START_DELAY_MS,
  detectDistribution,
  errorMessage,
  createUpdateService,
};
