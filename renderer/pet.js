'use strict';

// 单宠时代（2026-08-07 起）：永远只有一只打工喵盯全部工具，AGENT 恒为 'all'。
// 该常量保留仅为兼容旧查询参数与下方少量分支判断。
const AGENT = new URLSearchParams(location.search).get('agent') || 'all';

const stage = document.getElementById('stage');
const cat = document.getElementById('cat');

// 状态 GIF 缺失或加载失败时使用仓库自带的静态猫图。
const catImg = document.getElementById('cat-img');
const CAT_FALLBACK = '../assets/tray-cat.svg';
if (catImg) {
  catImg.onerror = () => {
    if (!catAssetMatches(CAT_FALLBACK)) catImg.src = CAT_FALLBACK;
  };
}
const PET_ASSET_REGISTRY = window.WorkMeowPetAssets;
let petAssetCatalog = PET_ASSET_REGISTRY.defaultCatalog();

function slotAssetUrls(slotId) {
  const slot = petAssetCatalog.slots[slotId];
  return slot && Array.isArray(slot.active) ? slot.active.map((asset) => asset.url).filter(Boolean) : [];
}

function stateAssetUrls(stateName) {
  const slotId = PET_ASSET_REGISTRY.slotForState(stateName);
  const active = slotAssetUrls(slotId);
  return active.length ? active : slotAssetUrls('idle');
}

function applyPetAssetCatalog(next) {
  petAssetCatalog = PET_ASSET_REGISTRY.normalizeCatalog(next);
  poolCycles.clear();
  stopPoolRot();
  ambientStop();
  xiabanVisualKey = null;
  xiabanVisualAsset = null;
  updateCat(state);
}

// Any state can now have more than one pose. Entering a state chooses one,
// then a long-running state rotates every 60 seconds. Each state owns an
// independent shuffled cycle so adding a custom pose never causes repeats.
const POOL_ROTATE_MS = 60 * 1000;
let poolRot = null;
let poolState = null;
const poolCycles = new Map();

function shufflePool(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function nextPoolFile(name, pool) {
  const signature = pool.join('\u0000');
  let cycle = poolCycles.get(name);
  if (!cycle || cycle.signature !== signature || cycle.remaining.length === 0) {
    const remaining = shufflePool(pool);
    // 洗牌仍然是随机的，但避免跨轮次紧挨着播出同一张，观感更自然。
    if (cycle && cycle.last && remaining.length > 1 && remaining[0] === cycle.last) {
      const swap = 1 + Math.floor(Math.random() * (remaining.length - 1));
      [remaining[0], remaining[swap]] = [remaining[swap], remaining[0]];
    }
    cycle = { signature, remaining, last: null };
    poolCycles.set(name, cycle);
  }
  const file = cycle.remaining.shift();
  cycle.last = file;
  return file;
}

function showPoolFile(name, pool) {
  const source = nextPoolFile(name, pool);
  if (source && !catAssetMatches(source)) catImg.src = source;
}

function stopPoolRot() {
  if (poolRot) clearInterval(poolRot);
  poolRot = null;
  poolState = null;
}

/* ====================================================================
   闲时作息（ambient）：无任务时的「下班生活」
   --------------------------------------------------------------------
   一直播同一张睡觉图既呆板又不真实——人闲下来也不是倒头就睡。这里挂一层
   **只影响画面、不改语义**的作息表：语义态仍然是 sleeping（会话点过滤、
   气泡抑制、playAction 屏蔽、STATES.md 优先级全部照旧），变的只有两样：
   显示哪张 GIF，以及 💤 角标亮不亮。

   为什么不直接把语义态改成 loafing/idle：loafing 现在的含义是「任务进行中
   的工具间隙」，idle 是「一轮已收尾、等你下一句」。若无任务时也复用它们，
   你就再也无法一眼分辨「喵在摸鱼」到底有没有活在跑，诊断价值直接归零。

   作息曲线：越闲越困。刚下班基本在活动，夜深了基本在睡，但任何阶段都保留
   反向可能——所以永远不会静止成一张图。
   ==================================================================== */
function ambientScenes(wantSleep) {
  const slotId = wantSleep ? 'ambient-sleep' : 'ambient-awake';
  return slotAssetUrls(slotId).map((url) => ({
    gif: url,
    sleep: wantSleep,
    hold: /\/cat-roam\.gif(?:[?#]|$)/.test(url) ? [8000, 16000] : null,
  }));
}
// awake = 抽到「醒着的活动」的概率；hold = 片段停留时长区间（区间内随机，避免机械感）。
// maxSleepRun / maxAwakeRun 是节奏护栏：概率负责自然感，护栏保证不会一直睡或一直醒。
// 越往后不只是越困，切换也越慢——睡沉了还每 30 秒换个睡姿，看着像在发抖。
const AMBIENT_PHASES = [
  { until: 5 * 60 * 1000,  awake: 0.85, hold: [15000, 35000], maxSleepRun: 2, maxAwakeRun: 4 },  // 刚下班：几乎都在活动，节奏快
  { until: 20 * 60 * 1000, awake: 0.45, hold: [25000, 55000], maxSleepRun: 2, maxAwakeRun: 3 },  // 犯困期：活动与打盹各半
  { until: Infinity,       awake: 0.15, hold: [45000, 120000], maxSleepRun: 3, maxAwakeRun: 2 }, // 夜深了：以睡为主，偶尔翻身摸手机
];
let ambientAt = 0;      // 进入闲时作息的时刻
let ambientTimer = null;
let ambientGif = null;  // 当前片段，用于判断是否刚进入闲时
let ambientSleepRun = 0; // 连续睡觉片段数；超过阶段护栏就安排醒来活动
let ambientAwakeRun = 0; // 连续醒着片段数；超过阶段护栏就安排打盹
const ambientCycles = new Map(); // 睡觉/醒着各自独立的一轮随机队列

function ambientPhase() {
  const elapsed = perfNow() - ambientAt;
  return AMBIENT_PHASES.find((p) => elapsed < p.until) || AMBIENT_PHASES[AMBIENT_PHASES.length - 1];
}

function nextAmbientScene(wantSleep) {
  let same = ambientScenes(wantSleep);
  if (!same.length) same = ambientScenes(!wantSleep);
  const key = wantSleep ? 'sleep' : 'awake';
  let cycle = ambientCycles.get(key);
  const signature = same.map((scene) => scene.gif).join('\u0000');
  if (!cycle || cycle.signature !== signature || cycle.remaining.length === 0) {
    const remaining = shufflePool(same);
    if (cycle && cycle.last && remaining.length > 1 && remaining[0].gif === cycle.last) {
      const swap = 1 + Math.floor(Math.random() * (remaining.length - 1));
      [remaining[0], remaining[swap]] = [remaining[swap], remaining[0]];
    }
    cycle = { signature, remaining, last: null };
    ambientCycles.set(key, cycle);
  }
  const scene = cycle.remaining.shift();
  cycle.last = scene.gif;
  return scene;
}

function ambientPick(phase) {
  let wantSleep;
  if (ambientGif == null) {
    // 刚结束一轮工作先缓一会儿：第一幕固定是待命/摸鱼/发呆，不会一进闲置就倒头睡。
    wantSleep = false;
  } else if (ambientSleepRun >= phase.maxSleepRun) {
    wantSleep = false;
  } else if (ambientAwakeRun >= phase.maxAwakeRun) {
    wantSleep = true;
  } else {
    wantSleep = Math.random() >= phase.awake;
  }
  return nextAmbientScene(wantSleep);
}

function ambientStep() {
  const phase = ambientPhase();
  const sc = ambientPick(phase);
  ambientGif = sc.gif;
  if (sc.sleep) {
    ambientSleepRun++;
    ambientAwakeRun = 0;
  } else {
    ambientAwakeRun++;
    ambientSleepRun = 0;
  }
  if (!catAssetMatches(sc.gif)) catImg.src = sc.gif;
  if (sleepEl) sleepEl.classList.toggle('on', sc.sleep); // 💤 只在真睡的片段亮
  const [lo, hi] = sc.hold || phase.hold; // 片段自带时长优先（如 roam 幅度大要短播）
  ambientTimer = setTimeout(ambientStep, lo + Math.random() * (hi - lo));
}

function ambientStart() {
  if (ambientTimer) return; // 已在跑：保留时段进度，别把「越闲越困」重置回刚下班
  ambientAt = perfNow();
  ambientGif = null;
  ambientSleepRun = 0;
  ambientAwakeRun = 0;
  ambientStep();
}

function ambientStop() {
  if (ambientTimer) { clearTimeout(ambientTimer); ambientTimer = null; }
  ambientGif = null;
  ambientSleepRun = 0;
  ambientAwakeRun = 0;
}

// 定时下班片段：只在本机当地时间的两个下班窗口播放，且只覆盖真正无任务的
// idle/sleeping。它不是业务状态，不会把 sleeping 伪装成 loafing，也不会盖住工作。
const XIABAN_DURATION_MS = 10 * 60 * 1000;
const XIABAN_DEFAULT_TIMES = Object.freeze({ lunch: '10:55', evening: '16:55' });
let xiabanSchedule = { ...XIABAN_DEFAULT_TIMES };
const XIABAN_STATES = new Set(['idle', 'sleeping']);
const XIABAN_COPY_KEYS = {
  lunch: ['bub.xiabanLunch1', 'bub.xiabanLunch2', 'bub.xiabanLunch3'],
  evening: ['bub.xiabanEvening1', 'bub.xiabanEvening2', 'bub.xiabanEvening3'],
};
const XIABAN_ANNOUNCED_STORAGE_KEY = 'workmeow.xiaban-announced-window';
let xiabanTimer = null;
let xiabanVisualKey = null;
let xiabanVisualAsset = null;
let xiabanAnnouncedWindow = (() => {
  try { return window.localStorage && window.localStorage.getItem(XIABAN_ANNOUNCED_STORAGE_KEY); }
  catch { return null; }
})();

function isXiabanClockTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function xiabanStartEntries() {
  return [
    { period: 'lunch', time: xiabanSchedule.lunch },
    { period: 'evening', time: xiabanSchedule.evening },
  ].filter((entry) => isXiabanClockTime(entry.time)).map((entry) => ({
    ...entry,
    startMin: Number(entry.time.slice(0, 2)) * 60 + Number(entry.time.slice(3)),
  }));
}

function applyXiabanSchedule(next) {
  if (!next || !isXiabanClockTime(next.lunch) || !isXiabanClockTime(next.evening)) return false;
  xiabanSchedule = { lunch: next.lunch, evening: next.evening };
  if (xiabanTimer) {
    clearTimeout(xiabanTimer);
    xiabanTimer = null;
  }
  scheduleXiabanBoundary();
  if (XIABAN_STATES.has(state)) updateCat(state);
  return true;
}

function xiabanWindow(now = Date.now()) {
  const d = new Date(now);
  const dayMs = (((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000) + d.getMilliseconds();
  for (const entry of xiabanStartEntries()) {
    const { startMin } = entry;
    const startMs = startMin * 60 * 1000;
    if (dayMs >= startMs && dayMs < startMs + XIABAN_DURATION_MS) {
      // 日期 + 时段共同组成去重 key：同一窗口反复收到状态
      // 快照也只播报一次，第二天自动解锁。
      const dateKey = [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');
      return {
        remainingMs: startMs + XIABAN_DURATION_MS - dayMs,
        period: entry.period,
        key: `${dateKey}:${startMin}`,
      };
    }
  }
  return null;
}

function xiabanBoundaryDelay(now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let best = Infinity;
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const day = new Date(today);
    day.setDate(day.getDate() + dayOffset);
    for (const entry of xiabanStartEntries()) {
      const { startMin } = entry;
      const start = new Date(day);
      start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      for (const boundary of [start.getTime(), start.getTime() + XIABAN_DURATION_MS]) {
        const delay = boundary - now;
        if (delay > 100) best = Math.min(best, delay);
      }
    }
  }
  return Number.isFinite(best) ? Math.max(250, best) : 60 * 60 * 1000;
}

function scheduleXiabanBoundary() {
  if (xiabanTimer) return;
  xiabanTimer = setTimeout(() => {
    xiabanTimer = null;
    updateCat(state);
    scheduleXiabanBoundary();
  }, xiabanBoundaryDelay());
}

function announceXiaban(info) {
  if (!info || xiabanAnnouncedWindow === info.key) return;
  // 用户正在操作卡片/菜单时不抢界面，也不先标记已播报；
  // 下一次状态快照进来后仍可以补播。
  if (askActive || actionPopOpen || radialOpen || peekOpen) return;
  const keys = XIABAN_COPY_KEYS[info.period] || XIABAN_COPY_KEYS.evening;
  const key = keys[Math.floor(Math.random() * keys.length)];
  xiabanAnnouncedWindow = info.key;
  // 记住最近一个已播报窗口，避免在 10 分钟内重启应用后
  // 又立即播一次；新日期/新时段的 key 不同，会正常解锁。
  try { if (window.localStorage) window.localStorage.setItem(XIABAN_ANNOUNCED_STORAGE_KEY, info.key); } catch {}
  showBubble(t(key), Math.min(6500, Math.max(3200, info.remainingMs)));
}

function xiabanMaybeShow(s) {
  scheduleXiabanBoundary();
  const info = xiabanWindow();
  if (!XIABAN_STATES.has(s) || !info) {
    xiabanVisualKey = null;
    xiabanVisualAsset = null;
    return false;
  }
  const pool = slotAssetUrls('xiaban');
  if (!pool.length) return false;
  if (xiabanVisualKey !== info.key || !xiabanVisualAsset) {
    xiabanVisualKey = info.key;
    xiabanVisualAsset = nextPoolFile('xiaban', pool);
  }
  if (!catAssetMatches(xiabanVisualAsset)) catImg.src = xiabanVisualAsset;
  if (sleepEl) sleepEl.classList.remove('on');
  announceXiaban(info);
  return true;
}

function updateCat(s) {
  if (!catImg) return;
  if (xiabanMaybeShow(s)) {
    ambientStop();
    stopPoolRot();
    return;
  }
  if (s === 'sleeping') { stopPoolRot(); ambientStart(); return; } // 画面交给作息表
  ambientStop();
  const pool = stateAssetUrls(s);
  if (pool.length) {
    if (poolState !== s) {
      stopPoolRot();
      poolState = s;
      showPoolFile(s, pool);
      poolRot = setInterval(() => {
        const cur = stateAssetUrls(state);
        if (!cur.length || state !== s) { stopPoolRot(); return; }
        showPoolFile(s, cur);
      }, POOL_ROTATE_MS);
    }
  } else {
    stopPoolRot();
  }
}

function catAssetMatches(source) {
  if (!catImg) return false;
  try {
    return new URL(catImg.src, window.location.href).href === new URL(source, window.location.href).href;
  } catch {
    return String(catImg.getAttribute('src') || '') === String(source || '');
  }
}
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const chipCost = document.getElementById('chip-cost');
const chipTokens = document.getElementById('chip-tokens');
const chipContext = document.getElementById('chip-context');
const chip = document.getElementById('chip');
const sessionsEl = document.getElementById('sessions');
const radial = document.getElementById('radial');
const thinkEl = document.getElementById('think');
const sleepEl = document.getElementById('sleep');
const propEl = document.getElementById('prop');
const sidekickEl = document.getElementById('sidekick');
const askEl = document.getElementById('ask');
const askScroll = document.getElementById('ask-scroll');
const askLabel = document.getElementById('ask-label');
const askSess = document.getElementById('ask-sess');
const askQhead = document.getElementById('ask-qhead');
const askQ = document.getElementById('ask-q');
const askHint = document.getElementById('ask-hint');
const askOpts = document.getElementById('ask-opts');
const askInputRow = document.getElementById('ask-input-row'); // .ask-other
const askText = document.getElementById('ask-text');
const askPage = document.getElementById('ask-page');
const askFoot = document.getElementById('ask-foot');
const askSubmit = document.getElementById('ask-submit');
const askBack = document.getElementById('ask-back');
const askTerm = document.getElementById('ask-term');
const notepad = document.getElementById('notepad');
const npBadge = document.getElementById('np-badge');
const actionPop = document.getElementById('action-pop');
const acActs = document.getElementById('ac-acts');
const acActSec = document.getElementById('ac-act-sec');
const peekEl = document.getElementById('peek');
const peekState = document.getElementById('peek-state');
const peekTitle = document.getElementById('peek-title');
const peekSubtitle = document.getElementById('peek-subtitle');
const peekList = document.getElementById('peek-list');
const peekSummary = document.getElementById('peek-summary');
const peekFocus = document.getElementById('peek-focus');
const peekPanel = document.getElementById('peek-panel');
const peekClose = document.getElementById('peek-close');

let askActive = false;
let askQueue = []; // 当前所有待处理的选择/输入（每项含 project）
let askIdx = 0;
let lastAskSig = ''; // 当前面板内容签名，避免每 2s 重渲冲掉用户输入
const answered = new Set(); // 已答的 key，避免快照延迟导致重弹
let askHover = false; // 鼠标在选项面板上
let elic = null;      // elicitation 渲染态：{ key, questions, qIdx, answers, selected }
// 面板开着、且(鼠标在面板上 / 输入框聚焦/有草稿 / 已选了选项) = 交互中：
// 此时别重渲面板、别改打工喵状态，免得打断你思考/选择。面板一关就自动解除。
const isInteracting = () => askActive && (askHover || document.activeElement === askText || !!(askText && askText.value) || (elic && elic.selected != null));

// i18n: shared/i18n.js is loaded as a <script> before this file.
const t = (key, vars) => window.WorkMeowI18n.t(key, vars);
const backgroundStatus = (session) => window.WorkMeowI18n.backgroundStatus(session);
// A reason arrives as a stable key ('reply'|'plan'|'perm'); older payloads may
// still carry free text, so fall back to whatever came in.
const waitPhrase = (reason) => (reason ? t('wait.' + reason) : t('wait.default'));
const reasonWord = (reason) => (reason ? t('reason.' + reason) : t('reason.default'));
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 带上 sessionId：否则同一项目下两个并行会话若问了同样的问题，会共用一个 key，
// 答掉一个就把另一个也标记成 answered 吞掉。choice 各构造处都带 sessionId。
const choiceKey = (c) => {
  if (!c) return '';
  if (c.permId) return `perm:${c.permId}`;
  if (c.actionId) return `action:${c.actionId}`;
  // Compatibility fallback for old snapshots; authorization choices always
  // take one of the stable branches above.
  return (c.sessionId || '') + '|' + (c.project || '') + '|' + (c.question || '');
};

// 动态定高：弹层贴 pet 上方(bottom:200)，把窗口高度调到刚好容纳内容，
// 避免固定大窗口留白 / 顶屏被下移。先扩到目标宽度再量高度：如果在基础
// 320px 窄窗里先测，长文本会被过度换行，错误地把弹层撑到整屏高。
const POPUP_W = 520;
const POPUP_BOTTOM = 200;
const ASK_VIEWPORT_MAX_H = 520;
const BASE_PET_FRAME_H = 340;
const RESTING_FRAME_MAX_W = 360;
const RESTING_FRAME_MAX_H = 360;
let fitPopupSeq = 0;
let edgeLayout = { vertical: 'above', horizontal: 'center' };

function browserWorkArea() {
  const s = window.screen || {};
  const width = Number.isFinite(s.availWidth) ? s.availWidth : (window.innerWidth || 320);
  const height = Number.isFinite(s.availHeight) ? s.availHeight : (window.innerHeight || 340);
  return {
    x: Number.isFinite(s.availLeft) ? s.availLeft : 0,
    y: Number.isFinite(s.availTop) ? s.availTop : 0,
    width,
    height,
  };
}

function petGeometrySnapshot() {
  const el = curSkinEl();
  if (!el || !Number.isFinite(window.screenX) || !Number.isFinite(window.screenY)) return null;
  const rect = el.getBoundingClientRect();
  const viewportW = Math.max(1, window.innerWidth || 320);
  const viewportH = Math.max(1, window.innerHeight || 340);
  return {
    workArea: browserWorkArea(),
    windowRect: { x: window.screenX, y: window.screenY, width: viewportW, height: viewportH },
    petRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  };
}

function setStageEdgeLayout(next) {
  const layout = next || edgeLayout;
  edgeLayout = {
    vertical: layout.vertical === 'below' ? 'below' : 'above',
    horizontal: ['left', 'right'].includes(layout.horizontal) ? layout.horizontal : 'center',
  };
  stage.classList.toggle('edge-below', edgeLayout.vertical === 'below');
  stage.classList.toggle('edge-left', edgeLayout.horizontal === 'left');
  stage.classList.toggle('edge-right', edgeLayout.horizontal === 'right');
  if (propEl && propEl.classList.contains('on')) positionProp();
}

// Changing the flex anchor moves the pet inside the transparent BrowserWindow.
// This payload lets the main process move/resize that window in the opposite
// direction, so the visible pet stays on exactly the same screen pixel.
function anchoredLayoutPayload(next) {
  const before = petGeometrySnapshot();
  if (!before) { setStageEdgeLayout(next); return null; }
  const oldPet = before.petRect;
  const wa = before.workArea;
  const waRight = wa.x + wa.width;
  const waBottom = wa.y + wa.height;
  const wr = before.windowRect;
  const compactHorizontalFrame = wr.width <= RESTING_FRAME_MAX_W;
  const compactVerticalFrame = wr.height <= RESTING_FRAME_MAX_H;
  let screenX = wr.x + oldPet.x;
  let screenY = wr.y + oldPet.y;

  // A frame at the work-area edge plus a large transparent inset means the OS
  // stopped the BrowserWindow before the user's visible pet reached the edge.
  // Treat that as an explicit edge drag and snap the *pet body*, not the frame.
  if (compactVerticalFrame && next.vertical === 'below' && wr.y <= wa.y + 3 && oldPet.y > 18) screenY = wa.y;
  if (compactVerticalFrame && next.vertical === 'above'
    && wr.y + wr.height >= waBottom - 3 && wr.height - oldPet.y - oldPet.height > 18) {
    screenY = waBottom - oldPet.height;
  }
  if (compactHorizontalFrame && next.horizontal === 'left' && wr.x <= wa.x + 3 && oldPet.x > 18) screenX = wa.x;
  if (compactHorizontalFrame && next.horizontal === 'right'
    && wr.x + wr.width >= waRight - 3 && wr.width - oldPet.x - oldPet.width > 18) {
    screenX = waRight - oldPet.width;
  }
  setStageEdgeLayout(next);
  const rect = curSkinEl().getBoundingClientRect();
  const viewportW = Math.max(1, window.innerWidth || 320);
  const viewportH = Math.max(1, window.innerHeight || 340);
  const xAlign = edgeLayout.horizontal;
  const yAlign = edgeLayout.vertical === 'below' ? 'top' : 'bottom';
  const xOffset = xAlign === 'left'
    ? rect.left
    : xAlign === 'right'
      ? viewportW - rect.right
      : rect.left + rect.width / 2 - viewportW / 2;
  const yOffset = yAlign === 'top' ? rect.top : viewportH - rect.bottom;
  return {
    screenX, screenY,
    width: rect.width, height: rect.height,
    xAlign, yAlign, xOffset, yOffset,
  };
}

function restingEdgeLayout() {
  const snapshot = petGeometrySnapshot();
  if (!snapshot || !window.PetGeometry) return edgeLayout;
  // In an expanded popup the bottom-anchored pet's local y grows by exactly
  // the extra window height. Remove that artificial offset before deciding
  // whether the visible pet itself is actually in the top-edge zone.
  const frameHeightExcess = Math.max(0, snapshot.windowRect.height - BASE_PET_FRAME_H);
  let topThreshold = snapshot.petRect.y - frameHeightExcess + 2;
  if (edgeLayout.vertical === 'below') {
    // Measure the real normal-layout inset for the current pet/status stack.
    // A fixed number is wrong as soon as a chip/bubble changes height and can
    // make pointerup flip the pet back too early.
    const previous = { ...edgeLayout };
    setStageEdgeLayout({ ...previous, vertical: 'above' });
    topThreshold = curSkinEl().getBoundingClientRect().top - frameHeightExcess + 2;
    setStageEdgeLayout(previous);
  }
  return window.PetGeometry.chooseRestingLayout({
    ...snapshot,
    current: edgeLayout,
    threshold: Math.max(24, topThreshold),
    inferVerticalFrameClamp: snapshot.windowRect.height <= RESTING_FRAME_MAX_H,
    inferHorizontalFrameClamp: snapshot.windowRect.width <= RESTING_FRAME_MAX_W,
  });
}

function popupEdgeLayout(height, popupHeight) {
  const snapshot = petGeometrySnapshot();
  if (!snapshot || !window.PetGeometry) return edgeLayout;
  return window.PetGeometry.choosePopupLayout({
    ...snapshot,
    current: edgeLayout,
    popupHeight: Math.max(80, Number(popupHeight) || (Number(height) || 340) - POPUP_BOTTOM),
    inferVerticalFrameClamp: snapshot.windowRect.height <= RESTING_FRAME_MAX_H,
    inferHorizontalFrameClamp: snapshot.windowRect.width <= RESTING_FRAME_MAX_W,
  });
}

function setRequestedPetSize(w, h, options = {}) {
  const width = Number(w) || 0;
  const height = Number(h) || 0;
  const nextLayout = options.popup
    ? popupEdgeLayout(height, options.popupHeight)
    : restingEdgeLayout();
  const anchor = anchoredLayoutPayload(nextLayout);
  try { window.pet.setPetSize(width, height, anchor); } catch {}
}
function fitPopup(el) {
  if (!el) return;
  const seq = ++fitPopupSeq;
  requestAnimationFrame(() => {
    const measure = () => {
      if (seq !== fitPopupSeq) return;
      const popupW = POPUP_W;
      // 关键：先临时去掉 max-height 再量，否则 scrollHeight 会被「当前小窗口算出的
      // max-height」钳住（鸡生蛋问题）→ 窗口永远只长一点点、列表只剩 1 行+滚动条。
      const prev = el.style.maxHeight;
      el.style.maxHeight = 'none';
      const contentH = el.scrollHeight;
      el.style.maxHeight = prev;
      const viewportH = el === askEl ? Math.min(contentH, ASK_VIEWPORT_MAX_H) : contentH;
      const winH = Math.max(340, POPUP_BOTTOM + viewportH + 24);
      setRequestedPetSize(popupW, winH, { popup: true, popupHeight: viewportH });
    };

    const targetW = POPUP_W;
    if (Math.abs((window.innerWidth || 0) - targetW) > 2) {
      // 第一拍只扩宽，第二拍在正确的横向排版下测真实高度。
      setRequestedPetSize(targetW, Math.max(340, window.innerHeight || 340), { popup: true });
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      measure();
    }
  });
}
function resetPetSize() {
  fitPopupSeq++;
  setRequestedPetSize(0, 0);
}

function settleEdgeLayout() {
  // No screen coordinates in the headless renderer tests; the real Electron
  // window always has them. This also avoids inventing a desktop in Node.
  if (!petGeometrySnapshot()) return;
  setRequestedPetSize(0, 0);
}

// Switch the internal top/bottom anchor *during* a drag, just before the
// transparent BrowserWindow reaches the work-area boundary. The visible pet
// is kept on the same screen pixel and the gesture is rebased, so the next
// pointer frame continues from there instead of producing edge -> pause ->
// jump. Returning from the top probes the normal layout first and restores it
// as soon as the whole frame can fit on-screen again.
function movePetDuringDrag(gesture, e, targetX, targetY) {
  const dragMeta = () => ({
    x: gesture.grabX,
    y: gesture.grabY,
    id: gesture.id,
    seq: ++gesture.moveSeq,
  });
  const el = curSkinEl();
  if (!el) {
    window.pet.setWinPos(targetX, targetY, dragMeta());
    return;
  }
  const before = el.getBoundingClientRect();
  const petScreenX = targetX + before.left;
  const petScreenY = targetY + before.top;
  const wa = browserWorkArea();
  let nextVertical = edgeLayout.vertical;

  if (edgeLayout.vertical === 'above') {
    nextVertical = window.PetGeometry
      ? window.PetGeometry.chooseDragVerticalLayout({
        current: 'above', workArea: wa, targetWindowY: targetY,
        petScreenY, abovePetOffset: before.top,
      })
      : (targetY <= wa.y + 2 ? 'below' : 'above');
  } else if (edgeLayout.vertical === 'below') {
    const candidate = { ...edgeLayout, vertical: 'above' };
    setStageEdgeLayout(candidate);
    const normalRect = el.getBoundingClientRect();
    const probed = window.PetGeometry
      ? window.PetGeometry.chooseDragVerticalLayout({
        current: 'below', workArea: wa, targetWindowY: targetY,
        petScreenY, abovePetOffset: normalRect.top,
      })
      : (petScreenY - normalRect.top >= wa.y + 2 ? 'above' : 'below');
    if (probed === 'above') {
      nextVertical = 'above';
    } else {
      setStageEdgeLayout({ ...edgeLayout, vertical: 'below' });
      nextVertical = 'below';
    }
  }

  if (nextVertical !== edgeLayout.vertical) {
    setStageEdgeLayout({ ...edgeLayout, vertical: nextVertical });
  }
  const after = el.getBoundingClientRect();
  const anchoredX = petScreenX - after.left;
  const anchoredY = petScreenY - after.top;
  // When the cat changes its internal edge anchor, the grabbed pixel moves
  // inside the window. Shift the local grab point by the same amount so the OS
  // cursor remains attached to that exact pixel without a visible jump.
  gesture.grabX += after.left - before.left;
  gesture.grabY += after.top - before.top;

  if (Math.abs(anchoredX - targetX) > 0.5 || Math.abs(anchoredY - targetY) > 0.5) {
    gesture.win = [anchoredX, anchoredY];
    gesture.sx = pointerScreenX(e);
    gesture.sy = pointerScreenY(e);
  }
  window.pet.setWinPos(anchoredX, anchoredY, dragMeta());
}

// 从快照重建队列（多任务都在、且标明项目）
function refreshAsk(stats) {
  // 记事本行动中心开着时，事项在那里处理，别再另弹选项面板抢窗口
  if (actionPopOpen) { hideAsk(); return; }
  const actionSource = Array.isArray(stats.actions)
    ? stats.actions
    : (stats.sessions || []).filter((x) => (x.state === 'waiting' || x.state === 'needsinput') && x.choice);
  const items = actionSource
    .map((x) => x.choice)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
  const present = new Set(items.map(choiceKey));
  for (const k of [...answered]) if (!present.has(k)) answered.delete(k); // 已消失=已答完，清理
  const fresh = items.filter((c) => !answered.has(choiceKey(c)));

  // 你正在答当前卡片、且它后端仍然有效 → 不重渲(保住勾选/输入)，但仍静默对账队列其余项，
  // 这样已解决的卡片不会残留、新卡片不会被你的“交互中”状态永久挡在外面。
  const cur = askActive ? askQueue[askIdx] : null;
  if (isInteracting() && cur && present.has(choiceKey(cur))) {
    askQueue = fresh;
    const i = fresh.findIndex((c) => choiceKey(c) === choiceKey(cur));
    askIdx = i >= 0 ? i : 0;
    return;
  }

  askQueue = fresh;
  if (!askQueue.length) { hideAsk(); return; }
  if (askIdx >= askQueue.length) askIdx = 0;
  const sig = askQueue.map(choiceKey).join(',');
  if (askActive && sig === lastAskSig) return; // 内容没变，别重渲（保住正在输入/勾选的）
  lastAskSig = sig;
  showAskPanel();
}

function enqueueChoice(c) {
  if (!c || (!(c.options && c.options.length) && !c.allowInput)) return;
  answered.delete(choiceKey(c));
  const i = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  if (i < 0) askQueue.push(c);
  // 记事本行动中心开着 → 新事项在那里显示，不另弹面板
  if (actionPopOpen) { renderActionPop(); return; }
  // 你正在答当前面板时，新任务先进队列、不抢面板（等你答完再显示），避免打断
  if (isInteracting() && askActive) return;
  askIdx = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  showAskPanel();
}

function showAskPanel() {
  const c = askQueue[askIdx];
  if (!c) { hideAsk(); return; }
  if (peekOpen) closePeek();
  const sess = c.sessionId ? ' · #' + String(c.sessionId).slice(-3) : '';
  const queue = askQueue.length > 1 ? `${askIdx + 1}/${askQueue.length} · ` : '';
  askSess.textContent = queue + (c.project || '?') + sess;

  if (c.kind === 'ask') {
    if (!elic || elic.key !== choiceKey(c)) {
      elic = { key: choiceKey(c), questions: Array.isArray(c.questions) ? c.questions : [], qIdx: 0, answers: {}, selected: null, selSet: [], multi: false, otherOn: false };
    }
    renderElicitation(c);
  } else {
    elic = null;
    if (c.kind === 'perm' && c.permId) renderPerm(c);
    else if (c.kind === 'plan' && c.permId) renderPlan(c);
    else renderContinue(c);
  }

  bubble.classList.add('hidden');
  askEl.classList.remove('hidden');
  lastAskSig = askQueue.map(choiceKey).join(',');
  askActive = true;
  fitPopup(askEl); // 富卡片：固定头尾、中部滚动，动态定高 + 520 宽
}

function clearAskBody() {
  askScroll.scrollTop = 0;
  askOpts.innerHTML = '';
  askOpts.classList.remove('perm-row');
  askQhead.textContent = '';
  askHint.textContent = '';
  askPage.textContent = '';
  askInputRow.classList.add('hidden');
  askText.value = '';
  askTerm.textContent = t('ask.goTerminal');
}

// ① elicitation（AskUserQuestion）：多选项卡 + Other + 分页 + Submit/Back
function renderElicitation(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needsInput');
  const qs = elic.questions;
  const q = qs[elic.qIdx] ||
    { question: c.question || t('ask.needAnswer'), options: (c.options || []).map((o) => ({ label: o.label, description: o.desc })) };
  askQhead.textContent = q.header || '';
  askQ.textContent = q.question || '';
  const multi = !!q.multiSelect;
  elic.multi = multi;
  askHint.textContent = multi ? t('ask.multiHint') : t('ask.singleHint');

  const prior = elic.answers[q.question];
  const opts = q.options || [];
  const known = (v) => opts.some((o) => o.label === v);
  if (multi) {
    const parts = prior ? String(prior).split(/,\s*/).filter(Boolean) : [];
    elic.selSet = parts.filter(known);
    const otherText = parts.find((p) => !known(p));
    elic.otherOn = !!otherText;
    elic.selected = null;
    if (otherText) askText.value = otherText;
  } else {
    elic.selSet = [];
    elic.otherOn = false;
    elic.selected = prior != null ? (known(prior) ? prior : '__other__') : null;
  }

  for (const o of opts) askOpts.appendChild(buildRadioCard(o.label, o.description, o.label, q));
  askOpts.appendChild(buildRadioCard(t('ask.other'), '', '__other__', q));
  if (elic.selected === '__other__' || (multi && elic.otherOn)) {
    askInputRow.classList.remove('hidden');
    if (!multi && prior && !known(prior)) askText.value = prior;
  }

  askPage.textContent = `${elic.qIdx + 1} / ${qs.length || 1}`;
  askFoot.classList.remove('hidden');
  const last = elic.qIdx >= (qs.length || 1) - 1;
  askSubmit.textContent = last ? t('ask.submit') : t('ask.next');
  askBack.classList.toggle('hidden', elic.qIdx === 0);
  askTerm.classList.remove('hidden');
  updateSubmitEnabled(q);
  fitPopup(askEl); // 题目切换后内容高度变了，重新定高
}

function buildRadioCard(label, desc, value, q) {
  const multi = elic.multi;
  const isSel = multi ? (value === '__other__' ? elic.otherOn : elic.selSet.includes(value)) : elic.selected === value;
  const card = document.createElement('button');
  card.className = 'ask-opt' + (multi ? ' multi' : '') + (isSel ? ' sel' : '');
  card.innerHTML =
    '<span class="ask-radio"></span><span class="ask-ot">' +
    `<span class="ask-ol">${esc(label)}</span>` + (desc ? `<span class="ask-od">${esc(desc)}</span>` : '') +
    '</span>';
  card.addEventListener('click', () => {
    if (multi) {
      if (value === '__other__') {
        elic.otherOn = !elic.otherOn;
        card.classList.toggle('sel', elic.otherOn);
        askInputRow.classList.toggle('hidden', !elic.otherOn);
        if (elic.otherOn) setTimeout(() => askText.focus(), 0);
      } else {
        const i = elic.selSet.indexOf(value);
        if (i >= 0) elic.selSet.splice(i, 1); else elic.selSet.push(value);
        card.classList.toggle('sel');
      }
    } else {
      elic.selected = value;
      askInputRow.classList.toggle('hidden', value !== '__other__');
      if (value === '__other__') setTimeout(() => askText.focus(), 0);
      [...askOpts.children].forEach((el) => el.classList.remove('sel'));
      card.classList.add('sel');
    }
    updateSubmitEnabled(q);
  });
  return card;
}

function updateSubmitEnabled() {
  let ok;
  if (elic && elic.multi) ok = elic.selSet.length > 0 || (elic.otherOn && (askText.value || '').trim());
  else ok = elic && elic.selected && (elic.selected !== '__other__' || (askText.value || '').trim());
  askSubmit.classList.toggle('disabled', !ok);
}

// 自定义输入为空时按回车：不发送，抖一下 + 提示别忘了填（2.6s 后复原 placeholder）
let emptyWarnTimer = null;
function warnEmptyInput() {
  askText.focus();
  askText.classList.add('warn');
  if (!askText.dataset.ph) askText.dataset.ph = askText.placeholder || t('ask.placeholder');
  askText.placeholder = t('ask.emptyWarn');
  clearTimeout(emptyWarnTimer);
  emptyWarnTimer = setTimeout(() => {
    askText.classList.remove('warn');
    if (askText.dataset.ph) { askText.placeholder = askText.dataset.ph; delete askText.dataset.ph; }
  }, 2600);
}

function elicNextOrSubmit(c) {
  const qs = elic.questions;
  const q = qs[elic.qIdx];
  let val;
  if (elic.multi) {
    const parts = [...elic.selSet];
    if (elic.otherOn && (askText.value || '').trim()) parts.push((askText.value).trim());
    val = parts.join(', ');
  } else {
    val = elic.selected === '__other__' ? (askText.value || '').trim() : elic.selected;
  }
  if (!val) return; // 必须先选/填
  if (q && q.question) elic.answers[q.question] = val;
  else elic.answers[c.question || '_'] = val;
  if (elic.qIdx < (qs.length || 1) - 1) { elic.qIdx++; renderElicitation(c); return; }
  decideChoice(c, { type: 'elicitation-submit', answers: { ...elic.answers } }, t('ask.submitted'));
}

function elicBack(c) {
  if (elic && elic.qIdx > 0) { elic.qIdx--; renderElicitation(c); }
}

// ② 授权：允许(绿)/拒绝(红) + 可选「始终允许」建议按钮(中性)
function renderPerm(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needPerm');
  askQhead.textContent = c.header || '';
  askQ.textContent = c.question || t('ask.needPermQ');
  const opts = c.options || [];
  if (opts.length === 2) askOpts.classList.add('perm-row'); // 仅允许/拒绝时并排
  opts.forEach((opt) => {
    const kind = opt.key === 'allow' ? 'allow' : opt.key === 'deny' ? 'deny' : 'sugg';
    const card = document.createElement('button');
    card.className = 'ask-opt act ' + kind;
    card.innerHTML = `<span class="ask-ot"><span class="ask-ol">${esc(opt.label)}</span></span>`;
    card.addEventListener('click', () => submitPerm(opt.key, c, opt.label));
    askOpts.appendChild(card);
  });
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ③ 纯回复（无选项）：只读问题 + Go to Terminal
function renderContinue(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needsInput');
  askQ.textContent = c.question || t('ask.waitingReply');
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ④ ExitPlanMode 方案评审：展示方案 + 批准 / 打回并反馈
function renderPlan(c) {
  clearAskBody();
  askLabel.textContent = t('ask.planLabel');
  askQhead.textContent = c.project ? '📂 ' + c.project : '';
  askQ.textContent = c.question || t('ask.planQ');
  const approve = document.createElement('button');
  approve.className = 'ask-opt act allow';
  approve.innerHTML = '<span class="ask-ot"><span class="ask-ol">' + esc(t('ask.approve')) + '</span></span>';
  approve.addEventListener('click', () => submitPerm('allow', c, t('ask.approved')));
  askOpts.appendChild(approve);
  const reject = document.createElement('button');
  reject.className = 'ask-opt act deny';
  reject.innerHTML = '<span class="ask-ot"><span class="ask-ol">' + esc(t('ask.reject')) + '</span></span>';
  reject.addEventListener('click', () => {
    decideChoice(c, { type: 'plan-feedback', feedback: (askText.value || '').trim() }, t('ask.rejected'));
  });
  askOpts.appendChild(reject);
  askInputRow.classList.remove('hidden');
  askText.placeholder = t('ask.rejectPlaceholder');
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

function finishChoice(choice, bubbleMsg) {
  answered.add(choiceKey(choice));
  elic = null;
  askQueue = askQueue.filter((c) => choiceKey(c) !== choiceKey(choice));
  if (askQueue.length) {
    // 还有下一题：直接展示，不弹确认气泡盖住选项面板
    askIdx = 0; showAskPanel();
  } else {
    // 先关面板（置 askActive=false），确认气泡才不会被 showBubble 的 askActive 早退拦掉
    hideAsk();
    showBubble(bubbleMsg, 2600);
  }
}
const decisionsInFlight = new Set();
async function decideChoice(choice, behavior, successMsg) {
  const key = choiceKey(choice);
  if (!choice || !choice.permId || decisionsInFlight.has(key)) return false;
  decisionsInFlight.add(key);
  try {
    const accepted = await window.pet.decidePermission(choice.permId, behavior);
    if (accepted === true) {
      finishChoice(choice, successMsg);
      return true;
    }
    // The held request disconnected/expired before the click. Remove the stale
    // local card, but explicitly say that no authorization was applied.
    finishChoice(choice, t('ask.expired'));
    return false;
  } catch {
    showBubble(t('ask.decisionFailed'), 4200, true);
    return false;
  } finally {
    decisionsInFlight.delete(key);
  }
}
function submitPerm(key, choice, label) {
  const msg = key === 'allow' ? t('ask.allowed') : key === 'deny' ? t('ask.denied') : t('ask.remembered');
  decideChoice(choice, key, msg);
}
// Go to Terminal：去会话终端自己答（授权/elicitation 都回 deny，让 CC 在终端重问）
async function gotoSession(choice) {
  if (choice.permId) await decideChoice(choice, 'deny', t('ask.toTerminal'));
  else finishChoice(choice, t('ask.toTerminal'));
  requestSessionFocus(choice.sessionId || '');
}

function hideAsk() {
  lastAskSig = '';
  elic = null;
  askEl.classList.add('hidden');
  askHover = false;
  if (askText) askText.value = ''; // 清掉草稿，避免关闭后仍被判为「交互中」冻住状态
  if (askActive) { askActive = false; resetPetSize(); window.pet.blurPet(); }
}

// ---------- 记事本 / 行动中心 ----------
let curSessions = [];
let curActions = [];
let actionPopOpen = false;

// 当前需要你处理的事项：有 choice、还没答过的 waiting/needsinput 会话
function actionableItems() {
  const source = curActions.length
    ? curActions
    : curSessions.filter((x) => x.state === 'waiting' || x.state === 'needsinput');
  return source
    .filter((x) => x.choice && !answered.has(choiceKey(x.choice)))
    .map((x) => x.choice)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
}

function updateNotepad(s) {
  curSessions = s.sessions || [];
  curActions = Array.isArray(s.actions) ? s.actions : [];
  const acts = actionableItems();
  if (!acts.length) {
    notepad.classList.add('hidden');
    if (actionPopOpen) closeActionPop();
    return;
  }
  notepad.classList.remove('hidden');
  npBadge.textContent = acts.length;
  npBadge.classList.add('urgent');
  // 弹层开着、且用户没在弹层里打字 → 同步刷新内容
  if (actionPopOpen && !actionPop.contains(document.activeElement)) { renderActionPop(); fitPopup(actionPop); }
}

function renderActionPop() {
  const acts = actionableItems();
  // 需要你处理
  if (acts.length) {
    acActSec.classList.remove('hidden');
    acActs.innerHTML = '';
    acts.forEach((c) => acActs.appendChild(buildActCard(c)));
  } else {
    acActSec.classList.add('hidden');
    acActs.innerHTML = '';
  }
}

// 一张「需要你处理」卡片：问题 + 选项按钮(可点即答) + 自定义输入
function buildActCard(c) {
  const card = document.createElement('div');
  card.className = 'ac-act';
  const kindTag = c.kind === 'perm' ? t('ask.kindPerm')
    : c.kind === 'continue' ? t('ask.kindContinue')
      : c.kind === 'plan' ? t('ask.kindPlan') : t('ask.kindChoice');
  const head = document.createElement('div');
  head.className = 'ac-act-proj';
  head.textContent = `📂 ${c.project || '?'} · ${kindTag}`;
  card.appendChild(head);
  const q = document.createElement('div');
  q.className = 'ac-act-q';
  q.textContent = (c.header ? '【' + c.header + '】 ' : '') + (c.question || t('ask.needHandling'));
  card.appendChild(q);

  const opts = document.createElement('div');
  opts.className = 'ac-act-opts';
  if (c.kind === 'perm' && c.permId) {
    // 授权：允许/拒绝 → HTTP 原生通道回 CC
    (c.options || []).forEach((opt) => {
      const b = document.createElement('button');
      b.textContent = opt.label;
      if (opt.desc) b.title = opt.desc;
      b.addEventListener('click', (e) => { e.stopPropagation(); popPerm(c, opt.key); });
      opts.appendChild(b);
    });
  } else {
    // 对话类：选项只读展示 + 「去回复」按钮（桌宠不替你打字）
    (c.options || []).forEach((opt) => {
      const label = typeof opt === 'string' ? opt : opt.label;
      const desc = typeof opt === 'string' ? '' : opt.desc || '';
      const d = document.createElement('div');
      d.className = 'ac-act-ro';
      d.textContent = label;
      if (desc) d.title = desc;
      opts.appendChild(d);
    });
    const go = document.createElement('button');
    go.className = 'ac-act-go';
    go.textContent = t('ask.goReply');
    go.addEventListener('click', (e) => { e.stopPropagation(); popGoto(c); });
    opts.appendChild(go);
  }
  card.appendChild(opts);
  return card;
}

// 授权：回 CC 决策
async function popPerm(choice, key) {
  const msg = key === 'allow' ? t('ask.allowed') : key === 'deny' ? t('ask.denied') : t('ask.remembered');
  await decideChoice(choice, key, msg);
  renderActionPop();
  maybeCloseEmptyPop();
}
// 对话类：定位并唤起该会话窗口
async function popGoto(choice) {
  // AskUserQuestion and ExitPlanMode also hold a PermissionRequest connection.
  // Deny it before handing control to the terminal so the request cannot stay
  // parked invisibly behind the action-center acknowledgement.
  if (choice.permId) await decideChoice(choice, 'deny', t('ask.toTerminal'));
  else answered.add(choiceKey(choice));
  requestSessionFocus(choice.sessionId || '');
  renderActionPop();
  maybeCloseEmptyPop();
}
function maybeCloseEmptyPop() {
  if (!actionableItems().length) closeActionPop();
}

function openActionPop() {
  if (askActive) hideAsk(); // 别和选项面板抢窗口
  if (peekOpen) closePeek();
  renderActionPop();
  actionPop.classList.remove('hidden');
  actionPopOpen = true;
  fitPopup(actionPop);
}
function closeActionPop() {
  actionPop.classList.add('hidden');
  actionPopOpen = false;
  window.pet.blurPet();
  resetPetSize();
}

// 状态标签仅用于猫猫头顶的状态点。
const SESS_META_ICON = {
  waiting: '✋ ', needsinput: '💬 ', working: '⚙️ ', juggling: '🤹 ',
  sweeping: '🧹 ', thinking: '💭 ', loafing: '🍦 ', error: '😵 ',
  idle: '', sleeping: '💤 ',
};
const SESS_META_KEY = {
  waiting: 'state.waiting', needsinput: 'state.needsinput', working: 'state.working',
  juggling: 'state.juggling', sweeping: 'state.sweeping', thinking: 'state.thinking',
  loafing: 'state.loafingLong', error: 'state.error', idle: 'state.idle',
  sleeping: 'state.sleeping',
};
function sessMeta(state) {
  const key = SESS_META_KEY[state];
  return key ? (SESS_META_ICON[state] || '') + t(key) : null;
}
const SESS_SORT = { waiting: 0, needsinput: 0, error: 1, working: 2, juggling: 2, sweeping: 2, thinking: 2, loafing: 3, idle: 4, sleeping: 5 };

const isBaseVisibleSession = (s) => !!s && !s.headless && s.state !== 'sleeping';
// 单一配色：完成→绿、中断→红，否则按状态。
function sessionDotClass(s) {
  if (s.state === 'idle' && s.badge === 'done') return 'done';
  if (s.state === 'idle' && s.badge === 'interrupted') return 'error';
  return s.state || 'idle';
}

// ---------- 左键工作速览 ----------
const PEEK_AUTO_CLOSE_MS = 8000;
const PEEK_BUSY_STATES = new Set(['waiting', 'needsinput', 'error', 'working', 'juggling', 'sweeping', 'thinking', 'loafing']);
let peekOpen = false;
let peekTimer = null;
let peekLayoutSig = '';
let peekPrimarySessionId = '';

function peekAgentLabel(agent) {
  try {
    if (window.WorkMeowAgents && typeof window.WorkMeowAgents.shortLabel === 'function') {
      return window.WorkMeowAgents.shortLabel(agent);
    }
  } catch {}
  return ({ claude: 'Claude', codex: 'Codex', trae: 'TRAE', workbuddy: 'WorkBuddy', opencode: 'opencode' })[agent] || 'AI';
}

function peekTime(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return t('peek.justNow');
  if (value < 60 * 1000) return t('peek.seconds', { count: Math.max(1, Math.floor(value / 1000)) });
  if (value < 60 * 60 * 1000) return t('peek.minutes', { count: Math.max(1, Math.floor(value / 60000)) });
  return t('peek.hours', { count: Math.max(1, Math.floor(value / 3600000)) });
}

function peekSessionState(s) {
  if (s && s.state === 'idle' && s.badge === 'done') return 'done';
  if (s && s.state === 'idle' && s.badge === 'interrupted') return 'error';
  return (s && s.state) || 'idle';
}

function peekSessionDetail(s) {
  const effective = peekSessionState(s);
  if (effective === 'done') return t('peek.done');
  if (s && s.state === 'idle' && s.badge === 'interrupted') return t('peek.interrupted');
  if (effective === 'waiting') return waitPhrase(s.reason);
  if (effective === 'needsinput') return (s.choice && s.choice.question) || t('state.needsinput');
  if (effective === 'error') return t('peek.errorDetail');
  const background = backgroundStatus(s);
  if (background) return background;
  if (s.op) return s.op;
  const key = SESS_META_KEY[effective];
  return key ? t(key) : t('state.idle');
}

function peekSessionTime(s) {
  const effective = peekSessionState(s);
  const turnStartedAt = Number(s && s.turnStartedAt) || 0;
  if (turnStartedAt > 0 && PEEK_BUSY_STATES.has(effective)) {
    return t('peek.elapsed', { time: peekTime(Date.now() - turnStartedAt) });
  }
  return t('peek.updated', { time: peekTime(s && s.idleMs) });
}

function peekSessions(stats) {
  const visible = (stats.sessions || []).filter((s) => s && !s.headless && s.state !== 'sleeping');
  const active = visible.filter((s) => PEEK_BUSY_STATES.has(s.state));
  const list = active.length
    ? active
    : visible
      .filter((s) => s.badge === 'done' || s.badge === 'interrupted')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 1);
  return list.slice().sort((a, b) => {
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 4;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 4;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
}

function makePeekRow(s) {
  const effective = peekSessionState(s);
  const focusable = s.focusable !== false;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'peek-row' + (focusable ? '' : ' not-focusable');
  row.title = focusable ? t('peek.focus') : t('peek.viewOnly');

  const dot = document.createElement('span');
  dot.className = 'peek-row-dot ' + effective;
  dot.setAttribute('aria-hidden', 'true');

  const main = document.createElement('span');
  main.className = 'peek-row-main';
  const project = document.createElement('span');
  project.className = 'peek-row-project';
  project.textContent = `${peekAgentLabel(s.agent)} · ${s.project || t('peek.unknownProject')}`;
  project.title = project.textContent;
  const detail = document.createElement('span');
  detail.className = 'peek-row-detail';
  detail.textContent = peekSessionDetail(s);
  main.appendChild(project);
  main.appendChild(detail);

  const time = document.createElement('span');
  time.className = 'peek-row-time';
  time.textContent = peekSessionTime(s);

  row.appendChild(dot);
  row.appendChild(main);
  row.appendChild(time);
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const sessionId = s.sessionId || '';
    closePeek();
    if (focusable && sessionId) requestSessionFocus(sessionId);
    else window.pet.openPanel(AGENT);
  });
  return row;
}

function renderPeek(stats) {
  if (!stats) return;
  const restingState = stats.idleMs == null || stats.idleMs > IDLE_SLEEP_MS ? 'sleeping' : 'idle';
  const rows = peekSessions(stats);
  const attention = (stats.sessions || []).filter((s) => !s.headless && (s.state === 'waiting' || s.state === 'needsinput'));
  const errors = (stats.sessions || []).filter((s) => !s.headless && s.state === 'error');
  const running = (stats.sessions || []).filter((s) => !s.headless && ['working', 'juggling', 'sweeping', 'thinking', 'loafing'].includes(s.state));
  const primary = rows[0] || null;
  const headlineState = attention.length ? attention[0].state
      : errors.length ? 'error'
      : primary ? peekSessionState(primary)
        : restingState;

  if (attention.length) peekTitle.textContent = t('peek.attentionTitle', { count: attention.length });
  else if (errors.length) peekTitle.textContent = t('peek.errorTitle', { count: errors.length });
  else if (running.length > 1) peekTitle.textContent = t('peek.multiTitle', { count: running.length });
  else if (primary && PEEK_BUSY_STATES.has(primary.state)) peekTitle.textContent = t(SESS_META_KEY[primary.state] || 'state.working');
  else peekTitle.textContent = t('peek.idleTitle');

  if (rows.length > 1) {
    peekSubtitle.textContent = rows.some((s) => s.focusable === false)
      ? t('peek.multiSubDetails')
      : t('peek.multiSub');
  }
  else if (primary && PEEK_BUSY_STATES.has(primary.state)) {
    peekSubtitle.textContent = t('peek.sessionSub', {
      agent: peekAgentLabel(primary.agent),
      project: primary.project || t('peek.unknownProject'),
    });
  } else {
    peekSubtitle.textContent = restingState === 'sleeping' ? t('peek.sleepingSub') : t('peek.idleSub');
  }

  peekState.className = 'peek-state ' + headlineState;
  peekList.innerHTML = '';
  rows.slice(0, 3).forEach((s) => peekList.appendChild(makePeekRow(s)));

  const today = stats.today || {};
  const rounds = Number(today.messages != null ? today.messages : today.msgs) || 0;
  if (running.length || attention.length || errors.length) {
    let summary = t('peek.running', { running: running.length, waiting: attention.length, rounds });
    if (rows.length > 3) summary += ' · ' + t('peek.more', { count: rows.length - 3 });
    peekSummary.textContent = summary;
  } else {
    peekSummary.textContent = t('peek.today', {
      rounds,
      tokens: compactTokens(today.tokens || 0),
      cost: '$' + (Number(today.cost) || 0).toFixed(3),
    });
  }

  peekPrimarySessionId = primary && primary.focusable !== false && primary.sessionId ? primary.sessionId : '';
  peekFocus.classList.toggle('hidden', !peekPrimarySessionId);
  peekPanel.style.flex = peekPrimarySessionId ? '' : '1';

  const layoutSig = [attention.length ? 'attention' : errors.length ? 'error' : running.length ? 'running' : 'idle', Math.min(rows.length, 3), !!peekPrimarySessionId].join(':');
  if (peekOpen && layoutSig !== peekLayoutSig) fitPopup(peekEl);
  peekLayoutSig = layoutSig;
}

function clearPeekTimer() {
  if (peekTimer) clearTimeout(peekTimer);
  peekTimer = null;
}

function armPeekTimer() {
  clearPeekTimer();
  if (peekOpen) peekTimer = setTimeout(closePeek, PEEK_AUTO_CLOSE_MS);
}

function openPeek() {
  if (!lastStats || askActive || actionPopOpen || radialOpen) return;
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubble.classList.add('hidden');
  renderPeek(lastStats);
  peekEl.classList.remove('hidden');
  peekOpen = true;
  fitPopup(peekEl);
  armPeekTimer();
}

function closePeek() {
  if (!peekOpen) return;
  clearPeekTimer();
  peekEl.classList.add('hidden');
  peekOpen = false;
  peekLayoutSig = '';
  peekPrimarySessionId = '';
  window.pet.blurPet();
  if (!askActive && !actionPopOpen) resetPetSize();
}

function handleCatClick() {
  if (radialOpen) { closeRadial(); return; }
  if (askActive) { hideAsk(); return; }
  if (actionPopOpen) { closeActionPop(); return; }
  if (peekOpen) { closePeek(); return; }

  const acts = actionableItems();
  if (acts.length > 1) { openActionPop(); return; }
  if (acts.length === 1) {
    const i = askQueue.findIndex((c) => choiceKey(c) === choiceKey(acts[0]));
    if (i >= 0) askIdx = i;
    else { askQueue = [acts[0]]; askIdx = 0; }
    showAskPanel();
    return;
  }
  openPeek();
}

// 工具 -> 干活动作；道具 emoji 的运动变体
const TOOL_ACT = {
  Edit: 'type', MultiEdit: 'type', Write: 'type', NotebookEdit: 'type',
  Read: 'read',
  Bash: 'crank',
  Grep: 'search', Glob: 'search',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'summon', Agent: 'summon',
  TodoWrite: 'check',
};
const ACT_CLASSES = ['act-type', 'act-read', 'act-search', 'act-crank', 'act-web', 'act-summon', 'act-check', 'act-work'];
const PROP_MOTION = { crank: 'spin', web: 'spin', search: 'hunt', type: 'jit' };
let actTimer = null;

let state = 'idle';
let bubbleTimer = null;
let transientUntil = 0;   // 短暂状态（happy/error）持续到的时间
let transientState = null;
let radialOpen = false;

const IDLE_SLEEP_MS = 6 * 60 * 1000;
const PURR_HOLD_MS = 1100;
const PURR_DISPLAY_MS = 6200;
const PURR_DAY_STORAGE_KEY = 'workmeow.purr-payday-day';
let purrPaydayUntil = 0;
let purrPaydaySummary = null;
let purrPaydayTimer = null;
const stateEls = [cat];
// ---------- 状态机（固定使用打工喵形象） ----------
// 前端会 setState 的全部状态词（聚合态 + 短暂态 + 情绪态）——统一取自
// shared/states.js（pet.html 以 <script> 在 pet.js 之前加载它）。classList.remove
// 必须覆盖此全集，漏一个就会 class 残留在皮肤元素上。
const STATE_WORDS = (window.WorkMeowStates && window.WorkMeowStates.RENDER_STATE_WORDS) || [];
function setState(s) {
  if (state === s) {
    // 语义状态没变，限时视觉层仍可能刚刚到期；同状态快照也要让猫
    // 重新选图，否则 30s 的高压工作姿态会一直拖到下一次状态切换。
    updateCat(s);
    return;
  }
  for (const el of stateEls) {
    el.classList.remove(...STATE_WORDS);
    el.classList.add(s);
  }
  state = s;
  thinkEl.classList.toggle('on', s === 'thinking');
  sleepEl.classList.toggle('on', s === 'sleeping');
  if (s === 'thinking' || s === 'sleeping') bubble.classList.add('hidden');
  if (s === 'working') {
    // 进入干活态 → 立刻挂上「持续忙碌」基线动作，不等具体 tool 事件，
    // 任何时刻都显得在忙（具体 tool 动作会在它之上叠加，结束后回落到这里）。
    for (const el of stateEls) el.classList.add('act-work');
  } else {
    clearAction(); // 离开干活态才清掉动作
  }
  // 注意：不要在这里 hideAsk()！面板显隐只由 refreshAsk(按是否有待答事项) 管。
  // 之前「s!=='waiting' 就 hideAsk」会在聚合态变 working/thinking 时把 needsinput 的面板闪掉。
  updateCat(s);
}

function positionProp() {
  const el = curSkinEl();
  if (!el || !propEl) return;
  const stageRect = stage.getBoundingClientRect();
  const petRect = el.getBoundingClientRect();
  const size = 28;
  const gap = 7;
  const viewportW = Math.max(1, stageRect.width || window.innerWidth || 320);
  const viewportH = Math.max(1, stageRect.height || window.innerHeight || 340);
  const petLeft = petRect.left - stageRect.left;
  const petTop = petRect.top - stageRect.top;
  const petRight = petLeft + petRect.width;
  const preferRight = edgeLayout.horizontal === 'left'
    || (edgeLayout.horizontal === 'center' && petLeft + petRect.width / 2 < viewportW / 2);
  let left = preferRight ? petRight + gap : petLeft - size - gap;
  if (left < 4 || left + size > viewportW - 4) {
    left = preferRight ? petLeft - size - gap : petRight + gap;
  }
  const top = Math.max(4, Math.min(viewportH - size - 4, petTop + petRect.height * 0.18));
  propEl.style.left = Math.round(Math.max(4, Math.min(viewportW - size - 4, left))) + 'px';
  propEl.style.top = Math.round(top) + 'px';
  propEl.style.right = 'auto';
  propEl.style.bottom = 'auto';
}

// 按工具播放专属动作 + 头顶道具
function playAction(toolName, icon) {
  if (state === 'waiting' || state === 'sleeping') return;
  const act = TOOL_ACT[toolName] || 'work';
  for (const el of stateEls) {
    el.classList.remove(...ACT_CLASSES);
    el.classList.add('act-' + act); // 通用 work 也有身体动作（不再只闪图标）
  }
  if (icon) {
    positionProp();
    propEl.textContent = icon;
    propEl.className = 'prop';
    void propEl.offsetWidth; // 重启动画
    const pm = PROP_MOTION[act];
    propEl.className = 'prop on' + (pm ? ' ' + pm : '');
  }
  if (act === 'summon') {
    sidekickEl.classList.remove('on');
    void sidekickEl.offsetWidth;
    sidekickEl.classList.add('on');
  }
  clearTimeout(actTimer);
  actTimer = setTimeout(clearAction, 2200);
}
function clearAction() {
  for (const el of stateEls) el.classList.remove(...ACT_CLASSES);
  propEl.classList.remove('on');
  // 具体 tool 动作结束后，仍在干活 → 回落到「持续忙碌」基线，别安静下来
  if (state === 'working') for (const el of stateEls) el.classList.add('act-work');
}

// 短暂状态：happy/error/greet…，到点后由 applyStats 接管。
// 到期不再干等下一个快照（周期推送最坏 ~4s，短暂态会拖尾）——
// 定时用最近一次快照主动重算聚合态，到点即回落。
let transientTimer = null;
function transient(s, ms, text, holdMs) {
  if (state === 'waiting') return; // 等用户优先
  transientState = s;
  transientUntil = perfNow() + ms;
  setState(s);
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { if (lastStats) applyStats(lastStats); }, ms + 30);
  if (text) showBubble(text, holdMs || ms);
}
// 高优先级稳态（waiting/needsinput/error）接管时清掉残留短暂态，
// 否则 talking/thinking 会在下个快照借 transientUntil 复活盖回来。
function clearTransient() {
  transientUntil = 0;
  clearTimeout(transientTimer);
}

// 大任务完成的彩带
function confetti() {
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height * 0.35;
  const emojis = ['🎉', '✨', '⭐', '🧡', '🎊'];
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = emojis[i % emojis.length];
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8; // 向上扇形
    const dist = 45 + Math.random() * 70;
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    s.style.fontSize = 12 + Math.random() * 12 + 'px';
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    s.style.animationDelay = Math.random() * 0.12 + 's';
    stage.appendChild(s);
    setTimeout(() => s.remove(), 1300);
  }
}

function positionBubbleTip() {
  if (!bubble || bubble.classList.contains('hidden')) return;
  const el = curSkinEl();
  if (!el) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (bubble.classList.contains('hidden')) return;
      const sr = stage.getBoundingClientRect();
      const petRect = el.getBoundingClientRect();
      const bubRect = bubble.getBoundingClientRect();
      const petCenterX = petRect.left - sr.left + petRect.width / 2;
      const bubLeft = bubRect.left - sr.left;
      const relX = petCenterX - bubLeft;
      // Keep the triangle inside the bubble's rounded corners.
      const minX = 14;
      const maxX = Math.max(minX + 1, bubRect.width - 14);
      const tipX = Math.min(Math.max(relX, minX), maxX);
      bubble.style.setProperty('--tip-x', tipX + 'px');
    });
  });
}

function showBubble(text, holdMs = 3200, force = false) {
  if (!force && (radialOpen || askActive || peekOpen)) return; // 弹层开着时不用普通气泡盖住它
  // emoji → 内联 SVG（WorkMeowIcons 在 emoji 字符与 SVG 之间做安全替换；不可识别字符原样保留）
  if (window.WorkMeowIcons && window.WorkMeowIcons.hasMappedEmoji(text)) {
    window.WorkMeowIcons.setTextWithIcons(bubbleText, text);
  } else {
    bubbleText.textContent = text;
  }
  bubble.classList.remove('hidden');
  bubble.scrollTop = 0; // 重置滚动到顶（上次长气泡可能滚到了下边）
  // 大段文字：把窗口按实际高度撑开（fitPopup 已按屏幕封顶，永远不顶出屏幕；
  // 实在超屏时由 #bubble 自身 overflow-y:auto 内滚动兜底）。
  fitPopup(bubble);
  positionBubbleTip();
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, holdMs);
}

function requestSessionFocus(sessionId) {
  if (!sessionId) return;
  Promise.resolve(window.pet.focusSession(sessionId))
    .then((focused) => {
      if (focused === false) showBubble(t('peek.focusFailed'), 4200, true);
    })
    .catch(() => showBubble(t('peek.focusFailed'), 4200, true));
}
function hideBubble() {
  bubble.classList.add('hidden');
  // 若没有其它弹层占用大窗口尺寸，恢复原始尺寸（避免 pet 一直停在加大窗口里）
  if (!askActive && !actionPopOpen && !peekOpen) resetPetSize();
}

const curSkinEl = () => cat;

window.pet.onEvent((ev) => {
  // 需要人处理或出错时，优先让出工作速览，保持原有卡片/气泡路径。
  if (peekOpen && (ev.kind === 'waiting' || ev.kind === 'needsinput' || ev.kind === 'error')) closePeek();
  // 你正在答面板/打字时：新的待答任务只悄悄进队列(不抢面板)，其余动画/彩带/气泡/状态变化一律不打断
  if (isInteracting()) {
    if ((ev.kind === 'waiting' || ev.kind === 'needsinput') && ev.choice) enqueueChoice(ev.choice);
    return;
  }
  switch (ev.kind) {
    case 'operation': {
      // 高优先级稳态（等授权/等回复/出错/清理）不被工具事件降级成 working——
      // 之前 error 期间其它会话干活会导致 working↔error 持续闪烁。
      const hold = state === 'waiting' || state === 'needsinput' || state === 'error' || state === 'sweeping';
      // “收到任务”产生的 thinking 只是等待首个动作的过渡态；真实工具一开始就应
      // 立刻切到 working。庆祝/说话/情绪等其它 transient 仍完整播放。
      const startingWork = transientState === 'thinking' && perfNow() < transientUntil;
      if (!hold && (startingWork || perfNow() >= transientUntil)) {
        if (startingWork) clearTransient();
        setState('working');
        playAction(ev.tool, ev.icon);
      }
      showBubble(`${ev.icon || '🔧'} ${ev.detail}`);
      break;
    }
    case 'say':
      if (ev.text && ev.text.length > 2 && state !== 'waiting') {
        const dur = Math.min(6000, Math.max(2200, ev.text.length * 80));
        // Stop 会同批派生 turn-done(happy) + say(talking)：让庆祝先演完，
        // talking 排在 happy 结束后接棒，气泡文本立刻显示不用等。
        if (transientState === 'happy' && perfNow() < transientUntil) {
          showBubble(`💬 ${ev.text}`, Math.min(4200, dur));
          const token = ++sayToken;
          setTimeout(() => {
            if (token === sayToken && state !== 'waiting') transient(ev.emotion || 'talking', dur);
          }, Math.max(0, transientUntil - perfNow()));
        } else if (ev.emotion) {
          // Claude 的话里带情绪（sorry/puzzled/excited）→ 短暂表情替代 talking
          transient(ev.emotion, 2800, `💬 ${ev.text}`, Math.min(4200, ev.text.length * 80));
        } else {
          transient('talking', dur, `💬 ${ev.text}`, Math.min(4200, dur));
        }
      }
      break;
    case 'user-turn':
      // 你的输入里带情绪（loved/sad/excited）→ 打工喵即时反应；否则像以前一样进 thinking
      if (ev.emotion && state !== 'waiting') {
        const tip = ev.emotion === 'loved' ? t('bub.loved') : ev.emotion === 'sad' ? t('bub.sad') : t('bub.ack');
        transient(ev.emotion, 2800, tip, 2600);
      } else {
        // 多会话时聚合里 working > thinking，直接 setState 会在下个快照被盖掉
        // （只闪 ~150ms）。用 transient 保证「刚提交任务」的思考表情至少停留一会。
        if (state !== 'waiting') transient('thinking', 3500);
        showBubble(t('bub.newTask'), 2600);
      }
      break;
    case 'turn-done':
      transient('happy', 1800, t('bub.roundDone'), 3400);
      break;
    case 'big-done':
      transient('happy', 2200, t('bub.bigDone', { ops: ev.ops || '' }), 3800);
      confetti();
      break;
    case 'error':
      transient('error', 2600, ev.text || t('bub.error'), 3000);
      break;
    case 'waiting':
      clearTransient(); // 残留的 talking/thinking 短暂态不得盖过等授权
      setState('waiting');
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice); // 直接弹出选项/输入
      } else {
        showBubble(t('bub.waitYou', { project: ev.project || '', wait: waitPhrase(ev.reason) }), 6000);
      }
      break;
    case 'needsinput':
      // Claude 在末尾问「要不要继续」之类，等你回复 → 黄点 + 可在桌宠上继续/回复
      if (state !== 'waiting') { clearTransient(); setState('needsinput'); }
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice);
      } else {
        showBubble(t('bub.needReply', { project: ev.project || '' }), 6000);
      }
      break;
    case 'greet':
      transient('greet', 2000, t('bub.greet', { project: ev.project || '' }), 2600);
      break;
    case 'longcmd':
      if (state !== 'waiting') showBubble(t('bub.slowCmd'), 3000);
      break;
  }
});

function perfNow() {
  return Date.now();
}

// ---------- 统计 + 聚合状态 ----------
let lastStats = null; // 最近一次快照：transient 到期时用它立即重算聚合态
let sayToken = 0;     // say 接棒 happy 的排队令牌（新事件作废旧排队）
function compactTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

const petInsights = window.WorkMeowPetInsights;
function capsuleElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return '';
  if (value < 60 * 1000) return `${Math.max(1, Math.floor(value / 1000))}秒`;
  if (value < 60 * 60 * 1000) return `${Math.max(1, Math.floor(value / 60000))}分`;
  return `${Math.max(1, Math.floor(value / 3600000))}小时`;
}

function localPurrDay(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function purrAlreadyAnnounced(day) {
  try { return window.localStorage && window.localStorage.getItem(PURR_DAY_STORAGE_KEY) === day; }
  catch { return false; }
}

function markPurrAnnounced(day) {
  try { if (window.localStorage) window.localStorage.setItem(PURR_DAY_STORAGE_KEY, day); }
  catch {}
}

function purrCanRun(stats) {
  if (!stats || !petInsights || typeof petInsights.hasActiveWork !== 'function') return false;
  if (askActive || actionPopOpen || radialOpen || peekOpen) return false;
  // Do not cut across a real completion/error/reply animation.
  if (perfNow() < transientUntil) return false;
  return !petInsights.hasActiveWork(stats, { sleepMs: IDLE_SLEEP_MS });
}

function purrEnvironmentClear(stats) {
  if (!stats || !petInsights || typeof petInsights.hasActiveWork !== 'function') return false;
  if (askActive || actionPopOpen || radialOpen || peekOpen) return false;
  return !petInsights.hasActiveWork(stats, { sleepMs: IDLE_SLEEP_MS });
}

function clearPurrPayday() {
  purrPaydayUntil = 0;
  purrPaydaySummary = null;
  clearTimeout(purrPaydayTimer);
  purrPaydayTimer = null;
}

function renderContextCapsule(s) {
  if (!chip || !chipContext || !s || !petInsights || typeof petInsights.context !== 'function') return;
  const now = perfNow();
  const purrVisible = purrPaydaySummary && purrPaydayUntil > now && purrEnvironmentClear(s);
  if (purrVisible) {
    const purr = purrPaydaySummary;
    chip.dataset.context = 'purr';
    chipContext.textContent = t('purr.title');
    chipTokens.textContent = `${purr.rounds} 轮`;
    chipCost.textContent = `${compactTokens(purr.tokens)} tokens`;
    chip.title = purr.copy || t('purr.titleAttr');
    chip.setAttribute('aria-label', chip.title);
    return;
  }
  if (purrPaydayUntil && !purrEnvironmentClear(s)) clearPurrPayday();

  const info = petInsights.context(s, { sleepMs: IDLE_SLEEP_MS });
  const usage = typeof petInsights.usage === 'function' ? petInsights.usage(s) : {
    rounds: Number(s.today && (s.today.messages || s.today.msgs)) || 0,
    tokens: Number(s.today && s.today.tokens) || 0,
    cost: Number(s.today && s.today.cost) || 0,
  };
  const detail = `${compactTokens(usage.tokens)} tokens · $${usage.cost.toFixed(3)}`;
  let label = '';
  let title = '';
  // A done badge is only the primary capsule state when no higher-priority
  // attention/active state is present. It can coexist with another session's
  // work, so do not let the badge leak into the data-state styling there.
  const showDone = info.recentDone && (info.kind === 'idle' || info.kind === 'sleeping');

  if (info.kind === 'waiting') {
    const total = info.count + (info.needsinput || 0);
    label = `✋ ${total} 件等你`;
    title = `等你处理：${info.count} 项授权${info.needsinput ? ` · ${info.needsinput} 项回复` : ''}`;
  } else if (info.kind === 'needsinput') {
    label = `💬 ${info.count} 件待回复`;
    title = `等你回复：${info.count} 项`;
  } else if (info.kind === 'error') {
    label = `😵 ${info.count} 项异常`;
    title = `任务异常：${info.count} 项`;
  } else if (info.kind === 'active') {
    const icon = SESS_META_ICON[info.state] || '⚙️';
    const stateText = backgroundStatus(info.primary) || t(SESS_META_KEY[info.state] || 'state.working');
    const elapsed = info.primary && info.primary.turnStartedAt
      ? capsuleElapsed(now - Number(info.primary.turnStartedAt))
      : '';
    label = info.activeCount > 1
      ? `${icon}${info.activeCount} 个任务`
      : `${icon}${stateText}${elapsed ? ` · ${elapsed}` : ''}`;
    title = info.activeCount > 1 ? `${info.activeCount} 个任务正在进行` : stateText;
  } else if (showDone) {
    label = '✅ 刚刚完成';
    title = '最近一轮任务已完成';
  } else if (info.kind === 'sleeping') {
    label = '💤 休息中';
    title = '没有活动任务，本喵正在休息';
  } else {
    label = '🌿 待命';
    title = '当前没有活动任务';
  }

  chip.dataset.context = showDone
    ? 'done'
    : (info.kind === 'active' ? `active-${info.state}` : info.kind);
  chipContext.textContent = label;
  chipTokens.textContent = compactTokens(usage.tokens) + ' tokens';
  chipCost.textContent = '$' + usage.cost.toFixed(3);
  const purrHint = !showDone && (info.kind === 'idle' || info.kind === 'sleeping')
    ? ` · ${t('purr.titleAttr')}`
    : '';
  chip.title = `${title} · 今日 ${detail}${purrHint}`;
  chip.setAttribute('aria-label', chip.title);
}

function triggerPurrPayday() {
  if (!purrCanRun(lastStats)) return false;
  const usage = petInsights.usage(lastStats);
  const day = localPurrDay();
  const firstToday = !purrAlreadyAnnounced(day);
  if (firstToday) markPurrAnnounced(day);
  const copy = firstToday
    ? (usage.rounds || usage.tokens
      ? t('purr.first', {
        rounds: usage.rounds,
        tokens: compactTokens(usage.tokens),
        cacheRate: usage.cacheRate == null ? '—' : usage.cacheRate.toFixed(0),
      })
      : t('purr.empty'))
    : t('purr.repeat');
  purrPaydaySummary = { ...usage, copy };
  purrPaydayUntil = perfNow() + PURR_DISPLAY_MS;
  clearTimeout(purrPaydayTimer);
  purrPaydayTimer = setTimeout(() => {
    clearPurrPayday();
    if (lastStats) renderContextCapsule(lastStats);
  }, PURR_DISPLAY_MS + 50);
  if (purrPaydayTimer && typeof purrPaydayTimer.unref === 'function') purrPaydayTimer.unref();
  renderContextCapsule(lastStats);
  transient('loved', 2500, copy, 5200);
  if (firstToday) confetti();
  return true;
}

function applyStats(s) {
  if (!s) return;
  lastStats = s;
  renderContextCapsule(s);
  renderSessions(s.sessions || []);
  updateNotepad(s); // 记事本：行动中心

  // 选项面板：按快照重建队列（多任务都在、标明项目；防漏事件/启动时已在等待）
  refreshAsk(s);
  // 速览不冻结状态机：快照到来时就地更新文字，不关闭/重开。
  if (peekOpen) renderPeek(s);

  // 你正在看面板/打字 → 不再改打工喵状态(别动来动去打断你)，安静等你答完
  if (isInteracting()) return;

  // 聚合梯子，对齐 STATES.md 的优先级表：
  //   waiting > 短暂态 > error(8) > needsinput/notification(7) > sweeping(6)
  //   > juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
  // 之前 working 排在 needsinput 前面，多会话时「等你回复」被干活态彻底盖住。
  if (s.waitingCount > 0) {
    setState('waiting');
  } else if (perfNow() < transientUntil) {
    setState(transientState);
  } else if (s.errorCount > 0) {
    setState('error'); // 有会话卡在 API 错误 → 瘫倒，直到该会话恢复或 oneshot 衰减
  } else if (s.needsinputCount > 0) {
    setState('needsinput');
  } else if (s.sweepingCount > 0) {
    setState('sweeping');
  } else if (s.jugglingCount > 0) {
    setState('juggling');
  } else if (s.workingCount > 0) {
    setState('working');
  } else if (s.thinkingCount > 0) {
    setState('thinking');
  } else if (s.loafingCount > 0) {
    setState('loafing'); // 工具间隙：上一步干完等下一步 → 摸鱼
  } else if (s.idleMs == null || s.idleMs > IDLE_SLEEP_MS) {
    // idleMs=null 表示已无任何活跃会话——什么都没发生就该睡觉；
    // 之前 null 落到 idle，桌宠永不入睡，睡着后会话被回收还会凭空惊醒。
    setState('sleeping');
  } else {
    setState('idle');
  }
}
window.pet.onXiabanSchedule((schedule) => applyXiabanSchedule(schedule));
if (window.pet.onPetAssets) window.pet.onPetAssets((catalog) => applyPetAssetCatalog(catalog));
window.pet.onStats(applyStats);

function renderSessions(sessions) {
  sessionsEl.innerHTML = '';
  // 头顶状态点只展示可见会话，并按状态优先级排列。
  const list = (sessions || []).filter(isBaseVisibleSession).sort((a, b) => {
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'sess-dot ' + sessionDotClass(s);
    const label = s.state === 'waiting' ? waitPhrase(s.reason) : (sessMeta(s.state) || s.state);
    d.title = `${s.project} · ${label}`;
    d.setAttribute('aria-hidden', 'true');
    sessionsEl.appendChild(d);
  }
}

// Static markup carries Chinese text inline; data-i18n keeps the shared wording
// consistent across the pet and detail panel.
function applyStaticI18n() {
  document.documentElement.lang = 'zh-CN';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
    delete el.dataset.ph; // drop the cached original so the warn/restore pair re-seeds
  }
}

// ====================================================================
// 拖动 + 右键菜单（拖动=移动窗口）
// ====================================================================
let g = null; // 当前手势（同步建立，保证快速点击也能识别）
let dragGestureSeq = 0;
function pointerScreenX(e) {
  const value = Number(e && e.screenX);
  if (Number.isFinite(value)) return value;
  return (Number(window.screenX) || 0) + (Number(e && e.clientX) || 0);
}
function pointerScreenY(e) {
  const value = Number(e && e.screenY);
  if (Number.isFinite(value)) return value;
  return (Number(window.screenY) || 0) + (Number(e && e.clientY) || 0);
}
function currentWindowScreenPosition() {
  const x = Number(window.screenX);
  const y = Number(window.screenY);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}
function pointerClientX(e) {
  const value = Number(e && e.clientX);
  if (Number.isFinite(value)) return value;
  return pointerScreenX(e) - (Number(window.screenX) || 0);
}
function pointerClientY(e) {
  const value = Number(e && e.clientY);
  if (Number.isFinite(value)) return value;
  return pointerScreenY(e) - (Number(window.screenY) || 0);
}

function cancelQueuedDragMove(gesture) {
  if (!gesture) return;
  if (gesture.moveFrame !== null) cancelAnimationFrame(gesture.moveFrame);
  gesture.moveFrame = null;
  gesture.pendingMove = null;
}

function flushQueuedDragMove(gesture) {
  if (!gesture) return;
  if (gesture.moveFrame !== null) cancelAnimationFrame(gesture.moveFrame);
  gesture.moveFrame = null;
  const pending = gesture.pendingMove;
  gesture.pendingMove = null;
  if (!pending || g !== gesture || !gesture.moved) return;
  movePetDuringDrag(gesture, pending, pending.targetX, pending.targetY);
}

function queueDragMove(gesture, e, targetX, targetY) {
  // BrowserWindow movement can produce a burst of pointermove events itself.
  // Keep only the newest physical-cursor sample per paint frame; together with
  // main's same-position guard this makes the feedback chain terminate.
  gesture.pendingMove = {
    screenX: pointerScreenX(e),
    screenY: pointerScreenY(e),
    targetX,
    targetY,
  };
  if (gesture.moveFrame !== null) return;
  gesture.moveFrame = requestAnimationFrame(() => flushQueuedDragMove(gesture));
}

function finishDrag(el, e, cancelled) {
  if (!g || g.el !== el) return;
  if (e && Number.isFinite(e.pointerId) && e.pointerId !== g.pid) return;
  const gesture = g;
  const wasMove = gesture.moved;
  const wasPurr = gesture.purrTriggered;
  clearTimeout(gesture.holdTimer);
  if (wasMove && !cancelled) flushQueuedDragMove(gesture);
  else cancelQueuedDragMove(gesture);
  el.classList.remove('dragging');
  g = null;
  try { el.releasePointerCapture(gesture.pid); } catch {}
  try { window.pet.endWinDrag(gesture.id); } catch {}
  if (wasMove) {
    if (peekOpen) closePeek();
    // END_WIN_DRAG is sent after the final position, so the queued size/anchor
    // settlement cannot revive an already released movement gesture.
    setTimeout(settleEdgeLayout, 0);
  } else if (!wasPurr && !cancelled) {
    // 左键短按 = 按当前优先级打开待处理卡/行动中心/工作速览；
    // 拖动仍由上面的 4px 阈值独立裁决，不会误触点击。
    handleCatClick();
  }
}

function attachDrag(el) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
    const gesture = {
      el,
      pid: e.pointerId,
      sx: pointerScreenX(e),
      sy: pointerScreenY(e),
      moved: false,
      purrTriggered: false,
      holdTimer: null,
      id: `${Date.now().toString(36)}-${++dragGestureSeq}`,
      moveSeq: 0,
      moveFrame: null,
      pendingMove: null,
      // Main combines this stable in-window grab point with the authoritative
      // OS cursor. Window-generated pointer events cannot accumulate movement.
      grabX: pointerClientX(e),
      grabY: pointerClientY(e),
      // Prefer the synchronous BrowserWindow coordinates. The IPC result is
      // only a fallback and is ignored once this gesture has a window origin.
      win: currentWindowScreenPosition(),
    };
    g = gesture;
    gesture.holdTimer = setTimeout(() => {
      if (g !== gesture || gesture.moved) return;
      gesture.purrTriggered = triggerPurrPayday();
    }, PURR_HOLD_MS);
    window.pet.getWinPos().then(([wx, wy]) => {
      if (g !== gesture || gesture.win) return;
      if (Number.isFinite(wx) && Number.isFinite(wy)) gesture.win = [wx, wy];
    }).catch(() => {});
  });
  el.addEventListener('pointermove', (e) => {
    if (!g) return;
    if (Number.isFinite(e.pointerId) && e.pointerId !== g.pid) return;
    const dx = pointerScreenX(e) - g.sx;
    const dy = pointerScreenY(e) - g.sy;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
    if (g.moved && g.holdTimer) {
      clearTimeout(g.holdTimer);
      g.holdTimer = null;
    }
    if (g.moved && !g.win) g.win = currentWindowScreenPosition();
    if (g.moved && g.win) {
      if (radialOpen) closeRadial();
      queueDragMove(g, e, g.win[0] + dx, g.win[1] + dy);
    }
  });
  el.addEventListener('pointerup', (e) => finishDrag(el, e, false));
  el.addEventListener('pointercancel', (e) => finishDrag(el, e, true));
  el.addEventListener('lostpointercapture', (e) => finishDrag(el, e, true));
  // 右键 = 泡泡菜单
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleRadial();
  });
}
stateEls.forEach(attachDrag);
cat.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    handleCatClick();
  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    toggleRadial();
  }
});

// 卡片按钮：Submit/Next、Back、Go to Terminal、Other 输入
askSubmit.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicNextOrSubmit(c); });
askBack.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicBack(c); });
askTerm.addEventListener('click', () => { const c = askQueue[askIdx]; if (c) gotoSession(c); });
askText.addEventListener('input', () => updateSubmitEnabled());
// 自定义输入里按回车直接发送（仅 elicitation）；空内容不发、提示别忘了填
askText.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const c = askQueue[askIdx];
  if (!c || !elic) return;
  if (!(askText.value || '').trim()) { warnEmptyInput(); return; }
  if (askSubmit.classList.contains('disabled')) { warnEmptyInput(); return; }
  elicNextOrSubmit(c);
});
// 鼠标在面板上 = 交互中（配合 isInteracting 冻结轮询）
askEl.addEventListener('pointerenter', () => { askHover = true; });
askEl.addEventListener('pointerleave', () => { askHover = false; });

// 记事本：点击开/关 行动中心弹层
notepad.addEventListener('click', (e) => { e.stopPropagation(); actionPopOpen ? closeActionPop() : openActionPop(); });
notepad.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); e.stopPropagation();
  actionPopOpen ? closeActionPop() : openActionPop();
});
notepad.addEventListener('contextmenu', (e) => e.stopPropagation());
document.getElementById('ac-close').addEventListener('click', (e) => { e.stopPropagation(); closeActionPop(); });

actionPop.querySelectorAll('.ac-ops button').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const op = b.dataset.op;
    if (op === 'panel') window.pet.openPanel(AGENT);
    closeActionPop();
  });
});

peekClose.addEventListener('click', (e) => { e.stopPropagation(); closePeek(); });
peekFocus.addEventListener('click', (e) => {
  e.stopPropagation();
  const sessionId = peekPrimarySessionId;
  closePeek();
  requestSessionFocus(sessionId);
});
peekPanel.addEventListener('click', (e) => {
  e.stopPropagation();
  closePeek();
  window.pet.openPanel(AGENT);
});
peekEl.addEventListener('pointerenter', clearPeekTimer);
peekEl.addEventListener('pointerleave', armPeekTimer);
peekEl.addEventListener('contextmenu', (e) => e.stopPropagation());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && peekOpen) {
    e.preventDefault();
    closePeek();
  }
});

// ---------- 泡泡菜单 ----------
let radialOpenSeq = 0;
let lastRadialMetrics = null;
// labelKey (not label): buildRadial resolves Chinese labels at render time.
const MENU = [
  { ic: 'chart',  labelKey: 'menu.panel', act: () => window.pet.openPanel(AGENT) },
  // 收起 = 隐藏这只打工喵（托盘可重新显示）；退出 = 退出整个 app。
  { ic: 'minus',  labelKey: 'menu.collapse', act: () => window.pet.closePet() },
  { ic: 'power', labelKey: 'menu.quit', act: () => window.pet.quit() },
];

function usableRadialMetrics(metrics) {
  if (!metrics || !metrics.window || !metrics.workArea) return null;
  const wr = metrics.window;
  const wa = metrics.workArea;
  if (![wr.x, wr.y, wr.width, wr.height, wa.x, wa.y, wa.width, wa.height].every(Number.isFinite)) return null;
  if (wr.width <= 0 || wr.height <= 0 || wa.width <= 0 || wa.height <= 0) return null;
  return metrics;
}

function radialFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settledRadialMetrics() {
  if (!window.pet || typeof window.pet.getWindowMetrics !== 'function') return null;
  let metrics = null;
  try { metrics = usableRadialMetrics(await window.pet.getWindowMetrics()); } catch { return null; }
  // setPetSize/resetPetSize 在主进程同步落 bounds，但 renderer 的 resize 与
  // flex 重排会晚一拍。等到 DOM viewport 也追上主进程尺寸后再取 pet rect。
  for (let i = 0; metrics && i < 6; i++) {
    const wr = metrics.window;
    const settled = Math.abs((window.innerWidth || 0) - wr.width) <= 1
      && Math.abs((window.innerHeight || 0) - wr.height) <= 1;
    if (settled) break;
    await radialFrame();
    try { metrics = usableRadialMetrics(await window.pet.getWindowMetrics()) || metrics; } catch {}
  }
  await radialFrame();
  return metrics;
}

function buildRadial(metrics = lastRadialMetrics) {
  radial.innerHTML = '';
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height / 2;
  const items = MENU;
  const n = items.length;
  const exact = usableRadialMetrics(metrics);
  if (exact) lastRadialMetrics = exact;
  const frame = exact && exact.window;
  const viewportW = Math.max(1, frame ? frame.width : (window.innerWidth || 320));
  const viewportH = Math.max(1, frame ? frame.height : (window.innerHeight || 340));
  const wa = exact ? exact.workArea : browserWorkArea();
  const winX = frame ? frame.x : (Number.isFinite(window.screenX) ? window.screenX : wa.x);
  const winY = frame ? frame.y : (Number.isFinite(window.screenY) ? window.screenY : wa.y);
  const pad = 5;
  // Intersect the BrowserWindow viewport with the actually visible work area.
  // This protects old saved positions that may still have part of the
  // transparent window off-screen before the first drag normalises them.
  const safeRect = {
    x: Math.max(pad, wa.x - winX + pad),
    y: Math.max(pad, wa.y - winY + pad),
    width: Math.max(46, Math.min(viewportW - pad, wa.x + wa.width - winX - pad) - Math.max(pad, wa.x - winX + pad)),
    height: Math.max(46, Math.min(viewportH - pad, wa.y + wa.height - winY - pad) - Math.max(pad, wa.y - winY + pad)),
  };
  const preferred = [];
  if (edgeLayout.horizontal === 'left') preferred.push('right');
  else if (edgeLayout.horizontal === 'right') preferred.push('left');
  if (edgeLayout.vertical === 'below') preferred.push('below');
  else preferred.push('above');
  preferred.push(edgeLayout.vertical === 'below' ? 'above' : 'below');
  const petLocalRect = { x: r.left - sr.left, y: r.top - sr.top, width: r.width, height: r.height };
  const layout = window.PetGeometry
    ? window.PetGeometry.cornerMenuLayout({
      count: n,
      center: { x: cx, y: cy },
      petRect: petLocalRect,
      safeRect,
      preferred,
      itemRadius: 26,
      gap: 10,
    })
    : { direction: 'top-right', points: [] };
  radial.dataset.direction = layout.direction || 'top-right';
  items.forEach((it, i) => {
    const point = layout.points[i] || { x: cx, y: cy };
    const x = point.x;
    const y = point.y;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'radial-item';
    b.style.left = x + 'px';
    b.style.top = y + 'px';
    b.style.transitionDelay = i * 0.03 + 's';
    const icName = it.ic;
    const icHtml = (window.WorkMeowIcons && window.WorkMeowIcons.icon(icName)) || '';
    b.innerHTML = `<span class="ri-ic oi">${icHtml}</span><span class="ri-lb">${esc(t(it.labelKey))}</span>`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRadial();
      it.act();
    });
    radial.appendChild(b);
  });
}

async function openRadial() {
  const seq = ++radialOpenSeq;
  if (actionPopOpen) closeActionPop();
  if (peekOpen) closePeek();
  radialOpen = true;
  bubble.classList.add('hidden');
  // closeActionPop 会异步把 BrowserWindow 从弹层尺寸缩回基础
  // 尺寸。必须等窗口和 DOM 都归位后再布局，否则菜单会按旧大窗坐标生成，
  // 随后的缩窗会把按钮直接裁出可见区域。
  let metrics = await settledRadialMetrics();
  if (seq !== radialOpenSeq || !radialOpen) return;
  settleEdgeLayout();
  metrics = await settledRadialMetrics() || metrics;
  if (seq !== radialOpenSeq || !radialOpen) return;
  buildRadial(metrics);
  radial.classList.remove('hidden');
}
function closeRadial() {
  radialOpenSeq++;
  radial.classList.add('hidden');
  radialOpen = false;
}
function toggleRadial() {
  if (radialOpen) closeRadial();
  else openRadial().catch(() => closeRadial());
}
// 点遮罩空白处关闭
radial.addEventListener('click', () => closeRadial());
window.addEventListener('blur', () => {
  if (radialOpen) closeRadial();
  if (peekOpen) closePeek();
});

// ---------- 初始化 ----------
(async () => {
  // 单宠：无名牌、无按工具切换的唤起按钮（打工喵一只盯全部）。
  // Convert positions saved by older builds that anchored the transparent
  // window rather than the visible pet.
  requestAnimationFrame(settleEdgeLayout);
  applyStaticI18n();
  if (window.pet.getPetAssets) {
    try { applyPetAssetCatalog(await window.pet.getPetAssets()); } catch {}
  }
  const s = await window.pet.getStats();
  // 有快照就按真实聚合态亮相；之前无条件 setState('idle') 会把刚算出的
  // working/waiting 盖掉，启动瞬间总是先闪一下空闲。getStats 落空但推送
  // 已先到时（lastStats 已有值）同样不能清。
  if (s) applyStats(s);
  else if (!lastStats) setState('idle');
  // 启动正好落在下班窗口时，保留更有时效性的干饭播报，
  // 不再立刻用“上线”气泡覆盖它。
  if (!(XIABAN_STATES.has(state) && xiabanWindow())) showBubble(t('bub.online'), 3000);
})();

// ---------- 透明区域点击穿透（命中测试）----------
// 桌宠窗口是透明矩形，空白处不该拦住后面的应用。光标在内容(打工喵/卡片/菜单/记事本)
// 上 → 接收点击；在透明区 → 让窗口穿透。forward:true 使穿透时 mousemove 仍回传，
// 因此一旦光标回到内容上即可恢复可点。拖动中(g)始终保持可点。
const HIT_SEL = '#cat,#radial,#notepad,#action-pop,#ask,#peek';
let mouseIgnoring = false;
function setMouseIgnore(on) {
  if (on === mouseIgnoring) return;
  mouseIgnoring = on;
  try { window.pet.setIgnoreMouse(on); } catch {}
}
window.addEventListener('mousemove', (e) => {
  if (g) { setMouseIgnore(false); return; } // 拖动中保持可点
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 命中测试权威同步悬停态：穿透切换时 pointerleave 可能漏发，会把 askHover 卡在 true，
  // 进而让 isInteracting() 永远为真、refreshAsk 永不对账（旧卡片冻结、新卡片进不来）。
  askHover = !!(el && el.closest('#ask'));
  setMouseIgnore(!(el && el.closest(HIT_SEL)));
}, true);
// 启动即默认穿透（透明区不挡），光标移到内容上时由上面的命中测试恢复
setMouseIgnore(true);

// 气泡和窗口自适应都可能改变本体在透明窗里的局部位置。
window.addEventListener('resize', () => requestAnimationFrame(() => {
  positionBubbleTip();
}));
