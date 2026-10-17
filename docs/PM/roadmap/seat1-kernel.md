# 席1 路线图 · 内核运行时

> 建立 2026-10-17 11:22 | 制度 R1 | PM 维护，席位只改状态标记

## 长目标（一句话）

**让宿主拥有一个可靠的内核循环**：吃一条用户消息，驱动引擎、回填历史、判定停止，并且能在进程重启后从快照恢复继续跑。这条循环是「编程开发 / 通用任务」能力的底座。

**完成标志**：一个 shell_exec 工具回合，全程不需要页端 nudge，一次跑完；进程中断后能从快照恢复并继续。

---

## 阶段序列（串行，做完一个立刻做下一个）

### S1 · TaskLoop 基础版  [x]

- 落点：`src/host/kernel/task-loop.ts` + `tests/desktop/kernel-task-loop.test.ts`
- 内容：createTaskLoop / TaskLoopStopReason 四态 / 单回合 run() / 历史回填 / 12 用例
- 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts` 全绿
- 结果：12/12 通过（11:19 实测文件 4721B）

### S2 · 多轮自驱  [x]

- 目标：run() 支持 maxRounds 循环。每轮重新算 stopReason，轮间不漏回填，达到上限返回 max-rounds
- 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加
- 要点：
  - 循环条件必须是「未 stop 且未达 maxRounds」
  - 每轮独立计 round 序号
  - 中途某轮 stopReason 命中就立刻退出，不跑满
  - 单轮行为必须与 S1 完全一致（老测试仍绿）
- 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts`，用例数须 >= 18，老 12 个仍绿
- 估时：0.5d

### S3 · 持久化恢复  [x]

- 目标：TaskLoop 能把 MessageHistory 的快照落盘，重启后 restore 继续跑
- 落点：`src/host/kernel/task-loop.ts`（改）+ `src/host/kernel/history-store.ts`（新建）+ 测试新建
- 要点：
  - store 接口只依赖注入的读写函数，不做真实文件 IO（便于测试）
  - snapshot 带 version，restore 版本不符必须抛错（对齐 MessageHistory 的 version:1）
  - 恢复后轮次计数要延续，不能从 0 重新算
- 验收：`npx vitest run tests/desktop/kernel-history-store.test.ts`，用例 >= 8
- 估时：1d

### S4 · 判停信号强化  [x]

- 目标：stopReason 覆盖真实场景，不再只有 timeout / no-tool-calls
- 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加
- 要点：
  - 复用 `src/shared/continuation-prompt.ts` 的 extractTaskCompleteSignal（只读引用，不改它）
  - 新增 completed：引擎回复里含 task_complete 信号
  - 新增 empty-response：content 为空且无工具调用
  - 停止优先级要写死在注释里：timeout > completed > empty-response > no-tool-calls
- 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts`，用例数须 >= 24
- 估时：0.5d

### S5 · 错误恢复路径  [x]

- 目标：引擎抛错 / 中途中断 时，历史不被写坏，且能标记中断点
- 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加
- 要点：
  - 引擎抛错时：用户消息已入历史，assistant 消息不入；抛错向上传但要带 round 号
  - 新增 stopReason 之外的 `error` 字段（不污染 stopReason 四态语义）
  - 恢复后能从最后一条 user 消息重试
- 验收：`npx vitest run tests/desktop/kernel-task-loop.test.ts`，用例数须 >= 30
- 估时：1d

### S6 · 端到端：无 nudge 完成一个工具回合  [x]

- 目标：这是 M2-3 的原始验收标准 —— 一个 shell_exec 回合全程不需要页端 nudge
- 落点：`tests/desktop/kernel-e2e-tool-round.test.ts`（新建）+ 若发现缺口回改 task-loop.ts
- 要点：
  - 用假引擎 + 假工具执行器模拟一个完整回合：用户问 → 引擎回工具调用 → 执行 → 结果回填 → 引擎给最终答案
  - 断言：全程 history 增长正确、stopReason 为 completed、无任何「等待 nudge」的中间态
  - 这个用例是 D1 的定性证据：证明自驱链路是通的
- 验收：`npx vitest run tests/desktop/kernel-e2e-tool-round.test.ts` 全绿
- 估时：1d

### S7 · TaskLoop 接真实引擎（替换占位 context）  [ ]

- 目标：把 task-loop.ts 里 `buildPrompt(history)` 的纯文本拼接换成真正的消息数组协议，直接对接 ModelEngine.send()
- 落点：`src/host/kernel/task-loop.ts`（改）+ `tests/desktop/kernel-task-loop.test.ts`（追加）
- 要点：
  - 用 MessageHistory.all() 返回的 ChatMessage[] 直接作为引擎输入
  - 不再做 role/content 字符串 join
  - 假引擎测试继续保留（假引擎收 ChatMessage[]）
- 验收：用例数 >= 36；老用例仍绿
- 估时：1d

### S8 · 工具执行桥接（TaskLoop → ToolProtocol）  [ ]

- 目标：TaskLoop 收到 toolCalls 后，不只是回填 history，真的能调用一个工具执行器并把结果回填
- 落点：`src/host/kernel/tool-bridge.ts`（新建）+ `tests/desktop/kernel-tool-bridge.test.ts`（新建）
- 要点：
  - 定义 `ToolExecutor` 接口：execute(name, args) => Promise<{ok, result?}>
  - TaskLoop 注入 ToolExecutor；不注入时行为退化为现在（只回填不执行）
  - 一轮工具调用 → 执行器返回结果 → 回填 history → 触发下一轮 send
  - 假执行器：按 name 返回固定结果，验证回填顺序
- 验收：用例 >= 12
- 估时：1.5d

### S9 · 取消与中断（abort）  [ ]

- 目标：run() 跑了一半能被取消，不留下半截历史
- 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加
- 要点：
  - run() 返回的 Promise 关联一个 AbortSignal
  - abort 后当前轮 send() 立即 reject
  - 已写入的 user/assistant 消息保留，不回滚
  - stopReason 新增 `aborted`
- 验收：用例数 >= 42
- 估时：1d

### S10 · 轮次超时（per-round timeout）  [ ]

- 目标：每一轮 engine.send() 有独立超时，不是整个 run() 一个大超时
- 落点：`src/host/kernel/task-loop.ts`（改）+ 测试追加
- 要点：
  - TaskLoopOptions 加可选 `roundTimeoutMs`，默认 120000
  - 每轮用 Promise.race 包 send()
  - 超时后 stopReason = 'timeout'，带 round 号
- 验收：用例数 >= 48
- 估时：0.5d

### S11 · 检查点（mid-round checkpoint）  [ ]

- 目标：每轮结束自动 save 快照到 history-store，崩溃重启后从最后一轮继续
- 落点：`src/host/kernel/task-loop.ts`（改）+ `src/host/kernel/history-store.ts`（接线）
- 要点：
  - run() 每轮结束调 store.save(snapshot)
  - TaskLoopOptions 加可选 store 注入；不注入时行为不变
  - 重启后 createTaskLoop 时从 store.load() 恢复 round 计数和历史
- 验收：用例数 >= 54
- 估时：1d

### S12 · 内核收口报告  [ ]

- 目标：把 kernel 层全部能力写成可交付文档
- 落点：`docs/架构文档/Kernel层收口报告-20261017.md`（新建）
- 要点：
  - MessageHistory / HistoryStore / TaskLoop / ToolBridge 四个模块的导出清单
  - 端到端数据流图：user → TaskLoop → engine.send → toolCall → ToolExecutor → 回填 → next round
  - 所有 stopReason 语义表
  - 贴 `git diff --stat -- src/host/kernel/`
- 验收：文件存在且含导出清单 + 数据流图
- 估时：0.5d

---

## 席位纪律

- 只写 `src/host/kernel/**`（新文件）与 `tests/desktop/kernel-*.test.ts`
- 不改 `model-engine.ts` / `message-history.ts` / `continuation-prompt.ts`，只 import
- 不改 `web-engine.ts`（席2 的）、不改 `tools/**`（席3 的）、不改 `package.json`
- 每阶段完成：落 `docs/PM/progress/seat1-Sx-yyyymmdd-HHmm.md`，然后回本文件把 [ ] 改 [x]
- **改完立刻做下一阶段，不要停下来等 PM**

## 跨域需求写这里（PM 会读）

（暂无）