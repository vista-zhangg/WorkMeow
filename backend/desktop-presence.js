'use strict';

const path = require('path');
const { spawn } = require('child_process');

// Design reference: moujunjie/Codex-Desktop-PET/electron/fullscreen-watcher.js
// https://github.com/moujunjie/Codex-Desktop-PET
// An independent implementation of foreground-window/monitor comparison. One
// hidden helper compiles Win32 interop once; only a boolean heartbeat leaves it.
const DEFAULT_INTERVAL_MS = 1000;
const RETRY_MS = 30000;
const STARTUP_TIMEOUT_MS = 20000;
const MAX_LINE_BYTES = 4096;

function safeInterval(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(500, Math.min(60000, Math.round(parsed))) : DEFAULT_INTERVAL_MS;
}

function parsePresenceLine(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value.fullscreen !== 'boolean') return null;
    if (value.foregroundChanged !== undefined && typeof value.foregroundChanged !== 'boolean') return null;
    return value.foregroundChanged === undefined
      ? { fullscreen: value.fullscreen }
      : { fullscreen: value.fullscreen, foregroundChanged: value.foregroundChanged };
  } catch {
    return null;
  }
}

function buildWatcherScript(intervalMs, ownProcessId) {
  const interval = safeInterval(intervalMs);
  const parsedPid = Number(ownProcessId);
  const ownPid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : 0;
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WorkMeowDesktopPresence {
  static IntPtr lastForeground = IntPtr.Zero;
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect rect, int size);

  public static int Read(uint ownProcessId) {
    // Match physical monitor/window coordinates on mixed-scale displays. The
    // context applies to this helper's thread only, never to the Electron app.
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
    catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    IntPtr window = GetForegroundWindow();
    bool changed = window != lastForeground;
    lastForeground = window;
    int foregroundFlag = changed ? 2 : 0;
    if (window == IntPtr.Zero || window == GetDesktopWindow() || window == GetShellWindow()
        || !IsWindowVisible(window) || IsIconic(window)) return foregroundFlag;
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    if (processId == ownProcessId) return 0;
    var name = new StringBuilder(256);
    GetClassName(window, name, name.Capacity);
    string windowClass = name.ToString();
    if (windowClass == "Progman" || windowClass == "WorkerW" || windowClass == "Shell_TrayWnd"
        || windowClass == "Shell_SecondaryTrayWnd") return foregroundFlag;
    // With an auto-hidden taskbar, a normal maximized, captioned window can
    // cover the entire monitor. It is still ordinary desktop work.
    if (IsZoomed(window) && (GetWindowLong(window, -16) & 0x00C00000) == 0x00C00000) return foregroundFlag;
    Rect bounds;
    if (!GetWindowRect(window, out bounds)) return foregroundFlag;
    Rect frame;
    // DWM bounds remove invisible resize borders that otherwise fake coverage.
    if (DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(Rect))) == 0
        && frame.Right > frame.Left && frame.Bottom > frame.Top) bounds = frame;
    var info = new MonitorInfo();
    info.Size = Marshal.SizeOf(typeof(MonitorInfo));
    IntPtr monitor = MonitorFromWindow(window, 2);
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return foregroundFlag;
    const int tolerance = 2;
    bool fullscreen = bounds.Left <= info.Monitor.Left + tolerance && bounds.Top <= info.Monitor.Top + tolerance
        && bounds.Right >= info.Monitor.Right - tolerance && bounds.Bottom >= info.Monitor.Bottom - tolerance;
    return foregroundFlag | (fullscreen ? 1 : 0);
  }
}
'@
while ($true) {
  try {
    $sample = [WorkMeowDesktopPresence]::Read([uint32]${ownPid})
    $fullscreen = if (($sample -band 1) -ne 0) { 'true' } else { 'false' }
    $foregroundChanged = if (($sample -band 2) -ne 0) { 'true' } else { 'false' }
    [Console]::Out.WriteLine('{"fullscreen":' + $fullscreen + ',"foregroundChanged":' + $foregroundChanged + '}')
  } catch { [Console]::Out.WriteLine('{"fullscreen":false}') }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${interval}
}
`;
}

function createDesktopPresenceMonitor({
  onChange = () => {},
  onForegroundChange = () => {},
  intervalMs = DEFAULT_INTERVAL_MS,
  platform = process.platform,
  ownProcessId = process.pid,
  spawnProcess = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  powershellPath = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
} = {}) {
  const interval = safeInterval(intervalMs);
  let running = false;
  let child = null;
  let retryTimer = null;
  let watchdogTimer = null;
  let lastFullscreen = null;

  function emit(fullscreen) {
    if (lastFullscreen === fullscreen) return;
    lastFullscreen = fullscreen;
    onChange({ fullscreen });
  }

  function clearWatchdog() {
    if (watchdogTimer !== null) clearTimer(watchdogTimer);
    watchdogTimer = null;
  }

  function retry() {
    if (!running || child || retryTimer !== null) return;
    retryTimer = setTimer(() => { retryTimer = null; launch(); }, RETRY_MS);
    retryTimer?.unref?.();
  }

  function fail(record) {
    if (record !== child || record.terminal) return;
    record.terminal = true;
    clearWatchdog();
    if (running) emit(false);
    // Wait for close before ever replacing this helper: at most one exists.
    try { record.process.kill(); } catch { /* close/error owns lifecycle */ }
  }

  function armWatchdog(record, delay) {
    clearWatchdog();
    watchdogTimer = setTimer(() => { watchdogTimer = null; fail(record); }, delay);
    watchdogTimer?.unref?.();
  }

  function launch() {
    if (!running || child || platform !== 'win32') return;
    let helper;
    try {
      helper = spawnProcess(powershellPath, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(buildWatcherScript(interval, ownProcessId), 'utf16le').toString('base64'),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      emit(false);
      retry();
      return;
    }
    const record = { process: helper, buffer: '', terminal: false };
    child = record;
    armWatchdog(record, STARTUP_TIMEOUT_MS);
    helper.stdout.on('data', (chunk) => {
      if (!running || child !== record || record.terminal) return;
      record.buffer += chunk.toString('utf8');
      if (record.buffer.length > MAX_LINE_BYTES) { fail(record); return; }
      let end;
      while ((end = record.buffer.indexOf('\n')) !== -1) {
        const line = record.buffer.slice(0, end).trim();
        record.buffer = record.buffer.slice(end + 1);
        if (!line) continue;
        const value = parsePresenceLine(line);
        if (!value) { fail(record); return; }
        emit(value.fullscreen);
        if (value.foregroundChanged && !value.fullscreen) onForegroundChange();
        if (!running || child !== record || record.terminal) return;
        armWatchdog(record, Math.max(10000, interval * 3 + 2000));
      }
    });
    // Drain stderr without retaining output or exposing foreground app details.
    helper.stderr.on('data', () => {});
    helper.on('error', () => fail(record));
    helper.on('close', () => {
      if (child !== record) return;
      child = null;
      clearWatchdog();
      if (running) { emit(false); retry(); }
    });
  }

  return {
    snapshot: () => ({ fullscreen: lastFullscreen === true }),
    start() {
      if (running) return;
      running = true;
      if (platform !== 'win32') { emit(false); return; }
      launch();
    },
    stop() {
      running = false;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      clearWatchdog();
      if (child && !child.terminal) {
        child.terminal = true;
        try { child.process.kill(); } catch { /* already exiting */ }
      }
      // Explicit stop also releases any automatic hide. Late stdout is ignored.
      emit(false);
    },
  };
}

module.exports = { createDesktopPresenceMonitor, parsePresenceLine, buildWatcherScript };
