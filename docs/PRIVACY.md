# 隐私与数据边界 / Privacy and Data Boundaries

## 中文

WorkMeow 是本地优先的 Windows 桌面应用，不提供云端账户、遥测或远程会话同步。

### 本机读取的数据

- Claude Code hook 事件、transcript 与进程信息；
- Codex 本机 rollout JSONL；
- Codex App Server 返回的当前账户类型、邮箱与套餐，以及订阅额度窗口（剩余百分比、窗口时长与刷新时间）；邮箱只在内存中用于识别账户并以脱敏形式显示；
- TRAE 本机日志与进程信息；
- WorkBuddy hook、transcript 与用量字段；
- opencode 插件事件与本机用量文件。

这些数据用于展示状态、会话标题、上下文占用、token 用量和权限卡。敏感内容不会作为普通调试日志输出；标题提取会过滤疑似密钥内容。

### 本机写入的数据

WorkMeow 将配置、窗口位置、运行时令牌、模型价格缓存、用量台账和 Codex 额度提醒去重键写入 `~/.workmeow/`。去重键只包含窗口标识与刷新时间，不包含认证信息。hook 与插件安装采用合并写入，修改前保留备份，卸载只移除本项目管理的条目。

### 网络访问

常规运行中，WorkMeow 会从 [models.dev](https://models.dev) 下载公共模型价目表。Windows 版使用 Electron 网络层并继承系统代理或 PAC 设置；启动时同步一次，成功后每 24 小时刷新，失败时自动重试。该请求不携带 transcript、rollout、权限内容或用量统计。设置 `WORKMEOW_NO_NET=1` 会禁用价格同步和 Codex 额度上游连接，使 WorkMeow 保持完全离线；额度显示为 `--`。

Codex 订阅额度通过官方 `codex app-server --stdio` 读取。WorkMeow 完成 App Server 初始化后先调用 `account/read`，再调用 `account/rateLimits/read` 并监听 `account/updated` 与 `account/rateLimits/updated`；认证和上游访问由 Codex 负责。WorkMeow 只监听 `~/.codex/auth.json` 目录项的替换，将它作为 file auth 的快速重连信号，且不打开或解析凭据文件。keyring / auto / ephemeral 没有对应的文件 watcher 保证，账户变化依靠 App Server 通知、周期性 `account/read` 与定期重建连接收敛；界面表示 WorkMeow 自己这条连接当前可见的账户。WorkMeow 不保存 Codex 邮箱或凭据，也不调用 ChatGPT 网页接口。退出 WorkMeow 时会终止它启动的 App Server 子进程。

本地服务只监听 loopback。写接口校验 Host、Origin、请求体大小、字段形状和每次运行随机生成的令牌。

### 计费说明

面板中的费用按公开 API 单价折算，仅用于本机趋势参考。它不是订阅账单、余额或厂商最终结算；未知或无法精确匹配的模型会显示回退估算或 $0，并标注价格来源。

### 用户控制

- 右键打工喵可通过 ON/OFF 一键切换「隐私模式」，设置中也提供同步开关：桌宠和详情面板会隐藏项目/会话名、回复正文、授权命令、方案、问题选项与操作流明细，同时保留工作/等待/异常状态和用量汇总。
- 隐私模式只是本机展示层遮蔽，不停止 watcher、hook、权限等待或用量统计。开启时当前气泡和敏感卡片会立即关闭；关闭后仍未处理的事项会恢复显示。
- 退出 WorkMeow 即停止 watcher 与本地服务；
- 可在设置的 Agent 接入区域或通过 `npm run uninstall:hooks` 卸载本项目 hook/插件；
- `~/.workmeow/` 包含用户配置和历史，只有确认不再需要时才应手动删除；
- 发布问题时不要附加真实 transcript、运行时令牌、个人目录或含敏感内容的截图。

## English

WorkMeow is a local-first Windows desktop application. It has no cloud account, telemetry service, or remote conversation synchronization.

### Data read locally

- Claude Code hook events, transcripts, and process information;
- local Codex rollout JSONL files;
- Current account type, email, plan, and subscription quota windows returned by Codex App Server. The email remains in memory only for account identification and is displayed in masked form;
- local TRAE logs and process information;
- WorkBuddy hooks, transcripts, and usage fields;
- opencode plugin events and the local usage file.

This data powers status, session titles, context usage, token reporting, and permission cards. Sensitive content is not emitted through ordinary debug output, and title extraction rejects secret-looking input.

### Data written locally

Configuration, window position, runtime token, model-price cache, usage ledgers, and Codex quota-alert dedupe keys are stored under `~/.workmeow/`. A dedupe key contains only a window identifier and reset time, never authentication data. Hook and plugin installation is merge-safe, creates backups before changes, and removes only WorkMeow-managed entries during uninstall.

### Network access

During normal operation, WorkMeow may download the public model price list from [models.dev](https://models.dev). On Windows it uses Electron's network stack and follows the system proxy or PAC configuration; it syncs at startup, refreshes every 24 hours after success, and retries transient failures. Transcripts, rollouts, permission contents, and usage statistics are not attached to that request. Set `WORKMEOW_NO_NET=1` to disable both pricing synchronization and the Codex quota upstream connection, keeping WorkMeow fully offline; quota displays `--`.

Codex subscription quota is read through the official `codex app-server --stdio` transport. WorkMeow initializes App Server, calls `account/read` before `account/rateLimits/read`, and listens for both account and rate-limit updates; Codex owns authentication and upstream access. WorkMeow watches replacement of the `~/.codex/auth.json` directory entry only as a fast reconnect signal for file auth, without opening or parsing the credential file. Keyring, auto, and ephemeral auth have no corresponding file-watcher guarantee; account changes converge through App Server notifications, periodic `account/read`, and scheduled connection recycling, and the UI represents the account visible to WorkMeow's own connection. WorkMeow does not persist the Codex email or credentials and does not call ChatGPT web endpoints. Exiting WorkMeow terminates the App Server child process it started.

The local service binds to loopback only. Write endpoints validate Host, Origin, body size, field shape, and a fresh random token generated for each run.

### Cost estimates

Displayed cost is calculated from public API prices for local trend analysis. It is not a subscription invoice, balance, or provider settlement. Unknown or unmatched models use a labeled fallback estimate or display $0.

### User control

- Toggle **Privacy mode** from the cat's compact ON/OFF context action or the synchronized Settings switch. It hides project/session names, response text, permission commands, plans, question options, and operation details while keeping essential state and aggregate usage visible.
- Privacy mode masks the local presentation layer only. It does not stop watchers, hooks, pending permissions, or usage accounting. Existing bubbles and sensitive cards close immediately; unresolved items return after privacy mode is disabled.
- Exiting WorkMeow stops its watchers and local service.
- Use the Agent integration area in Settings or `npm run uninstall:hooks` to remove WorkMeow-managed hooks and plugins.
- `~/.workmeow/` contains user configuration and history; delete it manually only when that data is no longer needed.
- Never attach real transcripts, runtime tokens, personal paths, or sensitive screenshots to a public report.
