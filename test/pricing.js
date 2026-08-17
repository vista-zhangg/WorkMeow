'use strict';

// Pricing unit test — per-model-id billing (the bug: every model that wasn't
// opus/sonnet/haiku, e.g. claude-fable-5, silently billed at the sonnet default;
// and opus generations were folded to one price). No network / no real files —
// drives extractModels + priceFor off an inline models.dev-shaped fixture.
// Run: node test/pricing.js

const assert = require('assert');
const {
  normModelName, priceFor, DEFAULT_PRICING,
  mergePriceRow, usageSnapshot, mergeUsage, usageDelta, usageCost,
} = require('../backend/metering');
const { _extractModels, _extractOtherModels } = require('../backend/pricing-sync');
const { contextLimit } = require('../backend/transcript');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// models.dev-shaped fixture: anthropic provider 内的 Claude 模型；openai provider
// 下的 gpt 不应混入 extractModels。cost 单位已是 USD per-million-token（无需换算）。
const TABLE = {
  anthropic: {
    id: 'anthropic', name: 'Anthropic',
    models: {
      'claude-fable-5': { name: 'Claude Fable 5', release_date: '2025-01-01', modalities: { input: ['text'], output: ['text'] }, cost: { input: 10, output: 50, cache_write: 12.5, cache_read: 1 } },
      'claude-opus-4-8': { name: 'Claude Opus 4.8', release_date: '2025-06-01', modalities: { input: ['text'], output: ['text'] }, cost: { input: 5, output: 25 }, context_window: 1000000 },
      'claude-opus-4-1': { name: 'Claude Opus 4.1', release_date: '2025-03-01', modalities: { input: ['text'], output: ['text'] }, cost: { input: 15, output: 75 } },
      'claude-opus-4-5-20251101': { name: 'Claude Opus 4.5', release_date: '2025-11-01', modalities: { input: ['text'], output: ['text'] }, cost: { input: 5, output: 25 } },
    },
  },
  openai: {
    id: 'openai', name: 'OpenAI',
    models: { 'gpt-4o': { name: 'GPT-4o', modalities: { input: ['text'], output: ['text'] }, cost: { input: 2.5, output: 10 } } },
  },
};

console.log('[P1] normModelName 规范化');
check('裸名不变', () => assert.strictEqual(normModelName('claude-fable-5'), 'claude-fable-5'));
check('去 provider/区域前缀', () => assert.strictEqual(normModelName('us.anthropic.claude-opus-4-8'), 'claude-opus-4-8'));
check('去 8 位日期后缀', () => assert.strictEqual(normModelName('claude-opus-4-5-20251101'), 'claude-opus-4-5'));
check('去版本后缀 -v1:0', () => assert.strictEqual(normModelName('claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5'));
check('空/异常输入不崩', () => { assert.strictEqual(normModelName(''), ''); assert.strictEqual(normModelName(null), ''); });

console.log('[P2] extractModels：只取 anthropic 直连，按裸名');
const models = _extractModels(TABLE);
check('fable-5 精确价 10/50', () => assert(models['claude-fable-5'].input === 10 && models['claude-fable-5'].output === 50));
check('cache 价缺失 → 5m 1.25x / 1h 2x / read 0.1x', () => {
  const m = models['claude-opus-4-8'];
  assert.strictEqual(m.cacheWrite5m, 6.25);
  assert.strictEqual(m.cacheWrite1h, 10);
  assert.strictEqual(m.cacheRead, 0.5);
});
check('opus 各代区分（4-1=15，4-8=5）', () => assert(models['claude-opus-4-1'].input === 15 && models['claude-opus-4-8'].input === 5));
check('带日期变体折叠到裸名', () => assert(models['claude-opus-4-5'] && models['claude-opus-4-5'].input === 5));
check('精确模型同步 context window', () => assert.strictEqual(models['claude-opus-4-8'].contextWindow, 1000000));
check('anthropic provider 内 claude 精确抽取（fable 直连 10）', () => assert.strictEqual(models['claude-fable-5'].input, 10));
check('非 claude 模型被跳过（openai 不混入）', () => assert(!Object.keys(models).some((k) => k.includes('gpt'))));

console.log('[P3] priceFor：精确 id → 家族关键词 → default');
const pricing = { ...JSON.parse(JSON.stringify(DEFAULT_PRICING)), _models: models };
check('fable-5 走精确 10/50（不再落 sonnet 3/15）', () => { const p = priceFor(pricing, 'claude-fable-5'); assert(p.input === 10 && p.output === 50); });
check('opus-4-1 与 opus-4-8 不同价', () => assert(priceFor(pricing, 'claude-opus-4-1').input === 15 && priceFor(pricing, 'claude-opus-4-8').input === 5));
check('未同步 → fable 家族兜底（仍 10，非 sonnet）', () => { const p2 = { ...JSON.parse(JSON.stringify(DEFAULT_PRICING)), _models: {} }; assert.strictEqual(priceFor(p2, 'claude-fable-5').input, 10); });
check('完全未知模型 → default', () => {
  const p2 = { ...JSON.parse(JSON.stringify(DEFAULT_PRICING)), _models: {} };
  assert.deepStrictEqual(priceFor(p2, 'totally-unknown'), p2.default);
});
check('无 _models 字段也不崩', () => assert(priceFor(DEFAULT_PRICING, 'claude-opus-4-8')));
check('旧 pricing.json 的 cacheWrite 仍覆盖 5m 单价', () => {
  const row = mergePriceRow(DEFAULT_PRICING.sonnet, { cacheWrite: 9 });
  assert.strictEqual(row.cacheWrite5m, 9);
  assert.strictEqual(row.cacheWrite1h, 6);
});

console.log('[P4] streaming usage + cache TTL');
const first = usageSnapshot({
  input_tokens: 4,
  output_tokens: 2,
  cache_creation_input_tokens: 120,
  cache_read_input_tokens: 50,
  cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 100 },
});
const final = usageSnapshot({
  input_tokens: 4,
  output_tokens: 372,
  cache_creation_input_tokens: 120,
  cache_read_input_tokens: 50,
  cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 100 },
});
const merged = mergeUsage(first, final);
const delta = usageDelta(first, merged);
check('同 message 后续流式记录只补输出增量', () => {
  assert.strictEqual(delta.output, 370);
  assert.strictEqual(delta.input, 0);
  assert.strictEqual(delta.cacheWrite5m, 0);
  assert.strictEqual(delta.cacheWrite1h, 0);
});
check('缓存 TTL 从 transcript 精确拆分', () => {
  assert.strictEqual(final.cacheWrite5m, 20);
  assert.strictEqual(final.cacheWrite1h, 100);
});
check('1h cache write 按 2x 而非 5m 的 1.25x', () => {
  const p = { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 };
  assert.strictEqual(usageCost({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 1000000, cacheRead: 0 }, p), 20);
});
check('上下文百分比优先使用精确模型窗口', () => {
  const table = { _models: models };
  assert.strictEqual(contextLimit('claude-opus-4-8', 10000, table), 1000000);
  assert.strictEqual(contextLimit('claude-opus-4-1', 10000, table), 200000);
});

console.log('[P5] extractOtherModels：国产/其它厂商精确价（WorkBuddy、TRAE 用）');
// models.dev 按 provider 分组，每个 provider 即官方厂商。
// anthropic/openai 被 SKIP，不混入 otherModels；非对话模型按 modalities/NON_CHAT 过滤。
const OTHER_TABLE = {
  zai: { id: 'zai', name: 'Zhipu', models: {
    'glm-5': { name: 'GLM-5', modalities: { input: ['text'], output: ['text'] }, cost: { input: 1, output: 3.2 }, context_window: 128000 },
  } },
  moonshotai: { id: 'moonshotai', name: 'Moonshot', models: {
    'kimi-k2.5': { name: 'Kimi K2.5', modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.6, output: 3 } },
  } },
  alibaba: { id: 'alibaba', name: 'Alibaba', models: {
    'qwen-plus-2025-07-28': { name: 'Qwen Plus', modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.4, output: 1.2 } },
    'qwen-image-2.0': { name: 'Qwen Image', modalities: { input: ['text'], output: ['image'] }, cost: { input: 5, output: 5 } }, // 输出 image → 非对话不收
  } },
  deepseek: { id: 'deepseek', name: 'DeepSeek', models: {
    'deepseek-v3.2': { name: 'DeepSeek V3.2', modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.28, output: 0.4 } },
  } },
  bytedance: { id: 'bytedance', name: 'ByteDance', models: {
    'doubao-embedding': { name: 'Doubao Embedding', modalities: { input: ['text'], output: ['embedding'] }, cost: { input: 0.1 } }, // embedding → 非对话不收
  } },
  anthropic: { id: 'anthropic', name: 'Anthropic', models: {
    'claude-opus-4-8': { name: 'Claude Opus 4.8', modalities: { input: ['text'], output: ['text'] }, cost: { input: 5, output: 25 } }, // 归 Claude 抽取器，不混入 other
  } },
  openai: { id: 'openai', name: 'OpenAI', models: {
    'gpt-5': { name: 'GPT-5', modalities: { input: ['text'], output: ['text'] }, cost: { input: 1.25, output: 10 } }, // 归 OpenAI 抽取器，不混入 other
  } },
};
const other = _extractOtherModels(OTHER_TABLE);
check('国产厂商精确抽取（glm-5 / kimi / qwen）', () => {
  assert.strictEqual(other['glm-5'].input, 1);
  assert.strictEqual(other['kimi-k2.5'].input, 0.6);
  assert.strictEqual(other['qwen-plus'].input, 0.4); // 日期后缀折叠
});
check('各 provider 即官方价（kimi 仍是 moonshotai 的 0.6/3）', () => assert.strictEqual(other['kimi-k2.5'].output, 3));
check('deepseek-v3.2 精确抽取', () => assert(other['deepseek-v3.2'] && other['deepseek-v3.2'].input === 0.28));
check('非对话模型不收（image / embedding）', () => assert(!other['qwen-image-2.0'] && !other['doubao-embedding']));
check('Claude / OpenAI 不混入（各有专门抽取器）', () => assert(!other['claude-opus-4-8'] && !other['gpt-5']));
check('contextWindow 同步', () => assert.strictEqual(other['glm-5'].contextWindow, 128000));
check('缓存价按 Anthropic 标准比率兜底', () => {
  assert.strictEqual(other['glm-5'].cacheWrite5m, 1.25);
  assert.strictEqual(other['glm-5'].cachedInput, 1); // models.dev 无 cache_read → 回落 input（无折扣）
});

console.log(failures === 0 ? '\n✅ PRICING ALL PASS' : '\n❌ ' + failures + ' FAILURE(S)');
process.exit(failures ? 1 : 0);
