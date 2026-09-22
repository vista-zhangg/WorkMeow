'use strict';

const assert = require('assert');
const { createPetVisibilityController } = require('../backend/pet-visibility');

let checks = 0;
function check(name, fn) { fn(); checks++; console.log('  ✓', name); }
function setup(options = {}) {
  let clock = 1000;
  const changes = [];
  const controller = createPetVisibilityController({ now: () => clock, onChange: (state) => changes.push(state), ...options });
  return { controller, changes, advance: (ms) => { clock += ms; } };
}

check('fullscreen temporarily hides either presentation and restores on exit', () => {
  const { controller: c } = setup();
  assert.equal(c.snapshot().visible, true);
  assert.equal(c.setFullscreen(true).visible, false);
  assert.equal(c.setFullscreen(false).visible, true);
});

check('fullscreen exit and setting changes never undo manual hide', () => {
  const { controller: c } = setup();
  c.hide();
  c.setFullscreen(true);
  assert.equal(c.setFullscreen(false).visible, false);
  assert.equal(c.setAutoHideFullscreen(false).visible, false);
  assert.equal(c.snapshot().manualHidden, true);
});

check('quiet expires exactly at its deadline, not at the previous tick', () => {
  const { controller: c, advance, changes } = setup();
  c.snooze(15);
  advance(15 * 60000 - 1);
  assert.equal(c.tick().visible, false);
  advance(1);
  assert.equal(c.tick().visible, true);
  assert.equal(c.snapshot().quietUntil, 0);
  assert.equal(changes.length, 2);
});

check('expired quiet cannot show over fullscreen and fullscreen exit cannot end quiet', () => {
  const { controller: c, advance } = setup();
  c.snooze(30);
  c.setFullscreen(true);
  assert.equal(c.setFullscreen(false).visible, false);
  c.setFullscreen(true);
  advance(30 * 60000);
  assert.equal(c.tick().visible, false);
  assert.equal(c.snapshot().quietUntil, 0);
  assert.equal(c.setFullscreen(false).visible, true);
});

check('manual hide during quiet stays hidden after the deadline', () => {
  const { controller: c, advance } = setup();
  c.snooze(60);
  c.hide();
  advance(60 * 60000);
  assert.equal(c.tick().visible, false);
  assert.equal(c.snapshot().manualHidden, true);
  assert.equal(c.snapshot().quietUntil, 0);
});

check('explicit show clears manual/quiet and permits this fullscreen session only', () => {
  const { controller: c } = setup();
  c.hide();
  assert.equal(c.show().visible, true);
  c.snooze(30);
  c.setFullscreen(true);
  const shown = c.show();
  assert.equal(shown.visible, true);
  assert.equal(shown.quietUntil, 0);
  assert.equal(shown.manualHidden, false);
  assert.equal(shown.fullscreenOverride, true);
  assert.equal(c.setFullscreen(true).visible, true);
  assert.equal(c.setFullscreen(false).fullscreenOverride, false);
  assert.equal(c.setFullscreen(true).visible, false);
});

check('disabling automatic hide releases fullscreen without cancelling quiet', () => {
  const { controller: c } = setup();
  c.setFullscreen(true);
  assert.equal(c.setAutoHideFullscreen(false).visible, true);
  c.snooze(15);
  assert.equal(c.setAutoHideFullscreen(true).visible, false);
  assert.equal(c.setAutoHideFullscreen(false).visible, false);
});

check('quiet choices are bounded, replace the deadline, and explicitly replace manual hiding', () => {
  const { controller: c, advance } = setup();
  c.hide();
  assert.equal(c.snooze(30).manualHidden, false);
  const deadline = c.snapshot().quietUntil;
  advance(60000);
  for (const invalid of [-1, 0, Infinity, NaN, 1441, 2.5, 'later', '30', true, null, [], {}, Symbol('time')]) {
    assert.equal(c.snooze(invalid).quietUntil, deadline);
  }
  assert.equal(c.snooze(15).quietUntil, 1000 + 16 * 60000);
});

check('custom quiet duration accepts both limits and arbitrary integer minutes', () => {
  for (const duration of [1, 7, 45, 120, 1439, 1440]) {
    const { controller: c, advance } = setup();
    assert.equal(c.snooze(duration).quietUntil, 1000 + duration * 60000);
    advance(duration * 60000 - 1);
    assert.equal(c.tick().visible, false);
    advance(1);
    assert.equal(c.tick().visible, true);
  }
});

check('snapshots are detached and repeated ticks do not broadcast unchanged state', () => {
  const { controller: c, changes } = setup();
  c.snapshot().manualHidden = true;
  assert.equal(c.snapshot().visible, true);
  c.tick(); c.tick();
  assert.equal(changes.length, 0);
  c.hide(); c.hide(); c.tick();
  assert.equal(changes.length, 1);
});

console.log(`Pet visibility: ${checks} checks passed.`);
