'use strict';

// opencode plugin test. The plugin is ESM (Bun parses it at runtime under
// opencode), so Node tests import a .mjs copy via dynamic import. Home is
// redirected through USERPROFILE so the plugin writes/reads a temp ~/.workmeow
// and the real machine is never touched. A local HTTP server captures the
// /state POSTs exactly like the pet's server would.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('node:url');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function until(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

const PLUGIN_SRC = path.join(__dirname, '..', 'hook', 'opencode-plugin.js');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-opencode-plugin-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.workmeow'), { recursive: true });

  // ── capture server ──────────────────────────────────────────────────────
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push({ path: req.url, token: req.headers['x-workmeow-token'], body: (() => { try { return JSON.parse(body); } catch { return null; } })() });
      res.writeHead(200, { 'x-workmeow-server': 'workmeow' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const token = 'a'.repeat(64);

  // ── plugin under test (imported after USERPROFILE redirect) ─────────────
  const oldProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home;
  fs.writeFileSync(path.join(home, '.workmeow', 'runtime.json'),
    JSON.stringify({ app: 'workmeow', port, token }));
  const tmpPlugin = path.join(root, 'opencode-plugin.mjs');
  fs.copyFileSync(PLUGIN_SRC, tmpPlugin);
  const mod = await import(pathToFileURL(tmpPlugin).href);
  const hooks = await mod.WorkMeowOpenCodePlugin({ directory: home });
  assert.strictEqual(typeof hooks.event, 'function');
  assert.strictEqual(typeof hooks['tool.execute.before'], 'function');
  assert.strictEqual(typeof hooks['tool.execute.after'], 'function');
  assert.strictEqual(typeof hooks.dispose, 'function');

  const ev = (type, properties) => hooks.event({ event: { type, properties } });

  // ── drive a realistic session ───────────────────────────────────────────
  await ev('session.created', { info: { id: 'sess-1', directory: 'C:\\proj', title: '' } });
  await until(() => got.some((r) => r.body && r.body.event === 'SessionStart'));
  const start = got.find((r) => r.body && r.body.event === 'SessionStart').body;
  assert.strictEqual(start.state, 'idle');
  assert.strictEqual(start.session_id, 'sess-1');
  assert.strictEqual(start.agent_id, 'opencode');
  assert.strictEqual(start.cwd, 'C:\\proj');
  assert.strictEqual(got[0].token, token, 'x-workmeow-token header sent');

  // user prompt: part streams in first, then message.updated
  await ev('message.part.updated', { part: { sessionID: 'sess-1', messageID: 'msg-u1', part: { type: 'text', text: '帮我看看这个 bug' } } });
  await ev('message.updated', { info: { id: 'msg-u1', sessionID: 'sess-1', role: 'user', time: { created: 1 } } });
  await until(() => got.some((r) => r.body && r.body.event === 'UserPromptSubmit'));
  const prompt = got.find((r) => r.body && r.body.event === 'UserPromptSubmit').body;
  assert.strictEqual(prompt.state, 'thinking');
  assert.strictEqual(prompt.session_title, '帮我看看这个 bug', 'user text becomes the session title');

  // tool round
  await hooks['tool.execute.before']({ tool: { type: 'command', raw: { command: 'ls' } }, sessionID: 'sess-1', callID: 'c1' });
  await hooks['tool.execute.after']({ tool: { type: 'command', raw: { command: 'ls' } }, sessionID: 'sess-1', callID: 'c1' });
  await until(() => got.some((r) => r.body && r.body.event === 'PreToolUse'));
  const pre = got.find((r) => r.body && r.body.event === 'PreToolUse').body;
  assert.strictEqual(pre.state, 'working');
  assert.strictEqual(pre.tool_name, 'Bash', 'command tool maps to Bash');
  assert(got.some((r) => r.body && r.body.event === 'PostToolUse' && r.body.tool_name === 'Bash'));

  // assistant answer: message created → text streams → finished with cost/tokens
  await ev('message.updated', {
    info: { id: 'msg-a1', sessionID: 'sess-1', role: 'assistant', modelID: 'gpt-5.6-codex', providerID: 'openai' },
  });
  await ev('message.part.updated', { part: { sessionID: 'sess-1', messageID: 'msg-a1', part: { type: 'text', text: 'done!' } } });
  await ev('message.updated', {
    info: {
      id: 'msg-a1', sessionID: 'sess-1', role: 'assistant', modelID: 'gpt-5.6-codex', providerID: 'openai',
      cost: 0.123, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 30, write: 20 } },
      finish: 'done', path: { cwd: 'C:\\proj' },
    },
  });
  await until(() => got.some((r) => r.body && r.body.event === 'Stop'));
  const stop = got.find((r) => r.body && r.body.event === 'Stop').body;
  assert.strictEqual(stop.state, 'attention');
  assert.strictEqual(stop.model, 'gpt-5.6-codex');
  assert.strictEqual(stop.assistant_last_output, 'done!', 'streamed text tail attached to Stop');

  // usage line landed exactly once
  const usageFile = path.join(home, '.workmeow', 'opencode-usage.jsonl');
  assert(await until(() => fs.existsSync(usageFile)), 'usage file created');
  let lines = fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 'one usage line per finished message');
  const usage = JSON.parse(lines[0]);
  assert.strictEqual(usage.v, 1);
  assert.strictEqual(usage.session_id, 'sess-1');
  assert.strictEqual(usage.message_id, 'msg-a1');
  assert.strictEqual(usage.model, 'gpt-5.6-codex');
  assert.strictEqual(usage.cost, 0.123);
  assert.deepStrictEqual(usage.tokens, { input: 100, output: 50, reasoning: 10, cacheRead: 30, cacheWrite: 20 });

  // same message again (streaming re-fire) must not double-log
  await ev('message.updated', {
    info: { id: 'msg-a1', sessionID: 'sess-1', role: 'assistant', modelID: 'gpt-5.6-codex', cost: 0.123, tokens: { input: 100, output: 50 }, finish: 'done' },
  });
  await sleep(150);
  lines = fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 're-fired message must not double-log');

  // ── replay guard: opencode re-emits existing messages when a session is
  // reloaded/synced (assistant finish first, then the user message last). Those
  // replays must never re-post thinking/Stop — otherwise the cat is left stuck
  // in "thinking" right after every finished answer.
  await sleep(400); // past the 300ms post-dedupe window
  await ev('message.updated', { info: { id: 'msg-u1', sessionID: 'sess-1', role: 'user', time: { created: 1 } } });
  await ev('message.updated', {
    info: { id: 'msg-a1', sessionID: 'sess-1', role: 'assistant', modelID: 'gpt-5.6-codex', cost: 0.123, tokens: { input: 100, output: 50 }, finish: 'done' },
  });
  await sleep(150);
  assert.strictEqual(got.filter((r) => r.body && r.body.event === 'UserPromptSubmit').length, 1, 'replayed user message must not re-post thinking');
  assert.strictEqual(got.filter((r) => r.body && r.body.event === 'Stop').length, 1, 'replayed finished message must not re-post Stop');

  // session.idle right after a turn → a second Stop once the 300ms dedupe
  // window has passed (it must NOT re-fire while dedupe is active).
  await sleep(400); // let the finish-Stop dedupe window expire
  await ev('session.idle', { sessionID: 'sess-1' });
  await until(() => got.filter((r) => r.body && r.body.event === 'Stop').length >= 2);
  assert.strictEqual(got.filter((r) => r.body && r.body.event === 'Stop').length, 2, 'idle Stop re-posts after dedupe window');

  // permission wait → notification
  await ev('permission.updated', { sessionID: 'sess-1', permission: { id: 'p1' } });
  await until(() => got.some((r) => r.body && r.body.event === 'Notification'));
  assert.strictEqual(got.find((r) => r.body && r.body.event === 'Notification').body.state, 'notification');

  // session error → error
  await ev('session.error', { sessionID: 'sess-1', error: { message: 'boom' } });
  await until(() => got.some((r) => r.body && r.body.event === 'StopFailure'));
  const err = got.find((r) => r.body && r.body.event === 'StopFailure').body;
  assert.strictEqual(err.state, 'error');
  assert.strictEqual(err.api_error_type, 'boom');

  // no pet running (runtime.json gone) → everything stays silent, no throw
  fs.rmSync(path.join(home, '.workmeow', 'runtime.json'));
  await ev('session.created', { info: { id: 'sess-2', directory: 'C:\\x', title: '' } });
  await hooks['tool.execute.before']({ tool: { type: 'command', raw: {} }, sessionID: 'sess-2', callID: 'c2' });
  await sleep(100);
  assert(!got.some((r) => r.body && r.body.session_id === 'sess-2'), 'no POST without runtime');

  await new Promise((resolve) => server.close(resolve));

  // ── installer (fresh require with another redirected home) ───────────────
  const home2 = path.join(root, 'home2');
  process.env.USERPROFILE = home2;
  const installer = require('../backend/opencode-install');
  let res = installer.registerHooks();
  assert.strictEqual(res.added, 1);
  const installed = path.join(home2, '.config', 'opencode', 'plugins', 'opencode-plugin.js');
  assert(fs.existsSync(installed), 'plugin copied into plugins dir');
  assert(fs.readFileSync(installed, 'utf8').includes('workmeow-opencode-plugin'));
  assert.strictEqual(installer.hooksCurrent(), true);
  res = installer.registerHooks();
  assert.strictEqual(res.skipped, 1, 'idempotent install');
  res = installer.unregisterHooks({ backup: true });
  assert.strictEqual(res.removed, 1);
  assert(!fs.existsSync(installed), 'plugin removed');
  assert(res.backupPath && fs.existsSync(res.backupPath), 'backup kept');
  assert.strictEqual(installer.hooksCurrent(), false);
  assert.strictEqual(installer.unregisterHooks({ backup: true }).removed, 0, 'second uninstall is a no-op');

  if (oldProfile !== undefined) process.env.USERPROFILE = oldProfile;
  fs.rmSync(root, { recursive: true, force: true });
  console.log('opencode plugin checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
