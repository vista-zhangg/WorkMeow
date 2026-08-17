'use strict';

// One IPC vocabulary for the main process and preload bridge. Keeping channel
// names here prevents a future feature from updating only one side.
const IPC = Object.freeze({
  PET_EVENT: 'pet:event',
  PET_STATS: 'pet:stats',
  PANEL_STATS: 'panel:stats',
  PANEL_PRICE: 'panel:price',
  XIABAN_SCHEDULE: 'xiaban:schedule',
  GET_STATS: 'get-stats',
  GET_WIN_POS: 'get-win-pos',
  GET_WINDOW_METRICS: 'get-window-metrics',
  SET_WIN_POS: 'set-win-pos',
  OPEN_PANEL: 'open-panel',
  CLOSE_PANEL: 'close-panel',
  GET_AUTO_LAUNCH: 'get-auto-launch',
  SET_AUTO_LAUNCH: 'set-auto-launch',
  GET_XIABAN_SCHEDULE: 'get-xiaban-schedule',
  SET_XIABAN_SCHEDULE: 'set-xiaban-schedule',
  CLOSE_SETTINGS: 'close-settings',
  SET_PANEL_HEIGHT: 'set-panel-height',
  QUIT_APP: 'quit-app',
  CLOSE_PET: 'close-pet',
  PERMISSION_DECIDE: 'permission-decide',
  FOCUS_SESSION: 'focus-session',
  SET_PET_SIZE: 'set-pet-size',
  PET_BLUR: 'pet-blur',
  SET_IGNORE_MOUSE: 'set-ignore-mouse',
});

const PUSH_CHANNELS = Object.freeze(['PET_EVENT', 'PET_STATS', 'PANEL_STATS', 'PANEL_PRICE', 'XIABAN_SCHEDULE']);
const INVOKE_CHANNELS = Object.freeze([
  'GET_STATS', 'GET_WIN_POS', 'GET_WINDOW_METRICS', 'GET_AUTO_LAUNCH',
  'SET_AUTO_LAUNCH', 'GET_XIABAN_SCHEDULE', 'SET_XIABAN_SCHEDULE',
  'PERMISSION_DECIDE', 'FOCUS_SESSION',
]);
const COMMAND_CHANNELS = Object.freeze([
  'SET_WIN_POS', 'OPEN_PANEL', 'CLOSE_PANEL', 'CLOSE_SETTINGS', 'SET_PANEL_HEIGHT', 'QUIT_APP',
  'CLOSE_PET', 'SET_PET_SIZE', 'PET_BLUR',
  'SET_IGNORE_MOUSE',
]);

module.exports = { IPC, PUSH_CHANNELS, INVOKE_CHANNELS, COMMAND_CHANNELS };
