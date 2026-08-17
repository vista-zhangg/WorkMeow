# 隐私与数据边界 / Privacy and Data Boundaries

## 中文

WorkMeow 是本地优先的 Windows 桌面应用，不提供云端账户、遥测或远程会话同步。

### 本机读取的数据

- Claude Code hook 事件、transcript 与进程信息；
- Codex 本机 rollout JSONL；
- TRAE 本机日志与进程信息；
- WorkBuddy hook、transcript 与用量字段；
- opencode 插件事件与本机用量文件。

这些数据用于展示状态、会话标题、上下文占用、token 用量和权限卡。敏感内容不会作为普通调试日志输出；标题提取会过滤疑似密钥内容。

### 本机写入的数据

WorkMeow 将配置、窗口位置、运行时令牌、模型价格缓存和用量台账写入 `~/.workmeow/`。hook 与插件安装采用合并写入，修改前保留备份，卸载只移除本项目管理的条目。

### 网络访问

常规运行中，WorkMeow 只会按缓存有效期从 [models.dev](https://models.dev) 下载公共模型价目表。该请求不携带 transcript、rollout、权限内容或用量统计。设置 `WORKMEOW_NO_NET=1` 可完全禁用价格同步。

本地服务只监听 loopback。写接口校验 Host、Origin、请求体大小、字段形状和每次运行随机生成的令牌。

### 计费说明

面板中的费用按公开 API 单价折算，仅用于本机趋势参考。它不是订阅账单、余额或厂商最终结算；未知或无法精确匹配的模型会显示回退估算或 $0，并标注价格来源。

### 用户控制

- 退出 WorkMeow 即停止 watcher 与本地服务；
- 可从托盘或 `npm run uninstall:hooks` 卸载本项目 hook/插件；
- `~/.workmeow/` 包含用户配置和历史，只有确认不再需要时才应手动删除；
- 发布问题时不要附加真实 transcript、运行时令牌、个人目录或含敏感内容的截图。

## English

WorkMeow is a local-first Windows desktop application. It has no cloud account, telemetry service, or remote conversation synchronization.

### Data read locally

- Claude Code hook events, transcripts, and process information;
- local Codex rollout JSONL files;
- local TRAE logs and process information;
- WorkBuddy hooks, transcripts, and usage fields;
- opencode plugin events and the local usage file.

This data powers status, session titles, context usage, token reporting, and permission cards. Sensitive content is not emitted through ordinary debug output, and title extraction rejects secret-looking input.

### Data written locally

Configuration, window position, runtime token, model-price cache, and usage ledgers are stored under `~/.workmeow/`. Hook and plugin installation is merge-safe, creates backups before changes, and removes only WorkMeow-managed entries during uninstall.

### Network access

During normal operation, WorkMeow may download the public model price list from [models.dev](https://models.dev) according to its cache lifetime. Transcripts, rollouts, permission contents, and usage statistics are not attached to that request. Set `WORKMEOW_NO_NET=1` to disable pricing synchronization completely.

The local service binds to loopback only. Write endpoints validate Host, Origin, body size, field shape, and a fresh random token generated for each run.

### Cost estimates

Displayed cost is calculated from public API prices for local trend analysis. It is not a subscription invoice, balance, or provider settlement. Unknown or unmatched models use a labeled fallback estimate or display $0.

### User control

- Exiting WorkMeow stops its watchers and local service.
- Use the tray action or `npm run uninstall:hooks` to remove WorkMeow-managed hooks and plugins.
- `~/.workmeow/` contains user configuration and history; delete it manually only when that data is no longer needed.
- Never attach real transcripts, runtime tokens, personal paths, or sensitive screenshots to a public report.
