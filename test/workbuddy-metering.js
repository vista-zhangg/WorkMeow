'use strict';

// Regression test for backend/workbuddy-metering.js.
// Uses temp dirs only (no real ~/.workbuddy / ~/.workmeow), and exercises:
//  - real token counting from providerData.usage (OpenAI camelCase)
//  - cached_tokens extracted from inputTokensDetails
//  - exact-only pricing: a priced model gets cost>0, an unknown model (hy3) gets $0

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { createWorkbuddyMetering } = require('../backend/workbuddy-metering');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

async function main() {
  // 用「今天」构造时间戳，避免硬编码日期跨午夜后 today 桶错位。
  const _n = new Date();
  const todayTs = (h) => `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-meter-test-'));
  const projects = path.join(base, 'projects', 'proj-x', 'sess-1');
  await fsp.mkdir(projects, { recursive: true });
  const jsonl = path.join(projects, 'a.jsonl');

  const lines = [
    // hy3 line (unknown model → should cost $0), with cached tokens in details
    JSON.stringify({
      type: 'message', role: 'assistant', timestamp: todayTs(10),
      providerData: {
        model: 'hy3', messageId: 'm1',
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050,
          inputTokensDetails: [{ cached_tokens: 900 }], outputTokensDetails: [{ reasoning_tokens: 5 }] },
      },
    }),
    // priced model line (gpt-4o present in temp cache → cost>0)
    JSON.stringify({
      type: 'message', role: 'assistant', timestamp: todayTs(11),
      providerData: {
        model: 'gpt-4o', messageId: 'm2',
        usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100,
          inputTokensDetails: [{ cached_tokens: 0 }], outputTokensDetails: [] },
      },
    }),
    // a non-assistant line that must be ignored
    JSON.stringify({ type: 'message', role: 'user', content: 'hi' }),
    // Anthropic 形状（message.usage）：cache_creation 是缓存「写入」，
    // cache_read 是缓存「读取」——两者必须分开计价，且 input 折算为含缓存口径。
    // 价目（下方 models.claude-x）：input 3 / output 15 / cachedInput 0.3 / cacheWrite5m 3.75
    // regularInput = (100+200+50) - 50 - 200 = 100
    // cost = 100*3 + 40*15 + 50*0.3 + 200*3.75 = 300+600+15+750 = 1665 /1e6
    JSON.stringify({
      type: 'assistant', timestamp: todayTs(12),
      message: {
        id: 'msg-a1', model: 'claude-x',
        usage: { input_tokens: 100, output_tokens: 40,
          cache_creation_input_tokens: 200, cache_read_input_tokens: 50 },
      },
    }),
  ];
  await fsp.writeFile(jsonl, lines.join('\n') + '\n', 'utf8');

  // temp pricing cache: only gpt-4o is known (no hy3)
  const cache = {
    ts: Date.now(), source: 'test', url: '',
    pricing: {},
    models: { 'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
      'claude-x': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 } },
  };
  const cachePath = path.join(base, 'pricing-cache.json');
  await fsp.writeFile(cachePath, JSON.stringify(cache), 'utf8');

  const m = createWorkbuddyMetering({
    projectsDir: path.join(base, 'projects'),
    stateDir: base,
    pricingCachePath: cachePath,
    pricingOverridePath: path.join(base, 'no-override.json'),
  });
  await m.scan();
  const s = m.getStats();

  assert(s.today.tokens === 3150 + 390, `today tokens summed (got ${s.today.tokens})`);
  assert(s.today.input === 3000 + 350 && s.today.output === 150 + 40, 'input/output summed');
  assert(s.today.cachedInput === 950, `cached read tokens (got ${s.today.cachedInput})`);
  assert(s.today.cacheWrite === 200, `cache write tokens split from read (got ${s.today.cacheWrite})`);
  assert(s.today.reasoningOutput === 5, `reasoning tokens (got ${s.today.reasoningOutput})`);

  const by = s.byModel;
  assert(by.hy3 && by['gpt-4o'] && by['claude-x'], 'all three models present in byModel');
  assert(by.hy3.cost === 0, `hy3 has no price → cost $0 (got ${by.hy3.cost})`);
  // gpt-4o: 2000 input (2000*2.5=5000) + 100 output (100*10=1000) = 6000 /1e6 = 0.006
  assert(by['gpt-4o'].cost > 0, `gpt-4o priced → cost>0 (got ${by['gpt-4o'].cost})`);
  // Anthropic 形状：缓存写入按 cacheWrite5m 价、缓存读取按 cacheRead 价
  const expectedAnth = 1665 / 1e6;
  assert(Math.abs(by['claude-x'].cost - expectedAnth) < 1e-9,
    `anthropic-shape cache write/read priced separately (got ${by['claude-x'].cost}, want ${expectedAnth})`);

  // exact-only: priceInfo must NOT report estimate
  const pi = m.priceInfo();
  assert(pi.estimate === false, 'priceInfo.estimate is false (no estimation policy)');

  // Streaming correction: the same messageId may report a larger cumulative
  // total later, but it must remain one assistant round.
  m._processObject({}, jsonl, {
    type: 'message', role: 'assistant', timestamp: todayTs(11),
    providerData: {
      model: 'gpt-4o', messageId: 'm2',
      usage: { inputTokens: 2100, outputTokens: 100, totalTokens: 2200 },
    },
  });
  const streamed = m.getStats();
  assert(streamed.today.tokens === 3640, `streaming delta added once (got ${streamed.today.tokens})`);
  assert(streamed.today.msgs === 3, `streaming update does not add a round (got ${streamed.today.msgs})`);

  // Reloading pricing must rebuild existing history, not only change the
  // in-memory lookup for future messages.
  cache.models.hy3 = { input: 1, output: 2, cachedInput: 0.1 };
  await fsp.writeFile(cachePath, JSON.stringify(cache), 'utf8');
  await m.reloadPricing();
  const repriced = m.getStats();
  assert(repriced.byModel.hy3.cost > 0, `pricing reload reprices history (got ${repriced.byModel.hy3.cost})`);
  assert(repriced.today.msgs === 3, `rebuild keeps one round per message (got ${repriced.today.msgs})`);

  // idempotent re-scan must not double count
  await m.scan();
  const s2 = m.getStats();
  assert(s2.today.tokens === 3540, `re-scan does not double count (got ${s2.today.tokens})`);

  // A rotated transcript must reset its cursor. Existing message ids remain
  // deduped, while a new message appended to the shorter file is counted.
  await fsp.writeFile(jsonl, lines[0] + '\n' + JSON.stringify({
    type: 'message', role: 'assistant', timestamp: todayTs(13),
    providerData: { model: 'gpt-4o', messageId: 'm-rotated', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  }) + '\n', 'utf8');
  await m.scan();
  assert(m.getStats().today.tokens === 3555, `rotated transcript resumes from byte zero (got ${m.getStats().today.tokens})`);
  const lifetimeBeforeRebuild = m.getStats().lifetime.tokens;
  await fsp.writeFile(jsonl, lines[0] + '\n', 'utf8');
  await m.rebuild();
  assert(m.getStats().lifetime.tokens >= lifetimeBeforeRebuild,
    'rebuild preserves WorkBuddy lifetime when a rotated source is incomplete');

  // cleanup
  await fsp.rm(base, { recursive: true, force: true });
  console.log('\nALL WORKBUDDY-METERING TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
