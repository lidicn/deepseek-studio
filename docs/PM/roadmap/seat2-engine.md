# 席2 路线图 · 引擎层

> 建立 2026-10-17 11:24 | 制度 R1 | PM 维护，席位只改状态标记

## 长目标（一句话）

**让 WebEngine 成为宿主唯一的 transport 实现，并且它自己知道「这轮到底完没完成」**：能上报指标、能检测截断、能在连接断开后恢复，而不是靠上层的 nudge 去猜。

**完成标志**：引擎能自证每一轮的完成状态（complete / truncated / disconnected），nudgeRate 有真实数据可算，断线能重连续跑。

---

## 阶段序列（串行，做完一个立刻做下一个）

### S1 · 接口一致性 + 指标接线  [x]

- 落点：`src/host/engine/web-engine.ts`（改）+ `tests/desktop/web-engine-transport.test.ts`
- 内容：WebEngine 精确实现 ModelEngine；metrics 可选注入 + 懒创建；getMetrics()；recordToolCall 转发；8 用例
- 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts` 全绿 + `npx vitest run tests/desktop/agent-loop.test.ts tests/desktop/engine-tool-records.test.ts` 仍绿
- 结果：8/8 通过（11:19 实测文件 6282B，web-engine.ts 已有 metrics/getMetrics）

### S2 · 完成状态自证  [x]

- 目标：引擎自己给出本轮的完成判定，不再让上层猜
- 落点：`src/host/engine/model-engine.ts`（**只加可选字段**）+ `src/host/engine/web-engine.ts`（改）+ 测试追加
- 要点：
  - EngineSendResult 新增可选字段 completion，取值只能是 complete / truncated / disconnected / unknown 四个字符串字面量
  - **必须是可选字段**，老调用方零影响（agent-loop.test.ts 必须仍绿）
  - web-engine 判定依据：收到 done 帧且无 toolcall 未闭合 → complete；收到 length 停止 → truncated；socket 断开 → disconnected
  - 判定逻辑写成一个纯函数，便于单测
- 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts`，用例数 >= 14；`npx vitest run tests/desktop/agent-loop.test.ts` 仍绿
- 估时：1d
- 结果：14/14 PASS，decideCompletion 纯函数导出，completion 字段已接 send/waitForNextReply/disconnected 早返回

### S3 · nudgeRate 真实取数  [x]

- 目标：把 completion 结果喂进 harness-metrics，让 nudgeRate 有真实分子分母
- 落点：`src/host/engine/web-engine.ts`（改）+ 测试追加
- 要点：
  - 每轮结束时按 completion 上报事件（complete → toolRound 完成；truncated/disconnected → 记为需 nudge）
  - **不改 harness-metrics.ts**（它是冻结区），只用它已有的 onEvent 接口
  - 若发现 onEvent 的事件模型喂不进去，写进「跨域需求」，不要自己改
- 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts`，用例数 >= 18，其中至少 2 个用例断言 metrics.snapshot() 的 toolRounds / nudgeRounds 数字变化
- 估时：1d
- 结果：18/18 PASS，closeRoundForMetrics 在 truncated/disconnected 时喂「纠偏」status 事件，test 15/16/18 断言 nudgeRounds 变化

### S4 · 断流恢复  [x]

- 目标：socket 断开后能重连并续跑，不丢在飞的一轮
- 落点：`src/host/engine/web-engine.ts`（改）+ `tests/desktop/web-engine-reconnect.test.ts`（新建）
- 要点：
  - 断开时把在飞的请求标为 pending，重连后重新发起（幂等）
  - 重连要有上限次数与退避，不能无限重试
  - 重连后 completion 应为 disconnected 已恢复 → 重新判定为 complete/truncated
- 验收：`npx vitest run tests/desktop/web-engine-reconnect.test.ts`，用例 >= 8
- 估时：1.5d
- 结果：8/8 PASS，maxReconnectAttempts=3 + 线性退避，tryReconnect() 在轮询 dispatch 失败时触发，耗尽后 completion=disconnected

### S5 · 引擎层可观测性  [x]

- 目标：出问题时能从日志看出「哪一轮、什么 completion、耗时多少」
- 落点：`src/host/engine/web-engine.ts`（改）+ 测试追加
- 要点：
  - 每轮打一条结构化记录（round / completion / toolCalls / elapsedMs）
  - 走注入的 logger，默认 no-op，不污染测试输出
  - 不要引第三方日志库
- 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts`，用例数 >= 22
- 估时：0.5d
- 结果：22/22 PASS，logger 注入 + logRound() 输出 {round, completion, toolCalls, elapsedMs, reconnects}

### S6 · M1-2 收口报告  [x]

- 目标：把 M1-2 的「WebEngine 是 ModelEngine 的 transport」这件事写成可交付的证据
- 落点：`docs/架构文档/M1-2-WebEngine边界归位-20261017.md`（新建）
- 要点：
  - 逐方法核对表（ModelEngine 每个方法 vs WebEngine 实现）
  - 列出所有新增能力（metrics / completion / reconnect / 日志）
  - 列出老行为未变的证据（agent-loop + engine-tool-records 测试绿）
- 验收：文件存在且含逐方法核对表；贴 `git diff --stat -- src/host/engine/`
- 估时：0.5d
- 结果：已交付，2 文件 +215/-21

### S7 · 流式 delta 支持  [ ]

- 目标：send() 支持逐 token delta 回调，不再只等整轮结束
- 落点：`src/host/engine/model-engine.ts`（**只加可选方法/回调**）+ `src/host/engine/web-engine.ts`（改）+ 测试追加
- 要点：
  - ModelEngine 接口加可选 `onDelta?: (text: string) => void` 到 EngineSendResult 或 send options
  - WebEngine 在 SSE 解析时每收到一段 text 就回调 onDelta
  - 不传 onDelta 时行为完全不变
  - TaskLoop（席1）可以选择不接这个回调
- 验收：web-engine-transport 用例数 >= 26；agent-loop.test.ts 仍绿
- 估时：1d

### S8 · 请求重试与退避  [ ]

- 目标：网络抖动 / 临时 5xx 能自动重试，不直接报 disconnected
- 落点：`src/host/engine/web-engine.ts`（改）+ `tests/desktop/web-engine-retry.test.ts`（新建）
- 要点：
  - 仅对幂等的 send() 重试（不重试已发 tool call 的轮次）
  - 最多 2 次重试，指数退避（500ms / 1500ms）
  - 重试期间 completion = 'unknown'，不提前标记 truncated
  - 重试耗尽后才走 S4 的 disconnected 路径
- 验收：新测试 >= 6 用例
- 估时：1d

### S9 · 多会话隔离（per-tab session）  [ ]

- 目标：WebEngine 实例天然绑定一个页签，多页签不串数据
- 落点：`src/host/engine/web-engine.ts`（改）+ 测试追加
- 要点：
  - 每个 WebEngine 实例有独立的 pollInterval 循环、currentRecords 缓冲、metrics 实例
  - 不引入全局单例状态
  - 两个实例并行 send() 互不影响
- 验收：用例数 >= 30
- 估时：1d

### S10 · ApiEngine 最小实现  [ ]

- 目标：把现在抛 "not implemented" 的 ApiEngine 做成真实可用的 OpenAI 兼容 transport
- 落点：`src/host/engine/api-engine.ts`（新建）+ `tests/desktop/api-engine.test.ts`（新建）
- 要点：
  - 实现 ModelEngine 接口（health / send / waitForNextReply）
  - 用 fetch 调 OpenAI 兼容 /v1/chat/completions
  - completion 判定：finish_reason = 'stop' → complete；'length' → truncated；网络错 → disconnected
  - 不引第三方 SDK，只用原生 fetch
- 验收：用例 >= 8（mock fetch）
- 估时：1.5d

### S11 · 引擎层收口报告  [ ]

- 目标：把 engine 层全部能力写成可交付文档
- 落点：`docs/架构文档/Engine层收口报告-20261017.md`（新建）
- 要点：
  - ModelEngine 接口完整方法表
  - WebEngine vs ApiEngine 对比表
  - completion 四态判定逻辑
  - 贴 `git diff --stat -- src/host/engine/`
- 验收：文件存在
- 估时：0.5d

---

## 席位纪律

- 只写 `src/host/engine/**` 与 `tests/desktop/web-engine-*.test.ts`、`tests/desktop/engine-*.test.ts`
- **`model-engine.ts` 只能加可选字段，不能改已有字段语义**（席1 在 import 它）
- 不改 `harness-metrics.ts`（冻结）、不改 `agent-loop.ts`（B 线全依赖）、不改 kernel 层（席1）、不改 tools（席3）、不改 package.json
- 每阶段完成：落 `docs/PM/progress/seat2-Sx-yyyymmdd-HHmm.md`，然后回本文件把 [ ] 改 [x]
- **改完立刻做下一阶段，不要停下来等 PM**

## 跨域需求写这里（PM 会读）

（暂无）
