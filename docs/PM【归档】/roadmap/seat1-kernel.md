# 席 1 路线图・内核运行时

> 建立 2026-10-17 11:22 | 制度 R1 | PM 维护，席位只改状态标记

## ⚡⚡⚡ 开工指令（14:25）⚡⚡⚡

**M3真机验收已通过。你现在一口气做完S17→S18→S19，不要做一个停一个。**

- S17: 真实工具执行桥接（2d）
- S18: continuation-prompt去续感化（0.5d）
- S19: UI集成kernel adapter（2d）

做完一个勾一个，落progress，立刻做下一个。全部做完再停。

---

## 长目标（一句话）

**让宿主拥有一个可靠的内核循环**：吃一条用户消息，驱动引擎、回填历史、判定停止，并且能在进程重启后从快照恢复继续跑。这条循环是「编程开发 / 通用任务」能力的底座。

**完成标志**：一个 shell\_exec 工具回合，全程不需要页端 nudge，一次跑完；进程中断后能从快照恢复并继续。



***

## 远期目标包（12:25 更新，PM 给方向，你自己拆阶段）

### 目标：kernel 层成为可独立运行的 agent 运行时

> 这不是一个小任务，是你接下来 1-2 天的全部工作。
>
> **你自己拆阶段、自己排顺序、自己定验收。**
>
>  我只给最终交付物：

**最终交付物**：一个调用方只需要写 5 行代码就能跑起来的 agent 运行时：



```
const runtime = createKernelRuntime({
  engine: myEngine,        // 实现 ModelEngine 接口
  store: myStore,          // 实现 HistoryStore 接口
});

await runtime.run('帮我查一下今天的天气');
// → 自动多轮、自动调工具、自动判停、崩溃能恢复、多任务并行
```

**这个运行时必须具备的能力**（你自己拆成阶段实现）：



1. 多轮自驱（已有）

2. 轮次超时（每轮独立超时）

3. 崩溃恢复（每轮结束存快照，重启后从最后一轮继续）

4. 多会话并行（多个 session 互不干扰）

5. 流式 delta 回调（onDelta 逐 token 推送）

6. abort 中断（随时能停）

7. 结构化事件输出（每轮结束输出 round-complete 事件）

8. 工具执行桥接（现在用假执行器，但接口要留好）

**约束**：



* 只写 `src/host/kernel/**` 和 `tests/desktop/kernel-*.test.ts`

* 不碰真实网页、不碰跨域文件

* 每完成一个能力，落 progress 文件，然后继续下一个

* **不要停下来等 PM。拆完阶段就开干，做完一个接一个。**

* 如果你觉得某个能力需要别的席位配合（比如工具桥接需要真实工具注册表），写在 progress 里标注 "跨域阻塞"，先做别的，不要停



***

## 已完成阶段（参考，不用重做）

S1-S9 已完成：TaskLoop 基础、多轮自驱、持久化、判停强化、错误恢复、端到端、接真实引擎、工具桥接假执行器、abort。



***

## 阶段序列（历史记录）

### S1・TaskLoop 基础版  \[x]



* 落点：`src/host/kernel/task-loop.ts` + `tests/desktop/kernel-task-loop.test.ts`

* 内容：createTaskLoop / TaskLoopStopReason 四态 / 单回合 run () / 历史回填 / 12 用例

* 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts` 全绿

* 结果：12/12 通过（11:19 实测文件 4721B）

### S2・多轮自驱  \[x]



* 目标：run () 支持 maxRounds 循环。每轮重新算 stopReason，轮间不漏回填，达到上限返回 max-rounds

* 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加

* 要点：


  * 循环条件必须是「未 stop 且未达 maxRounds」

  * 每轮独立计 round 序号

  * 中途某轮 stopReason 命中就立刻退出，不跑满

  * 单轮行为必须与 S1 完全一致（老测试仍绿）

* 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts`，用例数须 >= 18，老 12 个仍绿

* 估时：0.5d

### S3・持久化恢复  \[x]



* 目标：TaskLoop 能把 MessageHistory 的快照落盘，重启后 restore 继续跑

* 落点：`src/host/kernel/task-loop.ts`（改）+ `src/host/kernel/history-store.ts`（新建）+ 测试新建

* 要点：


  * store 接口只依赖注入的读写函数，不做真实文件 IO（便于测试）

  * snapshot 带 version，restore 版本不符必须抛错（对齐 MessageHistory 的 version:1）

  * 恢复后轮次计数要延续，不能从 0 重新算

* 验收：`npx vitest run tests/desktop/kernel-history-store.test.ts`，用例 >= 8

* 估时：1d

### S4・判停信号强化  \[x]



* 目标：stopReason 覆盖真实场景，不再只有 timeout /no-tool-calls

* 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加

* 要点：


  * 复用 `src/shared/continuation-prompt.ts` 的 extractTaskCompleteSignal（只读引用，不改它）

  * 新增 completed：引擎回复里含 task\_complete 信号

  * 新增 empty-response：content 为空且无工具调用

  * 停止优先级要写死在注释里：timeout > completed > empty-response > no-tool-calls

* 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts`，用例数须 >= 24

* 估时：0.5d

### S5・错误恢复路径  \[x]



* 目标：引擎抛错 / 中途中断 时，历史不被写坏，且能标记中断点

* 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加

* 要点：


  * 引擎抛错时：用户消息已入历史，assistant 消息不入；抛错向上传但要带 round 号

  * 新增 stopReason 之外的 `error` 字段（不污染 stopReason 四态语义）

  * 恢复后能从最后一条 user 消息重试

* 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts`，用例数须 >= 30

* 估时：1d

### S6・端到端：无 nudge 完成一个工具回合  \[x]



* 目标：这是 M2-3 的原始验收标准 —— 一个 shell\_exec 回合全程不需要页端 nudge

* 落点：`tests/desktop/kernel-e2e-tool-round.test.ts`（新建）+ 若发现缺口回改 task-loop.ts

* 要点：


  * 用假引擎 + 假工具执行器模拟一个完整回合：用户问 → 引擎回工具调用 → 执行 → 结果回填 → 引擎给最终答案

  * 断言：全程 history 增长正确、stopReason 为 completed、无任何「等待 nudge」的中间态

  * 这个用例是 D1 的定性证据：证明自驱链路是通的

* 验收：`npx vitest run tests/desktop/kernel-e2e-tool-round.test.ts` 全绿

* 估时：1d

### S7・TaskLoop 接真实引擎（替换占位 context）  \[x]



* 目标：把 task-loop.ts 里 `buildPrompt(history)` 的纯文本拼接换成真正的消息数组协议，直接对接 ModelEngine.send ()

* 落点：`src/host/kernel/task-loop.ts`（改）+ `tests/desktop/kernel-task-loop.test.ts`（追加）

* 要点：


  * 用 MessageHistory.all () 返回的 ChatMessage \[] 直接作为引擎输入

  * 不再做 role/content 字符串 join

  * 假引擎测试继续保留（假引擎收 ChatMessage \[]）

* 验收：用例数 >= 36；老用例仍绿

* 估时：1d

### S8・工具执行桥接（TaskLoop → ToolProtocol）  \[x]



* 目标：TaskLoop 收到 toolCalls 后，不只是回填 history，真的能调用一个工具执行器并把结果回填

* 落点：`src/host/kernel/tool-bridge.ts`（新建）+ `tests/desktop/kernel-tool-bridge.test.ts`（新建）

* 要点：


  * 定义 `ToolExecutor` 接口：execute (name, args) => Promise<{ok, result?}>

  * TaskLoop 注入 ToolExecutor；不注入时行为退化为现在（只回填不执行）

  * 一轮工具调用 → 执行器返回结果 → 回填 history → 触发下一轮 send

  * 假执行器：按 name 返回固定结果，验证回填顺序

* 验收：用例 >= 12

* 估时：1.5d

### S9・取消与中断（abort）  \[x]



* 目标：run () 跑了一半能被取消，不留下半截历史

* 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加

* 要点：


  * run () 返回的 Promise 关联一个 AbortSignal

  * abort 后当前轮 send () 立即 reject

  * 已写入的 user/assistant 消息保留，不回滚

  * stopReason 新增 `aborted`

* 验收：用例数 >= 42

* 估时：1d

### S10・轮次超时（per-round timeout）  \[x]



* 目标：每一轮 engine.send () 有独立超时，不是整个 run () 一个大超时

* 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加

* 要点：


  * TaskLoopOptions 加可选 `roundTimeoutMs`，默认 120000

  * 每轮用 Promise.race 包 send ()

  * 超时后 stopReason = 'timeout'，带 round 号

* 验收：用例数 >= 48

* 估时：0.5d

### S11・检查点（mid-round checkpoint）  \[x]



* 目标：每轮结束自动 save 快照到 history-store，崩溃重启后从最后一轮继续

* 落点：`src/host/kernel/task-loop.ts`（改）+ `src/host/kernel/history-store.ts`（接线）

* 要点：


  * run () 每轮结束调 store.save (snapshot)

  * TaskLoopOptions 加可选 store 注入；不注入时行为不变

  * 重启后 createTaskLoop 时从 store.load () 恢复 round 计数和历史

* 验收：用例数 >= 54

* 估时：1d

### S12・内核收口报告  \[x]



* 目标：把 kernel 层全部能力写成可交付文档

* 落点：`docs/架构文档/Kernel层收口报告-20261017.md`（新建）

* 要点：


  * MessageHistory / HistoryStore / TaskLoop / ToolBridge 四个模块的导出清单

  * 端到端数据流图：user → TaskLoop → engine.send → toolCall → ToolExecutor → 回填 → next round

  * 所有 stopReason 语义表

  * 贴 `git diff --stat -- src/host/kernel/`

* 验收：文件存在且含导出清单 + 数据流图

* 估时：0.5d

### S13・真实工具执行桥接  \[ ]（阻塞：tool-registry 不存在，跳过做 S14）



* **⚠️ 阻塞，不要停下来。先做 S14，里程碑时再回来。**

* 阻塞原因：`src/host/tool-registry` 模块不存在，席 1 不知道接什么接口。真实工具分发由 PM 在里程碑前统一提供 stub。

* 未来做时参考：ToolExecutor 接宿主真实工具注册表，危险工具走 consent 闸门

* 未来估时：2d

### S14・多会话并发  [x]



* 目标：TaskLoop 实例天然支持多会话并行，互不串历史

* 落点：`src/host/kernel/session-manager.ts`（新建）+ `tests/desktop/kernel-session-manager.test.ts`（新建）

* 具体做法：

1. 新建 `session-manager.ts`，导出 `createSessionManager(deps)`

2. deps 里传入 `createTaskLoop` 和 `createMessageHistory` 工厂函数（你自己 S1-S6 写的）

3. SessionManager 维护 `Map<sessionId, { history, taskLoop, abort }>`

4. `start(sessionId, userText)`：如果 session 不存在就新建，存在就复用

5. `destroy(sessionId)`：abort 未完成的 run，从 Map 删

6. `list()`：返回所有活跃 sessionId

7. 并发上限默认 4，超过报错

* 验收：用例 >= 10（两个 session 并行 run 不串历史）

* 估时：1d

### S15・流式 delta 转发到 UI（stub 版）  [x]



* 目标：onDelta 回调机制就位，现在用 stub 引擎触发，未来接真实流式

* 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加

* 具体做法：

1. TaskLoopOptions 加可选 `onDelta?: (text: string) => void`

2. 引擎 send () 期间如果引擎回调了 onDelta，就转发；不注入时行为不变

3. 写一个 fakeEngine，在 send () 期间手动调 onDelta ('hello') /onDelta (' world')

4. 断言：收到两次 onDelta，顺序正确，不缓存到整轮结束

* 验收：用例 >= 54（加 3 个新用例）

* 估时：0.5d

### S16・内核层收口：不接旧 agent-loop，只写适配接口  [x]



* **⚠️ 阻塞：不改 agent-loop.ts（跨域）。里程碑时 PM 统一接线。**

* 现在做什么：把 TaskLoop 的输入输出接口写成最薄的 adapter 形态，方便未来接

* 落点：`src/host/kernel/adapter.ts`（新建）+ 测试

* 具体做法：

1. 新建 adapter.ts，导出 `runTaskStandalone(userText, engine, options)` 一个函数

2. 这个函数内部就是 createMessageHistory + createTaskLoop + store

3. 对外只暴露：输入 userText + 一个 ModelEngine stub，输出 stopReason + rounds

4. 不 import bot/\*\*、不 import agent-loop.ts

* 验收：用例 >= 6

* 估时：0.5d



***

## 里程碑：M3 真机验收（PM 统一安排）

> 三席代码全部写完后，PM 会通知用户启动 Electron + 登录 DeepSeek，一次性跑真机验收。
> 验收项：nudgeRate（席 3 S13）、真实流式 delta（席 2 S13）、真实工具执行（席 1 S13）。
> 里程碑前三席不碰真机、不等其他席位，用 mock/stub 把所有能跑的跑完。



***

## 后续阶段（等真机验收后开始）

### S17 · 真实工具执行桥接（里程碑后）  [x]

- 前置：席5 V4 真机验证通过
- 目标：ToolExecutor 接宿主真实工具注册表（shell.exec / file.read / file.write）
- 落点：`src/host/kernel/tool-bridge.ts`（改）+ 测试追加
- 估时：2d

### S18 · continuation-prompt 去续感化  [x]

- 前置：席2 删完 agent-loop nudge 逻辑
- 目标：kernel 层不再依赖续逼提示词，只保留判停信号提取
- 落点：`src/host/kernel/task-loop.ts`（改引用）+ 测试
- 估时：0.5d

### S19 · UI 集成 kernel adapter  [x]

- 目标：把 kernel 接到现有 bot UI，用户看到流式输出
- 落点：`src/host/kernel/adapter.ts`（改）+ 测试
- 估时：2d

***

## 席位纪律



* 只写 `src/host/kernel/**`（新文件）与 `tests/desktop/kernel-*.test.ts`

* 不改 `model-engine.ts` / `message-history.ts` / `continuation-prompt.ts`，只 import

* 不改 `web-engine.ts`（席 2 的）、不改 `tools/**`（席 3 的）、不改 `package.json`

* 每阶段完成：落 `docs/PM/progress/seat1-Sx-yyyymmdd-HHmm.md`，然后回本文件把 \[] 改 \[x]

* **改完立刻做下一阶段，不要停下来等 PM**

## 跨域需求写这里（PM 会读）

（暂无）