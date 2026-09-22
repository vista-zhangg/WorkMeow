'use strict';

// trae-watch 单元测试 — 用临时目录伪造 %APPDATA%/TRAE SOLO CN/logs 结构。
// 覆盖两代信号源：
//   旧 ai-agent_*_stdout.log（Rust tracing，key=value）
//   新 window*/renderer.log（TRAE 0.1.64+，ai-agent stdout 已 0 字节、
//   tracing 迁入二进制 .alaudalog，会话生命周期镜像在 renderer.log）
// Run: node test/trae-watch.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraeWatch } = require('../backend/trae-watch');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// 假 core：只记账
function fakeCore() {
  return {
    updates: [], seeds: [],
    updateSession(sid, state, event, fields) { this.updates.push({ sid, state, event, fields }); },
    seedSession(s) { this.seeds.push(s); },
  };
}

const SID_A = '6a519ac6b6047ff853bd4e7c';
const SID_B = '6ab0e8683627780a31497896';
const TS = '2026-09-21T16:48:14.354+08:00';

// 伪造 logs/<ts>/ 结构，返回 {root, tsDir}
function mkLogs(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-trae-'));
  const tsDir = path.join(root, '20260921T162209');
  fs.mkdirSync(tsDir, { recursive: true });
  if (extra) extra(tsDir);
  return { root, tsDir };
}

function mkModular(tsDir) {
  const d = path.join(tsDir, 'Modular');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function mkWindow(tsDir) {
  const d = path.join(tsDir, 'window1');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const rline = (tag, payload) => `${TS} [info] ${tag} ${payload}\n`;

// renderer.log 常用行
const rStatus = (sid, next, prev) => rline(
  '[trae-chat-core] [SessionStatusTrace] Session status changed:',
  `{"source":"${prev === undefined ? 'core.set' : 'frontier.session_updated'}","sessionId":"${sid}"${prev === undefined ? '' : `,"prevStatus":${prev}`},"nextStatus":${next}}`
);
const rPlanItem = (sid, planItemId, toolName) => rline(
  '[trae-chat-core] [PlanItemHandler] New plan item created',
  `{"sessionId":"${sid}","planItemId":"${planItemId}","toolCallName":"${toolName}"}`
);
const rBadge = (sid, planItemId, toolName) => rline(
  '[AssistantMainBadge] received plan_item_enqueued for assistant badge',
  `{"eventSessionId":"${sid}","currentSessionId":"${sid}","toolCallName":"${toolName}","planItemId":"${planItemId}"}`
);
const rWaitConfirm = (sid) => rline(
  '[trae-chat-core] [NotificationPort] Waiting confirm detected, scheduling notification:',
  `{"sessionId":"${sid}","planItemId":"6ab0edd33627780a31497944","tailStatusType":"waiting_confirm"}`
);
const rToolConfirm = (sid, toolName) => rline(
  '[trae-chat-core] [ToolConfirm] action started',
  `{"sessionId":"${sid}","toolName":"${toolName}","planItemId":"6ab0edd33627780a31497944","panelType":"run-command-v2","actionKey":"run-session"}`
);
const rFetched = (sid, folder, title) => rline(
  '[trae-chat-core] [RealtimeEventService] Session fetched:',
  `{"chat_session_id":"${sid}","user_id":"42","status":3,"mode":"code","source":{"repo_url":"","type":"local","local_folder":"${folder}"},"title":"${title || ''}","icon":""}`
);
const rUpdated = (sid, title, status) => rline(
  '[RealtimeInitService][local] Handle event: session_updated',
  `{"chat_session_id":"${sid}","user_id":"42","status":${status},"title":"${title}","updated_at":1789978731551}`
);

console.log('[T1] 新信号源：renderer.log（TRAE 0.1.64+，ai-agent stdout 0 字节）');
check('0 字节 stdout + 活跃 renderer.log：启动即从尾部建档（sid/cwd/title）', () => {
  const { root, tsDir } = mkLogs((d) => {
    const m = mkModular(d); // stdout 存在但 0 字节
    fs.writeFileSync(path.join(m, 'ai-agent_0_1789976288934_stdout.log'), '');
    const w = mkWindow(d);
    fs.writeFileSync(w + '/renderer.log',
      rFetched(SID_B, 'd:\\\\Desktop\\\\python_development') +
      rUpdated(SID_B, '执行 FMEA 报告调整', 3) +
      rline('[TransportManager] executeRequest, lite list_chat_sessions, cost: 0', '{"x":1}') +
      rline('[trae-chat-core] [SessionDomainService] Sessions appended, count: 16', '{"n":1}'));
  });
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick();
  assert.strictEqual(core.seeds.length, 1, 'renderer.log 应建档');
  assert.strictEqual(core.seeds[0].id, SID_B);
  assert.strictEqual(core.seeds[0].agentId, 'trae');
  assert.strictEqual(core.seeds[0].cwd, 'd:\\Desktop\\python_development');
  assert.strictEqual(core.seeds[0].sessionTitle, '执行 FMEA 报告调整');
  assert.strictEqual(core.updates.length, 0, 'backfill 不发事件');
});

check('回合生命周期：新任务 thinking → 工具 working → sse.done idle', () => {
  const { root, tsDir } = mkLogs((d) => {
    mkWindow(d);
  });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, '');
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick(); // 空场启动 → booted
  fs.appendFileSync(fp,
    rStatus(SID_B, 1) + // 新会话（core.set）
    rStatus(SID_B, 3, 1) + // 1→3 agent 接手
    rPlanItem(SID_B, '6ab0f0c73627780a31497998', 'Shell') +
    rFetched(SID_B, 'd:\\\\proj\\\\demo') +
    rStatus(SID_B, 5, 3)); // sse.done
  w.tick();
  const evs = core.updates.map((u) => `${u.event}:${u.state}`);
  assert.deepStrictEqual(evs, [
    'UserPromptSubmit:thinking', // 新任务
    'PreToolUse:working',        // 工具
    'TraeIdle:idle',             // 回合完成
  ]);
  assert.ok(core.updates.every((u) => u.sid === SID_B));
  assert.strictEqual(core.updates[1].fields.toolName, 'Shell');
  assert.ok(core.updates.every((u) => u.fields.agentId === 'trae'));
});

check('旧会话新回合：5→3 视为新任务 thinking；首轮 core.set 恢复不建档不发事件', () => {
  const { root, tsDir } = mkLogs((d) => { mkWindow(d); });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, '');
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick();
  // 启动恢复：历史会话全部 core.set 5/4（无 prevStatus），不应给它们建档
  fs.appendFileSync(fp,
    rStatus(SID_A, 5) +
    rStatus('6a51ba38b6047ff853bd4fd0', 4) +
    rStatus(SID_B, 5) +
    rStatus(SID_B, 3, 5)); // 同一会话新回合
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => `${u.event}:${u.state}`), ['UserPromptSubmit:thinking']);
  assert.strictEqual(core.updates[0].sid, SID_B);
});

check('计划项去重：同 planItemId 的 badge 不重复发 PreToolUse', () => {
  const { root, tsDir } = mkLogs((d) => { mkWindow(d); });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, '');
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick();
  fs.appendFileSync(fp,
    rStatus(SID_B, 1) +
    rPlanItem(SID_B, '6ab0f0b93627780a31497995', 'Write') +
    rBadge(SID_B, '6ab0f0b93627780a31497995', 'Write') + // 同一计划项，应去重
    rBadge(SID_B, '6ab0f0d63627780a3149799e', 'finish')); // 新计划项，应发出
  w.tick();
  const tools = core.updates.filter((u) => u.event === 'PreToolUse');
  assert.deepStrictEqual(tools.map((u) => u.fields.toolName), ['Write', 'finish']);
  assert.ok(tools.every((u) => u.state === 'working'));
});

check('等待确认 → notification；用户批准 → working（toolName 跟随）', () => {
  const { root, tsDir } = mkLogs((d) => { mkWindow(d); });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, '');
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick();
  fs.appendFileSync(fp,
    rStatus(SID_B, 1) +
    rWaitConfirm(SID_B) +
    rToolConfirm(SID_B, 'Shell'));
  w.tick();
  const evs = core.updates.map((u) => `${u.event}:${u.state}`);
  assert.deepStrictEqual(evs, ['UserPromptSubmit:thinking', 'Notification:notification', 'PreToolUse:working']);
  assert.strictEqual(core.updates[2].fields.toolName, 'Shell');
});

check('后台行（轮询/路由/追加）不算活动也不发事件', () => {
  const { root, tsDir } = mkLogs((d) => { mkWindow(d); });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, '');
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick();
  fs.appendFileSync(fp,
    rline('[TransportManager] executeRequest, lite list_chat_sessions, c9a00162, cost: 0', '{}') +
    rline('[API client][routeSelector] chat listSessions local', '{}') +
    rline('[trae-chat-core] [SessionDomainService] Sessions appended, count: 2', '{}') +
    rline('[trae-chat-core] [RepoService] Repo list load failed: git token not found', '{}') +
    rline('[trae-chat-core] [ModelDomainService] Models refreshed', '{}') +
    rline('[tooling] deleteCachedWorkspaceFileOrFolder, len: 1', '{}'));
  w.tick();
  assert.strictEqual(core.updates.length, 0);
});

check('badge 的归属会话是 eventSessionId，不是聚焦的 currentSessionId', () => {
  const { root, tsDir } = mkLogs((d) => { mkWindow(d); });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, '');
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick();
  fs.appendFileSync(fp, rline(
    '[AssistantMainBadge] received plan_item_enqueued for assistant badge',
    `{"eventSessionId":"${SID_A}","currentSessionId":"${SID_B}","toolCallName":"Edit","planItemId":"6aabb33627780a31497aaa1"}`));
  w.tick();
  assert.strictEqual(core.updates.length, 1);
  assert.strictEqual(core.updates[0].sid, SID_A);
});

console.log('[T2] 旧信号源回归：ai-agent stdout（key=value）仍被解析');
check('旧日志：工具 hook 与 dispatch 信号照常工作', () => {
  const { root, tsDir } = mkLogs((d) => { mkModular(d); });
  const fp = path.join(tsDir, 'Modular', 'ai-agent_0_1789257087644_stdout.log');
  fs.writeFileSync(fp,
    `2026-08-07T23:32:28.010203+08:00  INFO a::b: do_chat:slardar_root:dispatch:execute_task:start session_id=${SID_B} task_id=aaa\n`);
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick(); // backfill 只探尾部建档
  fs.appendFileSync(fp,
    `2026-08-07T23:32:29.010203+08:00  INFO c::d: [ToolcallService] Start run tool \`"Grep"\` session_id=${SID_B}\n`);
  w.tick();
  assert.strictEqual(core.seeds.length, 1);
  assert.strictEqual(core.seeds[0].id, SID_B);
  const last = core.updates.at(-1);
  assert.strictEqual(last.event, 'PreToolUse');
  assert.strictEqual(last.state, 'working');
  assert.strictEqual(last.fields.toolName, 'Grep');
});

console.log('[T3] 健壮性');
check('损坏 JSON 行 / 不存在的目录不炸', () => {
  const { root, tsDir } = mkLogs((d) => { mkWindow(d); });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, '');
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick();
  fs.appendFileSync(fp,
    `${TS} [info] [trae-chat-core] [SessionStatusTrace] Session status changed: {BROKEN\n` +
    rStatus(SID_B, 1));
  w.tick();
  assert.ok(core.updates.some((u) => u.event === 'UserPromptSubmit'));
  const w2 = createTraeWatch({ core: fakeCore(), roots: [path.join(root, 'nope')], pollMs: 999999 });
  w2.tick(); // 不抛即可
});

check('静默退场后恢复：保留游标，不重放旧事件', () => {
  const { root, tsDir } = mkLogs((d) => { mkWindow(d); });
  const fp = path.join(tsDir, 'window1', 'renderer.log');
  fs.writeFileSync(fp, rStatus(SID_B, 1) + rStatus(SID_B, 5, 3));
  const core = fakeCore();
  const w = createTraeWatch({ core, roots: [root], pollMs: 999999 });
  w.tick(); // backfill 建档
  assert.strictEqual(core.seeds.length, 1);

  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(fp, old, old);
  w.tick();
  assert.strictEqual(w._trackers.has(fp), false, '静默 tracker 应退场');

  fs.appendFileSync(fp, rStatus(SID_B, 3, 5));
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => `${u.event}:${u.state}`), ['UserPromptSubmit:thinking']);
});

process.exit(failures ? 1 : 0);
