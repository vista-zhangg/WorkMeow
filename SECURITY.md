# 安全策略 / Security Policy

## 支持范围 / Supported versions

WorkMeow 当前维护最新发布版本和 `main` 分支。旧版本只在修复能安全回移时获得安全更新。

WorkMeow currently maintains the latest release and the `main` branch. Older versions receive security fixes only when a safe backport is practical.

## 私下报告 / Private reporting

请优先使用 GitHub 仓库 **Security → Report a vulnerability** 私下提交报告。若该入口暂不可用，请通过维护者的 GitHub 主页联系，并只提供足以建立私密沟通渠道的最少信息；不要在公开 Issue 中附加漏洞细节、真实 transcript、令牌或个人路径。

Please use **Security → Report a vulnerability** in this repository whenever available. If private reporting is temporarily unavailable, contact the maintainer through their GitHub profile with only enough information to establish a private channel. Do not place exploit details, real transcripts, tokens, or personal paths in a public issue.

报告应尽量包含 / A useful report includes:

- 受影响版本与 Windows 环境 / affected version and Windows environment;
- 可复现步骤与实际影响 / reproduction steps and observed impact;
- 是否涉及 loopback 服务、hook、权限响应或本地文件 / whether loopback, hooks, permission responses, or local files are involved;
- 已做脱敏的日志或最小复现 / redacted logs or a minimal reproduction;
- 建议修复（可选）/ a suggested fix, if available.

## 安全边界 / Security boundaries

以下问题属于高优先级 / The following are high priority:

- 未经授权调用本地写接口 / unauthenticated local write requests;
- 伪造或错误复用权限决定 / forged or incorrectly reused permission decisions;
- hook 安装覆盖用户现有配置 / hook installation overwriting user configuration;
- transcript、rollout、令牌或路径被外发 / exfiltration of transcripts, rollouts, tokens, or paths;
- 任意文件读写或命令执行 / arbitrary file access or command execution;
- 打包或升级破坏用户数据 / packaging or migration that destroys user data.

价格估算误差、未支持的平台和缺少商业代码签名通常不属于安全漏洞，但仍可作为普通 Issue 报告。

Pricing-estimate differences, unsupported platforms, and the absence of commercial code signing are generally not security vulnerabilities, but may still be reported as regular issues.
