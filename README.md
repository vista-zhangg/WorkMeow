<div align="center">
  <img src="assets/agentpaw-icon.png" width="112" alt="AgentPaw AI 桌伴图标">
  <h1>AgentPaw · AI 桌伴 — Codex / Claude Code 桌宠</h1>
  <p><strong>把你喜欢的 GIF 变成桌面伙伴，让 AI 任务进度和额度一眼可见。</strong></p>
  <p>多角色桌面宠物 · 自定义 GIF · AI 编程任务提醒 · Codex 订阅额度监控 · token 统计 · 休息提醒</p>
  <p>支持 Codex、Claude Code、TRAE、WorkBuddy、opencode 与 ZCode。</p>

  <p>
    <a href="README.md">简体中文</a> ·
    <a href="README_EN.md">English</a>
  </p>
  <p>
    <a href="https://github.com/vista-zhangg/codex-desktop-pet/releases/latest"><strong>下载 Windows 安装包</strong></a> ·
    <a href="docs/releases/1.9.0.md">1.9.0 更新说明</a> ·
    <a href="docs/介绍.md">使用指南</a>
  </p>

  <p>
    <a href="https://github.com/vista-zhangg/codex-desktop-pet/actions/workflows/ci.yml"><img src="https://github.com/vista-zhangg/codex-desktop-pet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4?logo=windows" alt="Windows x64 only">
    <img src="https://img.shields.io/badge/version-1.9.0-F6A04A" alt="Version 1.9.0">
    <a href="LICENSE"><img src="https://img.shields.io/badge/code%20license-MIT-2EA44F" alt="MIT License"></a>
  </p>
</div>

> [!IMPORTANT]
> AgentPaw 当前**仅支持 Windows x64**，不支持 macOS、Linux 或 Windows on ARM。Windows 安装包尚未进行商业代码签名，首次运行时可能出现 SmartScreen 提示。

产品名称和所有对外发布物统一使用 **AgentPaw · AI 桌伴**。

**免费、非营利，面向个人桌面陪伴与学习交流。** 不销售角色素材，不提供付费角色或付费下载。第三方角色的原创作者、账号和使用边界见[角色署名与素材说明](assets/CREDITS.md)。

这是独立开源的 **AI 桌宠 / Codex desktop pet / Claude Code companion / agent usage monitor**，与 OpenAI、Anthropic 无隶属关系。让任务状态、订阅额度与历史用量常驻桌面。程序为 `AgentPaw.exe`，数据保存在 `~/.agentpaw/`；首次启动会复制旧版配置、角色和历史记录，保留原目录作为恢复备份。

## 它能做什么

AgentPaw · AI 桌伴让你在桌面上查看 Codex 的任务进度、5h / 7d 订阅额度与 token 用量，也能把其他 AI 编程工具的本机会话汇聚到一起：忙时开工、需要你时举手、结束时提醒。无论 AI 是否正在工作，它都能提醒坐在电脑前的你喝水、伸伸懒腰；伙伴形象和紧凑胶囊都可使用。

- **一个桌伴，六个 Agent**：支持 Codex、Claude Code、TRAE、WorkBuddy、opencode 和 ZCode。
- **多角色与自建 IP**：角色独立保存动作；一张待命 GIF 即可创建新角色，也可通过角色包导入整套状态。内置角色的编辑和恢复默认互不影响。
- **状态一眼可见**：工作、思考、并行、清理、等待授权、等待回复、完成、出错、摸鱼与睡眠；后台任务或定时唤醒未结束时保持运行，不提前报完成。
- **表情自由定制**：集中查看每个状态的全部 GIF，可新增轮换、替换或移出选中项，也可一键恢复默认。
- **原生权限卡**：Claude Code 请求授权时，可直接在桌宠上允许、拒绝或永久允许。
- **统一用量面板**：聚合 token、缓存读写、上下文窗口、模型、每日趋势与 API 公价折算。
- **无需打开 Codex 即可查额度**：启动时自动发现桌面 Codex 自带的 CLI；右键 AgentPaw 品牌托盘图标即可查看当前脱敏账户、5h / 7d 剩余量、刷新点和更新时间。缺失窗口明确显示 `--`，无需手动配置。
- **接入自检与修复**：在设置中核对六个 Agent 的 Hook、插件或只读监听状态，可一键修复或卸载 AgentPaw 接入。
- **一键隐私模式**：右键 AgentPaw · AI 桌伴通过 ON/OFF 快速切换，也可在设置中控制；隐藏敏感明细但保留必要状态和用量。
- **本地优先**：会话与统计数据留在本机；公共价格由 models.dev 提供，订阅额度由 Codex 自己认证并读取。
- **轻量桌面交互**：拖动、贴边、工作速览、行动中心、系统托盘、开机启动和下班彩蛋。
- **照顾你的工作节奏**：喝水、伸展和远眺提醒独立于 AI 任务状态，伙伴和胶囊均可提醒；总开关、各类提醒、间隔和稍后提醒时长均可调整，也可今天跳过。
- **全屏免打扰与临时安静**：全屏时自动藏起，退出全屏后恢复；可选择安静 15 / 30 / 60 分钟或自定义时长。伙伴和胶囊使用同一套隐藏机制，后台继续监控，手动「收起／藏起」后只在你主动显示时恢复。

## 真实状态示例

内置 **打工猫、奶茶鼠与小蜜蜂蜜蜜**，也支持自己的原创 IP。奶茶鼠创作者为 **阿翅 Achi**，官方账号为「奶茶鼠的想法（BOBARAT）」，见[奶茶鼠署名](assets/characters/milktea-mouse/CREDITS.md)。小蜜蜂蜜蜜创作者为 **花栗鼠发发（曾用名：花栗鼠 Toby）**，见[蜜蜜署名与出处](assets/characters/mimi-bee/CREDITS.md)。

| 打工猫 · 工作中 | 奶茶鼠 · 工作中 | 小蜜蜂蜜蜜 · 打招呼 |
| --- | --- | --- |
| ![打工猫桌宠](assets/cat/cat-working.gif) | ![奶茶鼠 GIF 桌宠工作状态](assets/characters/milktea-mouse/13.gif) | ![小蜜蜂蜜蜜 GIF 桌宠](assets/characters/mimi-bee/01.gif) |

<table>
  <tr>
    <td align="center"><img src="assets/cat/cat-working.gif" width="132" alt="工作中"><br><strong>工作中</strong><br><sub>工具正在执行</sub></td>
    <td align="center"><img src="assets/cat/cat-thinking.gif" width="132" alt="思考中"><br><strong>思考中</strong><br><sub>模型正在推理</sub></td>
    <td align="center"><img src="assets/cat/cat-juggling.gif" width="132" alt="并行任务"><br><strong>并行任务</strong><br><sub>多条任务同时进行</sub></td>
    <td align="center"><img src="assets/cat/cat-waiting.gif" width="132" alt="等待授权"><br><strong>等待授权</strong><br><sub>需要你的决定</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/cat/cat-happy.gif" width="132" alt="任务完成"><br><strong>任务完成</strong><br><sub>一轮工作已结束</sub></td>
    <td align="center"><img src="assets/cat/cat-error.gif" width="132" alt="执行出错"><br><strong>执行出错</strong><br><sub>会话需要关注</sub></td>
    <td align="center"><img src="assets/cat/cat-loafing.gif" width="132" alt="工具间隙"><br><strong>工具间隙</strong><br><sub>等待下一步事件</sub></td>
    <td align="center"><img src="assets/cat/cat-sleeping.gif" width="132" alt="休息中"><br><strong>休息中</strong><br><sub>当前没有活跃任务</sub></td>
  </tr>
</table>

> 第三方角色素材不包含在代码的 MIT License 中。来源与权属分别见[猫角色素材署名](assets/cat/CREDITS.md)、[奶茶鼠素材说明](assets/characters/milktea-mouse/CREDITS.md)和[小蜜蜂蜜蜜素材说明](assets/characters/mimi-bee/CREDITS.md)。品牌图标独立于角色素材。

## 自定义状态表情

在任务栏托盘打开“设置”→“角色与表情”，先选角色，再选择工作、反馈或闲时状态。可直接创建新角色或[导入角色包](docs/character-packs.md)。选择状态后可以：

前三张卡片是内置角色，第四张 **“＋ 自定义角色”** 用来创建自己的伙伴：输入名称，选择待命 GIF，再逐个补充动作。已创建的个人角色排列在后面。

- “新增”保留当前表情，把新 GIF 加入随机轮换；
- 在播放列表中选中任意默认或自定义 GIF 后，可单独替换或移出；内置文件不会删除，自定义原始文件也不受影响；
- 每个状态至少保留一个表情；“恢复默认”会撤销该状态的全部调整。

导入流程会把 GIF 统一适配为桌宠使用的 120 × 120 画布，并尽量移除与主体分离的纯色背景。透明背景会原样保留；复杂背景不会强行抠图，以免破坏主体，设置页会给出提示。支持最大 12 MB、2048 × 2048、180 帧、60 秒的 GIF，每个状态最多保存 20 个自定义表情。

AgentPaw 只把处理后的副本保存在当前用户的 `~/.agentpaw/pet-assets`，不会修改或删除原始文件。设置保存后会立即同步到正在显示的桌宠，无需重启。用户自行导入的素材及其使用授权由用户负责。

## 支持矩阵

| Agent | 接入方式 | 是否修改外部配置 | 桌宠内授权 |
| --- | --- | --- | --- |
| Codex | 增量读取本机 rollout JSONL；官方 App Server 订阅额度通知 | 不修改 Codex 配置、不读取凭据文件 | 只读提醒 |
| Claude Code | `hook/agentpaw-hook.js` 生命周期 hook、transcript、进程信息 | 合并安装/卸载 AgentPaw hook，不覆盖已有 hook | 支持 |
| TRAE | 读取本机 IDE 日志与进程信息 | 仅在检测到 TRAE 后合并安装 hook | 只读提醒 |
| WorkBuddy | hook、transcript 与用量字段 | 仅在检测到 WorkBuddy 后合并安装 hook | 只读提醒 |
| opencode | 官方插件机制、事件与用量文件 | 安装/卸载一个独立插件文件 | 只读提醒 |
| ZCode | `hook/zcode-hook.js` 生命周期 hook（事件名在 stdin 载荷中）、只读轮询 ZCode 的 `model_usage` SQLite 台账 | 合并安装/卸载 `~/.zcode/cli/config.json` 的 hook 块，不覆盖已有 hook | 只读提醒 |

首次启动只接入当前 Windows 用户已经使用过的工具，不会为未检测到的 Agent 凭空创建配置目录。Codex 始终只读，不安装 hook。

## 安装与运行

### 使用发行版

从 [最新 Release](https://github.com/vista-zhangg/codex-desktop-pet/releases/latest) 下载：

- `AgentPaw-<version>-Windows-x64.exe`：唯一支持的 Windows x64 NSIS 安装包。

1.7.0 起，Release 不再提供源码/npm 部署入口或 ZIP 便携包；请安装 EXE 后使用，不要从压缩包或源码目录直接运行。

### 开发与贡献

源码启动、测试和本地打包命令仅供开发者与贡献者使用，不属于 Release 安装方式；请参阅[本地开发与打包手册](docs/LOCAL_DEPLOYMENT.md)。

## 开发者命令

开发者使用的 `npm` 命令、回归测试和 EXE 打包流程统一记录在[本地开发与打包手册](docs/LOCAL_DEPLOYMENT.md)中。

## 数据与隐私

- 配置、运行时令牌、价格缓存和用量台账保存在 `~/.agentpaw/`。
- Claude Code、Codex、TRAE、WorkBuddy、opencode 与 ZCode 的会话数据只在本机读取和处理。
- 本地 HTTP 服务只监听 loopback，写接口要求每次运行随机生成的令牌。
- models.dev 同步只下载公开价目表，不上传 transcript、rollout、权限内容或统计数据。
- Codex 额度通过一个长生命周期的 `codex app-server --stdio` 连接读取；AgentPaw 会先用 `account/read` 确认当前账户，再读取额度并监听更新。认证与上游请求均由 Codex 负责；AgentPaw 不读取 `~/.codex/auth.json` 的内容，也不访问 ChatGPT 网页接口。文件认证下，`auth.json` 被替换会触发立即重连；keyring / auto / ephemeral 没有可监听的文件事件，账户切换依赖 App Server 的账户通知、周期性 `account/read` 和定期重建连接收敛。因此界面表示的是 AgentPaw 自己这条 App Server 连接当前可见的账户，不承诺另一进程中的非文件认证切换能被文件 watcher 即时发现。
- 右键 AgentPaw · AI 桌伴或在设置中开启「隐私模式」只会遮蔽屏幕展示；监控与用量统计继续在本机运行，关闭后未处理事项自动恢复。
- 面板费用是按公开 API 单价折算的估计值，不等同于订阅账单或厂商最终结算。

完整说明见 [隐私与数据边界](docs/PRIVACY.md)。

## 工作原理

```text
Claude hook ─────┐
Codex rollout ───┼──> local server / watcher ──> adapter / core ──> 桌宠 + 详情面板
TRAE 日志 ───────┤                                  └────────────> 统一用量台账
WorkBuddy ───────┤
opencode 插件 ───┤
ZCode hook/DB ───┘
Codex App Server ───────> 托盘右键菜单（5h / 7d）+ 临界额度气泡
```

主进程负责 watcher 生命周期、托盘和窗口；后端状态机聚合多会话；renderer 只接收收敛后的状态与事件协议。状态词汇和优先级由 [`shared/states.js`](shared/states.js) 统一定义。

## 文档

- [用户使用介绍](docs/介绍.md)
- [本地部署与打包](docs/LOCAL_DEPLOYMENT.md)
- [版本发布流程](docs/RELEASE.md)
- [状态机与渲染规范](STATES.md)
- [隐私与数据边界（中英双语）](docs/PRIVACY.md)
- [贡献指南（中英双语）](CONTRIBUTING.md)
- [安全策略（中英双语）](SECURITY.md)

## 项目来源与许可证

AgentPaw 基于 [LLMPET](https://github.com/myunwang/LLMPET) 二次开发，并在 Windows 桌面交互、多 Agent 接入、用量统计、设置与工程结构方面进行了扩展和重构。

- 源代码依照 [MIT License](LICENSE) 发布；
- 根目录许可证保留上游 `Copyright (c) 2026 myunwang`；
- AgentPaw 的修改部分版权归相应贡献者所有；
- 第三方角色 GIF 与衍生头像版权归各自权利人，不适用代码的 MIT License；完整原作者署名保留在素材目录。

## 参与贡献

欢迎提交缺陷报告、Windows 兼容性改进和新 Agent 适配。提交前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

---

<div align="center">
  <sub>Codex desktop pet &amp; companion · Windows x64 · Local-first · Six AI coding tools.</sub>
</div>
