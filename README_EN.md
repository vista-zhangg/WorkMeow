<div align="center">
  <img src="assets/tray-cat.svg" width="112" alt="WorkMeow icon">
  <h1>WorkMeow</h1>
  <p><strong>One cat keeping an eye on every AI coding agent at work.</strong></p>
  <p>Live status, notifications, permission requests, and unified token usage for Claude Code, Codex, TRAE, WorkBuddy, and opencode.</p>

  <p>
    <a href="README.md">简体中文</a> ·
    <a href="README_EN.md">English</a>
  </p>

  <p>
    <a href="https://github.com/vista-zhangg/WorkMeow/actions/workflows/ci.yml"><img src="https://github.com/vista-zhangg/WorkMeow/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4?logo=windows" alt="Windows x64 only">
    <img src="https://img.shields.io/badge/version-1.6.0-F6A04A" alt="Version 1.6.0">
    <a href="LICENSE"><img src="https://img.shields.io/badge/code%20license-MIT-2EA44F" alt="MIT License"></a>
  </p>
</div>

> [!IMPORTANT]
> WorkMeow currently supports **Windows x64 only**. macOS, Linux, and Windows on ARM are not supported. Documentation is available in Chinese and English; the application UI is currently Simplified Chinese. The Windows binaries are not commercially code-signed yet, so SmartScreen may display a warning on first launch.

## What it does

Switching between several agent windows just to check progress is distracting. WorkMeow turns local agent activity into one small desktop companion: it works when your agents work, asks for attention when they need you, celebrates completed turns, and presents usage in one place.

- **One cat, five agents** — Claude Code, Codex, TRAE, WorkBuddy, and opencode.
- **Status at a glance** — working, thinking, parallel tasks, compaction, permission waits, user input, completion, errors, breaks, and sleep.
- **Custom expressions** — browse every state GIF, add rotating variants, replace or remove a selected item, or restore defaults.
- **Native permission cards** — allow, deny, or permanently allow supported Claude Code requests from the pet.
- **Unified usage view** — tokens, cache reads and writes, context windows, models, daily trends, and API-price estimates.
- **Integration health and repair** — verify hooks, plugins, and read-only watchers for all five agents, then repair detected integrations in one click.
- **Local-first operation** — conversations and usage stay on the machine; the regular optional network request only downloads public model pricing from models.dev.
- **Desktop-friendly controls** — drag, edge snapping, work peek, action center, system tray, auto-start, and scheduled break animations.

## Real state examples

<table>
  <tr>
    <td align="center"><img src="assets/cat/cat-working.gif" width="132" alt="Working"><br><strong>Working</strong><br><sub>A tool is running</sub></td>
    <td align="center"><img src="assets/cat/cat-thinking.gif" width="132" alt="Thinking"><br><strong>Thinking</strong><br><sub>The model is reasoning</sub></td>
    <td align="center"><img src="assets/cat/cat-juggling.gif" width="132" alt="Parallel tasks"><br><strong>Parallel</strong><br><sub>Several tasks are active</sub></td>
    <td align="center"><img src="assets/cat/cat-waiting.gif" width="132" alt="Permission required"><br><strong>Permission</strong><br><sub>Your decision is required</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/cat/cat-happy.gif" width="132" alt="Completed"><br><strong>Completed</strong><br><sub>A turn has finished</sub></td>
    <td align="center"><img src="assets/cat/cat-error.gif" width="132" alt="Error"><br><strong>Error</strong><br><sub>A session needs attention</sub></td>
    <td align="center"><img src="assets/cat/cat-loafing.gif" width="132" alt="Between tools"><br><strong>Between tools</strong><br><sub>Waiting for the next event</sub></td>
    <td align="center"><img src="assets/cat/cat-sleeping.gif" width="132" alt="Resting"><br><strong>Resting</strong><br><sub>No active task</sub></td>
  </tr>
</table>

> The GIF artwork comes from the original “月薪喵” meme series by Douyin creator **@月薪喵**. The artwork is not covered by the project’s MIT License. See [asset credits and copyright information](assets/cat/CREDITS.md).

## Custom state expressions

Open Settings from the system tray and select **Cat expressions** to browse every work, feedback, and ambient state. For the selected state you can:

- keep the current expressions and **add a rotating variant**;
- select any built-in or custom GIF in the playlist and replace or remove only that item; built-in files and imported source files are never deleted;
- keep at least one GIF per state, or restore all of the state's built-in defaults at once.

Imports are fitted to WorkMeow's 120 × 120 pet canvas. Transparent backgrounds are preserved, while a detached solid-color border is removed when it can be detected safely. Complex backgrounds are kept to avoid damaging the subject, with a warning shown in Settings. Limits are 12 MB, 2048 × 2048, 180 frames, and 60 seconds per GIF; each state accepts up to 20 custom expressions.

WorkMeow stores only a processed copy under `~/.workmeow/pet-assets` for the current user. It never changes or deletes the source file, and saved expressions update the visible pet immediately without a restart. Users are responsible for the rights to assets they import.

## Support matrix

| Agent | Integration | External configuration | In-pet approval |
| --- | --- | --- | --- |
| Claude Code | Lifecycle hooks, transcript, and process data | Merge-safe WorkMeow hook install/uninstall | Supported |
| Codex | Incremental local rollout JSONL reader | Does not modify Codex configuration | Read-only alerts |
| TRAE | Local IDE logs and process data | Installs a merge-safe hook only when TRAE is detected | Read-only alerts |
| WorkBuddy | Hooks, transcripts, and usage fields | Installs a merge-safe hook only when WorkBuddy is detected | Read-only alerts |
| opencode | Official plugin mechanism, events, and usage file | Installs/removes one standalone plugin file | Read-only alerts |

On first launch, WorkMeow only integrates with tools already used by the current Windows account. It does not create configuration folders for undetected agents. Codex is always read-only and requires no hook.

## Install and run

### Release builds

Once a version is published, download it from [GitHub Releases](https://github.com/vista-zhangg/WorkMeow/releases):

- `WorkMeow-<version>-Windows-x64.exe` — Windows installer;
- `WorkMeow-<version>-Windows-x64.zip` — portable build.

Fully extract the portable ZIP before running `WorkMeow.exe`. Do not launch it inside an archive preview or copy only the executable.

### Run from source

Requirements: Windows x64, Node.js 22.12 or newer, npm, and at least one supported agent.

```powershell
git clone https://github.com/vista-zhangg/WorkMeow.git
cd WorkMeow
npm ci
npm test
npm start
```

Keep Electron attached to the terminal while debugging:

```powershell
npm run start:console
```

## Common commands

```powershell
npm start                 # Start detached from the current terminal
npm run start:console     # Start in the current terminal for debugging
npm test                  # Run all 29 regression suites
npm run install:hooks     # Install/reconcile hooks and plugins for detected tools
npm run uninstall:hooks   # Back up and remove WorkMeow-managed integrations
npm run meter:rebuild     # Recalculate local history using current prices
npm run package:portable  # Build the Windows x64 portable ZIP
npm run package:win       # Build installer, ZIP, and SHA-256 checksums
```

## Data and privacy

- Configuration, runtime tokens, pricing cache, and usage ledgers live in `~/.workmeow/`.
- Claude Code, Codex, TRAE, WorkBuddy, and opencode session data is read and processed locally.
- The local HTTP service binds to loopback only, and write endpoints require a fresh per-run token.
- models.dev synchronization downloads a public price list only; transcripts, rollouts, permission contents, and usage statistics are not uploaded.
- Displayed cost is an estimate based on public API prices, not a subscription bill or a provider’s final invoice.

See [Privacy and data boundaries](docs/PRIVACY.md) for the complete bilingual policy.

## How it works

```text
Claude hooks ─────┐
Codex rollouts ───┼──> local server / watchers ──> adapter / core ──> pet + details panel
TRAE logs ────────┤                                      └────────> unified usage ledger
WorkBuddy ────────┤
opencode plugin ──┘
```

The main process owns watcher lifecycles, the tray, and windows. The backend state machine aggregates concurrent sessions. Renderers only receive a reduced status and event protocol. State vocabulary and priority are defined once in [`shared/states.js`](shared/states.js).

## Documentation

- [Chinese user guide](docs/介绍.md)
- [Chinese local deployment and packaging guide](docs/LOCAL_DEPLOYMENT.md)
- [State machine and rendering specification](STATES.md)
- [Privacy and data boundaries — bilingual](docs/PRIVACY.md)
- [Contributing guide — bilingual](CONTRIBUTING.md)
- [Security policy — bilingual](SECURITY.md)

## Origin and licensing

WorkMeow is derived from [LLMPET](https://github.com/myunwang/LLMPET), with substantial work on Windows desktop behavior, multi-agent integrations, unified usage reporting, settings, and project structure.

- Source code is released under the [MIT License](LICENSE).
- The root license retains the upstream `Copyright (c) 2026 myunwang` notice.
- WorkMeow modifications remain copyright of their respective contributors.
- The 月薪喵 GIFs remain copyright of Douyin creator **@月薪喵** and are not covered by the project’s MIT License.

## Contributing

Bug reports, Windows compatibility improvements, and new agent integrations are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

---

<div align="center">
  <sub>Windows x64 only · Local-first · One cat, all your agents.</sub>
</div>
