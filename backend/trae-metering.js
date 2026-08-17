'use strict';

// Persistent TRAE token ledger + pricing (read-only, from IDE logs).
//
// TRAE CN（含 Trae / TRAE SOLO）不在本地落 Claude-Code 形转录；其 agent 服务
// 的 stdout 日志里会以 Rust Debug 格式打印每次调用的 token 用量：
//   %APPDATA%/Trae CN/logs/<启动时间戳>/Modular/ai-agent_*_stdout.log
//   2026-06-29T12:29:49.880117+08:00  INFO ...: token usage: TokenUsageEvent {
//     name: "", prompt_tokens: 608, completion_tokens: 28, total_tokens: 636,
//     reasoning_tokens: Some(0), cache_creation_input_tokens: Some(0),
//     cache_read_input_tokens: Some(0), ... }
// 本模块按文件偏移增量扫描这些日志，聚合出与其它工具同形的台账。
//
// 模型归属：TokenUsageEvent.name 通常为空，此时读 TRAE 当前选中模型
// （state.vscdb 里的 AI.agent.model.selected_model，二进制正则粗取、10 分钟缓存），
// 取不到记 'trae'。价格策略：models.dev 缓存精确命中 → 最长前缀近似（如 glm-5 →
// glm-5p1）→ 无价则 cost=0（与 WorkBuddy 一样不乱估价）。
//
// 已知局限：该日志只覆盖走了 ai_agent::llm_stream 的调用（会话标题生成、部分
// agent 回合），TRAE 主聊天回合是否全程打印取决于 IDE 版本——漏记时台账偏小，
// 不会虚增。

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { STATE_DIR } = require('./paths');
const { num, dayKey, mergeLifetime } = require('./metering-common');
const { createMeterQueue } = require('./meter-queue');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOG_ROOTS = [
  path.join(APPDATA, 'Trae CN', 'logs'),
  path.join(APPDATA, 'Trae', 'logs'),
  path.join(APPDATA, 'TRAE SOLO CN', 'logs'),
  path.join(APPDATA, 'TRAE SOLO', 'logs'),
];
const STATE_PATH = path.join(STATE_DIR, 'trae-usage.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json'); // models.dev sync cache
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'trae-pricing.json'); // user override
const SCHEMA_VERSION = 1;
const MODEL_CACHE_MS = 10 * 60 * 1000;
const DAILY_KEEP_DAYS = 95;
const BACKFILL_MS = DAILY_KEEP_DAYS * 24 * 60 * 60 * 1000;

const DEFAULT_PRICING = {
  default: { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
};

function normModelName(model) {
  const s = String(model || '').toLowerCase().trim();
  if (!s) return '';
  return s.replace(/-\d{4}\d{2}\d{2}\b/g, '').replace(/@.*$/, '').split('/').pop() || s;
}

function normalizePriceRow(row, fallback = DEFAULT_PRICING.default) {
  const input = Number.isFinite(row && row.input) ? row.input : fallback.input;
  const output = Number.isFinite(row && row.output) ? row.output : fallback.output;
  const cachedInput = Number.isFinite(row && row.cachedInput)
    ? row.cachedInput
    : Number.isFinite(row && row.cacheRead) ? row.cacheRead
    : input * 0.1;
  const cacheWrite = Number.isFinite(row && row.cacheWrite)
    ? row.cacheWrite
    : Number.isFinite(row && row.cacheWrite5m) ? row.cacheWrite5m
    : input * 1.25;
  return { input, output, cachedInput, cacheWrite };
}

// 与 workbuddy-metering 同策略：加载 models.dev 缓存里抽取好的模型价目
// （含 otherModels：GLM/Kimi/DeepSeek/Qwen/豆包/MiniMax 等国产厂商，
// pricing-sync 每日自动从社区价目同步）；用户 override 优先。
function loadPricingFrom(pricingCachePath, pricingOverridePath) {
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  out._models = {};
  const SKIP = new Set(['ts', 'source', 'url', 'pricing']);
  try {
    const c = JSON.parse(fs.readFileSync(pricingCachePath, 'utf8'));
    for (const [k, v] of Object.entries(c)) {
      if (SKIP.has(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [id, row] of Object.entries(v)) {
          if (row && typeof row === 'object' && Number.isFinite(row.input)) {
            out._models[normModelName(id)] = normalizePriceRow(row);
          }
        }
      }
    }
  } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(pricingOverridePath, 'utf8'));
    for (const [key, row] of Object.entries(raw)) {
      if (key === 'models' && row && typeof row === 'object') {
        for (const [id, r] of Object.entries(row)) {
          const k = normModelName(id);
          if (r && typeof r === 'object') out._models[k] = normalizePriceRow(r, out._models[k] || DEFAULT_PRICING.default);
        }
      } else if (row && typeof row === 'object') {
        out[key] = normalizePriceRow(row, out[key] || DEFAULT_PRICING.default);
      }
    }
  } catch {}
  return out;
}

function usageCost(usage, price) {
  if (!price) return 0;
  const u = usage || emptyUsage();
  const p = normalizePriceRow(price);
  const regularInput = Math.max(0, num(u.input) - num(u.cachedInput) - num(u.cacheWrite));
  return (regularInput * p.input + num(u.output) * p.output
    + num(u.cachedInput) * p.cachedInput + num(u.cacheWrite) * p.cacheWrite) / 1e6;
}

function emptyUsage() {
  return { tokens: 0, input: 0, output: 0, cachedInput: 0, reasoningOutput: 0, cacheWrite: 0, cost: 0 };
}

// Rust Debug 格式里的 Some(N) / None / 裸数字
function someNum(body, key) {
  const m = new RegExp(key + ':\\s*(?:Some\\((\\d+)\\)|(\\d+))').exec(body);
  if (!m) return 0;
  return num(m[1] || m[2]);
}

// 解析一行日志，命中 TokenUsageEvent 返回 { ts, name, usage }，否则 null。
function parseUsageLine(line) {
  const idx = line.indexOf('TokenUsageEvent');
  if (idx === -1) return null;
  const body = line.slice(idx);
  const tsM = /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(line);
  const ts = tsM ? Date.parse(tsM[1]) : NaN;
  const nameM = /name:\s*"([^"]*)"/.exec(body);
  const prompt = someNum(body, 'prompt_tokens');
  const completion = someNum(body, 'completion_tokens');
  const total = someNum(body, 'total_tokens');
  const reasoning = someNum(body, 'reasoning_tokens');
  const cacheWrite = someNum(body, 'cache_creation_input_tokens');
  const cacheRead = someNum(body, 'cache_read_input_tokens');
  if (prompt <= 0 && completion <= 0 && total <= 0) return null;
  // 统一 OpenAI 语义：input 含缓存读取与缓存写入部分
  const input = prompt + cacheWrite;
  return {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    name: nameM ? nameM[1] : '',
    usage: {
      tokens: total || input + completion,
      input,
      output: completion,
      cachedInput: cacheRead,
      reasoningOutput: reasoning,
      cacheWrite,
      cost: 0,
    },
  };
}

function emptyDay() {
  return { ...emptyUsage(), msgs: 0 };
}

function addUsage(target, delta, messageDelta = 0) {
  for (const key of Object.keys(emptyUsage())) target[key] = num(target[key]) + num(delta[key]);
  target.msgs = num(target.msgs) + messageDelta;
}

// state.vscdb 是 SQLite，但 selected_model 的 JSON 值以明文 UTF-8 存放在页面里，
// 直接用正则粗取（best-effort，失败就回退 'trae'）。
function readSelectedModel(stateDirs) {
  for (const dir of stateDirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.vscdb')) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(dir, f)); } catch { continue; }
      const text = buf.toString('utf8');
      const k = text.indexOf('AI.agent.model.selected_model');
      if (k === -1) continue;
      const m = /"name"\s*:\s*"([^"]+)"/.exec(text.slice(k, k + 4096));
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

function createTraeMetering(options = {}) {
  const logRoots = options.logsRoot ? [options.logsRoot] : (options.logsRoots || LOG_ROOTS);
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'trae-usage.json');
  const pricingPaths = {
    pricingCachePath: options.pricingCachePath || PRICING_CACHE_PATH,
    pricingOverridePath: options.pricingOverridePath || PRICING_OVERRIDE_PATH,
  };
  const modelStateDirs = options.modelStateDirs || [
    path.join(APPDATA, 'Trae CN', 'User', 'globalStorage'),
    path.join(APPDATA, 'TRAE SOLO CN', 'User', 'globalStorage'),
    path.join(APPDATA, 'Trae', 'User', 'globalStorage'),
  ];

  let pricing = loadPricingFrom(pricingPaths.pricingCachePath, pricingPaths.pricingOverridePath);

  // 精确命中 → 最长前缀近似 → null（无价不计费）
  function priceFor(model) {
    const models = pricing._models || {};
    const norm = normModelName(model);
    if (norm && models[norm]) return normalizePriceRow(models[norm]);
    if (norm) {
      let best = null;
      for (const k of Object.keys(models)) {
        if (k.startsWith(norm) || norm.startsWith(k)) {
          if (!best || k.length > best.length) best = k;
        }
      }
      if (best) return normalizePriceRow(models[best]);
    }
    return null;
  }

  const state = {
    schemaVersion: SCHEMA_VERSION,
    files: {},          // filePath -> { offset, carry }
    seenEvents: {},     // sha256(file + full log line) -> { count, ts }
    daily: {},
    hourlyByDay: {},
    hourlyCostByDay: {},
    byModelByDay: {},
    lifetime: emptyDay(),
    diagnostics: { lastScanTs: 0, scannedFiles: 0, events: 0 },
  };
  let scanning = false;
  const operations = createMeterQueue();
  let dirty = false;
  let saveTimer = null;
  let timer = null;
  let loaded = false;
  let modelCache = { name: null, at: 0 };

  function currentModel() {
    if (modelCache.name && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.name;
    const name = readSelectedModel(modelStateDirs);
    if (name) modelCache = { name, at: Date.now() };
    return modelCache.name || 'trae';
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.schemaVersion !== SCHEMA_VERSION) return; // rescan from scratch
        state.files = raw.files && typeof raw.files === 'object' ? raw.files : {};
        state.seenEvents = raw.seenEvents && typeof raw.seenEvents === 'object' ? raw.seenEvents : {};
        state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
        state.hourlyByDay = raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {};
        state.hourlyCostByDay = raw.hourlyCostByDay && typeof raw.hourlyCostByDay === 'object' ? raw.hourlyCostByDay : {};
        state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
        state.lifetime = raw.lifetime && typeof raw.lifetime === 'object' ? { ...emptyDay(), ...raw.lifetime } : emptyDay();
        state.diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object'
          ? { ...state.diagnostics, ...raw.diagnostics } : state.diagnostics;
      }
    } catch {}
  }

  function saveNow() {
    dirty = false;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = path.join(stateDir, `.trae-usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch {}
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - BACKFILL_MS);
    for (const key of ['daily', 'hourlyByDay', 'hourlyCostByDay', 'byModelByDay']) {
      for (const day of Object.keys(state[key])) if (day < cutoff) delete state[key][day];
    }
    const cutoffTs = Date.now() - BACKFILL_MS;
    for (const [hash, row] of Object.entries(state.seenEvents)) {
      const ts = row && typeof row === 'object' ? Number(row.ts) : Number(row);
      if (!Number.isFinite(ts) || ts < cutoffTs) delete state.seenEvents[hash];
    }
  }

  function eventHash(file, line) {
    return crypto.createHash('sha256').update(`${file}\0${line}`, 'utf8').digest('hex');
  }

  function seenRow(hash) {
    const value = state.seenEvents[hash];
    if (value && typeof value === 'object') {
      return { count: Math.max(0, Math.floor(num(value.count))), ts: num(value.ts) };
    }
    return value ? { count: 1, ts: num(value) } : { count: 0, ts: 0 };
  }

  function acceptEvent(file, line, parsed, countUsage, replayCounts = null) {
    const hash = eventHash(file, line);
    const seen = seenRow(hash);
    if (replayCounts) {
      const occurrence = (replayCounts.get(hash) || 0) + 1;
      replayCounts.set(hash, occurrence);
      if (occurrence <= seen.count) return false;
      state.seenEvents[hash] = { count: occurrence, ts: parsed.ts };
    } else {
      // Normal appends are unique by file offset. Incrementing the occurrence
      // count also preserves two legitimately identical log lines.
      state.seenEvents[hash] = { count: seen.count + 1, ts: parsed.ts };
    }
    if (countUsage) record(parsed.ts, parsed.name || currentModel(), parsed.usage);
    return true;
  }

  async function seedProcessedEvents(file, fileState) {
    if (fileState.dedupeVersion === 2) return;
    if (fileState.offset <= 0) {
      fileState.dedupeVersion = 2;
      return;
    }
    const stream = fs.createReadStream(file, { start: 0, end: Math.max(0, fileState.offset - 1), encoding: 'utf8' });
    let carry = '';
    try {
      for await (const chunk of stream) {
        const lines = (carry + chunk).split('\n');
        carry = lines.pop() || '';
        for (const line of lines) {
          if (!line.includes('TokenUsageEvent')) continue;
          const parsed = parseUsageLine(line);
          if (parsed) acceptEvent(file, line, parsed, false);
        }
      }
    } catch {}
    fileState.dedupeVersion = 2;
  }

  async function listFiles() {
    const out = [];
    for (const root of logRoots) {
      let dirs;
      try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const modDir = path.join(root, d.name, 'Modular');
        let files;
        try { files = await fsp.readdir(modDir, { withFileTypes: true }); } catch { continue; }
        for (const f of files) {
          if (f.isFile() && /^ai-agent_.*_stdout\.log$/.test(f.name)) out.push(path.join(modDir, f.name));
        }
      }
    }
    return out;
  }

  function record(ts, model, usage) {
    if (num(usage.tokens) <= 0) return;
    const delta = { ...usage };
    const p = priceFor(model);
    delta.cost = p ? usageCost(delta, p) : 0;

    const key = dayKey(ts);
    const day = (state.daily[key] = state.daily[key] || emptyDay());
    addUsage(day, delta, 1);
    addUsage(state.lifetime, delta, 1);

    const hour = new Date(ts).getHours();
    const hours = (state.hourlyByDay[key] = state.hourlyByDay[key] || new Array(24).fill(0));
    hours[hour] += delta.tokens;
    const hourCosts = (state.hourlyCostByDay[key] = state.hourlyCostByDay[key] || new Array(24).fill(0));
    hourCosts[hour] += delta.cost;

    const models = (state.byModelByDay[key] = state.byModelByDay[key] || {});
    const modelKey = model || 'trae';
    const row = (models[modelKey] = models[modelKey] || emptyDay());
    addUsage(row, delta, 1);

    state.diagnostics.events++;
  }

  async function scanFile(file) {
    let stat;
    try { stat = await fsp.stat(file); } catch { return; }
    const fileState = state.files[file] || { offset: 0, carry: '', dedupeVersion: 2 };
    let wasTruncated = false;
    if (fileState.offset > stat.size) {
      // 日志被截断/轮换：从头重扫该文件（trae 日志按启动时间戳分目录，极少发生）
      fileState.offset = 0;
      fileState.carry = '';
      wasTruncated = true;
      state.diagnostics.truncated = (state.diagnostics.truncated || 0) + 1;
    }
    await seedProcessedEvents(file, fileState);
    if (fileState.offset === stat.size) return;
    const stream = fs.createReadStream(file, { start: fileState.offset, encoding: 'utf8' });
    let carry = fileState.carry || '';
    const replayCounts = wasTruncated ? new Map() : null;
    try {
      for await (const chunk of stream) {
        const lines = (carry + chunk).split('\n');
        carry = lines.pop() || '';
        for (const line of lines) {
          if (line.indexOf('TokenUsageEvent') === -1) continue;
          let parsed;
          try { parsed = parseUsageLine(line); } catch { parsed = null; }
          if (!parsed) continue;
          // Old hashes may be pruned to keep the state bounded. A truncation
          // must still never resurrect ancient usage into lifetime totals.
          if (wasTruncated && parsed.ts < Date.now() - BACKFILL_MS) continue;
          acceptEvent(file, line, parsed, true, replayCounts);
        }
      }
    } catch {}
    fileState.offset = stat.size;
    fileState.carry = carry;
    state.files[file] = fileState;
  }

  async function performScan() {
    load();
    scanning = true;
    try {
      const files = (await listFiles()).sort();
      for (const file of files) {
        try { await scanFile(file); } catch {}
      }
      pruneDaily();
      state.diagnostics.lastScanTs = Date.now();
      state.diagnostics.scannedFiles = files.length;
      scheduleSave();
    } catch {
    } finally {
      scanning = false;
    }
  }

  function scan() { return operations.scan(performScan); }

  function getStats() {
    const todayKey = dayKey(Date.now());
    const today = { ...emptyDay(), ...(state.daily[todayKey] || {}) };
    const byModel = state.byModelByDay[todayKey] ? { ...state.byModelByDay[todayKey] } : {};
    for (const key of Object.keys(byModel)) byModel[key] = { ...emptyDay(), ...byModel[key] };
    return {
      today,
      lifetime: { ...emptyDay(), ...state.lifetime },
      hourlyTok: (state.hourlyByDay[todayKey] || new Array(24).fill(0)).slice(),
      hourly: (state.hourlyCostByDay[todayKey] || new Array(24).fill(0)).slice(),
      daily: Object.fromEntries(Object.entries(state.daily).map(([key, value]) => [
        key, { ...emptyDay(), ...value },
      ])),
      byModel,
      diagnostics: { ...state.diagnostics },
    };
  }

  function priceInfo() {
    let live = false;
    let ts = 0;
    let source = 'builtin';
    const count = Object.keys(pricing._models || {}).length;
    try {
      const c = JSON.parse(fs.readFileSync(pricingPaths.pricingCachePath, 'utf8'));
      if (c && c.pricing && typeof c.pricing === 'object') {
        live = true; source = 'models.dev'; ts = Number(c.ts) || 0;
      }
    } catch {}
    try { fs.accessSync(pricingPaths.pricingOverridePath); live = true; source = 'override'; } catch {}
    const stale = ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000;
    // TRAE 模型可能走最长前缀近似（如 glm-5 → glm-5p1），属估算。
    return { live, count, ts, source, stale, estimate: true };
  }

  function reloadPricing() {
    pricing = loadPricingFrom(pricingPaths.pricingCachePath, pricingPaths.pricingOverridePath);
  }

  async function rebuild() {
    return operations.exclusive(async () => {
      load();
      if (!(await listFiles()).length) {
        saveNow();
        return getStats();
      }
      const oldLifetime = { ...state.lifetime };
      state.files = {};
      state.seenEvents = {};
      state.daily = {};
      state.hourlyByDay = {};
      state.hourlyCostByDay = {};
      state.byModelByDay = {};
      state.lifetime = emptyDay();
      state.diagnostics = { lastScanTs: 0, scannedFiles: 0, events: 0 };
      pricing = loadPricingFrom(pricingPaths.pricingCachePath, pricingPaths.pricingOverridePath);
      await performScan();
      // A log directory can be rotated or partially deleted. Keep the
      // monotonic lifetime ledger from falling when a rebuild sees less source
      // history than the running instance had already observed.
      state.lifetime = mergeLifetime(oldLifetime, state.lifetime);
      saveNow();
      return getStats();
    });
  }

  function start(intervalMs = 30000) {
    load();
    scan();
    timer = setInterval(scan, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return { start, stop, scan, rebuild, getStats, priceInfo, reloadPricing, _state: state };
}

module.exports = { createTraeMetering, parseUsageLine, usageCost };
