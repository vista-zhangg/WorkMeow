'use strict';

// Pricing sync — public-data only, no credentials/API calls.
//
// 从 models.dev 公开数据库 (https://models.dev/api.json) 拉取 Anthropic + OpenAI +
// 主流国产/其它厂商模型价，缓存到 ~/.workmeow/pricing-cache.json。
// metering.loadPricing() / codex-metering.loadPricing() / trae-metering 合并时
// 放在用户手动 override 之下，手填价仍优先。与 CC Switch 同源同法，保持简洁、
// 零依赖、无需鉴权，用户不必安装任何额外应用。
//
// 抽取四块（同一 models.dev table，按 provider 分组提取）：
//   pricing      —— Claude 家族价（opus/sonnet/haiku）
//   models       —— Claude 精确型号价
//   openaiModels —— Codex/OpenAI 精确型号价
//   otherModels  —— 其它主流厂商精确型号价（GLM/Kimi/DeepSeek/Qwen/MiniMax/
//                  Gemini/Grok/Mistral 等，WorkBuddy、TRAE 的国产模型价从这里出）
//
// ⚠️ models.dev 的 cost.input/output 已是 USD per-million-token，直接使用，
// 不再兼容旧的 per-token 价目格式。
// 这里直接取整即可，不要 ×1e6，否则价格会被放大 100 万倍。
//
// Safety:
//   - Fetches one public JSON file. No auth, no account, no API quota.
//   - Failures are silent — the cost-chip stays accurate-enough on the built-in defaults.
//   - Stale caches are still used (better than nothing).

const https = require('https');
const fs = require('fs');
const { normModelName } = require('./metering');
const { statePath } = require('./paths');

const CACHE = statePath('pricing-cache.json');
const URL = 'https://models.dev/api.json';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 4000;            // let the app finish booting first
const FETCH_TIMEOUT_MS = 15000;
const MAX_BODY = 8 * 1024 * 1024;

function fetchJson(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (r) => {
      if (r.statusCode !== 200) { r.resume(); rej(new Error('HTTP ' + r.statusCode)); return; }
      let body = ''; let size = 0; let tooLarge = false;
      r.on('data', (c) => { if (tooLarge) return; size += c.length; if (size > MAX_BODY) { tooLarge = true; return; } body += c; });
      r.on('end', () => { if (tooLarge) { rej(new Error('body too large')); return; } try { res(JSON.parse(body)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
  });
}

// models.dev cost 已是 per-million；四舍五入到 4 位小数，非数返回 null。
const r = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const ctxOf = (model) => (Number.isFinite(model && model.max_input_tokens)
  ? Math.floor(model.max_input_tokens)
  : Number.isFinite(model && model.context_window) ? Math.floor(model.context_window) : null);

// models.dev 非 chat 模型标记（embedding/audio/image/video/实时/检索类一律不收）
const NON_CHAT = /(embed|audio|speech|tts|whisper|transcribe|realtime|dall|image|video|music|moderation|rerank|guard|safety|search|instruct)/i;

// 判定一个 models.dev model 是否为可计价的文本对话模型：status 非 deprecated、
// 输出 modalities 含 text 且不含 audio/image/video、id/name 不含非 chat 标记。
function isTextChatModel(modelId, model) {
  if (model && model.status && String(model.status).toLowerCase() === 'deprecated') return false;
  const outs = model && model.modalities && Array.isArray(model.modalities.output)
    ? model.modalities.output.map((m) => String(m).toLowerCase()) : [];
  if (outs.length) {
    if (!outs.includes('text')) return false;
    if (outs.some((m) => ['audio', 'image', 'video'].includes(m))) return false;
  }
  return !NON_CHAT.test(String(modelId) + ' ' + (model && model.name || ''));
}

// 有效价判定：至少一边有非零价。models.dev 对开源权重模型顶层 cost=0（=自部署
// 成本，非 API 价），这类一律跳过，避免把真实收费的 API 模型误判为免费。
function hasPrice(input, output) {
  if (input == null && output == null) return false;
  if ((input == null || input === 0) && (output == null || output === 0)) return false;
  return true;
}

// Normalize OpenAI model names similar to how codex-metering does it:
// lowercase, strip date suffixes (-20250125 / -2025-01-25), take last path segment.
function normOpenAIName(model) {
  const s = String(model || '').toLowerCase().trim();
  if (!s) return '';
  return s.replace(/-\d{4}-\d{2}-\d{2}\b/g, '').replace(/-\d{4}\d{2}\d{2}\b/g, '').replace(/@.*$/, '').split('/').pop() || s;
}

// ── Claude 家族价（opus/sonnet/haiku）───────────────────────────────────────
// 每个 family 取 release_date 最新的有效行（= 当前在售价）。
function extractFamilies(table) {
  const out = {};
  const provider = table && table.anthropic;
  const models = provider && provider.models;
  if (!models || typeof models !== 'object') return out;
  const cand = { opus: [], sonnet: [], haiku: [] };
  for (const [modelId, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object') continue;
    if (!isTextChatModel(modelId, model)) continue;
    const n = String(modelId).toLowerCase();
    const fam = n.includes('opus') ? 'opus' : n.includes('sonnet') ? 'sonnet' : n.includes('haiku') ? 'haiku' : null;
    if (!fam) continue;
    const cost = model.cost;
    if (!cost || typeof cost !== 'object') continue;
    const input = r(cost.input);
    const output = r(cost.output);
    if (!hasPrice(input, output)) continue;
    // Anthropic 标准：cache_write(5m) = input×1.25，1h = input×2，read = input×0.1
    const cacheWrite5m = r(cost.cache_write) != null ? r(cost.cache_write) : (input != null ? r(input * 1.25) : null);
    const cacheRead = r(cost.cache_read) != null ? r(cost.cache_read) : (input != null ? r(input * 0.1) : null);
    cand[fam].push({ rd: model.release_date || '', row: {
      input, output, cacheWrite5m, cacheWrite1h: input != null ? r(input * 2) : null, cacheRead,
    } });
  }
  for (const fam of ['opus', 'sonnet', 'haiku']) {
    const arr = cand[fam];
    if (!arr.length) continue;
    arr.sort((a, b) => (a.rd < b.rd ? 1 : a.rd > b.rd ? -1 : 0));
    out[fam] = arr[0].row;
  }
  return out;
}

// ── Claude 精确型号价（key = normModelName，与 metering.priceFor 对齐）─────────
function extractModels(table) {
  const out = {};
  const provider = table && table.anthropic;
  const models = provider && provider.models;
  if (!models || typeof models !== 'object') return out;
  for (const [modelId, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object') continue;
    if (!/claude/i.test(modelId)) continue;
    if (!isTextChatModel(modelId, model)) continue;
    const cost = model.cost;
    if (!cost || typeof cost !== 'object') continue;
    const id = normModelName(modelId);
    if (!id) continue;
    const input = r(cost.input);
    const output = r(cost.output);
    if (!hasPrice(input, output)) continue;
    const cacheWrite5m = r(cost.cache_write) != null ? r(cost.cache_write) : (input != null ? r(input * 1.25) : null);
    const cacheRead = r(cost.cache_read) != null ? r(cost.cache_read) : (input != null ? r(input * 0.1) : null);
    out[id] = {
      input, output, cacheWrite5m, cacheWrite1h: input != null ? r(input * 2) : null, cacheRead,
      contextWindow: ctxOf(model),
    };
  }
  return out;
}

// ── Codex/OpenAI 精确型号价（codex-metering 用，字段 input/output/cachedInput）─
function isRelevantOpenAIChat(id) {
  const n = String(id).toLowerCase();
  if (!/^(gpt-|o[1-9]|chatgpt-)/i.test(n)) return false;
  if (/(embed|audio|whisper|tts|dall|realtime|vision|instruct|moderation|search)/i.test(n)) return false;
  return true;
}
function extractOpenAIModels(table) {
  const out = {};
  const provider = table && table.openai;
  const models = provider && provider.models;
  if (!models || typeof models !== 'object') return out;
  for (const [modelId, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object') continue;
    if (!isTextChatModel(modelId, model)) continue;
    const id = normOpenAIName(modelId);
    if (!id || !isRelevantOpenAIChat(id)) continue;
    const cost = model.cost;
    if (!cost || typeof cost !== 'object') continue;
    const input = r(cost.input);
    const output = r(cost.output);
    if (input == null && output == null) continue;
    let cachedInput = r(cost.cache_read);
    if (cachedInput == null) cachedInput = input;
    out[id] = { input, output, cachedInput, contextWindow: ctxOf(model) };
  }
  return out;
}

// ── 其它主流厂商精确型号价（WorkBuddy、TRAE 国产模型价从这里出）────────────────
// 遍历除 anthropic/openai 外的所有 provider，用家族前缀过滤主流对话模型。
// 跳过 cost=0 的开源权重模型（自部署成本，非 API 价——GLM/Kimi 开源版在 models.dev
// 上是 $0，但它们的 API 调用其实收费）。
function extractOtherModels(table) {
  const out = {};
  if (!table || typeof table !== 'object') return out;
  const SKIP = new Set(['anthropic', 'openai']);
  const FAMILY = /^(glm-|doubao|kimi-|moonshot|deepseek|qwen|qwq|minimax|hunyuan|ernie|abab|gemini-|grok-|mistral-|codestral-|pixtral-|nova-|llama-|llama3|mimo-|longcat-)/i;
  for (const [providerId, provider] of Object.entries(table)) {
    if (SKIP.has(providerId)) continue;
    if (!provider || typeof provider !== 'object') continue;
    const models = provider.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object') continue;
      if (!isTextChatModel(modelId, model)) continue;
      const id = normOpenAIName(modelId);
      if (!id || !FAMILY.test(id)) continue;
      const cost = model.cost;
      if (!cost || typeof cost !== 'object') continue;
      const input = r(cost.input);
      const output = r(cost.output);
      if (!hasPrice(input, output)) continue;
      let cachedInput = r(cost.cache_read);
      if (cachedInput == null) cachedInput = input;
      const cacheWrite5m = r(cost.cache_write);
      out[id] = {
        input, output, cachedInput, cacheRead: cachedInput,
        cacheWrite5m: cacheWrite5m != null ? cacheWrite5m : (input != null ? r(input * 1.25) : null),
        contextWindow: ctxOf(model),
      };
    }
  }
  return out;
}

function createPricingSync(options = {}) {
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  let timer = null;
  let stopped = false;

  function scheduleNext(ms) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, ms);
    if (timer.unref) timer.unref();
  }

  async function refresh() {
    if (stopped) return;
    try {
      const table = await fetchJson(URL);
      if (!table || typeof table !== 'object') throw new Error('empty response');
      const pricing = extractFamilies(table);
      const models = extractModels(table);
      const openaiModels = extractOpenAIModels(table);
      const otherModels = extractOtherModels(table);
      if (!Object.keys(pricing).length && !Object.keys(openaiModels).length) {
        throw new Error('no pricing extracted');
      }
      let wrote = false;
      try {
        fs.mkdirSync(path.dirname(CACHE), { recursive: true });
        const tmp = path.join(path.dirname(CACHE), `.pricing-cache.${process.pid}.${Date.now()}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify({
          ts: Date.now(), source: 'models.dev', url: URL,
          pricing, models, openaiModels, otherModels,
        }, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, CACHE);
        try { fs.chmodSync(CACHE, 0o600); } catch {}
        wrote = true;
      } catch {}
      if (wrote) try { onUpdate(); } catch {}
    } catch (e) {
      // Network pricing is optional; the last cache or built-in defaults remain valid.
    }
    scheduleNext(REFRESH_MS);
  }

  function start() {
    stopped = false;
    scheduleNext(STARTUP_DELAY_MS); // don't compete with hook install
  }
  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function getCached() {
    try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
  }

  return { start, stop, getCached, refresh };
}

module.exports = { createPricingSync, CACHE_PATH: CACHE, _extractFamilies: extractFamilies, _extractModels: extractModels, _extractOpenAIModels: extractOpenAIModels, _extractOtherModels: extractOtherModels };
