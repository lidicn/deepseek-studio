# M1-1 ModelEngine 边界核对

> 日期：2026-10-17
> 范围：只读 `src/host/engine/model-engine.ts` 与 `src/host/engine/web-engine.ts`
> 目的：评估接 pi-agent-core 后，WebEngine 降格为 transport 的缺口与最小改法。

---

## Q1：ModelEngine 接口是否足以承载「WebEngine 降格为 transport」？缺什么？

**结论：当前接口是「一次性请求-响应」模型，不足以直接当 pi-agent-core 的 transport；缺流式回调、多轮消息数组、工具结果回灌、按请求中止、模型/参数选择五项。**

证据：
- `model-engine.ts:36` — `send(text: string): Promise<EngineSendResult>` 只接受一个字符串，不接受 `messages: Message[]`，也没有 streaming onDelta 回调。
- `model-engine.ts:28-42` — 整个接口只有 `name / health / send / waitForNextReply?` 四个成员，没有 abort signal、没有 model/params 透传。
- `web-engine.ts:57-97` — `send()` 假定页端已有对话上下文（`chat-insert` 写入文本后直接 `chat-send`），不管理历史；工具调用结果由页端拦截器自动回填（`web-engine.ts:5-7` 注释），引擎本身不参与。
- `web-engine.ts:25` — `isStopped?()` 是全局中止钩子，不是 per-request AbortController。

pi-agent-core 的 transport 抽象通常要求：接收 `messages[]` 发出、流式吐 delta、把 tool result 作为下一轮消息回灌、可按请求取消。当前接口每一项都缺。

**最小改法（若要改）**：
1. `send` 签名扩展为 `send(req: { text: string; messages?: unknown[]; signal?: AbortSignal; onDelta?: (t: string) => void }): Promise<EngineSendResult>`，web 实现忽略 messages（页端自带历史），onDelta 从 SSE/快照增量里算。
2. 新增 `injectToolResult(result: unknown): Promise<void>` 或在 send 的 options 里带 `toolResults`，让 pi 把工具结果喂回页端拦截器 pending 队列。
3. `isStopped` 从全局钩子改为接受 `signal?: AbortSignal`。

---

## Q2：toolCalls 是 number 计数，pi 期望结构化数组。gap 多大？能否在 WebEngine 内部补出数组而不改 ModelEngine 接口？

**结论：gap 有两层——类型层和数据层。类型上 `number` 与 `ToolCallRecord[]` 不兼容；数据上 WebEngine 当前只拿到计数器（`toolCallCounter.current`），拿不到工具名/参数/结果。不改 ModelEngine 接口无法把数组塞进 `send()` 返回值，但可以在 WebEngine 自己的接口上旁路暴露。**

证据：
- `model-engine.ts:23` — `readonly toolCalls: number;` 类型是计数，不是数组。
- `model-engine.ts:13-17` — 已定义 `ToolCallRecord { tool: string; ok: boolean; error?: string }`，但 EngineSendResult 没用它。
- `web-engine.ts:20` — `toolCallCounter: { current: number }` 只传了一个数字引用，没有记录列表。
- `web-engine.ts:95` — `const toolCalls = options.toolCallCounter.current - counterStart;` 只算差值。

数据层：工具调用的实际记录（tool 名、params、ExecuteResult）在 hub / intercept 层产生，WebEngine 从未被传入。当前架构里 WebEngine 连「本轮调了哪些工具」都不知道，只知道次数。

**能否不改接口补数组？**
- 不能改 `EngineSendResult.toolCalls` 的类型（那是 ModelEngine 接口的一部分）。
- 可以在 `WebEngineOptions` 里新增一个 `onToolCall?: (rec: ToolCallRecord) => void` 回调，WebEngine 内部累积本轮记录，再在 WebEngine 自己的接口上加一个 `getLastToolCallRecords(): ToolCallRecord[]`。但 pi-agent-core 面向的是 ModelEngine 接口，它看到的 `toolCalls` 仍是 `number`，拿不到数组。

**最小改法（若要改）**：
1. 把 `EngineSendResult.toolCalls` 从 `number` 改为 `ToolCallRecord[]`，面板/审计处的「次数」用 `.length` 代替。
2. `WebEngineOptions` 的 `toolCallCounter` 升级为 `toolCallLog: { push(rec: ToolCallRecord): void; snapshot(): ToolCallRecord[] }`，或新增 `onToolCall` 回调。
3. hub 执行完工具调用后，把 `{ tool, ok, error }` 推给 WebEngine 的缓冲区。

> **席3 复核补充（20261017）**：方案 1 是破坏性改动——现有 AgentLoop 与面板审计都把 `result.toolCalls` 当数字读。更稳妥的最小改法是**保留 `toolCalls: number` 不动，新增可选字段 `readonly toolCallRecords?: readonly ToolCallRecord[]`**（additive，零迁移成本）。WebEngine 内部仍需把 `toolCallCounter` 扩成带 `drain(): ToolCallRecord[]` 的对象（这是 WebEngineOptions，不是 ModelEngine 接口），收尾时把 drain 结果填进新字段、`toolCalls` 仍取 `records.length`。pi 消费新字段，老调用方继续读数字，两条路并行不悖。

---

## Q3：waitForNextReply 是可选的（?），如果 pi 的 transport 抽象要求显式声明，现有可选签名会不会成为接入障碍？

**结论：会成为轻度障碍——取决于 pi 侧是「能力检测」还是「强制实现」。可选签名在 TypeScript 下意味着实现类可以不写这个方法，pi 若要求 transport 必须实现，类型层直接报错；pi 若用 `'waitForNextReply' in engine` 做运行时检测则可用，但显式声明能力更安全。**

证据：
- `model-engine.ts:41` — `waitForNextReply?(): Promise<EngineSendResult>;` 问号表示可选。
- `web-engine.ts:103` — WebEngine 实现了此方法（auto-continue 续轮询）。
- `model-engine.ts:45-55` — `createApiEngineStub` 没有实现 `waitForNextReply`，依赖可选签名编译通过。

如果 pi-agent-core 的 transport 接口要求所有实现显式声明「是否支持异步续跑」（典型做法是加 `readonly supportsAsyncReply: boolean` 或把方法设为必选但不支持时 reject），那当前 `?` 可选签名会让：
1. ApiEngine 这类不支持续跑的实现没有显式声明位；
2. pi 无法在静态类型上区分「不支持」和「忘了实现」。

**最小改法**：
1. 保持 `waitForNextReply?` 可选，但在 ModelEngine 上加 `readonly capabilities: { asyncReply: boolean }`，让实现类显式声明。
2. 或者把 `waitForNextReply` 改为必选，不支持时返回 `Promise.reject(new Error('async-reply-not-supported'))`。web 实现正常返回，api stub 返回 reject。
3. 推荐做法 1（capability flag），因为它不破坏现有 ApiEngineStub 的编译，也让 pi 在运行时一眼看出 transport 能力矩阵。

> **席3 复核补充（20261017）**：真正的接入边界不是 ModelEngine 本身，而是一个 `class PiWebTransport implements PiTransport` 的 adapter。WebEngine 已经实现了 `waitForNextReply`（`web-engine.ts:103`），adapter 直接委托即可；ApiEngineStub 没实现，adapter 决定 reject。也就是说，ModelEngine 上的 `?` 在 adapter 层被消化，不会传染给 pi，**不构成编译期阻塞**。上面推荐的 `capabilities.asyncReply` 标志位是更显式的能力声明，属于 polish 而非前置必改。

---

## 总结

| 维度 | 当前状态 | 缺口严重度 | 最小改法 |
|---|---|---|---|
| Q1 transport 形态 | 一次性 send(text) | 高（5 项缺） | 扩展 send 签名 + 工具结果回灌 |
| Q2 toolCalls 结构 | number 计数 | 中（类型+数据双层） | toolCalls 改 ToolCallRecord[] + 回调 |
| Q3 waitForNextReply 可选 | `?` 可选 | 低（能力声明） | 加 capabilities 标志位 |

**整体判断**：WebEngine 降格为 transport 不是零改动能完成的，但缺口集中在「接口签名扩展」而非「重写实现」——WebEngine 内部的轮询/SSE/完成检测逻辑本身是可用的，主要工作是把它对接到 pi-agent-core 的 messages / streaming / abort / capability 协议上。
