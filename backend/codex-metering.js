'use strict';

// Persistent Codex token ledger + pricing.
//
// Codex rollout token_count events expose both total_token_usage (a cumulative
// counter that can reset after compaction/context reconstruction) and
// last_token_usage (the exact current request). We ledger last_token_usage once
// per append-only event. Using positive cumulative deltas over-counted a real
// day by >10x because every cumulative reset re-added a large partial history.
// Cached input and reasoning output are subsets of input/output, so they are
// reported separately but never added on top of total_tokens.
//
// Pricing uses USD per 1M tokens (OpenAI public pricing, 2025). Cached input
// is priced at 50% of base input cost.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { STATE_DIR } = require('./paths');
const { num, dayKey, mergeLifetime } = require('./metering-common');
const { createMeterQueue } = require('./meter-queue');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const STATE_PATH = path.join(STATE_DIR, 'codex-usage.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json'); // models.dev sync cache
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'codex-pricing.json');
const SCHEMA_VERSION = 3;
const DAILY_KEEP_DAYS = 95;
const BACKFILL_MS = DAILY_KEEP_DAYS * 24 * 60 * 60 * 1000;

// Codex/OpenAI model pricing (USD per 1,000,000 tokens)
// Priority: synced cache > user override > built-in defaults.
// Built-in defaults aligned with the current models.dev OpenAI pricing snapshot.
// Cache discount varies by generation: gpt-5+ = 10%, gpt-4.1/o3 = 25%, gpt-4o/o1 = 50%.
const DEFAULT_PRICING = {
  // GPT-5.6 family (latest)
  'gpt-5.6':            { input: 5.00, output: 30.00, cachedInput: 0.50 },
  'gpt-5.6-luna':       { input: 0.20, output: 1.20,  cachedInput: 0.02 },
  'gpt-5.6-sol':        { input: 5.00, output: 30.00, cachedInput: 0.50 },
  'gpt-5.6-terra':      { input: 2.00, output: 12.00, cachedInput: 0.20 },
  // GPT-5.5 family
  'gpt-5.5':            { input: 5.00, output: 30.00, cachedInput: 0.50 },
  'gpt-5.5-pro':        { input: 30.0, output: 180.0, cachedInput: 3.00 },
  // GPT-5.4 family
  'gpt-5.4':            { input: 2.50, output: 15.00, cachedInput: 0.25 },
  'gpt-5.4-mini':       { input: 0.75, output: 4.50,  cachedInput: 0.075 },
  'gpt-5.4-nano':       { input: 0.20, output: 1.25,  cachedInput: 0.02 },
  'gpt-5.4-pro':        { input: 30.0, output: 180.0, cachedInput: 3.00 },
  // GPT-5.3 / 5.2 / 5.1 family
  'gpt-5.3':            { input: 1.75, output: 14.00, cachedInput: 0.175 },
  'gpt-5.2':            { input: 1.75, output: 14.00, cachedInput: 0.175 },
  'gpt-5.2-pro':        { input: 21.0, output: 168.0, cachedInput: 2.10 },
  'gpt-5.1':            { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5.1-codex':      { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2.00,  cachedInput: 0.025 },
  'gpt-5.1-codex-max':  { input: 1.25, output: 10.00, cachedInput: 0.125 },
  // GPT-5 base family
  'gpt-5':              { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5-codex':        { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5-chat':         { input: 1.25, output: 10.00, cachedInput: 0.125 },
  'gpt-5-mini':         { input: 0.25, output: 2.00,  cachedInput: 0.025 },
  'gpt-5-nano':         { input: 0.05, output: 0.40,  cachedInput: 0.005 },
  'gpt-5-pro':          { input: 15.0, output: 120.0, cachedInput: 1.50 },
  // GPT-4.1 family (cache = 25%)
  'gpt-4.1':            { input: 2.00, output: 8.00,  cachedInput: 0.50 },
  'gpt-4.1-mini':       { input: 0.40, output: 1.60,  cachedInput: 0.10 },
  'gpt-4.1-nano':       { input: 0.10, output: 0.40,  cachedInput: 0.025 },
  // GPT-4o family (cache = 50%)
  'gpt-4o':             { input: 2.50, output: 10.00, cachedInput: 1.25 },
  'gpt-4o-2024-08-06':  { input: 2.50, output: 10.00, cachedInput: 1.25 },
  'chatgpt-4o-latest':  { input: 5.00, output: 15.00, cachedInput: 2.50 },
  'gpt-4o-mini':        { input: 0.15, output: 0.60,  cachedInput: 0.075 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.60, cachedInput: 0.075 },
  // o1 family (reasoning, cache = 50%)
  'o1':                 { input: 15.0, output: 60.00, cachedInput: 7.50 },
  'o1-preview':         { input: 15.0, output: 60.00, cachedInput: 7.50 },
  'o1-mini':            { input: 3.00, output: 12.00, cachedInput: 1.50 },
  // o3 family
  'o3':                 { input: 2.00, output: 8.00,  cachedInput: 0.50 },
  'o3-mini':            { input: 1.10, output: 4.40,  cachedInput: 0.55 },
  // GPT-4 Turbo / legacy
  'gpt-4-turbo':        { input: 10.0, output: 30.00, cachedInput: 5.00 },
  'gpt-4':              { input: 30.0, output: 60.00, cachedInput: 15.0 },
  'gpt-4-32k':          { input: 60.0, output: 120.0, cachedInput: 30.0 },
  // GPT-3.5 family (legacy, no discount)
  'gpt-3.5-turbo':      { input: 0.50, output: 1.50,  cachedInput: 0.25 },
  'gpt-3.5-turbo-16k':  { input: 3.00, output: 4.00,  cachedInput: 1.50 },
  // Default fallback (use gpt-5 pricing as conservative estimate)
  'default':            { input: 1.25, output: 10.00, cachedInput: 0.125 },
};

function normModelName(model) {
  const s = String(model || '').toLowerCase().trim();
  if (!s) return '';
  // Strip version dates and provider prefixes
  return s.replace(/-\d{4}\d{2}\d{2}\b/g, '').replace(/@.*$/, '').split('/').pop() || s;
}

function priceFor(model, table = null) {
  const pricing = table || loadPricing();
  const models = pricing._models || {};
  const norm = normModelName(model);
  if (norm && models[norm]) return normalizePriceRow(models[norm]);
  const m = String(model || '').toLowerCase();
  // Prefix matching — most specific first, highest version first.
  // GPT-5.6 family
  if (m.includes('gpt-5.6-luna')) return normalizePriceRow(pricing['gpt-5.6-luna'] || pricing['gpt-5.6'] || pricing.default);
  if (m.includes('gpt-5.6-sol'))  return normalizePriceRow(pricing['gpt-5.6-sol']  || pricing['gpt-5.6'] || pricing.default);
  if (m.includes('gpt-5.6-terra'))return normalizePriceRow(pricing['gpt-5.6-terra']|| pricing['gpt-5.6'] || pricing.default);
  if (m.includes('gpt-5.6'))      return normalizePriceRow(pricing['gpt-5.6']      || pricing.default);
  // GPT-5.5 family
  if (m.includes('gpt-5.5-pro'))  return normalizePriceRow(pricing['gpt-5.5-pro']  || pricing['gpt-5.5'] || pricing.default);
  if (m.includes('gpt-5.5'))      return normalizePriceRow(pricing['gpt-5.5']      || pricing.default);
  // GPT-5.4 family
  if (m.includes('gpt-5.4-nano')) return normalizePriceRow(pricing['gpt-5.4-nano'] || pricing.default);
  if (m.includes('gpt-5.4-mini')) return normalizePriceRow(pricing['gpt-5.4-mini'] || pricing.default);
  if (m.includes('gpt-5.4-pro'))  return normalizePriceRow(pricing['gpt-5.4-pro']  || pricing['gpt-5.4'] || pricing.default);
  if (m.includes('gpt-5.4'))      return normalizePriceRow(pricing['gpt-5.4']      || pricing.default);
  // GPT-5.3
  if (m.includes('gpt-5.3'))      return normalizePriceRow(pricing['gpt-5.3']      || pricing['gpt-5.2'] || pricing.default);
  // GPT-5.2 family
  if (m.includes('gpt-5.2-pro'))  return normalizePriceRow(pricing['gpt-5.2-pro']  || pricing['gpt-5.2'] || pricing.default);
  if (m.includes('gpt-5.2'))      return normalizePriceRow(pricing['gpt-5.2']      || pricing.default);
  // GPT-5.1 family
  if (m.includes('gpt-5.1-codex-mini')) return normalizePriceRow(pricing['gpt-5.1-codex-mini'] || pricing['gpt-5-mini'] || pricing.default);
  if (m.includes('gpt-5.1-codex-max'))  return normalizePriceRow(pricing['gpt-5.1-codex-max']  || pricing['gpt-5.1'] || pricing.default);
  if (m.includes('gpt-5.1-codex'))      return normalizePriceRow(pricing['gpt-5.1-codex']      || pricing['gpt-5.1'] || pricing.default);
  if (m.includes('gpt-5.1-chat'))       return normalizePriceRow(pricing['gpt-5.1']            || pricing.default);
  if (m.includes('gpt-5.1'))            return normalizePriceRow(pricing['gpt-5.1']            || pricing.default);
  // GPT-5 base family
  if (m.includes('gpt-5-codex'))  return normalizePriceRow(pricing['gpt-5-codex']  || pricing['gpt-5'] || pricing.default);
  if (m.includes('gpt-5-chat'))   return normalizePriceRow(pricing['gpt-5-chat']   || pricing['gpt-5'] || pricing.default);
  if (m.includes('gpt-5-pro'))    return normalizePriceRow(pricing['gpt-5-pro']    || pricing.default);
  if (m.includes('gpt-5-nano'))   return normalizePriceRow(pricing['gpt-5-nano']   || pricing.default);
  if (m.includes('gpt-5-mini'))   return normalizePriceRow(pricing['gpt-5-mini']   || pricing.default);
  if (m.includes('gpt-5'))        return normalizePriceRow(pricing['gpt-5']        || pricing.default);
  // GPT-4.1 family
  if (m.includes('gpt-4.1-nano')) return normalizePriceRow(pricing['gpt-4.1-nano'] || pricing.default);
  if (m.includes('gpt-4.1-mini')) return normalizePriceRow(pricing['gpt-4.1-mini'] || pricing.default);
  if (m.includes('gpt-4.1'))      return normalizePriceRow(pricing['gpt-4.1']      || pricing.default);
  // GPT-4o family
  if (m.includes('chatgpt-4o-latest')) return normalizePriceRow(pricing['chatgpt-4o-latest'] || pricing['gpt-4o'] || pricing.default);
  if (m.includes('gpt-4o-mini'))  return normalizePriceRow(pricing['gpt-4o-mini']  || pricing.default);
  if (m.includes('gpt-4o'))       return normalizePriceRow(pricing['gpt-4o']       || pricing.default);
  // o-series reasoning models
  if (m.includes('o3-mini'))      return normalizePriceRow(pricing['o3-mini']      || pricing.default);
  if (m.includes('o3'))           return normalizePriceRow(pricing['o3']           || pricing.default);
  if (m.includes('o1-mini'))      return normalizePriceRow(pricing['o1-mini']      || pricing.default);
  if (m.includes('o1-preview') || m.includes('o1-')) return normalizePriceRow(pricing['o1-preview'] || pricing['o1'] || pricing.default);
  if (m.includes('o1'))           return normalizePriceRow(pricing['o1']           || pricing.default);
  // GPT-4 legacy
  if (m.includes('gpt-4-turbo') || m.includes('gpt-4-1106') || m.includes('gpt-4-0125')) {
    return normalizePriceRow(pricing['gpt-4-turbo'] || pricing.default);
  }
  if (m.includes('gpt-4-32k'))    return normalizePriceRow(pricing['gpt-4-32k']    || pricing.default);
  if (m.includes('gpt-4'))        return normalizePriceRow(pricing['gpt-4']        || pricing.default);
  // GPT-3.5 legacy
  if (m.includes('gpt-3.5-turbo-16k')) return normalizePriceRow(pricing['gpt-3.5-turbo-16k'] || pricing.default);
  if (m.includes('gpt-3.5'))      return normalizePriceRow(pricing['gpt-3.5-turbo']|| pricing.default);
  return normalizePriceRow(pricing.default);
}

function normalizePriceRow(row, fallback = DEFAULT_PRICING.default) {
  const input = Number.isFinite(row && row.input) ? row.input : fallback.input;
  const output = Number.isFinite(row && row.output) ? row.output : fallback.output;
  const cachedInput = Number.isFinite(row && row.cachedInput)
    ? row.cachedInput
    : input * 0.5;
  return { input, output, cachedInput };
}

function loadPricing() {
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  out._models = {};
  // Layer 1: models.dev sync cache (online prices, refreshed every 24h)
  try {
    const c = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (c && c.openaiModels && typeof c.openaiModels === 'object') {
      for (const [id, row] of Object.entries(c.openaiModels)) {
        if (row && typeof row === 'object' && Number.isFinite(row.input)) {
          const k = normModelName(id);
          out._models[k] = normalizePriceRow(row, out._models[k] || DEFAULT_PRICING.default);
        }
      }
    }
  } catch {}
  // Layer 2: user override (~/.workmeow/codex-pricing.json) — wins over sync cache
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

function usageCost(usage, price) {
  const u = usage || {};
  const p = normalizePriceRow(price);
  // cachedInput is already part of input tokens — don't double count
  const regularInput = Math.max(0, num(u.input) - num(u.cachedInput));
  return (
    regularInput * p.input
    + num(u.output) * p.output
    + num(u.cachedInput) * p.cachedInput
  ) / 1e6;
}

function emptyUsage() {
  return {
    tokens: 0, input: 0, output: 0, cachedInput: 0,
    reasoningOutput: 0, cacheWrite: 0, cost: 0,
  };
}

function normalizeUsage(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const input = num(u.input_tokens ?? u.inputTokens);
  const output = num(u.output_tokens ?? u.outputTokens);
  const cachedInput = num(u.cached_input_tokens ?? u.cachedInputTokens);
  const reasoningOutput = num(u.reasoning_output_tokens ?? u.reasoningOutputTokens);
  const normalized = {
    tokens: num(u.total_tokens ?? u.totalTokens) || input + output,
    input,
    output,
    cachedInput,
    reasoningOutput,
    cacheWrite: num(u.cache_write_input_tokens ?? u.cacheWriteInputTokens),
    cost: 0,
  };
  return normalized;
}

function deltaUsage(previous, current) {
  const a = previous || emptyUsage();
  const b = current || emptyUsage();
  const reset = num(b.tokens) < num(a.tokens);
  const out = {};
  for (const key of Object.keys(emptyUsage())) {
    out[key] = reset ? num(b[key]) : Math.max(0, num(b[key]) - num(a[key]));
  }
  return out;
}

function parseTimestamp(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value);
    if (Number.isFinite(n)) return n > 0 && n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function emptyDay() {
  return { ...emptyUsage(), msgs: 0 };
}

function addUsage(target, delta, messageDelta = 0) {
  for (const key of Object.keys(emptyUsage())) target[key] = num(target[key]) + num(delta[key]);
  target.msgs = num(target.msgs) + messageDelta;
}

function createCodexMetering(options = {}) {
  const sessionsDir = options.sessionsDir || SESSIONS_DIR;
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'codex-usage.json');

  const state = {
    schemaVersion: SCHEMA_VERSION,
    files: {},
    sessions: {},
    daily: {},
    hourlyByDay: {},
    hourlyCostByDay: {},
    byModelByDay: {},
    lifetime: emptyDay(),
    diagnostics: { lastScanTs: 0, scannedFiles: 0, events: 0, resets: 0 },
  };
  let scanning = false;
  const operations = createMeterQueue();
  let pricing = loadPricing();
  let dirty = false;
  let saveTimer = null;
  let timer = null;
  let loaded = false;

  function reset() {
    state.files = {};
    state.sessions = {};
    state.daily = {};
    state.hourlyByDay = {};
    state.hourlyCostByDay = {};
    state.byModelByDay = {};
    state.lifetime = emptyDay();
    state.diagnostics = { lastScanTs: 0, scannedFiles: 0, events: 0, resets: 0 };
  }

  function migrateState(raw) {
    // Schema v2 -> v3: add cost field (recompute from scratch)
    if (raw.schemaVersion < 3) {
      // Just reset and rescan to get accurate costs
      return false;
    }
    return true;
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw) return;
      if (raw.schemaVersion !== SCHEMA_VERSION) {
        if (!migrateState(raw)) return; // Force rescan
      }
      state.files = raw.files && typeof raw.files === 'object' ? raw.files : {};
      state.sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
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
      const tmp = path.join(stateDir, `.codex-usage.${process.pid}.${Date.now()}.tmp`);
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
    for (const [id, session] of Object.entries(state.sessions)) {
      if (Number.isFinite(Number(session && session.updatedAt))
        && Number(session.updatedAt) < Date.now() - BACKFILL_MS) delete state.sessions[id];
    }
  }

  async function listFiles(dir = sessionsDir, out = []) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await listFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  function record(ts, model, delta) {
    if (num(delta.tokens) <= 0) return;
    const p = priceFor(model, pricing);
    const cost = usageCost(delta, p);
    delta.cost = cost;

    const key = dayKey(ts);
    const day = (state.daily[key] = state.daily[key] || emptyDay());
    addUsage(day, delta, 1);
    addUsage(state.lifetime, delta, 1);

    const hour = new Date(ts).getHours();
    const hours = (state.hourlyByDay[key] = state.hourlyByDay[key] || new Array(24).fill(0));
    hours[hour] += delta.tokens;
    const hourCosts = (state.hourlyCostByDay[key] = state.hourlyCostByDay[key] || new Array(24).fill(0));
    hourCosts[hour] += cost;

    const models = (state.byModelByDay[key] = state.byModelByDay[key] || {});
    const modelKey = model || 'unknown';
    const row = (models[modelKey] = models[modelKey] || emptyDay());
    addUsage(row, delta, 1);
  }

  function processObject(fileState, file, object) {
    const payload = object && object.payload && typeof object.payload === 'object' ? object.payload : {};
    if (object.type === 'session_meta') {
      fileState.sessionId = String(payload.id || payload.session_id || fileState.sessionId || file);
      return;
    }
    if (object.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) fileState.model = payload.model;
      return;
    }
    if (object.type !== 'event_msg' || payload.type !== 'token_count') return;
    const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
    const cumulative = normalizeUsage(info.total_token_usage || info.totalTokenUsage);
    const current = normalizeUsage(info.last_token_usage || info.lastTokenUsage);
    if (current.tokens <= 0) return;
    const sessionKey = fileState.sessionId || file;
    const previous = state.sessions[sessionKey] && state.sessions[sessionKey].usage;
    const ts = parseTimestamp(object.timestamp);
    // A rollout can be truncated/rotated while retaining a prefix that was
    // already consumed. During the replay pass, skip those old rows by their
    // timestamp; genuinely appended rows are newer and still get counted.
    if (fileState.replaying && previous && ts <= Number(state.sessions[sessionKey].updatedAt || 0)
      && cumulative.tokens <= num(previous.tokens)) return;
    if (previous && cumulative.tokens < num(previous.tokens)) state.diagnostics.resets++;
    state.sessions[sessionKey] = { usage: cumulative, updatedAt: ts };
    record(ts, fileState.model, current);
    state.diagnostics.events++;
  }

  async function scanFile(file) {
    let stat;
    try { stat = await fsp.stat(file); } catch { return; }
    const fileState = state.files[file] || { offset: 0, carry: '', sessionId: null, model: null };
    if (fileState.offset > stat.size) {
      state.diagnostics.truncated = (state.diagnostics.truncated || 0) + 1;
      fileState.offset = 0;
      fileState.carry = '';
      fileState.replaying = true;
    }
    if (fileState.offset === stat.size) return;
    const stream = fs.createReadStream(file, { start: fileState.offset, encoding: 'utf8' });
    let carry = fileState.carry || '';
    for await (const chunk of stream) {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() || '';
      for (const line of lines) {
        if (!line || line.charCodeAt(0) !== 123) continue;
        let object;
        try { object = JSON.parse(line); } catch { continue; }
        processObject(fileState, file, object);
      }
    }
    fileState.offset = stat.size;
    fileState.carry = carry;
    fileState.replaying = false;
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
    // Ensure all model rows have cost field
    for (const key of Object.keys(byModel)) {
      byModel[key] = { ...emptyDay(), ...byModel[key] };
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
        sessions: Object.keys(state.sessions).length,
      },
    };
  }

  async function rebuild() {
    return operations.exclusive(async () => {
      load();
      const files = await listFiles();
      if (!files.length) {
        saveNow();
        return getStats();
      }
      const oldLifetime = { ...state.lifetime };
      reset();
      pricing = loadPricing();
      await performScan();
      // Rollouts can be deleted, compacted, or only partially available. A
      // rebuild is a repair/reprice operation, not permission to erase the
      // monotonic lifetime ledger when the source no longer contains all rows.
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

  function priceInfo() {
    let live = false;
    let ts = 0;
    let count = Object.keys(DEFAULT_PRICING).length - 1;
    let source = 'builtin';
    try {
      const c = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
      if (c && c.openaiModels && typeof c.openaiModels === 'object' && Object.keys(c.openaiModels).length) {
        live = true; ts = Number(c.ts) || 0; source = 'models.dev';
        count = Object.keys(c.openaiModels).length;
      }
    } catch {}
    try { fs.accessSync(PRICING_OVERRIDE_PATH); live = true; source = 'override'; } catch {}
    const stale = ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000;
    return { live, count, ts, source, stale, estimate: true };
  }

  return { start, stop, scan, rebuild, getStats, priceInfo, _state: state, _processObject: processObject };
}

module.exports = { createCodexMetering, normalizeUsage, deltaUsage, emptyUsage, priceFor, usageCost, parseTimestamp };
