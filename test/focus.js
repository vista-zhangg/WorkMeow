'use strict';

const assert = require('assert');
const { codexThreadUrl, focusSession } = require('../backend/focus');
const adapter = require('../backend/adapter');

async function run() {
  assert.strictEqual(
    codexThreadUrl({ id: '019fe5c2-6cb3-7713-8feb-846d1882fcb6', agentId: 'codex' }),
    'codex://threads/019fe5c2-6cb3-7713-8feb-846d1882fcb6',
    'Codex sessions should map to their exact Desktop thread deep link',
  );
  assert.strictEqual(codexThreadUrl({ id: 'bad/path', agentId: 'codex' }), null);
  assert.strictEqual(codexThreadUrl({ id: 'abc', agentId: 'claude-code' }), null);

  const opened = [];
  const codexResult = await focusSession(
    { id: 'thread-123', agentId: 'codex', sourcePid: null },
    {
      openExternal: async (url) => opened.push(url),
      activatePids: async () => { throw new Error('PID fallback should not run'); },
    },
  );
  assert.strictEqual(codexResult, true);
  assert.deepStrictEqual(opened, ['codex://threads/thread-123']);

  let fallbackPids = null;
  const fallbackResult = await focusSession(
    { id: 'thread-456', agentId: 'codex', sourcePid: 42, pidChain: [42, 84] },
    {
      openExternal: async () => { throw new Error('protocol unavailable'); },
      activatePids: async (pids) => { fallbackPids = pids; return 84; },
    },
  );
  assert.strictEqual(fallbackResult, true);
  assert.deepStrictEqual(fallbackPids, [42, 84], 'protocol failure should preserve deduplicated PID fallback');

  let terminalPids = null;
  const terminalResult = await focusSession(
    { id: 'claude-1', agentId: 'claude-code', sourcePid: 10, pidChain: [20, 10] },
    { activatePids: async (pids) => { terminalPids = pids; return false; } },
  );
  assert.strictEqual(terminalResult, false);
  assert.deepStrictEqual(terminalPids, [10, 20], 'non-Codex sessions should keep the existing PID focus path');

  assert.strictEqual(await focusSession(null, { activatePids: async () => true }), false);

  const stats = adapter.buildPetStats({
    active: null,
    sessions: [
      { id: 'codex-1', agentId: 'codex', state: 'working', updatedAt: Date.now() },
      { id: 'claude-1', agentId: 'claude-code', state: 'working', sourcePid: 100, updatedAt: Date.now() },
      { id: 'trae-1', agentId: 'trae', state: 'working', pidChain: [200], updatedAt: Date.now() },
      { id: 'workbuddy-1', agentId: 'workbuddy', state: 'working', sourcePid: 300, updatedAt: Date.now() },
      { id: 'opencode-1', agentId: 'opencode', state: 'working', updatedAt: Date.now() },
    ],
  }, [], null, {});
  const focusable = Object.fromEntries(stats.sessions.map((s) => [s.agent, s.focusable]));
  assert.deepStrictEqual(focusable, {
    codex: true,
    claude: true,
    trae: true,
    workbuddy: true,
    opencode: false,
  }, 'the renderer should only advertise session focus when a deep link or live PID exists');

  console.log('Session focus checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
