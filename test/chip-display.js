'use strict';
const assert = require('assert');
const config = require('../backend/config');
const { loadRenderer } = require('./dom-stub');
assert.strictEqual(config.sanitize({}).showStatus, true);
assert.strictEqual(config.sanitize({}).showCat, true);
assert.strictEqual(config.sanitize({ showStatus: 'true' }).showStatus, true);
assert.strictEqual(config.sanitize({}).showQuota, true);
assert.strictEqual(config.sanitize({}).showTokens, false);
assert.strictEqual(config.sanitize({}).showCost, true);
assert.strictEqual(config.sanitize({ showTokens: true }).showTokens, true);
assert.strictEqual(config.sanitize({ showCost: 'true' }).showCost, true);
const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js', 'shared/pet-insights.js', 'renderer/pet.js']);
const stats = { today: { tokens: 1234, cost: 0.123 }, sessions: [], bg: {}, idleMs: 1000,
  codexQuota: { status: 'ready', windows: { fiveHour: { remainingPercent: 20, resetsAt: 1800000000 }, weekly: { remainingPercent: 5 } } } };
w.handlers.stats(stats);
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), false);
assert.strictEqual(w.elements('cat').getAttribute('aria-hidden'), 'false');
assert.strictEqual(w.elements('chip-tokens').hidden, true);
assert.strictEqual(w.elements('chip-cost').hidden, false);
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '20%');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.level, 'amber');
assert.strictEqual(w.elements('chip-quota').children[1].dataset.level, 'red');
assert.strictEqual(w.elements('chip-quota').children[1].textContent, '5%');
assert.strictEqual(w.elements('chip').title, '', 'the capsule must not use a native hover tooltip');
assert.strictEqual(w.elements('quota-popover').classList.contains('hidden'), true);
w.elements('chip-quota').dispatch('click');
assert.strictEqual(w.elements('quota-popover').classList.contains('hidden'), false);
assert.strictEqual(w.elements('quota-popover-rows').children.length, 2);
assert(w.elements('quota-popover-rows').children[0].children[1].children[1].textContent.includes('刷新'));
w.elements('chip-quota').dispatch('click');
assert.strictEqual(w.elements('quota-popover').classList.contains('hidden'), true);
w.handlers.stats({ ...stats, codexQuota: {
  status: 'ready',
  windows: { fiveHour: null, weekly: { remainingPercent: 80, usedPercent: 20, resetsAt: 1800000000 } },
  estimate: { tokens: 200000, cost: 1.25, usedPercent: 20, estimatedTotalTokens: 1000000, estimatedTotalCost: 6.25 },
} });
assert.strictEqual(w.elements('chip-quota').children.length, 1,
  'a Pro-style weekly-only quota must hide the empty 5h badge');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.period, '7d');
w.elements('chip-quota').dispatch('click');
assert.strictEqual(w.elements('quota-popover-rows').children.length, 1,
  'the weekly-only popover must hide the empty 5h row');
assert.strictEqual(w.elements('quota-popover-insight').hidden, false,
  'the quota popover must show the weekly usage estimate when available');
w.elements('chip-quota').dispatch('click');
const compactStats = { ...stats, sessions: [{ state: 'working', agent: 'codex', createdAt: 100 }],
  chipDisplay: { showCat: false, showStatus: true, showQuota: true, showTokens: false, showCost: false } };
w.handlers.stats(compactStats);
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), true);
assert.strictEqual(w.elements('cat').getAttribute('aria-hidden'), 'true');
assert.strictEqual(w.elements('chip-context').textContent.startsWith('⚙️'), true,
  'the working-state icon must remain inside the capsule');
w.window.innerWidth = 320;
w.elements('stage').getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 340 });
w.elements('chip').getBoundingClientRect = () => ({ left: 150, top: 300, width: 130, height: 21 });
w.elements('sessions').getBoundingClientRect = () => ({ left: 80, top: 275, width: 50, height: 21 });
w.handlers.event({ kind: 'operation', tool: 'Bash', icon: '⚙️', detail: '调用工具' });
assert.strictEqual(w.elements('prop').style.left, '45px',
  'the live tool icon must sit to the left of the first status dot');
w.elements('sessions').getBoundingClientRect = () => ({ left: 100, top: 275, width: 95, height: 21 });
w.handlers.stats({ ...compactStats, sessions: [
  { state: 'working', agent: 'codex', createdAt: 100 },
  { state: 'thinking', agent: 'claude', createdAt: 101 },
] });
assert.strictEqual(w.elements('prop').style.left, '65px',
  'the live tool icon must follow the first dot when parallel sessions change');
w.handlers.stats({ ...stats, chipDisplay: { showCat: true, showStatus: true, showQuota: true, showTokens: false, showCost: false } });
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), false);
w.handlers.stats({ ...stats, chipDisplay: { showStatus: false, showQuota: true, showTokens: false, showCost: false } });
assert.strictEqual(w.elements('chip-context').hidden, true);
assert.strictEqual(w.elements('chip-quota').hidden, false);
assert.strictEqual(w.elements('chip-tokens-sep').hidden, true);
w.handlers.stats({ ...stats, chipDisplay: { showStatus: false, showQuota: false, showTokens: false, showCost: true } });
assert.strictEqual(w.elements('chip-context').hidden, true);
assert.strictEqual(w.elements('chip-cost-sep').hidden, true);
assert.strictEqual(w.elements('chip-cost').hidden, false);
w.handlers.stats({ ...stats, codexQuota: { status: 'ready', windows: {
  fiveHour: { remainingPercent: 75, resetsAt: 1800003600 }, weekly: { remainingPercent: 60 },
} } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '75%');
assert.strictEqual(w.elements('chip-quota').children[1].textContent, '60%');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.level, 'normal');
w.handlers.stats({ ...stats, chipDisplay: { showQuota: false, showTokens: true, showCost: false } });
assert.strictEqual(w.elements('chip-quota').hidden, true);
assert.strictEqual(w.elements('chip-tokens').hidden, false);
assert.strictEqual(w.elements('chip-cost-sep').hidden, true);
assert(!w.elements('chip').title.includes('$'));
w.handlers.stats({ ...stats, codexQuota: { status: 'unavailable' } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '--');
console.log('chip display checks passed');
process.exit(0);
