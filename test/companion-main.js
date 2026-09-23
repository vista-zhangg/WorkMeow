'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createPetVisibilityController } = require('../backend/pet-visibility');
const { createRestReminderController } = require('../backend/rest-reminders');
const restPreferences = require('../shared/rest-preferences');
const { IPC } = require('../shared/ipc-channels');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const configSource = fs.readFileSync(path.join(__dirname, '../backend/config.js'), 'utf8');
const START = new Date(2026, 8, 23, 9).getTime();
const clone = (value) => JSON.parse(JSON.stringify(value));

// Execute the production functions without booting Electron, watchers or the
// user's real configuration. Boundaries intentionally name adjacent functions:
// if main is reorganized, the test fails rather than testing a stale copy.
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `cannot extract main integration: ${start}`);
  return source.slice(first, last);
}
const integrationSource = section('function showPet()', 'function hardenWindow(')
  + section('function sendPetEvent(', 'function quotaAlertEvent(')
  + section('function persistPos(', 'function makePetWindow(')
  + section('function registerIpc()', '  ipcMain.handle(IPC.GET_WIN_POS,') + '\n}\n';

function fixture(preferences = {}) {
  let time = START;
  const disk = new Map();
  const configPath = path.join('virtual-state', 'config.json');
  disk.set(configPath, JSON.stringify(preferences));
  const memoryFs = {
    readFileSync(file) { if (!disk.has(file)) throw new Error('ENOENT'); return disk.get(file); },
    writeFileSync(file, data) { disk.set(file, String(data)); },
    renameSync(from, to) { assert.ok(disk.has(from)); disk.set(to, disk.get(from)); disk.delete(from); },
    mkdirSync() {}, chmodSync() {},
  };
  const configModule = { exports: {} };
  vm.runInNewContext(configSource, {
    module: configModule,
    process: { pid: 1 },
    require(name) {
      if (name === 'fs') return memoryFs;
      if (name === 'path') return path;
      if (name === './paths') return { STATE_DIR: 'virtual-state' };
      if (name === '../shared/rest-preferences') return restPreferences;
      throw new Error(`Unexpected config dependency: ${name}`);
    },
  }, { filename: 'backend/config.js' });
  const config = configModule.exports;
  const powerMonitor = new EventEmitter();
  powerMonitor.idleSeconds = 0;
  powerMonitor.getSystemIdleTime = () => powerMonitor.idleSeconds;
  const pushes = [];
  const timers = [];
  const handlers = new Map();
  const commands = new Map();
  let detector = null;
  let shows = 0;
  let hides = 0;
  let quotaDeliveries = 0;
  let trayRefreshes = 0;
  let raises = 0;
  const pointerState = { mouseIgnoring: true };
  let cursor = { x: -100, y: -100 };
  const win = {
    visible: false, destroyed: false, webContents: { id: 1 },
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    showInactive() { this.visible = true; shows++; },
    show() { this.visible = true; shows++; },
    hide() { this.visible = false; hides++; },
    setAlwaysOnTop() { raises++; },
    moveTop() { raises++; },
    getBounds() { return { x: 100, y: 100, width: 320, height: 340 }; },
  };
  const settingsWin = { isDestroyed: () => false, webContents: { id: 2 } };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const context = {
    config, fs: memoryFs, path, IPC, Date: FakeDate,
    restReminders: null, petVisibility: null, desktopPresence: null,
    companionTimer: null, desktopLocked: false, desktopPaused: false,
    desktopPresenceReady: false, companionQuitting: false,
    mergedWin: null, petWin: null, settingsWin,
    restRuntimePath: 'virtual-state/rest-runtime.json', restRuntimeCache: '',
    powerMonitor,
    screen: { getCursorScreenPoint: () => cursor },
    createRestReminderController: (options) => createRestReminderController({ ...options, now: () => time }),
    createPetVisibilityController: (options) => createPetVisibilityController({ ...options, now: () => time }),
    createDesktopPresenceMonitor(options) {
      detector = {
        starts: 0,
        start() { this.starts++; },
        stop() { options.onChange({ fullscreen: false }); },
        emit(fullscreen) { options.onChange({ fullscreen }); },
        foreground() { options.onForegroundChange(); },
      };
      return detector;
    },
    setInterval(fn, delay) {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    firstAlivePetWin: () => context.mergedWin && !context.mergedWin.isDestroyed() ? context.mergedWin : null,
    primaryPetState: () => context.mergedWin ? pointerState : null,
    reconcilePets() { context.mergedWin = win; context.petWin = win; },
    sendPet(channel, value) { if (context.mergedWin) pushes.push({ target: 'pet', channel, value: clone(value) }); },
    sendWin(target, channel, value) { if (target) pushes.push({ target: 'settings', channel, value: clone(value) }); },
    deliverQuotaAlerts() { quotaDeliveries++; },
    refreshTrayMenu() { trayRefreshes++; },
    privacy: { protectEvent: (event) => event },
    stateOfSender: (sender) => sender === win.webContents ? { win } : null,
    ipcMain: { handle(name, handler) { handlers.set(name, handler); }, on(name, handler) { commands.set(name, handler); } },
  };
  vm.createContext(context);
  vm.runInContext(integrationSource, context, { filename: 'main.js (companion integration)' });
  context.registerIpc();
  context.startCompanionServices();
  const test = {
    context, config, disk, win, settingsWin, powerMonitor, pushes, timers,
    counts: () => ({ shows, hides, quotaDeliveries, trayRefreshes, raises }),
    sample: (fullscreen) => detector.emit(fullscreen),
    foreground: () => detector.foreground(),
    cursorAt(x, y) { cursor = { x, y }; return test; },
    pointerState,
    attach() { context.reconcilePets(); context.applyPetVisibility(); return test; },
    invoke(channel, value, sender = settingsWin.webContents) { return handlers.get(channel)({ sender }, value); },
    advance(seconds) {
      for (let count = 0; count < seconds; count++) {
        time += 1000;
        for (const timer of timers) if ((time - START) % timer.delay === 0) timer.fn();
      }
    },
    state: () => clone(context.companionState()),
  };
  return test;
}

let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ✓', name); }

check('startup waits for the first fullscreen sample with windows created in either order', () => {
  const first = fixture().attach();
  assert.equal(first.win.visible, false, 'must not flash before helper startup');
  first.sample(true);
  assert.equal(first.win.visible, false);
  first.sample(false);
  assert.equal(first.win.visible, true);
  const early = fixture();
  early.sample(false);
  early.attach();
  assert.equal(early.win.visible, true);
  assert.equal(early.timers.length, 2);
});

check('disabled fullscreen setting bypasses initial detection and remains visible in fullscreen', () => {
  const test = fixture({ autoHideFullscreen: false }).attach();
  assert.equal(test.win.visible, true);
  test.sample(true);
  assert.equal(test.win.visible, true);
});

check('foreground switches restore z-order only while the companion is visible', () => {
  const test = fixture().attach();
  test.sample(false);
  const initial = test.counts().raises;
  test.foreground();
  assert.equal(test.counts().raises, initial + 2);
  test.context.hidePet();
  test.foreground();
  assert.equal(test.counts().raises, initial + 2);
  test.context.showPet();
  assert.ok(test.counts().raises >= initial + 4);
  test.sample(true);
  const duringFullscreen = test.counts().raises;
  test.foreground();
  assert.equal(test.counts().raises, duringFullscreen);
});

check('OS cursor sampling repairs lost click-through transitions', () => {
  const test = fixture().attach();
  test.sample(false);
  test.cursorAt(120, 130);
  test.context.samplePetPointer();
  assert.ok(test.pushes.some(push => push.channel === IPC.PET_POINTER_CHECK && push.value.x === 20 && push.value.y === 30));
  const before = test.pushes.length;
  test.cursorAt(0, 0);
  test.context.samplePetPointer();
  assert.equal(test.pushes.length, before, 'an ignored window needs no outside sample');
  test.pointerState.mouseIgnoring = false;
  test.context.samplePetPointer();
  assert.equal(test.pushes.at(-1).channel, IPC.PET_POINTER_CHECK);
  test.context.hidePet();
  const hiddenCount = test.pushes.length;
  test.context.samplePetPointer();
  assert.equal(test.pushes.length, hiddenCount);
});

check('cat and capsule use the same explicit hide/show and automatic restore policy', () => {
  for (const showCat of [true, false]) {
    const test = fixture({ showCat }).attach();
    test.sample(false);
    test.context.hidePet();
    assert.equal(test.win.visible, false);
    test.sample(true); test.sample(false);
    assert.equal(test.win.visible, false);
    test.context.showPet();
    assert.equal(test.win.visible, true);
    test.sample(true);
    assert.equal(test.win.visible, false);
    test.context.showPet();
    assert.equal(test.win.visible, true);
    assert.equal(test.state().visibility.fullscreenOverride, true);
    test.sample(false); test.sample(true);
    assert.equal(test.win.visible, false);
  }
});

check('lock and suspend hide immediately and cannot undo manual hiding on release', () => {
  for (const [pause, resume] of [['lock-screen', 'unlock-screen'], ['suspend', 'resume']]) {
    const test = fixture().attach();
    test.sample(false);
    test.powerMonitor.emit(pause);
    assert.equal(test.win.visible, false);
    assert.equal(test.state().visibility.visible, false);
    test.context.hidePet();
    test.sample(true); test.sample(false);
    test.powerMonitor.emit(resume);
    assert.equal(test.win.visible, false);
    assert.equal(test.state().visibility.manualHidden, true);
    test.context.showPet();
    assert.equal(test.win.visible, true);
  }
});

check('overlapping lock and suspend require both releases before showing', () => {
  const test = fixture().attach();
  test.sample(false);
  test.powerMonitor.emit('lock-screen'); test.powerMonitor.emit('suspend');
  test.powerMonitor.emit('resume');
  assert.equal(test.win.visible, false);
  test.powerMonitor.emit('unlock-screen');
  assert.equal(test.win.visible, true);
});

check('custom quiet deadline is applied by the main timer but does not break fullscreen hiding', () => {
  const test = fixture({ quietMinutes: 2 }).attach();
  test.sample(false);
  test.context.hideMenuItems().find(item => item.label && item.label.startsWith('安静 2 分钟')).click();
  assert.equal(test.state().visibility.quietUntil, START + 120000);
  test.sample(true);
  test.advance(119);
  assert.equal(test.state().visibility.quietUntil, START + 120000);
  test.advance(1);
  assert.equal(test.state().visibility.quietUntil, 0);
  assert.equal(test.win.visible, false);
  test.sample(false);
  assert.equal(test.win.visible, true);
});

check('explicit show cancels timed hiding and quitting callbacks cannot reshow the window', () => {
  const test = fixture({ quietMinutes: 7 }).attach();
  test.sample(false);
  test.context.hideMenuItems().find(item => item.label && item.label.startsWith('安静 7 分钟')).click();
  test.context.showPet();
  assert.equal(test.win.visible, true);
  assert.equal(test.state().visibility.quietUntil, 0);
  test.sample(true);
  const before = test.counts().shows;
  test.context.companionQuitting = true;
  test.context.desktopPresence.stop();
  assert.equal(test.win.visible, false);
  assert.equal(test.counts().shows, before);
});

check('settings IPC saves custom durations and window position saves preserve them', () => {
  const test = fixture().attach();
  test.sample(false);
  const result = test.invoke(IPC.SET_COMPANION_PREFS, {
    quietMinutes: 47, autoHideFullscreen: false,
    restReminders: { waterMinutes: 32, stretchMinutes: 78, eyesEnabled: true, eyesMinutes: 16, snoozeMinutes: 9 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.quietMinutes, 47);
  assert.equal(result.rest.preferences.snoozeMinutes, 9);
  test.context.persistPos({ x: 120, y: 300 });
  const reloaded = clone(test.config.reload());
  assert.equal(reloaded.quietMinutes, 47);
  assert.equal(reloaded.autoHideFullscreen, false);
  assert.equal(reloaded.restReminders.waterMinutes, 32);
  assert.equal(reloaded.restReminders.stretchMinutes, 78);
  assert.deepEqual(reloaded.petPosition, { x: 120, y: 300 });
  test.context.hideMenuItems().find(item => item.label && item.label.startsWith('安静 47 分钟')).click();
  assert.equal(test.state().visibility.quietUntil, START + 47 * 60000);
  assert.ok(test.pushes.some(push => push.target === 'pet' && push.value.quietMinutes === 47));
  assert.ok(test.pushes.some(push => push.target === 'settings' && push.value.quietMinutes === 47));
});

check('companion IPC rejects foreign senders and invalid quiet values preserve a saved duration', () => {
  const test = fixture({ quietMinutes: 47 }).attach();
  assert.equal(test.invoke(IPC.SET_COMPANION_PREFS, { quietMinutes: 20 }, {}).ok, false);
  assert.equal(test.invoke(IPC.GET_COMPANION_STATE, null, {}), null);
  assert.equal(test.invoke(IPC.REST_ACTION, { action: 'done' }, {}).ok, false);
  for (const value of [0, 1441, 0.5, NaN, Infinity, '60', true, null]) {
    test.invoke(IPC.SET_COMPANION_PREFS, { quietMinutes: value });
    assert.equal(test.config.get().quietMinutes, 47);
  }
  for (const value of [1, 1440]) {
    assert.equal(test.invoke(IPC.SET_COMPANION_PREFS, { quietMinutes: value }).quietMinutes, value);
  }
});

check('human activity creates and retains reminders while quiet, without showing a hidden window', () => {
  const test = fixture({ quietMinutes: 7, restReminders: { waterMinutes: 5, stretchEnabled: false } }).attach();
  test.sample(false);
  test.context.hideMenuItems().find(item => item.label && item.label.startsWith('安静 7 分钟')).click();
  test.advance(300);
  assert.deepEqual(test.state().rest.pending.kinds, ['water']);
  assert.equal(test.win.visible, false);
  test.context.showPet();
  assert.equal(test.win.visible, true);
  assert.deepEqual(test.state().rest.pending.kinds, ['water']);
  const id = test.state().rest.pending.id;
  assert.equal(test.invoke(IPC.REST_ACTION, { id, action: 'snooze' }, test.win.webContents).ok, true);
  assert.equal(test.state().rest.pending, null);
  assert.ok(test.disk.has('virtual-state/rest-runtime.json'));
});

check('locked time does not accrue reminders and active usage resumes after unlock', () => {
  const test = fixture({ restReminders: { waterMinutes: 5, stretchEnabled: false } }).attach();
  test.sample(false);
  test.advance(240);
  test.powerMonitor.emit('lock-screen');
  test.advance(600);
  assert.equal(test.state().rest.pending, null);
  test.powerMonitor.emit('unlock-screen');
  test.advance(60);
  assert.deepEqual(test.state().rest.pending.kinds, ['water']);
});

check('permission/event forwarding does not override a user hide or fullscreen policy', () => {
  const test = fixture().attach();
  test.sample(false);
  test.context.hidePet();
  const before = test.counts().shows;
  test.context.sendPetEvent({ kind: 'permission', text: 'needs approval', ts: START });
  assert.equal(test.win.visible, false);
  assert.equal(test.counts().shows, before);
  assert.ok(test.pushes.some(push => push.channel === IPC.PET_EVENT && push.value.kind === 'permission'));
});

console.log(`Companion main integration: ${checks} checks passed.`);
