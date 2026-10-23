# dsh-interrupted-resume

> DSH 重启后，自动给「被强制中断」的会话发一条安全的继续指令。

## 解决什么问题

dsh 被重启 / 崩溃 / 强杀时，正在跑的 turn 会被中断。重启后那个会话就停在半路，
你得手动进去说一句「继续」——而且因为不知道中断前做到哪一步，很容易重复执行副作用操作。

本插件在启动后自动识别这些会话，注入一条**带状态核对要求**的继续消息。

## 判定条件（四层，全满足才续）

| # | 条件 | 理由 |
|---|---|---|
| 1 | 最近 **12 小时**内有过人类提示词 | 避免唤醒陈年会话 |
| 2 | 最后一条 `turn/end.reason.kind === "interrupted"` | **只认崩溃中断**；`aborted` 是用户主动停止，绝不续 |
| 3 | 距中断 **≥ 30 秒**（`quietMs`） | 避开用户重启后立刻打开的会话，防 `writer-held` 竞争 |
| 4 | 本会话自动续 **< 2 次** | 防模型反复中断时 token 空转 |

> ⚠️ 条件 3 **不是放弃**，而是延后：到点后由调度器重排再扫一轮。

## 注入的消息不是裸「继续」

重启可能发生在副作用操作中途，所以注入文本强制要求先核对状态：

```
[自动续跑 · 由 dsh 重启触发]

上一轮（turn N）因 dsh 进程重启被强制中断，没有正常结束。

请按以下顺序继续：
1. 先核对当前实际状态（工作区文件、git 状态、后台任务/子进程、已执行的外部操作），确认中断前哪些步骤真的完成了；
2. 从中断处继续推进原任务；
3. 不要去重做可能已产生副作用的操作（写文件、提交、推送、删除、发布、部署等）——若无法确认其是否已执行，先核实再决定；
4. 如果核对后仍然无法判断状态，停止操作并向我报告现状与疑点。
```

## 安装

```bash
dsh plugin --profile web add dsh-interrupted-resume   # 或本地路径
```

## 配置

```js
{
  promptWindowMs: 12 * 60 * 60 * 1000,  // 候选窗口
  startupDelayMs: 5_000,               // 启动后延迟多久开始扫
  quietMs: 30 * 1000,                  // 中断后静置多久才续
  maxAttemptsPerSession: 2,            // 每会话最多自动续几次
  enabled: true,
  dryRun: false,                       // true = 只记日志不注入
}
```

## 状态与可观测性

所有痕迹写在自己的状态目录（跟随 `DSH_HOME`）：

```
$DSH_HOME/interrupted-resume/
├── resume.log    # 每轮扫描/判定/注入的完整链路
└── ledger.json   # 每会话的续跑次数与最后处理的 turn
```

典型日志：

```
defer session-xxx: interrupted 12s ago (< quietMs 30s), will retry in 18s
scan done: 1 sessions, 1 in window, 0 resumed, 1 deferred
resumed session-xxx: turn 1, attempt 1
scan done: 1 sessions, 1 in window, 1 resumed
```

## 实现要点

- **不能监听 `session/event`**：`interrupted` 是冷读时由 session repair **合成**的，
  agent loop 从不实时发出它。所以必须启动后主动 `list()` + `inspect()`。
- **`ctx.get("sessionController")` 每次现取**，不缓存：cordis 服务激活时机不保证早于插件 `apply()`。
- **requestId 可推导**（`continue-after-interrupted-<sessionId>-<turn>`）：
  同会话同轮永远得到同一 id，借用 `session/prompt` 自身的幂等检查挡重复注入。
- **先写 ledger 再注入**：即使注入途中进程再次崩溃，也不会无限重试。

## 已知限制

- 每个进程生命周期内只处理「启动时能看到的」中断；插件中途热加载不追溯。
- 如果模型在续跑后再次中断，第 2 次仍会续，第 3 次起放弃（`maxAttemptsPerSession`）。
- `lastPromptAt` 语义是**最后一条人类提示词时间**，不是最后活动时间；
  长期运行但很久没输入的任务可能落在 12h 窗口外。

## License

MIT
