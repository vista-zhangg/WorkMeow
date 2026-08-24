'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preload scripts cannot require application files. This literal is
// checked against shared/ipc-channels.js by test/ipc-contract.js.
const IPC = Object.freeze({
  PET_EVENT: 'pet:event', PET_STATS: 'pet:stats', PANEL_STATS: 'panel:stats', PANEL_PRICE: 'panel:price',
  GET_STATS: 'get-stats', GET_WIN_POS: 'get-win-pos', GET_WINDOW_METRICS: 'get-window-metrics',
  XIABAN_SCHEDULE: 'xiaban:schedule',
  PET_ASSETS: 'pet-assets:changed',
  SET_WIN_POS: 'set-win-pos', OPEN_PANEL: 'open-panel', CLOSE_PANEL: 'close-panel',
  GET_AUTO_LAUNCH: 'get-auto-launch', SET_AUTO_LAUNCH: 'set-auto-launch',
  GET_XIABAN_SCHEDULE: 'get-xiaban-schedule', SET_XIABAN_SCHEDULE: 'set-xiaban-schedule',
  GET_PET_ASSETS: 'get-pet-assets', IMPORT_PET_GIF: 'import-pet-gif',
  REMOVE_PET_ASSET: 'remove-pet-asset', RESET_PET_SLOT: 'reset-pet-slot',
  CLOSE_SETTINGS: 'close-settings',
  SET_PANEL_HEIGHT: 'set-panel-height', QUIT_APP: 'quit-app', CLOSE_PET: 'close-pet',
  PERMISSION_DECIDE: 'permission-decide', FOCUS_SESSION: 'focus-session', SET_PET_SIZE: 'set-pet-size',
  PET_BLUR: 'pet-blur', SET_IGNORE_MOUSE: 'set-ignore-mouse',
});

contextBridge.exposeInMainWorld('pet', {
  // 主进程 -> 渲染进程
  onEvent: (cb) => ipcRenderer.on(IPC.PET_EVENT, (_e, data) => cb(data)),
  onStats: (cb) => ipcRenderer.on(IPC.PET_STATS, (_e, data) => cb(data)),
  onPanelStats: (cb) => ipcRenderer.on(IPC.PANEL_STATS, (_e, data) => cb(data)),
  onPrice: (cb) => ipcRenderer.on(IPC.PANEL_PRICE, (_e, data) => cb(data)),
  onXiabanSchedule: (cb) => ipcRenderer.on(IPC.XIABAN_SCHEDULE, (_e, data) => cb(data)),
  onPetAssets: (cb) => ipcRenderer.on(IPC.PET_ASSETS, (_e, data) => cb(data)),
  // 渲染进程 -> 主进程
  getStats: () => ipcRenderer.invoke(IPC.GET_STATS),
  openPanel: (agent) => ipcRenderer.send(IPC.OPEN_PANEL, agent || 'all'),
  closePanel: () => ipcRenderer.send(IPC.CLOSE_PANEL),
  getAutoLaunch: () => ipcRenderer.invoke(IPC.GET_AUTO_LAUNCH),
  setAutoLaunch: (enabled) => ipcRenderer.invoke(IPC.SET_AUTO_LAUNCH, !!enabled),
  getXiabanSchedule: () => ipcRenderer.invoke(IPC.GET_XIABAN_SCHEDULE),
  setXiabanSchedule: (schedule) => ipcRenderer.invoke(IPC.SET_XIABAN_SCHEDULE, schedule),
  getPetAssets: () => ipcRenderer.invoke(IPC.GET_PET_ASSETS),
  importPetGif: (slotId, mode, options) => ipcRenderer.invoke(IPC.IMPORT_PET_GIF, slotId, mode, options || {}),
  removePetAsset: (slotId, assetId) => ipcRenderer.invoke(IPC.REMOVE_PET_ASSET, slotId, assetId),
  resetPetSlot: (slotId) => ipcRenderer.invoke(IPC.RESET_PET_SLOT, slotId),
  closeSettings: () => ipcRenderer.send(IPC.CLOSE_SETTINGS),
  quit: () => ipcRenderer.send(IPC.QUIT_APP),
  // 单宠模式：收起唯一的一只打工喵。
  closePet: () => ipcRenderer.send(IPC.CLOSE_PET),
  // 手动拖动窗口
  getWinPos: () => ipcRenderer.invoke(IPC.GET_WIN_POS),
  getWindowMetrics: () => ipcRenderer.invoke(IPC.GET_WINDOW_METRICS),
  setWinPos: (x, y) => ipcRenderer.send(IPC.SET_WIN_POS, x, y),
  // 原生授权：通过本地 HTTP server 回 CC 决策（allow/deny），不需按键/Accessibility
  decidePermission: (permId, behavior) => ipcRenderer.invoke(IPC.PERMISSION_DECIDE, permId, behavior),
  // 对话类（继续/选择/方案）：Codex 精确打开对应 task，其它 Agent 定位会话窗口/终端
  focusSession: (sessionId) => ipcRenderer.invoke(IPC.FOCUS_SESSION, sessionId),
  // 透明空白处点击穿透：渲染端命中测试后切换（true=穿透，鼠标事件仍转发回来）
  setIgnoreMouse: (ignore) => ipcRenderer.send(IPC.SET_IGNORE_MOUSE, ignore),
  // 按弹层内容精确定高（动态，避免固定大窗口留白）；w/h<=0 复位
  setPetSize: (w, h, anchor) => ipcRenderer.send(IPC.SET_PET_SIZE, w, h, anchor),
  // 详情面板按内容高度自适应，避免底部留白 / 内容多时被切
  setPanelHeight: (h) => ipcRenderer.send(IPC.SET_PANEL_HEIGHT, h),
  // 输入框结束后归还窗口焦点
  blurPet: () => ipcRenderer.send(IPC.PET_BLUR),
  // 上报「用户正在交互」(选项面板/右键菜单/记事本)——领地模式据此避战/撤退
});
