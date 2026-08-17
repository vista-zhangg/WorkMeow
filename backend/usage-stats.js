'use strict';

// Normalize the slightly different token semantics exposed by each provider
// before the main process combines them. Claude and opencode report cache
// reads/writes as separate categories; Codex, WorkBuddy and TRAE expose an
// OpenAI-style input total that already contains those cache subsets.

const { SOURCE_IDS: SOURCES } = require('./source-registry');

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    inputTotal: 0,
    tokens: 0,
    cost: 0,
    messages: 0,
    msgs: 0,
    cacheRead: 0,
    cachedInput: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: 0,
    cacheCreate: 0,
    reasoningOutput: 0,
  };
}

function firstNumber(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) return num(value);
  }
  return 0;
}

function normalizeSourceRow(source, row = {}) {
  const input = num(row.input);
  const output = num(row.output);
  const isSeparateCache = source === 'claude' || source === 'opencode';
  const cacheRead = source === 'claude'
    ? num(row.cacheRead)
    : firstNumber(row.cacheRead, row.cachedInput);
  const cacheWrite5m = source === 'claude'
    ? firstNumber(row.cacheWrite5m, row.cacheWrite)
    : firstNumber(row.cacheWrite5m, row.cacheWrite);
  const cacheWrite1h = source === 'claude' ? num(row.cacheWrite1h) : 0;
  // Older persisted Claude ledgers exposed only cacheCreate. Preserve that
  // history when the split 5m/1h fields are absent.
  const cacheCreate = cacheWrite5m + cacheWrite1h || num(row.cacheCreate);
  const inputTotal = Number.isFinite(Number(row.inputTotal))
    ? num(row.inputTotal)
    : input + (isSeparateCache ? cacheRead + cacheCreate : 0);
  const tokens = num(row.tokens) || inputTotal + output;
  const messages = firstNumber(row.messages, row.msgs);

  return {
    input,
    output,
    inputTotal,
    tokens,
    cost: num(row.cost),
    messages,
    msgs: messages,
    cacheRead,
    cachedInput: source === 'claude' ? 0 : cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    cacheWrite: source === 'claude' ? 0 : cacheWrite5m,
    cacheCreate,
    reasoningOutput: num(row.reasoningOutput),
  };
}

function addRow(target, source, row) {
  const normalized = normalizeSourceRow(source, row);
  for (const key of [
    'input', 'output', 'inputTotal', 'tokens', 'cost', 'messages', 'msgs',
    'cacheRead', 'cachedInput', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite',
    'cacheCreate', 'reasoningOutput',
  ]) {
    target[key] = num(target[key]) + num(normalized[key]);
  }
  return target;
}

function mergeUsageRows(rows) {
  const out = emptyUsage();
  for (const [source, row] of rows) addRow(out, source, row || {});
  // Keep both names available because the renderer and older pet consumers
  // use different names for message count.
  out.messages = out.msgs;
  return out;
}

function mergeDaily(sources) {
  const daily = {};
  for (const [source, meter] of sources) {
    for (const [day, row] of Object.entries((meter && meter.daily) || {})) {
      const target = daily[day] || (daily[day] = emptyUsage());
      addRow(target, source, row);
      target.messages = target.msgs;
    }
  }
  return daily;
}

module.exports = {
  SOURCES,
  emptyUsage,
  normalizeSourceRow,
  mergeUsageRows,
  mergeDaily,
};
