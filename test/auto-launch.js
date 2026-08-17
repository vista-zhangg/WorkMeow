'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const channels = fs.readFileSync(path.join(root, 'shared', 'ipc-channels.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(root, 'renderer', 'settings.html'), 'utf8');
const settingsJs = fs.readFileSync(path.join(root, 'renderer', 'settings.js'), 'utf8');
const settingsCss = fs.readFileSync(path.join(root, 'renderer', 'settings.css'), 'utf8');
const i18n = require('../shared/i18n');

assert(/app\.getLoginItemSettings\(autoLaunchMatchOptions\(\)\)/.test(main), 'settings must read the current auto-launch state');
assert(/app\.setLoginItemSettings\(autoLaunchSettings\(desired\)\)/.test(main), 'settings must update the auto-launch state');
assert(/executableWillLaunchAtLogin/.test(main), 'Windows settings must use the executable launch status');
assert(/function openSettings\(\)/.test(main) && /settings\.html/.test(main), 'tray must open the settings window');
assert(/tray\.settings/.test(main), 'tray menu must expose a settings entry');
assert(/GET_AUTO_LAUNCH/.test(channels) && /SET_AUTO_LAUNCH/.test(channels), 'settings must have dedicated IPC channels');
assert(/getAutoLaunch:/.test(preload) && /setAutoLaunch:/.test(preload), 'preload must expose auto-launch settings APIs');
assert(/role="switch"/.test(settingsHtml) && /auto-launch-toggle/.test(settingsJs), 'settings UI must provide an accessible toggle');
assert(/linear-gradient\(165deg/.test(settingsCss) && /border-radius: 18px/.test(settingsCss), 'settings UI must retain the glass panel style');
assert.strictEqual(i18n.DICT.zh['tray.settings'], '设置');
assert.strictEqual(i18n.DICT.zh['settings.autoLaunchTitle'], '开机自动启动');

console.log('auto-launch checks passed');
