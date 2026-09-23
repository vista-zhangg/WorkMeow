'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createDesktopPresenceMonitor, parsePresenceLine, buildWatcherScript } = require('../backend/desktop-presence');

let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ✓', name); }

function setup(options = {}) {
  const timers = new Map();
  const helpers = [];
  const changes = [];
  const foregroundChanges = [];
  const spawns = [];
  let nextId = 0;
  const monitor = createDesktopPresenceMonitor({
    platform: 'win32', ownProcessId: 1234, onChange: (state) => changes.push(state),
    onForegroundChange: () => foregroundChanges.push(true),
    setTimer(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    spawnProcess(command, args, spawnOptions) {
      const helper = new EventEmitter();
      helper.stdout = new EventEmitter();
      helper.stderr = new EventEmitter();
      helper.killCount = 0;
      helper.kill = () => { helper.killCount++; };
      helpers.push(helper);
      spawns.push({ command, args, options: spawnOptions });
      return helper;
    },
    ...options,
  });
  function fireTimer(delay) {
    const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(entry, `missing timer with delay ${delay}`);
    timers.delete(entry[0]);
    entry[1].fn();
  }
  return { monitor, helpers, changes, foregroundChanges, spawns, timers, fireTimer };
}

check('wire format accepts strict booleans and drops malformed values', () => {
  assert.deepEqual(parsePresenceLine('{"fullscreen":false}'), { fullscreen: false });
  assert.deepEqual(parsePresenceLine('{"fullscreen":true,"title":"not retained"}'), { fullscreen: true });
  assert.deepEqual(parsePresenceLine('{"fullscreen":false,"foregroundChanged":true}'), { fullscreen: false, foregroundChanged: true });
  for (const line of ['oops', '{}', 'null', '{"fullscreen":"false"}', '{"fullscreen":1}', '{"fullscreen":false,"foregroundChanged":1}']) {
    assert.equal(parsePresenceLine(line), null);
  }
});

check('helper is hidden, compiles once and only starts once per start cycle', () => {
  const { monitor, spawns } = setup();
  monitor.start(); monitor.start();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(spawns[0].args.includes('-NonInteractive'));
  const script = Buffer.from(spawns[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('[uint32]1234'));
  assert.ok(script.includes('SetThreadDpiAwarenessContext'));
  assert.ok(script.includes('Start-Sleep -Milliseconds 1000'));
  monitor.stop();
});

check('fragmented CRLF lines are reconstructed and identical heartbeats deduplicated', () => {
  const { monitor, helpers, changes, timers } = setup();
  monitor.start();
  helpers[0].stdout.emit('data', Buffer.from('{"full'));
  assert.equal(changes.length, 0);
  helpers[0].stdout.emit('data', Buffer.from('screen":true}\r\n{"fullscreen":true}\n'));
  assert.deepEqual(changes, [{ fullscreen: true }]);
  assert.equal([...timers.values()][0].delay, 10000);
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":false}\n'));
  assert.deepEqual(changes, [{ fullscreen: true }, { fullscreen: false }]);
  monitor.stop();
});

check('foreground changes are reported without changing fullscreen state or raising over fullscreen', () => {
  const { monitor, helpers, changes, foregroundChanges } = setup();
  monitor.start();
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":false,"foregroundChanged":true}\n'));
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":false,"foregroundChanged":false}\n'));
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":false,"foregroundChanged":true}\n'));
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":true,"foregroundChanged":true}\n'));
  assert.deepEqual(changes, [{ fullscreen: false }, { fullscreen: true }]);
  assert.equal(foregroundChanges.length, 2);
  monitor.stop();
});

check('bad output fails open and cannot spawn a replacement before child close', () => {
  const { monitor, helpers, changes, spawns, timers, fireTimer } = setup();
  monitor.start();
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":true}\n'));
  helpers[0].stdout.emit('data', Buffer.from('invalid\n'));
  assert.equal(helpers[0].killCount, 1);
  assert.equal(monitor.snapshot().fullscreen, false);
  assert.equal(timers.size, 0);
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":true}\n'));
  assert.equal(changes.length, 2);
  helpers[0].emit('close', 1);
  fireTimer(30000);
  assert.equal(spawns.length, 2);
  monitor.stop();
});

check('watchdog releases a stuck fullscreen flag and retries after helper exit', () => {
  const { monitor, helpers, fireTimer, spawns } = setup();
  monitor.start();
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":true}\n'));
  fireTimer(10000);
  assert.equal(monitor.snapshot().fullscreen, false);
  assert.equal(helpers[0].killCount, 1);
  helpers[0].emit('close', 1);
  fireTimer(30000);
  assert.equal(spawns.length, 2);
  monitor.stop();
});

check('startup timeout and oversized output both bound a failed helper', () => {
  for (const kind of ['timeout', 'overflow']) {
    const { monitor, helpers, fireTimer } = setup();
    monitor.start();
    if (kind === 'timeout') fireTimer(20000);
    else helpers[0].stdout.emit('data', Buffer.from('x'.repeat(4097)));
    assert.equal(helpers[0].killCount, 1);
    assert.equal(monitor.snapshot().fullscreen, false);
    monitor.stop();
  }
});

check('stop ignores late stdout and exit, clears retry, and releases fullscreen', () => {
  const { monitor, helpers, changes, timers, spawns } = setup();
  monitor.start();
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":true}\n'));
  monitor.stop(); monitor.stop();
  assert.equal(helpers[0].killCount, 1);
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":true}\n'));
  helpers[0].emit('error', new Error('late'));
  helpers[0].emit('close', 1);
  assert.deepEqual(changes, [{ fullscreen: true }, { fullscreen: false }]);
  assert.equal(timers.size, 0);
  assert.equal(spawns.length, 1);
});

check('stop/start race waits for old helper close and old callbacks cannot kill replacement', () => {
  const { monitor, helpers, spawns, fireTimer, timers } = setup();
  monitor.start();
  const oldHelper = helpers[0];
  monitor.stop(); monitor.start();
  assert.equal(spawns.length, 1);
  oldHelper.emit('close', 0);
  fireTimer(30000);
  assert.equal(spawns.length, 2);
  oldHelper.emit('close', 0);
  oldHelper.stdout.emit('data', Buffer.from('{"fullscreen":true}\n'));
  assert.equal(helpers[1].killCount, 0);
  assert.equal(timers.size, 1);
  monitor.stop();
});

check('spawn exceptions, errors and exits all fail open with bounded retries', () => {
  const thrown = setup({ spawnProcess() { throw new Error('unavailable'); } });
  thrown.monitor.start();
  assert.deepEqual(thrown.changes, [{ fullscreen: false }]);
  thrown.fireTimer(30000);
  assert.equal(thrown.timers.size, 1);
  thrown.monitor.stop();
  assert.equal(thrown.timers.size, 0);
  const { monitor, helpers, timers } = setup();
  monitor.start();
  helpers[0].stdout.emit('data', Buffer.from('{"fullscreen":true}\n'));
  helpers[0].emit('error', new Error('broken'));
  assert.equal(monitor.snapshot().fullscreen, false);
  helpers[0].emit('close', 1);
  assert.equal([...timers.values()][0].delay, 30000);
  monitor.stop();
  assert.equal(timers.size, 0);
});

check('unsupported platforms remain visible without subprocesses', () => {
  const { monitor, spawns, timers, changes } = setup({ platform: 'darwin' });
  monitor.start();
  assert.equal(spawns.length, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(changes, [{ fullscreen: false }]);
  monitor.stop();
});

check('script interpolation only permits finite interval and positive process IDs', () => {
  assert.ok(buildWatcherScript(Infinity, '0; bad').includes('Start-Sleep -Milliseconds 1000'));
  assert.ok(buildWatcherScript(1, -3).includes('[uint32]0'));
  assert.ok(buildWatcherScript(1, 1).includes('Start-Sleep -Milliseconds 500'));
  assert.ok(buildWatcherScript(1e12, 1).includes('Start-Sleep -Milliseconds 60000'));
});

console.log(`Desktop presence: ${checks} checks passed.`);
