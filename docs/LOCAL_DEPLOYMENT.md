# 将打工喵（WorkMeow）部署到用户本地

本文说明如何在 Windows 上从源码启动、测试打工喵（WorkMeow），并制作本地安装包。

## 支持范围

当前唯一支持的平台是 **Windows x64**。会话窗口聚焦支持 Windows Terminal、cmd、PowerShell 和 VS Code 等常见窗口。

打工喵至少需要用户安装并使用过以下一个 agent：

- [Claude Code](https://claude.com/claude-code)
- [OpenAI Codex](https://github.com/openai/codex)
- TRAE
- WorkBuddy
- [opencode](https://opencode.ai/)

## 首次启动后

- 打工喵会把本项目需要的 Claude Code / TRAE / WorkBuddy hooks 和 opencode 插件**合并/安装**，不会覆盖已有配置；
- Codex 不安装 hooks，只读监听 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`；
- 新开的 Claude Code / Codex / TRAE / WorkBuddy / opencode 会话会出现在桌宠的会话列表中；
- 配置、位置和用量历史保存在 `~/.workmeow/`；界面固定为中文；
- 托盘菜单中的设置可以配置开机自动启动和下班彩蛋时间，默认时间为 10:55 和 16:55；

如果只使用 Codex，不希望安装 Claude hooks，可以按下方 PowerShell 示例设置 `WORKMEOW_NO_HOOKS` 后启动。

## 从源码部署

### 准备环境

- Windows x64；
- [Git](https://git-scm.com/)；
- Node.js 22.12 或更高版本（与 Electron 43 的开发依赖要求一致；CI 覆盖 Node.js 22.12 和 24）；
- Claude Code 和/或 OpenAI Codex。

检查环境：

```powershell
git --version
node --version
npm --version
```

### 获取依赖并启动

```powershell
git clone https://github.com/vista-zhangg/WorkMeow.git
cd WorkMeow
npm ci
npm test
npm start
```

计划发布地址为 <https://github.com/vista-zhangg/WorkMeow>（仓库创建后生效），上游源码地址为 <https://github.com/myunwang/LLMPET>。

### 发布前许可证与素材检查

- 上游代码采用 MIT License；公开发布时必须保留根目录 [`LICENSE`](../LICENSE) 中的 `myunwang` 原始版权声明和完整许可文本；
- `assets/cat/` 中的 GIF 来自抖音博主 **@月薪喵**，已获授权用于本项目；发布时必须保留 [`CREDITS.md`](../assets/cat/CREDITS.md) 中的来源与署名；
- GIF 不纳入项目 MIT 许可，第三方转载或移作其他项目仍需另行取得原作者许可；
- 删除上游 `.git` 历史并建立独立仓库不违反 MIT，但不能删除上游版权声明，也不能把上游代码表述为完全原创。

- `npm ci` 按 `package-lock.json` 安装锁定版本，适合可复现部署；
- `npm test` 运行项目的无头回归测试；
- `npm start` 通过脱离终端的启动器运行桌宠；调试时使用 `npm run start:console` 让 Electron 留在当前终端。

只验证界面、不修改 Claude Code 配置：

```powershell
$env:WORKMEOW_NO_HOOKS='1'
npm start
```

完全禁止可选的价格表联网请求：

```powershell
$env:WORKMEOW_NO_NET='1'
npm start
```

### 网络较慢时

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
```

如果打包阶段也无法连接 GitHub 的 Electron/7-Zip 发行地址：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run package:portable
```

## 制作本地安装包

先执行：

```powershell
npm ci
npm test
```

### Windows 安装包

在 Windows x64 环境中运行：

```powershell
npm run package:win
```

产物位于 `dist/`，包括 NSIS `.exe` 安装包、`.zip` 免安装包和 `SHA256SUMS.txt`。构建中间目录与调试配置会在成功打包后自动清理。

只生成便于分发给普通用户的 Windows x64 ZIP：

```powershell
npm run package:portable
```

接收者必须完整解压 ZIP，然后双击解压目录中的 `WorkMeow.exe`。便携版会使用 Electron 内置的 Node 模式执行展开到 `~/.workmeow/hook-runtime/` 的 hook，不要求接收者安装 Node.js。

## 卸载

先从打工喵托盘选择“卸载已安装的钩子和插件”，或在源码目录运行：

```powershell
npm run uninstall:hooks
```

然后退出打工喵。`~/.workmeow/` 是用户配置与用量历史目录；只有在确认不再需要这些数据时才手动删除。

## 常见问题

### 桌宠没有显示会话

1. 确认至少有一个已接入的 agent（Claude Code / Codex / TRAE / WorkBuddy / opencode）运行过一次；
2. 启动打工喵后新建一个 agent 会话；
3. Claude Code 用户可退出并重新打开打工喵，让 hooks 重新对账；
4. Codex 用户确认 `~/.codex/sessions/` 下存在当前会话的 rollout 文件。
