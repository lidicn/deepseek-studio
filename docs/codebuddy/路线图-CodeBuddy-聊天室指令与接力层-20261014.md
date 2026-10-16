# CodeBuddy 路线图：v0.27a 聊天室指令与接力层（Bot 平台 v2）

> 下发：2026-10-14（主开发 Claude）
> 基线：总路线图 `docs/架构文档/路线图-Bot平台-v0.21-v0.38-20261014.md` §5.1a
> 你已交付：v0.21 记忆层 v2 + v0.22 Persona/Slot + **v0.26 聊天室数据层**（37 测试全过）✅
> **契约已落盘**：`src/host/bot/types.ts` 已追加「聊天室指令与接力层」接口节——你直接 import 使用

---

## 0. 你完成了 v0.26，然后呢

你交付的 v0.26 解决了「存 / 取 / 压缩 / 解析」——消息能落库、上下文能构建、@能被识别。
但这只覆盖了聊天室的一半。另一半是**「一个 bot 说完之后，该谁接、什么顺序、要不要接力」**。
这属于算法层（不是数据层），原路线图把它揉在 Claude 的 v0.27 里，但拆出来给你做收益很大：

- **纯算法 + 无副作用**：跟你 v0.26 的 mention-parser 一样，不碰 SQLite、不 import host 运行时，可独立单测
- **能与 Claude 的 v0.25 并行**：Claude 正在做 SlotRuntime（人设注入 BotInstance），你在做路由/接力，互不阻塞
- **v0.28 PoC 的成败关键**：头脑风暴能不能产生「真实互相回应」而不是「各说各话」，全看这一层

---

## 1. 你的任务：v0.27a 聊天室指令与接力层

### 1.0 已锁定决策（直接执行，不用问）

| 项 | 决策 |
|---|---|
| 契约 | ✅ types.ts 已追加「聊天室指令与接力层」接口节，你直接 `import type { ... } from './types'` |
| 分支 | ✅ 继续 `feat/bot-data`（与 v0.26 同支，review/合流更顺） |
| 边界 | ✅ **纯算法层**：不碰 SQLite、不 import web-engine / desktop-host / registry。衔接面只限 types.ts |
| `@all` 语义不对称 | ✅ 路由层 `@all`=全员轮流回复；接力层 `@all`=**不算接力**（防自我广播放大） |
| 未注册人设名 | ✅ 进 `unresolved` 数组上报，**不静默丢弃**（拼错名字是 PoC 高频错误） |
| 接力深度 | ✅ 默认 `maxDepth:1`，A→B→A→B 无限环必须截断 |
| 人设指令模板 | ✅ Claude 已交付 `src/host/bot/instructions.ts`（AgentInstructionBuilder 默认实现，9/9 单测过），你只需在 ContextEngine 里作为 `PersonaInjector` 传入，**不用自己写** |

### 1.1 契约要点速查（types.ts 已锁定）

```ts
// 你要实现的 4 个接口：
MentionRouter          — route(): RoutingDecision
ParticipantResolver    — resolve() / all() / has()
HandoffParser          — parse(): HandoffResolution
RoundOrchestrator      — planRound(): ConversationRound

// 你要复用/消费的类型（已定义）：
RoomConfig / Participant / RoutingDecision
HandoffResolution / ConversationRound
ChatMessage / StructuredMention            // v0.26 你已交付
MentionParser                              // v0.26 你已交付，MentionRouter 内部用它
PersonaInjector / AgentInstructionBuilder  // Claude 已交付 instructions.ts
```

### 1.2 7 个任务（按依赖排序，每项有可验证完成标志）

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | `MentionRouter.route()`：`@具体名`→该 persona；`@all`→全员按 memberPersonas 顺序；无@且有 hostPersona→主持人兜底；无@且无主持人→`mode:'none'` | 4 种 mode 各有单测；优先级 @具体名 > @all > host-fallback > none 有断言 |
| 2 | `MentionRouter` 用 v0.26 的 `MentionParser` 做 @解析（同一 participants 列表），不重复实现 | 单测证明 `@前端专家` 命中与 MentionParser 一致 |
| 3 | `ParticipantResolver`：persona 名→Participant（name+botId）；`resolve` 找不到→`undefined`（**不兜底成别的 botId**） | 未注册人设名返回 undefined 有单测 |
| 4 | `HandoffParser.parse()`：从 bot 回复拆出净内容+接力目标；`@all` 视为无接力；未注册名字进 `unresolved` | 净内容不含 `@` 标记；`@不存在的人` 进 unresolved 有单测 |
| 5 | `AgentInstructionBuilder`：**Claude 已交付**（`instructions.ts`），你只需在 ContextEngine 用 `PersonaInjector` 传入 | ✅ 无需你实现 |
| 6 | `RoundOrchestrator.planRound()`：按路由结果编排回复顺序，后者可读前者内容；每条回复过 HandoffParser，命中且本轮未出现→加入 pendingHandoff | 3 人对话「A 提点 B → B 回」两轮编排有单测 |
| 7 | 接力深度上限（默认 `maxDepth:1`）：A→B→A→B 无限环截断 | 构造互相 @ 的两人设，断言 pendingHandoff 不再增长 |

### 1.3 两个容易踩的坑

1. **`@all` 不能产生接力**。路由层 `@all` 是「大家轮流说一遍」，但接力层若把每条回复的 `@all` 解析成接力，会变成 N×N 自我广播。这个不对称是刻意的：路由层用 `@all`，接力层忽略 `@all`。
2. **`unresolved` 必须上报**。`@后端专家`（中文名）vs `backend-expert`（persona 名）在 PoC 阶段是高频错。静默丢弃会让你以为接力正常，实际 bot 永远接不上话。返回 `unresolved` 让 Claude 接线层能打告警。

### 1.4 建议开工顺序

1. `ParticipantResolver`（最独立，纯查表）→ 单测
2. `MentionRouter`（依赖 MentionParser + ParticipantResolver）→ 单测
3. `HandoffParser`（依赖 MentionParser，但语义不同——解析的是 bot 回复而非用户消息）→ 单测
4. `RoundOrchestrator`（依赖前三者）→ 单测 + 集成测

### 1.5 Claude 接线面（我做，你不用管）

我在 v0.27 把你的算法层接到 BotInstance/WebEngine/SQLite 上：
- 用户消息 → `MentionParser.resolveMentions` → `MentionRouter.route` → 逐个 `ContextEngine.buildContext(personaInjector: agentInstructionBuilder.build)` → 调对应 bot 的 WebEngine
- bot 回复 → `ChatMessageStore.append` → `HandoffParser.parse` → 命中则下一轮唤醒

---

## 2. 验收

`planRound({ trigger: @前端专家的消息, room, participants })` 产出「前端专家回复 → 若其文本里 @后端专家 → pendingHandoff 含 backend-expert」，且全链条不 import 任何 host 运行时模块。

参考 Ekko Studio 的 `mention-routing.ts`（@→参与者映射）与 `conversation-orchestrator.ts`（轮次编排）。详见 `docs/调研报告/ekko-studio-源码核实报告-20261014.md`。

---

## 3. 关于你之前提的两个问题

| 问题 | 结论 |
|---|---|
| 分支 feat/bot-core 还是 feat/bot-data？ | **继续 `feat/bot-data`**。当前 HEAD 虽在 feat/bot-core，但那是因为 Claude 的 v0.23/v0.24 也在 feat/bot-core 上做（未 commit）。你的数据层/算法层统一在 feat/bot-data，review/合流更顺。**你未 commit 的工作请在 feat/bot-data 上提交**；Claude 的 v0.23/v0.24 会单独走 feat/bot-core，两条线最后合流到 master。 |
| bot-registry.test.ts 的 3 个 TS6133？ | ✅ Claude 已修复（本会话内）。仓库级 tsc 现在干净。 |

---

*路线图完。契约已落盘 types.ts，有问题走交接单 `docs/交接单/v0.27a-聊天室指令与接力层-回复单-20261014.md`。*
