'use strict';

// ZCode integration checks — merge-safe hook installer semantics over
// ~/.zcode/cli/config.json plus an end-to-end hook run: ZCode pipes a
// Claude-compatible JSON payload (event name ONLY in `hook_event_name`, never
// argv) into hook/zcode-hook.js, which must POST the mapped pet state to the
// WorkMeow server.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createZcodeHookInstaller, COMMAND_EVENTS } = require('../backend/zcode-hookinstall');
const { buildBody, EVENT_STATE } = require('../backend/hook-common');
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-zcode-int-'));

// ---- shared hook mapping (agent id + event vocabulary) ----
{
  const body = buildBody('PostToolUse', { session_id: 'sess_z', cwd: 'D:\\x', tool_name: 'Bash' }, 'zcode');
  assert.strictEqual(body.agent_id, 'zcode');
  assert.strictEqual(body.state, 'working');
  assert.strictEqual(body.event, 'PostToolUse');
  assert.strictEqual(body.tool_name, 'Bash');
  assert.strictEqual(buildBody('Stop', { session_id: 'sess_z' }, 'zcode').state, 'attention');
  assert.strictEqual(buildBody('PostToolUseFailure', { session_id: 'sess_z' }, 'zcode').state, 'error');
  assert.strictEqual(EVENT_STATE.SessionStart, 'idle');
  // Subagent dispatch: ZCode names the subagent tool 'Agent' (Claude Code uses
  // 'Task'); both fork into the juggling (并行) state instead of plain work.
  assert.strictEqual(buildBody('PreToolUse', { session_id: 'sess_z', tool_name: 'Task' }, 'zcode').state, 'juggling');
  assert.strictEqual(buildBody('PreToolUse', { session_id: 'sess_z', tool_name: 'Agent' }, 'zcode').state, 'juggling');
  assert.strictEqual(buildBody('PreToolUse', { session_id: 'sess_z', tool_name: 'Bash' }, 'zcode').state, 'working');
  // ZCode fires no SessionEnd/Notification/PreCompact — those stay unmapped-input-safe.
  assert.strictEqual(buildBody('Unknown', { session_id: 'sess_z' }, 'zcode'), null);
}

// ---- installer semantics ----
const runtime = { executable: path.join(root, 'electron.exe'), runAsNode: true };
function newInstaller(configName) {
  const configPath = path.join(root, configName);
  return {
    configPath,
    installer: createZcodeHookInstaller({ configPath, detectPath: root, runtime }),
  };
}
const ourHooksIn = (config) => {
  const events = config.hooks && config.hooks.events;
  return COMMAND_EVENTS.filter((event) => Array.isArray(events && events[event])
    && events[event].some((group) => (group.hooks || []).some(
      (hook) => (hook.command || '').includes('zcode-hook.js')
        || JSON.stringify(hook.args || []).includes('zcode-hook.js'))));
};

{
  const { configPath, installer } = newInstaller('fresh-config.json');

  // Fresh install: config-file hooks are off by default in ZCode, so the
  // installer must flip hooks.enabled and register all seven events.
  const first = installer.registerHooks();
  assert.strictEqual(first.added, COMMAND_EVENTS.length);
  let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(config.hooks.enabled, true);
  assert.deepStrictEqual(ourHooksIn(config).sort(), [...COMMAND_EVENTS].sort());
  const hook = config.hooks.events.PreToolUse[0].hooks[0];
  assert.strictEqual(hook.type, 'process');
  assert(Array.isArray(hook.args) && hook.args.length >= 5, 'process hook is an argv vector');
  assert.strictEqual(hook.timeoutMs, 5000);
  // ZCode's schema rejects `matcher: ""` (min 1 char) and invalidates the
  // whole config file over it — our catch-all must OMIT the key entirely.
  for (const event of COMMAND_EVENTS) {
    for (const group of config.hooks.events[event]) {
      assert(group.matcher === undefined, `matcher must be omitted, got ${JSON.stringify(group.matcher)} on ${event}`);
    }
  }
  assert(installer.hooksCurrent(), 'fresh install must report current');

  // Re-register is idempotent.
  const second = installer.registerHooks();
  assert.strictEqual(second.added, 0);
  assert.strictEqual(second.updated, 0);
  assert.strictEqual(second.skipped, COMMAND_EVENTS.length);

  // An earlier install wrote `matcher: ""` (ZCode rejects it and fails the
  // whole file). Re-registering must heal the group in place.
  const broken = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  broken.hooks.events.Stop[0].matcher = '';
  fs.writeFileSync(configPath, JSON.stringify(broken));
  const healed = installer.registerHooks();
  assert.strictEqual(healed.updated >= 1, true, 'empty matcher is healed');
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(config.hooks.events.Stop[0].matcher, undefined);
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(ourHooksIn(config).length, COMMAND_EVENTS.length, 'no duplicate groups');

  // Uninstall with nothing else in the file removes the whole hooks block.
  const removed = installer.unregisterHooks({ backup: true });
  assert.strictEqual(removed.removed, COMMAND_EVENTS.length);
  assert(removed.backupPath, 'uninstall backs the config up');
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(config.hooks, undefined);
  assert(!installer.hooksCurrent(), 'uninstalled hooks must not report current');
}

{
  const { configPath, installer } = newInstaller('shared-config.json');
  // A user's own hooks and unrelated keys must survive both register and
  // uninstall untouched.
  fs.writeFileSync(configPath, JSON.stringify({
    plugins: { enabledPlugins: { 'x@y': true } },
    hooks: {
      events: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'user-tool.exe', args: ['--flag'] }] }],
      },
    },
  }));
  installer.registerHooks();
  let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(config.hooks.enabled, true);
  const userGroups = config.hooks.events.PreToolUse.filter(
    (group) => (group.hooks || []).some((hook) => hook.command === 'user-tool.exe'));
  assert.strictEqual(userGroups.length, 1, 'user hook group survives');
  assert.strictEqual(userGroups[0].matcher, 'Bash', 'user matcher survives');
  assert.deepStrictEqual(config.plugins.enabledPlugins, { 'x@y': true });

  installer.unregisterHooks({});
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(ourHooksIn(config).length, 0);
  assert.strictEqual(config.hooks.events.PreToolUse.length, 1, 'only the user group remains');
  assert.strictEqual(config.hooks.events.PreToolUse[0].hooks[0].command, 'user-tool.exe');
  assert.deepStrictEqual(config.plugins.enabledPlugins, { 'x@y': true });
  assert(!installer.hooksCurrent());
}

// ---- end-to-end hook run with a temp home and a stub WorkMeow server ----
const token = 'a'.repeat(48);

function freeWorkmeowPort() {
  const { PORTS } = require('../backend/transport');
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= PORTS.length) return resolve(null);
      const port = PORTS[i++];
      const server = net.createServer();
      server.once('error', () => tryNext());
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

async function main() {
  const port = await freeWorkmeowPort();
  if (!port) {
    console.log('zcode integration checks passed (e2e hook POST skipped: no free WorkMeow port)');
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ path: req.url, token: req.headers['x-workmeow-token'], body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'x-workmeow-server': 'workmeow' });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.workmeow'), { recursive: true });
  fs.writeFileSync(path.join(home, '.workmeow', 'runtime.json'),
    JSON.stringify({ app: 'workmeow', port, token }));

  const hookScript = path.join(__dirname, '..', 'hook', 'zcode-hook.js');
  const runHook = (payload, extraEnv = {}) => spawnSync(process.execPath, [hookScript], {
    cwd: __dirname,
    input: JSON.stringify(payload),
    env: { ...process.env, USERPROFILE: home, HOME: home, ...extraEnv },
    timeout: 15000,
  });

  try {
    const post = runHook({
      hook_event_name: 'PostToolUse', session_id: 'sess_z', cwd: 'D:\\proj',
      tool_name: 'Bash', permission_mode: 'default', agent_type: 'zcode-agent',
    });
    assert.strictEqual(post.status, 0, `hook exit code: ${post.status} ${post.stderr}`);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(received.length, 1, 'exactly one state POST');
    assert.strictEqual(received[0].path, '/state');
    assert.strictEqual(received[0].token, token);
    assert.strictEqual(received[0].body.agent_id, 'zcode');
    assert.strictEqual(received[0].body.state, 'working');
    assert.strictEqual(received[0].body.event, 'PostToolUse');
    assert.strictEqual(received[0].body.session_id, 'sess_z');
    assert.strictEqual(received[0].body.cwd, 'D:\\proj');

    received.length = 0;
    const stop = runHook({ hook_event_name: 'Stop', session_id: 'sess_z' });
    assert.strictEqual(stop.status, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].body.state, 'attention');

    received.length = 0;
    // ZCode 的 transcript_path 是每次 hook 现生成的临时文件，Stop 的 💬 气泡
    // 改从 db.sqlite（message/part 表）取最后一条助手文本。WORKMEOW_ZCODE_DB
    // 指向测试库；指向不存在的库时 enrich 安静跳过、不影响状态推送。
    const nodb = runHook({ hook_event_name: 'Stop', session_id: 'sess_z' },
      { WORKMEOW_ZCODE_DB: path.join(root, 'no-such', 'db.sqlite') });
    assert.strictEqual(nodb.status, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].body.state, 'attention');
    assert.strictEqual(received[0].body.assistant_last_output, undefined,
      'missing DB degrades to a plain Stop');
    received.length = 0;

    if (DatabaseSync) {
      const zdbPath = path.join(root, 'zcode', 'db.sqlite');
      fs.mkdirSync(path.dirname(zdbPath), { recursive: true });
      const zdb = new DatabaseSync(zdbPath);
      zdb.exec(`CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT, sequence INTEGER)`);
      zdb.exec(`CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT, sequence INTEGER)`);
      const t = Date.now();
      zdb.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)')
        .run('msg1', 'sess_z', t, t, JSON.stringify({ role: 'assistant' }), 0);
      zdb.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('p1', 'msg1', 'sess_z', t, t, JSON.stringify({ type: 'text', text: '关键的最终结论：一切正常。' }), 0);
      zdb.close();

      const bubble = runHook({ hook_event_name: 'Stop', session_id: 'sess_z', cwd: 'D:\\proj' },
        { WORKMEOW_ZCODE_DB: zdbPath });
      assert.strictEqual(bubble.status, 0, `bubble hook exit code: ${bubble.status} ${bubble.stderr}`);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].body.state, 'attention');
      assert.strictEqual(received[0].body.assistant_last_output, '关键的最终结论：一切正常。',
        'Stop bubble is enriched from the ZCode message/part tables');
      received.length = 0;
    } else {
      console.log('zcode integration checks: bubble enrichment skipped (node:sqlite unavailable)');
    }

    received.length = 0;
    const unknown = runHook({ hook_event_name: 'NoSuchEvent', session_id: 'sess_z' });
    assert.strictEqual(unknown.status, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(received.length, 0, 'unknown events stay silent');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('zcode integration checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
