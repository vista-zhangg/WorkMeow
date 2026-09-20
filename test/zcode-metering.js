'use strict';

// ZCode metering checks — fold SQLite model_usage rows into the unified
// ledger, with ZCode's Claude-style token categories (input excludes cache,
// cache read/write are separate columns) and title-generation requests
// counted for tokens but never for messages.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// node:sqlite needs a flag before Node 22.13 (CI pins 22.12); the meter itself
// degrades gracefully there, so only the DB-backed checks below are skipped.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
const { createZcodeMetering, normalizeUsage, usageCost, priceFor } = require('../backend/zcode-metering');

// normalizeUsage: cache columns are separate categories; computed_total wins
// over the sum when present.
const u = normalizeUsage({
  input_tokens: 100, output_tokens: 50, reasoning_tokens: 10,
  cache_read_input_tokens: 30, cache_creation_input_tokens: 20, computed_total_tokens: 200,
});
assert.strictEqual(u.tokens, 200);
assert.strictEqual(u.input, 100);
assert.strictEqual(u.output, 50);
assert.strictEqual(u.reasoningOutput, 10);
assert.strictEqual(u.cachedInput, 30);
assert.strictEqual(u.cacheWrite, 20);

// Missing computed_total falls back to the category sum.
assert.strictEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }).tokens, 15);

// Cost estimation from the built-in tables.
assert(usageCost(u, priceFor('glm-5.3', null)) > 0, 'glm estimate sane');
assert.strictEqual(priceFor('GLM-5.3', null).input, priceFor('glm-4.6', null).input, 'glm family rows match');

async function main() {
  if (!DatabaseSync) {
    console.log('zcode metering checks passed (DB-backed checks skipped: node:sqlite unavailable in this runtime)');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-zcode-meter-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(root, 'db.sqlite');

  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE model_usage (
    id TEXT PRIMARY KEY, session_id TEXT, query_source TEXT, agent TEXT, model_id TEXT,
    status TEXT, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER
  )`);
  // The liveness heartbeat also reads tool_usage (in-flight tools) and the
  // session table (titles) on the same scan; the fixture mirrors ZCode's schema.
  db.exec(`CREATE TABLE tool_usage (
    id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, status TEXT,
    started_at INTEGER, completed_at INTEGER
  )`);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER
  )`);
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO model_usage
    (id, session_id, query_source, agent, model_id, status, completed_at,
     input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens,
     cache_read_input_tokens, computed_total_tokens)
    VALUES (?, 'sess1', ?, 'zcode-agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A real turn with cache traffic.
  insert.run('r1', 'main_turn', 'GLM-5.3', 'completed', now, 1000, 500, 100, 200, 300, 2000);
  // Background title request: tokens count, messages must not.
  insert.run('r2', 'session_title', 'GLM-5.3-Flash', 'completed', now, 50, 20, 0, 0, 0, 70);
  // Failed request: zero tokens, ignored everywhere but the dedupe ledger.
  insert.run('r3', 'main_turn', 'GLM-5.3', 'error', now, 0, 0, 0, 0, 0, 0);
  // In-flight request: no completion timestamp yet.
  insert.run('r4', 'main_turn', 'GLM-5.3', 'completed', null, 10, 5, 0, 0, 0, 15);
  // A tool mid-execution (long Bash) — liveness evidence without model rows;
  // a stale in-flight row older than the window must NOT count; a completed
  // tool neither.
  db.prepare('INSERT INTO tool_usage VALUES (?, ?, ?, ?, ?, ?)')
    .run('t1', 'sess-tool', 'Bash', 'running', now, null);
  db.prepare('INSERT INTO tool_usage VALUES (?, ?, ?, ?, ?, ?)')
    .run('t2', 'sess-stale', 'Bash', 'running', now - 25 * 60 * 1000, null);
  db.prepare('INSERT INTO tool_usage VALUES (?, ?, ?, ?, ?, ?)')
    .run('t3', 'sess1', 'Bash', 'completed', now - 1000, now - 990);
  // Recent titled session + archived + too-old sessions for the backfill query.
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
    .run('sess1', 'D:\\proj', '标题一', now, null);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
    .run('sess-arch', 'D:\\old', '已归档', now, now);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
    .run('sess-old', 'D:\\older', '太旧', now - 60 * 60 * 1000, null);
  db.close();

  const activitySeen = [];
  const meter = createZcodeMetering({
    dbPath, stateDir,
    onSessionActivity: (activity) => activitySeen.push(activity),
  });
  await meter.scan();
  let stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 2070, 'title tokens count but r3/r4 do not');
  assert.strictEqual(stats.today.input, 1050);
  assert.strictEqual(stats.today.output, 520);
  assert.strictEqual(stats.today.cachedInput, 300);
  assert.strictEqual(stats.today.cacheWrite, 200);
  assert.strictEqual(stats.today.msgs, 1, 'session_title requests are never messages');
  assert(stats.today.cost > 0, 'cost estimated from the price table');
  assert.strictEqual(stats.lifetime.tokens, 2070);
  assert.strictEqual(stats.hourlyTok.reduce((a, b) => a + b, 0), 2070);
  const modelRow = stats.byModel['GLM-5.3'];
  assert(modelRow, 'byModel has GLM-5.3');
  assert.strictEqual(modelRow.cacheRead, 300, 'cacheRead mapped for the panel');
  assert.strictEqual(modelRow.cacheWrite5m, 200);
  assert.strictEqual(modelRow.msgs, 1);

  // Session liveness: one callback per scan, carrying fresh model completions
  // + in-flight tools + titles (the「工作没有停」evidence core.touchSession
  // consumes so a long ZCode task is never mistaken for stuck).
  assert.strictEqual(activitySeen.length, 1, 'one activity callback per scan');
  const act = activitySeen[0];
  assert(act.sess1 && act.sess1.at === now, 'completed model row touches its session');
  assert.strictEqual(act.sess1.title, '标题一', 'title comes from the session table');
  assert(act['sess-tool'] && act['sess-tool'].at >= now, 'in-flight tool marks its session live');
  assert(!('sess-stale' in act), 'stale in-flight tool outside the window is ignored');
  assert(!('sess-arch' in act) && !('sess-old' in act), 'untouched sessions stay untouched');

  // Boot backfill: recent, non-archived sessions with titles — ZCode sessions
  // show up in the pet list (with a title) before the next hook event.
  const backfill = meter.readSessions({ cutoffMs: 30 * 60 * 1000, limit: 10 });
  assert.deepStrictEqual(backfill.map((r) => r.id), ['sess1'], 'only the recent session backfills');
  assert.strictEqual(backfill[0].title, '标题一');
  assert.strictEqual(backfill[0].cwd, 'D:\\proj');
  assert(backfill[0].updatedAt > 0, 'updatedAt = session.time_updated');

  // Second scan must not double count (watermark + records dedupe).
  await meter.scan();
  stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 2070, 'second scan must not double count');
  assert.strictEqual(stats.today.msgs, 1);
  assert.strictEqual(activitySeen.length, 2, 'second scan still reports liveness for the in-flight tool');
  assert.strictEqual(activitySeen[1]['sess-tool'].at >= now, true, 'in-flight tool keeps the session live');

  // The in-flight row completes later: next scan folds it in.
  const db2 = new DatabaseSync(dbPath);
  db2.prepare('UPDATE model_usage SET completed_at = ? WHERE id = ?').run(now + 5, 'r4');
  db2.close();
  await meter.scan();
  stats = meter.getStats();
  assert.strictEqual(stats.today.tokens, 2085, 'late-completing row is picked up');
  assert.strictEqual(stats.today.msgs, 2);

  // Rebuild from the surviving rows keeps the lifetime ledger intact.
  const lifetimeBeforeRebuild = meter.getStats().lifetime.tokens;
  await meter.rebuild();
  assert(meter.getStats().lifetime.tokens >= lifetimeBeforeRebuild,
    'rebuild preserves zcode lifetime');

  // A database that disappears must degrade to empty scans, not throw.
  const missing = createZcodeMetering({
    dbPath: path.join(root, 'gone.sqlite'),
    stateDir: path.join(root, 'state-missing'),
  });
  await missing.scan();
  assert.strictEqual(missing.getStats().today.tokens, 0);
  assert(missing.getStats().diagnostics.unavailable, 'missing db is reported in diagnostics');

  meter.stop();
  missing.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('zcode metering checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
