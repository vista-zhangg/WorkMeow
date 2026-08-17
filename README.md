<div align="center">
  <img src="assets/tray-cat.svg" width="112" alt="打工喵图标">
  <h1>打工喵（WorkMeow）</h1>
  <p><strong>让一只喵替你盯住所有正在工作的 AI 编程助手。</strong></p>
  <p>实时聚合 Claude Code、Codex、TRAE、WorkBuddy 与 opencode 的状态、提醒、权限请求和 token 用量。</p>

  <p>
    <a href="README.md">简体中文</a> ·
    <a href="README_EN.md">English</a>
  </p>

  <p>
    <a href="https://github.com/vista-zhangg/WorkMeow/actions/workflows/ci.yml"><img src="https://github.com/vista-zhangg/WorkMeow/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64-0078D4?logo=windows" alt="Windows x64 only">
    <img src="https://img.shields.io/badge/version-1.4.0-F6A04A" alt="Version 1.4.0">
    <a href="LICENSE"><img src="https://img.shields.io/badge/code%20license-MIT-2EA44F" alt="MIT License"></a>
  </p>
</div>

> [!IMPORTANT]
> WorkMeow 当前**仅支持 Windows x64**，不支持 macOS、Linux 或 Windows on ARM。Windows 安装包尚未进行商业代码签名，首次运行时可能出现 SmartScreen 提示。

产品名称和所有对外发布物统一使用 **打工喵（WorkMeow）**。

## 它能做什么

当多个 Agent 同时工作时，频繁切换窗口查看状态很容易打断思路。WorkMeow 把本机上的会话汇聚为一个常驻桌面的小窗口：忙时开工、需要你时举手、结束时提醒，还能在统一面板中查看用量与上下文。

- **一只喵，五个 Agent**：统一监控 Claude Code、Codex、TRAE、WorkBuddy 和 opencode。
- **状态一眼可见**：工作、思考、并行、清理、等待授权、等待回复、完成、出错、摸鱼与睡眠。
- **原生权限卡**：Claude Code 请求授权时，可直接在桌宠上允许、拒绝或永久允许。
- **统一用量面板**：聚合 token、缓存读写、上下文窗口、模型、每日趋势与 API 公价折算。
- **本地优先**：会话与统计数据留在本机；唯一的常规外联是下载 models.dev 公共模型价目表。
- **轻量桌面交互**：拖动、贴边、工作速览、行动中心、系统托盘、开机启动和下班彩蛋。

## 真实状态示例

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

> GIF 素材来自抖音博主 **@月薪喵** 的原创“月薪喵”表情系列，已获授权用于 WorkMeow 项目及其发布物。素材版权不包含在本项目 MIT License 中；完整来源与授权边界见 [素材署名](assets/cat/CREDITS.md)。

## 支持矩阵

| Agent | 接入方式 | 是否修改外部配置 | 桌宠内授权 |
| --- | --- | --- | --- |
| Claude Code | `hook/workmeow-hook.js` 生命周期 hook、transcript、进程信息 | 合并安装/卸载 WorkMeow hook，不覆盖已有 hook | 支持 |
| Codex | 增量读取本机 rollout JSONL | 不修改 Codex 配置 | 只读提醒 |
| TRAE | 读取本机 IDE 日志与进程信息 | 仅在检测到 TRAE 后合并安装 hook | 只读提醒 |
| WorkBuddy | hook、transcript 与用量字段 | 仅在检测到 WorkBuddy 后合并安装 hook | 只读提醒 |
| opencode | 官方插件机制、事件与用量文件 | 安装/卸载一个独立插件文件 | 只读提醒 |

首次启动只接入当前 Windows 用户已经使用过的工具，不会为未检测到的 Agent 凭空创建配置目录。Codex 始终只读，不安装 hook。

## 安装与运行

### 使用发行版

正式版本发布后，可从 [GitHub Releases](https://github.com/vista-zhangg/WorkMeow/releases) 下载：

- `WorkMeow-<version>-Windows-x64.exe`：Windows 安装包；
- `WorkMeow-<version>-Windows-x64.zip`：免安装便携版。

便携版必须**完整解压**后再运行 `WorkMeow.exe`，不要在压缩软件预览窗口中启动，也不要只复制单个 EXE。

### 从源码运行

要求：Windows x64、Node.js 18 或更高版本、npm，以及至少一个受支持的 Agent。

```powershell
git clone https://github.com/vista-zhangg/WorkMeow.git
cd WorkMeow
npm ci
npm test
npm start
```

调试时让 Electron 保持在当前终端：

```powershell
npm run start:console
```

## 常用命令

```powershell
npm start                 # 脱离当前终端启动
npm run start:console     # 在当前终端启动，便于调试
npm test                  # 运行 29 套回归测试
npm run install:hooks     # 对已检测到的工具安装/对账 hook 与插件
npm run uninstall:hooks   # 备份后卸载 WorkMeow 写入的 hook 与插件
npm run meter:rebuild     # 用当前价格重新计算本机历史台账
npm run package:portable  # 构建 Windows x64 便携 ZIP
npm run package:win       # 构建安装包、ZIP 与 SHA-256 校验值
```

## 数据与隐私

- 配置、运行时令牌、价格缓存和用量台账保存在 `~/.workmeow/`。
- Claude Code、Codex、TRAE、WorkBuddy 与 opencode 的会话数据只在本机读取和处理。
- 本地 HTTP 服务只监听 loopback，写接口要求每次运行随机生成的令牌。
- models.dev 同步只下载公开价目表，不上传 transcript、rollout、权限内容或统计数据。
- 面板费用是按公开 API 单价折算的估计值，不等同于订阅账单或厂商最终结算。

完整说明见 [隐私与数据边界](docs/PRIVACY.md)。

## 工作原理

```text
Claude hook ─────┐
Codex rollout ───┼──> local server / watcher ──> adapter / core ──> 桌宠 + 详情面板
TRAE 日志 ───────┤                                  └────────────> 统一用量台账
WorkBuddy ───────┤
opencode 插件 ───┘
```

主进程负责 watcher 生命周期、托盘和窗口；后端状态机聚合多会话；renderer 只接收收敛后的状态与事件协议。状态词汇和优先级由 [`shared/states.js`](shared/states.js) 统一定义。

## 文档

- [用户使用介绍](docs/介绍.md)
- [本地部署与打包](docs/LOCAL_DEPLOYMENT.md)
- [状态机与渲染规范](STATES.md)
- [隐私与数据边界（中英双语）](docs/PRIVACY.md)
- [贡献指南（中英双语）](CONTRIBUTING.md)
- [安全策略（中英双语）](SECURITY.md)

## 项目来源与许可证

WorkMeow 基于 [LLMPET](https://github.com/myunwang/LLMPET) 二次开发，并在 Windows 桌面交互、多 Agent 接入、用量统计、设置与工程结构方面进行了扩展和重构。

- 源代码依照 [MIT License](LICENSE) 发布；
- 根目录许可证保留上游 `Copyright (c) 2026 myunwang`；
- WorkMeow 的修改部分版权归相应贡献者所有；
- 月薪喵 GIF 归抖音博主 **@月薪喵** 所有，按针对本项目的授权使用，不随 MIT License 再授权。

## 参与贡献

欢迎提交缺陷报告、Windows 兼容性改进和新 Agent 适配。提交前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

---

<div align="center">
  <sub>Windows x64 only · Local-first · One cat, all your agents.</sub>
</div>
