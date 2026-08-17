# 打工喵状态规范

本文件描述当前代码使用的状态词汇和聚合规则。唯一词汇来源是 `shared/states.js`；后端、renderer 和测试都从该文件读取或校验，不能在其他模块另写一套列表。

## 状态词汇

### 后端可接收状态

`error`、`notification`、`sweeping`、`attention`、`carrying`、`juggling`、`working`、`thinking`、`idle`、`sleeping`，以及预留的入睡序列：`yawning`、`dozing`、`collapsing`、`waking`。

### renderer 合成状态

`loafing`、`happy`、`waiting`、`needsinput`、`greet`、`talking`、`loved`、`sad`、`sorry`、`excited`、`puzzled`。

这些状态通过 `shared/states.js` 的 `RENDER_STATE_WORDS` 统一清理，保证同一时刻不会把旧状态 class 泄漏到喵身上。

## 后端状态机

- `working`、`thinking`、`juggling`、`carrying`、`sweeping` 属于忙碌状态，会参与卡住检测和 transcript 轮询。
- `attention`、`carrying`、`sweeping`、`error` 是带 TTL 的短暂状态；没有后续事件时会回落。
- `notification` 表示需要用户注意，不按普通短暂状态自动衰减。
- `sleeping` 只在没有活跃会话且空闲超过阈值时出现；有新会话会被唤醒。

## Notification 事件语义隔离（分类与识别）

`Notification` 是 Claude Code / WorkBuddy / TRAE 共用的一个 hook 事件名，但语义被重载：它既表示「我阻塞在等你」，也表示「这里安静了一会儿」。早期实现无差别把每个 `Notification` 都判成「等你回复」，而 `notification` 态又被排除在 oneshot TTL 衰减之外，于是 WorkBuddy 每个**已结束**的会话都会在 60 秒空闲定时器触发后变成「等你回复」并永久卡住。

分类逻辑集中在 `backend/notify-policy.js`：每个工具在 `AGENT_NOTIFY` 注册表中**显式声明**自己的 `notification_type` 词表与未知兜底，新工具必须写明语义，不能静默继承 Claude（注册表覆盖 `shared/agents.js` 的全部工具，由 `test/notify-policy.js` 锁死）。

- **workbuddy**：载荷带 `notification_type`，共 4 值——
  - `permission_prompt` → 真的阻塞（WorkBuddy 没有阻塞型 PermissionRequest hook，这是唯一授权信号）
  - `elicitation_dialog` → AskUserQuestion 卡片打开，真的阻塞
  - `idle_prompt` → 回合结束 60 秒后的空闲定时器，**不阻塞**
  - `auth_success` → 登录提示，纯噪声，整条丢弃
- **claude / trae**：无 `notification_type`，退回消息文本启发式（`waiting for your input` / `等待你的输入` → 不阻塞；`needs your permission` / `需要你的授权` → 阻塞）；无法归类一律判阻塞（宁可误报也不吞掉真实等待）。
- **codex / opencode**：不经过此分类（它们的 watcher 已只在审批 / elicitation 事件产出 `notification`，opencode 显式忽略纯 `session.idle`）。

分类产生三种裁决，由 `hook-common.js` 落实：
- `blocking` → 保留 `notification` 态（真「等你回复」）
- `idle` → 降级为 `idle`，事件改名 `IdleNotification`，仅用于把卡死的忙碌态软着陆
- `info` → 整条事件丢弃，不发 HTTP

`core.js` 的 `IdleNotification` 走 `applyIdleNotification`：只把卡死的 `working` 软着陆到 `idle`，不创建会话、不刷新 `updatedAt`、不清真实 `notification`、不动完成 / 中断徽标。`ElicitationResult` 是用户答完「等待结束」的信号，归入 `thinking`，立即解除 `needsinput`。`server.js` 透传上游 `notification_type`（白名单 `^[a-z_]{1,32}$`），`workbuddy-hookinstall.js` 的 `COMMAND_EVENTS` 已补 `ElicitationResult`。

## renderer 聚合优先级

`renderer/pet.js` 的 `applyStats` 使用下面的顺序，越靠前越优先：

```text
waiting
  > 短暂态（happy / talking / 情绪反馈等）
  > error
  > needsinput
  > sweeping
  > juggling
  > working
  > thinking
  > loafing
  > idle / sleeping
```

`waiting` 和 `needsinput` 不能被其他会话的普通工作事件盖掉，因为它们代表用户需要立即处理的事项。用户正在操作卡片或详情面板时，状态快照只更新数据，不抢焦点或重置交互。

后端 `STATE_PRIORITY` 还保留 `notification`、`attention` 和 `carrying` 的数值优先级，用于多会话状态聚合和事件回收；renderer 对 `waiting`、`needsinput` 等用户交互态有额外保护，这是有意的分层，不是重复实现。

## 事件到视觉状态

| 事件/条件 | 视觉表现 |
| --- | --- |
| 新用户任务 | `thinking` 短暂过渡，随后按真实工具动作进入 `working` |
| 工具执行 | `working`，叠加工具动作和小图标；并行任务可进入 `juggling` |
| 等待权限 | `waiting`，显示授权卡 |
| 等待用户回答 | `needsinput`，显示问题卡 |
| 工具结束 | `happy` 或完成徽标；消息会在庆祝结束后接棒显示 |
| 网络/API 错误 | `error`，直到会话恢复或短暂态回收 |
| 工具间隙 | `loafing`，表示上一步已完成且尚未收到下一步事件 |
| 长时间无活跃会话 | `sleeping` |

可用的 GIF 和情绪映射集中在 `renderer/pet.js`。预留状态有词汇和状态机支持，但没有生产事件时不会凭空播放。

## loafing / idle / sleeping 的判定边界

三者都表现为「没在干活」，但触发条件完全不同，阈值散落在三个文件里，这里集中记录：

| | `loafing` 摸鱼 | `idle` 待命 | `sleeping` 睡觉 |
| --- | --- | --- | --- |
| 会话状态 | 活着，任务进行中 | 活着，本轮已收尾 | 已结束，或一个都没有 |
| 语义 | 上一步干完、下一步还没来 | 球在用户手上 | 无事可做 |
| 判定方 | `backend/adapter.js` 启发式推断 | 后端事件驱动 | 后端事件 + renderer 阈值 |
| 阈值 | 距上个 hook 事件 > 5 s **且** transcript 静止 | 即时 | `idleMs > 6 min` 或 `idleMs == null` |
| 常量 | `LOAF_GAP_MS` / `TRANSCRIPT_ACTIVE_MS`（150 s） | — | `IDLE_SLEEP_MS`（`renderer/pet.js`） |

两个容易踩的细节：

- **loafing 的防误判**：只看「5 秒没事件」会误伤长篇输出——模型可能正在产出、只是还没调工具。`adapter.js` 额外检查 transcript 文件的修改时间，**文件还在长就保持 `working`**，否则会出现「模型疯狂输出、喵却躺地上刷手机」。
- **Codex 例外**：Codex 的 rollout 有明确的 `task_complete` / `turn_aborted` 信号，且本轮首个工具之后可能长时间不落盘，套用上述启发式会误报摸鱼，因此 `e.agentId !== 'codex'` 直接跳过。
- **`idleMs == null` 必须落到 `sleeping`**：`null` 表示已无任何活跃会话。早期把 `null` 归到 `idle`，导致桌宠永不入睡，且睡着后会话被回收还会凭空惊醒。

## 闲时作息（ambient）

无任务时长期只播一张睡觉图既呆板也不真实。`renderer/pet.js` 在语义态为 `sleeping` 时挂一层**只影响画面、不改语义**的作息表。

**边界很关键**：语义态始终保持 `sleeping`，会话点过滤（`isBaseVisibleSession`）、气泡抑制、`playAction` 屏蔽、上面的聚合优先级全部照旧；随画面变化的只有两样——显示哪张 GIF，以及 💤 角标（`.sleep.on`）亮不亮。

**为什么不直接把语义态换成 `loafing` / `idle`**：`loafing` 现在明确表示「任务进行中的工具间隙」，`idle` 表示「本轮收尾、等你下一句」。若无任务时复用它们，就再也无法一眼分辨「喵在摸鱼」到底有没有活在跑，诊断价值归零。

作息片段（`AMBIENT_SCENES`）分「睡着」与「醒着」两组：

- 睡着：`cat-sleeping.gif`、`cat-sleeping-2.gif`
- 醒着：`cat-loafing.gif` / `-2` / `-3` / `-4` / `-5`、`cat-idle.gif`、`cat-thinking-2.gif`（趴着望云发呆）、`cat-roam.gif`（撒腿跑着玩）

抽取规则「越闲越困」（`AMBIENT_PHASES`，按进入闲置后的累计时长推进）：

| 阶段 | 时长 | 抽到「醒着」的概率 | 每个片段停留 | 最多连续睡 / 醒 |
| --- | --- | --- | --- | --- |
| 刚下班 | 0–5 min | 85 % | 15–35 s | 2 / 4 |
| 犯困期 | 5–20 min | 45 % | 25–55 s | 2 / 3 |
| 夜深了 | > 20 min | 15 % | 45–120 s | 3 / 2 |

刚进入闲置时固定先播一段醒着的待命/摸鱼/发呆画面；之后由概率决定节奏，但连续睡眠或清醒达到护栏后会强制切换，避免“永远睡觉”或“永远不睡”。越往后不只是越困，切换也越慢——睡沉了还每 30 秒换个睡姿会看着发抖。停留时长在区间内随机取，且不连播同一张；`cat-roam.gif` 动作幅度大，用片段级 `hold` 覆盖为 8–16 s 短播。任何阶段都保留反向可能（夜深时仍会翻身摸手机），所以画面永远不会静止成一张图。

特殊片段 `cat-xiaban.gif` 不参加随机池，而是按本机当地时间定时触发。默认窗口为每天 **10:55–11:05** 和 **16:55–17:05**；开始时间可以在任务栏托盘的“设置”中修改，保存后立即同步到桌宠。它仅在语义状态为 `idle` 或 `sleeping` 时播放；任务开始会立即让位，窗口结束后恢复普通闲时作息。动画开始时会同步弹出一条随机气泡：上午窗口为“午饭/干饭”主题，下午窗口为“收工/下班”主题；同一日的同一窗口只播报一次，不会被周期状态快照重复触发。

概率与连续片段护栏共同控制节奏：短期不会连续睡死，长期仍会逐步偏向睡眠；停留时长按阶段变长，因此越闲越安静但不会失去活动感。

中途有任何活动会退出作息表；重新闲下来时时段进度从头计（刚被打断过说明有事发生，重新从「刚下班」开始合理）。

对应回归在 `test/state-smoke.js` 的 `[R6b]`：锁死「语义态仍是 sleeping」「画面只取自片段集」「会轮换」「不只有睡觉」「💤 角标与画面一致」五条。

## 桌面交互布局

- 左键短按猫本体会按“待处理 > 错误 > 正在运行 > 今日小结”展示内容：单个待处理事项回到原有问答/授权卡，多个事项打开行动中心，其余状态打开工作速览。速览最多列出 3 个任务，可定位会话或进入详情；Codex 通过 `codex://threads/{id}` 精确打开对应 task，Claude / TRAE / WorkBuddy 等 hook 会话在取得实时窗口 PID 时聚焦对应窗口。历史回填、纯 watcher 或 opencode 等没有定位信息的会话不显示无效的打开按钮，任务行改为进入详情；实际定位失败时显示气泡提示。快照刷新时就地更新，8 秒无交互自动关闭。
- 拖动以屏幕坐标计算窗口位移，并在 pointerdown 同步记录窗口原点；旧的异步位置回调不能覆盖新手势。
- 右键菜单由 `shared/pet-geometry.js` 计算，在工作区安全矩形内选择扇区，按钮避开喵的实际可视矩形并保持等距。
- 工具小图标以喵的可视矩形为锚点，在左右/上下边缘自动翻转和夹紧，不使用固定的远距离 `bottom/left/right` 偏移。

## 验收

```bash
npm test
node test/state-smoke.js
node test/pet-geometry.js
node test/popup-style.js
node test/notify-policy.js
```

其中状态回归覆盖词汇单一来源、优先级、瞬态回落、睡眠判定和 class 泄漏；几何回归覆盖四边窗口、菜单避让和工具图标锚定；`notify-policy.js` 覆盖各工具 `Notification` 语义隔离、hook 噪声丢弃、`IdleNotification` 软着陆与端到端面板分流。
