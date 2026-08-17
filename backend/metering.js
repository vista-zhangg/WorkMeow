'use strict';

// Metering + billing for Claude Code usage.
//
// Claude Code writes a transcript JSONL per session under
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Each assistant turn line carries message.usage (input / output / cache tokens)
// and message.model. Claude writes the SAME message id several times while the
// response streams; later rows contain the completed output token count. We keep
// the component-wise maximum snapshot per message and apply only the positive
// delta, so neither the first partial row nor a resumed/copied transcript can
// under-count or double-count usage. Aggregates persist to ~/.workmeow/usage.json
// so the retained 95-day calendar survives restarts; the first run backfills
// from the existing transcripts.
//
// Same idea as the ccusage tool: read only token counts + model + timestamps
// from the transcripts (never message content), then price them.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { STATE_DIR } = require('./paths');
const { num, dayKey } = require('./metering-common');
const { createMeterQueue } = require('./meter-queue');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const STATE_PATH = path.join(STATE_DIR, 'usage.json');
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'pricing.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json'); // models.dev 同步缓存

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_KEEP_DAYS = 95;
const BACKFILL_MS = DAILY_KEEP_DAYS * DAY_MS;
const STATE_SCHEMA = 3;

// USD per 1,000,000 tokens. Family-level ESTIMATES — only a last-resort fallback
// now that we price by exact model id (pricing._models, synced from models.dev).
// Override via ~/.workmeow/pricing.json (families and/or a "models" map):
//   { "opus": {...}, "models": { "claude-opus-4-8": {"input":5,"output":25,...} } }
const DEFAULT_PRICING = {
  opus:    { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  fable:   { input: 10, output: 50, cacheWrite5m: 12.5,  cacheWrite1h: 20, cacheRead: 1 },
  sonnet:  { input: 3,  output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6, cacheRead: 0.3 },
  haiku:   { input: 1,  output: 5,  cacheWrite5m: 1.25,  cacheWrite1h: 2, cacheRead: 0.1 },
  default: { input: 3,  output: 15, cacheWrite5m: 3.75,  cacheWrite1h: 6, cacheRead: 0.3 },
};

// Normalize a model name to match the pricing table: lowercase, strip any
// provider/region prefix (anthropic./us.…), and drop the date + version suffix.
// transcript names (claude-opus-4-8) are already bare — this mainly folds
// models.dev's dated variants (claude-opus-4-5-20251101) onto the bare id.
function normModelName(model) {
  const s = String(model || '').toLowerCase().trim().split(':')[0];
  if (!s) return '';
  const seg = s.split(/[/.]/).find((p) => p.includes('claude')) || s;
  return seg.replace(/-\d{8}\b/g, '').replace(/-v\d+$/, '').replace(/@.*$/, '');
}

// Priority: user manual override > models.dev sync cache > built-in defaults.
// Family-level shallow merge — sub-keys (input/output/cacheWrite/cacheRead)
// from a higher layer replace the same key in a lower layer; missing sub-keys
// keep the lower-layer value. So a stale cache can't zero-out a missing field.
function normalizePriceRow(row, fallback = DEFAULT_PRICING.default) {
  const input = Number.isFinite(row && row.input) ? row.input : fallback.input;
  const output = Number.isFinite(row && row.output) ? row.output : fallback.output;
  const cacheWrite5m = Number.isFinite(row && row.cacheWrite5m)
    ? row.cacheWrite5m
    : Number.isFinite(row && row.cacheWrite) ? row.cacheWrite : input * 1.25;
  const cacheWrite1h = Number.isFinite(row && row.cacheWrite1h) ? row.cacheWrite1h : input * 2;
  const cacheRead = Number.isFinite(row && row.cacheRead) ? row.cacheRead : input * 0.1;
  const out = { input, output, cacheWrite5m, cacheWrite1h, cacheRead };
  if (Number.isFinite(row && row.contextWindow) && row.contextWindow > 0) {
    out.contextWindow = Math.floor(row.contextWindow);
  }
  return out;
}

function mergePriceRow(base, incoming) {
  const row = incoming && typeof incoming === 'object' ? { ...incoming } : {};
  // Backward compatibility with pricing.json files documented by older WorkMeow
  // versions. A legacy cacheWrite override must beat the new built-in 5m field.
  if (!Number.isFinite(row.cacheWrite5m) && Number.isFinite(row.cacheWrite)) {
    row.cacheWrite5m = row.cacheWrite;
  }
  return normalizePriceRow(row, normalizePriceRow(base || DEFAULT_PRICING.default));
}

function loadPricing(options = {}) {
  const cachePath = options.pricingCachePath || PRICING_CACHE_PATH;
  const overridePath = options.pricingOverridePath || PRICING_OVERRIDE_PATH;
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  out._models = {}; // exact per-model-id prices (claude-fable-5 → {...}); wins over family
  // layer 1: synced cache (~/.workmeow/pricing-cache.json)
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c && c.pricing && typeof c.pricing === 'object') {
      for (const [fam, row] of Object.entries(c.pricing)) {
        if (out[fam] && row && typeof row === 'object') {
          out[fam] = mergePriceRow(out[fam], row);
        }
      }
    }
    if (c && c.models && typeof c.models === 'object') {
      for (const [id, row] of Object.entries(c.models)) {
        if (row && typeof row === 'object' && Number.isFinite(row.input)) {
          out._models[normModelName(id)] = normalizePriceRow(row);
        }
      }
    }
  } catch {}
  // layer 2: user override (~/.workmeow/pricing.json) — wins. Supports both family
  // keys and a "models" map of exact ids.
  try {
    const raw = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    for (const [fam, row] of Object.entries(raw)) {
      if (fam === 'models' && row && typeof row === 'object') {
        for (const [id, r] of Object.entries(row)) {
          const k = normModelName(id);
          if (r && typeof r === 'object') out._models[k] = mergePriceRow(out._models[k] || DEFAULT_PRICING.default, r);
        }
      } else if (row && typeof row === 'object') {
        out[fam] = mergePriceRow(out[fam] || DEFAULT_PRICING.default, row);
      }
    }
  } catch {}
  for (const fam of ['opus', 'fable', 'sonnet', 'haiku', 'default']) {
    out[fam] = normalizePriceRow(out[fam], DEFAULT_PRICING[fam] || DEFAULT_PRICING.default);
  }
  return out;
}

// Price a model: exact per-id table first (correct across opus generations and
// new models like fable-5), then family keyword, then the generic default.
function priceFor(pricing, model) {
  const models = pricing._models || {};
  const norm = normModelName(model);
  if (norm && models[norm]) return normalizePriceRow(models[norm]);
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return normalizePriceRow(pricing.opus);
  if (m.includes('fable')) return normalizePriceRow(pricing.fable || pricing.default);
  if (m.includes('haiku')) return normalizePriceRow(pricing.haiku);
  if (m.includes('sonnet')) return normalizePriceRow(pricing.sonnet);
  return normalizePriceRow(pricing.default);
}

function emptyDay() {
  return {
    cost: 0, tokens: 0, msgs: 0, input: 0, output: 0,
    cacheCreate: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
  };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function usageSnapshot(usage) {
  const nested = usage && usage.cache_creation && typeof usage.cache_creation === 'object'
    ? usage.cache_creation : {};
  const totalCreate = num(usage && usage.cache_creation_input_tokens);
  const oneHour = num(nested.ephemeral_1h_input_tokens);
  const explicitFive = num(nested.ephemeral_5m_input_tokens);
  // Older transcript rows expose only the aggregate field. Anthropic's default
  // cache TTL is 5 minutes, so any unclassified remainder belongs there.
  const fiveMinute = explicitFive + Math.max(0, totalCreate - explicitFive - oneHour);
  return {
    input: num(usage && usage.input_tokens),
    output: num(usage && usage.output_tokens),
    cacheWrite5m: fiveMinute,
    cacheWrite1h: oneHour,
    cacheRead: num(usage && usage.cache_read_input_tokens),
  };
}

function mergeUsage(previous, incoming) {
  const a = previous || emptyUsage();
  const b = incoming || emptyUsage();
  const out = {};
  for (const key of Object.keys(emptyUsage())) out[key] = Math.max(num(a[key]), num(b[key]));
  return out;
}

function usageDelta(previous, next) {
  const a = previous || emptyUsage();
  const b = next || emptyUsage();
  const out = {};
  for (const key of Object.keys(emptyUsage())) out[key] = Math.max(0, num(b[key]) - num(a[key]));
  return out;
}

function usageTokens(usage) {
  const u = usage || emptyUsage();
  return num(u.input) + num(u.output) + num(u.cacheWrite5m) + num(u.cacheWrite1h) + num(u.cacheRead);
}

function usageCost(usage, price) {
  const u = usage || emptyUsage();
  const p = normalizePriceRow(price);
  return (
    num(u.input) * p.input
    + num(u.output) * p.output
    + num(u.cacheWrite5m) * p.cacheWrite5m
    + num(u.cacheWrite1h) * p.cacheWrite1h
    + num(u.cacheRead) * p.cacheRead
  ) / 1e6;
}

function createMetering(options = {}) {
  const projectsDir = options.projectsDir || PROJECTS_DIR;
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'usage.json');
  const pricingPaths = {
    pricingCachePath: options.pricingCachePath || path.join(stateDir, 'pricing-cache.json'),
    pricingOverridePath: options.pricingOverridePath || path.join(stateDir, 'pricing.json'),
  };
  let pricing = loadPricing(pricingPaths);

  // Persisted state.
  let state = {
    schemaVersion: STATE_SCHEMA,
    cursors: {},          // filePath -> byte offset already consumed
    records: {},          // message key -> final/max usage snapshot for streaming correction
    daily: {},            // 'YYYY-MM-DD' -> { cost, tokens, msgs, input, output, cacheCreate, cacheRead }
    byModelByDay: {},     // 'YYYY-MM-DD' -> { model: { cost, tokens } }
    hourlyByDay: {},      // 'YYYY-MM-DD' -> [24] cost
    hourlyTokensByDay: {},// 'YYYY-MM-DD' -> [24] real token usage
    lifetime: emptyDay(), // never pruned; locally observed Claude total
    diagnostics: {
      lastScanTs: 0, scannedFiles: 0, records: 0, streamingCorrections: 0,
      migratedFrom: null, estimatedModels: {},
    },
  };
  let scanning = false;
  const operations = createMeterQueue();
  let dirty = false;
  let saveTimer = null;
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.schemaVersion !== STATE_SCHEMA) {
          state.diagnostics.migratedFrom = Number(raw.schemaVersion) || 1;
          return;
        }
        state.cursors = raw.cursors && typeof raw.cursors === 'object' ? raw.cursors : {};
        state.records = raw.records && typeof raw.records === 'object' ? raw.records : {};
        state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
        state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
        state.hourlyByDay = raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {};
        state.hourlyTokensByDay = raw.hourlyTokensByDay && typeof raw.hourlyTokensByDay === 'object' ? raw.hourlyTokensByDay : {};
        // v2 files created before lifetime existed are migrated from their
        // retained daily ledger exactly once. New usage then advances this
        // monotonic counter even after old calendar days are pruned.
        if (raw.lifetime && typeof raw.lifetime === 'object') {
          state.lifetime = { ...emptyDay(), ...raw.lifetime };
        } else {
          state.lifetime = Object.values(state.daily).reduce((sum, day) => {
            for (const key of Object.keys(emptyDay())) sum[key] += num(day && day[key]);
            return sum;
          }, emptyDay());
        }
        state.diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object'
          ? { ...state.diagnostics, ...raw.diagnostics } : state.diagnostics;
        state.schemaVersion = STATE_SCHEMA;
      }
    } catch {}
    pruneDaily();
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function saveNow() {
    dirty = false;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = path.join(stateDir, `.usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
      try { fs.chmodSync(statePath, 0o600); } catch {}
    } catch {}
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - BACKFILL_MS);
    for (const k of Object.keys(state.daily)) if (k < cutoff) delete state.daily[k];
    for (const k of Object.keys(state.byModelByDay)) if (k < cutoff) delete state.byModelByDay[k];
    for (const k of Object.keys(state.hourlyByDay)) if (k < cutoff) delete state.hourlyByDay[k];
    for (const k of Object.keys(state.hourlyTokensByDay)) if (k < cutoff) delete state.hourlyTokensByDay[k];
    // Bound final usage records to the same retention window.
    for (const [key, rec] of Object.entries(state.records)) {
      if (!rec || rec.day < cutoff) delete state.records[key];
    }
  }

  // Apply a positive usage delta. Message count increments only for the first
  // snapshot; later streaming rows correct token/cost without inventing turns.
  function recordDelta(tsMs, model, usage, isNew, countLifetime = true) {
    const input = num(usage.input);
    const output = num(usage.output);
    const cacheWrite5m = num(usage.cacheWrite5m);
    const cacheWrite1h = num(usage.cacheWrite1h);
    const cacheCreate = cacheWrite5m + cacheWrite1h;
    const cacheRead = num(usage.cacheRead);
    const tokens = usageTokens(usage);
    if (tokens <= 0) return;

    const p = priceFor(pricing, model);
    const cost = usageCost(usage, p);

    const k = dayKey(tsMs);
    const d = (state.daily[k] = state.daily[k] || emptyDay());
    d.cost += cost; d.tokens += tokens; d.msgs += isNew ? 1 : 0;
    d.input += input; d.output += output; d.cacheCreate += cacheCreate;
    d.cacheWrite5m = num(d.cacheWrite5m) + cacheWrite5m;
    d.cacheWrite1h = num(d.cacheWrite1h) + cacheWrite1h;
    d.cacheRead += cacheRead;

    if (countLifetime) {
      const lifetime = state.lifetime || (state.lifetime = emptyDay());
      lifetime.cost += cost; lifetime.tokens += tokens; lifetime.msgs += isNew ? 1 : 0;
      lifetime.input += input; lifetime.output += output; lifetime.cacheCreate += cacheCreate;
      lifetime.cacheWrite5m = num(lifetime.cacheWrite5m) + cacheWrite5m;
      lifetime.cacheWrite1h = num(lifetime.cacheWrite1h) + cacheWrite1h;
      lifetime.cacheRead += cacheRead;
    }

    const fam = (state.byModelByDay[k] = state.byModelByDay[k] || {});
    const mk = model || 'unknown';
    // Per-model detail (cost + token 四元组 + 轮次) so the panel can show 有总有分.
    const mv = (fam[mk] = fam[mk] || {
      cost: 0, tokens: 0, msgs: 0, input: 0, output: 0,
      cacheCreate: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
    });
    mv.cost += cost; mv.tokens += tokens; mv.msgs += isNew ? 1 : 0;
    mv.input += input; mv.output += output; mv.cacheCreate += cacheCreate;
    mv.cacheWrite5m = num(mv.cacheWrite5m) + cacheWrite5m;
    mv.cacheWrite1h = num(mv.cacheWrite1h) + cacheWrite1h;
    mv.cacheRead += cacheRead;

    const hours = (state.hourlyByDay[k] = state.hourlyByDay[k] || new Array(24).fill(0));
    const hour = new Date(tsMs).getHours();
    hours[hour] += cost;
    const hourlyTokens = (state.hourlyTokensByDay[k] = state.hourlyTokensByDay[k] || new Array(24).fill(0));
    hourlyTokens[hour] += tokens;

  }

  function ingest(key, tsMs, model, rawUsage) {
    const incoming = usageSnapshot(rawUsage);
    if (usageTokens(incoming) <= 0) return false;
    const previous = state.records[key] || null;
    const merged = mergeUsage(previous && previous.usage, incoming);
    const delta = usageDelta(previous && previous.usage, merged);
    if (usageTokens(delta) <= 0) return false;
    const isNew = !previous;
    recordDelta(previous ? previous.ts : tsMs, previous ? previous.model : model, delta, isNew);
    state.records[key] = {
      day: dayKey(previous ? previous.ts : tsMs),
      ts: previous ? previous.ts : tsMs,
      model: previous ? previous.model : model,
      usage: merged,
    };
    if (!isNew) state.diagnostics.streamingCorrections = num(state.diagnostics.streamingCorrections) + 1;
    const norm = normModelName(model);
    if (!norm || !(pricing._models && pricing._models[norm])) {
      const estimates = state.diagnostics.estimatedModels || (state.diagnostics.estimatedModels = {});
      estimates[model || 'unknown'] = num(estimates[model || 'unknown']) + (isNew ? 1 : 0);
    }
    return true;
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

  async function scanFile(file, minTimestampMs = 0) {
    let st;
    try { st = await fsp.stat(file); } catch { return; }
    if (st.mtimeMs < Date.now() - BACKFILL_MS) return; // too old to matter
    let offset = state.cursors[file] || 0;
    const wasTruncated = offset > st.size;
    if (wasTruncated) offset = 0; // file truncated/rotated
    if (st.size <= offset) return;

    const { lines, newOffset } = await readNewLines(file, offset, st.size);
    for (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123) continue; // fast skip non-'{' lines
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'assistant') continue;
      const msg = o.message;
      const usage = msg && msg.usage;
      if (!usage || typeof usage !== 'object') continue;
      const id = msg.id || `${o.requestId || ''}:${o.timestamp || ''}`;
      const key = `${id}|${o.requestId || ''}`;
      const tsMs = o.timestamp ? Date.parse(o.timestamp) : st.mtimeMs;
      if (!Number.isFinite(tsMs)) continue;
      const floor = Math.max(minTimestampMs, wasTruncated ? Date.now() - BACKFILL_MS : 0);
      if (floor > 0 && tsMs < floor) continue;
      ingest(key, tsMs, msg.model || 'unknown', usage);
    }
    state.cursors[file] = newOffset;
  }

  async function listTranscripts() {
    const out = [];
    let dirs;
    try { dirs = await fsp.readdir(projectsDir, { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sub = path.join(projectsDir, d.name);
      let files;
      try { files = await fsp.readdir(sub); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(sub, f));
    }
    return out;
  }

  async function performScan(minTimestampMs = 0) {
    load();
    scanning = true;
    try {
      const files = await listTranscripts();
      for (const file of files) {
        // Isolate per file: a single unreadable/poison transcript must not abort
        // the whole loop and starve every file after it, scan after scan.
        try { await scanFile(file, minTimestampMs); } catch {}
      }
      pruneDaily();
      state.diagnostics.lastScanTs = Date.now();
      state.diagnostics.scannedFiles = files.length;
      state.diagnostics.records = Object.keys(state.records).length;
      scheduleSave();
    } catch {
    } finally {
      scanning = false;
    }
  }

  function scan() {
    return operations.scan(performScan);
  }

  function getStats() {
    const todayK = dayKey(Date.now());
    const today = { ...emptyDay(), ...(state.daily[todayK] || {}) };
    const byModel = state.byModelByDay[todayK] ? { ...state.byModelByDay[todayK] } : {};
    const hourly = (state.hourlyByDay[todayK] || new Array(24).fill(0)).slice();
    const hourlyTok = (state.hourlyTokensByDay[todayK] || new Array(24).fill(0)).slice();

    // Keep the token components in the daily ledger so the detail panel can
    // calculate range-level cache/input statistics, not just cost/tokens.
    const daily = {};
    for (const [k, v] of Object.entries(state.daily)) {
      daily[k] = { ...emptyDay(), ...v };
    }

    return {
      today,
      lifetime: { ...emptyDay(), ...(state.lifetime || {}) },
      byModel,
      hourly,
      hourlyTok,
      daily,
      diagnostics: diagnostics(),
    };
  }

  // Re-read the price table after a models.dev sync lands a fresh cache.
  function reloadPricing() {
    return operations.exclusive(async () => {
      const previousPricing = pricing;
      pricing = loadPricing(pricingPaths);
      repriceRecords(previousPricing);
      scheduleSave();
      return getStats();
    });
  }

  // Report the price table the UI is actually using — the old hard-coded
  // { live:false, source:'builtin' } told every online user their sync failed.
  function priceInfo() {
    let live = false;
    let ts = 0;
    let count = Object.keys(DEFAULT_PRICING).length - 1;
    let source = 'builtin';
    try {
      const c = JSON.parse(fs.readFileSync(pricingPaths.pricingCachePath, 'utf8'));
      if (c && c.pricing && typeof c.pricing === 'object' && Object.keys(c.pricing).length) {
        live = true; ts = Number(c.ts) || 0; source = 'models.dev';
        // Prefer the exact per-model count (what actually drives billing now).
        count = (c.models && typeof c.models === 'object' && Object.keys(c.models).length)
          ? Object.keys(c.models).length
          : Object.keys(c.pricing).length;
      }
    } catch {}
    try { fs.accessSync(pricingPaths.pricingOverridePath); live = true; source = 'override'; } catch {}
    const stale = ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000;
    return { live, count, ts, source, stale, estimate: true };
  }

  // Whole-history recompute: clear the aggregates + cursors + dedupe set and
  // re-scan every transcript from byte 0 with the CURRENT (fixed) price table.
  // The transcripts are the source of truth, so this retroactively corrects cost
  // stored under a wrong price (e.g. fable-5 previously billed at sonnet). Async.
  async function rebuild() {
    return operations.exclusive(async () => {
      // The CLI constructs a fresh meter and calls rebuild() directly. Load
      // the persisted ledger once, but never reload it over live in-memory
      // events after start() has already initialized this instance.
      load();
      // Records are retained for 95 days, while lifetime is intentionally
      // monotonic. Preserve the older/non-reconstructible base and rebuild the
      // retained window with the current table instead of resetting all-time
      // usage to zero.
      const previousPricing = pricing;
      const oldRecords = state.records;
      const lifetimeBase = subtractUsage(state.lifetime, aggregateRecords(previousPricing));
      state.cursors = {};
      state.records = {};
      state.daily = {};
      state.byModelByDay = {};
      state.hourlyByDay = {};
      state.hourlyTokensByDay = {};
      state.lifetime = lifetimeBase;
      state.diagnostics = {
        lastScanTs: 0, scannedFiles: 0, records: 0, streamingCorrections: 0,
        migratedFrom: null, estimatedModels: {},
      };
      pricing = loadPricing(pricingPaths);
      // The lifetime base already contains usage older than our retained
      // records. Scan the current source, then merge it with the old retained
      // ledger: a deleted/rotated transcript must not make lifetime totals go
      // backwards, and a smaller replayed snapshot must not erase a streamed
      // maximum already observed in the ledger.
      await performScan(Date.now() - BACKFILL_MS);
      const scannedRecords = state.records;
      const combinedRecords = { ...oldRecords };
      for (const [key, next] of Object.entries(scannedRecords)) {
        const prev = combinedRecords[key];
        if (!prev) {
          combinedRecords[key] = next;
          continue;
        }
        const usage = mergeUsage(prev.usage, next.usage);
        combinedRecords[key] = {
          ...next,
          ts: prev.ts || next.ts,
          day: prev.day || next.day,
          model: prev.model || next.model,
          usage,
        };
      }
      state.records = combinedRecords;
      rebuildAggregates(combinedRecords, lifetimeBase);
      state.diagnostics.records = Object.keys(combinedRecords).length;
      pruneDaily();
      saveNow();
      return totals();
    });
  }

  function resetAggregates() {
    state.daily = {};
    state.byModelByDay = {};
    state.hourlyByDay = {};
    state.hourlyTokensByDay = {};
    state.diagnostics.estimatedModels = {};
  }

  function aggregateRecords(table) {
    const total = emptyDay();
    for (const rec of Object.values(state.records)) {
      if (!rec || !rec.usage) continue;
      const usage = rec.usage;
      total.cost += usageCost(usage, priceFor(table, rec.model));
      total.tokens += usageTokens(usage);
      total.msgs += 1;
      total.input += num(usage.input);
      total.output += num(usage.output);
      total.cacheWrite5m += num(usage.cacheWrite5m);
      total.cacheWrite1h += num(usage.cacheWrite1h);
      total.cacheCreate += num(usage.cacheWrite5m) + num(usage.cacheWrite1h);
      total.cacheRead += num(usage.cacheRead);
    }
    return total;
  }

  function subtractUsage(total, part) {
    const out = emptyDay();
    for (const key of Object.keys(out)) out[key] = Math.max(0, num(total && total[key]) - num(part && part[key]));
    return out;
  }

  function repriceRecords(previousPricing = pricing) {
    const lifetimeBase = subtractUsage(state.lifetime, aggregateRecords(previousPricing));
    rebuildAggregates(state.records, lifetimeBase);
  }

  function rebuildAggregates(records, lifetimeBase) {
    resetAggregates();
    state.lifetime = lifetimeBase;
    const rows = Object.values(records || {}).sort((a, b) => a.ts - b.ts);
    for (const rec of rows) {
      // Repricing rebuilds the retained calendar/cost views. Lifetime token
      // progression has already counted these records and must not advance.
      recordDelta(rec.ts, rec.model, rec.usage, true, true);
      const norm = normModelName(rec.model);
      if (!norm || !(pricing._models && pricing._models[norm])) {
        const estimates = state.diagnostics.estimatedModels;
        estimates[rec.model || 'unknown'] = num(estimates[rec.model || 'unknown']) + 1;
      }
    }
    pruneDaily();
  }

  function diagnostics() {
    const info = priceInfo();
    const estimated = state.diagnostics.estimatedModels || {};
    return {
      schemaVersion: STATE_SCHEMA,
      lastScanTs: num(state.diagnostics.lastScanTs),
      scannedFiles: num(state.diagnostics.scannedFiles),
      records: Object.keys(state.records).length,
      streamingCorrections: num(state.diagnostics.streamingCorrections),
      migratedFrom: state.diagnostics.migratedFrom || null,
      estimatedModelCount: Object.keys(estimated).length,
      estimatedModels: Object.entries(estimated)
        .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([model, count]) => ({ model, count })),
      pricing: info,
    };
  }

  // All-time cost/token totals per model, summed across the retained days.
  function totals() {
    let cost = 0, tokens = 0;
    const byModel = {};
    for (const day of Object.values(state.byModelByDay)) {
      for (const [id, v] of Object.entries(day)) {
        byModel[id] = (byModel[id] || 0) + (v.cost || 0);
        cost += v.cost || 0; tokens += v.tokens || 0;
      }
    }
    return { cost, tokens, byModel };
  }

  let timer = null;
  function start(intervalMs = 30000) {
    load();
    scan();
    timer = setInterval(scan, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow(); // always flush the latest aggregates on quit
  }

  return {
    start, stop, scan, getStats, priceInfo, reloadPricing, rebuild, totals, diagnostics,
    _state: state, _ingest: ingest,
  };
}

module.exports = {
  createMetering, DEFAULT_PRICING, normModelName, priceFor, loadPricing,
  normalizePriceRow, mergePriceRow, usageSnapshot, mergeUsage, usageDelta, usageCost,
};
