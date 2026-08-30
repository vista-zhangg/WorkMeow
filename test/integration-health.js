'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIntegrationHealth, latestEventBySource } = require('../backend/integration-health');
const { createCodexWatch } = require('../backend/codex-watch');
const { createTraeWatch } = require('../backend/trae-watch');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const hookIntegrations = [
  { id: 'claude', label: 'Claude Code', detected: true, connected: true },
  { id: 'workbuddy', label: 'WorkBuddy', detected: true, connected: true },
  { id: 'trae', label: 'TRAE', detected: true, connected: false },
  { id: 'opencode', label: 'opencode', detected: true, connected: true },
];
const watchers = {
  codex: { available: true, running: true },
  trae: { available: true, running: true },
};
const snapshot = {
  sessions: [
    { agentId: 'claude-code', updatedAt: 100 },
    { agentId: 'claude-code', updatedAt: 300 },
    { agentId: 'codex', updatedAt: 200 },
    { agentId: 'unknown', updatedAt: 999 },
  ],
};

const healthy = buildIntegrationHealth({
  hookIntegrations, watchers, codexDetected: true, hooksEnabled: true, snapshot, now: 500,
});
assert.strictEqual(healthy.checkedAt, 500);
assert.deepStrictEqual(healthy.summary, {
  total: 5, detected: 5, ready: 5, needsRepair: 0, repairable: 0, notDetected: 0,
});
assert.strictEqual(healthy.integrations.find((row) => row.id === 'claude').lastEventAt, 300);
assert.strictEqual(healthy.integrations.find((row) => row.id === 'codex').lastEventAt, 200);
assert.strictEqual(healthy.integrations.find((row) => row.id === 'trae').mode, 'watcher',
  'TRAE health must follow its reliable log watcher rather than optional hook delivery');

const disabled = buildIntegrationHealth({
  hookIntegrations, watchers, codexDetected: true, hooksEnabled: false,
});
for (const id of ['claude', 'workbuddy', 'opencode']) {
  const row = disabled.integrations.find((item) => item.id === id);
  assert.strictEqual(row.state, 'disabled');
  assert.strictEqual(row.repairable, true);
}
assert.strictEqual(disabled.integrations.find((row) => row.id === 'codex').state, 'ready');
assert.strictEqual(disabled.integrations.find((row) => row.id === 'trae').state, 'ready');
assert.strictEqual(disabled.summary.needsRepair, 3);

const broken = buildIntegrationHealth({
  hookIntegrations: hookIntegrations.map((row) => row.id === 'claude' ? { ...row, connected: false } : row),
  watchers: {
    codex: { available: true, running: false },
    trae: { available: false, running: false },
  },
  codexDetected: true,
  hooksEnabled: true,
});
assert.strictEqual(broken.integrations.find((row) => row.id === 'claude').state, 'needs-repair');
assert.strictEqual(broken.integrations.find((row) => row.id === 'codex').repairable, true);
assert.strictEqual(broken.integrations.find((row) => row.id === 'trae').repairable, false);
assert.strictEqual(broken.summary.needsRepair, 3);
assert.strictEqual(broken.summary.repairable, 2);

const missing = buildIntegrationHealth({ hookIntegrations: [], watchers: {}, now: 0 });
assert.strictEqual(missing.summary.detected, 0);
assert.strictEqual(missing.summary.repairable, 0);
assert(missing.integrations.every((row) => row.state === 'not-detected'));
assert.deepStrictEqual(latestEventBySource(snapshot), { claude: 300, codex: 200 });
const eventDetected = buildIntegrationHealth({
  hookIntegrations: [],
  watchers: { codex: { available: true, running: true }, trae: { available: true, running: true } },
  snapshot: { sessions: [...snapshot.sessions, { agentId: 'trae', updatedAt: 400 }] },
});
assert.strictEqual(eventDetected.integrations.find((row) => row.id === 'codex').state, 'ready');
assert.strictEqual(eventDetected.integrations.find((row) => row.id === 'trae').state, 'ready',
  'a live read-only session must remain detected without a hook config directory');
assert.strictEqual(eventDetected.integrations.find((row) => row.id === 'claude').detected, false,
  'managed repair must not infer an install target from stale session memory alone');
assert(!JSON.stringify(healthy).includes('cwd') && !JSON.stringify(healthy).includes('token'),
  'health report must not expose project paths or runtime credentials');

const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-health-watch-'));
try {
  const core = { updateSession() {}, setContextUsage() {}, seedSession() {} };
  const codexWatch = createCodexWatch({ core, sessionsDir: path.join(emptyRoot, 'codex'), pollMs: 999999 });
  const traeWatch = createTraeWatch({ core, roots: [path.join(emptyRoot, 'trae')], pollMs: 999999 });
  for (const watcher of [codexWatch, traeWatch]) {
    assert.strictEqual(watcher.isRunning(), false);
    watcher.start();
    assert.strictEqual(watcher.isRunning(), true);
    watcher.start();
    assert.strictEqual(watcher.isRunning(), true, 'watcher repair start must be idempotent');
    watcher.stop();
    assert.strictEqual(watcher.isRunning(), false);
  }
} finally {
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}

const html = read('renderer/settings.html');
const js = read('renderer/settings.js');
const css = read('renderer/settings.css');
const main = read('main.js');
const preload = read('preload.js');
for (const id of ['integrations-section', 'integration-summary', 'integration-list',
  'integration-refresh', 'integration-repair']) {
  assert(html.includes(`id="${id}"`), `settings must expose ${id}`);
}
assert(/getIntegrationHealth/.test(preload) && /repairIntegrations/.test(preload),
  'sandboxed settings bridge must expose health check and repair');
assert(/e\.sender !== settingsWin\.webContents/.test(main),
  'integration repair IPC must reject non-settings renderers');
assert(/integration-row/.test(css) && /integration-state\.needs-repair/.test(css),
  'settings must distinguish compact ready and repair states');
assert(/replaceChildren\(\)/.test(js) && /document\.createElement/.test(js),
  'integration rows must render without interpolating status data as HTML');
assert(/isRunning/.test(read('backend/codex-watch.js')) && /isRunning/.test(read('backend/trae-watch.js')),
  'read-only watchers must expose their running state for health checks');

console.log('integration health checks passed');
