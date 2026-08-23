'use strict';

// 打工喵 WorkMeow — Electron main process.
//
// Boot order: core (session state) → metering (cost) → permissions → HTTP
// server → install Claude Code hooks (using the bound port) → start watcher.
// Wiring: core/permission activity → adapter → pet:event / pet:stats pushed to
// the renderer over the preload IPC contract.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog, shell } = require('electron');
const BRAND = require('./shared/brand');
const { IPC } = require('./shared/ipc-channels');

// Give the dev app the public WorkMeow identity so it isn't shown as a generic
// "Electron" window or confused with an older legacy build.
try { app.setName(BRAND.name); } catch {}
try { app.setAppUserModelId(BRAND.appId); } catch {}

const config = require('./backend/config');
const { createCore } = require('./backend/core');
const { createMetering } = require('./backend/metering');
const { createPricingSync } = require('./backend/pricing-sync');
const { createPermissions } = require('./backend/permission');
const { createServer } = require('./backend/server');
const adapter = require('./backend/adapter');
const hooks = require('./backend/hooks');
const { focusSession } = require('./backend/focus');
const { createCodexWatch } = require('./backend/codex-watch');
const { createTraeWatch } = require('./backend/trae-watch');
const { createCodexMetering } = require('./backend/codex-metering');
const { createWorkbuddyMetering } = require('./backend/workbuddy-metering');
const { createTraeMetering } = require('./backend/trae-metering');
const { createOpenCodeMetering } = require('./backend/opencode-metering');
const { emptyUsage, normalizeSourceRow, mergeUsageRows, mergeDaily } = require('./backend/usage-stats');
const { withValues: withSourceValues } = require('./backend/source-registry');
const transport = require('./backend/transport');
const env = require('./backend/env');
const { migrateLegacyState } = require('./backend/paths');
const i18n = require('./shared/i18n');

const t = i18n.t;

// Windows 下由 `npm start` 的 detached 启动器（start-detached.js）
// 让 GUI 进程脱离启动它的控制台，关闭终端后桌宠仍继续运行。

const PRELOAD = path.join(__dirname, 'preload.js');
const BASE_W = 320, BASE_H = 340;

// 单宠模型（2026-08-07 起）：
//   只有一只「打工喵」(mergedWin, agent='all')，统一展示和统计所有 AI 工具；
//   所有后端只通过这一只喵展示和统计。
// petWin 仅作兼容别名（被旧引用使用）。
let mergedWin = null;
let petWin = null;
let panelWin = null; // 详情面板（唯一，汇总所有工具）
let settingsWin = null; // 设置面板（唯一）
let panelHeight = 0; // 当前自适应高度（防抖用）
let tray = null;
let core = null;
let metering = null;
let pricingSync = null;
let permissions = null;
let server = null;
let stopWatcher = null;
let codexWatch = null;  // Codex rollout 只读监听器
let traeWatch = null;   // TRAE SOLO CN 日志只读监听器
let codexMetering = null; // Codex rollout 累计 token 台账（与状态 watcher 解耦）
let workbuddyMetering = null; // WorkBuddy 转录 token 台账（只读，从 ~/.workbuddy/projects 扫描）
let traeMetering = null; // TRAE agent 日志 token 台账（只读，从 Trae CN logs 扫描）
let opencodeMetering = null; // opencode 用量台账（只读，tail ~/.workmeow/opencode-usage.jsonl）

// 宠物窗口的交互状态（单宠，但保留 Map 结构以便安全处理渲染进程生命周期）。
const petState = new Map(); // id → { agent, win, customSize, mouseIgnoring }
const petStates = () => [...petState.values()].filter((s) => s.win && !s.win.isDestroyed());
const stateOfSender = (sender) => petState.get(sender.id) || null;
const primaryPetState = () => (petWin && !petWin.isDestroyed() ? petState.get(petWin.webContents.id) : null);

let lastStats = null;   // 全量快照（面板与桌宠共用）
let statsTimer = null;
let emitDebounce = null;
const recentOps = []; // ring for the panel "操作流"; newest first, capped

// ── window geometry ───────────────────────────────────────────────────────────
  // customSize is set by the renderer to fit an open popup exactly (dynamic
  // height), so a short popup does not leave a large transparent window.
function targetSize(st) {
  const cs = st && st.customSize;
  if (cs) {
    return { w: Math.min(900, Math.max(BASE_W, cs.w)), h: Math.max(BASE_H, cs.h) };
  }
  return { w: BASE_W, h: BASE_H };
}

function validPetAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const numeric = ['screenX', 'screenY', 'width', 'height', 'xOffset', 'yOffset'];
  if (!numeric.every((key) => Number.isFinite(anchor[key]))) return null;
  if (!(anchor.width > 0) || !(anchor.height > 0)) return null;
  if (!['left', 'center', 'right'].includes(anchor.xAlign)) return null;
  if (!['top', 'bottom'].includes(anchor.yAlign)) return null;
  return anchor;
}

function anchoredPetOrigin(anchor, width, height) {
  let localX;
  if (anchor.xAlign === 'left') localX = anchor.xOffset;
  else if (anchor.xAlign === 'right') localX = width - anchor.xOffset - anchor.width;
  else localX = width / 2 + anchor.xOffset - anchor.width / 2;

  const localY = anchor.yAlign === 'top'
    ? anchor.yOffset
    : height - anchor.yOffset - anchor.height;
  return {
    x: Math.round(anchor.screenX - localX),
    y: Math.round(anchor.screenY - localY),
  };
}

function applyPetSize(st, requestedAnchor) {
  if (!st || !st.win || st.win.isDestroyed()) return;
  const win = st.win;
  const { w } = targetSize(st);
  let { h } = targetSize(st);
  const b = win.getBounds();
  // Cap the window to the screen's work area so a tall popup can NEVER push the
  // pet / footer buttons off-screen — the popup scrolls internally instead.
  try {
    const wa = screen.getDisplayMatching(b).workArea;
    const width = Math.min(w, wa.width);
    h = Math.min(h, wa.height);
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, width, h) : null;
    const cx = b.x + b.width / 2;
    const bottom = b.y + b.height;
    let x = anchored ? anchored.x : Math.round(cx - width / 2);
    let y = anchored ? anchored.y : Math.round(bottom - h);
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
    win.setBounds({ x, y, width, height: h });
  } catch {
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, w, h) : null;
    const bottom = b.y + b.height;
    win.setBounds({ x: anchored ? anchored.x : b.x, y: anchored ? anchored.y : Math.round(bottom - h), width: w, height: h });
  }
}

// 单宠：永远只有一只合并宠盯全部后端。
function createPetWindows() {
  reconcilePets();
}

function persistPos(b) {
  config.save({ petPosition: { x: b.x, y: b.y } });
}

function makePetWindow(agent) {
  agent = 'all'; // 单宠：忽略入参，恒为合并宠
  const c = config.get();
  const saved = c.petPosition;
  let x, y;
  if (saved) { x = saved.x; y = saved.y; }
  else {
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      x = wa.x + wa.width - BASE_W - 24;
      y = wa.y + wa.height - BASE_H - 24;
    } catch {}
  }

  const win = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    x, y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  hardenWindow(win, path.join(__dirname, 'renderer', 'pet.html'));
  // ?agent= 仅保留兼容参数；单宠模式始终由统一的 all 形象渲染。
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'), { query: { agent } });

  // mouseIgnoring=true：透明窗启动即穿透，renderer 命中测试后再接管（pet.js 同款默认）
  const st = { agent, win, customSize: null, mouseIgnoring: true };
  // 'closed' 之后绝不能再碰 win.webContents（抛 "Object has been destroyed"，主进程
  // 未捕获直接崩）——id 在创建时取好。
  const wcId = win.webContents.id;
  petState.set(wcId, st);
  win.on('closed', () => {
    petState.delete(wcId);
    if (petWin === win) petWin = null;
    if (mergedWin === win) mergedWin = null;
  });

  win.on('moved', () => {
    if (st.customSize) return; // only persist the resting position
    if (win.isDestroyed()) return;
    persistPos(win.getBounds());
  });
  win.webContents.on('did-finish-load', () => {
    sendWin(win, IPC.XIABAN_SCHEDULE, getXiabanSchedule());
    if (core) sendWin(win, IPC.PET_STATS, buildStats(st.agent));
  });
  return win;
}

// 详情面板：唯一一个，汇总所有 AI 工具的用量（agent 参数保留仅为兼容旧调用）。
function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show(); panelWin.focus();
    return;
  }
  panelHeight = 0;
  const win = new BrowserWindow({
    width: 580,
    height: 850,
    minHeight: 500,
    frame: false,
    transparent: false,
    resizable: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#eef4fc', // 与面板淡蓝配色一致，避免加载白闪
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(win, path.join(__dirname, 'renderer', 'panel.html'));
  panelWin = win;
  win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { query: { agent: 'all' } });
  win.webContents.on('did-finish-load', () => {
    sendWin(win, IPC.PANEL_PRICE, combinedPriceInfo());
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.show();
      } catch {}
    }, 120);
  });
  win.on('closed', () => { if (panelWin === win) panelWin = null; panelHeight = 0; });
}

function closePanel() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  panelWin = null;
  panelHeight = 0;
}

// 设置面板：沿用详情面板的无边框玻璃卡片风格，集中放置用户偏好。
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show(); settingsWin.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 440,
    height: 540,
    minWidth: 400,
    minHeight: 460,
    frame: false,
    transparent: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: false,
    show: false,
    center: true,
    backgroundColor: '#eef4fc',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(win, path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin = win;
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.show();
      } catch {}
    }, 80);
  });
  win.on('closed', () => { if (settingsWin === win) settingsWin = null; });
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  settingsWin = null;
}

// 显示/藏起打工喵（单宠：只有一个开关）。
function showPet() {
  if (!mergedWin || mergedWin.isDestroyed()) reconcilePets();
  if (mergedWin && !mergedWin.isDestroyed()) mergedWin.show();
  refreshTrayMenu();
}
function hidePet() {
  if (mergedWin && !mergedWin.isDestroyed()) mergedWin.hide();
  refreshTrayMenu();
}


// Block any navigation / new-window to external content (hardening).
function hardenWindow(win, allowedFile = null) {
  const allowedPath = allowedFile ? path.resolve(allowedFile) : null;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const next = new URL(url);
      const nextPath = next.protocol === 'file:' ? path.resolve(fileURLToPath(next)) : null;
      if (next.protocol !== 'file:' || (allowedPath && nextPath !== allowedPath)) e.preventDefault();
    } catch { e.preventDefault(); }
  });
  win.webContents.on('will-redirect', (e) => e.preventDefault());
}

// ── push helpers ──────────────────────────────────────────────────────────────
function sendWin(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function firstAlivePetWin() {
  return mergedWin && !mergedWin.isDestroyed() ? mergedWin : null;
}
function sendPet(channel, payload) { sendWin(firstAlivePetWin(), channel, payload); }
function sendPanel(channel, payload) { sendWin(panelWin, channel, payload); }

function meterInstances() {
  return {
    claude: metering,
    codex: codexMetering,
    workbuddy: workbuddyMetering,
    trae: traeMetering,
    opencode: opencodeMetering,
  };
}

function meterStats() {
  return Object.fromEntries(withSourceValues(meterInstances()).map(({ id, value }) => [
    id,
    value && typeof value.getStats === 'function' ? value.getStats() : null,
  ]));
}

// The detail panel shows a merged ledger, so its price badge must describe the
// merged sources too. Reporting Claude alone made the badge look online even
// when another provider was still using a stale or built-in table.
function combinedPriceInfo() {
  const items = withSourceValues(meterInstances()).flatMap(({ id, label, value: meter }) => {
    if (!meter || typeof meter.priceInfo !== 'function') return [];
    try { return [{ id, name: label, ...meter.priceInfo() }]; } catch { return []; }
  });
  const liveCount = items.filter((item) => item.live).length;
  const live = items.length > 0 && liveCount === items.length;
  const ts = items.reduce((max, item) => Math.max(max, Number(item.ts) || 0), 0);
  const count = items.reduce((max, item) => Math.max(max, Number(item.count) || 0), 0);
  return {
    live,
    mixed: liveCount > 0 && liveCount < items.length,
    count,
    ts,
    source: [...new Set(items.map((item) => item.source).filter(Boolean))].join(' + ') || 'builtin',
    stale: items.some((item) => item.stale),
    estimate: items.some((item) => item.estimate),
    sources: items,
    sync: pricingSync && typeof pricingSync.getStatus === 'function'
      ? pricingSync.getStatus()
      : null,
  };
}

// 单宠：所有事件都发给这唯一的一只打工喵。
function sendPetEvent(ev) {
  sendPet(IPC.PET_EVENT, ev);
}

// 没有计量数据源的工具（未来工具）用的空台账
function emptyMeter() {
  return {
    today: emptyUsage(),
    lifetime: emptyUsage(),
    byModel: {}, hourly: new Array(24).fill(0), hourlyTok: new Array(24).fill(0), daily: {}, diagnostics: null,
  };
}

// 统一统计（2026-08-07 起）：不分工具，所有数据源合并成一份台账对外展示。
// agent 参数保留仅为兼容旧调用，取值不影响结果。
function buildStats(agent = 'all', snapshot = null, cachedMeter = null) {
  const snap = snapshot || core.buildSnapshot();
  // 使用缓存的 metering 数据避免重复调用 getStats()
  const sourceRows = withSourceValues(cachedMeter || meterStats()).map(({ id, value }) => [id, value]);
  const usageBySource = Object.fromEntries(sourceRows);
  const claudeMeter = usageBySource.claude;
  const codexUsage = usageBySource.codex;
  const workbuddyUsage = usageBySource.workbuddy;
  const traeUsage = usageBySource.trae;
  const opencodeUsage = usageBySource.opencode;

  // 合并所有已接入的数据源；来源顺序由 source-registry 统一维护。
  const sourceMeters = sourceRows;
  const meter = claudeMeter ? { ...claudeMeter } : emptyMeter();
  meter.today = mergeUsageRows(sourceMeters.map(([source, usage]) => [source, usage && usage.today]));
  meter.lifetime = mergeUsageRows(sourceMeters.map(([source, usage]) => [source, usage && usage.lifetime]));
  // Each metering source already keeps a retained daily ledger. Expose the
  // merged ledger so the panel can switch between today/7d/30d without
  // silently dropping Codex, WorkBuddy, TRAE or opencode history.
  meter.daily = mergeDaily(sourceMeters);
  const mergeHourly = (key) => Array.from({ length: 24 }, (_, i) => sourceRows.reduce(
    (sum, [, usage]) => sum + ((usage && usage[key] && usage[key][i]) || 0), 0,
  ));
  meter.hourly = mergeHourly('hourly');
  meter.hourlyTok = mergeHourly('hourlyTok');
  // 按模型合并：同名模型（如各工具都跑 glm-5）聚合成一行。
  const byModel = {};
  for (const [source, usage] of sourceRows) {
    const src = usage && usage.byModel;
    if (!src) continue;
    for (const [model, row] of Object.entries(src)) {
      const normalized = normalizeSourceRow(source, row);
      const acc = (byModel[model] = byModel[model] || {
        tokens: 0, cost: 0, msgs: 0, messages: 0, input: 0, output: 0,
        inputTotal: 0, cachedInput: 0, cacheRead: 0, cacheWrite5m: 0,
        cacheWrite1h: 0, cacheCreate: 0, reasoningOutput: 0,
      });
      acc.tokens += normalized.tokens;
      acc.cost += normalized.cost;
      acc.msgs += normalized.msgs;
      acc.messages = acc.msgs;
      acc.input += normalized.input;
      acc.output += normalized.output;
      acc.inputTotal += normalized.inputTotal;
      // cacheRead is the single normalized cache-read field. Do not add
      // opencode's cachedInput and its mapped cacheRead twice.
      acc.cacheRead += normalized.cacheRead;
      acc.cacheWrite5m += normalized.cacheWrite5m;
      acc.cacheWrite1h += normalized.cacheWrite1h;
      acc.cacheCreate += normalized.cacheCreate;
      acc.reasoningOutput += normalized.reasoningOutput;
    }
  }
  meter.byModel = byModel;

  const pending = permissions.getPending();
  const ops = recentOps.slice(0, 30);
  return adapter.buildPetStats(snap, pending, meter, {
    lastOps: ops,
    codexUsage,
    usageProvider: 'all',
  });
}


function recordOp(ev) {
  if (ev.kind === 'operation') {
    recentOps.unshift({ tool: ev.tool, icon: ev.icon, detail: ev.detail, file: ev.file || '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
  } else if (ev.kind === 'say') {
    recentOps.unshift({ tool: 'say', icon: '💬', detail: ev.text, file: '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
  } else return;
  if (recentOps.length > 50) recentOps.length = 50;
}

function emitStats() {
  if (!core) return;
  const snapshot = core.buildSnapshot();
  // 一次性获取 metering 数据，避免多次调用 getStats()
  const cachedMeter = meterStats();
  lastStats = buildStats('all', snapshot, cachedMeter);
  for (const st of petStates()) sendWin(st.win, IPC.PET_STATS, lastStats);
  sendPanel(IPC.PANEL_STATS, lastStats);
}

function scheduleEmit() {
  if (emitDebounce) return;
  emitDebounce = setTimeout(() => { emitDebounce = null; emitStats(); }, 150);
}

function bootBackend() {
  const codexDir = env.value('CODEX_DIR') || undefined;
  core = createCore({
    onActivity: (act) => {
      for (const ev of adapter.activityToEvents(act)) { recordOp(ev); sendPetEvent(ev); }
    },

    onDirty: scheduleEmit,
  });
  core.startStaleCleanup();
  if (!env.flag('NO_CODEX')) {
    codexMetering = createCodexMetering({
      sessionsDir: codexDir,
    });
    codexMetering.start(30000);
    codexWatch = createCodexWatch({
      core,
      // 开发/E2E 可用 WORKMEOW_CODEX_DIR 指到假目录，不碰真实 ~/.codex
      sessionsDir: codexDir,
    });
    codexWatch.start();
  }

  metering = createMetering();
  metering.start(30000);

  // WorkBuddy token ledger: scans ~/.workbuddy/projects transcripts read-only.
  // Same gating as Codex (WORKMEOW_NO_CODEX disables that; no equivalent flag yet
  // for WorkBuddy, but it's cheap and isolated).
  workbuddyMetering = createWorkbuddyMetering({
    projectsDir: env.value('WORKBUDDY_DIR') || undefined,
  });
  workbuddyMetering.start(30000);

  // TRAE token ledger: scans Trae CN ai-agent stdout logs read-only
  // (token usage: TokenUsageEvent lines). Pricing uses the models.dev cache.
  traeMetering = createTraeMetering({
    logsRoot: env.value('TRAE_DIR') || undefined,
  });
  traeMetering.start(30000);

  // opencode 用量台账：tail ~/.workmeow/opencode-usage.jsonl（插件写入），
  // 只读，与状态推送（插件直接 POST /state）解耦。WORKMEOW_NO_OPENCODE=1 跳过。
  if (!env.flag('NO_OPENCODE')) {
    opencodeMetering = createOpenCodeMetering({
      usageFile: env.value('OPENCODE_USAGE') || undefined,
    });
    opencodeMetering.start(30000);
  }

  // TRAE 状态监听：TRAE SOLO CN 的内置 agent 不支持 Claude hooks，唯一可靠
  // 的活动信号源是 ai-agent stdout 日志。读日志增量 tail 把工具生命周期
  // (hook=PreToolUse/PostToolUse) 翻译成 core 状态流。
  if (!env.flag('NO_TRAE')) {
    traeWatch = createTraeWatch({ core });
    traeWatch.start();
  }

  // Pricing sync: fetches models.dev's open pricing JSON once on boot + every 24h.
  // metering.loadPricing() now reads ~/.workmeow/pricing-cache.json beneath the
  // user override. Public-data only — no credentials, no API calls.
  // On a fresh sync: reload the in-memory price table (so new prices apply this
  // run, not next restart) and push the updated source line to the panel.
  // WORKMEOW_NO_NET=1 keeps the app fully offline (the pricing fetch is the ONLY
  // outbound request WorkMeow ever makes) — falls back to the built-in price table.
  if (!env.flag('NO_NET')) {
    pricingSync = createPricingSync({
      onStatus: () => {
        sendPanel(IPC.PANEL_PRICE, combinedPriceInfo());
      },
      onUpdate: async () => {
        const rebuilds = [];
        if (metering) {
          try {
            const result = metering.reloadPricing();
            if (result && typeof result.then === 'function') rebuilds.push(result);
          } catch {}
        }
        for (const { id, value: meter } of withSourceValues(meterInstances())) {
          if (id === 'claude') continue;
          if (!meter) continue;
          try {
            const result = id === 'workbuddy' && typeof meter.reloadPricing === 'function'
              ? meter.reloadPricing()
              : typeof meter.rebuild === 'function' ? meter.rebuild() : null;
            if (result && typeof result.then === 'function') rebuilds.push(result);
          } catch {}
        }
        await Promise.allSettled(rebuilds);
        sendPanel(IPC.PANEL_PRICE, combinedPriceInfo());
        scheduleEmit();
      },
    });
    pricingSync.start();
  }

  permissions = createPermissions({
    onAdded: (entry) => {
      const session = core.getSession(entry.sessionId);
      const lite = session ? {
        id: session.id,
        cwd: session.cwd,
        sessionTitle: session.sessionTitle,
        agentId: session.agentId,
      } : null;
      let choice, kind, reason;
      if (entry.isElicitation) {
        choice = adapter.buildElicitationChoice(
          { id: entry.id, sessionId: entry.sessionId, questions: entry.questions }, lite);
        kind = 'needsinput'; reason = 'reply';
      } else if (entry.toolName === 'ExitPlanMode') {
        choice = adapter.buildPlanChoice(
          { id: entry.id, sessionId: entry.sessionId, toolInput: entry.toolInput }, lite);
        kind = 'needsinput'; reason = 'plan';
      } else {
        choice = adapter.buildPermChoice(
          {
            id: entry.id,
            sessionId: entry.sessionId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            suggestions: entry.suggestions,
          },
          lite,
        );
        kind = 'waiting'; reason = 'perm';
      }
      // A parked permission needs the user's eyes. In menubar mode (or if the pet
      // was hidden) the ask panel would render into an invisible window and CC
      // would hang until the park times out — so surface the pet window first.
      try { const w = firstAlivePetWin(); if (w && !w.isVisible()) w.show(); } catch {}
      sendPetEvent({ kind, project: choice.project, reason, sessionId: entry.sessionId, choice, agent: 'claude', ts: Date.now() });
      scheduleEmit();
    },
    onChange: scheduleEmit,
  });

  server = createServer({ core, permissions });
  server.start();

  // Install hooks once the server has a port (defer so listen wins the race).
  // WORKMEOW_NO_HOOKS=1 skips touching ~/.claude/settings.json +
  // ~/.trae-cn/hooks.json + ~/.workbuddy/settings.json +
  // ~/.config/opencode/plugins/opencode-plugin.js (dev/verify mode).
  setTimeout(() => {
    if (env.flag('NO_HOOKS') || config.get().hooksEnabled === false) {
      return;
    }
    const port = server.getPort();
    if (port) {
      const report = hooks.install(port, server.getToken());
      stopWatcher = hooks.startWatcher(() => ({ port: server.getPort(), token: server.getToken() }));
      if (config.get().onboardingVersion < 1) {
        config.save({ onboardingVersion: 1 });
        showIntegrationStatus(report);
      }
    }
  }, 400);

  // Periodic refresh so idle→sleeping transitions + cost updates reach the UI.
  statsTimer = setInterval(emitStats, 4000);
  if (statsTimer.unref) statsTimer.unref();
}

// minimal entry shape for adapter.projectName()
function registerIpc() {
  const senderPetWin = (e) => {
    const st = stateOfSender(e.sender);
    if (st && st.win && !st.win.isDestroyed()) return st.win;
    return petWin && !petWin.isDestroyed() ? petWin : null;
  };

  ipcMain.handle(IPC.GET_STATS, () => lastStats || buildStats());
  ipcMain.handle(IPC.GET_WIN_POS, (e) => {
    const win = senderPetWin(e);
    if (!win) return [0, 0];
    const b = win.getBounds();
    return [b.x, b.y];
  });
  ipcMain.handle(IPC.GET_WINDOW_METRICS, (e) => {
    const win = senderPetWin(e);
    if (!win) return null;
    const windowBounds = win.getBounds();
    let workArea = null;
    try { workArea = screen.getDisplayMatching(windowBounds).workArea; } catch {}
    return { window: windowBounds, workArea };
  });

  ipcMain.on(IPC.SET_WIN_POS, (e, x, y) => {
    const win = senderPetWin(e);
    if (win && Number.isFinite(x) && Number.isFinite(y)) {
      const b = win.getBounds();
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
    }
  });

  ipcMain.on(IPC.OPEN_PANEL, (_e, agent) => openPanel(agent || 'all'));
  ipcMain.on(IPC.CLOSE_PANEL, closePanel);
  ipcMain.handle(IPC.GET_AUTO_LAUNCH, () => getAutoLaunchStatus());
  ipcMain.handle(IPC.SET_AUTO_LAUNCH, (_e, enabled) => setAutoLaunch(enabled));
  ipcMain.handle(IPC.GET_XIABAN_SCHEDULE, () => getXiabanSchedule());
  ipcMain.handle(IPC.SET_XIABAN_SCHEDULE, (_e, schedule) => setXiabanSchedule(schedule));
  ipcMain.on(IPC.CLOSE_SETTINGS, closeSettings);

  // 详情面板按内容高度自适应：clamp 到屏幕工作区，阈值防抖避免每次 stats 都抖
  ipcMain.on(IPC.SET_PANEL_HEIGHT, (e, h) => {
    const win = BrowserWindow.fromId(e.sender.id);
    if (!win || win.isDestroyed() || win !== panelWin || !Number.isFinite(h)) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const clamped = Math.max(320, Math.min(Math.round(h), wa.height - 24));
    if (Math.abs(clamped - panelHeight) < 6) return;
    panelHeight = clamped;
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: clamped });
  });

  ipcMain.on(IPC.QUIT_APP, () => app.quit());
  // 收起 = 隐藏唯一的一只打工喵（托盘菜单可重新显示）。
  ipcMain.on(IPC.CLOSE_PET, (e) => {
    const st = stateOfSender(e.sender);
    if (!st || !st.win || st.win.isDestroyed()) return;
    st.win.hide();
    refreshTrayMenu();
  });

  ipcMain.handle(IPC.PERMISSION_DECIDE, (_e, permId, behavior) => {
    if (!permissions || typeof permId !== 'string' || !permId) return false;
    return permissions.decide(permId, behavior) === true;
  });
  ipcMain.handle(IPC.FOCUS_SESSION, (_e, sessionId) => {
    return focusSession(core.getSession(sessionId), {
      openExternal: (url) => shell.openExternal(url),
    });
  });
  // Dynamic sizing: renderer measures the open popup and asks for an exact fit.
  // w/h <= 0 resets to the base pet size.
  ipcMain.on(IPC.SET_PET_SIZE, (e, w, h, anchor) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = (Number(w) > 0 && Number(h) > 0) ? { w: Number(w), h: Number(h) } : null;
    applyPetSize(st, anchor);
  });
  ipcMain.on(IPC.PET_BLUR, (e) => { const w = senderPetWin(e); if (w) { w.blur(); } });

  // Click-through: the renderer hit-tests the cursor and toggles this so the
  // transparent parts of the pet window let clicks reach apps behind it.
  // forward:true keeps mousemove flowing to the renderer while ignoring, so it
  // can re-enable clicks the moment the cursor returns to the pet/content.
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (e, ignore) => {
    const st = stateOfSender(e.sender);
    const w = st && st.win && !st.win.isDestroyed() ? st.win : null;
    if (!w) return;
    st.mouseIgnoring = !!ignore; // 记录 renderer 期望的穿透状态
    try { w.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {}
  });

}

// 单宠对账：确保唯一的一只打工喵存在。不存在就创建；存在就不动。
function reconcilePets() {
  if (!mergedWin || mergedWin.isDestroyed()) mergedWin = makePetWindow('all');
  petWin = mergedWin; // 兼容别名
}

// ── tray ──────────────────────────────────────────────────────────────────────
function buildTray() {
  let img;
  try {
    // 使用透明背景的打工喵头像，resize 到 tray 适合的尺寸。
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-cat.png'));
    if (img && !img.isEmpty()) {
      img = img.resize({ width: 32, height: 32 });
    }
  } catch {}
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip(t('tray.tooltip'));
  refreshTrayMenu();
  tray.on('click', () => { showPet(); });
}

function showIntegrationStatus(report = null) {
  const port = server && server.getPort();
  const token = server && server.getToken();
  const integrations = report && Array.isArray(report.integrations)
    ? report.integrations
    : hooks.integrationStatus(port, token);
  const codexDetected = fs.existsSync(path.join(os.homedir(), '.codex'));
  const rows = [
    { label: 'Codex', detected: codexDetected, connected: codexDetected && Boolean(codexWatch) },
    ...integrations,
  ];
  const detail = rows.map((row) => {
    const ready = row.detected && row.connected;
    const key = ready
      ? 'dlg.integrationsReady'
      : row.detected ? 'dlg.integrationsFailed' : 'dlg.integrationsMissing';
    return `${ready ? '✓' : '—'} ${row.label}：${t(key)}`;
  }).join('\n') + `\n\n${t('dlg.integrationsHint')}`;
  dialog.showMessageBox({
    type: 'info',
    title: t('dlg.integrationsTitle'),
    message: t('dlg.integrationsMessage'),
    detail,
    buttons: ['开始使用'],
    defaultId: 0,
    noLink: true,
  }).catch(() => {});
}

function autoLaunchMatchOptions() {
  const options = {};
  // In development, Windows needs the Electron executable plus the project
  // path. Packaged builds launch the application executable directly.
  if (process.platform === 'win32') {
    options.path = process.execPath;
    options.args = app.isPackaged ? [] : [app.getAppPath()];
  }
  return options;
}

function autoLaunchSettings(enabled) {
  return { ...autoLaunchMatchOptions(), openAtLogin: !!enabled };
}

function autoLaunchSupported() {
  return process.platform === 'win32'
    && typeof app.getLoginItemSettings === 'function'
    && typeof app.setLoginItemSettings === 'function';
}

function getAutoLaunchStatus() {
  if (!autoLaunchSupported()) return { supported: false, enabled: false, error: null };
  try {
    const settings = app.getLoginItemSettings(autoLaunchMatchOptions());
    // Windows can report openAtLogin=false when the registered path/args do
    // not exactly match the current process. executableWillLaunchAtLogin is
    // the reliable answer to whether this executable will run at login.
    const enabled = process.platform === 'win32'
      ? !!settings.executableWillLaunchAtLogin
      : !!settings.openAtLogin;
    return { supported: true, enabled, error: null };
  } catch {
    return { supported: true, enabled: false, error: 'read' };
  }
}

function setAutoLaunch(enabled) {
  const desired = !!enabled;
  if (!autoLaunchSupported()) return { supported: false, enabled: false, ok: false, error: 'unsupported' };
  try {
    app.setLoginItemSettings(autoLaunchSettings(desired));
  } catch {
    return { ...getAutoLaunchStatus(), ok: false, error: 'write' };
  }
  const status = getAutoLaunchStatus();
  refreshTrayMenu();
  return { ...status, ok: !status.error && status.enabled === desired };
}

function getXiabanSchedule() {
  const times = config.get().xiabanTimes || config.DEFAULT_XIABAN_TIMES;
  return {
    lunch: times.lunch,
    evening: times.evening,
  };
}

function setXiabanSchedule(schedule) {
  const current = getXiabanSchedule();
  if (!schedule || !config.isClockTime(schedule.lunch) || !config.isClockTime(schedule.evening)) {
    return { ok: false, schedule: current, error: 'invalid' };
  }
  const next = { lunch: schedule.lunch, evening: schedule.evening };
  const saved = config.save({ xiabanTimes: next });
  const actual = saved && saved.xiabanTimes ? {
    lunch: saved.xiabanTimes.lunch,
    evening: saved.xiabanTimes.evening,
  } : current;
  const ok = actual.lunch === next.lunch && actual.evening === next.evening;
  if (ok) sendPet(IPC.XIABAN_SCHEDULE, actual);
  return { ok, schedule: actual, error: ok ? null : 'write' };
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip(t('tray.tooltip'));
  const petVisible = !!(mergedWin && !mergedWin.isDestroyed() && mergedWin.isVisible());
  const items = [
    { label: t('tray.panel'), click: () => openPanel() },
    { label: petVisible ? t('tray.hidePet') : t('tray.showPet'), click: () => (petVisible ? hidePet() : showPet()) },
    { type: 'separator' },
    { label: t('tray.settings'), click: () => openSettings() },
    { type: 'separator' },
    { label: t('tray.integrations'), click: () => showIntegrationStatus() },
    { label: t('tray.uninstallHook'), click: () => {
      try { if (stopWatcher) { stopWatcher(); stopWatcher = null; } } catch {}
      hooks.uninstall();
    } },
    { label: t('tray.quit'), click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
// 多实例防护（对齐 clawd-on-desk 的处理）：
//  1) Electron 实例锁：同一份 app 重复启动 → 新实例静默退出；
//  2) 启动探测：候选端口上已有同身份 server 在跑（多为另一份代码副本）→ 提示并退出；
//  3) server.js 里的 runtime 守护：存活期间 runtime.json 被别的副本覆盖 → 抢回。
// 开发需要多开时用 WORKMEOW_ALLOW_MULTI=1 跳过 1/2。
const allowMulti = env.flag('ALLOW_MULTI');

// 并行探测所有候选端口，找到任一存活的同身份 server 就返回其端口
function findRivalInstance() {
  if (allowMulti) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = transport.PORTS.length;
    let found = null;
    for (const p of transport.PORTS) {
      transport.probe(p, 600, (ok) => {
        if (ok && found === null) found = p;
        if (--pending === 0) resolve(found);
      });
    }
  });
}

const gotTheLock = allowMulti ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => { try { for (const st of petStates()) st.win.show(); } catch {} });
  app.whenReady().then(async () => {
    const rival = await findRivalInstance();
    if (rival) {
      dialog.showErrorBox(
        t('dlg.dupTitle'),
        t('dlg.dupBody', { port: rival }) + t('dlg.dupHint')
      );
      app.quit();
      return;
    }
    migrateLegacyState();
    // Rewrite legacy config once so removed appearance/layout/budget fields disappear
    // from ~/.workmeow/config.json instead of remaining as dead state.
    config.save({});
    registerIpc();
    bootBackend();
    createPetWindows();
    try { buildTray(); } catch {}
  });
}

app.on('window-all-closed', () => { /* tray app: stay alive */ });

app.on('before-quit', () => {
  try { if (codexWatch) codexWatch.stop(); } catch {}
  try { if (traeWatch) traeWatch.stop(); } catch {}
  try { if (stopWatcher) stopWatcher(); } catch {}
  try { if (permissions) permissions.cleanup(); } catch {}
  try { if (server) server.stop(); } catch {}
  try { if (metering) metering.stop(); } catch {}
  try { if (codexMetering) codexMetering.stop(); } catch {}
  try { if (workbuddyMetering) workbuddyMetering.stop(); } catch {}
  try { if (traeMetering) traeMetering.stop(); } catch {}
  try { if (opencodeMetering) opencodeMetering.stop(); } catch {}
  try { if (pricingSync) pricingSync.stop(); } catch {}
  try { if (core) core.stopStaleCleanup(); } catch {}
});
