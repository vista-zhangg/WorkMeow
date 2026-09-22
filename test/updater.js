'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  RELEASES_URL,
  detectDistribution,
  errorMessage,
  createUpdateService,
} = require('../backend/updater');

class FakeUpdater extends EventEmitter {
  constructor(result = 'available') {
    super();
    this.result = result;
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
  }

  async checkForUpdates() {
    this.checks += 1;
    this.emit('checking-for-update');
    if (this.result === 'error') throw new Error('network ETIMEDOUT');
    if (this.result === 'available') this.emit('update-available', { version: '1.6.0' });
    else this.emit('update-not-available', { version: '1.5.3' });
  }

  async downloadUpdate() {
    this.downloads += 1;
    this.emit('download-progress', { percent: 42.4 });
    this.emit('update-downloaded', { version: '1.6.0' });
  }

  quitAndInstall(isSilent, forceRunAfter) {
    this.installs += 1;
    this.installArgs = [isSilent, forceRunAfter];
  }
}

function app(packaged = true) {
  return { isPackaged: packaged, getVersion: () => '1.5.3' };
}

function config(autoUpdateEnabled) {
  return {
    value: { autoUpdateEnabled },
    get() { return { ...this.value }; },
    save(patch) { this.value = { ...this.value, ...patch }; return { ...this.value }; },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  assert.strictEqual(detectDistribution(app(false), { platform: 'win32' }), 'development');
  assert.strictEqual(detectDistribution(app(), { platform: 'darwin' }), 'unsupported');
  assert.strictEqual(detectDistribution(app(), {
    platform: 'win32', execPath: 'C:\\WorkMeow\\WorkMeow.exe',
    fs: { readdirSync: () => ['WorkMeow.exe', 'Uninstall 打工喵.exe'] }, path: path.win32,
  }), 'installer');
  assert.strictEqual(detectDistribution(app(), {
    platform: 'win32', execPath: 'C:\\WorkMeow\\WorkMeow.exe',
    fs: { readdirSync: () => ['WorkMeow.exe', 'resources'] }, path: path.win32,
  }), 'portable');

  const installedUpdater = new FakeUpdater();
  let readyPrompts = 0;
  const installed = createUpdateService({
    app: app(), updater: installedUpdater, config: config(true), mode: 'installer',
    shell: { openExternal: async () => {} }, onDownloaded: () => { readyPrompts += 1; },
  });
  installed.start(false);
  assert.strictEqual(installedUpdater.disableDifferentialDownload, true, 'new clients must download full installers without requesting blockmaps');
  assert.strictEqual(installedUpdater.disableWebInstaller, true);
  await installed.check(true);
  await flush();
  assert.strictEqual(installedUpdater.checks, 1, 'installed builds must check the update provider');
  assert.strictEqual(installedUpdater.downloads, 1, 'installed builds must auto-download when enabled');
  assert.strictEqual(installed.snapshot().phase, 'downloaded');
  assert.strictEqual(installed.snapshot().latestVersion, '1.6.0');
  assert.strictEqual(readyPrompts, 1, 'a downloaded update must prompt once');
  assert.strictEqual(installed.install(), true, 'downloaded installer updates must be installable');
  assert.deepStrictEqual(installedUpdater.installArgs, [false, true]);

  const manualUpdater = new FakeUpdater();
  const manualConfig = config(false);
  const manual = createUpdateService({
    app: app(), updater: manualUpdater, config: manualConfig, mode: 'installer',
    shell: { openExternal: async () => {} },
  });
  manual.start(false);
  await manual.check(true);
  await flush();
  assert.strictEqual(manual.snapshot().phase, 'available');
  assert.strictEqual(manualUpdater.downloads, 0, 'disabled auto-check must not start a download');
  assert.strictEqual(manual.install(), false, 'an update cannot install before download completes');
  await manual.download();
  assert.strictEqual(manualUpdater.downloads, 1, 'manual download must remain available');
  assert.strictEqual(manual.snapshot().phase, 'downloaded');
  manual.setAutoCheck(true);
  assert.strictEqual(manualConfig.value.autoUpdateEnabled, true, 'the preference must persist');

  const portableUpdater = new FakeUpdater();
  let openedUrl = null;
  const portable = createUpdateService({
    app: app(), updater: portableUpdater, config: config(true), mode: 'portable',
    shell: { openExternal: async (url) => { openedUrl = url; } },
  });
  portable.start(false);
  await portable.check(true);
  await flush();
  assert.strictEqual(portable.snapshot().phase, 'available');
  assert.strictEqual(portableUpdater.downloads, 0, 'ZIP builds must never auto-download an installer');
  await portable.download();
  assert.strictEqual(portableUpdater.downloads, 0, 'ZIP builds must reject explicit updater downloads too');
  assert.strictEqual(portable.install(), false, 'ZIP builds must never invoke installer replacement');
  assert.strictEqual(await portable.openReleasePage(), true);
  assert.strictEqual(openedUrl, 'https://github.com/vista-zhangg/codex-desktop-pet/releases/tag/v1.6.0');

  const latestUpdater = new FakeUpdater('latest');
  const latest = createUpdateService({
    app: app(), updater: latestUpdater, config: config(true), mode: 'installer', shell: {},
  });
  latest.start(false);
  await latest.check(true);
  assert.strictEqual(latest.snapshot().phase, 'up-to-date');
  assert.strictEqual(latest.snapshot().latestVersion, '1.5.3');

  const failingUpdater = new FakeUpdater('error');
  const failing = createUpdateService({
    app: app(), updater: failingUpdater, config: config(true), mode: 'installer', shell: {},
  });
  failing.start(false);
  await failing.check(true);
  assert.strictEqual(failing.snapshot().phase, 'error');
  assert.match(failing.snapshot().error, /网络/);
  assert.match(errorMessage(new Error('404 latest.yml')), /尚未发布/);
  assert.strictEqual(RELEASES_URL, 'https://github.com/vista-zhangg/codex-desktop-pet/releases/latest');

  const root = path.join(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const pkg = require('../package.json');
  const workflow = read('.github/workflows/release.yml');
  const finalize = read('scripts/finalize-dist.js');
  const settings = read('renderer/settings.html');
  const preload = read('preload.js');
  assert(pkg.dependencies['electron-updater'], 'electron-updater must ship with the application');
  assert.strictEqual(pkg.build.electronDist, 'node_modules/electron/dist',
    'packaging must reuse the Electron runtime already installed by npm');
  assert.deepStrictEqual(pkg.build.win.target, ['nsis'],
    'new releases must expose the NSIS EXE installer only');
  assert.strictEqual(pkg.scripts['package:portable'], undefined,
    'portable ZIP packaging must be retired from the public release flow');
  assert(/--win nsis(?:\s|$)/.test(pkg.scripts['package:win']),
    'Windows packaging must target NSIS explicitly');
  assert.strictEqual(pkg.build.publish[0].provider, 'github');
  assert.strictEqual(pkg.build.publish[0].owner, 'vista-zhangg');
  assert(!workflow.includes('dist/WorkMeow-*-Windows-x64.zip'),
    'releases must not upload the retired portable ZIP');
  assert(workflow.includes('dist/latest.yml') && !workflow.includes('.exe.blockmap') && !workflow.includes('SHA256SUMS.txt'),
    'releases retain legacy update discovery without redundant attachments');
  assert.strictEqual(pkg.build.nsis.differentialPackage, false, 'packaging must not generate blockmaps');
  assert(finalize.includes('verifyArtifacts(options)') && finalize.includes('verifyDist('),
    'cleanup must validate new artifacts before removing old output');
  assert(workflow.includes('npm run release:publish'), 'CI must use the verified draft-first publisher');

  // The 1.7.x updater takes this existing fallback when the new Release has
  // no blockmap. The full installer URL and SHA-512 still come from latest.yml.
  const { AppUpdater } = require('electron-updater');
  const fallback = await AppUpdater.prototype.differentialDownloadInstaller.call({
    _logger: { info() {}, error() {} },
    _testOnlyOptions: null,
    app: { version: '1.7.14' },
    downloadedUpdateHelper: { cacheDir: path.join(root, '.inspect') },
    listenerCount: () => 0,
    httpExecutor: { downloadToBuffer: async () => { throw new Error('404 blockmap'); } },
  }, { url: new URL('https://github.com/vista-zhangg/codex-desktop-pet/releases/download/v1.8.0/WorkMeow-1.8.0-Windows-x64.exe'), info: {} }, {
    updateInfoAndProvider: { info: { version: '1.8.0' }, provider: {
      getBlockMapFiles: () => [new URL('https://github.com/old.blockmap'), new URL('https://github.com/new.blockmap')],
    } },
  }, 'unused-installer.exe');
  assert.strictEqual(fallback, true, '1.7.x must fall back to the full installer when a blockmap is absent');
  assert(settings.includes('id="auto-update-toggle"') && settings.includes('id="update-check"'),
    'settings must expose the preference and manual check');
  for (const api of ['getUpdateState', 'checkForUpdates', 'setAutoUpdate', 'downloadUpdate', 'installUpdate', 'openUpdatePage']) {
    assert(preload.includes(`${api}:`), `preload must expose ${api}`);
  }

  console.log('update service and release contract checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
