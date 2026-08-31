'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  mergeRateLimitPayload,
  normalizeAccount,
  normalizeRateLimits,
  createAlertDeduper,
  createCodexRateLimits,
} = require('../backend/codex-rate-limits');
const { resolveCodexCommand } = require('../backend/codex-cli-resolver');
const { isAuthStoreEvent, createCodexAccountWatch } = require('../backend/codex-account-watch');
const quotaTray = require('../backend/codex-quota-tray');

const reset5h = Math.floor(new Date(2026, 7, 30, 14, 20).getTime() / 1000);
const resetWeek = Math.floor(new Date(2026, 8, 3, 9, 20).getTime() / 1000);

function payload(primary = null, secondary = null) {
  return {
    rateLimits: {
      limitId: 'codex',
      primary,
      secondary,
      rateLimitReachedType: null,
    },
  };
}

function window(usedPercent, windowDurationMins, resetsAt) {
  return { usedPercent, windowDurationMins, resetsAt };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    this.emit('exit', 0, null);
  }
}

async function main() {
  const account = normalizeAccount({
    account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' },
  });
  assert.deepStrictEqual(account, { type: 'chatgpt', email: 'me@example.com', planType: 'plus' });

  const normalized = normalizeRateLimits(payload(
    window(25, 300, reset5h),
    window(82, 10080, resetWeek),
  ), 1234);
  assert.strictEqual(normalized.windows.fiveHour.remainingPercent, 75);
  assert.strictEqual(normalized.windows.weekly.remainingPercent, 18);
  assert.strictEqual(normalized.severity, 'amber');
  assert.strictEqual(normalized.updatedAt, 1234);

  const proLike = normalizeRateLimits(payload(null, window(7, 10080, resetWeek)));
  assert.strictEqual(proLike.windows.fiveHour, null, 'a missing 5h window must stay missing');
  assert.strictEqual(proLike.windows.weekly.remainingPercent, 93);
  const byLimitId = normalizeRateLimits({
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: window(8, 10080, resetWeek), secondary: null },
    },
  });
  assert.strictEqual(byLimitId.windows.weekly.remainingPercent, 92,
    'newer multi-bucket responses must use the canonical codex bucket');
  assert.strictEqual(byLimitId.windows.weekly.windowId, proLike.windows.weekly.windowId,
    'window identity must not depend on the primary/secondary slot');
  const conflictingViews = normalizeRateLimits({
    rateLimits: { limitId: 'codex', primary: window(90, 300, reset5h), secondary: null },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: window(10, 300, reset5h), secondary: null },
    },
  });
  assert.strictEqual(conflictingViews.windows.fiveHour.remainingPercent, 90,
    'the canonical codex bucket must take precedence over the legacy single-bucket view');
  const unknown = normalizeRateLimits(payload(window(10, 60, reset5h), null));
  assert.strictEqual(unknown.windows.fiveHour, null, 'an unknown duration must not be guessed as 5h');
  assert.strictEqual(unknown.windows.weekly, null, 'an unknown duration must not be guessed as weekly');

  const initial = payload(window(25, 300, reset5h), window(40, 10080, resetWeek));
  const merged = mergeRateLimitPayload(initial, {
    rateLimits: { limitId: 'codex', primary: { usedPercent: 81 } },
  });
  const afterDelta = normalizeRateLimits(merged);
  assert.strictEqual(afterDelta.windows.fiveHour.remainingPercent, 19);
  assert.strictEqual(afterDelta.windows.fiveHour.windowDurationMins, 300);
  assert.strictEqual(afterDelta.windows.weekly.remainingPercent, 60,
    'an incremental primary update must preserve the weekly window');

  const rows = quotaTray.displayRows(normalized);
  assert.strictEqual(rows.fiveHour.remaining, '75%');
  assert.strictEqual(rows.weekly.remaining, '18%');
  assert.strictEqual(rows.weekly.reset, '周四 09:20');
  assert.strictEqual(quotaTray.accountText(account), 'm***@example.com · Plus');
  assert.strictEqual(quotaTray.updatedText(new Date(2026, 7, 30, 18, 31, 45).getTime()), '18:31',
    'tray update time should stay compact and omit seconds');
  const missingRows = quotaTray.displayRows(null);
  assert.strictEqual(missingRows.fiveHour.remaining, '--');
  assert.strictEqual(missingRows.weekly.reset, '--');
  assert.strictEqual(missingRows.updated, '--');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-rate-limits-'));
  const dedupePath = path.join(temp, 'alerts.json');
  const alerts = [];
  const service = createCodexRateLimits({
    dedupePath,
    now: () => new Date(2026, 7, 30, 9, 0).getTime(),
    onAlert: (alert) => alerts.push(alert),
  });
  service._accept(payload(window(80, 300, reset5h), null), true);
  service._accept({ rateLimits: { primary: { usedPercent: 90 } } }, false);
  assert.strictEqual(alerts.length, 1, 'one window/reset cycle may alert only once');
  assert.strictEqual(fs.existsSync(dedupePath), false,
    'an alert must not be claimed before the UI acknowledges that it was shown');
  assert.strictEqual(service.acknowledgeAlert(alerts[0].alertId), true);
  service._accept(payload(window(90, 300, reset5h + 18000), null), true);
  assert.strictEqual(alerts.length, 2, 'a new resetsAt value starts a new alert cycle');
  assert.strictEqual(service.acknowledgeAlert(alerts[1].alertId), true);
  assert(fs.existsSync(dedupePath), 'alert dedupe must survive an app restart');
  const afterRestartAlerts = [];
  const restarted = createCodexRateLimits({
    dedupePath,
    now: () => new Date(2026, 7, 30, 9, 1).getTime(),
    onAlert: (alert) => afterRestartAlerts.push(alert),
  });
  restarted._accept(payload(window(95, 300, reset5h + 18000), null), true);
  assert.strictEqual(afterRestartAlerts.length, 0, 'persisted dedupe must suppress the same cycle after restart');

  const unseenPath = path.join(temp, 'unseen-alerts.json');
  const unseenAlerts = [];
  createCodexRateLimits({ dedupePath: unseenPath, onAlert: (alert) => unseenAlerts.push(alert) })
    ._accept(payload(window(90, 300, reset5h), null), true);
  assert.strictEqual(fs.existsSync(unseenPath), false, 'an unseen alert must remain unclaimed on disk');
  createCodexRateLimits({ dedupePath: unseenPath, onAlert: (alert) => unseenAlerts.push(alert) })
    ._accept(payload(window(90, 300, reset5h), null), true);
  assert.strictEqual(unseenAlerts.length, 2, 'an unseen cycle must be offered again after restart');

  const boundedPath = path.join(temp, 'bounded-alerts.json');
  const boundedDeduper = createAlertDeduper({ file: boundedPath, now: () => Date.now() });
  const futureReset = Math.floor(Date.now() / 1000) + 3600;
  for (let i = 0; i < 80; i++) {
    boundedDeduper.claim({ windowId: 'codex:300', resetsAt: futureReset + i });
  }
  const boundedRecords = JSON.parse(fs.readFileSync(boundedPath, 'utf8')).records;
  assert.strictEqual(boundedRecords.length, 64, 'alert dedupe state must stay bounded instead of growing like a log');

  const proc = new FakeProcess();
  const writes = [];
  proc.stdin.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').trim().split('\n')) {
      if (line) writes.push(JSON.parse(line));
    }
  });
  let spawnArgs = null;
  let latest = null;
  const live = createCodexRateLimits({
    spawn: (command, args, options) => {
      spawnArgs = { command, args, options };
      return proc;
    },
    resolveCommand: () => ({ command: 'fake-codex.exe', args: ['app-server', '--stdio'], source: 'test' }),
    watchAccount: false,
    pollIntervalMs: 0,
    sessionMaxAgeMs: 0,
    dedupePath: null,
    onUpdate: (state) => { latest = state; },
  });
  live.start();
  assert.deepStrictEqual(spawnArgs.args, ['app-server', '--stdio']);
  assert.strictEqual(spawnArgs.options.shell, false);
  assert.strictEqual(writes[0].method, 'initialize');
  assert.strictEqual(writes[0].params.clientInfo.name, 'workmeow');

  proc.stdout.write(`${JSON.stringify({ id: writes[0].id, result: { userAgent: 'codex' } })}\n`);
  await tick();
  assert.strictEqual(writes[1].method, 'initialized');
  assert.strictEqual(writes[2].method, 'account/read');
  assert.deepStrictEqual(writes[2].params, { refreshToken: false });
  proc.stdout.write(`${JSON.stringify({
    id: writes[2].id,
    result: { account: { type: 'chatgpt', email: 'first@example.com', planType: 'plus' }, requiresOpenaiAuth: true },
  })}\n`);
  await tick();
  assert.strictEqual(writes[3].method, 'account/rateLimits/read');
  proc.stdout.write(`${JSON.stringify({ id: writes[3].id, result: initial })}\n`);
  await tick();
  assert.strictEqual(latest.windows.fiveHour.remainingPercent, 75);
  assert.strictEqual(latest.windows.weekly.remainingPercent, 60);
  assert.strictEqual(latest.account.email, 'first@example.com');
  assert.strictEqual(proc.killed, false, 'the App Server must remain alive after the initial read');

  proc.stdout.write(`${JSON.stringify({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { primary: { usedPercent: 95 } } },
  })}\n`);
  await tick();
  assert.strictEqual(latest.windows.fiveHour.remainingPercent, 5);
  assert.strictEqual(latest.windows.weekly.remainingPercent, 60);
  assert.strictEqual(latest.severity, 'red');

  proc.stdout.write(`${JSON.stringify({
    method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' },
  })}\n`);
  await tick();
  assert.strictEqual(latest.status, 'connecting');
  assert.strictEqual(latest.windows.fiveHour, null,
    'account changes must clear the previous account quota immediately');
  assert.strictEqual(writes[4].method, 'account/read');
  proc.stdout.write(`${JSON.stringify({
    id: writes[4].id,
    result: { account: { type: 'chatgpt', email: 'second@example.com', planType: 'pro' }, requiresOpenaiAuth: true },
  })}\n`);
  await tick();
  assert.strictEqual(writes[5].method, 'account/rateLimits/read');
  proc.stdout.write(`${JSON.stringify({ id: writes[5].id, result: payload(null, window(12, 10080, resetWeek)) })}\n`);
  await tick();
  assert.strictEqual(latest.account.email, 'second@example.com');
  assert.strictEqual(latest.windows.fiveHour, null);
  assert.strictEqual(latest.windows.weekly.remainingPercent, 88);
  live.stop();
  assert.strictEqual(proc.killed, true);

  if (process.platform === 'win32') {
    const localRoot = path.join(temp, 'local');
    const oldExe = path.join(localRoot, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe');
    const newExe = path.join(localRoot, 'OpenAI', 'Codex', 'bin', 'new', 'codex.exe');
    fs.mkdirSync(path.dirname(oldExe), { recursive: true });
    fs.mkdirSync(path.dirname(newExe), { recursive: true });
    fs.writeFileSync(oldExe, 'old');
    fs.writeFileSync(newExe, 'new');
    fs.utimesSync(oldExe, new Date(1000), new Date(1000));
    fs.utimesSync(newExe, new Date(2000), new Date(2000));
    const resolved = resolveCodexCommand({ env: { LOCALAPPDATA: localRoot, Path: '' } });
    assert.strictEqual(resolved.command, newExe,
      'GUI startup must discover the newest Codex desktop native executable without PATH');
    assert.strictEqual(resolved.source, 'codex-desktop');
  }
  assert.strictEqual(isAuthStoreEvent('auth.json'), true);
  assert.strictEqual(isAuthStoreEvent('auth.json.123.tmp'), true);
  assert.strictEqual(isAuthStoreEvent('config.toml'), false);
  let watchCallback = null;
  let scheduledChange = null;
  let accountChanges = 0;
  const fakeAccountWatch = createCodexAccountWatch({
    codexHome: temp,
    watch: (_directory, _options, callback) => {
      watchCallback = callback;
      return { close() {}, on() {} };
    },
    setTimeout: (callback) => {
      scheduledChange = callback;
      return { unref() {} };
    },
    clearTimeout: () => {},
    onChange: () => { accountChanges++; },
  });
  assert.strictEqual(fakeAccountWatch.start(), true);
  watchCallback('change', 'config.toml');
  assert.strictEqual(scheduledChange, null, 'unrelated Codex files must not reconnect the quota client');
  watchCallback('rename', 'auth.json');
  assert.strictEqual(typeof scheduledChange, 'function');
  scheduledChange();
  assert.strictEqual(accountChanges, 1, 'auth store replacement must trigger one debounced reconnect');
  fakeAccountWatch.stop();

  console.log('codex rate-limits checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
