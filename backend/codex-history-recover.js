'use strict';

// Explicit, offline recovery. Never runs on import or guesses which backup a
// user wants to trust. The normal application must be closed to avoid writers
// from different versions racing on the same ledger.
const fs = require('fs');
const path = require('path');
const { createCodexMetering } = require('./codex-metering');
const { getPortCandidates, probe } = require('./transport');

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--from') {
    throw new Error('Usage: node backend/codex-history-recover.js --from <codex-usage.json backup>');
  }
  const source = path.resolve(args[1]);
  const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
  const live = await Promise.all(getPortCandidates().map(port => new Promise(resolve => probe(port, 500, resolve))));
  if (live.some(Boolean)) throw new Error('Exit AgentPaw before restoring its usage ledger.');
  const meter = createCodexMetering();
  const stats = await meter.restoreLifetime(snapshot, source);
  console.log(JSON.stringify({ source, lifetime: stats.lifetime, historyBase: meter._state.historyBase }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
