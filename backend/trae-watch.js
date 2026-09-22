'use strict';

// TRAE SOLO CN 日志监听器 —— 把 TRAE 日志翻译成 core 的状态流。
//
// 为什么走「读日志」而不是钩子：TRAE SOLO CN 的内置 agent 是 Rust 原生模块
// (ai_agent.dll)，不是 Claude Code CLI，不读 ~/.claude/settings.json 也不读
// ~/.trae-cn/hooks.json。活动信号只能从 %APPDATA%/TRAE SOLO CN/logs/<ts>/ 下
// 的日志里读。
//
// 信号源有两代（2026-09 起 TRAE 0.1.64 切换，两代都看）：
//
// ① 旧：Modular/ai-agent_*_stdout.log —— Rust tracing 纯文本。每行带
//    session_id=xxx、task_id=xxx，工具生命周期用 hook=PreToolUse/PostToolUse
//    标记。0.1.64 起该文件变成 0 字节占位，tracing 全部改写进二进制
//    .alaudalog (AalG) 格式，无法按行 tail —— 旧信号源由此失效。
//
// ② 新：window*/renderer.log —— 渲染进程纯文本日志，会话生命周期以 JSON
//    载荷形式镜像在这里：
//    [SessionStatusTrace] Session status changed: {...sessionId,nextStatus}
//      nextStatus 1 → thinking（新任务）；3 → working（执行中）；
//      5 → idle（sse.done 回合完成）；4 → idle（异常终止）
//    [PlanItemHandler] New plan item created / [AssistantMainBadge]
//    plan_item_enqueued {...planItemId, toolCallName} → working（PreToolUse）
//    [NotificationPort] Waiting confirm detected → notification（等用户确认）
//    [ToolConfirm] action started → working（用户已批准，工具开跑）
//    [MetadataHandler] received metadata / [RealtimeEventService] 等 → 活动心跳
//    cwd 从 realtime 事件的 local_folder 提取，标题从 session_updated 的 title。
//
// 旧 stdout 静默 8 秒 → idle；renderer 用明确的回合结束事件。
// renderer 按会话隔离，后台同步不提供活性；异常退出由 core 的 stale 兜底。
//
// 大文件安全：日志可达 70MB+。增量 tail（单轮 256KB），backfill 只探尾部不回放。

const fs = require('fs');
const os = require('os');
const path = require('path');

// TRAE 日志根：覆盖 TRAE SOLO CN / TRAE SOLO / Trae CN / Trae 四个变体
function candidateLogRoots() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(appdata, 'TRAE SOLO CN', 'logs'),
    path.join(appdata, 'TRAE SOLO', 'logs'),
    path.join(appdata, 'Trae CN', 'logs'),
    path.join(appdata, 'Trae', 'logs'),
  ];
}

const POLL_MS = 2000;
const IDLE_AFTER_SILENCE_MS = 8 * 1000;     // 日志停写 8s → idle
const RETIRE_AFTER_SILENCE_MS = 10 * 60 * 1000; // 停写 10min → 退场（保留游标）
const MAX_READ_PER_TICK = 256 * 1024;
const HOT_DIRS = 4;                          // 每轮扫最近 4 个时间戳目录
const FULL_SWEEP_TICKS = 15;                 // 每 ~30s 全量扫一次所有目录
const TAIL_PROBE_BYTES = 64 * 1024;
const ASSISTANT_MAX = 2400;

// 正则：从一行日志提取信号。每行形如
// 2026-08-07T23:32:28.010203+08:00  INFO a::b::c: message ... session_id=XXX task_id=YYY ...
const RE_SESSION = /session_id=([0-9a-f]+)/i;
const RE_TASK = /task_id=([0-9a-f]+)/i;
const RE_REPO = /repo=([^\s]+)/;
const RE_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\S*)/;
// TRAE 工具名格式：[ToolcallService] Start run tool `"Grep"`（反引号+双引号+名+双引号+反引号）
const RE_TOOL_START = /\[ToolcallService\]\s+Start run tool `"([^"]+)"`/;
const RE_TOOL_FINISH = /\[ToolcallService\]\s+Run tool \w+ finished,\s+status:\s*(\w+)/i;
const RE_CHAT_DISPATCH = /do_chat:slardar_root:dispatch(:execute_task)?/;
const RE_PLAN_FINAL = /plan final token cost/;
const RE_PLAN_FINISH = /plan tool call finish/;

// 「有意义」的活动行判定：只匹配 chat 派发 / 工具调用 / 规划 / hook 信号。
// TRAE 空闲时仍会持续写 toolhost/rpc/tenant_config 等后台行（见 ai-agent 日志尾部：
// [Toolhost] spawn、[rpc] register_session_client、route: service:"commercial" 等），
// 这些不算活动——否则打工喵会因后台日志持续落盘而永远停在 working 状态。
const RE_MEANINGFUL = /(do_chat|ToolcallService|hook=PreToolUse|hook=PostToolUse|plan final token cost|plan tool call finish|execute_toolcall)/i;

// ---------- renderer.log 信号（TRAE 0.1.64+） ----------
// 会话归属：JSON 载荷里的任意一种 session id 键（比文件名稳定，一个窗口一个
// renderer.log 可能交错多个会话）。
const RE_R_SID = /"(?:sessionId|session_id|chat_session_id|eventSessionId|currentSessionId|targetSessionId)":"([0-9a-f]{8,})"/i;
const RE_R_CWD = /"local_folder":"((?:[^"\\]|\\.)*)"/;
const RE_R_TITLE = /"title":"((?:[^"\\]|\\.)*)"/;
const RE_R_STATUS = /\[SessionStatusTrace\] Session status changed:/;
const RE_R_PLAN_ITEM = /New plan item created|plan item first observed/;
const RE_R_BADGE = /\[AssistantMainBadge\] received plan_item_enqueued/;
const RE_R_WAIT_CONFIRM = /\[NotificationPort\] Waiting confirm detected/;
const RE_R_TOOL_CONFIRM = /\[ToolConfirm\] action started/;
const RE_R_METADATA = /\[MetadataHandler\] received metadata/;
const RE_R_STREAM_LIFE = /\[NotificationPort\] Stream (started|stopped)/;
// title 只从会话生命周期行收割（其它行的 JSON 里也可能嵌 title 字样）
const RE_R_SESSION_LIFE = /session_created|session_updated|Session fetched|SessionStatusTrace/;
// renderer.log 空闲时也在被 list_chat_sessions 轮询等后台流量持续写入，
// 只有这些标签算活动（和旧 ai-agent 的 RE_MEANINGFUL 同一个角色）。
const RE_R_MEANINGFUL = /(SessionStatusTrace|PlanItemHandler|sse-summary|plan_item_enqueued|ToolConfirm|NotificationPort|MetadataHandler|session_created|session_updated|Session fetched|Status conflict)/;

// TRAE 的会话状态码：1=新任务 3=执行中 4=异常终止 5=回合完成。
// prevStatus 缺失 = core.set 启动恢复（历史会话回填），不能当成实时迁移。
function rendererStatusUpdate(next, prev) {
  if (next === 1) return { state: 'thinking', event: 'UserPromptSubmit' };
  if (next === 3 && (prev === 5 || prev === 4)) return { state: 'thinking', event: 'UserPromptSubmit' }; // 旧会话新回合
  if ((next === 5 || next === 4) && (prev === 3 || prev === 1)) return { state: 'idle', event: 'TraeIdle' };
  return null; // 其余（启动恢复 / 1→3 / 重复同步）只算活动
}

function parseTs(line) {
  const m = RE_TS.exec(line);
  if (!m) return 0;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : 0;
}

// renderer.log 行尾的 JSON 载荷：取整行第一个 { 到最后一个 } 解析。
function tailJson(line) {
  const a = line.indexOf('{');
  const b = line.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const v = JSON.parse(line.slice(a, b + 1));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

function rendererSessionId(p) {
  const sid = p && (p.eventSessionId || p.sessionId || p.session_id || p.chat_session_id);
  return typeof sid === 'string' && sid ? sid : null;
}

// JSON 字符串值反转义（"d:\\Desktop\\x" → d:\Desktop\x）。
function unquoteJson(raw) {
  if (!raw) return '';
  try { return JSON.parse(`"${raw}"`) || ''; } catch { return raw; }
}

function readBytes(fp, start, len) {
  let fd = null;
  try {
    fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.slice(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function clipAssistant(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  return t.length > ASSISTANT_MAX ? t.slice(0, ASSISTANT_MAX) : t;
}

function listTsDirs(roots) {
  const out = [];
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (!/^\d{8}T\d{6}$/.test(n)) continue;
      out.push({ dir: path.join(root, n), name: n });
    }
  }
  // 按目录名（时间戳）倒序，最新的在前
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out;
}

function listAgentLogs(dir) {
  const modular = path.join(dir, 'Modular');
  let names;
  try { names = fs.readdirSync(modular); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^ai-agent_.*_stdout\.log$/.test(n)) continue;
    try {
      const st = fs.statSync(path.join(modular, n));
      out.push({ fp: path.join(modular, n), size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out;
}

// renderer.log：每个窗口目录 window<N>/renderer.log（TRAE 0.1.64+ 的活动信号源）
function listRendererLogs(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^window\d+$/.test(n)) continue;
    const fp = path.join(dir, n, 'renderer.log');
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    out.push({ fp, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

function createTraeWatch(deps) {
  const core = deps.core;
  const roots = deps.roots || candidateLogRoots();
  const pollMs = deps.pollMs || POLL_MS;

  /** @type {Map<string, object>} file path → tracker */
  const trackers = new Map();
  const cursors = new Map(); // 文件偏移保留：长寿会话静默后恢复只读增量
  let timer = null;
  let booted = false;
  let tickCount = 0;
  let missingLogged = false;

  function baseFields(t) {
    const f = {
      agentId: 'trae',
      headless: false,
      transcriptPath: t.fp,
    };
    if (t.cwd) f.cwd = t.cwd;
    if (t.model) f.model = t.model;
    return f;
  }

  function update(t, state, event, extra) {
    if (!t.sid) return;
    t.state = state;
    core.updateSession(t.sid, state, event, { ...baseFields(t), ...extra });
  }

  // renderer.log 行处理。返回 true = 有意义的活动行（刷新 idle 计时器）。
  // 会话归属：payload 里任意一种 session id 键；一个 renderer.log 交错多会话时
  // 逐行跟随（与旧 ai-agent 逻辑一致）。
  function handleRendererLine(t, line) {
    // Ownership is resolved before dispatch; metadata belongs to this session.
    if (t.sid) {
      if (!t.cwd) {
        const cwd = RE_R_CWD.exec(line);
        if (cwd) t.cwd = unquoteJson(cwd[1]) || t.cwd;
      }
      if (RE_R_SESSION_LIFE.test(line)) {
        const title = RE_R_TITLE.exec(line);
        if (title) t.title = unquoteJson(title[1]) || t.title;
      }
    }

    // ① 会话状态迁移（1=新任务 3=执行中 5=回合完成 4=异常终止）
    if (RE_R_STATUS.test(line)) {
      const p = tailJson(line);
      const next = p ? Number(p.nextStatus) : 0;
      const prev = p && p.prevStatus != null ? Number(p.prevStatus) : NaN;
      const mapped = rendererStatusUpdate(next, prev);
      if (mapped) update(t, mapped.state, mapped.event, { sessionTitle: t.title || null });
      // 启动恢复（core.set，无 prevStatus）不算活动，避免给历史会话建档
      return !!(mapped || (p && Number.isFinite(prev)));
    }

    // ② 计划项 = 工具调用信号（toolCallName 为空的是纯文本段，只算活动）
    if (RE_R_PLAN_ITEM.test(line) || RE_R_BADGE.test(line)) {
      const p = tailJson(line);
      if (p) {
        // badge 载荷里 currentSessionId 是当前聚焦的会话，eventSessionId 才是
        // 事件归属；PlanItemHandler 用 sessionId
        const ownerSid = p.eventSessionId || p.sessionId;
        if (typeof ownerSid === 'string' && ownerSid) t.sid = ownerSid;
        const planItemId = String(p.planItemId || '');
        const toolName = String(p.toolCallName || '');
        if (toolName && planItemId && !t.toolItems.has(planItemId)) {
          t.toolItems.set(planItemId, toolName);
          if (t.toolItems.size > 128) t.toolItems.delete(t.toolItems.keys().next().value);
          t.lastTool = toolName;
          update(t, 'working', 'PreToolUse', { toolName, sessionTitle: t.title || null });
          return true;
        }
      }
      return true;
    }

    // ③ TRAE 等用户确认工具 → notification（持续到用户处理）
    if (RE_R_WAIT_CONFIRM.test(line)) {
      const p = tailJson(line);
      if (p && typeof p.sessionId === 'string') t.sid = p.sessionId;
      update(t, 'notification', 'Notification', { sessionTitle: t.title || null });
      return true;
    }

    // ④ 用户批准工具 → 工具开跑
    if (RE_R_TOOL_CONFIRM.test(line)) {
      const p = tailJson(line);
      if (p) {
        if (typeof p.sessionId === 'string' && p.sessionId) t.sid = p.sessionId;
        if (p.toolName) t.lastTool = String(p.toolName);
      }
      update(t, 'working', 'PreToolUse', { toolName: t.lastTool || null, sessionTitle: t.title || null });
      return true;
    }

    // ⑤ 流式元数据/回合生命周期/realtime 同步：活动心跳，不发事件
    if (RE_R_STREAM_LIFE.test(line) && /Stream stopped/.test(line)) {
      update(t, 'idle', 'TraeIdle');
      return true;
    }
    if (RE_R_METADATA.test(line) || RE_R_STREAM_LIFE.test(line)) return true;
    return false; // session list/title synchronization is not execution evidence
  }

  // 从一行日志提取信号，转成 core 事件。返回 true 表示这是「有意义的活动行」
  // （chat 派发 / 工具调用 / 规划 / hook），用于驱动 idle 降级计时器；后台行
  // （toolhost/rpc/tenant_config 等）不匹配任何信号，返回 false。
  function handleLine(t, line) {
    if (t.kind === 'renderer') {
      // renderer.log 空闲时也被 list_chat_sessions 轮询等后台流量持续写入，
      // 先过活动门控再解析，否则打工喵会永远停在 working。
      if (!RE_R_MEANINGFUL.test(line)) return false;
      const p = tailJson(line);
      // Window logs interleave multiple projects and sessions. Never inherit
      // ownership from the previous line (including malformed/global events).
      const sid = rendererSessionId(p);
      if (typeof sid !== 'string' || !sid) return false;
      let session = t.sessions.get(sid);
      if (!session) {
        session = { ...newTracker(t.fp), sid };
        t.sessions.set(sid, session);
      }
      const active = handleRendererLine(session, line);
      if (active) {
        session.lastActivityAt = Date.now();
        if (session.state && core.touchSession) core.touchSession(sid, session.lastActivityAt, session.title);
      }
      return active;
    }

    const sid = RE_SESSION.exec(line);
    if (sid) {
      // 用日志里的 session_id 作为会话标识（比文件名更稳定）
      if (t.sid !== sid[1]) {
        t.sid = sid[1];
      }
    }
    const repo = RE_REPO.exec(line);
    if (repo) {
      const cwd = repo[1];
      if (cwd && !t.cwd) t.cwd = cwd;
    }

    // 后台行一概不算活动（即使带 session_id），避免空闲时被误判为 working
    if (!RE_MEANINGFUL.test(line)) return false;
    if (!t.sid) return true; // 有活动信号但还没拿到 session_id，先记为活动

    // 注意顺序：具体的工具/规划/hook 信号要先于 dispatch:start 判定。因为 TRAE 日志里
    // 工具调用、规划都发生在 do_chat:...:execute_task:start span 内，行里同样带有
    // execute_task:start 字样；若先判 dispatch 会把工具调用误判成 thinking。
    // 工具开始 → working
    const mStart = RE_TOOL_START.exec(line);
    if (mStart) {
      const toolName = mStart[1];
      t.lastTool = toolName;
      update(t, 'working', 'PreToolUse', { toolName });
      return true;
    }
    // 工具完成 → working（任务仍在执行，后续还有规划/下一工具）
    const mFinish = RE_TOOL_FINISH.exec(line);
    if (mFinish) {
      const status = String(mFinish[1]).toLowerCase();
      const toolName = t.lastTool || null;
      if (status === 'failed' || status === 'error') {
        update(t, 'error', 'PostToolUseFailure', { toolName });
      } else {
        update(t, 'working', 'PostToolUse', { toolName });
      }
      return true;
    }
    // hook=PreToolUse/PostToolUse 兜底信号
    if (/hook=PreToolUse/.test(line)) {
      const tm = /tool=([^\s,]+)/.exec(line);
      if (tm) t.lastTool = tm[1];
      update(t, 'working', 'PreToolUse', { toolName: t.lastTool || null });
      return true;
    }
    if (/hook=PostToolUse/.test(line)) {
      update(t, 'working', 'PostToolUse', { toolName: t.lastTool || null });
      return true;
    }
    // 规划阶段仍在跑
    if (RE_PLAN_FINAL.test(line) || RE_PLAN_FINISH.test(line)) {
      update(t, 'working', 'PostToolUse', { toolName: t.lastTool || null });
      return true;
    }
    // 任务/聊天开始 → thinking（同一 task_id 只发一次，避免 dispatch 链路重复打）
    if (RE_CHAT_DISPATCH.test(line) && /:start/.test(line)) {
      const tm = RE_TASK.exec(line);
      const taskId = tm ? tm[1] : '';
      if (taskId && t.lastTaskId === taskId) return true; // 同一任务已发过，仍是活动行
      t.lastTaskId = taskId || t.lastTaskId;
      update(t, 'thinking', 'UserPromptSubmit');
      return true;
    }
    // 其余 do_chat 相关行（流式、内部派发）也是活动信号，但不主动发事件，
    // 避免降级正在跑的工具；靠返回 true 维持 working 计时器。
    return true;
  }

  function backfill(t, size, mtimeMs) {
    // 历史不回放，只静默入库
    t.offset = size;
    cursors.set(t.fp, { offset: size, carry: '' });
    // 从尾部探测一次 session_id / cwd，让会话能正确建档。
    // renderer.log 的 sid/cwd 是 JSON 键值对，与 ai-agent 的 key=value 格式不同。
    const isRenderer = t.kind === 'renderer';
    const sidRe = isRenderer ? RE_R_SID : RE_SESSION;
    const cwdRe = isRenderer ? RE_R_CWD : RE_REPO;
    const start = Math.max(0, size - TAIL_PROBE_BYTES);
    const tail = readBytes(t.fp, start, size - start);
    if (tail) {
      const lines = tail.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      // 从尾部往前找最后一个带 session_id 的行
      for (let i = lines.length - 1; i >= 0; i--) {
        const sid = isRenderer ? rendererSessionId(tailJson(lines[i])) : (sidRe.exec(lines[i]) || [])[1];
        if (sid) { t.sid = sid; break; }
      }
      // cwd 从尾部找
      for (let i = lines.length - 1; i >= 0; i--) {
        if (isRenderer && rendererSessionId(tailJson(lines[i])) !== t.sid) continue;
        const repo = cwdRe.exec(lines[i]);
        if (repo) {
          t.cwd = isRenderer ? (unquoteJson(repo[1]) || t.cwd) : repo[1];
          if (t.cwd) break;
        }
      }
      // 标题（仅 renderer.log 有）：从尾部往前找第一个非空 title
      if (isRenderer) {
        for (let i = lines.length - 1; i >= 0 && !t.title; i--) {
          if (rendererSessionId(tailJson(lines[i])) !== t.sid || !RE_R_SESSION_LIFE.test(lines[i])) continue;
          const title = RE_R_TITLE.exec(lines[i]);
          if (title) t.title = unquoteJson(title[1]) || null;
        }
      }
    }
    if (!t.sid) return; // 找不到 session_id，不建档
    if (isRenderer) t.sessions.set(t.sid, { ...newTracker(t.fp), sid: t.sid, cwd: t.cwd, title: t.title });
    core.seedSession({
      id: t.sid,
      agentId: 'trae',
      cwd: t.cwd || '',
      transcriptPath: t.fp,
      sessionTitle: t.title || null,
      contextUsage: null,
      sourcePid: null,
      headless: false,
      createdAt: mtimeMs,
      updatedAt: mtimeMs,
    });
  }

  function pump(t, size) {
    if (size < t.offset) { t.offset = 0; t.carry = ''; }
    if (size <= t.offset) return false;
    const len = Math.min(size - t.offset, MAX_READ_PER_TICK);
    const chunk = readBytes(t.fp, t.offset, len);
    if (!chunk) return false;
    t.offset += chunk.length;
    const text = t.carry + chunk.toString('utf8');
    const lines = text.split('\n');
    t.carry = lines.pop() || '';
    let sawActivity = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        // 只有「有意义」的活动行才刷新 idle 计时器；后台行（toolhost/rpc 等）不算
        if (handleLine(t, line)) sawActivity = true;
      } catch {}
    }
    cursors.set(t.fp, { offset: t.offset, carry: t.carry });
    return sawActivity;
  }

  function newTracker(fp, cursor) {
    return {
      fp, sid: null, offset: cursor ? cursor.offset : 0, carry: cursor ? cursor.carry : '',
      cwd: null, model: null, lastTool: null, lastTaskId: null,
      lastActivityAt: 0,
      // renderer.log (TRAE 0.1.64+) 专用：会话标题、已发过的计划项去重表
      kind: /renderer\.log$/.test(fp) ? 'renderer' : 'agent',
      title: null,
      toolItems: new Map(),
      sessions: new Map(),
    };
  }

  function tick() {
    const now = Date.now();
    const fullSweep = !booted || (tickCount % FULL_SWEEP_TICKS === 0);
    tickCount++;
    const tsDirs = listTsDirs(roots);
    if (!tsDirs.length) {
      if (!missingLogged) missingLogged = true;
      return;
    }
    if (missingLogged) missingLogged = false;

    // 收集候选文件：最近 HOT_DIRS 个目录里的 ai-agent stdout + window*/renderer.log
    const found = [];
    const hotDirs = tsDirs.slice(0, HOT_DIRS);
    for (const { dir } of hotDirs) {
      for (const e of listAgentLogs(dir)) found.push(e);
      for (const e of listRendererLogs(dir)) found.push(e);
    }
    if (fullSweep) {
      // 全量兜底：长寿会话可能写在较早目录里
      const seen = new Set(found.map((f) => f.fp));
      for (const { dir } of tsDirs) {
        if (hotDirs.includes(dir)) continue;
        for (const e of listAgentLogs(dir)) if (!seen.has(e.fp)) found.push(e);
        for (const e of listRendererLogs(dir)) if (!seen.has(e.fp)) found.push(e);
      }
    }

    // ① 新文件 → 建 tracker
    for (const { fp, size, mtimeMs } of found) {
      if (trackers.has(fp)) continue;
      // 太旧且没在写的跳过
      if (now - mtimeMs > RETIRE_AFTER_SILENCE_MS) continue;
      const prior = booted ? cursors.get(fp) : null;
      const t = newTracker(fp, prior);
      trackers.set(fp, t);
      if (!booted) {
        backfill(t, size, mtimeMs);
      } else if (prior) {
        if (t.offset > size) { t.offset = size; t.carry = ''; }
      } else {
      }
    }

    // ② 泵所有已跟踪文件
    for (const [fp, t] of trackers) {
      let st;
      try { st = fs.statSync(fp); } catch { trackers.delete(fp); continue; }
      const ageSinceWrite = now - st.mtimeMs;
      // 退场：太久没写
      if (ageSinceWrite > RETIRE_AFTER_SILENCE_MS) {
        cursors.set(fp, { offset: t.offset, carry: t.carry });
        // 让会话自然走 core 的 stale 回收，不主动删
        trackers.delete(fp);
        continue;
      }
      const sawActivity = pump(t, st.size);
      // 只有有意义的活动才刷新计时器；文件因后台行（toolhost/rpc 等）增长不算，
      // 否则 TRAE 空闲时打工喵会永远停在 working 状态。
      if (sawActivity) {
        t.lastActivityAt = now;
      }
      t.lastSize = st.size;

      // 静默超时：从 working/thinking 降回 idle
      if (t.kind === 'renderer') {
        for (const [sid, session] of t.sessions) {
          const silence = now - session.lastActivityAt;
          // Explicit renderer lifecycle events own completion. An 8-second
          // gap is normal during thinking, long tools and approval waits.
          if (silence > RETIRE_AFTER_SILENCE_MS && session.state !== 'notification') {
            t.sessions.delete(sid);
          }
        }
      } else if (t.sid && t.lastActivityAt) {
        const silent = now - t.lastActivityAt;
        if (silent > IDLE_AFTER_SILENCE_MS) {
          // 只发一次 idle，不重复打
          update(t, 'idle', 'TraeIdle');
          t.lastActivityAt = 0; // 避免重复触发；下次有活动会重新设
        }
      }
    }
    booted = true;
  }

  function start() {
    if (timer) return;
    try { tick(); } catch {}
    timer = setInterval(() => { try { tick(); } catch {} }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function isRunning() { return !!timer; }

  return { start, stop, isRunning, tick, _trackers: trackers, _cursors: cursors };
}

module.exports = { createTraeWatch, candidateLogRoots };
