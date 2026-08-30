'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const TESTS = Object.freeze([
  'smoke.js',
  'state-smoke.js',
  'pricing.js',
  'pricing-sync.js',
  'metering-common.js',
  'metering.js',
  'codex-metering.js',
  'workbuddy-metering.js',
  'trae-metering.js',
  'opencode-metering.js',
  'usage-stats.js',
  'source-registry.js',
  'integration-health.js',
  'workmeow-migration.js',
  'config-external-write.js',
  'portable-runtime.js',
  'integration-detection.js',
  'ipc-contract.js',
  'auto-launch.js',
  'updater.js',
  'xiaban-schedule.js',
  'pet-assets.js',
  'settings-assets.js',
  'focus.js',
  'deadcode.js',
  'codex-watch.js',
  'codex-integration.js',
  'i18n.js',
  'pet-geometry.js',
  'pet-insights.js',
  'popup-style.js',
  'branding.js',
  'opencode-plugin.js',
  'notify-policy.js',
]);

function runAll() {
  for (const file of TESTS) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
  console.log(`\nWorkMeow: ${TESTS.length} test suites passed`);
}

if (require.main === module) runAll();

module.exports = { TESTS, runAll };
