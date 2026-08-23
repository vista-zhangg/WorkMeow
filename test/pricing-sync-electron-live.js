'use strict';

// Manual Windows integration check. It deliberately uses Electron's default
// session so the request follows the same system proxy/PAC path as WorkMeow.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, session } = require('electron');
const { createPricingSync } = require('../backend/pricing-sync');

const URL = 'https://models.dev/api.json';

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-electron-pricing-'));
  const cachePath = path.join(dir, 'pricing-cache.json');
  const sync = createPricingSync({ cachePath, refreshMs: 86400000 });
  try {
    const proxy = await session.defaultSession.resolveProxy(URL);
    const result = await sync.refresh();
    if (!result.ok) throw new Error(result.error || 'pricing refresh failed');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const count = ['models', 'openaiModels', 'otherModels']
      .reduce((sum, key) => sum + Object.keys(cache[key] || {}).length, 0);
    console.log(JSON.stringify({ ok: true, proxy, source: cache.source, count, ts: cache.ts }));
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    sync.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    app.quit();
  }
});
