'use strict';

// Renderer state-machine smoke test — loads the REAL renderer/pet.js headless
// (test/dom-stub.js) and drives it with synthetic pet:stats / pet:event traffic.
// Covers the bug class「状态被秒盖 / 闪烁 / 卡死 / class 泄漏 / 素材不可达」.
// Run: node test/state-smoke.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadRenderer } = require('./dom-stub');
const States = require('../shared/states');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

// 状态词全集取自唯一来源 shared/states.js（用于 class 泄漏检测）。此前这里是
// pet.js 的手抄副本、漏了 'loafing'，让 R8 泄漏检测对该状态失明——现在同源。
const STATE_WORDS = States.RENDER_STATE_WORDS;

function baseStats(over = {}) {
  return {
    today: { cost: 0 }, sessions: [], bg: { zombie: 0 },
    waitingCount: 0, needsinputCount: 0, workingCount: 0, jugglingCount: 0,
    sweepingCount: 0, thinkingCount: 0, loafingCount: 0, errorCount: 0, idleMs: 1000,
    ...over,
  };
}

function world() {
  const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'shared/pet-insights.js', 'renderer/pet.js']);
  return w;
}
const stateClasses = (el) => el.classList.list.filter((c) => STATE_WORDS.includes(c));
const catSrc = (w) => w.elements('cat-img').getAttribute('src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clickCat(w, x = 10, y = 10) {
  const cat = w.elements('cat');
  cat.dispatch('pointerdown', { button: 0, pointerId: 1, screenX: x, screenY: y });
  cat.dispatch('pointerup', { button: 0, pointerId: 1, screenX: x, screenY: y });
}

async function main() {
  console.log('[R0] 状态词表单一来源一致性');
  {
    // 后端 VALID_STATES（core 接受的状态）必须全部落在渲染端 STATE_WORDS 里，
    // 否则新增一个后端状态时 classList.remove 覆盖不到 → class 残留。
    const missing = States.VALID_STATES.filter((s) => !States.RENDER_STATE_WORDS.includes(s));
    check('渲染端 STATE_WORDS ⊇ 后端 VALID_STATES', () => assert.deepStrictEqual(missing, []));
    check('STATE_WORDS 含 loafing（曾在手抄副本里漏掉）', () => assert(STATE_WORDS.includes('loafing')));
    check('renderer 通过 <script> 拿到同一份 STATE_WORDS', () => {
      const oi = world().window.WorkMeowStates;
      assert(oi && Array.isArray(oi.RENDER_STATE_WORDS));
      assert.deepStrictEqual(oi.RENDER_STATE_WORDS, States.RENDER_STATE_WORDS);
    });
  }

  console.log('[R1] 聚合梯子优先级（对齐 STATES.md）');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 2, thinkingCount: 1 }));
    check('working > thinking', () => assert(cat.classList.contains('working')));
    w.handlers.stats(baseStats({ workingCount: 2, jugglingCount: 1 }));
    check('juggling > working（并行子任务可见）', () => assert(cat.classList.contains('juggling')));
    check('cat 显示 juggling 池素材', () => assert([
      'cat-juggling.gif', 'cat-juggling-2.gif', 'cat-juggling-3.gif',
    ].some((file) => catSrc(w).endsWith(file))));
    w.handlers.stats(baseStats({ jugglingCount: 1, sweepingCount: 1 }));
    check('sweeping > juggling', () => assert(cat.classList.contains('sweeping')));
    w.handlers.stats(baseStats({ workingCount: 3, needsinputCount: 1 }));
    check('needsinput > working（等你回复不被干活盖住）', () => assert(cat.classList.contains('needsinput')));
    w.handlers.stats(baseStats({ needsinputCount: 1, errorCount: 1 }));
    check('error > needsinput', () => assert(cat.classList.contains('error')));
    w.handlers.stats(baseStats({ errorCount: 1, waitingCount: 1 }));
    check('waiting > error', () => assert(cat.classList.contains('waiting')));
  }

  console.log('[R2] thinking transient：多会话干活时提交 prompt 仍可见，且到期回落');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 2 }));
    w.handlers.event({ kind: 'user-turn', project: 'p' });
    check('user-turn 后进入 thinking', () => assert(cat.classList.contains('thinking')));
    w.handlers.stats(baseStats({ workingCount: 2 })); // 快照立刻到达（曾经 150ms 秒盖）
    check('快照到达后 thinking 仍在（transient 存续）', () => assert(cat.classList.contains('thinking')));
    w.clock.offset += 4000; // 越过 3500ms 窗口
    w.handlers.stats(baseStats({ workingCount: 2 }));
    check('transient 到期后回落 working', () => assert(cat.classList.contains('working')));
  }

  console.log('[R3] operation 事件的守卫');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'user-turn', project: 'p' });
    w.handlers.event({ kind: 'operation', tool: 'Bash', icon: '⚙️', detail: '运行命令' });
    check('首个 operation 立即结束 thinking 过渡态并进入 working', () => assert(cat.classList.contains('working')));
    w.handlers.stats(baseStats({ workingCount: 1 }));
    check('后续快照不让已清理的 thinking 复活', () => assert(cat.classList.contains('working')));
    // needsinput 稳态不被 op 降级
    const w2 = world();
    const cat2 = w2.elements('cat');
    w2.handlers.stats(baseStats({ needsinputCount: 1, workingCount: 1 }));
    assert(cat2.classList.contains('needsinput'));
    w2.handlers.event({ kind: 'operation', tool: 'Bash', icon: '⚙️', detail: '运行命令' });
    check('needsinput 稳态不被 operation 打断', () => assert(cat2.classList.contains('needsinput')));
    // error 稳态同理（曾经 working↔error 闪烁）
    const w3 = world();
    const cat3 = w3.elements('cat');
    w3.handlers.stats(baseStats({ errorCount: 1, workingCount: 1 }));
    w3.handlers.event({ kind: 'operation', tool: 'Read', icon: '📖', detail: '读取文件' });
    check('error 稳态不被 operation 打断', () => assert(cat3.classList.contains('error')));
  }

  console.log('[R4] happy 庆祝不被同批 say 秒盖，say 接棒');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'turn-done', project: 'p' });
    check('turn-done → happy', () => assert(cat.classList.contains('happy')));
    w.handlers.event({ kind: 'say', text: '我修好了那个 bug，测试也通过了。', project: 'p' });
    check('同批 say 不秒盖 happy', () => assert(cat.classList.contains('happy')));
    await sleep(2000); // happy 1800ms 结束后 say 接棒
    check('happy 结束后 talking 接棒', () => assert(cat.classList.contains('talking')));
  }

  console.log('[R5] needsinput / waiting 清残留 transient');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'say', text: '这是一段比较长的回复文本内容。', project: 'p' });
    assert(cat.classList.contains('talking'));
    w.handlers.event({ kind: 'needsinput', project: 'p' });
    check('needsinput 事件即时生效', () => assert(cat.classList.contains('needsinput')));
    w.handlers.stats(baseStats({ needsinputCount: 1, workingCount: 1 }));
    check('下个快照 talking 不复活（transient 已清）', () => assert(cat.classList.contains('needsinput')));
  }

  console.log('[R6] 睡眠判定');
  {
    const w = world();
    const cat = w.elements('cat');
    w.handlers.stats(baseStats({ idleMs: 7 * 60 * 1000 }));
    check('空闲超阈值 → sleeping', () => assert(cat.classList.contains('sleeping')));
    w.handlers.stats(baseStats({ idleMs: null }));
    check('无活跃会话(idleMs=null) → sleeping 不惊醒', () => assert(cat.classList.contains('sleeping')));
    w.handlers.stats(baseStats({ idleMs: 1000 }));
    check('有近期活动 → idle', () => assert(cat.classList.contains('idle')));
  }

  console.log('[R6b] 闲时作息：无任务时画面轮换，但语义仍是 sleeping');
  {
    const w = world();
    const cat = w.elements('cat');
    const sleepEl = w.elements('sleep');
    const AMBIENT = ['cat-sleeping.gif', 'cat-sleeping-2.gif', 'cat-loafing.gif',
      'cat-loafing-2.gif', 'cat-loafing-3.gif', 'cat-loafing-4.gif', 'cat-loafing-5.gif', 'cat-idle.gif',
      'cat-thinking-2.gif', 'cat-roam.gif'];
    const SLEEPY = ['cat-sleeping.gif', 'cat-sleeping-2.gif'];
    const seen = new Set();
    let badgeBad = null;
    let firstRestingGif = null;
    // 反复「进入闲置 → 有活动 → 再闲置」：每次重入都重新抽片段，等价于快进作息表
    for (let i = 0; i < 60; i++) {
      w.handlers.stats(baseStats({ idleMs: null }));
      const gif = catSrc(w).split('/').pop();
      if (i === 0) firstRestingGif = gif;
      seen.add(gif);
      if (sleepEl.classList.contains('on') !== SLEEPY.includes(gif)) badgeBad = gif;
      w.handlers.stats(baseStats({ workingCount: 1 })); // 退出闲置
    }
    check('刚进入闲置先出现醒着的片段', () => assert(!SLEEPY.includes(firstRestingGif), firstRestingGif));
    w.handlers.stats(baseStats({ idleMs: null }));
    check('闲置时语义态仍是 sleeping（会话点/气泡逻辑不受影响）',
      () => assert(cat.classList.contains('sleeping')));
    check('画面只取自作息片段集',
      () => assert([...seen].every((g) => AMBIENT.includes(g)), '越界素材: ' + [...seen].join(',')));
    check('画面会轮换，不是永远同一张',
      () => assert(seen.size >= 3, '只出现 ' + seen.size + ' 种: ' + [...seen].join(',')));
    check('闲置时会出现醒着的活动，不是只有睡觉',
      () => assert([...seen].some((g) => !SLEEPY.includes(g))));
    check('💤 角标与当前画面一致（只在真睡的片段亮）',
      () => assert(!badgeBad, '角标与画面不一致: ' + badgeBad));
  }

  console.log('[R6c] 定时下班片段：只在无任务窗口播放');
  {
    const w = world();
    const setLocalTime = (hour, minute) => {
      const d = new Date();
      d.setHours(hour, minute, 0, 0);
      w.clock.offset = d.getTime() - Date.now();
    };
    setLocalTime(10, 56);
    w.handlers.stats(baseStats({ idleMs: 1000 }));
    check('上午下班窗口的 idle 播放 cat-xiaban', () => assert(catSrc(w).endsWith('cat-xiaban.gif')));
    const lunchLines = [
      '🍚 午饭铃响啦！保存好进度，先去干饭～',
      '🍱 上午巡逻结束，工位我看着，你去吃饭吧！',
      '🥢 到饭点啦，代码不会趁你吃饭时长腿跑掉的。',
    ];
    const bubbleText = w.elements('bubble-text');
    check('午饭窗口同步播报干饭气泡', () => assert(lunchLines.includes(bubbleText.textContent), bubbleText.textContent));
    bubbleText.textContent = '__same_window__';
    w.handlers.stats(baseStats({ idleMs: 1000 }));
    check('同一下班窗口的快照刷新不重复播报', () => assert.strictEqual(bubbleText.textContent, '__same_window__'));
    w.handlers.stats(baseStats({ workingCount: 1 }));
    check('有任务时不播放 cat-xiaban', () => assert(!catSrc(w).endsWith('cat-xiaban.gif')));
    setLocalTime(16, 56);
    w.handlers.stats(baseStats({ idleMs: null }));
    check('下午下班窗口的 sleeping 播放 cat-xiaban', () => assert(catSrc(w).endsWith('cat-xiaban.gif')));
    const eveningLines = [
      '🍜 下班时间到！今天的 bug 留给明天，先去干饭～',
      '🌃 工位已由本喵接管，放心下班，记得按时吃饭！',
      '🔔 收工收工！再不走，晚饭就要开始等你回复了。',
    ];
    check('晚间窗口使用下班主题文案', () => assert(eveningLines.includes(bubbleText.textContent), bubbleText.textContent));
    setLocalTime(17, 5);
    w.handlers.stats(baseStats({ idleMs: null }));
    check('下班窗口结束后退出 cat-xiaban', () => assert(!catSrc(w).endsWith('cat-xiaban.gif')));

    const custom = world();
    custom.handlers.xiabanSchedule({ lunch: '12:10', evening: '18:20' });
    const customNow = new Date();
    customNow.setHours(12, 11, 0, 0);
    custom.clock.offset = customNow.getTime() - Date.now();
    custom.handlers.stats(baseStats({ idleMs: 1000 }));
    check('自定义午间时间触发下班彩蛋', () =>
      assert(catSrc(custom).endsWith('cat-xiaban.gif')));
    const customEvening = new Date();
    customEvening.setHours(18, 21, 0, 0);
    custom.clock.offset = customEvening.getTime() - Date.now();
    custom.handlers.stats(baseStats({ idleMs: null }));
    check('自定义晚间时间触发下班彩蛋', () =>
      assert(catSrc(custom).endsWith('cat-xiaban.gif')));
  }

  console.log('[R7] 情绪短暂态的皮肤映射（不再回落成摸鱼图）');
  {
    const w = world();
    w.handlers.stats(baseStats({ workingCount: 1 }));
    w.handlers.event({ kind: 'user-turn', emotion: 'loved', project: 'p' });
    check('被夸 → cat-happy 素材', () => assert(catSrc(w).endsWith('cat-happy.gif')));
    const w2 = world();
    w2.handlers.stats(baseStats({ workingCount: 1 }));
    w2.handlers.event({ kind: 'user-turn', emotion: 'sad', project: 'p' });
    check('负面情绪 → cat-sad 素材', () => assert(catSrc(w2).endsWith('cat-sad.gif')));
  }

  console.log('[R8] class 泄漏检测：任意时刻皮肤元素上最多一个状态词');
  {
    const w = world();
    const cat = w.elements('cat');
    const seq = [
      () => w.handlers.stats(baseStats({ workingCount: 1 })),
      () => w.handlers.event({ kind: 'user-turn', project: 'p' }),
      () => w.handlers.stats(baseStats({ jugglingCount: 1 })),
      () => { w.clock.offset += 4000; w.handlers.stats(baseStats({ sweepingCount: 1 })); },
      () => w.handlers.event({ kind: 'turn-done', project: 'p' }),
      () => w.handlers.event({ kind: 'waiting', project: 'p' }),
      () => w.handlers.stats(baseStats({ errorCount: 1 })),
      () => w.handlers.stats(baseStats({ idleMs: null })),
    ];
    let leaked = null;
    for (const step of seq) {
      step();
      const cs = stateClasses(cat);
      if (cs.length > 1) { leaked = cs; break; }
    }
    check('全序列无 class 残留', () => assert(!leaked, 'leaked: ' + JSON.stringify(leaked)));
  }

  console.log('[R9] 启动不闪 idle');
  {
    const w = loadRenderer(['shared/i18n.js', 'shared/pet-insights.js', 'renderer/pet.js']);
    // 模拟 init 拿到快照（getStats stub 返回 null，这里直接补推快照 + 确认不被覆盖）
    w.handlers.stats(baseStats({ workingCount: 1 }));
    await sleep(30); // 让 init 的 async IIFE 走完（getStats→null→setState('idle') 只在无快照时）
    const cat = w.elements('cat');
    check('有快照时状态保持 working', () => assert(cat.classList.contains('working')));
  }

  console.log('[R10] working/thinking 多姿态轮换');
  {
    const w = world();
    // 工作帧池现扫自 pet.js 源码：你再加 cat-working-6.gif 时测试自动跟，不用手改这份列表
    const petSrcW = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
    const wm = petSrcW.match(/working:\s*\[([\s\S]*?)\]/);
    const WPOOL = [...new Set([...(wm ? wm[1].matchAll(/'cat-[a-z0-9-]+\.gif'/g) : []).map((m) => m[0].slice(1, -1))])];
    const TPOOL = ['cat-thinking.gif', 'cat-thinking-2.gif'];
    const workingSeen = [];
    for (let i = 0; i < WPOOL.length; i++) {
      w.handlers.stats(baseStats({ workingCount: 1 }));
      workingSeen.push(catSrc(w).split('/').pop());
      w.handlers.stats(baseStats({ idleMs: 1000 })); // 离开 working，模拟下一次进入
    }
    check('working 首轮只随机出现且不重复', () => {
      assert.strictEqual(new Set(workingSeen).size, WPOOL.length);
      assert(workingSeen.every((file) => WPOOL.includes(file)));
    });
    w.handlers.stats(baseStats({ workingCount: 1 }));
    const nextCycle = catSrc(w).split('/').pop();
    check('working 完成一轮后才开启下一轮', () => assert(WPOOL.includes(nextCycle)));

    const thinkingSeen = [];
    for (let i = 0; i < TPOOL.length; i++) {
      w.handlers.stats(baseStats({ thinkingCount: 1 }));
      thinkingSeen.push(catSrc(w).split('/').pop());
      w.handlers.stats(baseStats({ idleMs: 1000 }));
    }
    check('thinking 也按自己的随机循环轮换', () => {
      assert.strictEqual(new Set(thinkingSeen).size, TPOOL.length);
      assert(thinkingSeen.every((file) => TPOOL.includes(file)));
    });
    const JPOOL = ['cat-juggling.gif', 'cat-juggling-2.gif', 'cat-juggling-3.gif'];
    w.handlers.stats(baseStats({ jugglingCount: 1 }));
    check('juggling 显示并行轮换池素材', () => assert(JPOOL.includes(catSrc(w).split('/').pop())));
    // loafing 摸鱼：工具间隙，优先级低于 thinking、高于 idle
    const LPOOL = ['cat-loafing.gif', 'cat-loafing-2.gif', 'cat-loafing-3.gif', 'cat-loafing-4.gif', 'cat-loafing-5.gif'];
    w.handlers.stats(baseStats({ loafingCount: 1 }));
    check('loafing 显示摸鱼轮换池素材', () => assert(LPOOL.includes(catSrc(w).split('/').pop())));
    w.handlers.stats(baseStats({ loafingCount: 1, thinkingCount: 1 }));
    check('thinking > loafing', () => assert(w.elements('cat').classList.contains('thinking')));
    w.handlers.stats(baseStats({ loafingCount: 1, workingCount: 1 }));
    check('working > loafing', () => assert(w.elements('cat').classList.contains('working')));
  }

  console.log('[R11] 左键工作速览：状态分流、聚焦与拖动不误触');
  {
    const w = world();
    const peek = w.elements('peek');
    peek.classList.add('hidden');
    const started = Date.now() - 65 * 1000;
    const working = baseStats({
      today: { tokens: 126000, cost: 0.84, messages: 18 },
      workingCount: 1,
      sessions: [{
        project: 'WorkMeow', agent: 'codex', state: 'working', op: '编辑文件',
        sessionId: 'sess-work', headless: false, createdAt: started, updatedAt: Date.now(), idleMs: 1000,
      }],
    });
    w.handlers.stats(working);
    clickCat(w);
    check('单击干活中的喵打开速览', () => assert(!peek.classList.contains('hidden')));
    check('速览展示状态、Agent、项目和当前操作', () => {
      assert.strictEqual(w.elements('peek-title').textContent, '干活中');
      assert.strictEqual(w.elements('peek-subtitle').textContent, 'Codex · WorkMeow');
      const row = w.elements('peek-list').children[0];
      assert(row && row.children[1].children[1].textContent === '编辑文件');
    });
    w.handlers.stats({ ...working, sessions: [{ ...working.sessions[0], op: '运行命令', idleMs: 2000 }] });
    check('速览打开期间快照就地刷新', () => {
      const row = w.elements('peek-list').children[0];
      assert.strictEqual(row.children[1].children[1].textContent, '运行命令');
    });
    w.elements('peek-focus').dispatch('click');
    check('主按钮聚焦当前会话', () => {
      assert(w.calls.some(([name, args]) => name === 'focusSession' && args[0] === 'sess-work'));
      assert(peek.classList.contains('hidden'));
    });

    const failedFocusWorld = world();
    failedFocusWorld.elements('peek').classList.add('hidden');
    failedFocusWorld.elements('bubble').classList.add('hidden');
    failedFocusWorld.behavior.focusResult = false;
    failedFocusWorld.handlers.stats(working);
    clickCat(failedFocusWorld);
    failedFocusWorld.elements('peek-focus').dispatch('click');
    await Promise.resolve();
    check('系统无法打开会话时给出可见反馈', () => {
      assert.strictEqual(
        failedFocusWorld.elements('bubble-text').textContent,
        '没能打开这个会话，请在对应 Agent 中手动打开',
      );
      assert(!failedFocusWorld.elements('bubble').classList.contains('hidden'));
    });

    const viewOnlyWorld = world();
    viewOnlyWorld.elements('peek').classList.add('hidden');
    viewOnlyWorld.handlers.stats({
      ...working,
      sessions: [{ ...working.sessions[0], agent: 'opencode', focusable: false }],
    });
    clickCat(viewOnlyWorld);
    check('没有定位信息的 Agent 不展示无效打开按钮', () => {
      assert(viewOnlyWorld.elements('peek-focus').classList.contains('hidden'));
      assert(viewOnlyWorld.elements('peek-list').children[0].classList.contains('not-focusable'));
    });
    viewOnlyWorld.elements('peek-list').children[0].dispatch('click');
    check('没有定位信息的任务行改为打开详情', () => {
      assert(viewOnlyWorld.calls.some(([name]) => name === 'openPanel'));
      assert(!viewOnlyWorld.calls.some(([name]) => name === 'focusSession'));
    });

    clickCat(w);
    w.document.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    check('Esc 关闭速览', () => assert(peek.classList.contains('hidden')));

    const idleWorld = world();
    idleWorld.elements('peek').classList.add('hidden');
    idleWorld.handlers.stats(baseStats({ idleMs: null, today: { tokens: 8000, cost: 0.04, messages: 3 } }));
    clickCat(idleWorld);
    check('无任务时展示今日小结，不显示无效会话按钮', () => {
      assert.strictEqual(idleWorld.elements('peek-title').textContent, '暂时没有任务');
      assert(idleWorld.elements('peek-summary').textContent.includes('今日 3 轮'));
      assert(idleWorld.elements('peek-focus').classList.contains('hidden'));
    });

    const actionWorld = world();
    actionWorld.elements('peek').classList.add('hidden');
    actionWorld.elements('ask').classList.add('hidden');
    actionWorld.elements('action-pop').classList.add('hidden');
    const choice = (id) => ({
      kind: 'perm', sessionId: id, project: 'p-' + id, question: '允许运行命令？',
      permId: 'perm-' + id, options: [{ key: 'allow', label: '允许' }, { key: 'deny', label: '拒绝' }],
    });
    actionWorld.handlers.stats(baseStats({
      waitingCount: 2,
      sessions: [
        { project: 'p-a', agent: 'claude', state: 'waiting', sessionId: 'a', headless: false, choice: choice('a') },
        { project: 'p-b', agent: 'claude', state: 'waiting', sessionId: 'b', headless: false, choice: choice('b') },
      ],
    }));
    clickCat(actionWorld); // 自动弹出的第一张 ask 卡先关闭
    clickCat(actionWorld); // 再点按多事项策略打开行动中心
    check('多个待处理事项优先进入原有行动中心', () => {
      assert(!actionWorld.elements('action-pop').classList.contains('hidden'));
      assert.strictEqual(actionWorld.elements('ac-acts').children.length, 2);
    });

  const sameSessionWorld = world();
    sameSessionWorld.elements('peek').classList.add('hidden');
    sameSessionWorld.elements('ask').classList.add('hidden');
    sameSessionWorld.elements('action-pop').classList.add('hidden');
    const sameA = choice('shared');
    sameA.permId = 'perm-shared-a';
    const sameB = choice('shared');
    sameB.permId = 'perm-shared-b';
    sameSessionWorld.handlers.stats(baseStats({
      waitingCount: 2,
      actions: [
        { id: sameA.permId, state: 'waiting', sessionId: 'shared', choice: sameA },
        { id: sameB.permId, state: 'waiting', sessionId: 'shared', choice: sameB },
      ],
      sessions: [{ project: 'p-shared', agent: 'claude', state: 'waiting', sessionId: 'shared', headless: false, choice: sameA }],
    }));
    clickCat(sameSessionWorld);
    clickCat(sameSessionWorld);
    check('同一会话的并行权限都出现在行动中心', () => {
      assert.strictEqual(sameSessionWorld.elements('ac-acts').children.length, 2);
    });

    const singleActionWorld = world();
    singleActionWorld.elements('peek').classList.add('hidden');
    singleActionWorld.elements('ask').classList.add('hidden');
    singleActionWorld.handlers.stats(baseStats({
      waitingCount: 1,
      sessions: [{ project: 'p-one', agent: 'claude', state: 'waiting', sessionId: 'one', headless: false, choice: choice('one') }],
    }));
    clickCat(singleActionWorld); // 关闭自动弹出的卡片
    clickCat(singleActionWorld); // 单事项应回到同一张原生卡片
    check('单个待处理事项仍使用原有授权/问答卡', () => {
      assert(!singleActionWorld.elements('ask').classList.contains('hidden'));
      assert(singleActionWorld.elements('peek').classList.contains('hidden'));
    });

    const dragWorld = world();
    dragWorld.elements('peek').classList.add('hidden');
    dragWorld.handlers.stats(working);
    const dragCat = dragWorld.elements('cat');
    dragCat.dispatch('pointerdown', { button: 0, pointerId: 7, screenX: 10, screenY: 10 });
    dragCat.dispatch('pointermove', { button: 0, pointerId: 7, screenX: 20, screenY: 10 });
    dragCat.dispatch('pointerup', { button: 0, pointerId: 7, screenX: 20, screenY: 10 });
    check('拖动超过 4px 不误打开速览', () => assert(dragWorld.elements('peek').classList.contains('hidden')));
  }

  console.log('[R12] 素材可达性与静态兜底');
  {
    const petSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8');
    const refs = [...new Set([...petSrc.matchAll(/'cat-[a-z0-9-]+\.gif'/g)].map((m) => m[0].slice(1, -1)))];
    const missing = refs.filter((f) => !fs.existsSync(path.join(__dirname, '..', 'assets', 'cat', f)));
    check('所有被引用的授权 GIF 均可达' + (missing.length ? '（缺失: ' + missing.join(',') + '）' : ''),
      () => assert.strictEqual(missing.length, 0, '缺失素材: ' + missing.join(', ')));
    check('静态兜底素材存在', () => {
      assert(fs.existsSync(path.join(__dirname, '..', 'assets', 'tray-cat.svg')));
    });
    check('GIF 缺失时会回退到静态素材', () => {
      assert(/catImg\.onerror\s*=/.test(petSrc));
      assert(/CAT_FALLBACK\s*=\s*'\.\.\/assets\/tray-cat\.svg'/.test(petSrc));
    });
    check('状态 GIF 映射仍保留，取得授权后可直接恢复动画素材',
      () => assert(refs.includes('cat-working-2.gif')));
  }

  console.log('[R13] 呼噜工资条：长按触发、活动时让路、同日去重');
  {
    const w = world();
    w.elements('peek').classList.add('hidden');
    w.handlers.stats(baseStats({
      today: { tokens: 4200, cost: 0.12, messages: 3, inputTotal: 100, cacheRead: 40 },
      idleMs: null,
    }));
    const cat = w.elements('cat');
    cat.dispatch('pointerdown', { button: 0, pointerId: 11, screenX: 10, screenY: 10 });
    await sleep(1150);
    cat.dispatch('pointerup', { button: 0, pointerId: 11, screenX: 10, screenY: 10 });
    check('空闲时长按进入工资条', () => {
      assert.strictEqual(w.elements('chip-context').textContent, '🐾 今日工资条');
      assert(w.elements('bubble-text').textContent.includes('呼噜'));
      assert(w.elements('peek').classList.contains('hidden'), '长按不应同时打开速览');
    });

    await sleep(1500); // let the first loved transient settle before retrying the hidden action
    const second = w.elements('cat');
    second.dispatch('pointerdown', { button: 0, pointerId: 12, screenX: 10, screenY: 10 });
    await sleep(1150);
    second.dispatch('pointerup', { button: 0, pointerId: 12, screenX: 10, screenY: 10 });
    check('同日第二次仍有呼噜反馈', () => assert(w.elements('bubble-text').textContent.includes('工资条已经发过')));

    const busy = world();
    busy.handlers.stats(baseStats({ workingCount: 1, idleMs: 1000 }));
    const busyCat = busy.elements('cat');
    busyCat.dispatch('pointerdown', { button: 0, pointerId: 13, screenX: 10, screenY: 10 });
    await sleep(1150);
    busyCat.dispatch('pointerup', { button: 0, pointerId: 13, screenX: 10, screenY: 10 });
    check('有活动任务时长按不触发工资条', () => assert.notStrictEqual(busy.elements('chip-context').textContent, '🐾 今日工资条'));
  }

  console.log('[R14] 完成胶囊：主状态文案不可被明细挤掉');
  {
    const idle = world();
    idle.handlers.stats(baseStats({ idleMs: 1000 }));
    check('普通空闲不会冒充完成', () =>
      assert.strictEqual(idle.elements('chip-context').textContent, '🌿 待命'));

    const w = world();
    w.handlers.stats(baseStats({
      today: { tokens: 987654321, cost: 12345.678 },
      sessions: [{ state: 'idle', badge: 'done', createdAt: Date.now() - 500 }],
      idleMs: 500,
    }));
    check('完成快照保留完整主状态文案', () =>
      assert.strictEqual(w.elements('chip-context').textContent, '✅ 刚刚完成'));

    const sleepingDone = world();
    sleepingDone.handlers.stats(baseStats({
      sessions: [{ state: 'idle', badge: 'done', createdAt: Date.now() - 500 }],
      idleMs: null,
    }));
    check('无活跃会话的完成快照仍显示完成而非休息', () =>
      assert.strictEqual(sleepingDone.elements('chip-context').textContent, '✅ 刚刚完成'));
    check('完成胶囊使用独立语义标记', () =>
      assert.strictEqual(sleepingDone.elements('chip').dataset.context, 'done'));

    const mixed = world();
    mixed.handlers.stats(baseStats({
      workingCount: 1,
      sessions: [
        { state: 'idle', badge: 'done', createdAt: Date.now() - 500 },
        { state: 'working', agent: 'codex', createdAt: Date.now() - 2000 },
      ],
      idleMs: 500,
    }));
    check('混合会话优先显示正在进行而非旧完成徽标', () =>
      assert(mixed.elements('chip-context').textContent.includes('干活中')));
    check('混合会话不会挂上 done 数据态', () =>
      assert.strictEqual(mixed.elements('chip').dataset.context, 'active-working'));
  }

  console.log(`\n${failures === 0 ? '✅ RENDERER ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
