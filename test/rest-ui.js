'use strict';

// Real pet + companion scripts, real reminder scheduler, and only DOM/Electron
// boundaries stubbed. Activity tests exercise the same state shape as main.js.
const assert = require('assert');
const vm = require('vm');
const { loadRenderer } = require('./dom-stub');
const { DEFAULTS } = require('../shared/rest-preferences');
const { createRestReminderController } = require('../backend/rest-reminders');

const MINUTE = 60_000;
const files = ['shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js', 'shared/agents.js',
  'shared/pet-insights.js', 'shared/pet-geometry.js', 'renderer/pet.js', 'renderer/companion.js'];
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
const baseStats = (overrides = {}) => ({
  today: { tokens: 0, cost: 0 }, sessions: [], actions: [], bg: {}, idleMs: 1000,
  waitingCount: 0, needsinputCount: 0, workingCount: 0, jugglingCount: 0,
  sweepingCount: 0, thinkingCount: 0, loafingCount: 0, errorCount: 0,
  ...overrides,
});
const visible = (world) => !world.elements('rest-reminder').classList.contains('hidden');
const json = (value) => JSON.parse(JSON.stringify(value));

async function fixture(overrides = {}) {
  const world = loadRenderer(files);
  // Stub does not parse HTML, so seed the actual initial markup class.
  world.elements('rest-reminder').classList.add('hidden');
  world.window.innerWidth = 520;
  world.window.innerHeight = 540;
  world.elements('rest-reminder').scrollHeight = 190;
  let now = new Date(2026, 8, 23, 9).getTime();
  let visibility = { visible: true, quietUntil: 0, autoHideFullscreen: true };
  let controller;
  const snapshot = () => ({ rest: controller.getState(), visibility: { ...visibility } });
  controller = createRestReminderController({
    now: () => now,
    preferences: { ...DEFAULTS, waterMinutes: 5, stretchMinutes: 5, ...overrides },
    onChange: () => world.handlers.companionState(snapshot()),
  });
  world.behavior.restAction = (payload) => ({ ...controller.act(payload), ...snapshot() });
  await pause();
  world.handlers.stats(baseStats());
  world.handlers.companionState(snapshot());
  return {
    world,
    controller,
    snapshot,
    advance(minutes) {
      for (let index = 0; index < minutes * 4; index++) {
        now += 15_000;
        controller.tick({ idleSeconds: 0 });
      }
    },
    setVisible(value) {
      visibility = { ...visibility, visible: value };
      world.handlers.companionState(snapshot());
    },
  };
}

async function main() {
  for (const showCat of [true, false]) {
    for (const working of [false, true]) {
      const test = await fixture();
      const w = test.world;
      w.handlers.stats(baseStats({
        chipDisplay: { showCat, showStatus: true, showQuota: true, showCost: false },
        workingCount: working ? 1 : 0,
        sessions: working ? [{ id: 'coding', state: 'working', agent: 'codex', createdAt: 100 }] : [],
      }));
      assert.strictEqual(visible(w), false);
      test.advance(5);
      assert.strictEqual(visible(w), true, `reminder must show for cat=${showCat}, working=${working}`);
      assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), !showCat);
      assert(w.elements('rest-title').textContent.includes('喝口水'));
      assert(w.elements('rest-title').textContent.includes('伸个懒腰'));
      const id = test.controller.getState().pending.id;
      test.advance(5);
      assert.strictEqual(test.controller.getState().pending.id, id, 'pending reminders stay deduplicated');
      w.handlers.event({ kind: 'operation', tool: 'Read', detail: 'Read code' });
      assert.strictEqual(visible(w), true, 'routine agent traffic must not replace the rest card');
      assert.strictEqual(w.elements('bubble').classList.contains('hidden'), true);
      await pause();
      const popupSizes = w.calls.filter((call) => call[0] === 'setPetSize' && call[1][3] === 'popup');
      assert(popupSizes.length > 0, 'card must expand the Electron window in both layouts');
    }
  }

  {
    const test = await fixture({ snoozeMinutes: 7 });
    const w = test.world;
    test.advance(5);
    assert.strictEqual(w.elements('rest-snooze').textContent, '7 分钟后');
    const firstId = test.controller.getState().pending.id;
    w.elements('rest-snooze').dispatch('click');
    await pause();
    assert.deepStrictEqual(json(w.calls.filter((call) => call[0] === 'restAction').at(-1)[1][0]), {
      id: firstId, action: 'snooze',
    });
    assert.strictEqual(visible(w), false);
    test.advance(6.75);
    assert.strictEqual(visible(w), false);
    test.advance(0.25);
    assert.strictEqual(visible(w), true);
    w.elements('rest-done').dispatch('click');
    await pause();
    assert.strictEqual(visible(w), false);
    test.advance(5);
    w.elements('rest-skip').dispatch('click');
    await pause();
    assert.strictEqual(visible(w), false);
    assert(test.controller.getState().skippedUntil > 0);
    test.advance(60);
    assert.strictEqual(visible(w), false, 'skip today must survive subsequent agent-independent ticks');
  }

  {
    const test = await fixture();
    const w = test.world;
    test.advance(5);
    const dueId = test.controller.getState().pending.id;
    const choice = { kind: 'perm', permId: 'permission-one', sessionId: 'code-one', project: 'demo',
      tool: 'Bash', command: 'npm test', options: [{ label: '允许', value: 'allow' }] };
    w.handlers.event({ kind: 'waiting', choice });
    assert.strictEqual(w.elements('ask').classList.contains('hidden'), false);
    assert.strictEqual(visible(w), false, 'a permission prompt has precedence over rest');
    w.handlers.companionState(test.snapshot());
    assert.strictEqual(visible(w), false, 'duplicate state must not reopen rest over permission');
    w.handlers.stats(baseStats());
    await pause();
    assert.strictEqual(w.elements('ask').classList.contains('hidden'), true);
    assert.strictEqual(visible(w), true, 'pending rest returns when permission is resolved');
    assert.strictEqual(test.controller.getState().pending.id, dueId);
    w.elements('chip-quota').dispatch('click');
    assert.strictEqual(visible(w), false, 'quota details and rest must not overlap');
    w.elements('chip-quota').dispatch('click');
    await pause();
    assert.strictEqual(visible(w), true);
  }

  for (const showCat of [true, false]) {
    const test = await fixture({ snoozeMinutes: 3 });
    const w = test.world;
    w.handlers.stats(baseStats({ chipDisplay: { showCat, showStatus: true, showQuota: true } }));
    test.advance(5);
    const choice = { kind: 'perm', permId: 'long-permission', sessionId: 'code-one', project: 'demo',
      tool: 'Bash', command: 'npm test', options: [{ label: '允许', value: 'allow' }] };
    w.handlers.event({ kind: 'waiting', choice });
    await pause();
    assert.strictEqual(visible(w), false);
    assert.strictEqual(w.elements('rest-pending').hidden, false,
      'an unanswered permission must keep a compact rest reminder visible in both layouts');
    assert(w.elements('rest-pending').textContent.includes('喝口水'));
    assert(w.elements('rest-pending').getAttribute('aria-label').includes('3 分钟'));
    test.setVisible(false);
    assert.strictEqual(w.elements('rest-pending').hidden, true, 'hidden app must also hide the compact reminder');
    test.setVisible(true);
    assert.strictEqual(w.elements('rest-pending').hidden, false);
    w.elements('rest-pending').dispatch('click');
    await pause();
    assert.strictEqual(w.elements('rest-pending').hidden, true);
    assert.strictEqual(w.elements('ask').classList.contains('hidden'), false,
      'snoozing through the capsule must preserve the open permission form');
    assert.strictEqual(w.calls.filter((call) => call[0] === 'decidePermission').length, 0);
    assert.strictEqual(w.calls.filter((call) => call[0] === 'restAction').at(-1)[1][0].action, 'snooze');
    test.advance(2.75);
    assert.strictEqual(w.elements('rest-pending').hidden, true);
    test.advance(0.25);
    assert.strictEqual(w.elements('rest-pending').hidden, false);
    assert.strictEqual(visible(w), false, 'snooze expiry must not replace a still-open permission');
    w.handlers.stats(baseStats());
    await pause();
    assert.strictEqual(visible(w), true);
    assert.strictEqual(w.elements('rest-pending').hidden, true, 'resolved permission promotes badge back to full card');
  }

  {
    const test = await fixture();
    const w = test.world;
    test.setVisible(false);
    test.advance(5);
    assert.strictEqual(visible(w), false, 'hidden pet must retain a silent pending reminder');
    const id = test.controller.getState().pending.id;
    test.setVisible(true);
    assert.strictEqual(visible(w), true);
    assert.strictEqual(test.controller.getState().pending.id, id);
    w.document.hidden = true;
    w.document.dispatch('visibilitychange');
    assert.strictEqual(visible(w), false, 'actual renderer visibility also suppresses the card');
    w.document.hidden = false;
    w.document.dispatch('visibilitychange');
    assert.strictEqual(visible(w), true);
    test.controller.setPreferences({ enabled: false });
    assert.strictEqual(visible(w), false, 'disabling rest clears an already visible card');
  }

  {
    const test = await fixture({ snoozeMinutes: 3 });
    const w = test.world;
    test.advance(5);
    let resolveAction;
    w.behavior.restAction = () => new Promise((resolve) => { resolveAction = resolve; });
    w.elements('rest-done').dispatch('click');
    w.elements('rest-snooze').dispatch('click');
    assert.strictEqual(w.calls.filter((call) => call[0] === 'restAction').length, 1, 'rapid clicks submit only once');
    assert.strictEqual(w.elements('rest-done').disabled, true);
    resolveAction({ ok: false, ...test.snapshot() });
    await pause();
    assert.strictEqual(w.elements('rest-done').disabled, false);
    assert(w.elements('rest-action-status').textContent.includes('没有保存成功'));
    w.behavior.restAction = (payload) => ({ ...test.controller.act(payload), ...test.snapshot() });
    let prevented = false;
    w.elements('rest-reminder').dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
    await pause();
    assert.strictEqual(prevented, true);
    assert.strictEqual(visible(w), false, 'Escape uses configured snooze, not an untracked dismiss');
    test.advance(3);
    assert.strictEqual(visible(w), true);
  }

  for (const showCat of [true, false]) {
    const test = await fixture();
    const w = test.world;
    w.handlers.stats(baseStats({ chipDisplay: { showCat, showStatus: true, showQuota: true } }));
    test.advance(5);
    await vm.runInContext('openRadial()', w.sandbox);
    assert.strictEqual(visible(w), false, 'context menu temporarily defers the reminder');
    w.elements('radial').dispatch('click');
    await pause();
    assert.strictEqual(visible(w), true, 'closing context menu restores reminder without a stats tick');

    w.window.screenX = 0;
    w.window.screenY = 0;
    const handle = w.elements(showCat ? 'cat' : 'chip');
    const pointer = { button: 0, pointerId: 1, screenX: 10, screenY: 10, clientX: 10, clientY: 10 };
    handle.dispatch('pointerdown', pointer);
    assert.strictEqual(visible(w), false, 'drag start clears the overlay before window movement');
    handle.dispatch('pointermove', { ...pointer, screenX: 30 });
    handle.dispatch('pointerup', { ...pointer, screenX: 30 });
    // Release -> settle -> restore -> measure spans several animation frames.
    for (let frame = 0; frame < 4; frame++) await pause();
    assert.strictEqual(visible(w), true, 'drag completion immediately restores pending reminder');
    assert.strictEqual(w.calls.filter((call) => call[0] === 'setPetSize').at(-1)[1][3], 'popup',
      'drag settlement must refit the restored card instead of leaving a resting-size window: '
        + JSON.stringify(w.calls.filter((call) => call[0] === 'setPetSize').slice(-8)));
    handle.dispatch('pointerdown', { ...pointer, pointerId: 2 });
    handle.dispatch('pointercancel', { ...pointer, pointerId: 2 });
    await pause();
    assert.strictEqual(visible(w), true, 'cancelled pointer capture must restore the reminder without movement');

    // Use the real menu entry/action; native Menu rendering is the main-process boundary.
    vm.runInContext('MENU.find(item => item.labelKey === "menu.collapse").act()', w.sandbox);
    assert.strictEqual(w.calls.filter((call) => call[0] === 'openHideMenu').length, 1,
      'both cat and capsule menus expose the same hide/quiet menu');
  }

  {
    const test = await fixture();
    const w = test.world;
    test.advance(5);
    vm.runInContext('showBubble("重要操作失败，请重试", 80, true)', w.sandbox);
    w.window.WorkMeowCompanion.refresh();
    assert.strictEqual(visible(w), false, 'forced error bubble gets its complete display interval');
    assert.strictEqual(w.elements('bubble').classList.contains('hidden'), false);
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.strictEqual(visible(w), true, 'reminder returns after critical feedback without new stats');
  }

  {
    const test = await fixture();
    const w = test.world;
    vm.runInContext('showBubble("操作失败一", 160, true)', w.sandbox);
    test.advance(5);
    assert.strictEqual(visible(w), false, 'a newly due reminder must respect an already visible forced bubble');
    await new Promise((resolve) => setTimeout(resolve, 100));
    vm.runInContext('showBubble("操作失败二", 160, true)', w.sandbox);
    await new Promise((resolve) => setTimeout(resolve, 90));
    w.window.WorkMeowCompanion.refresh();
    assert.strictEqual(visible(w), false, 'another forced bubble extends the existing deferral');
    assert.strictEqual(w.elements('bubble-text').textContent, '操作失败二');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.strictEqual(visible(w), true);
  }

  console.log('rest reminder UI integration checks passed');
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
