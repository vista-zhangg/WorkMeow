'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodexMetering } = require('../backend/codex-metering');

async function main(schemaVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-history-'));
  const sessionsDir = path.join(root, 'sessions');
  const archivedSessionsDir = path.join(root, 'archived_sessions');
  const stateDir = path.join(root, 'state');
  for (const dir of [sessionsDir, archivedSessionsDir, stateDir]) fs.mkdirSync(dir);
  const statePath = path.join(stateDir, 'codex-usage.json');
  const at = Date.now() - 60000;
  const usage = tokens => ({ input_tokens: tokens, output_tokens: 0, total_tokens: tokens });
  const event = (ts, total, last) => ({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(last) },
  } });
  const rows = (id, events) => [
    { type: 'session_meta', payload: { id } },
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    ...events,
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  const file = path.join(sessionsDir, 'rollout-known.jsonl');
  const oldEvent = event(at - 1000, 100, 100);
  const newEvent = event(at + 1000, 125, 25);
  fs.writeFileSync(file, rows('known', [oldEvent, newEvent]));
  fs.writeFileSync(path.join(archivedSessionsDir, 'rollout-unseen.jsonl'), rows('archived', [event(at - 2000, 40, 40)]));
  const snapshot = { schemaVersion, lifetime: { tokens: 1000, input: 1000, cost: 5, msgs: 10 },
    diagnostics: { lastScanTs: at }, files: { [file]: { sessionId: 'known' } },
    sessions: { known: { updatedAt: at, usage: usage(100) } } };
  fs.writeFileSync(statePath, JSON.stringify(snapshot));
  let meter = createCodexMetering({ sessionsDir, stateDir });
  try {
    await meter.scan();
    assert.equal(meter.getStats().lifetime.tokens, 1065, 'migration preserves missing history, adds new and previously unseen archived usage');
    assert.equal(meter.getStats().today.tokens, 165, 'calendar replay excludes inaccessible historical base');
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath + '.before-v5.bak')), snapshot, 'upgrade backs up the exact original ledger');
    const beforeMove = meter.getStats().lifetime;
    fs.renameSync(file, path.join(archivedSessionsDir, path.basename(file)));
    await meter.scan();
    assert.deepEqual(meter.getStats().lifetime, beforeMove, 'archiving does not count the file twice');
    meter.stop();
    meter = createCodexMetering({ sessionsDir, stateDir });
    await meter.scan();
    assert.deepEqual(meter.getStats().lifetime, beforeMove, 'restart does not replay money');

    const recovery = { ...snapshot, lifetime: { ...snapshot.lifetime, tokens: 2000, input: 2000, cost: 8, msgs: 20 } };
    const restored = (await meter.restoreLifetime(recovery, 'test-backup')).lifetime;
    assert.equal(restored.tokens, 2025, 'recovery adds only events after the backup cutoff');
    assert(restored.cost > 8 && restored.cost < 8.01, 'old cost is preserved, with only the new request added');
    assert.deepEqual((await meter.restoreLifetime(recovery, 'test-backup')).lifetime, restored, 'same recovery is idempotent');

    fs.writeFileSync(path.join(sessionsDir, 'rollout-late-archive.jsonl'), rows('late-archive', [event(at - 5000, 90, 90)]));
    await meter.scan();
    assert.deepEqual(meter.getStats().lifetime, restored, 'late discovery before the restored cutoff is already covered');
    const next = event(at + 2000, 175, 50);
    const moved = path.join(archivedSessionsDir, path.basename(file));
    fs.appendFileSync(moved, JSON.stringify(next) + '\n');
    await meter.scan();
    assert.equal(meter.getStats().lifetime.tokens, 2075, 'new activity remains additive after restoration');
    const afterNew = meter.getStats().lifetime;
    fs.unlinkSync(moved);
    await meter.rebuild();
    assert.deepEqual(meter.getStats().lifetime, afterNew, 'rebuild cannot erase deleted source or reprice historical money');
    meter.stop();
    meter = createCodexMetering({ sessionsDir, stateDir });
    fs.writeFileSync(moved, rows('known', [oldEvent, newEvent, next]));
    await meter.rebuild();
    assert.deepEqual(meter.getStats().lifetime, afterNew, 'reappearing logs remain deduplicated after restart');
    await assert.rejects(meter.restoreLifetime(snapshot), /reduce/);
    assert.deepEqual(meter.getStats().lifetime, afterNew, 'an insufficient snapshot leaves history intact');
  } finally {
    meter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('codex history preservation and recovery checks passed');
}
(async () => { for (const schema of [3, 4]) await main(schema); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
