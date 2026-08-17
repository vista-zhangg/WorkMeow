'use strict';

// Persistent opencode token/cost ledger.
//
// opencode has no telemetry file of its own — the pet's opencode plugin
// (hook/opencode-plugin.js, installed into ~/.config/opencode/plugins/) appends
// one compact JSON line per completed assistant message to
//   ~/.workmeow/opencode-usage.jsonl
// This module tails that file (byte cursor, append-only) and aggregates the
// rows into the same stats shape as codex-metering, so main.js merges the
// sources with zero special-casing.
//
// Each line:
//   { v:1, ts, session_id, message_id, model, provider, cost,
//     tokens:{ input, output, reasoning, cacheRead, cacheWrite } }
//
// `cost` is the provider-reported USD when opencode could compute it (the
// preferred source of truth); missing/zero cost falls back to pricing-cache
// (models.dev) or built-in family estimates. reasoning is a subset of output
// tokens (never added on top); cacheRead/cacheWrite are separate token
// categories (like Claude's cache_read / cache_write, unlike OpenAI's
// cachedInput which is a subset of input).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { STATE_DIR } = require('./paths');
const { num, dayKey, mergeLifetime } = require('./metering-common');
const { createMeterQueue } = require('./meter-queue');

const USAGE_FILE = path.join(STATE_DIR, 'opencode-usage.jsonl');
const STATE_PATH = path.join(STATE_DIR, 'opencode-usage.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json'); // models.dev sync cache
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'opencode-pricing.json');
const SCHEMA_VERSION = 1;
const DAILY_KEEP_DAYS = 95;
const BACKFILL_MS = DAILY_KEEP_DAYS * 24 * 60 * 60 * 1000;

// USD per 1,000,000 tokens. Only a last-resort fallback for models the sync
// cache doesn't cover — provider-reported cost (from the plugin lines) wins
// over every price row.
const DEFAULT_PRICING = {
  claude:   { input: 3.00,  output: 15.00, cachedInput: 0.30,  cacheWrite: 3.75  },
  gpt:      { input: 1.25,  output: 10.00, cachedInput: 0.125, cacheWrite: 1.5625 },
  gemini:   { input: 1.25,  output: 10.00, cachedInput: 0.125, cacheWrite: 1.5625 },
  deepseek: { input: 0.27,  output: 1.10,  cachedInput: 0.027, cacheWrite: 0.34  },
  default:  { input: 1.25,  output: 10.00, cachedInput: 0.125, cacheWrite: 1.5625 },
};

// Strip version dates/provider prefixes so dated model ids hit the cache table.
function normModelName(model) {
  const s = String(model || '').toLowerCase().trim().split(':')[0];
  if (!s) return '';
  return s.replace(/-\d{8}\b/g, '').replace(/@.*$/, '').split('/').pop() || s;
}

function normalizePriceRow(row, fallback = DEFAULT_PRICING.default) {
  const input = Number.isFinite(row && row.input) ? row.input : fallback.input;
  const output = Number.isFinite(row && row.output) ? row.output : fallback.output;
  const cachedInput = Number.isFinite(row && row.cachedInput)
    ? row.cachedInput
    : Number.isFinite(row && row.cacheRead) ? row.cacheRead : input * 0.1;
  const cacheWrite = Number.isFinite(row && row.cacheWrite)
    ? row.cacheWrite
    : Number.isFinite(row && row.cacheWrite5m) ? row.cacheWrite5m : input * 1.25;
  return { input, output, cachedInput, cacheWrite };
}

function loadPricing() {
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  out._models = {};
  // Layer 1: models.dev sync cache — any of the three model tables may cover
  // an opencode model (opencode runs arbitrary providers).
  try {
    const c = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
    for (const table of ['openaiModels', 'otherModels', 'models']) {
      const rows = c && c[table] && typeof c[table] === 'object' ? c[table] : {};
      for (const [id, row] of Object.entries(rows)) {
        if (row && typeof row === 'object' && Number.isFinite(row.input)) {
          const k = normModelName(id);
          out._models[k] = normalizePriceRow(row, out._models[k] || out.default);
        }
      }
    }
  } catch {}
  // Layer 2: user override (~/.workmeow/opencode-pricing.json) — wins.
  try {
    const raw = JSON.parse(fs.readFileSync(PRICING_OVERRIDE_PATH, 'utf8'));
    for (const [key, row] of Object.entries(raw)) {
      if (key === 'models' && row && typeof row === 'object') {
        for (const [id, r] of Object.entries(row)) {
          const k = normModelName(id);
          if (r && typeof r === 'object') out._models[k] = normalizePriceRow(r, out._models[k] || out.default);
        }
      } else if (row && typeof row === 'object') {
        out[key] = normalizePriceRow(row, out[key] || out.default);
      }
    }
  } catch {}
  return out;
}

function priceFor(model, pricing) {
  const p = pricing || DEFAULT_PRICING;
  const models = p._models || {};
  const norm = normModelName(model);
  if (norm && models[norm]) return normalizePriceRow(models[norm]);
  const m = String(model || '').toLowerCase();
  if (m.includes('claude')) return normalizePriceRow(p.claude);
  if (m.includes('gemini')) return normalizePriceRow(p.gemini);
  if (m.includes('gpt')) return normalizePriceRow(p.gpt);
  if (m.includes('deepseek')) return normalizePriceRow(p.deepseek);
  return normalizePriceRow(p.default);
}

function emptyUsage() {
  return { tokens: 0, input: 0, output: 0, cachedInput: 0, reasoningOutput: 0, cacheWrite: 0, cost: 0 };
}

function normalizeUsage(raw) {
  const t = raw && raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : {};
  const input = num(t.input);
  const output = num(t.output);
  const cachedInput = num(t.cacheRead);
  const cacheWrite = num(t.cacheWrite);
  return {
    tokens: input + output + cachedInput + cacheWrite,
    input,
    output,
    cachedInput,
    reasoningOutput: num(t.reasoning),
    cacheWrite,
    cost: num(raw && raw.cost),
  };
}

function usageCost(usage, price) {
  const u = usage || emptyUsage();
  if (num(u.cost) > 0) return u.cost; // provider-reported cost wins
  const p = normalizePriceRow(price);
  return (num(u.input) * p.input
    + num(u.output) * p.output
    + num(u.cachedInput) * p.cachedInput
    + num(u.cacheWrite) * p.cacheWrite) / 1e6;
}

function emptyDay() {
  return { ...emptyUsage(), msgs: 0 };
}

function addUsage(target, delta, messageDelta = 0) {
  for (const key of Object.keys(emptyUsage())) target[key] = num(target[key]) + num(delta[key]);
  target.msgs = num(target.msgs) + messageDelta;
}

function createOpenCodeMetering(options = {}) {
  const usageFile = options.usageFile || USAGE_FILE;
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'opencode-usage.json');

  let pricing = loadPricing();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    cursors: {},       // file -> byte offset already consumed
    records: {},       // message_id -> { day, ts, model, usage }
    daily: {},
    hourlyByDay: {},
    hourlyCostByDay: {},
    byModelByDay: {},
    lifetime: emptyDay(),
    diagnostics: { lastScanTs: 0, scannedFiles: 0, events: 0, estimatedModels: {} },
  };
  let scanning = false;
  const operations = createMeterQueue();
  let dirty = false;
  let saveTimer = null;
  let timer = null;
  let loaded = false;

  function reset() {
    state.cursors = {};
    state.records = {};
    state.daily = {};
    state.hourlyByDay = {};
    state.hourlyCostByDay = {};
    state.byModelByDay = {};
    state.lifetime = emptyDay();
    state.diagnostics = { lastScanTs: 0, scannedFiles: 0, events: 0, estimatedModels: {} };
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      if (raw.schemaVersion !== SCHEMA_VERSION) return; // force rescan
      state.cursors = raw.cursors && typeof raw.cursors === 'object' ? raw.cursors : {};
      state.records = raw.records && typeof raw.records === 'object' ? raw.records : {};
      state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
      state.hourlyByDay = raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {};
      state.hourlyCostByDay = raw.hourlyCostByDay && typeof raw.hourlyCostByDay === 'object' ? raw.hourlyCostByDay : {};
      state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
      state.lifetime = raw.lifetime && typeof raw.lifetime === 'object' ? { ...emptyDay(), ...raw.lifetime } : emptyDay();
      state.diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object'
        ? { ...state.diagnostics, ...raw.diagnostics } : state.diagnostics;
    } catch {}
  }

  function saveNow() {
    dirty = false;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = path.join(stateDir, `.opencode-usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
      try { fs.chmodSync(statePath, 0o600); } catch {}
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
    for (const [id, record] of Object.entries(state.records)) {
      if (Number.isFinite(Number(record && record.ts))
        && Number(record.ts) < Date.now() - BACKFILL_MS) delete state.records[id];
    }
  }

  function record(ts, model, usage, isNew) {
    if (num(usage.tokens) <= 0) return;
    const p = priceFor(model, pricing);
    usage.cost = usageCost(usage, p);

    const key = dayKey(ts);
    const day = (state.daily[key] = state.daily[key] || emptyDay());
    addUsage(day, usage, isNew ? 1 : 0);
    addUsage(state.lifetime, usage, isNew ? 1 : 0);

    const hour = new Date(ts).getHours();
    const hours = (state.hourlyByDay[key] = state.hourlyByDay[key] || new Array(24).fill(0));
    hours[hour] += usage.tokens;
    const hourCosts = (state.hourlyCostByDay[key] = state.hourlyCostByDay[key] || new Array(24).fill(0));
    hourCosts[hour] += usage.cost;

    const models = (state.byModelByDay[key] = state.byModelByDay[key] || {});
    const modelKey = model || 'unknown';
    const row = (models[modelKey] = models[modelKey] || emptyDay());
    addUsage(row, usage, isNew ? 1 : 0);

    if (pricing._models && !pricing._models[normModelName(model)]) {
      const estimates = state.diagnostics.estimatedModels || (state.diagnostics.estimatedModels = {});
      estimates[modelKey] = num(estimates[modelKey]) + (isNew ? 1 : 0);
    }
  }

  // Read appended bytes since the stored cursor, returning complete lines only.
  async function readNewLines(file, fromOffset, size) {
    if (size <= fromOffset) return { lines: [], newOffset: size < fromOffset ? 0 : fromOffset };
    const fh = await fsp.open(file, 'r');
    try {
      const len = size - fromOffset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, fromOffset);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return { lines: [], newOffset: fromOffset }; // no complete line yet
      const consumed = text.slice(0, lastNl);
      return { lines: consumed.split('\n'), newOffset: fromOffset + Buffer.byteLength(consumed, 'utf8') + 1 };
    } finally {
      await fh.close();
    }
  }

  function ingestLine(line, minTimestampMs = 0) {
    if (!line || line.charCodeAt(0) !== 123) return false; // fast skip non-'{' lines
    let o;
    try { o = JSON.parse(line); } catch { return false; }
    if (!o || o.v !== 1) return false;
    const id = String(o.message_id || '');
    if (!id || state.records[id]) return false; // dedupe (file rewrite/rotation)
    const usage = normalizeUsage(o);
    if (usage.tokens <= 0) return false;
    const ts = Number.isFinite(o.ts) ? o.ts : Date.now();
    // After rotation the cursor restarts at byte zero. Ignore rows outside
    // the retained window so an old prefix cannot be re-added after its
    // message ids have already aged out of the ledger.
    if (minTimestampMs > 0 && ts < minTimestampMs) return false;
    record(ts, String(o.model || 'unknown'), usage, true);
    state.records[id] = { day: dayKey(ts), ts, model: String(o.model || 'unknown'), usage };
    state.diagnostics.events = num(state.diagnostics.events) + 1;
    return true;
  }

  async function scanFile() {
    let st;
    try { st = await fsp.stat(usageFile); } catch { return; }
    let offset = state.cursors[usageFile] || 0;
    const wasTruncated = offset > st.size;
    if (wasTruncated) offset = 0; // file truncated/rotated
    if (st.size <= offset) return;
    const { lines, newOffset } = await readNewLines(usageFile, offset, st.size);
    const floor = wasTruncated ? Date.now() - BACKFILL_MS : 0;
    for (const line of lines) {
      try { ingestLine(line, floor); } catch {}
    }
    state.cursors[usageFile] = newOffset;
  }

  async function performScan() {
    load();
    scanning = true;
    try {
      await scanFile();
      pruneDaily();
      state.diagnostics.lastScanTs = Date.now();
      state.diagnostics.scannedFiles = 1;
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
    const byModel = {};
    if (state.byModelByDay[todayKey]) {
      for (const [k, v] of Object.entries(state.byModelByDay[todayKey])) {
        // 面板按 Claude 语义读 cacheRead/cacheWrite5m：把 opencode 的
        // cachedInput/cacheWrite 映射过去，让缓存列也有数。
        byModel[k] = {
          ...emptyDay(),
          ...v,
          cacheRead: v.cachedInput || 0,
          cacheWrite5m: v.cacheWrite || 0,
          cacheWrite1h: 0,
        };
      }
    }
    return {
      today,
      lifetime: { ...emptyDay(), ...state.lifetime },
      hourlyTok: (state.hourlyByDay[todayKey] || new Array(24).fill(0)).slice(),
      hourly: (state.hourlyCostByDay[todayKey] || new Array(24).fill(0)).slice(),
      daily: Object.fromEntries(Object.entries(state.daily).map(([key, value]) => [
        key, { ...emptyDay(), ...value },
      ])),
      byModel,
      diagnostics: {
        ...state.diagnostics,
        records: Object.keys(state.records).length,
        pricing: priceInfo(),
      },
    };
  }

  function priceInfo() {
    let live = false;
    let ts = 0;
    let count = Object.keys(DEFAULT_PRICING).length - 1;
    let source = 'builtin';
    try {
      const c = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
      const tables = ['openaiModels', 'otherModels', 'models'];
      const total = tables.reduce((n, t) => n + Object.keys((c && c[t]) || {}).length, 0);
      if (total > 0) {
        live = true; ts = Number(c.ts) || 0; source = 'models.dev'; count = total;
      }
    } catch {}
    try { fs.accessSync(PRICING_OVERRIDE_PATH); live = true; source = 'override'; } catch {}
    const stale = ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000;
    return { live, count, ts, source, stale, estimate: true };
  }

  async function rebuild() {
    return operations.exclusive(async () => {
      load();
      try {
        await fsp.access(usageFile, fs.constants.F_OK);
      } catch {
        saveNow();
        return getStats();
      }
      const oldLifetime = { ...state.lifetime };
      reset();
      // Pricing sync can replace pricing-cache.json while the app is running;
      // rebuild must use the fresh table for both new and persisted records.
      pricing = loadPricing();
      await performScan();
      // The append-only usage file may have been truncated/rotated since the
      // last scan. Repricing/rebuilding must not erase already observed
      // all-time usage just because the source prefix is no longer present.
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

  return { start, stop, scan, rebuild, getStats, priceInfo, _state: state, _ingestLine: ingestLine };
}

module.exports = {
  createOpenCodeMetering, normalizeUsage, emptyUsage, usageCost, priceFor, normModelName, DEFAULT_PRICING,
};
