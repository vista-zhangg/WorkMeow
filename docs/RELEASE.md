# WorkMeow Windows EXE 发布手册

适用于 1.8.0 及之后的 Windows x64 安装版。对外提供简洁下载入口，同时保留已安装用户的应用内升级能力。一个版本只执行一次完整本地测试和一次本地打包；CI 在独立环境中再次验证并生成正式发布包。

## 发布契约

`dist/` 和 GitHub Release 的上传附件必须恰好包含两个文件：

- `WorkMeow-<version>-Windows-x64.exe`：唯一面向用户的安装包。
- `latest.yml`：兼容现有更新客户端的版本、文件地址、大小和 SHA-512；用户不需要自行下载。

不发布 ZIP 便携包、`.exe.blockmap`、独立 `SHA256SUMS.txt`、构建目录或调试配置。GitHub 自动生成的 Source code (zip / tar.gz) 是平台提供的源码入口，不是应用安装包。

不要为了让附件列表只剩 EXE 而删除 `latest.yml`：1.7.x 已安装客户端先读取最新 Release 的这个文件，删除它会直接中断应用内升级。1.7.x 在缺少 blockmap 时会自动退回完整下载安装包；1.8.0 起直接使用完整下载。SHA-512 内容校验和 NSIS 安装流程继续由 electron-updater 负责，不能绕过。

## 固定操作流程

1. 确认待发布改动完整、属于同一个版本，并检查远端分支及标签；不得覆盖已发布标签。
2. 同步修改 `package.json`、`package-lock.json` 根版本与根包版本、中文和英文 README 的版本徽标。
3. 编写 `docs/releases/<version>.md`，说明用户可见变化、安装与升级方式及已知限制。不要只堆砌提交列表。
4. 运行 `npm test`。发生失败时先修复，再执行受影响的测试；只有新改动需要扩大验证范围时才重跑全部测试。
5. 运行 `npm run package:win`。命令构建 NSIS EXE，并调用 `finalize-dist.js` 先验证新产物，再清理旧产物，最后检查精确文件集合。
6. 检查安装包版本信息、`git diff --check` 和 `git status --short`；明确列出暂存路径，提交全部本次版本所需的源代码、文档和测试。`dist` 不提交 Git。
7. 推送当前发布分支，再创建并推送相同版本的带注释标签，例如 `v1.8.0`。标签必须严格等于 `v` 加 `package.json` 的版本号。
8. 等待 `.github/workflows/ci.yml` 和 `.github/workflows/release.yml` 完成；确认分支测试、Windows 构建、发布任务均成功。
9. 核对远端标签指向本次提交、最新 Release 的版本、发布说明和两个附件；确认 GitHub API 中附件大小与 SHA-256 校验结果通过。回报 Release 链接和本地安装包路径。

本地维护命令：

```powershell
npm test
npm run package:win
npm run verify:dist
```

`verify:dist` 是需要时使用的独立复核命令，正常打包已自动执行同样的验证。

## 校验与安全清理

`scripts/verify-dist.js` 检查：

- 文件存在、非空、为普通文件，安装包具备有效 Windows PE 头；
- `latest.yml` 的版本、唯一安装包地址、大小正确；
- 对实际 EXE 计算的 SHA-512 与 `files[]` 和兼容字段中的摘要完全一致；
- 清理后的目录恰好只有当前 EXE 与 `latest.yml`。

关闭差分打包后，electron-builder 可能省略 `files[].size`。`scripts/finalize-dist.js` 先验证版本、文件名、PE 头和实际 SHA-512，再补齐缺失的文件大小；已存在但错误的大小不会被自动覆盖。全部新产物通过校验后才删除旧文件；每个删除目标必须是经过解析的 `dist` 的直接子项。校验失败时保留旧安装包，不进行换代清理。符号链接只删除链接本身。

构建复用 `node_modules/electron/dist`，不重复下载 Electron。NSIS 的 `differentialPackage` 固定为 `false`，避免生成不再使用的差分包。

## CI 发布方式

标签触发 Windows 构建任务：安装锁定依赖、核对标签版本、运行测试、检查素材署名、构建并验证两个产物。Actions artifact 只传递这两个文件，避免把 `dist/*` 等宽泛匹配直接上传 Release。

发布任务下载该 artifact 后运行 `npm run release:publish`：

1. 重新验证本次安装包与更新元数据。
2. 创建带版本发布说明的 **draft Release**，上传明确列出的两个附件。
3. 从 Release 列表解析草稿的 ID，按 ID 读取草稿。按标签查询的 API 不提供草稿，不能用它进行发布前校验。对两个本地文件分别计算 SHA-256，与 GitHub API 返回的上传附件摘要和大小比对。
4. 全部一致后才将草稿公开并设为 Latest，再读取远端进行复核。

发布脚本只能在匹配仓库与版本标签的工作流中执行。失败的草稿可以通过重跑任务继续处理；已公开版本不会被覆盖，应另发新版本。修改已发布版本的说明时保留准确的安装与兼容性信息；不要删除旧客户端需要的 `latest.yml`。

不要重新下载 Release 覆盖本地 `dist`。本地包和 CI 包因构建时间戳可能具有不同哈希，它们应分别通过自身的 `latest.yml` 校验。正式线上包以 CI 产物为准。

## 等待与故障处理

- `building target=nsis` 阶段存在 `makensis.exe`：正常构建，等待完成。
- 重复下载 Electron：检查 `build.electronDist`，应指向 `node_modules/electron/dist`。
- 缺少 EXE 或 `latest.yml`、版本或摘要不符：修复构建配置，不能绕过验证或先删旧包。
- GitHub 上传失败或摘要尚未就绪：保持草稿；脚本会短暂重试摘要读取，失败后检查日志再重跑任务。
- 发布脚本需要修复且标签尚未公开：先确认 Release 仍为草稿、旧工作流已结束，再提交修复。仅在这种情况下可将未发布标签移至修复提交，推送时必须使用指定旧标签对象的 `--force-with-lease`；重新触发完整发布校验，复用草稿。不得将此例外用于已公开版本。
- Release 已公开但要修复程序：使用新版本和新标签，不强推已发布标签或悄悄替换 EXE。
- 只有超过十分钟、相关压缩/安装器进程不存在且 CPU 与磁盘均无活动时，才将本地打包视为卡死。

自动化输出仅保留测试结论、构建阶段变化和失败日志。GitHub Actions 使用间隔查询，不持续打印完整任务树。最终核对远端资产即可，无需重复下载约 100 MB 的安装包。
