'use strict';

// focusSession(session) — open/focus the app that owns an agent session, for
// the pet's left-click / "💬 去回复".
//
// Our hook reports source_pid as the terminal process plus a pid_chain. On
// Windows 下我们探测 pid 链中拥有顶层窗口的进程
// (WindowsTerminal / conhost apps / VS Code) and bring it to the foreground via
// user32 (SetForegroundWindow + SwitchToThisWindow). focusSession only supports
// the Windows desktop shipped by WorkMeow.

const { execFile } = require('child_process');

// Windows: one PowerShell run tries every candidate pid in order and focuses
// the first one that owns a top-level window. SetForegroundWindow from a
// background process is throttled by Windows, so we also call
// SwitchToThisWindow as a fallback (it emulates the Alt-Tab path).
function activateWinPids(pids) {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return Promise.resolve(false);
  const script = [
    "Add-Type -Namespace W -Name U -MemberDefinition '",
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
    "'",
    `foreach ($id in @(${list.join(',')})) {`,
    '  $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {',
    '    $h = $p.MainWindowHandle',
    '    if ([W.U]::IsIconic($h)) { [W.U]::ShowWindowAsync($h, 9) | Out-Null }',
    '    [W.U]::SetForegroundWindow($h) | Out-Null',
    '    [W.U]::SwitchToThisWindow($h, $true)',
    '    Write-Output ("ok|" + $id)',
    '    exit 0',
    '  }',
    '}',
    "Write-Output 'none'",
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        const m = /^ok\|(\d+)$/m.exec(String(stdout || ''));
        resolve(!err && m ? parseInt(m[1], 10) : false);
      });
  });
}

// Codex Desktop owns the `codex:` protocol. Its watcher sessions deliberately
// have no sourcePid, so a thread deep link is the only precise way to navigate
// to the selected task (focusing ChatGPT.exe alone would open an arbitrary one).
function codexThreadUrl(session) {
  if (!session || session.agentId !== 'codex') return null;
  const id = String(session.id || '');
  // Session ids currently are UUIDs. Keep the protocol payload deliberately
  // narrow so future/untrusted adapter data cannot alter the URI structure.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  return `codex://threads/${encodeURIComponent(id)}`;
}

// Returns true if the OS accepted a precise deep link or a window was focused.
// Dependencies are injectable so the behavior can be tested without changing
// the foreground window or launching an application.
async function focusSession(session, options = {}) {
  if (!session) return false;

  const threadUrl = codexThreadUrl(session);
  if (threadUrl && typeof options.openExternal === 'function') {
    try {
      await options.openExternal(threadUrl);
      return true;
    } catch {
      // If a Codex protocol handler is unavailable, retain the PID fallback.
    }
  }

  const candidates = [];
  if (session.sourcePid) candidates.push(session.sourcePid);
  if (Array.isArray(session.pidChain)) for (const p of session.pidChain) candidates.push(p);

  const ordered = [...new Set(candidates)];
  const activatePids = options.activatePids || activateWinPids;
  return Boolean(await activatePids(ordered));
}

module.exports = { codexThreadUrl, focusSession };
