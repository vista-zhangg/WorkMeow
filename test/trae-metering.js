'use strict';

// Regression test for backend/trae-metering.js.
// Synthetic ai-agent stdout log with TokenUsageEvent lines; temp dirs only.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { createTraeMetering, parseUsageLine } = require('../backend/trae-metering');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

async function main() {
  // 用「今天」构造时间戳，避免硬编码日期跨午夜后 today 桶错位。
  const _n = new Date();
  const todayTs = (h) => `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000000+08:00`;

  // ── line parser ──────────────────────────────────────────────────────────
  const line = '2026-06-29T12:29:49.880117+08:00  INFO generate_session_title_and_icon: ai_agent::domain::model::llm_stream: token usage: TokenUsageEvent { name: "", prompt_tokens: 608, completion_tokens: 28, total_tokens: 636, reasoning_tokens: Some(0), cache_creation_input_tokens: Some(0), cache_read_input_tokens: Some(0), prompt_tokens_total: Some(0), completion_tokens_total: Some(0) }';
  const p = parseUsageLine(line);
  assert(p && p.usage.tokens === 636, 'parser reads total tokens');
  assert(p.usage.input === 608 && p.usage.output === 28, 'parser reads prompt/completion');
  assert(Number.isFinite(p.ts), 'parser reads timestamp');

  const line2 = `${todayTs(10)}  INFO chat: token usage: TokenUsageEvent { name: "glm-5", prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, reasoning_tokens: Some(40), cache_creation_input_tokens: Some(200), cache_read_input_tokens: Some(300) }`;
  const p2 = parseUsageLine(line2);
  assert(p2 && p2.name === 'glm-5', 'parser reads model name');
  assert(p2.usage.input === 1200, `input = prompt + cache write (got ${p2.usage.input})`);
  assert(p2.usage.cachedInput === 300 && p2.usage.cacheWrite === 200, 'cache read/write split');
  assert(p2.usage.reasoningOutput === 40, 'reasoning tokens');
  assert(parseUsageLine('2026-08-07 INFO nothing here') === null, 'non-usage line ignored');

  // ── ledger ───────────────────────────────────────────────────────────────
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'trae-meter-test-'));
  const modDir = path.join(base, 'logs', '20260629T122836', 'Modular');
  await fsp.mkdir(modDir, { recursive: true });
  const logFile = path.join(modDir, 'ai-agent_0_1782707316299_stdout.log');
  const lines = [
    `${todayTs(9)}  INFO boot: starting up`,
    line2,
    // unknown model → cost 0, tokens still counted
    `${todayTs(11)}  INFO chat: token usage: TokenUsageEvent { name: "hy3", prompt_tokens: 500, completion_tokens: 50, total_tokens: 550, reasoning_tokens: None, cache_creation_input_tokens: Some(0), cache_read_input_tokens: Some(0) }`,
  ];
  await fsp.writeFile(logFile, lines.join('\n') + '\n', 'utf8');

  const cache = {
    ts: Date.now(), source: 'test', url: '',
    pricing: {},
    models: { 'glm-5': { input: 1, output: 4, cachedInput: 0.1, cacheWrite5m: 1.25 } },
  };
  const cachePath = path.join(base, 'pricing-cache.json');
  await fsp.writeFile(cachePath, JSON.stringify(cache), 'utf8');

  const m = createTraeMetering({
    logsRoot: path.join(base, 'logs'),
    stateDir: base,
    pricingCachePath: cachePath,
    pricingOverridePath: path.join(base, 'no-override.json'),
    modelStateDirs: [path.join(base, 'no-such-dir')],
  });
  await m.scan();
  const s = m.getStats();

  assert(s.today.tokens === 1650, `today tokens summed (got ${s.today.tokens})`);
  const by = s.byModel;
  assert(by['glm-5'] && by.hy3, 'both models present in byModel');
  // glm-5: regularInput = 1200-300-200=700 → 700*1 + 100*4 + 300*0.1 + 200*1.25 = 700+400+30+250 = 1380 /1e6
  const expected = 1380 / 1e6;
  assert(Math.abs(by['glm-5'].cost - expected) < 1e-9, `glm-5 cost exact (got ${by['glm-5'].cost}, want ${expected})`);
  assert(by.hy3.cost === 0, 'unknown model → cost $0');

  // idempotent re-scan
  await m.scan();
  assert(m.getStats().today.tokens === 1650, 're-scan does not double count');

  // incremental append is picked up
  await fsp.appendFile(logFile, line2.replace(`${todayTs(10)}`, `${todayTs(12)}`) + '\n', 'utf8');
  await m.scan();
  assert(m.getStats().today.tokens === 2750, `appended line counted (got ${m.getStats().today.tokens})`);

  // A truncated log can retain old lines and add new ones. Retained occurrences
  // must be skipped, while a genuinely repeated identical line is still valid.
  await fsp.writeFile(logFile, line2 + '\n' + line2 + '\n', 'utf8');
  await m.scan();
  assert(m.getStats().today.tokens === 3850,
    `truncation skips one retained occurrence but counts the second identical event (got ${m.getStats().today.tokens})`);
  const lifetimeBeforeRebuild = m.getStats().lifetime.tokens;
  await fsp.writeFile(logFile, line2 + '\n', 'utf8');
  await m.rebuild();
  assert(m.getStats().lifetime.tokens >= lifetimeBeforeRebuild,
    'rebuild preserves TRAE lifetime when a rotated source is incomplete');

  const pi = m.priceInfo();
  assert(pi.live === true && pi.source === 'models.dev' && pi.count >= 1, 'priceInfo reports models.dev cache');

  await fsp.rm(base, { recursive: true, force: true });
  console.log('\nALL TRAE-METERING TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
