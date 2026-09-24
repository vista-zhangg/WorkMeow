'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DEFAULTS, sanitizePreferences } = require('../shared/rest-preferences');
const { createRestReminderController, SNOOZE_MS } = require('../backend/rest-reminders');

const MINUTE = 60_000;
const START = new Date(2026, 8, 23, 9).getTime();
function fixture(preferences = {}, runtime, start = START) {
  let time = start;
  const changes = [];
  const controller = createRestReminderController({
    now: () => time,
    preferences: { ...DEFAULTS, ...preferences },
    runtime,
    onChange: (state) => changes.push(state),
  });
  return {
    controller,
    changes,
    now: () => time,
    jump: (milliseconds, input) => { time += milliseconds; return controller.tick(input); },
    advance: (minutes, input) => {
      const ticks = minutes * 4;
      for (let index = 0; index < ticks; index++) { time += 15_000; controller.tick(input); }
      return controller.getState();
    },
  };
}

assert.deepStrictEqual(sanitizePreferences(null), DEFAULTS);
assert.deepStrictEqual(sanitizePreferences([]), DEFAULTS);
assert.deepStrictEqual(sanitizePreferences({ enabled: 'false', waterMinutes: '', stretchMinutes: Infinity }), DEFAULTS);
assert.strictEqual(sanitizePreferences({ waterMinutes: 0 }).waterMinutes, 5);
assert.strictEqual(sanitizePreferences({ stretchMinutes: 500 }).stretchMinutes, 240);
assert.strictEqual(sanitizePreferences({ eyesMinutes: '25.6' }).eyesMinutes, 26);
assert.strictEqual(sanitizePreferences({ snoozeMinutes: 0 }).snoozeMinutes, 1);
assert.strictEqual(sanitizePreferences({ snoozeMinutes: 999 }).snoozeMinutes, 240);
const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shared/rest-preferences.js'), 'utf8'), browser);
assert.strictEqual(browser.window.AgentPawRestPreferences.DEFAULTS.waterMinutes, 45);

// Ordinary computer work triggers reminders even with zero AI sessions. There
// is no agent-state input that can prevent or manufacture active computer time.
{
  const test = fixture();
  assert.strictEqual(test.advance(44.75).pending, null);
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['water']);
  const first = test.controller.getState().pending;
  assert.strictEqual(test.changes.length, 1, 'normal clock ticks must not produce broadcasts or writes');
  test.advance(14.75);
  assert.strictEqual(test.changes.length, 1, 'a pending reminder must not repeatedly pop up');
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['water', 'stretch']);
  assert.strictEqual(test.controller.getState().pending.id, first.id, 'newly due kinds merge into the same card');
  assert.strictEqual(test.controller.act({ id: 'old', action: 'done' }).ok, false);
  assert.strictEqual(test.controller.act({ id: first.id, action: 'unrecognized' }).ok, false);
  assert.strictEqual(test.controller.act({ id: first.id, action: 'done' }).ok, true);
  assert.strictEqual(test.advance(44.75).pending, null);
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['water']);
}

{
  const test = fixture({ waterMinutes: 5, stretchMinutes: 5, eyesEnabled: true, eyesMinutes: 5 });
  assert.deepStrictEqual(test.advance(5).pending.kinds, ['water', 'stretch', 'eyes']);
  const snapshot = test.controller.getState();
  snapshot.pending.kinds.pop();
  snapshot.preferences.enabled = false;
  assert.deepStrictEqual(test.controller.getState().pending.kinds, ['water', 'stretch', 'eyes']);
  assert.strictEqual(test.controller.getState().preferences.enabled, true, 'state cannot mutate the controller');
}

// A five-minute absence satisfies stretch/eyes but not the drink reminder.
{
  const test = fixture({ waterMinutes: 10, stretchMinutes: 10, eyesEnabled: true, eyesMinutes: 10 });
  test.advance(9);
  test.advance(10, { idleSeconds: 600, agentState: 'working' });
  assert.strictEqual(test.controller.getState().pending, null);
  test.jump(15_000, { idleSeconds: 0 });
  assert.deepStrictEqual(test.advance(1).pending.kinds, ['water']);
  test.controller.act({ id: test.controller.getState().pending.id, action: 'done' });
  assert.deepStrictEqual(test.advance(9).pending.kinds, ['stretch', 'eyes']);
  assert.strictEqual(test.jump(15_000, { idleSeconds: 300 }).pending, null);
}

// Reading and short breaks remain part of continuous use.
{
  const test = fixture({ waterMinutes: 5, stretchEnabled: false });
  assert.deepStrictEqual(test.advance(5, { idleSeconds: 120 }).pending.kinds, ['water']);
}

// Quiet/fullscreen is handled by presentation, so ticks continue to accumulate.
{
  const test = fixture({ waterMinutes: 5, stretchEnabled: false });
  assert.deepStrictEqual(test.advance(5, { quiet: true, fullscreen: true }).pending.kinds, ['water']);
  const paused = fixture({ waterMinutes: 5, stretchMinutes: 5 });
  paused.advance(4);
  paused.advance(10, { paused: true });
  paused.jump(15_000, { paused: false });
  assert.deepStrictEqual(paused.advance(1).pending.kinds, ['water']);
}

{
  const test = fixture({ waterMinutes: 5, stretchMinutes: 10 });
  const due = test.advance(5).pending;
  assert.strictEqual(test.controller.act({ id: due.id, action: 'snooze' }).ok, true);
  assert.strictEqual(test.controller.getState().snoozedUntil, test.now() + SNOOZE_MS);
  assert.strictEqual(test.advance(9.75).pending, null, 'later kinds must respect the full-card snooze');
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['water', 'stretch']);
  assert.notStrictEqual(test.controller.getState().pending.id, due.id);
}

{
  const test = fixture({ waterMinutes: 5, stretchEnabled: false, snoozeMinutes: 2 });
  const due = test.advance(5).pending;
  test.controller.act({ id: due.id, action: 'snooze' });
  assert.strictEqual(test.controller.getState().snoozedUntil, test.now() + 2 * MINUTE);
  assert.strictEqual(test.advance(1.75).pending, null);
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['water']);
  test.controller.setPreferences({ snoozeMinutes: 3 });
  test.controller.act({ id: test.controller.getState().pending.id, action: 'snooze' });
  assert.strictEqual(test.controller.getState().snoozedUntil, test.now() + 3 * MINUTE);
}

// Explicit future snoozes and same-day skip choices survive restart, no use time.
{
  const test = fixture({ waterMinutes: 5, stretchEnabled: false });
  const due = test.advance(5).pending;
  test.controller.act({ id: due.id, action: 'snooze' });
  const restored = fixture({ waterMinutes: 5, stretchEnabled: false }, test.controller.serialize(), test.now());
  assert.strictEqual(restored.advance(9.75).pending, null);
  assert.deepStrictEqual(restored.advance(0.25).pending.kinds, ['water']);
  restored.controller.act({ id: restored.controller.getState().pending.id, action: 'skip-today' });
  const saved = restored.controller.serialize();
  const skipped = fixture({ waterMinutes: 5 }, saved, restored.now());
  assert.strictEqual(skipped.advance(60).pending, null);
  const tomorrow = new Date(2026, 8, 24, 0).getTime();
  skipped.jump(tomorrow - skipped.now());
  assert.strictEqual(skipped.controller.getState().skippedUntil, 0);
  assert.strictEqual(skipped.controller.getState().pending, null);
  assert.deepStrictEqual(skipped.advance(5).pending.kinds, ['water']);
  const stale = fixture({ waterMinutes: 5 }, saved, tomorrow);
  assert.strictEqual(stale.controller.getState().skippedUntil, 0);
  assert.deepStrictEqual(stale.advance(5).pending.kinds, ['water']);
}

{
  const beforeMidnight = new Date(2026, 8, 23, 23, 54).getTime();
  const test = fixture({ waterMinutes: 5, stretchMinutes: 5 }, null, beforeMidnight);
  const due = test.advance(5).pending;
  test.controller.act({ id: due.id, action: 'snooze' });
  const saved = test.controller.serialize();
  assert.strictEqual(test.advance(9.75).pending, null, 'a snooze keeps its exact duration across midnight');
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['water', 'stretch']);
  const afterMidnight = new Date(2026, 8, 24, 0, 2).getTime();
  const restored = fixture({ waterMinutes: 5, stretchMinutes: 5 }, saved, afterMidnight);
  assert.strictEqual(restored.advance(6.75).pending, null);
  assert.deepStrictEqual(restored.advance(0.25).pending.kinds, ['water', 'stretch'],
    'restarting after midnight preserves a still-future explicit snooze');
}

{
  const test = fixture({ waterMinutes: 5, stretchEnabled: false });
  const due = test.advance(5).pending;
  test.controller.act({ id: due.id, action: 'skip-today' });
  test.controller.setPreferences({ waterMinutes: 10 });
  assert(test.controller.getState().skippedUntil > 0, 'ordinary preference changes preserve today-skip');
  test.controller.setPreferences({ enabled: false });
  test.controller.setPreferences({ enabled: true });
  assert.strictEqual(test.controller.getState().skippedUntil, 0, 'explicit re-enable resumes reminders today');
  assert.deepStrictEqual(test.advance(10).pending.kinds, ['water']);
}

{
  const test = fixture({ waterMinutes: 5, stretchMinutes: 5, eyesEnabled: true, eyesMinutes: 5 });
  const due = test.advance(5).pending;
  test.controller.act({ id: due.id, action: 'snooze' });
  const beforeIdle = test.changes.length;
  test.advance(11, { idleSeconds: 600 });
  assert.strictEqual(test.controller.getState().pending, null, 'expired snooze must not notify an absent user');
  assert.deepStrictEqual(test.controller.serialize().snoozedKinds, ['water']);
  assert.strictEqual(test.changes.length, beforeIdle + 1, 'satisfied snooze kinds must be persisted once');
  assert.deepStrictEqual(test.jump(15_000, { idleSeconds: 0 }).pending.kinds, ['water']);
}

{
  const test = fixture({ waterMinutes: 5, stretchMinutes: 5 });
  test.advance(4);
  test.advance(1, { paused: true });
  test.jump(15_000, { paused: false });
  assert.deepStrictEqual(test.advance(1).pending.kinds, ['water', 'stretch'], 'a brief lock must not erase continuous use');
  test.controller.setPreferences({ waterMinutes: 10 });
  assert.deepStrictEqual(test.controller.getState().pending.kinds, ['stretch']);
  test.controller.act({ id: test.controller.getState().pending.id, action: 'done' });
  assert.strictEqual(test.advance(4.75).pending, null);
}

{
  const nextMidnight = new Date(2026, 8, 24, 0).getTime();
  const malformed = fixture({}, {
    version: 1,
    day: '2026-9-23',
    skippedUntil: START + 365 * 24 * 60 * MINUTE,
    snoozedUntil: START + 365 * 24 * 60 * MINUTE,
    snoozedKinds: ['water', 'script'],
  });
  assert.strictEqual(malformed.controller.getState().skippedUntil, nextMidnight);
  assert.strictEqual(malformed.controller.getState().snoozedUntil, 0);
  const boundedSnooze = fixture({}, {
    version: 1, day: '2026-9-23', snoozedUntil: START + 365 * 24 * 60 * MINUTE,
    snoozedKinds: ['water', 'script', 'eyes'],
  });
  assert.strictEqual(boundedSnooze.controller.getState().snoozedUntil, START + 240 * MINUTE);
  assert.deepStrictEqual(boundedSnooze.controller.serialize().snoozedKinds, ['water']);
}

{
  const test = fixture({ waterMinutes: 5, stretchMinutes: 5, eyesEnabled: true, eyesMinutes: 5 });
  test.advance(5);
  test.controller.setPreferences({ waterEnabled: false });
  assert.deepStrictEqual(test.controller.getState().pending.kinds, ['stretch', 'eyes']);
  test.controller.setPreferences({ enabled: false });
  assert.strictEqual(test.controller.getState().pending, null);
  assert.strictEqual(test.advance(60).pending, null);
  test.controller.setPreferences({ enabled: true });
  assert.strictEqual(test.advance(4.75).pending, null);
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['stretch', 'eyes']);
}

{
  const test = fixture({ waterMinutes: 5, stretchMinutes: 5 });
  test.advance(4);
  assert.strictEqual(test.jump(8 * 60 * MINUTE).pending, null, 'sleep elapsed time must never be credited');
  assert.deepStrictEqual(test.advance(1).pending.kinds, ['water']);
  test.jump(-30 * MINUTE);
  assert.strictEqual(test.controller.getState().pending, null);
  assert.strictEqual(test.advance(4.75).pending, null);
  assert.deepStrictEqual(test.advance(0.25).pending.kinds, ['water', 'stretch']);
  const overnight = fixture({ waterMinutes: 5, stretchMinutes: 5 });
  overnight.advance(4);
  assert.strictEqual(overnight.jump(24 * 60 * MINUTE).pending, null);
  assert.strictEqual(overnight.advance(4.75).pending, null);
  assert.deepStrictEqual(overnight.advance(0.25).pending.kinds, ['water', 'stretch']);
}

console.log('rest reminder scheduler checks passed');
