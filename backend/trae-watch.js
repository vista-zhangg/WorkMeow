'use strict';

// TRAE SOLO CN 日志监听器 —— 把 ai-agent stdout 日志翻译成 core 的状态流。
//
// 为什么走「读日志」而不是钩子：TRAE SOLO CN 的内置 agent 是 Rust 原生模块
// (ai_agent.dll)，不是 Claude Code CLI，不读 ~/.claude/settings.json 也不读
// ~/.trae-cn/hooks.json。唯一可靠的活动信号源是它写到
// %APPDATA%/TRAE SOLO CN/logs/<ts>/Modular/ai-agent_*_stdout.log 的 Rust tracing
// 日志。每行都带 session_id=xxx、task_id=xxx、message_id=xxx，且工具生命周期
// 用 hook=PreToolUse / hook=PostToolUse 标记——正好对应打工喵的词汇。
//
// 与 codex-watch 不同：TRAE 日志是 Rust tracing 文本（非结构化 JSONL），所以
// 用正则识别关键事件而非 JSON.parse。信号覆盖：
//   do_chat:slardar_root:dispatch:execute_task:start   → thinking（用户发了消息/任务开始）
//   [ToolcallService] Start run tool "X"               → working（PreToolUse）
//   [ToolcallService] Run tool X finished, status:     → working（PostToolUse，任务仍在执行）
//   hook=PreToolUse / hook=PostToolUse                 → working（兜底工具信号）
//   execute_task:start                                  → thinking
//   plan tool call finish                              → working
//   plan final token cost                              → working（规划阶段仍在跑）
//
// 状态降级：文件停止增长 8 秒 → idle（TRAE 日志是事项完成才落盘，停写即停工，
// 不像 Claude transcript 会持续流式追加）。会话陈旧 10 分钟 → 退场。
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

function parseTs(line) {
  const m = RE_TS.exec(line);
  if (!m) return 0;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : 0;
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
    core.updateSession(t.sid, state, event, { ...baseFields(t), ...extra });
  }

  // 从一行日志提取信号，转成 core 事件。返回 true 表示这是「有意义的活动行」
  // （chat 派发 / 工具调用 / 规划 / hook），用于驱动 idle 降级计时器；后台行
  // （toolhost/rpc/tenant_config 等）不匹配任何信号，返回 false。
  function handleLine(t, line) {
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
    // 从尾部探测一次 session_id / cwd，让会话能正确建档
    const start = Math.max(0, size - TAIL_PROBE_BYTES);
    const tail = readBytes(t.fp, start, size - start);
    if (tail) {
      const lines = tail.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      // 从尾部往前找最后一个带 session_id 的行
      for (let i = lines.length - 1; i >= 0; i--) {
        const sid = RE_SESSION.exec(lines[i]);
        if (sid) { t.sid = sid[1]; break; }
      }
      // cwd 从尾部找
      for (let i = lines.length - 1; i >= 0; i--) {
        const repo = RE_REPO.exec(lines[i]);
        if (repo) { t.cwd = repo[1]; break; }
      }
    }
    if (!t.sid) return; // 找不到 session_id，不建档
    core.seedSession({
      id: t.sid,
      agentId: 'trae',
      cwd: t.cwd || '',
      transcriptPath: t.fp,
      sessionTitle: null,
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

    // 收集候选文件：最近 HOT_DIRS 个目录里的 ai-agent stdout
    const found = [];
    const hotDirs = tsDirs.slice(0, HOT_DIRS);
    for (const { dir } of hotDirs) {
      for (const e of listAgentLogs(dir)) found.push(e);
    }
    if (fullSweep) {
      // 全量兜底：长寿会话可能写在较早目录里
      const seen = new Set(found.map((f) => f.fp));
      for (const { dir } of tsDirs) {
        if (hotDirs.includes(dir)) continue;
        for (const e of listAgentLogs(dir)) if (!seen.has(e.fp)) found.push(e);
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
      if (t.sid && t.lastActivityAt) {
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

  return { start, stop, tick, _trackers: trackers, _cursors: cursors };
}

module.exports = { createTraeWatch, candidateLogRoots };
