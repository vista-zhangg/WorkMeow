'use strict';

// Notification 语义隔离回归测试。
//
// 背景（真实缺陷）：WorkBuddy / CodeBuddy 的 SessionManager.resetIdleTimer 每个
// 会话挂一个 60s 定时器，会话仍然空闲就发
//   Notification { message:"CodeBuddy is waiting for your input",
//                  notification_type:"idle_prompt" }
// 桌宠把所有 Notification 一律当「等你回复」，而 notification 又被排除在
// oneshot 衰减之外 —— 于是每个「已经结束」的 WorkBuddy 会话都会在 60 秒后
// 变成等待回复并永久卡住。这组用例锁死修复后的分流行为。
//
// Run: node test/notify-policy.js

const assert = require('assert');
const notify = require('../backend/notify-policy');
const { buildBody, EVENT_STATE } = require('../backend/hook-common');
const { createCore, deriveBadge } = require('../backend/core');
const { buildPetStats } = require('../backend/adapter');
const { SHORT_KEYS, agentId } = require('../shared/agents');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

const notifBody = (agent, payload) => buildBody('Notification', { session_id: 's1', ...payload }, agent);

console.log('[N0] 每个工具都必须显式声明 Notification 语义');
{
  check('注册表覆盖 shared/agents.js 的全部工具', () => {
    const missing = SHORT_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(notify.AGENT_NOTIFY, k));
    assert.deepStrictEqual(missing, [], '未声明语义的工具会静默继承 Claude 语义：' + missing.join(','));
  });
  check('只有 WorkBuddy 声明了 notification_type 词表', () => {
    assert.deepStrictEqual(notify.notificationTypes('workbuddy'), {
      permission_prompt: 'blocking',
      elicitation_dialog: 'blocking',
      idle_prompt: 'idle',
      auth_success: 'info',
    });
    assert.strictEqual(notify.notificationTypes('claude'), null);
  });
  check('未知工具兜底为 blocking（宁可误报也不吞掉真实等待）', () => {
    assert.strictEqual(notify.classifyNotification({ agentKey: 'nope', message: '' }), notify.BLOCKING);
  });
}

console.log('[N1] WorkBuddy：notification_type 权威分流');
{
  const c = (t, msg) => notify.classifyNotification({ agentKey: 'workbuddy', notificationType: t, message: msg });
  check('idle_prompt → idle（60 秒空闲定时器，不是等你回复）',
    () => assert.strictEqual(c('idle_prompt', 'CodeBuddy is waiting for your input'), notify.IDLE));
  check('auth_success → info（登录提示，完全不该动桌宠）',
    () => assert.strictEqual(c('auth_success', 'auth_success: 张三'), notify.INFO));
  check('permission_prompt → blocking',
    () => assert.strictEqual(c('permission_prompt', ''), notify.BLOCKING));
  check('elicitation_dialog → blocking',
    () => assert.strictEqual(c('elicitation_dialog', ''), notify.BLOCKING));
  check('大小写/空格不影响判定',
    () => assert.strictEqual(c('  IDLE_PROMPT ', ''), notify.IDLE));
}

console.log('[N2] Claude / TRAE：无 notification_type，退回消息文本');
{
  const c = (agent, msg) => notify.classifyNotification({ agentKey: agent, message: msg });
  check('Claude「is waiting for your input」→ idle',
    () => assert.strictEqual(c('claude', 'Claude is waiting for your input'), notify.IDLE));
  check('Claude「needs your permission to use Bash」→ blocking',
    () => assert.strictEqual(c('claude', 'Claude needs your permission to use Bash'), notify.BLOCKING));
  check('中文「等待你的输入」→ idle',
    () => assert.strictEqual(c('trae', '等待你的输入'), notify.IDLE));
  check('中文「需要你的授权」→ blocking',
    () => assert.strictEqual(c('trae', '需要你的授权'), notify.BLOCKING));
  check('TRAE 无法归类 → blocking',
    () => assert.strictEqual(c('trae', 'something unexpected'), notify.BLOCKING));
  check('Claude 即使误带 idle_prompt 字段也走文本（它没有该词表）',
    () => assert.strictEqual(
      notify.classifyNotification({ agentKey: 'claude', notificationType: 'idle_prompt', message: 'needs your permission' }),
      notify.BLOCKING));
}

console.log('[N3] hook 层：噪声不出网，空闲改名 IdleNotification');
{
  check('WorkBuddy auth_success 整条丢弃（不发 HTTP）', () => {
    assert.strictEqual(notifBody('workbuddy', { notification_type: 'auth_success', message: 'auth_success: x' }), null);
  });
  check('WorkBuddy idle_prompt → state=idle / event=IdleNotification', () => {
    const b = notifBody('workbuddy', { notification_type: 'idle_prompt', message: 'CodeBuddy is waiting for your input' });
    assert.strictEqual(b.state, 'idle');
    assert.strictEqual(b.event, 'IdleNotification');
    assert.strictEqual(b.agent_id, 'workbuddy');
  });
  check('WorkBuddy permission_prompt → 仍是 notification 且带上分类标签', () => {
    const b = notifBody('workbuddy', { notification_type: 'permission_prompt', message: '' });
    assert.strictEqual(b.state, 'notification');
    assert.strictEqual(b.event, 'Notification');
    assert.strictEqual(b.notification_type, 'permission_prompt');
  });
  check('Claude 空闲提醒同样降级（同一个 60 秒定时器坑）', () => {
    const b = notifBody('claude-code', { message: 'Claude is waiting for your input' });
    assert.strictEqual(b.event, 'IdleNotification');
  });
  check('Elicitation 事件不参与分类，永远是等你回复', () => {
    const b = buildBody('Elicitation', { session_id: 's1' }, 'workbuddy');
    assert.strictEqual(b.state, 'notification');
    assert.strictEqual(b.event, 'Elicitation');
  });
  check('ElicitationResult 已进入事件表（用户答完 → 恢复干活）', () => {
    assert.strictEqual(EVENT_STATE.ElicitationResult, 'thinking');
    const b = buildBody('ElicitationResult', { session_id: 's1' }, 'workbuddy');
    assert.strictEqual(b.state, 'thinking');
  });
  check('无 session_id 一律丢弃（不伪造幽灵会话）', () => {
    assert.strictEqual(buildBody('Notification', { notification_type: 'permission_prompt' }, 'workbuddy'), null);
  });
}

console.log('[N4] core：IdleNotification 只软着陆，不污染徽标');
{
  const core = createCore({});
  const F = { agentId: 'workbuddy' };

  check('未知会话不会被空闲提醒凭空创建', () => {
    core.updateSession('ghost', 'idle', 'IdleNotification', F);
    assert.strictEqual(core.getSession('ghost'), null);
  });

  check('回合结束后的空闲提醒不会变成「等你回复」，完成徽标保留', () => {
    core.updateSession('a', 'thinking', 'UserPromptSubmit', F);
    core.updateSession('a', 'attention', 'Stop', F);
    const before = core.getSession('a');
    assert.strictEqual(deriveBadge(before), 'done');
    core.updateSession('a', 'idle', 'IdleNotification', F);
    const after = core.getSession('a');
    assert.strictEqual(after.state, 'idle');
    assert.strictEqual(deriveBadge(after), 'done', '完成徽标被空闲提醒吃掉了');
    assert.strictEqual(after.requiresCompletionAck, true);
  });

  check('中断徽标也不会被空闲提醒抹掉', () => {
    core.updateSession('b', 'thinking', 'UserPromptSubmit', F);
    core.updateSession('b', 'error', 'StopFailure', F);
    core.updateSession('b', 'idle', 'IdleNotification', F);
    assert.strictEqual(deriveBadge(core.getSession('b')), 'interrupted');
  });

  check('卡死的 working 会被空闲提醒软着陆到 idle', () => {
    core.updateSession('c', 'working', 'PreToolUse', F);
    assert.strictEqual(core.getSession('c').state, 'working');
    core.updateSession('c', 'idle', 'IdleNotification', F);
    assert.strictEqual(core.getSession('c').state, 'idle');
  });

  check('真实的 notification 不会被随后的空闲提醒清掉（弹窗开着本来就空闲）', () => {
    core.updateSession('d', 'notification', 'Notification', { ...F, notificationType: 'elicitation_dialog' });
    core.updateSession('d', 'idle', 'IdleNotification', F);
    const s = core.getSession('d');
    assert.strictEqual(s.state, 'notification');
    assert.strictEqual(s.notificationType, 'elicitation_dialog');
  });

  check('用户答完（ElicitationResult）立即解除等待', () => {
    core.updateSession('d', 'thinking', 'ElicitationResult', F);
    const s = core.getSession('d');
    assert.strictEqual(s.state, 'thinking');
    assert.strictEqual(s.notificationType, null);
  });

  check('空闲提醒不刷新 updatedAt（会话确实已经闲了这么久）', () => {
    core.updateSession('e', 'working', 'PreToolUse', F);
    const at = core.getSession('e').updatedAt;
    core.updateSession('e', 'idle', 'IdleNotification', F);
    assert.strictEqual(core.getSession('e').updatedAt, at);
  });
}

console.log('[N5] 端到端：hook 载荷 → core → 面板会话行');
{
  const core = createCore({});
  const feed = (event, payload, agent) => {
    const b = buildBody(event, { session_id: 'x', cwd: '/tmp/demo', ...payload }, agent);
    if (!b) return false;
    core.updateSession(b.session_id, b.state, b.event, {
      agentId: b.agent_id ? agentId(b.agent_id === 'workbuddy' ? 'workbuddy' : 'claude') : 'workbuddy',
      cwd: b.cwd,
      notificationType: b.notification_type || null,
    });
    return true;
  };
  const rowState = () => buildPetStats(core.buildSnapshot(), [], null, {}).sessions[0].state;

  feed('UserPromptSubmit', {}, 'workbuddy');
  feed('Stop', {}, 'workbuddy');
  check('回合结束 → 面板 idle', () => assert.strictEqual(rowState(), 'idle'));

  const sent = feed('Notification', { notification_type: 'idle_prompt' }, 'workbuddy');
  check('60 秒空闲提醒仍然上报（用于软着陆）', () => assert.strictEqual(sent, true));
  check('面板不会冒出「等你回复」（本次缺陷的正靶）',
    () => assert.strictEqual(rowState(), 'idle'));
  check('needsinputCount 归零',
    () => assert.strictEqual(buildPetStats(core.buildSnapshot(), [], null, {}).needsinputCount, 0));

  feed('Notification', { notification_type: 'permission_prompt' }, 'workbuddy');
  check('真实授权请求依旧显示等你回复', () => assert.strictEqual(rowState(), 'needsinput'));
  check('needsinputCount = 1',
    () => assert.strictEqual(buildPetStats(core.buildSnapshot(), [], null, {}).needsinputCount, 1));
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
