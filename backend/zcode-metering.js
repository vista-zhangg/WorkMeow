'use strict';

// ZCode token ledger — read-only poller over ZCode's own SQLite database.
//
// ZCode persists one row per completed model request in
//   ~/.zcode/cli/db/db.sqlite (WAL mode, table `model_usage`)
// with Claude-style token categories: `input_tokens` excludes cache, and
// cache reads/writes live in their own columns. Rows carry model id, status,
// timestamps and `query_source` (main_turn / session_title / …), so the meter
// can exclude background title-generation requests from the message counter
// while still counting their very real token spend.
//
// Unlike opencode there is nothing to install and no usage file to tail: this
// module opens the database read-only on a timer, folds new rows into the same
// stats shape as codex-metering / opencode-metering (so main.js merges the
// sources with zero special-casing), and closes the handle after each scan.
// node:sqlite ships with the Node runtime WorkMeow targets (>= 22.12); if it
// or the schema is missing the meter reports empty stats instead of throwing.
//
// The ZCode database only changes while ZCode itself runs, so a 30s poll is
// plenty and the DB handle is never held between scans.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { STATE_DIR } = require('./paths');
const { num, dayKey, mergeLifetime } = require('./metering-common');
const { createMeterQueue } = require('./meter-queue');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

const DEFAULT_DB_PATH = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const STATE_PATH = path.join(STATE_DIR, 'zcode-usage.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json'); // models.dev sync cache
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'zcode-pricing.json');
const SCHEMA_VERSION = 1;
const DAILY_KEEP_DAYS = 95;
const BACKFILL_MS = DAILY_KEEP_DAYS * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 2000;
const TITLE_QUERY_SOURCES = new Set(['session_title']); // background, never a user message

// USD per 1,000,000 tokens. Last-resort fallback for models the sync cache
// doesn't cover; glm-5.3 is covered by models.dev today, the glm row only
// keeps estimates sane when the cache is missing or offline-stale.
const DEFAULT_PRICING = {
  claude:   { input: 3.00,  output: 15.00, cachedInput: 0.30,  cacheWrite: 3.75  },
  glm:      { input: 0.60,  output: 2.20,  cachedInput: 0.11,  cacheWrite: 0.75  },
  gpt:      { input: 1.25,  output: 10.00, cachedInput: 0.125, cacheWrite: 1.5625 },
  gemini:   { input: 1.25,  output: 10.00, cachedInput: 0.125, cacheWrite: 1.5625 },
  deepseek: { input: 0.27,  output: 1.10,  cachedInput: 0.027, cacheWrite: 0.34  },
  default:  { input: 1.25,  output: 10.00, cachedInput: 0.125, cacheWrite: 1.5625 },
};

const REQUIRED_COLUMNS = Object.freeze([
  'id', 'session_id', 'query_source', 'model_id', 'status', 'completed_at',
  'input_tokens', 'output_tokens', 'reasoning_tokens',
  'cache_creation_input_tokens', 'cache_read_input_tokens', 'computed_total_tokens',
]);

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
  // Layer 1: models.dev sync cache — ZCode runs arbitrary providers.
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
  // Layer 2: user override (~/.workmeow/zcode-pricing.json) — wins.
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
  if (m.includes('glm')) return normalizePriceRow(p.glm);
  if (m.includes('claude')) return normalizePriceRow(p.claude);
  if (m.includes('gemini')) return normalizePriceRow(p.gemini);
  if (m.includes('gpt')) return normalizePriceRow(p.gpt);
  if (m.includes('deepseek')) return normalizePriceRow(p.deepseek);
  return normalizePriceRow(p.default);
}

function emptyUsage() {
  return { tokens: 0, input: 0, output: 0, cachedInput: 0, reasoningOutput: 0, cacheWrite: 0, cost: 0 };
}

// Claude-style categories: input excludes cache; cache read/write are their
// own columns. computed_total_tokens is ZCode's own authoritative total.
function normalizeUsage(row) {
  const input = num(row && row.input_tokens);
  const output = num(row && row.output_tokens);
  const cachedInput = num(row && row.cache_read_input_tokens);
  const cacheWrite = num(row && row.cache_creation_input_tokens);
  return {
    tokens: num(row && row.computed_total_tokens) || (input + output + cachedInput + cacheWrite),
    input,
    output,
    cachedInput,
    reasoningOutput: num(row && row.reasoning_tokens),
    cacheWrite,
  };
}

function usageCost(usage, price) {
  const u = usage || emptyUsage();
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

function createZcodeMetering(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'zcode-usage.json');

  let pricing = loadPricing();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    watermark: { ts: 0, id: '' }, // last model_usage row folded into the ledger
    records: {},       // row id -> { day, ts, model } (dedupe across rescans)
    daily: {},
    hourlyByDay: {},
    hourlyCostByDay: {},
    byModelByDay: {},
    lifetime: emptyDay(),
    diagnostics: { lastScanTs: 0, events: 0, unavailable: null, estimatedModels: {} },
  };
  const operations = createMeterQueue();
  let dirty = false;
  let saveTimer = null;
  let timer = null;
  let loaded = false;

  function reset() {
    state.watermark = { ts: 0, id: '' };
    state.records = {};
    state.daily = {};
    state.hourlyByDay = {};
    state.hourlyCostByDay = {};
    state.byModelByDay = {};
    state.lifetime = emptyDay();
    state.diagnostics = { lastScanTs: 0, events: 0, unavailable: null, estimatedModels: {} };
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      if (raw.schemaVersion !== SCHEMA_VERSION) return; // force rescan
      state.watermark = raw.watermark && typeof raw.watermark === 'object'
        ? { ts: num(raw.watermark.ts), id: String(raw.watermark.id || '') } : { ts: 0, id: '' };
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
      const tmp = path.join(stateDir, `.zcode-usage.${process.pid}.${Date.now()}.tmp`);
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

  function record(ts, model, usage, messageDelta) {
    if (num(usage.tokens) <= 0) return;
    usage.cost = usageCost(usage, priceFor(model, pricing));

    const key = dayKey(ts);
    const day = (state.daily[key] = state.daily[key] || emptyDay());
    addUsage(day, usage, messageDelta);
    addUsage(state.lifetime, usage, messageDelta);

    const hour = new Date(ts).getHours();
    const hours = (state.hourlyByDay[key] = state.hourlyByDay[key] || new Array(24).fill(0));
    hours[hour] += usage.tokens;
    const hourCosts = (state.hourlyCostByDay[key] = state.hourlyCostByDay[key] || new Array(24).fill(0));
    hourCosts[hour] += usage.cost;

    const models = (state.byModelByDay[key] = state.byModelByDay[key] || {});
    const modelKey = model || 'unknown';
    const row = (models[modelKey] = models[modelKey] || emptyDay());
    addUsage(row, usage, messageDelta);

    if (pricing._models && !pricing._models[normModelName(model)]) {
      const estimates = state.diagnostics.estimatedModels || (state.diagnostics.estimatedModels = {});
      estimates[modelKey] = num(estimates[modelKey]) + (messageDelta > 0 ? 1 : 0);
    }
  }

  // Open the DB read-only for one scan and page through every model_usage row
  // at or after the watermark. The (completed_at, id) key keeps ties stable
  // across pages; the records map still dedupes when scans overlap.
  function readNewRows() {
    if (!DatabaseSync) {
      state.diagnostics.unavailable = 'node:sqlite unavailable in this runtime';
      return [];
    }
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (err) {
      state.diagnostics.unavailable = `open failed: ${err.message}`;
      return [];
    }
    try {
      const cols = db.prepare('PRAGMA table_info(model_usage)').all().map((c) => String(c.name));
      const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
      if (missing.length) {
        state.diagnostics.unavailable = `schema changed (missing: ${missing.join(', ')})`;
        return [];
      }
      state.diagnostics.unavailable = null;
      const out = [];
      let lastTs = num(state.watermark.ts);
      let lastId = String(state.watermark.id || '');
      for (;;) {
        const rows = db.prepare(
          `SELECT id, session_id, query_source, agent, model_id, status, completed_at,
                  input_tokens, output_tokens, reasoning_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
             FROM model_usage
            WHERE completed_at > ? OR (completed_at = ? AND id > ?)
            ORDER BY completed_at ASC, id ASC
            LIMIT ${PAGE_SIZE}`
        ).all(lastTs, lastTs, lastId);
        for (const row of rows) out.push(row);
        if (rows.length < PAGE_SIZE) break;
        const tail = rows[rows.length - 1];
        lastTs = num(tail.completed_at);
        lastId = String(tail.id || '');
      }
      return out;
    } catch (err) {
      state.diagnostics.unavailable = `query failed: ${err.message}`;
      return [];
    } finally {
      try { db.close(); } catch {}
    }
  }

  function ingestRow(row) {
    const id = String(row.id || '');
    if (!id || state.records[id]) return false;
    const ts = num(row.completed_at);
    if (ts <= 0) return false; // in-flight row (no completion timestamp yet)
    state.records[id] = { day: dayKey(ts), ts, model: String(row.model_id || 'unknown') };
    const usage = normalizeUsage(row);
    const msgs = TITLE_QUERY_SOURCES.has(String(row.query_source || '')) ? 0 : 1;
    record(ts, String(row.model_id || 'unknown'), usage, msgs);
    state.diagnostics.events = num(state.diagnostics.events) + 1;
    return true;
  }

  async function performScan() {
    load();
    try {
      const rows = readNewRows();
      for (const row of rows) {
        try { ingestRow(row); } catch {}
        const ts = num(row.completed_at);
        const id = String(row.id || '');
        if (ts > num(state.watermark.ts)
          || (ts === num(state.watermark.ts) && id > String(state.watermark.id || ''))) {
          state.watermark = { ts, id };
        }
      }
      pruneDaily();
      state.diagnostics.lastScanTs = Date.now();
      scheduleSave();
    } catch {}
  }

  function scan() { return operations.scan(performScan); }

  function getStats() {
    const todayKey = dayKey(Date.now());
    const today = { ...emptyDay(), ...(state.daily[todayKey] || {}) };
    const byModel = {};
    if (state.byModelByDay[todayKey]) {
      for (const [k, v] of Object.entries(state.byModelByDay[todayKey])) {
        // 面板按 Claude 语义读 cacheRead/cacheWrite5m：把 SQLite 的
        // cache_read/cache_creation 映射过去，让缓存列也有数。
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
      const oldLifetime = { ...state.lifetime };
      reset();
      // Pricing sync can replace pricing-cache.json while the app is running;
      // rebuild must use the fresh table for both new and persisted records.
      pricing = loadPricing();
      await performScan();
      // The SQLite source can be pruned by ZCode's own retention; rebuilding
      // must not erase already observed all-time usage just because old rows
      // are no longer present.
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

  return { start, stop, scan, rebuild, getStats, priceInfo, _state: state, _ingestRow: ingestRow };
}

module.exports = {
  createZcodeMetering, normalizeUsage, usageCost, priceFor, normModelName, DEFAULT_PRICING,
};
