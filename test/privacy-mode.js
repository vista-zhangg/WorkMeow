'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const privacy = require('../backend/privacy');
const config = require('../backend/config');
const i18n = require('../shared/i18n');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const raw = {
  today: { tokens: 1200, cost: 0.21, messages: 3 },
  waitingCount: 1,
  needsinputCount: 0,
  workingCount: 1,
  active: { sessionId: 'session-secret', project: '客户并购项目', model: 'claude-sonnet' },
  sessions: [{
    sessionId: 'session-secret', project: '客户并购项目', state: 'waiting',
    op: '修改 D:\\客户\\报价单.md',
    choice: { question: '运行命令：deploy --token secret', options: [{ label: '允许' }] },
  }],
  actions: [{
    id: 'perm-secret', sessionId: 'session-secret', state: 'waiting', reason: 'perm',
    choice: { question: '运行命令：deploy --token secret', options: [{ label: '允许' }] },
  }],
  lastOps: [{
    tool: 'Bash', icon: '⚙️', detail: '运行命令 deploy --token secret',
    file: 'D:\\客户\\报价单.md', project: '客户并购项目', ts: 1,
  }],
  diagnostics: { sourcePath: 'D:\\客户\\报价单.md' },
};

const protectedStats = privacy.protectStats(raw, true);
const serialized = JSON.stringify(protectedStats);
for (const secret of ['客户并购项目', 'deploy --token secret', '报价单.md']) {
  assert(!serialized.includes(secret), `privacy snapshot must remove ${secret}`);
}
assert.strictEqual(protectedStats.privacyMode, true);
assert.strictEqual(protectedStats.active.project, i18n.t('privacy.project'));
assert.strictEqual(protectedStats.sessions[0].project, i18n.t('privacy.project'));
assert.strictEqual(protectedStats.sessions[0].op, null);
assert.strictEqual(protectedStats.sessions[0].choice, null);
assert.strictEqual(protectedStats.actions[0].choice, null,
  'private mode must keep the attention count without exposing an interactive card');
assert.strictEqual(protectedStats.lastOps[0].detail, i18n.t('privacy.hiddenDetail'));
assert.strictEqual(protectedStats.diagnostics, null);
assert.deepStrictEqual(protectedStats.today, raw.today, 'usage summary remains useful in privacy mode');
assert.strictEqual(protectedStats.waitingCount, 1, 'semantic state and attention counts must remain intact');
assert(raw.sessions[0].choice && raw.actions[0].choice, 'redaction must not mutate the internal snapshot');

const visibleStats = privacy.protectStats(raw, false);
assert.strictEqual(visibleStats.privacyMode, false);
assert.strictEqual(visibleStats.sessions[0].project, '客户并购项目');

const privateEvent = privacy.protectEvent({
  kind: 'say', project: '客户并购项目', text: '报价是 42 万', emotion: 'excited',
}, true);
assert.strictEqual(privateEvent.project, i18n.t('privacy.project'));
assert.strictEqual(privateEvent.text, i18n.t('privacy.newMessage'));
assert.strictEqual(privateEvent.emotion, null);
const permissionEvent = privacy.protectEvent({
  kind: 'waiting', project: '客户并购项目', choice: raw.actions[0].choice,
}, true);
assert.strictEqual(permissionEvent.choice, null);
const operationEvent = privacy.protectEvent({
  kind: 'operation', project: '客户并购项目', detail: '修改报价单.md', file: '报价单.md',
}, true);
assert.strictEqual(operationEvent.detail, i18n.t('privacy.hiddenDetail'));
assert.strictEqual(operationEvent.file, '');

assert.strictEqual(config.DEFAULTS.privacyMode, false);
assert.strictEqual(config.sanitize({ privacyMode: true }).privacyMode, true);
assert.strictEqual(config.sanitize({ privacyMode: 'true' }).privacyMode, false);

const main = read('main.js');
const pet = read('renderer/pet.js');
assert(/tray\.privacyMode[\s\S]*?type:\s*'checkbox'[\s\S]*?checked:\s*privacyMode/.test(main),
  'tray must expose a checked one-click privacy toggle');
assert(!/label:\s*t\('tray\.integrations'\)/.test(main),
  'tray must not duplicate integration health from Settings');
assert(/privacy\.protectStats/.test(main) && /privacy\.protectEvent/.test(main),
  'main must redact both snapshots and live events before renderer delivery');
assert(/enteringPrivacy[\s\S]*?hideBubble\(\)/.test(pet),
  'enabling privacy must immediately hide an already visible message');
assert(/s\.privacyMode[\s\S]*?\ud83d\udd12/.test(pet), 'pet capsule must keep a visible privacy indicator');

console.log('privacy mode checks passed');
