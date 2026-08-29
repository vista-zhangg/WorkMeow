'use strict';

// Single source of truth for every user-visible string.
//
// Required by the main process (main.js, backend/adapter.js) and loaded as a
// <script> by the renderer (pet.html / panel.html → window.WorkMeowI18n), mirroring
// the shared/states.js UMD shim.
//
// Localized strings shared by the pet and detail panel.
//

// Placeholders use {name} and are substituted by t(key, vars).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkMeowI18n = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  const zh = {
    // ── tray ────────────────────────────────────────────────────────────────
    'tray.tooltip': '打工喵 WorkMeow — 盯所有 AI 工具的桌宠',
    'tray.panel': '详情面板',
    'tray.showPet': '显示打工喵',
    'tray.hidePet': '藏起打工喵',
    'tray.settings': '设置',
    'tray.integrations': 'AI 工具接入状态',
    'tray.uninstallHook': '卸载已安装的钩子和插件',
    'tray.quit': '退出',

    // ── dialogs ─────────────────────────────────────────────────────────────
    'dlg.dupTitle': '打工喵已在运行',
    'dlg.dupBody': '检测到另一个打工喵实例正在端口 {port} 上服务（可能来自其他代码副本）。\n',
    'dlg.dupHint': '本实例将退出，避免抢占会话事件。\n开发需要多开时：WORKMEOW_ALLOW_MULTI=1',
    'dlg.integrationsTitle': '打工喵已准备好',
    'dlg.integrationsMessage': '便携运行环境已经就绪',
    'dlg.integrationsReady': '已接入',
    'dlg.integrationsMissing': '未检测到，安装或首次使用后会自动接入',
    'dlg.integrationsFailed': '已检测到，但接入尚未完成',
    'dlg.integrationsHint': '无需安装 Node.js。以后可以从托盘菜单再次查看接入状态。',

    // ── settings ────────────────────────────────────────────────────────────
    'settings.title': '打工喵 · 设置',
    'settings.subtitle': '调整启动方式和每种状态的喵咪表情',
    'settings.generalTab': '常规',
    'settings.expressionsTab': '喵咪表情',
    'settings.startupSection': '启动设置',
    'settings.autoLaunchTitle': '开机自动启动',
    'settings.autoLaunchDescription': '登录 Windows 后自动运行打工喵',
    'settings.enabled': '已开启',
    'settings.disabled': '已关闭',
    'settings.saving': '保存中…',
    'settings.saved': '设置已更新',
    'settings.failed': '保存失败，请重试',
    'settings.unsupported': '当前系统不支持此设置',
    'settings.hint': '修改会立即生效，下次登录 Windows 时自动运行。',
    'settings.xiabanSection': '下班彩蛋',
    'settings.xiabanDescription': '在指定时间播放下班动画和提示语',
    'settings.lunchTime': '午间彩蛋',
    'settings.eveningTime': '晚间彩蛋',
    'settings.saveTime': '保存时间',
    'settings.resetTime': '恢复默认',
    'settings.timeSaving': '保存中…',
    'settings.timeSaved': '下班时间已更新',
    'settings.timeInvalid': '请输入有效的时间',
    'settings.timeSaveFailed': '下班时间保存失败，请重试',
    'settings.timeHint': '彩蛋持续 10 分钟，仅在打工喵空闲或休息时播放。',
    'settings.expressionsTitle': '自定义每一种喵咪状态',
    'settings.expressionsDescription': '选择状态和具体表情后，可以新增、替换或移出。导入后会自动透明化、等比缩放并适配到 120×120。',
    'settings.removeBackground': '自动清理纯色背景',
    'settings.allStates': '全部状态',
    'settings.allStatesHint': '点击卡片进行管理',
    'settings.addExpression': '＋ 新增',
    'settings.replaceExpression': '替换选中',
    'settings.removeExpression': '移出选中',
    'settings.addReplaceHint': '新增会保留当前列表；替换和移出只作用于选中的表情。每个状态至少保留一个表情。',
    'settings.currentExpressions': '当前播放列表',
    'settings.restoreStateDefault': '恢复这个状态的默认表情',
    'settings.close': '关闭',

    // ── waiting reasons ─────────────────────────────────────────────────────
    // 完整短语直接使用中文，避免把中文语序拆成两段。
    'wait.reply': '等你回复',
    'wait.plan': '等你审方案',
    'wait.perm': '等你授权',
    'wait.default': '等你处理',
    'reason.reply': '回复',
    'reason.plan': '审方案',
    'reason.perm': '授权',
    'reason.default': '处理',

    // ── session states ──────────────────────────────────────────────────────
    'state.working': '干活中',
    'state.juggling': '并行子任务',
    'state.sweeping': '清理上下文',
    'state.thinking': '思考中',
    'state.loafing': '摸鱼中',
    'state.loafingLong': '摸鱼中(等下一步)',
    'state.waiting': '等你处理',
    'state.needsinput': '等你回复',
    'state.error': '出错了',
    'state.done': '刚完成',
    'state.idle': '空闲',
    'state.sleeping': '休息中',
    'state.greet': '新会话',
    'state.talking': '回应中',

    // ── tool labels ─────────────────────────────────────────────────────────
    'tool.Edit': '编辑文件',
    'tool.Write': '写文件',
    'tool.NotebookEdit': '编辑笔记本',
    'tool.Read': '读取文件',
    'tool.Bash': '运行命令',
    'tool.Grep': '搜索代码',
    'tool.Glob': '查找文件',
    'tool.WebSearch': '联网搜索',
    'tool.WebFetch': '抓取网页',
    'tool.Task': '派出子 agent',
    'tool.TodoWrite': '更新待办',
    'tool.Js': '跑 JS 代码',
    'tool.Wait': '等命令输出',
    'tool.default': '处理中',

    // ── error bubbles ───────────────────────────────────────────────────────
    'err.rateLimit': '🚦 被限流了，稍等…',
    'err.server': '🌐 服务器开小差了，正在重试…',
    'err.billing': '💳 账单/额度异常',
    'err.auth': '🔑 鉴权失败',
    'err.model': '🤖 模型不可用',
    'err.maxTokens': '✂️ 输出超长被截断',
    'err.default': '😵 出了点状况，在想办法…',

    // ── permission / ask cards ──────────────────────────────────────────────
    'perm.runCommand': '运行命令：',
    'perm.editFile': '修改文件：',
    'perm.readFile': '读取文件：',
    'perm.fetchUrl': '抓取网页：',
    'perm.webSearch': '联网搜索：',
    'perm.needsApproval': ' 需要授权',
    'perm.modePlan': '🅿️ 切到计划模式',
    'perm.modeAcceptEdits': '✍️ 自动接受编辑',
    'perm.modeOther': '设为 ',
    'perm.alwaysAllow': '🔓 始终允许：',
    'perm.thisAction': '此操作',
    'perm.allow': '✅ 允许',
    'perm.deny': '⛔ 拒绝',
    'perm.planHeader': '方案评审',
    'perm.planQuestion': '请审阅这个方案',
    'perm.planApprove': '✅ 批准方案',
    'perm.askQuestion': '需要你回答',
    'perm.continueQuestion': '{who} 在等你回复',

    // ── ask panel (renderer) ────────────────────────────────────────────────
    'ask.needAnswer': '需要你回答',
    'ask.multiHint': '可多选（点选多个）',
    'ask.singleHint': '单选一项',
    'ask.placeholder': '输入自定义回答…',
    'ask.emptyWarn': '⚠️ 还没输入内容，是不是忘了填？',
    'ask.submitted': '✅ 已提交回答',
    'ask.needPerm': '需要授权',
    'ask.needPermQ': '需要你授权',
    'ask.waitingReply': 'Claude 在等你回复',
    'ask.planLabel': '方案评审',
    'ask.planQ': '请审阅这个方案',
    'ask.approve': '✅ 批准方案',
    'ask.approved': '✅ 已批准方案',
    'ask.reject': '✏️ 打回并反馈',
    'ask.rejected': '✏️ 已打回方案',
    'ask.rejectPlaceholder': '可写修改意见，打回让 Claude 改…',
    'ask.allowed': '✅ 已允许',
    'ask.denied': '⛔ 已拒绝',
    'ask.remembered': '🔓 已记住（始终允许）',
    'ask.toTerminal': '💬 已带你去终端',
    'ask.expired': '⚠️ 请求已失效，没有执行授权',
    'ask.decisionFailed': '⚠️ 未能提交决定，请重试',
    'ask.needsInput': '需要输入',
    'ask.back': '返回',
    'ask.submit': '提交回答',
    'ask.next': '下一步 ›',
    'ask.other': '其他',
    'ask.goTerminal': '💬 去终端',
    'ask.kindPerm': '授权',
    'ask.kindContinue': '回复',
    'ask.kindPlan': '方案',
    'ask.kindChoice': '选择',
    'ask.needHandling': '需要你处理',
    'ask.goReply': '💬 去这个会话回复 →',

    // ── session labels ──────────────────────────────────────────────────────
    'sess.fallbackName': '会话',

    'bub.loved': '🥰 谢谢夸奖！',
    'bub.sad': '😢 别生气…',
    'bub.ack': '✨ 收到！',
    'bub.newTask': '📨 收到新任务！',
    'bub.roundDone': '✅ 这一轮搞定啦！',
    'bub.bigDone': '🎉 大任务搞定！({ops}步)',
    'bub.error': '😵 出了点状况，在想办法…',
    'bub.waitYou': '✋ {project} {wait}',
    'bub.needReply': '💬 {project} 等你回复',
    'bub.greet': '👋 {project} 新会话，你好！',
    'bub.slowCmd': '💦 这条命令有点久，稍等…',
    'bub.online': '🐱 打工喵上线，开始盯所有 AI 任务啦！',

    // ── purr payday easter egg ──────────────────────────────────────────────
    'purr.title': '🐾 今日工资条',
    'purr.first': '呼噜……今天陪你跑了 {rounds} 轮，处理 {tokens} tokens，缓存命中 {cacheRate}%。摸鱼许可已批准五分钟。',
    'purr.empty': '呼噜……今天还没开工，本喵先陪你坐会儿。',
    'purr.repeat': '呼噜……今日工资条已经发过啦，本喵继续陪你待命。',
    'purr.titleAttr': '长按本喵查看今日陪伴工资条',

    // ── radial menu ─────────────────────────────────────────────────────────
    'bub.xiabanLunch1': '🍚 午饭铃响啦！保存好进度，先去干饭～',
    'bub.xiabanLunch2': '🍱 上午巡逻结束，工位我看着，你去吃饭吧！',
    'bub.xiabanLunch3': '🥢 到饭点啦，代码不会趁你吃饭时长腿跑掉的。',
    'bub.xiabanEvening1': '🍜 下班时间到！今天的 bug 留给明天，先去干饭～',
    'bub.xiabanEvening2': '🌃 工位已由本喵接管，放心下班，记得按时吃饭！',
    'bub.xiabanEvening3': '🔔 收工收工！再不走，晚饭就要开始等你回复了。',

    // ── left-click work peek ───────────────────────────────────────────────
    'peek.aria': '工作速览',
    'peek.close': '关闭工作速览',
    'peek.focus': '打开当前会话',
    'peek.focusFailed': '没能打开这个会话，请在对应 Agent 中手动打开',
    'peek.viewOnly': '该会话没有可用的窗口定位信息，点击查看详情',
    'peek.panel': '查看详情',
    'peek.idleTitle': '暂时没有任务',
    'peek.idleSub': '打工喵正在待命',
    'peek.sleepingSub': '工位已由本喵接管',
    'peek.multiTitle': '{count} 个任务正在进行',
    'peek.attentionTitle': '{count} 件事需要你处理',
    'peek.errorTitle': '{count} 个任务遇到问题',
    'peek.multiSub': '点击任务可定位到对应会话',
    'peek.multiSubDetails': '部分任务没有窗口定位信息，可点击查看详情',
    'peek.sessionSub': '{agent} · {project}',
    'peek.today': '今日 {rounds} 轮 · {tokens} tokens · API 等价 {cost}',
    'peek.running': '运行中 {running} · 等待你 {waiting} · 今日 {rounds} 轮',
    'peek.more': '另有 {count} 个任务，可在详情中查看',
    'peek.elapsed': '会话已持续 {time}',
    'peek.updated': '{time}前更新',
    'peek.justNow': '刚刚',
    'peek.seconds': '{count}秒',
    'peek.minutes': '{count}分钟',
    'peek.hours': '{count}小时',
    'peek.errorDetail': '任务执行异常，可打开会话查看',
    'peek.done': '刚完成',
    'peek.interrupted': '已中断',
    'peek.unknownProject': '未命名会话',

    'menu.panel': '详情',
    'menu.quit': '退出',
    'menu.collapse': '收起',

    // ── action center ───────────────────────────────────────────────────────
    'action.title': '🗒️ 行动中心',
    'action.close': '关闭',
    'action.needYou': '🔔 需要你处理',
    'action.panel': '📊 详情',
    'action.notepadTitle': '行动中心',

    // ── detail panel ────────────────────────────────────────────────────────
    'panel.waitingSession': '等待会话…',
    'panel.close': '关闭',
    'panel.usageTrend': '用量趋势',
    'panel.metricTokens': 'Token',
    'panel.metricCost': '费用',
    'panel.rangeToday': '今日',
    'panel.range7d': '7天',
    'panel.range30d': '30天',
    'panel.hourUnit': '点',
    'panel.tokIn': '输入',
    'panel.tokOut': '输出',
    'panel.tokCacheWrite5m': '缓存写入（5m）',
    'panel.tokCacheWrite1h': '缓存写入（1h）',
    'panel.tokCacheRead': '缓存读取',
    'panel.msgRounds': '消息轮次',
    'panel.activeTasks': '进行中的任务',
    'panel.noActiveSession': '暂无活跃会话',
    'panel.byModel': '按模型（分）',
    'panel.noData': '暂无数据',
    'panel.liveOps': '实时操作',
    'panel.waitingOps': '等待操作…',

    // 新增统计相关
    'panel.cacheHitRate': '缓存命中率',
    'panel.cacheTokens': '缓存读取',
    'panel.cacheInputTotal': '输入总量',
    'panel.lifetimeStats': '累计统计',
    'panel.lifetimeCost': '累计费用',
    'panel.lifetimeTokens': '累计 Tokens',
    'panel.lifetimeMsgs': '累计轮次',


  };

  const DICT = { zh };

  function fill(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  }

  // Missing keys fall back to the key itself rather than to a blank label.
  function t(key, vars) {
    const raw = DICT.zh[key];
    if (raw === undefined) return key;
    return fill(raw, vars);
  }

  return { DICT, t };
});
