# 贡献指南 / Contributing Guide

感谢你改进打工喵（WorkMeow）。项目当前只接受能在 **Windows x64** 上验证的变更。

Thank you for improving WorkMeow. The project currently accepts changes that can be validated on **Windows x64**.

## 开发环境 / Development setup

- Windows x64
- Node.js 22.12 或更高版本 / Node.js 22.12 or newer
- npm（依赖以 `package-lock.json` 为准 / dependencies are locked by `package-lock.json`）

```powershell
npm ci
npm test
npm run start:console
```

若只验证界面且不希望修改任何 Agent 配置：

To inspect the UI without changing any agent configuration:

```powershell
$env:WORKMEOW_NO_HOOKS='1'
npm run start:console
```

## 提交要求 / Pull request expectations

1. 保持改动聚焦，并说明用户可见影响。Keep each change focused and describe its user-visible impact.
2. 新功能必须补充或更新测试。Add or update tests for new behavior.
3. 提交前运行 `npm test`。Run `npm test` before submitting.
4. 不提交 `node_modules/`、`dist/`、日志、本机配置、transcript 或用量台账。Never commit dependencies, builds, logs, local configuration, transcripts, or usage ledgers.
5. 新增第三方代码或素材时必须记录来源、许可证和再分发权限。Record origin, license, and redistribution rights for every third-party dependency or asset.
6. 不得删除 [`LICENSE`](LICENSE) 中的上游版权声明，也不得删除 [`assets/cat/CREDITS.md`](assets/cat/CREDITS.md) 的月薪喵署名。Do not remove the upstream copyright notice or the 月薪喵 attribution.

推荐使用简洁的 Conventional Commit，例如：

Use concise Conventional Commits when practical:

```text
feat: add a new agent watcher
fix: preserve permission cards across retries
docs: clarify Windows installation
test: cover rollout truncation
```

## 新 Agent 接入 / Adding an agent

- 在 `shared/agents.js` 注册唯一 ID 与显示名；
- 在 `backend/source-registry.js` 注册统计来源；
- 明确声明 notification 语义，未知事件采用 fail-closed；
- 不得静默修改外部工具配置；安装必须可检测、合并且可卸载；
- 对日志、transcript 和用量解析增加隔离测试。

Register the agent centrally, declare notification semantics explicitly, avoid silent configuration changes, provide reversible integration, and add isolated parser/watcher tests.

## 安全问题 / Security issues

不要在公开 Issue 中披露令牌绕过、权限决策、任意文件写入或敏感信息泄漏细节。请按 [SECURITY.md](SECURITY.md) 私下报告。

Do not disclose token bypasses, permission-decision flaws, arbitrary file writes, or sensitive-data leaks in public issues. Follow [SECURITY.md](SECURITY.md) for private reporting.
