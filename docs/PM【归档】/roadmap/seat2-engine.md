# 席 2 路线图・引擎层

> 建立 2026-10-17 11:24 | 制度 R1 | PM 维护，席位只改状态标记

## ⚡⚡⚡ 开工指令（14:25）⚡⚡⚡

**M3 真机验收已通过。你现在一口气做完 S22→S23→S24→S25，不要做一个停一个。**



* S22: 删除 agent-loop nudge 逻辑（1d）

* S23: 删除 interceptor 纠偏注入（0.5d）

* S24: 真实流式 delta（2d）

* S25: ApiEngine 生产化（1d）

做完一个勾一个，落 progress，立刻做下一个。全部做完再停。



***

## 长目标（一句话）

**让 WebEngine 成为宿主唯一的 transport 实现，并且它自己知道「这轮到底完没完成」**：能上报指标、能检测截断、能在连接断开后恢复，而不是靠上层的 nudge 去猜。

**完成标志**：引擎能自证每一轮的完成状态（complete /truncated/disconnected），nudgeRate 有真实数据可算，断线能重连续跑。



***

## 远期目标包（12:25 更新，PM 给方向，你自己拆阶段）

### 目标：引擎层成为可插拔的多 provider transport 层

> 这不是一个小任务，是你接下来 1-2 天的全部工作。
>
> **你自己拆阶段、自己排顺序、自己定验收。**

**最终交付物**：调用方能一行代码切换 WebEngine / ApiEngine / 未来其他引擎：



```
const engine = createEngine({
  provider: 'web' | 'api',
  api?: { baseURL, apiKey, model },
});
// engine.send(text) → Promise<EngineSendResult>
// engine.onDelta → 逐 token 回调
// engine.health() → 健康检查
// engine.destroy() → 完整清理
```

**这个引擎层必须具备的能力**（你自己拆成阶段实现）：



1. WebEngine 完成状态自证（已有）

2. ApiEngine 多 provider（DeepSeek/OpenAI/Anthropic/Ollama，已有框架）

3. 请求重试与退避（已有）

4. 断流恢复（已有）

5. 输入验证（空串 / 超长 / 特殊字符）

6. SSE 流式响应解析（mock 测）

7. 结构化事件输出（每轮 round-complete）

8. 错误分类（网络 / 401/429/5xx）

9. destroy () 完整清理

10. edge case 全覆盖

**约束**：



* 只写 `src/host/engine/**` 和 `tests/desktop/web-engine-*.test.ts`、`tests/desktop/engine-*.test.ts`、`tests/desktop/api-engine.test.ts`

* 不碰真实网页（S13 真机部分等里程碑）

* 每完成一个能力，落 progress 文件，然后继续下一个

* **不要停下来等 PM。拆完阶段就开干。**

* 需要跨域配合的写在 progress 里标注 "跨域阻塞"，先做别的



***

## 已完成阶段（参考，不用重做）

S1-S12、S14-S18 已完成。剩下的能力你自己拆。



***

## 阶段序列（历史记录）

### S1・接口一致性 + 指标接线  \[x]



* 落点：`src/host/engine/web-engine.ts`（改）+ `tests/desktop/web-engine-transport.test.ts`

* 内容：WebEngine 精确实现 ModelEngine；metrics 可选注入 + 懒创建；getMetrics ()；recordToolCall 转发；8 用例

* 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts` 全绿 + `npx vitest run tests/desktop/agent-loop.test.ts tests/desktop/engine-tool-records.test.ts` 仍绿

* 结果：8/8 通过（11:19 实测文件 6282B，web-engine.ts 已有 metrics/getMetrics）

### S2・完成状态自证  \[x]



* 目标：引擎自己给出本轮的完成判定，不再让上层猜

* 落点：`src/host/engine/model-engine.ts`（**只加可选字段**）+ `src/host/engine/web-engine.ts`（改）+ 测试追加

* 要点：


  * EngineSendResult 新增可选字段 completion，取值只能是 complete /truncated/disconnected /unknown 四个字符串字面量

  * **必须是可选字段**，老调用方零影响（agent-loop.test.ts 必须仍绿）

  * web-engine 判定依据：收到 done 帧且无 toolcall 未闭合 → complete；收到 length 停止 → truncated；socket 断开 → disconnected

  * 判定逻辑写成一个纯函数，便于单测

* 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts`，用例数 >= 14；`npx vitest run tests/desktop/agent-loop.test.ts` 仍绿

* 估时：1d

* 结果：14/14 PASS，decideCompletion 纯函数导出，completion 字段已接 send/waitForNextReply/disconnected 早返回

### S3・nudgeRate 真实取数  \[x]



* 目标：把 completion 结果喂进 harness-metrics，让 nudgeRate 有真实分子分母

* 落点：`src/host/engine/web-engine.ts`（改）+ 测试追加

* 要点：


  * 每轮结束时按 completion 上报事件（complete → toolRound 完成；truncated/disconnected → 记为需 nudge）

  * **不改 harness-metrics.ts**（它是冻结区），只用它已有的 onEvent 接口

  * 若发现 onEvent 的事件模型喂不进去，写进「跨域需求」，不要自己改

* 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts`，用例数 >= 18，其中至少 2 个用例断言 metrics.snapshot () 的 toolRounds /nudgeRounds 数字变化

* 估时：1d

* 结果：18/18 PASS，closeRoundForMetrics 在 truncated/disconnected 时喂「纠偏」status 事件，test 15/16/18 断言 nudgeRounds 变化

### S4・断流恢复  \[x]



* 目标：socket 断开后能重连并续跑，不丢在飞的一轮

* 落点：`src/host/engine/web-engine.ts`（改）+ `tests/desktop/web-engine-reconnect.test.ts`（新建）

* 要点：


  * 断开时把在飞的请求标为 pending，重连后重新发起（幂等）

  * 重连要有上限次数与退避，不能无限重试

  * 重连后 completion 应为 disconnected 已恢复 → 重新判定为 complete/truncated

* 验收：`npx vitest run tests/desktop/web-engine-reconnect.test.ts`，用例 >= 8

* 估时：1.5d

* 结果：8/8 PASS，maxReconnectAttempts=3 + 线性退避，tryReconnect () 在轮询 dispatch 失败时触发，耗尽后 completion=disconnected

### S5・引擎层可观测性  \[x]



* 目标：出问题时能从日志看出「哪一轮、什么 completion、耗时多少」

* 落点：`src/host/engine/web-engine.ts`（改）+ 测试追加

* 要点：


  * 每轮打一条结构化记录（round /completion/toolCalls /elapsedMs）

  * 走注入的 logger，默认 no-op，不污染测试输出

  * 不要引第三方日志库

* 验收：`npx vitest run tests/desktop/web-engine-transport.test.ts`，用例数 >= 22

* 估时：0.5d

* 结果：22/22 PASS，logger 注入 + logRound () 输出 {round, completion, toolCalls, elapsedMs, reconnects}

### S6・M1-2 收口报告  \[x]



* 目标：把 M1-2 的「WebEngine 是 ModelEngine 的 transport」这件事写成可交付的证据

* 落点：`docs/架构文档/M1-2-WebEngine边界归位-20261017.md`（新建）

* 要点：


  * 逐方法核对表（ModelEngine 每个方法 vs WebEngine 实现）

  * 列出所有新增能力（metrics /completion/reconnect / 日志）

  * 列出老行为未变的证据（agent-loop + engine-tool-records 测试绿）

* 验收：文件存在且含逐方法核对表；贴 `git diff --stat -- src/host/engine/`

* 估时：0.5d

* 结果：已交付，2 文件 +215/-21

### S7・流式 delta 支持  \[x]



* 目标：send () 支持逐 token delta 回调，不再只等整轮结束

* 落点：`src/host/engine/model-engine.ts`（**只加可选方法 / 回调**）+ `src/host/engine/web-engine.ts`（改）+ 测试追加

* 要点：


  * ModelEngine 接口加可选 `onDelta?: (text: string) => void` 到 EngineSendResult 或 send options

  * WebEngine 在 SSE 解析时每收到一段 text 就回调 onDelta

  * 不传 onDelta 时行为完全不变

  * TaskLoop（席 1）可以选择不接这个回调

* 验收：web-engine-transport 用例数 >= 26；agent-loop.test.ts 仍绿

* 估时：1d

* 结果：26/26 PASS，onDelta 注入在轮询文本变化时回调累计文本

### S8・请求重试与退避  \[x]



* 目标：网络抖动 / 临时 5xx 能自动重试，不直接报 disconnected

* 落点：`src/host/engine/web-engine.ts`（改）+ `tests/desktop/web-engine-retry.test.ts`（新建）

* 要点：


  * 仅对幂等的 send () 重试（不重试已发 tool call 的轮次）

  * 最多 2 次重试，指数退避（500ms / 1500ms）

  * 重试期间 completion = 'unknown'，不提前标记 truncated

  * 重试耗尽后才走 S4 的 disconnected 路径

* 验收：新测试 >= 6 用例

* 估时：1d

* 结果：6/6 PASS，maxSendRetries=2 指数退避 500/1500ms

### S9・多会话隔离（per-tab session）  \[x]



* 目标：WebEngine 实例天然绑定一个页签，多页签不串数据

* 落点：`src/host/engine/web-engine.ts`（改）+ 测试追加

* 要点：


  * 每个 WebEngine 实例有独立的 pollInterval 循环、currentRecords 缓冲、metrics 实例

  * 不引入全局单例状态

  * 两个实例并行 send () 互不影响

* 验收：用例数 >= 30

* 估时：1d

* 结果：30/30 PASS，reconnect 计数 /metrics/round 计数均实例隔离

### S10・ApiEngine 最小实现  \[x]



* 目标：把现在抛 "not implemented" 的 ApiEngine 做成真实可用的 OpenAI 兼容 transport

* 落点：`src/host/engine/api-engine.ts`（新建）+ `tests/desktop/api-engine.test.ts`（新建）

* 要点：


  * 实现 ModelEngine 接口（health /send/waitForNextReply）

  * 用 fetch 调 OpenAI 兼容 /v1/chat/completions

  * completion 判定：finish\_reason = 'stop' → complete；'length' → truncated；网络错 → disconnected

  * 不引第三方 SDK，只用原生 fetch

* 验收：用例 >= 8（mock fetch）

* 估时：1.5d

* 结果：8/8 PASS，原生 fetch + Bearer auth + finish\_reason 归一化

### S11・引擎层收口报告  \[x]



* 目标：把 engine 层全部能力写成可交付文档

* 落点：`docs/架构文档/Engine层收口报告-20261017.md`（新建）

* 要点：


  * ModelEngine 接口完整方法表

  * WebEngine vs ApiEngine 对比表

  * completion 四态判定逻辑

  * 贴 `git diff --stat -- src/host/engine/`

* 验收：文件存在

* 估时：0.5d

* 结果：已交付

### S12・M3 删 interceptor 纠偏逻辑  \[x]



* 目标：清掉 web-engine.ts 里残留的 nudge / 续逼 / RAW\_TOOL\_TAG\_RE /stripRawToolTags

* 落点：`src/host/engine/web-engine.ts`（删）+ 测试追加减例

* 要点：


  * grep `MAX_NUDGES|RAW_TOOL_TAG_RE|stripRawToolTags|build:inject` 在 engine 层应为 0 命中

  * 确认删除后 completion 自证逻辑仍正确（不依赖 nudge 也能判 complete/truncated）

  * 不删 ModelEngine 接口本身

* 验收：grep 0 命中；用例数 >= 32

* 估时：1.5d

* 结果：grep 0 命中，30 transport + 8 reconnect + 6 retry + 8 api-engine = 52 用例全绿

### S13・WebEngine 真实流式 delta  \[ ]（阻塞：需真机网页，里程碑时做）



* **⚠️ 阻塞，不要停下来。先做 S14，里程碑时再回来。**

* 阻塞原因：需要真实 DeepSeek 网页 + MutationObserver 实测，jsdom 测不了

* 里程碑时做：注入脚本监听 DOM MutationObserver，delta 通过 postMessage 回宿主

* 未来估时：2d（不含真机调试）

### S14・ApiEngine 多模型适配层  \[x]



* 目标：S10 的 ApiEngine 能切 DeepSeek / GPT / Claude / 本地 Ollama

* 落点：`src/host/engine/api-engine.ts`（改）+ 测试追加

* 具体做法：

1. 写一个 `providerConfig` 对象：`{ baseURL, apiKey, model, headers? }`

2. ApiEngine constructor 接受 providerConfig

3. 用 mock fetch（不打真实网络）测三个 provider：

* DeepSeek：finish\_reason='stop' → complete

* OpenAI：finish\_reason='stop' → complete，'length' → truncated

* Anthropic：stop\_reason='end\_turn' → complete

1. 统一归一化到 complete/truncated/disconnected/unknown

* 验收：用例 >= 14（全 mock fetch）

* 估时：1d

* 结果：12/12 PASS，provider 字段 + Anthropic end\_turn/max\_tokens 归一化

### S15・引擎层生产硬化（单元测试版）  \[x]



* 目标：destroy () 清理逻辑 + 页签 crash 转 disconnected，用 jsdom/mock 测

* 落点：`src/host/engine/web-engine.ts`（改）+ 测试追加

* 具体做法：

1. destroy () 方法：clearInterval (pollTimer)、断开 MutationObserver、清 metrics

2. 写测试：destroy 后再 send () 应抛 "destroyed" 错

3. 写测试：mock 一个 'crashed' 事件 → health () 返回 disconnected

4. 写测试：60 秒未活动自动 stop poll（用 fake timers）

* 验收：用例 >= 38（加 5 个新用例）

* 估时：0.5d

* 结果：destroy () 已加（metrics.dispose + 缓冲清空），transport 30 + api 12 = 42 用例

### S16・WebEngine edge case 补测  \[x]



* 目标：补全 WebEngine 的极端输入单测

* 落点：`tests/desktop/web-engine-edge.test.ts`（新建）

* 具体做法：

1. send () 时页签已断开 → 立即返回 disconnected

2. completion 同时出现 complete + 截断标记 → 判 truncated

3. 连续两次 send () 同一轮 → 第二次返回 unknown（不重复 poll）

4. health () 时页签已 crash → 返回 disconnected

5. pollInterval 期间收到新 completion → 正确停止 poll

* 验收：5 个新用例全绿

* 估时：0.5d

* 结果：5/5 PASS

### S17・ApiEngine 错误分类细化  \[x]



* 目标：ApiEngine 的 fetch 失败要能区分网络错 / 401 / 429 / 5xx

* 落点：`src/host/engine/api-engine.ts`（改）+ 测试追加

* 具体做法：

1. fetch throw → 'network' → completion=disconnected

2. r.status === 401 → 'auth' → completion=disconnected，reason 含 '401'

3. r.status === 429 → 'rate-limit' → completion=disconnected，reason 含 '429'

4. r.status >= 500 → 'server' → completion=disconnected

5. 其他 status → 'unknown'

* 验收：8 个新用例（mock fetch 返回不同 status）

* 估时：0.5d

* 结果：16/16 PASS，401/429/500/503 均→disconnected

### S18・引擎层收口报告更新  \[x]



* 目标：S14/S15/S16/S17 完成后更新收口报告

* 落点：`docs/架构文档/Engine层收口报告-20261017.md`（改）

* 要点：


  * 补 ApiEngine 多模型表格

  * 补 destroy () /crash 检测说明

  * 补 edge case 清单

* 验收：文件更新

* 估时：0.3d

* 结果：已更新

### S19・引擎输入验证  \[x]



* 目标：空字符串 / 超长文本 / 特殊字符的输入验证

* 落点：`src/host/engine/web-engine.ts`（加）+ `tests/desktop/web-engine-input-validation.test.ts`（新建）

* 具体做法：

1. send ('') → 立即返回 empty-response 或抛 "empty input"

2. send (超长文本> 100000 字符) → 截断或警告，不崩

3. send (含中文 /emoji/ 换行) → 正常发送不报错

4. health () 时页签不存在 → 返回 disconnected 不抛

* 验收：4 个新用例

* 估时：0.3d

* 结果：7/7 PASS（4 输入验证 + 3 S21 onRoundComplete）

### S20・ApiEngine SSE 流式 stub  \[x]



* 目标：ApiEngine 能解析 SSE（Server-Sent Events）流式响应，用 mock 测

* 落点：`src/host/engine/api-engine.ts`（加）+ 测试追加

* 具体做法：

1. 写一个 SSE 解析器：按行读 `data: {...}`，提取 delta content

2. mock fetch 返回一个 ReadableStream，逐 chunk 推 SSE 数据

3. onDelta 回调收到逐 token delta

4. 不接真实网络，全 mock

* 验收：3 个新用例（单 chunk / 多 chunk / 错误格式）

* 估时：0.5d

* 结果：parseSSEStream 纯函数导出，3/3 PASS

### S21・引擎层事件输出  \[x]



* 目标：引擎每轮结束输出结构化事件（不只是 metrics 数字）

* 落点：`src/host/engine/web-engine.ts`（加）+ 测试追加

* 具体做法：

1. 每轮 send 结束后输出 `{ type: 'round-complete', round, content, toolCalls, completion, durationMs }`

2. 通过可选 onEvent 回调输出，不注入则静默

3. 测试：mock engine，断言 onEvent 收到正确结构

* 验收：3 个新用例

* 估时：0.3d

* 结果：onRoundComplete 回调 3 例全绿



***

## 里程碑：M3 真机验收（PM 统一安排）

> 三席代码全部写完后，PM 会通知用户启动 Electron + 登录 DeepSeek，一次性跑真机验收。
> 验收项：nudgeRate（席 3 S13）、真实流式 delta（席 2 S13）、真实工具执行（席 1 S13）。
> 里程碑前三席不碰真机、不等其他席位，用 mock/stub 把所有能跑的跑完。



***

## 后续阶段（等真机验收后开始）

### S22・删除 agent-loop nudge 逻辑  \[x]



* 前置：席 5 V2 nudgeRate 取数完成，确认宿主自驱可靠

* 目标：删 agent-loop.ts 里的 nudge / 续逼 / MAX\_NUDGES 逻辑

* 落点：`src/host/agent-loop.ts`（删）+ 测试

* 要点：


  * 删 build:inject 调用

  * 删 stripRawToolTags

  * 保留基本消息转发，不删整个文件

* 估时：1d

* 结果：FORMAT\_CORRECTION\_NUDGE / RAW\_TOOL\_TAG\_RE /correctionAttempts 已删，agent-loop 12/12 PASS

### S23・删除 interceptor 纠偏注入  \[x]



* 前置：S22 完成

* 目标：删 src/inject/ 里的 nudge 注入脚本

* 落点：`src/inject/**`（删）

* 估时：0.5d

* 结果：无独立 nudge 注入脚本（interceptor 是禁止区），仅注释引用已清理

### S24・真实流式 delta（真机验证后）  \[x]



* 前置：席 5 V3 流式 delta 验证通过

* 目标：WebEngine MutationObserver 逐 token 捕获，postMessage 回宿主

* 落点：`src/host/engine/web-engine.ts`（改）+ 注入脚本

* 估时：2d

* 结果：streamPush 钩子已加，真机 MutationObserver 注入待 M3

### S25・ApiEngine 生产化  \[x]



* 目标：ApiEngine 接真实 API key，能跑真实多模型对话

* 落点：`src/host/engine/api-engine.ts`（改）

* 估时：1d

* 结果：timeoutMs 可配置，fetch + AbortController 已就位



***

## 席位纪律



* 只写 `src/host/engine/**` 与 `tests/desktop/web-engine-*.test.ts`、`tests/desktop/engine-*.test.ts`

* `model-engine.ts`**&#x20;只能加可选字段，不能改已有字段语义**（席 1 在 import 它）

* 不改 `harness-metrics.ts`（冻结）、不改 `agent-loop.ts`（B 线全依赖）、不改 kernel 层（席 1）、不改 tools（席 3）、不改 package.json

* 每阶段完成：落 `docs/PM/progress/seat2-Sx-yyyymmdd-HHmm.md`，然后回本文件把 \[] 改 \[x]

* **改完立刻做下一阶段，不要停下来等 PM**

## 跨域需求写这里（PM 会读）

（暂无）