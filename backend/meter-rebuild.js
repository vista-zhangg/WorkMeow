'use strict';

// Recompute every usage history with the current models.dev-backed price table.
// This is an explicit CLI utility; importing the module must never scan files,
// access the network, or rewrite the user's usage ledger.

const fs = require('fs');
const path = require('path');
const { createMetering } = require('./metering');
const { createCodexMetering } = require('./codex-metering');
const { createWorkbuddyMetering } = require('./workbuddy-metering');
const { createTraeMetering } = require('./trae-metering');
const { createOpenCodeMetering } = require('./opencode-metering');
const { createPricingSync } = require('./pricing-sync');
const { SOURCE_REGISTRY } = require('./source-registry');
const { STATE_DIR, migrateLegacyState } = require('./paths');
const env = require('./env');

const STATE_FILES = {
  claude: 'usage.json',
  codex: 'codex-usage.json',
  workbuddy: 'workbuddy-usage.json',
  trae: 'trae-usage.json',
  opencode: 'opencode-usage.json',
};
const FACTORIES = {
  claude: () => createMetering(),
  codex: () => createCodexMetering(),
  workbuddy: () => createWorkbuddyMetering(),
  trae: () => createTraeMetering(),
  opencode: () => createOpenCodeMetering(),
};
const SOURCES = SOURCE_REGISTRY.map(({ id, label }) => {
  if (!STATE_FILES[id] || typeof FACTORIES[id] !== 'function') {
    throw new Error(`Meter rebuild source is not configured: ${id}`);
  }
  return {
    id,
    name: label,
    statePath: path.join(STATE_DIR, STATE_FILES[id]),
    create: FACTORIES[id],
  };
});

function oldTotals(statePath = SOURCES[0].statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    let cost = 0;
    let tokens = 0;
    const byModel = {};
    for (const day of Object.values(state.byModelByDay || {})) {
      for (const [id, value] of Object.entries(day)) {
        byModel[id] = (byModel[id] || 0) + (value.cost || 0);
        cost += value.cost || 0;
        tokens += value.tokens || 0;
      }
    }
    return { cost, tokens, byModel };
  } catch {
    return { cost: 0, tokens: 0, byModel: {} };
  }
}

function currentTotals(meter) {
  const byModel = {};
  let cost = 0;
  let tokens = 0;
  for (const day of Object.values((meter && meter._state && meter._state.byModelByDay) || {})) {
    for (const [id, value] of Object.entries(day)) {
      byModel[id] = (byModel[id] || 0) + (Number(value.cost) || 0);
      cost += Number(value.cost) || 0;
      tokens += Number(value.tokens) || 0;
    }
  }
  return { cost, tokens, byModel };
}

async function main() {
  migrateLegacyState();
  const sync = !process.argv.includes('--no-sync') && !env.flag('NO_NET');
  if (sync) {
    process.stdout.write('1) Sync latest models.dev pricing... ');
    try {
      const pricingSync = createPricingSync();
      let result;
      try {
        result = await pricingSync.refresh();
      } finally {
        pricingSync.stop();
      }
      if (result && result.ok) console.log('ok');
      else console.log(`skipped (${result && result.error || 'unknown error'}); using existing cache / built-in prices`);
    } catch (error) {
      console.log(`skipped (${error.message}); using existing cache / built-in prices`);
    }
  } else {
    console.log('1) Skip pricing sync (using existing cache / built-in prices)');
  }

  console.log('2) Rescan all provider transcripts/logs and rebuild history...');
  const results = [];
  for (const source of SOURCES) {
    const before = oldTotals(source.statePath);
    const meter = source.create();
    await meter.rebuild();
    const after = currentTotals(meter);
    results.push({ source, before, after });
    const delta = after.cost - before.cost;
    console.log(`  ${source.name.padEnd(9)} $${before.cost.toFixed(2)} → $${after.cost.toFixed(2)}  `
      + `(${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}) · ${after.tokens.toLocaleString()} tokens`);
  }

  const beforeCost = results.reduce((sum, row) => sum + row.before.cost, 0);
  const afterCost = results.reduce((sum, row) => sum + row.after.cost, 0);
  const delta = afterCost - beforeCost;
  console.log(`\nTotal  $${beforeCost.toFixed(2)} → $${afterCost.toFixed(2)}  (${delta >= 0 ? '+' : ''}$${delta.toFixed(2)})`);
  console.log('已重算 ~/.workmeow/ 下的 Claude、Codex、WorkBuddy、TRAE、opencode 台账。重开打工喵详情面板即可看到新统计。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('meter rebuild failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { main, oldTotals, currentTotals, SOURCES };
