'use strict';

const assert = require('assert');
const vm = require('vm');
const { loadRenderer } = require('./dom-stub');

async function main() {
  const world = loadRenderer([
    'shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js',
    'shared/pet-insights.js', 'shared/pet-geometry.js', 'renderer/pet.js',
  ]);
  const { window, elements, sandbox } = world;
  const radial = elements('radial');
  let petLeft = 200;
  elements('stage').getBoundingClientRect = () => ({ left: 0, top: 0, width: window.innerWidth, height: 340 });
  elements('cat').getBoundingClientRect = () => ({ left: petLeft, top: 155, width: 120, height: 120 });
  window.innerWidth = 320;
  window.innerHeight = 340;
  window.screenX = 1000;
  window.screenY = 560;
  window.screen = { availLeft: 0, availTop: 0, availWidth: 1320, availHeight: 900 };
  const metrics = (x, width) => ({
    window: { x, y: 560, width, height: 340 },
    workArea: { x: 0, y: 0, width: 1320, height: 900 },
  });
  const centers = () => radial.children.map((item) => ({ x: parseFloat(item.style.left), y: parseFloat(item.style.top) }));
  const assertInside = () => {
    assert.equal(radial.children.length, 3);
    for (const point of centers()) {
      assert(point.x >= 31 && point.x <= 289, 'menu button must fit the current 320px viewport');
      assert(point.y >= 31 && point.y <= 309, 'menu button must fit vertically');
    }
  };

  vm.runInContext("setStageEdgeLayout({ vertical: 'above', horizontal: 'left' })", sandbox);
  sandbox.__metrics = metrics(800, 520); // Bounds left over from an expanded popup.
  vm.runInContext('buildRadial(__metrics)', sandbox);
  assert.equal(radial.dataset.direction, 'top-left');
  assertInside();

  window.innerWidth = 520;
  window.screenX = 800;
  petLeft = 360;
  sandbox.__metrics = metrics(800, 520);
  vm.runInContext('buildRadial(__metrics); radialOpen = true', sandbox);
  radial.classList.remove('hidden');
  assert(centers().some((point) => point.x > 289));

  window.innerWidth = 320;
  window.screenX = 1000;
  petLeft = 200;
  window.pet.getWindowMetrics = () => Promise.resolve(metrics(1000, 320));
  window.dispatch('resize');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(radial.dataset.direction, 'top-left');
  assertInside();

  console.log('Radial menu bounds and resize checks passed.');
  process.exit(0); // pet.js keeps animation and refresh timers alive.
}

main().catch((error) => { console.error(error); process.exit(1); });
