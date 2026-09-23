'use strict';

const assert = require('assert');
const { loadRenderer } = require('./dom-stub');

const world = loadRenderer([
  'shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js',
  'shared/pet-insights.js', 'renderer/pet.js',
]);
const { document, handlers, calls } = world;
assert.equal(typeof handlers.pointerCheck, 'function');

const hit = { closest: (selector) => selector.includes('#cat') ? hit : null };
document.elementFromPoint = (x, y) => x === 25 && y === 30 ? hit : null;

handlers.pointerCheck({ x: 25, y: 30 });
assert.deepEqual(calls.at(-1), ['setIgnoreMouse', [false]], 'pet becomes interactive without a DOM mousemove');

handlers.pointerCheck({ x: -1, y: -1 });
assert.deepEqual(calls.at(-1), ['setIgnoreMouse', [true]], 'transparent area returns to click-through');

console.log('Pet pointer recovery: 2 checks passed.');
process.exit(0); // pet.js starts long-lived animation and refresh timers.
