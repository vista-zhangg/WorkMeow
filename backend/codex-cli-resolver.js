'use strict';

// Resolve the native Codex CLI without assuming that a GUI-launched WorkMeow
// inherited the user's terminal PATH. No credential files are read here.

const fs = require('fs');
const os = require('os');
const path = require('path');

function isFile(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

function directoryEntries(directory, fsImpl = fs) {
  try { return fsImpl.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
}

function modifiedAt(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).mtimeMs || 0; } catch { return 0; }
}

function direct(file, source) {
  return { command: file, args: ['app-server', '--stdio'], source };
}

function cmdWrapper(file, env) {
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `""${file}" app-server --stdio"`],
    source: 'path-cmd',
  };
}

function desktopNativeCandidates(env = process.env, fsImpl = fs) {
  if (process.platform !== 'win32') return [];
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return [];
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const candidates = [];
  for (const entry of directoryEntries(binRoot, fsImpl)) {
    if (!entry.isDirectory()) continue;
    const file = path.join(binRoot, entry.name, 'codex.exe');
    if (isFile(file, fsImpl)) candidates.push(file);
  }
  return candidates.sort((left, right) => modifiedAt(right, fsImpl) - modifiedAt(left, fsImpl));
}

function npmNativeCandidates(env = process.env, fsImpl = fs) {
  if (process.platform !== 'win32') return [];
  const appData = env.APPDATA;
  if (!appData) return [];
  const modules = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules');
  const candidates = [];
  function visit(directory, depth) {
    if (depth > 6) return;
    for (const entry of directoryEntries(directory, fsImpl)) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') {
        candidates.push(target);
      }
    }
  }
  visit(modules, 0);
  return candidates.sort((left, right) => modifiedAt(right, fsImpl) - modifiedAt(left, fsImpl));
}

function pathDirectories(env = process.env) {
  const value = env.Path || env.PATH || '';
  const separator = process.platform === 'win32' ? ';' : path.delimiter;
  return value.split(separator)
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function resolveCodexCommand(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || fs;
  const explicit = options.command || env.WORKMEOW_CODEX_CLI;
  if (explicit) return direct(explicit, 'explicit');

  if (process.platform === 'win32') {
    const desktop = desktopNativeCandidates(env, fsImpl)[0];
    if (desktop) return direct(desktop, 'codex-desktop');

    const npmNative = npmNativeCandidates(env, fsImpl)[0];
    if (npmNative) return direct(npmNative, 'npm-native');

    for (const directory of pathDirectories(env)) {
      const executable = path.join(directory, 'codex.exe');
      if (isFile(executable, fsImpl)) return direct(executable, 'path-native');
      const command = path.join(directory, 'codex.cmd');
      if (isFile(command, fsImpl)) return cmdWrapper(command, env);
    }
  } else {
    for (const directory of pathDirectories(env)) {
      const executable = path.join(directory, 'codex');
      if (isFile(executable, fsImpl)) return direct(executable, 'path-native');
    }
  }

  // Let spawn produce the platform-native ENOENT signal; the service will keep
  // retrying in case Codex is installed after WorkMeow starts.
  return direct(process.platform === 'win32' ? 'codex.exe' : 'codex', 'fallback');
}

function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

module.exports = {
  desktopNativeCandidates,
  npmNativeCandidates,
  pathDirectories,
  resolveCodexCommand,
  defaultCodexHome,
};
