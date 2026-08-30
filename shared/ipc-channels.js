'use strict';

// One IPC vocabulary for the main process and preload bridge. Keeping channel
// names here prevents a future feature from updating only one side.
const IPC = Object.freeze({
  PET_EVENT: 'pet:event',
  PET_STATS: 'pet:stats',
  PANEL_STATS: 'panel:stats',
  PANEL_PRICE: 'panel:price',
  XIABAN_SCHEDULE: 'xiaban:schedule',
  PET_ASSETS: 'pet-assets:changed',
  UPDATE_STATE: 'update:state',
  PRIVACY_STATE: 'privacy:state',
  GET_STATS: 'get-stats',
  GET_WIN_POS: 'get-win-pos',
  GET_WINDOW_METRICS: 'get-window-metrics',
  GET_UPDATE_STATE: 'update:get-state',
  CHECK_FOR_UPDATES: 'update:check',
  SET_AUTO_UPDATE: 'update:set-auto',
  DOWNLOAD_UPDATE: 'update:download',
  INSTALL_UPDATE: 'update:install',
  OPEN_UPDATE_PAGE: 'update:open-page',
  SET_WIN_POS: 'set-win-pos',
  END_WIN_DRAG: 'end-win-drag',
  OPEN_PANEL: 'open-panel',
  CLOSE_PANEL: 'close-panel',
  GET_AUTO_LAUNCH: 'get-auto-launch',
  SET_AUTO_LAUNCH: 'set-auto-launch',
  GET_PRIVACY_MODE: 'privacy:get',
  SET_PRIVACY_MODE: 'privacy:set',
  GET_INTEGRATION_HEALTH: 'integrations:get-health',
  REPAIR_INTEGRATIONS: 'integrations:repair',
  UNINSTALL_INTEGRATIONS: 'integrations:uninstall',
  GET_XIABAN_SCHEDULE: 'get-xiaban-schedule',
  SET_XIABAN_SCHEDULE: 'set-xiaban-schedule',
  GET_PET_ASSETS: 'get-pet-assets',
  IMPORT_PET_GIF: 'import-pet-gif',
  REMOVE_PET_ASSET: 'remove-pet-asset',
  RESET_PET_SLOT: 'reset-pet-slot',
  CLOSE_SETTINGS: 'close-settings',
  SET_PANEL_HEIGHT: 'set-panel-height',
  CLOSE_PET: 'close-pet',
  PERMISSION_DECIDE: 'permission-decide',
  FOCUS_SESSION: 'focus-session',
  SET_PET_SIZE: 'set-pet-size',
  PET_BLUR: 'pet-blur',
  SET_IGNORE_MOUSE: 'set-ignore-mouse',
});

const PUSH_CHANNELS = Object.freeze([
  'PET_EVENT', 'PET_STATS', 'PANEL_STATS', 'PANEL_PRICE', 'XIABAN_SCHEDULE',
  'PET_ASSETS', 'UPDATE_STATE', 'PRIVACY_STATE',
]);
const INVOKE_CHANNELS = Object.freeze([
  'GET_STATS', 'GET_WIN_POS', 'GET_WINDOW_METRICS', 'GET_AUTO_LAUNCH',
  'SET_AUTO_LAUNCH', 'GET_PRIVACY_MODE', 'SET_PRIVACY_MODE',
  'GET_INTEGRATION_HEALTH', 'REPAIR_INTEGRATIONS', 'UNINSTALL_INTEGRATIONS',
  'GET_XIABAN_SCHEDULE', 'SET_XIABAN_SCHEDULE',
  'GET_PET_ASSETS', 'IMPORT_PET_GIF', 'REMOVE_PET_ASSET', 'RESET_PET_SLOT',
  'PERMISSION_DECIDE', 'FOCUS_SESSION', 'GET_UPDATE_STATE', 'CHECK_FOR_UPDATES',
  'SET_AUTO_UPDATE', 'DOWNLOAD_UPDATE', 'INSTALL_UPDATE', 'OPEN_UPDATE_PAGE',
]);
const COMMAND_CHANNELS = Object.freeze([
  'SET_WIN_POS', 'END_WIN_DRAG', 'OPEN_PANEL', 'CLOSE_PANEL', 'CLOSE_SETTINGS', 'SET_PANEL_HEIGHT',
  'CLOSE_PET', 'SET_PET_SIZE', 'PET_BLUR',
  'SET_IGNORE_MOUSE',
]);

module.exports = { IPC, PUSH_CHANNELS, INVOKE_CHANNELS, COMMAND_CHANNELS };
