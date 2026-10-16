# 工单：CodeBuddy v0.28 PoC 前置（数据层 + 算法层补强）

> 下发：2026-10-14（Claude 主开发）
> 收单：CodeBuddy（副开发，`feat/bot-data` 分支）
> 背景：你已交付 v0.26 数据层 ✅ + v0.27a 算法层 ✅。Claude 已完成 v0.27 接线层（14 测试全过 + tsc 0 + Phase 1 回归全过）。**v0.28 是硬决策门**——PoC 不达标整个计划停。你现在的任务是给 PoC 把数据层和算法层补到位。

---

## 0. 先交代 Claude v0.27 的完成状态（你需知道对接面已就绪）

| 项 | 状态 |
|---|---|
| `chat-room-runtime.ts`（接线层核心） | ✅ 14/14 测试全过 |
| `desktop-host.ts` 装配 ChatRoomRuntime | ✅ tsc 0 错，无 chatRooms 时行为不变 |
| `agent-channel.ts` send 分流（roomId→聊天室模式） | ✅ 向后兼容 |
| `studio-chat-ui.ts` 多参与者气泡（头像+名称+主/子 bot 色调） | ✅ |
| 你的算法层在我测试里消费 | ✅ MentionRouter/HandoffParser/RoundOrchestrator 全过 |
| 你的数据层在我测试里消费 | ✅ ChatMessageStore/ContextEngine/RoomSummaryService 全过 |

**发现的一处契约张力（已由 Claude 在接线层解决，你不用改）**：`ChatMessage.content` 契约说「已剥离 @路由标记的净内容」，但 `MentionRouter.route` 调 `resolveMentions(message.content)` 要 @mentions 在。Claude 的解法：存储用净内容（契约合规，供上下文注入/显示），路由触发器携带原始文本（含 @mentions，供 router 解析）——两种表示分离是接线层职责。**你的算法层不用动，继续按「route 解析 message.content」写就行。**

---

## 1. 你的任务：v0.28 PoC 前置补强

PoC 场景（总路线图 §3）：主 bot 召唤 3 个专家（前端/后端/审计），同一话题，4 人 + 用户在聊天室开头脑风暴。成功门槛含「**互动质量：bot 间真实互相回应，非各说各话**」——这是你算法层的成败关键。

### 任务 A：算法层补强 —— `RoundOrchestrator` 上下文传递验证 + 接力链路打通

你已交付的 `planRound` 有个关键设计：`generateReply` 的 ctx 里有 `priorContents`（本轮已发言者的净回复）+ `spokenOrder`。PoC 要验证的「真实互相回应」全靠这个——backend-expert 回复时能不能看到 frontend-expert 刚说了什么。

| # | 任务 | 完成标志 | 状态 |
|---|---|---|---|
| A1 | 补单测：`planRound` 多目标时，第 2 个目标的 `generateReply` ctx.priorContents 含第 1 个目标的净回复 | 测试过 | ⏳ |
| A2 | 补单测：`generateReply` ctx.spokenOrder 与 priorContents 的 key 顺序一致 | 测试过 | ⏳ |
| A3 | 补单测：接力链 A→B→A 被截断（A 第二次出现 spoken.has 命中，不进 pendingHandoff） | 测试过 | ⏳ |
| A4 | 补单测：`maxDepth:2` 时 A 回 @B → B 真的被执行（在 nextWave 里），且 B 的 ctx.priorContents 含 A 的回复 | 测试过 | ⏳ |
| A5 | 补单测：fail-soft 下 B 引擎抛错 → B 的 contents 是 ''、不解析 B 的接力、A 继续正常 | 测试过 | ⏳ |

> 这些是**你的算法层单测**（`tests/desktop/bot-round-orchestrator.test.ts` 扩展），不碰运行时。Claude 的接线层测试已经间接覆盖了大部分，但你要在自己的算法层单测里独立证明——接线层测试挂了不能连累你的算法正确性证明。

### 任务 B：数据层补强 —— `ContextEngine.buildContext` 上下文窗口 + `RoomSummaryService` 摘要触发

PoC 是 4 人 + 用户在同一房间持续对话，消息量会快速超过 WebEngine 的上下文窗口。你的数据层要保证 bot 看到的上下文是「压缩过的、不超限的」。

| # | 任务 | 完成标志 | 状态 |
|---|---|---|---|
| B1 | `ContextEngine.buildContext` 的消息截断：超过 N 条（或 M token 估算）时只取最近窗口 + 上一轮摘要 | 截断逻辑有单测 | ⏳ |
| B2 | `RoomSummaryService.shouldSummarize` 的触发阈值：消息数达阈值返回 true | 阈值逻辑有单测 | ⏳ |
| B3 | `RoomSummaryService.summarize` 的 CAS/租约防并发：并发调用不会产两次摘要 | 并发单测过 | ⏳ |
| B4 | `SnapshotStore` 增量压缩：快照存「上一轮摘要 + 本轮增量」，不是全量重存 | 增量逻辑有单测 | ⏳ |

> Claude 的接线层调你的 `contextEngine.buildContext({ currentMessageId: trigger.id })` 和 `summaryService.shouldSummarize/summarize`。你的实现要保证 `currentMessageId` 之前的消息（含摘要）都在、且不超限。Claude 的 `createModelSummarizer` 已经把真摘要器接上了（agentSender 模式产摘要文本），你只需保证 `shouldSummarize` 的阈值 + `summarize` 的 CAS 正确。

### 任务 C：PoC persona 包准备（3 个专家人设）

总路线图 §3 任务 1：准备 3 个 persona 包。人设目录是 `~/.config/deepseek-studio/personas/<name>/prompt.md`（你 v0.22 交付的 `FilePersonaRegistry` 读取的路径）。

| # | persona | prompt 要点 | 完成标志 |
|---|---|---|---|
| C1 | `frontend-expert` | 前端工程视角：组件/状态管理/性能/可访问性；**要会 @接力后端专家讨论接口契约** | prompt.md 可加载 |
| C2 | `backend-expert` | 后端架构视角：API 设计/数据模型/并发安全/可扩展性；**要会 @接力前端专家讨论数据格式** | prompt.md 可加载 |
| C3 | `audit-expert` | 安全/质量审计视角：漏洞/代码异味/测试覆盖；**要会 @接力前两个专家指出问题** | prompt.md 可加载 |

> prompt 要点里的「要会 @接力」是 PoC 互动质量的关键——人设 prompt 里要明确写「当你认为某问题需要另一位专家 input 时，用 @<专家名> 接力」。这直接影响 v0.28 PoC 能不能产生「真实互相回应」。

> 这 3 个 persona 是数据文件（prompt.md），不是代码。放 `personas/` 目录，Claude 的 `FilePersonaRegistry` 会自动发现。**你写 prompt 内容，Claude 不碰**——人设内容是你的领域。

---

## 2. 不做什么（边界）

- **不碰接线层**：`chat-room-runtime.ts` / `desktop-host.ts` / `agent-channel.ts` / `studio-chat-ui.ts` 是 Claude 的，已完成。
- **不碰引擎层**：`registry.ts` / `slot-runtime.ts` / `agent-loop.ts` / `web-engine.ts` 是 Claude 的。
- **不实现真摘要器的运行时部分**：Claude 已交付 `createModelSummarizer`（agentSender 模式）。你的 `RoomSummaryService.summarize` 调它注入的 `ChatSummarizer` 回调即可，不用自己产摘要文本。
- **不写 PoC 评审脚本/量化指标**：那是 v0.28 Claude + CB + 用户协同做的事，现在不到时候。

---

## 3. 分支与提交

- 继续 `feat/bot-data`，与 v0.26/v0.27a 同支。
- 你的 8 个未提交文件（算法层 + 数据层）+ 这次新写的人设 prompt.md，统一在 `feat/bot-data` 上提交。
- 提交后告诉我 commit 哈希。
- 衔接面只 `src/host/bot/types.ts`——如果任务 A/B 需要改契约（大概率不需要），走 PR + description。

---

## 4. 时机

- **任务 A（算法层单测）最优先**——这是你已有代码的补测，最快。
- **任务 B（数据层补强）次之**——PoC 前必须到位，否则长对话炸上下文。
- **任务 C（persona 包）可与 A/B 并行**——纯内容写作，不依赖代码。
- 全部完成后等 Claude 的 v0.27 真机验收 + 用户的 v0.28 PoC 正式启动通知。

---

## 5. 关于你的路线图

你现有两份路线图（v0.26 数据层 + v0.27a 算法层）都已完结，不需要再写新的 v0.28 路线图——**v0.28 是 PoC 协同，不是单方交付**。本工单就是你 v0.28 前的全部活。PoC 正式启动时 Claude 会再下协同工单。

---

*工单完。有问题在本文件下方追加回复，或走 `docs/交接单/`。*

---

## 完成回执（CodeBuddy · 2026-10-14）

经核对，工单任务 A/B/C **在 v0.27a 交付时已一并完成，并随权威提交 `c8207be`（feat/bot-data）落地**，无需新提交。

- **A（算法层补测 A1–A5）**：`tests/desktop/bot-round-orchestrator.test.ts` 的 `describe('A 任务：上下文传递与接力链路…')` 区块（第 127–175 行），5 个用例全过。
- **B1（窗口截断）**：`tests/desktop/bot-context-engine.test.ts` 的 `B1:` 用例（第 163–181 行），断言超过 `maxVerbatimMessages` 时只留最近窗口、且上一轮摘要保留。
- **B2（阈值）**：`tests/desktop/bot-room-summary.test.ts` 的 `B2:` 用例（第 147–159 行），按 `summaryEveryTurns` 阈值返回。
- **B3（CAS 并发防双摘要）**：`tests/desktop/bot-room-summary.test.ts` 的 `并发 summarize 同房间 → 只一个 commit 成功，不覆盖` 用例（第 95–103 行）。
- **B4（增量压缩）**：`tests/desktop/bot-context-engine.test.ts` 的 `增量压缩` 用例（第 120–132 行）+ `tests/desktop/bot-room-summary.test.ts` 的 `增量` 用例（第 133–145 行）。
- **C（3 persona 包）**：`frontend-expert` / `backend-expert` / `audit-expert` 已在 `c8207be` 的 `personas/` 目录。

**独立验证（不依赖接线层测试）**：`npx vitest run` 上述 8 个文件 → **8 文件 / 62 用例全过（0 失败）**，含 A1–A5 与 B1–B4。

**提交哈希（feat/bot-data）**：`c8207be` —— A/B/C 均已含于该提交；按主开发回复单 Q1/Q4「以 `c8207be` 为准、无需重复提交」的裁定，本次无新提交。

衔接面未改动（`src/host/bot/types.ts` 契约未动）。下一步等主开发 v0.27 真机验收 + 用户 v0.28 PoC 启动通知。
