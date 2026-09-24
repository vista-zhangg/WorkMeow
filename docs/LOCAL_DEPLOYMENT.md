# 在本地开发和制作 AgentPaw · AI 桌伴 EXE 安装包

本文说明如何在 Windows 上进行源码开发、测试 AgentPaw · AI 桌伴，并制作本地 EXE 安装包。源码/npm 命令仅供开发者和贡献者使用，不是 Release 面向用户的安装方式。

## 支持范围

当前唯一支持的平台是 **Windows x64**。会话窗口聚焦支持 Windows Terminal、cmd、PowerShell 和 VS Code 等常见窗口。

AI 任务与用量功能需要用户安装并使用过以下至少一个 agent；休息提醒独立于 AI 任务运行：

- [OpenAI Codex](https://github.com/openai/codex)
- [Claude Code](https://claude.com/claude-code)
- TRAE
- WorkBuddy
- [opencode](https://opencode.ai/)
- ZCode（Z.ai 桌面客户端，未提供公开文档链接）

## 首次启动后

- AgentPaw · AI 桌伴会把本项目需要的 Claude Code / TRAE / WorkBuddy hooks、opencode 插件和 ZCode hook 块**合并/安装**，不会覆盖已有配置；
- Codex 不安装 hooks，只读监听 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`，用量同时纳入 `~/.codex/archived_sessions/` 中的归档会话；
- 新开的 Claude Code / Codex / TRAE / WorkBuddy / opencode / ZCode 会话会出现在桌宠的会话列表中；
- 配置、位置和用量历史保存在 `~/.agentpaw/`；界面固定为中文；
- 托盘菜单中的设置可以配置开机自动启动和下班彩蛋时间，默认时间为 10:55 和 16:55；
- 「陪伴与休息」设置页可以调整喝水、伸展、远眺提醒与全屏免打扰；伙伴形象与胶囊均使用同一组设置；

如果只使用 Codex，不希望安装 Claude hooks，可以按下方 PowerShell 示例设置 `AGENTPAW_NO_HOOKS` 后启动。

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
git clone https://github.com/vista-zhangg/codex-desktop-pet.git
cd codex-desktop-pet
npm ci
npm test
npm start
```

项目仓库为 <https://github.com/vista-zhangg/codex-desktop-pet>，上游源码地址为 <https://github.com/myunwang/LLMPET>。

### 发布前许可证与素材检查

- 上游代码采用 MIT License；公开发布时必须保留根目录 [`LICENSE`](../LICENSE) 中的 `myunwang` 原始版权声明和完整许可文本；
- `assets/cat/` 中的 GIF 素材来自第三方原创猫表情系列；发布时必须保留 [`CREDITS.md`](../assets/cat/CREDITS.md) 中的来源与署名；
- GIF 不纳入项目 MIT 许可，第三方转载或移作其他项目仍需另行取得原作者许可；
- 删除上游 `.git` 历史并建立独立仓库不违反 MIT，但不能删除上游版权声明，也不能把上游代码表述为完全原创。

- `npm ci` 按 `package-lock.json` 安装锁定版本，适合可复现部署；
- `npm test` 运行项目的无头回归测试；
- `npm start` 通过脱离终端的启动器运行桌宠；调试时使用 `npm run start:console` 让 Electron 留在当前终端。

### 界面预览与检查

运行 `npm run preview:ui`，使用示例数据检查详情、设置和胶囊界面。预览窗口在后台渲染，不启动正式应用后端，也不读写用户的 hooks 或用量记录。截图、检查结果和日志保存在 `.inspect/ui-preview/`，进程结束后命令返回通过或失败。

### 历史用量保护与恢复

“累计统计”合并本机已记录的各工具历史，不跟随今日、7 天、30 天筛选。Codex 用量同时扫描活动和归档会话；升级保留旧累计，并在迁移前生成 `codex-usage.json.before-v5.bak`。已记录的 Codex 累计费用保留记账时的估算，新用量按当前价格累加；价格刷新可以更新日明细估算，不会重新定价或清空累计基数。

如果旧版本重算已经丢失累计，先退出 AgentPaw，再用明确选定的历史备份恢复：

```powershell
node backend/codex-history-recover.js --from "$env:USERPROFILE\.octopus\codex-usage.json"
```

命令不联网，以备份累计为基数，只加入备份扫描时间之后的去重记录，并保留恢复前备份。重复执行同一备份不会叠加；会降低现有累计的备份会被拒绝。旧台账和源日志都缺失的部分无法凭空重建。恢复后需要使用支持 v5 台账的修复版本，旧版本不理解新格式。

预览脚本将日志直接写入文件，启动器也将 Electron 的标准输出、错误输出重定向到文件，避免短命终端管道关闭后触发 `EPIPE: broken pipe` 弹窗。未捕获错误会记录日志并退出，预览超过 90 秒也会退出。不要通过临时 PowerShell 命令直接启动后台 Electron 并继承其输出管道。

只验证界面、不修改 Claude Code 配置：

```powershell
$env:AGENTPAW_NO_HOOKS='1'
npm start
```

完全禁止可选的价格表联网请求：

```powershell
$env:AGENTPAW_NO_NET='1'
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
npm run package:win
```

## 制作本地安装包

先执行：

```powershell
npm ci
npm test
```

### Windows EXE 安装包

在 Windows x64 环境中运行：

```powershell
npm run package:win
```

产物位于 `dist/`，仅保留当前版本的 NSIS `.exe` 安装包和 `latest.yml`。后者用于应用内自动更新，包含安装包地址、大小与 SHA-512，用户不需要手动下载。新产物通过文件格式、版本、大小与实际哈希校验后，脚本才会删除旧包和构建中间目录。自 1.8.0 起不生成差分 `.blockmap`，不再发布独立 `SHA256SUMS.txt`；1.7.x 安装版仍可自动升级，旧客户端在缺少差分包时自动改为完整下载。

发布到 GitHub 的版本号、发布说明、标签、CI 校验及故障处理流程见 [Windows EXE 发布手册](RELEASE.md)。不要手动向 Release 混入旧版本文件或构建中间文件。

## 卸载

先从 AgentPaw · AI 桌伴托盘选择“卸载已安装的钩子和插件”，或在源码目录运行：

```powershell
npm run uninstall:hooks
```

然后退出 AgentPaw · AI 桌伴。`~/.agentpaw/` 是用户配置与用量历史目录；只有在确认不再需要这些数据时才手动删除。

## 常见问题

### 桌宠没有显示会话

1. 确认至少有一个已接入的 agent（Claude Code / Codex / TRAE / WorkBuddy / opencode / ZCode）运行过一次；
2. 启动 AgentPaw · AI 桌伴后新建一个 agent 会话；
3. Claude Code 用户可退出并重新打开 AgentPaw · AI 桌伴，让 hooks 重新对账；
4. Codex 用户确认 `~/.codex/sessions/` 下存在当前会话的 rollout 文件。
