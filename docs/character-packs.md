# 桌宠角色与本地角色包

设置 →「角色与表情」中可以切换角色、用一张 GIF 创建角色，或选择 `character.json` 导入整套动作。内置打工猫、奶茶鼠与小蜜蜂蜜蜜；每个角色独立保存自己的默认动作和后续编辑。升级会保留原有 GIF。

小蜜蜂蜜蜜的 16 张 GIF 保留原生透明背景，覆盖全部状态，支持单独替换、增加和恢复默认。原作者为花栗鼠发发（曾用名：花栗鼠 Toby），详见[素材署名](../assets/characters/mimi-bee/CREDITS.md)。

角色包是一个本地文件夹，包含 `character.json` 和它引用的 GIF 文件；目前没有在线发布或 ZIP 解包功能。把整个文件夹交给使用者即可导入。

```json
{
  "format": "agentpaw-character",
  "version": 1,
  "name": "我的伙伴",
  "removeBackground": false,
  "slots": {
    "idle": ["gifs/idle.gif"],
    "working": ["gifs/working.gif", "gifs/working-2.gif"],
    "happy": ["gifs/happy.gif"]
  },
  "notes": {
    "ambient-sleep": "暂用待命动作，稍后补充睡觉动画。"
  }
}
```

`idle` 至少需要一个 GIF。未配置的状态自动使用这个角色的待命动作，设置中会标注；其他角色的素材不会混入。`removeBackground: false` 保留原背景，适配时仍按桌宠现有规范缩放到 120×120 并保留留白。

支持的 16 个槽位：`idle`、`working`、`thinking`、`talking`、`juggling`、`sweeping`、`loafing`、`waiting`、`needsinput`、`happy`、`greet`、`error`、`sad`、`ambient-awake`、`ambient-sleep`、`xiaban`。

每个状态最多 20 个默认动作，整包最多 64 个不同 GIF、原始文件合计 128 MB。GIF 沿用应用的单文件、帧数和时长限制。引用路径必须在角色包目录内；导入时会复制并适配文件，之后移动原文件夹不影响播放。

恢复状态默认值只影响当前角色。内置角色不能移除；移除个人角色会从列表隐藏，并将其文件保留在本机 `.removed-*` 目录中。后续需要回收磁盘空间时可以单独处理归档。

开发时可以执行 `node scripts/import-pet-character.js <character.json>` 导入本地角色并选中，重启应用生效。正常使用建议走设置入口，可即时生效。

微信素材提取属于本次本地素材准备过程，不属于角色包导入能力；应用本身不会读取微信数据。用户自己的素材无需经过微信即可导入。
