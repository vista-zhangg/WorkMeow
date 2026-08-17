// 打工喵 WorkMeow — opencode 状态/用量插件（自包含，无任何外部依赖）。
//
// 由 opencode-install.js 复制到 ~/.config/opencode/plugins/opencode-plugin.js
// 后，opencode 的插件运行时（Bun）会自动加载并调用导出对象上的钩子。
//
// 职责：
//   1. 把 opencode 事件流翻译成打工喵 /state 协议（POST 127.0.0.1:<port>/state，
//      身份头 x-workmeow-token，端口/令牌读自 ~/.workmeow/runtime.json）；
//   2. 每个完成的 assistant 消息把用量行追加写入
//      ~/.workmeow/opencode-usage.jsonl，供打工喵 opencode-metering 增量读取。
//
// 铁律（与 workmeow-hook.js 一致）：永远不抛错、永远不阻塞 agent —— 所有
// 失败（宠物没开、端口变化、磁盘异常）都静默吞掉。插件是给 agent 用的，
// 任何异常都只能由打工喵自己兜底，绝不能反过来拖慢/弄崩 opencode。
//
// marker: workmeow-opencode-plugin

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const AGENT_ID = 'opencode';
const WORKMEOW_DIR = path.join(os.homedir(), '.workmeow');
const RUNTIME_PATH = path.join(WORKMEOW_DIR, 'runtime.json');
const USAGE_PATH = path.join(WORKMEOW_DIR, 'opencode-usage.jsonl');
const STATE_PATH = '/state';
const TOKEN_HEADER = 'x-workmeow-token';
const POST_TIMEOUT_MS = 500;
const LAST_OUTPUT_MAX = 2400;   // 与 server 的 ASSISTANT_LAST_OUTPUT_MAX 对齐
const MAX_BODY_BYTES = 16384;   // 与 server 的 MAX_STATE_BODY_BYTES 对齐
const TURN_LOOKBACK_MS = 90000; // session.idle 多久内算「刚完成一轮」

// opencode 工具类型 → 打工喵词汇（未知类型原样首字母大写兜底）。
const TOOL_NAMES = {
  command: 'Bash',
  shell: 'Bash',
  bash: 'Bash',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  web: 'Web',
  search: 'Search',
  todo: 'Todo',
  plan: 'Plan',
  agent: 'Agent',
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function readRuntime() {
  try {
    const obj = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
    const port = Number(obj && obj.port);
    const token = typeof (obj && obj.token) === 'string' && /^[a-f0-9]{48,128}$/i.test(obj.token) ? obj.token : '';
    return obj && obj.app === 'workmeow' && Number.isInteger(port) && token ? { port, token } : null;
  } catch {
    return null;
  }
}

// 尽力而为的 POST：异步、快速放弃，绝不阻塞。
function postState(body) {
  const runtime = readRuntime();
  if (!runtime) return;
  let payload = '';
  try {
    payload = JSON.stringify(body);
    // Never cut serialized JSON. Bound optional display fields until the exact
    // UTF-8 payload fits the server contract; identity fields stay intact.
    if (Buffer.byteLength(payload, 'utf8') > MAX_BODY_BYTES) {
      const bounded = { ...body };
      if (typeof bounded.assistant_last_output === 'string') bounded.assistant_last_output = bounded.assistant_last_output.slice(-1200);
      if (typeof bounded.session_title === 'string') bounded.session_title = bounded.session_title.slice(0, 240);
      if (typeof bounded.cwd === 'string') bounded.cwd = bounded.cwd.slice(0, 1024);
      if (typeof bounded.api_error_type === 'string') bounded.api_error_type = bounded.api_error_type.slice(0, 240);
      payload = JSON.stringify(bounded);
      if (Buffer.byteLength(payload, 'utf8') > MAX_BODY_BYTES) return;
    }
  } catch { return; }
  let req;
  try {
    req = http.request(
      {
        hostname: '127.0.0.1',
        port: runtime.port,
        path: STATE_PATH,
        method: 'POST',
        timeout: POST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          [TOKEN_HEADER]: runtime.token,
        },
      },
      (res) => { try { res.resume(); } catch {} }
    );
  } catch { return; }
  req.on('error', () => {});
  req.on('timeout', () => { try { req.destroy(); } catch {} });
  try { req.end(payload); } catch {}
}

function appendUsage(line) {
  try {
    fs.mkdirSync(WORKMEOW_DIR, { recursive: true });
    fs.appendFileSync(USAGE_PATH, JSON.stringify(line) + '\n');
  } catch {}
}

// 事件负载：opencode 各事件的 properties 形状不同，统一安全取对象。
function eventInfo(ev) {
  const p = (ev && ev.properties && typeof ev.properties === 'object') ? ev.properties : {};
  const info = (p.info && typeof p.info === 'object') ? p.info : p;
  return { p, info };
}

function toolName(tool) {
  const t = str(tool && tool.type);
  return TOOL_NAMES[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Tool');
}

export const WorkMeowOpenCodePlugin = async ({ directory }) => {
  const sessions = new Map();        // sessionID -> { cwd, title, model }
  const lastTurnAt = new Map();      // sessionID -> 最近一次回合活动 ms
  const lastRoleBySession = new Map(); // sessionID -> 最近 message.updated 的 role
  const userText = new Map();        // sessionID -> 待用的最近用户文本（标题兜底）
  const outputTail = new Map();      // sessionID -> assistant 文本尾部
  const loggedMessages = new Set();  // 已写 usage 的 message id
  const seenMessageIds = new Set();  // 见过的 message id（opencode 会话重载会重放
                                     // 既有消息的 message.updated，重放不算新回合）
  const stoppedMessageIds = new Set(); // 已发过 Stop 的 assistant message id
  let lastPostKey = '';
  let lastPostAt = 0;
  const MAX_TRACKED_IDS = 20000;
  const IDLE_SESSION_MS = 6 * 60 * 60 * 1000;

  function remember(set, id) {
    if (!id) return;
    set.add(id);
    while (set.size > MAX_TRACKED_IDS) set.delete(set.values().next().value);
  }

  function dropSession(sid) {
    sessions.delete(sid);
    lastTurnAt.delete(sid);
    lastRoleBySession.delete(sid);
    userText.delete(sid);
    outputTail.delete(sid);
  }

  function touchSession(sid) {
    if (!sid) return;
    const meta = sessions.get(sid) || { cwd: str(directory) };
    meta.touchedAt = Date.now();
    sessions.set(sid, meta);
  }

  function pruneSessions(now = Date.now()) {
    for (const [sid, meta] of sessions) {
      const at = Math.max(num(meta && meta.touchedAt), num(lastTurnAt.get(sid)));
      if (now - at > IDLE_SESSION_MS) dropSession(sid);
    }
  }

  function post(state, event, extra) {
    try {
      const sessionID = str(extra.session_id);
      if (!sessionID) return;
      touchSession(sessionID);
      const meta = sessions.get(sessionID) || {};
      const body = { state, event, session_id: sessionID, agent_id: AGENT_ID };
      if (extra.cwd || meta.cwd) body.cwd = extra.cwd || meta.cwd;
      if (extra.model || meta.model) body.model = extra.model || meta.model;
      if (extra.session_title || meta.title) body.session_title = extra.session_title || meta.title;
      if (extra.tool_name) body.tool_name = extra.tool_name;
      if (extra.api_error_type) body.api_error_type = extra.api_error_type;
      const tail = outputTail.get(sessionID);
      if (tail) body.assistant_last_output = tail.length > LAST_OUTPUT_MAX ? tail.slice(-LAST_OUTPUT_MAX) : tail;
      // 相同 session+state+event 300ms 内去重（session.idle 等会连发）。
      const key = `${sessionID}|${state}|${event}`;
      const now = Date.now();
      if (key === lastPostKey && now - lastPostAt < 300) return;
      lastPostKey = key;
      lastPostAt = now;
      postState(body);
    } catch {}
  }

  function logUsage(sid, msg) {
    try {
      const id = str(msg.id);
      if (!id || loggedMessages.has(id)) return;
      const tokens = msg.tokens && typeof msg.tokens === 'object' ? msg.tokens : null;
      const cost = num(msg.cost);
      if (cost <= 0 && !tokens) return; // 无任何用量信息，无从记
      remember(loggedMessages, id);
      const cache = tokens && tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
      appendUsage({
        v: 1,
        ts: Date.now(),
        session_id: sid,
        message_id: id,
        model: str(msg.modelID) || 'unknown',
        provider: str(msg.providerID) || '',
        cost: cost > 0 ? cost : undefined,
        tokens: tokens ? {
          input: num(tokens.input),
          output: num(tokens.output),
          reasoning: num(tokens.reasoning),
          cacheRead: num(cache.read),
          cacheWrite: num(cache.write),
        } : undefined,
      });
    } catch {}
  }

  function onEvent(input) {
    try {
      const ev = (input && input.event) || {};
      const type = str(ev.type);
      const { p, info } = eventInfo(ev);
      pruneSessions();

      if (type === 'session.deleted') {
        const sid = str(info.id) || str(p.sessionID) || str(p.session_id);
        if (sid) dropSession(sid);
        return;
      }

      if (type === 'session.created' || type === 'session.updated') {
        const sid = str(info.id);
        if (!sid) return;
        const prev = sessions.get(sid) || {};
        const meta = {
          cwd: str(info.directory) || prev.cwd || '',
          title: str(info.title) || prev.title || '',
          model: prev.model || '',
          touchedAt: Date.now(),
        };
        sessions.set(sid, meta);
        if (type === 'session.created') {
          post('idle', 'SessionStart', { session_id: sid });
        }
        return;
      }

      if (type === 'message.updated') {
        const sid = str(info.sessionID) || str(info.session_id);
        if (!sid) return;
        touchSession(sid);
        const role = str(info.role);
        if (role) lastRoleBySession.set(sid, role);
        if (role === 'user') {
          // 重放守卫：opencode 在会话重新加载/同步时会重放既有消息的
          // message.updated，其中最后一条（用户消息）会把回合结束后的状态
          // 钉死在 thinking。只有从未见过的消息 id 才算新回合。
          const uid = str(info.id);
          if (uid && seenMessageIds.has(uid)) return;
          remember(seenMessageIds, uid);
          const title = str(info.title) || (userText.get(sid) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          userText.delete(sid);
          post('thinking', 'UserPromptSubmit', { session_id: sid, session_title: title });
          return;
        }
        if (role === 'assistant') {
          const model = str(info.modelID);
          if (model) {
            const meta = sessions.get(sid);
            if (meta) meta.model = model;
          }
          lastTurnAt.set(sid, Date.now());
          if (info.error && typeof info.error === 'object') {
            post('error', 'StopFailure', { session_id: sid, api_error_type: str(info.error.type || info.error.message) || 'error' });
          } else if (info.finish) {
            // 同一消息的 finish 可能重放（如流式补发/会话重载）：usage 与
            // Stop 都只发一次。
            const aid = str(info.id);
            if (aid && stoppedMessageIds.has(aid)) return;
            remember(stoppedMessageIds, aid);
            logUsage(sid, info);
            post('attention', 'Stop', { session_id: sid });
          }
        }
        return;
      }

      if (type === 'message.part.updated') {
        // TextPart 全文流式到达：只缓存尾部，不 POST（避免刷屏）。
        const part = (p.part && typeof p.part === 'object') ? p.part : p;
        const text = str(part.text || (part.part && part.part.text));
        if (!text) return;
        const sid = str(part.sessionID) || str(p.sessionID) || '';
        if (!sid) return;
        touchSession(sid);
        // 会话开头（尚无 message.updated）的文本默认属于用户 prompt。
        if (lastRoleBySession.get(sid) !== 'assistant') {
          userText.set(sid, ((userText.get(sid) || '') + text).slice(-LAST_OUTPUT_MAX * 4));
        } else {
          outputTail.set(sid, (outputTail.get(sid) || '') + text);
          // 只留 LAST_OUTPUT_MAX 的几倍，防内存无限增长。
          if (outputTail.get(sid).length > LAST_OUTPUT_MAX * 4) {
            outputTail.set(sid, outputTail.get(sid).slice(-LAST_OUTPUT_MAX * 4));
          }
        }
        return;
      }

      if (type === 'session.idle') {
        const sid = str(p.sessionID) || str(info.id) || '';
        if (!sid) return;
        // 一轮刚结束（assistant finish 已发过 Stop 或 90 秒内有回合活动）→ 收尾；
        // 纯空闲（启动/等待权限/改标题）不打扰。
        const last = lastTurnAt.get(sid) || 0;
        if (last > 0 && Date.now() - last < TURN_LOOKBACK_MS) {
          post('attention', 'Stop', { session_id: sid });
        }
        return;
      }

      if (type === 'session.compacted') {
        const sid = str(p.sessionID) || str(info.id) || '';
        if (sid) post('sweeping', 'PreCompact', { session_id: sid });
        return;
      }

      if (type === 'session.error') {
        const sid = str(p.sessionID) || str(info.id) || '';
        const err = str((info.error && info.error.message) || p.error) || 'session error';
        if (sid) post('error', 'StopFailure', { session_id: sid, api_error_type: err });
        return;
      }

      if (type === 'permission.updated') {
        const sid = str(p.sessionID) || str(info.sessionID) || str(info.id) || '';
        if (sid) post('notification', 'Notification', { session_id: sid });
        return;
      }

      if (type === 'permission.replied') {
        const sid = str(p.sessionID) || str(info.sessionID) || '';
        if (sid) post('thinking', 'UserPromptSubmit', { session_id: sid });
      }
    } catch {}
  }

  function onToolExec(after) {
    return (input) => {
      try {
        const sid = str(input && (input.sessionID || input.session_id));
        if (!sid) return;
        const name = toolName(input && input.tool);
        post('working', after ? 'PostToolUse' : 'PreToolUse', { session_id: sid, tool_name: name });
      } catch {}
    };
  }

  return {
    event: onEvent,
    'tool.execute.before': onToolExec(false),
    'tool.execute.after': onToolExec(true),
    dispose: () => {
      sessions.clear(); lastTurnAt.clear(); lastRoleBySession.clear();
      userText.clear(); outputTail.clear(); loggedMessages.clear();
      seenMessageIds.clear(); stoppedMessageIds.clear();
    },
  };
};
