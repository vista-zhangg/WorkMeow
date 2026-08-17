'use strict';

// opencode 插件安装器。
//
// opencode 的插件目录是 ~/.config/opencode/plugins/，该目录下每个 .js 文件都会
// 被 opencode 的插件运行时（Bun）自动加载。与 Claude Code/TRAE/WorkBuddy 的
// JSON 配置合写不同，这里的「钩子」就是插件文件本身，所以安装 = 把
// hook/opencode-plugin.js 原子复制到 ~/.config/opencode/plugins/opencode-plugin.js，
// 卸载 = 备份后删除。
//
// 为了与其他安装器共用 backend/hooks.js 的 install/uninstall/startWatcher
// 生命周期，本模块同样暴露 registerHooks(port, token) / unregisterHooks /
// hooksCurrent / SETTINGS_PATH（端口与令牌对插件无用，签名兼容即可）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGINS_DIR = path.join(os.homedir(), '.config', 'opencode', 'plugins');
const DETECT_PATH = path.join(os.homedir(), '.config', 'opencode');
const SETTINGS_PATH = path.join(PLUGINS_DIR, 'opencode-plugin.js');
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook', 'opencode-plugin.js');
const MARKER = 'workmeow-opencode-plugin';

function readSource() {
  const source = fs.readFileSync(HOOK_SCRIPT, 'utf8');
  if (!source.includes(MARKER)) throw new Error('opencode plugin source missing marker');
  return source;
}

function registerHooks() {
  const source = readSource();
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const existing = fs.existsSync(SETTINGS_PATH);
  const current = existing ? fs.readFileSync(SETTINGS_PATH, 'utf8') : '';
  if (current === source) return { added: 0, updated: 0, skipped: 1 };
  if (existing && !current.includes(MARKER)) {
    // 别的工具/用户自己的同名插件占着位置：先备份再覆盖，不静默丢数据。
    try { fs.copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.pet-backup-${Date.now()}.bak`); } catch {}
  }
  const tmp = path.join(PLUGINS_DIR, `.opencode-plugin.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, source, { encoding: 'utf8' });
  fs.renameSync(tmp, SETTINGS_PATH);
  return { added: existing ? 0 : 1, updated: existing ? 1 : 0, skipped: 0 };
}

function unregisterHooks(options = {}) {
  try {
    const current = fs.readFileSync(SETTINGS_PATH, 'utf8');
    if (!current.includes(MARKER)) return { removed: 0 };
    let backupPath = null;
    if (options.backup) {
      try {
        backupPath = `${SETTINGS_PATH}.pet-backup-${Date.now()}.bak`;
        fs.copyFileSync(SETTINGS_PATH, backupPath);
      } catch { backupPath = null; }
    }
    fs.unlinkSync(SETTINGS_PATH);
    return { removed: 1, backupPath };
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0 };
    return { removed: 0 };
  }
}

function hooksCurrent() {
  try { return fs.readFileSync(SETTINGS_PATH, 'utf8').includes(MARKER); } catch { return false; }
}

// CLI: `node backend/opencode-install.js` 安装；`--uninstall` 卸载。
if (require.main === module) {
  if (process.argv.includes('--uninstall')) {
    console.log(unregisterHooks({ backup: true }));
  } else {
    console.log(registerHooks());
  }
}

module.exports = {
  registerHooks,
  unregisterHooks,
  hooksCurrent,
  SETTINGS_PATH,
  HOOK_SCRIPT,
  MARKER,
  INTEGRATION_ID: 'opencode',
  INTEGRATION_LABEL: 'opencode',
  DETECT_PATH,
};
