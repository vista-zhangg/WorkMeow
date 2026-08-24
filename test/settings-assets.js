'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('renderer/settings.html');
const js = read('renderer/settings.js');
const css = read('renderer/settings.css');
const main = read('main.js');
const preload = read('preload.js');

for (const id of ['tab-expressions', 'asset-gallery', 'asset-inspector', 'asset-add', 'asset-replace',
  'asset-reset', 'asset-variants', 'remove-bg-toggle']) {
  assert(html.includes(`id="${id}"`), `settings must expose ${id}`);
}
assert(/img-src 'self' data: workmeow-asset:/.test(html), 'settings CSP must allow only the controlled custom asset scheme');
assert(html.includes('../shared/pet-assets.js'), 'settings must use the shared visual slot registry');
assert(/importPetGif\(selectedSlotId, mode/.test(js), 'the selected slot must drive imports');
assert(/importExpression\('append'\)/.test(js), 'adding a GIF must preserve the current playlist');
assert(/importExpression\('replace'\)/.test(js), 'replacing a state must be an explicit separate action');
assert(/removePetAsset/.test(js) && /resetPetSlot/.test(js), 'custom entries must be removable and resettable');
assert(/window\.confirm/.test(js), 'destructive playlist operations must require confirmation');
assert(/checkerboard/.test(css) && /asset-grid/.test(css), 'the gallery must make transparency and every state visually reviewable');
assert(/e\.sender !== settingsWin\.webContents/.test(main), 'mutating asset IPC must reject non-settings renderers');
assert(/filters: \[\{ name: 'GIF 动画', extensions: \['gif'\]/.test(main), 'native picker must be restricted to GIF files');
assert(/PET_ASSETS: 'pet-assets:changed'/.test(preload), 'live asset changes must be exposed to renderers');

console.log('settings asset interaction contract checks passed');
