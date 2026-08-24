'use strict';

// Guard the cleanup boundary: these checks intentionally target only code that
// was proven to have no runtime consumer. They make future additions explicit
// instead of silently growing another compatibility/dead-code chain.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PetAssets = require('../shared/pet-assets');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const runtimeFiles = [
  'main.js', 'preload.js', 'backend/server.js', 'backend/permission.js',
  'renderer/pet.js', 'renderer/panel.js', 'renderer/pet.html', 'renderer/panel.html',
];
const runtime = runtimeFiles.map(read).join('\n');

assert(!/uiBusy|petVisualBounds|shouldDropForDnd|dropAllForDnd|hasPendingForSession/.test(runtime),
  'removed UI/DND compatibility chain must not return');
assert(!/renderTodos|todo-block|tp-todo-sec|curTodos|todosProject|todo\.progress|panel\.todoBlock/.test(runtime),
  'generic TODO data/UI path must remain removed');
assert(!/todopop|todoPopOpen|renderTodoPop|openTodoPop|closeTodoPop|\btp-/.test(runtime),
  'the action center must not regress to the retired generic TODO naming');
assert(/action\.title/.test(read('renderer/pet.html')) && /action\.needYou/.test(read('renderer/pet.html')),
  'the live action center must keep its explicit contract');
assert(!/DEBUG_STATE|DEBUG_CONFETTI/.test(read('renderer/pet.js')), 'renderer debug switches must stay out of production code');

const assetDir = path.join(root, 'assets', 'cat');
const gifNames = fs.readdirSync(assetDir).filter((name) => name.endsWith('.gif')).sort();
const referenced = new Set(PetAssets.SLOTS.flatMap((slot) => slot.defaultFiles));
const intentionallyUnwired = [];
const unwired = gifNames.filter((name) => !referenced.has(name));
assert.deepStrictEqual(unwired, intentionallyUnwired,
  `unexpected unreferenced cat assets: ${unwired.join(', ')}`);

console.log('deadcode checks passed');
