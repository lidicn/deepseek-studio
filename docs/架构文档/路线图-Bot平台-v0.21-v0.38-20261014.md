# Bot 平台路线图 v2（聊天室基石版）

> 出品：2026-10-14（基于多轮讨论重写）
> 范式转变：从「并行审计仪表盘」→「协作聊天室」——聊天室是基石，任务分发是聊天室上的长任务扩展
> 基线：Bot 计划书 + 三层解耦设计稿 + 侦查报告 + Ekko 源码核实报告 + CB 第一批交付
> 决策门：**v0.28（G1 PoC 头脑风暴）是硬决策门——过不了就停。**

---

## 0. 范式转变：为什么聊天室是基石

### 0.1 核心洞察

用户构想：主 bot 在聊天室把任务分发给其他 bot，子 bot 领任务去执行，完成后回聊天室交付报告。聊天室同时是**协作空间 + 任务面板 + 记录系统**。

这意味着**聊天室是统一消息总线**——所有 bot 和用户都挂在上面。任务分发不是另一种模式，而是聊天室上的一种「消息类型」：

| 消息类型 | 触发 | 行为 | 时长 |
|---|---|---|---|
| 即时回复 | @某专家问问题 | 在聊天室上下文里即时生成回复 | 秒级 |
| 长任务 | @某专家去做任务 | 领任务→离线执行→完成回报摘要 | 分钟~小时级 |
| 状态回报 | 子 bot 执行中 | 聊天室显示进度 | - |
| 结果交付 | 子 bot 完成 | 摘要+证据引用回聊天室 | - |

**同一个 @路由机制，两种 handler。聊天室是底座，任务分发是底座上的长任务扩展。**

### 0.2 两种协作形态统一为一种架构

| | 即时协作（头脑风暴） | 任务分发（审计会议） |
|---|---|---|
| 上下文 | 共享（聊天室快照） | 执行期隔离，回报时回聊天室 |
| 通信 | 多向碰撞 | 单向：主 bot→子 bot→主 bot |
| 调度 | @路由即时触发 | @路由触发长任务 handler |
| 底座 | **聊天室** | **聊天室** |

### 0.3 验证顺序：先聊天室，后任务分发

| 先做聊天室 (G1) | 先做任务分发 |
|---|---|
| ✅ 聊天室是任务分发的底座 | ❌ 没有聊天室=没有统一面板，用户切窗口 |
| ✅ @路由 + 上下文共享是基础设施，可复用 | ❌ 分发的用户交互依赖聊天室 |
| ✅ PoC 用头脑风暴验证多视角价值 | ❌ 审计 PoC 需要的基建更多 |

---

## 1. 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| **执行路径** | 全网页（隐藏 WebviewWindow） | 用户裁定；后续兼容 OpenAI API |
| **调度模式** | @路由 + handoff | 灵活，用户可 @指定，可 handoff 接力；不选 Hermes 串行轮次（太死板） |
| **上下文策略** | Ekko 式快照+增量压缩 | 解决网页版上下文有限；旧消息摘要存盘，只注入「摘要+最近 N 条」 |
| **ApiEngine** | **延后**（G4 阶段做 OpenAI 兼容） | 全网页优先，API 兼容作为后续扩展 |
| **多窗口寻址** | **必做**（原「可绕则绕」取消） | 全网页路径强制要求 |

---

## 2. 版本全景图

```
Phase 0: 基础设施（v0.21~v0.22）—— CB ✅ 已交付
  v0.21 记忆层 v2 (SQLite+FTS5) ─────── CB ✅
  v0.22 Persona/Slot 注册表 ────────── CB ✅

Phase 1: 核心引擎 + 多窗口（v0.23~v0.25）—— Claude ✅ 全部交付
  v0.23 AgentLoop 去单例 + BotRegistry ──────────────── Claude ✅
  v0.24 多窗口寻址（隐藏 WebviewWindow + profile 隔离 + botId 注入 + WS 路由）Claude ✅
  v0.25 SlotRuntime（人设注入 BotInstance + 工具白名单 + Scheduler runner 接入）Claude ✅

Phase 2: 聊天室基石 G1（v0.26~v0.28）—— Claude + CB
  v0.26 聊天室数据层（消息存储 + 上下文引擎 + 房间摘要 + @解析）── CB ✅
  v0.27a 聊天室指令与接力层（人设指令 + 接力解析 + 轮次编排 + 参与者翻译）CB ⏳ ◀═══ CB 新任务
  v0.27 聊天室 UI + 路由 + 上下文注入接线 ────────────── Claude
  v0.28 PoC：头脑风暴（3 专家 + 用户）◀═══ 硬决策门

  ┌─ 不达标 → 停止 ─┐
  └─ 达标 ↓ ────────┘

Phase 3: 任务分发 G2（v0.29~v0.31）
  v0.29 长任务 handler + 离线执行 + 状态回报
  v0.30 SubBotReport 协议 + 落盘 + 结果交付
  v0.31 PoC：审计会议（主 bot 分发，子 bot 离线审计后回报）

Phase 4: 规模+治理 G3（v0.32~v0.34）
  v0.32 5+ bot + 人设热插拔 + 干净卸载
  v0.33 Curator（冲突标记 + 遗忘 + 路由 + 审计回滚）
  v0.34 稳定性硬化（窗口前台化 + 限流冷却 + 崩溃恢复）

Phase 5: 生产化 G4（v0.35~v0.38）
  v0.35 Bot 管理 UI 树（账号/槽位/人设/任务四视图）
  v0.36 成本治理 + ApiEngine（OpenAI 兼容）
  v0.37 多平台 + 安全加固
  v0.38 生产版 GA
```

| 阶段 | 版本 | 日历日 | 累计 | 决策门 |
|---|---|---|---|---|
| Phase 0 基础设施 | v0.21~v0.22 | ✅ 已完成 | 0 | 无 |
| Phase 1 核心引擎 | v0.23 ✅ / v0.24 ✅ / v0.25 ✅（全部交付） | ~12 | 12 | 无 |
| Phase 2 聊天室 G1 | v0.26 ✅ / v0.27a CB ⏳ / v0.27 Claude ⏳ / v0.28 门 | ~14 | 26 | **v0.28 硬** |
| Phase 3 任务分发 G2 | v0.29~v0.31 | ~12 | 38 | 软 |
| Phase 4 规模治理 G3 | v0.32~v0.34 | ~20 | 58 | 软 |
| Phase 5 生产化 G4 | v0.35~v0.38 | ~25 | 83 | 无 |

> 实际工期 ×1.5（调试意外）→ 约 125 天到 GA。最大不确定性在 v0.28。

---

## 3. Phase 0：基础设施（v0.21~v0.22）✅ CB 已交付

### v0.21 — 记忆层 v2（SQLite + FTS5）✅

| 项 | 状态 |
|---|---|
| 负责方 | CodeBuddy ✅ |
| 分支 | feat/bot-data，commit d568aff |
| 存储 | SQLite（node:sqlite，Node 24 内置）+ FTS5 trigram 分词 |
| 新字段 | source / confidence / personaTags / invalidAt / contentHash |
| 接口 | search（FTS bm25→LIKE 兜底→标签加权）/ invalidate（失效不删除）/ listByPersona / formatForPrompt |
| 降级 | node:sqlite 不可用时自动退内存存储，宿主不崩 |
| 迁移 | 旧 memories.json 首次启动自动导入，原文件保留 |
| 测试 | 18 项全过 |

### v0.22 — Persona/Slot 注册表 ✅

| 项 | 状态 |
|---|---|
| 负责方 | CodeBuddy ✅ |
| PersonaRegistry | FilePersonaRegistry：扫描 personas/，路径穿越防护，tools.json 白名单 |
| SlotRegistry | AccountRegistry + FileSlotRegistry：1槽位:1账号铁律服务端强制 |
| Scheduler | assign({slot?, persona, task})：占槽+加载人设，预留 runner 回调 |
| 示例人设 | personas/audit-expert/（prompt.md + tools.json + memory/）开箱可用 |
| 测试 | 26 项全过（persona 10 + slot+scheduler 16） |

**CB 交接卡**：`docs/codebuddy/交接卡-CodeBuddy副开发-Bot数据层-20261014.md`

---

## 4. Phase 1：核心引擎 + 多窗口（v0.23~v0.25）

> Claude 主开发。v0.23 / v0.24 / v0.25 ✅ 全部交付（2026-10-14），Phase 1 闭环。下一批：v0.27（聊天室 UI + 接线）。
> v0.23+v0.24 落地后 CB 解锁了 v0.27a（人设指令 + 接力 + 轮次编排），见 §5.1a。

### v0.23 — AgentLoop 去单例 + BotRegistry ✅

| 项 | 内容 |
|---|---|
| 负责方 | Claude |
| 工期 | 5-7 天 → 实际同日内交付 |
| 状态 | ✅ 已交付（2026-10-14）：`src/host/bot/registry.ts` 新建 BotRegistry；事件带 botId；agent-channel 多 bot 路由 |
| 关键文件 | `src/host/agent-loop.ts`、`src/host/agent-channel.ts`、`src/host/desktop-host.ts`、`src/host/bot/registry.ts` |
| 验证 | `agent-loop`(10) + `bot-registry`(7) + `agent-channel-multibot`(5) = 22/22 通过；`tsc --noEmit` 0 错误 |

**任务清单**：

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 去掉 `if (active) throw 'agent-busy'` 单例锁，active 改为实例级 | 两个 loop 实例各自 running 独立 |
| 2 | 实现 `BotInstance` 装配：`{ id, loop, engine, persona, slotId }` | botRegistry.create() 返回可用实例 |
| 3 | 实现 `BotRegistry`：create / get / list / destroy 生命周期 | N 个实例可共存可销毁 |
| 4 | `agent-channel` 从「单 agent」改为「按 botId 路由」 | send 消息带 botId 路由到对应 BotInstance |
| 5 | `agent-channel` 的 state 快照改为多 Bot 状态列表 | 面板能看到所有活跃 Bot |
| 6 | `agent-channel` 的 agent-busy 检查改为 per-bot busy | 不同 botId 不互相阻塞 |
| 7 | 事件流带 botId 标签：AgentLoopEvent 加 botId 字段 | 面板能区分事件来源 |
| 8 | 回归测试：现有单 Bot 场景（不指定 botId）行为不变 | 既有测试全绿 |

**验收**：两个 BotInstance 可并行 send()，互不阻塞；现有单 Bot 路径无回归。

---

### v0.24 — 多窗口寻址（全网页路径核心改造）✅

| 项 | 内容 |
|---|---|
| 负责方 | Claude |
| 工期 | 5-7 天 → 实际同日内交付 |
| 状态 | ✅ 已交付（2026-10-14）：botId 全程可选串到 protocol → page-runtime hub → desktop-host → BotRegistry → 注入页；预配置 bot 窗口 + WebView2 profile 隔离 |
| 关键文件 | `src/host/protocol.ts`、`src/host/page-runtime.ts`、`src/host/desktop-host.ts`、`src/desktop/host-client.ts`、`src/desktop/entry.ts`、`src-tauri/src/main.rs` |
| 验证 | `page-runtime-multibot`(5) 全过 + `tool-bridge`(13) 回归 + `tsc` 0 错误 + `cargo check` 通过 + inject bundle 已重建同步 |

> **待真机验证**：WebView2 `data_directory` 的 Cookie/localStorage/IndexedDB 实际隔离效果只能在本机 Windows Tauri 运行时验证，本环境仅证明 API 可用（`cargo check`）。代码在 bot 缺 `dataDir` 时打印显式告警而非静默降级。

> **向后兼容规则（关键设计）**：`pickClient(botId?)` 只在**调用方显式给了 botId** 时才按 botId 过滤；不传 botId 时沿用改造前的「任一可信页」行为。这样单窗口 / 旧注入脚本 / 遗留调用路径行为完全不变，而多 bot 引擎各自带 botId 调用即精确寻址。连接级身份（hello 登记的 `rec.botId`）优先于报文内 `msg.botId`。

**验收**：创建 2 个隐藏窗口，各登录不同 DeepSeek 账号，注入脚本各自上报 botId，WS 能按 botId 路由消息到对应窗口。✅（TS 路由已由集成测试覆盖；profile 隔离待真机）

> 这是全网页路径最重的改造——原侦查报告标为「可绕则绕」，全网页决策后变为必做。

**任务清单**：

| # | 任务 | 完成标志 | 状态 |
|---|---|---|---|
| 1 | 隐藏 WebviewWindow 创建：预配置驱动（`~/.config/deepseek-studio/bot-windows.json`），逐个容错创建 | N 个窗口可创建 | ✅ |
| 2 | profile 隔离：`data_directory()` 独立 WebView2 user data folder | 不同窗口登录态不串 | ✅ 代码 / ⏳ 真机 |
| 3 | 注入带 botId：`initialization_script` 前缀注入 `window.__studioBotId` | 注入脚本上报 botId | ✅ |
| 4 | WS 路由：`dispatch` / `requestConsent` 加 botId 参数，`pickClient(botId?)` | 不同 botId 打到不同窗口 | ✅ |
| 5 | WebEngine per-window：`BotRegistry.createEngine` 每 bot 引擎 dispatch 带自己的 botId | 每个 WebEngine 读自己的窗口 | ✅ |
| 6 | 同意闸门按 botId：`allowlistFor(botId)` 每 bot 独立放行表；窗口不在场 → `consent-unavailable` | 不拿别人的同意 | ✅ |
| 7 | 窗口生命周期：close handler 按 label 分流，bot 窗口不污染主窗口几何、不关共享 sidecar | 可管理 | ✅ |

**验收**：创建 2 个隐藏窗口，各登录不同 DeepSeek 账号，注入脚本各自上报 botId，WS 能按 botId 路由消息到对应窗口。✅ TS 侧已验证；profile 隔离待真机。

---

### v0.25 — SlotRuntime（人设注入 + 工具白名单 + Scheduler 接入）✅

| 项 | 内容 |
|---|---|
| 负责方 | Claude ✅ |
| 工期 | 3-4 天 → 实际同日内交付 |
| 状态 | ✅ 已交付（2026-10-14）：SlotRuntime + 人设白名单 executor + Scheduler runner 接入 |
| 依赖 | v0.23（BotRegistry）✅、v0.24（多窗口）✅、CB 的 Scheduler（已交付）✅ |
| 关键文件 | `src/host/bot/slot-runtime.ts`（新建）、`registry.ts`（state 加 executor）、`desktop-host.ts`（hub executor 接入） |
| 验证 | `bot-slot-runtime`(8) + `bot-slot-runtime-integration`(13) = 21/21；Phase 1 全量回归 123/123；`tsc` 0 错误 |

**任务清单**：

| # | 任务 | 完成标志 | 状态 |
|---|---|---|---|
| 1 | `loadPersona(name)`：加载人设 → 注入 prompt 到 BotInstance | 人设 prompt 生效 | ✅ |
| 2 | 按 persona.tools 白名单过滤（`createPersonaExecutor`） | Bot 只能用白名单工具 | ✅ |
| 3 | `unloadPersona()`：清 persona + 白名单 + executor | 卸载干净 | ✅ |
| 4 | `run(handle)`：以当前人设执行任务 | 能跑通 | ✅ |
| 5 | Scheduler runner 接入：`new Scheduler({ slots, personas, runner: slotRuntime.run })` | assign 闭环 | ✅ |
| 6 | 集成测试：Scheduler + BotRegistry 真装配，假引擎记录消息 | assign 不抛错、能执行 | ✅ |

**验收**：`scheduler.assign({slot:'S1', persona:'audit-expert', task:{dimension:'并发安全'}})` 能跑通——Bot 加载人设、收到任务、在对应窗口执行。✅

> **两条工具路径的不对称（本版本核心设计）**：
> - 页面驱动工具（chat-read / chat-insert / chat-send）：WebEngine.dispatch 结构上不过白名单——它是引擎与页面通信的唯一通道，过滤掉它引擎就死了。
> - 模型发起工具（shell.exec / file.read 等）：页内拦截器解析 → ws 反向投递 → hub.executor → 人设白名单 → **仍回 invokeTool 走完整授权链**（白名单只「拒绝」，从不「放行免授权」）。
> - 拒绝码固定 `tool-not-allowed-by-persona`，与 consent-denied / unknown-tool 区分，便于审计。
>
> **人设 prompt 注入方式（与通用系统提示词不同）**：WebEngine 没有系统提示词概念——它把文本贴进 chat.deepseek.com 输入框。所以 persona.prompt 作为消息文本的一部分，紧跟 `AGENT_SENTINEL` 之后（该前缀语义是「agent 驱动而非用户手输」）。人设块与任务块用 `\n---\n` 分隔，避免模型混淆「你是谁」与「现在做什么」。

---

## 5. Phase 2：聊天室基石 G1（v0.26~v0.28）

> 目标：**可演示的多 Bot 聊天室**，验证聊天室协作的价值。v0.28 是硬决策门。

### v0.26 — 聊天室数据层（消息存储 + 上下文引擎 + 房间摘要 + @解析）✅

| 项 | 内容 |
|---|---|
| 负责方 | CodeBuddy ✅ |
| 工期 | 5-7 天 → 实际同日内交付（2026-10-14） |
| 状态 | ✅ 已交付：4 模块 + memory-store 非破坏扩展，37 个新测试全过 |
| 依赖 | types.ts 新增接口（Claude 先定义）✅、v0.21 记忆层 v2（复用 SQLite，方案 A 单连接）✅ |
| 关键文件 | `src/host/bot/chat-room-store.ts`、`context-engine.ts`、`room-summary.ts`、`mention-parser.ts` |

> **可并行**：与 v0.23~v0.25 同时启动——聊天室数据层不依赖多窗口，可独立开发和测试。

**任务清单**：

| # | 任务 | 完成标志 | 状态 |
|---|---|---|---|
| 1 | ChatMessageStore：SQLite 存储聊天室消息（roomId/senderId/senderType/content/timestamp/mentions） | 消息可存可查 | ✅ |
| 2 | ChatMessageStore.getMessages(roomId, {throughMessageId, limit}) | 按范围取消息 | ✅ |
| 3 | ContextEngine.buildContext(roomId, botId, currentMessageId)：构建 bot 回复上下文 | 返回 systemPrompt + messages | ✅ |
| 4 | ContextEngine 快照机制：每房间维护 {summary, lastMessageId}，已摘要的旧消息不重复传 | 快照存取正常 | ✅ |
| 5 | ContextEngine 增量压缩：超 token 阈值才压缩，只压缩快照之后的新消息 | 不全量重算 | ✅ |
| 6 | ContextEngine per-room 压缩锁：防并发快照覆盖 | 并发安全 | ✅ |
| 7 | RoomSummaryService：周期摘要（summaryEveryTurns 可配）+ CAS 租约防并发覆盖 | 摘要不互相覆盖 | ✅ |
| 8 | MentionParser.resolveMentions(content, participants)：解析 @某专家 / @all | 返回 StructuredMention[] | ✅ |
| 9 | MentionParser.stripMentionTokens(content)：剥离 @标记留净内容 | 净内容 | ✅ |
| 10 | 单测：buildContext 返回 {summary + 最近N条} | npm test 绿 | ✅ |
| 11 | 单测：resolveMentions("@前端专家 你怎么看") 返回正确目标 | npm test 绿 | ✅ |

**验收**：消息可存储检索；ContextEngine 能构建「摘要+最近消息」上下文；@解析正确。✅

**借鉴参考**：Ekko Studio 的 `context-engine/compressor.ts`（快照+增量压缩）、`mention-routing.ts`（@解析）、`room-summary.ts`（CAS 租约）。详见 `docs/调研报告/ekko-studio-源码核实报告-20261014.md`。

---

### v0.27a — 聊天室指令与接力层 ◀═══ CB 新任务（v0.26 完成后解锁）

| 项 | 内容 |
|---|---|
| 负责方 | CodeBuddy |
| 工期 | 4-5 天 |
| 依赖 | v0.26（MentionParser / ContextEngine 已交付）✅；契约已落盘 `types.ts`（Claude 已追加）✅ |
| 关键文件 | 新建 `src/host/bot/mention-router.ts`、`participant-resolver.ts`、`handoff-parser.ts`、`round-orchestrator.ts` |
| 边界 | **纯算法层**：不碰 SQLite、不 import web-engine / desktop-host / registry。衔接面仍只限 `types.ts` |

> **为什么单独立一项**：v0.26 解决的是「存/取/压缩/解析」——消息能落库、上下文能构建、@能被识别。
> 但「一个 bot 说完之后，该谁接、什么顺序、要不要接力」是聊天室能否真的对话的关键，属于算法而非数据。
> v0.27（Claude）的验收目标是「@前端专家 → 前端专家回复 → 另一个 bot 看到 → 可追加回应」，其中「该谁回」这一环必须有明确实现，否则 v0.27 无从接线。
> 与 v0.23~v0.25 一样，这一层不依赖多窗口，**可在 Claude 做 v0.25 时并行开工**。

**任务清单**（7 项，按依赖排序；每项都写了可验证的完成标志）：

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | `MentionRouter.route()`：`@具体名` → 该 persona；`@all` → 全员按 `memberPersonas` 顺序；无@且有 `hostPersona` → 主持人兜底；无@且无主持人 → `mode:'none'` | 4 种 mode 各有单测；优先级 @具体名 > @all > host-fallback > none 有断言 |
| 2 | `MentionRouter` 用 v0.26 的 `MentionParser` 做解析（同一 participants 列表），不重复实现 @解析 | 单测证明 `@前端专家` 命中与 MentionParser 一致 |
| 3 | `ParticipantResolver`：persona 名 → Participant（name+botId）；`resolve` 找不到 → `undefined`（**不兜底成别的 botId**） | 未注册人设名返回 undefined 有单测 |
| 4 | `HandoffParser.parse()`：从 bot 回复文本拆出净内容 + 接力目标；`@all` 视为无接力（防全员广播自我放大）；未注册名字进 `unresolved` 而非丢弃 | 净内容不含 `@` 标记；`@不存在的人` 进 unresolved 有单测 |
| 5 | `AgentInstructionBuilder.build()` 契约已由 Claude 定稿，Claude 已交付默认实现 | ✅ `src/host/bot/instructions.ts`（9/9 单测通过），你只需在 ContextEngine 里以 `PersonaInjector` 传入 |
| 6 | `RoundOrchestrator.planRound()`：按路由结果编排回复顺序，后者可读前者内容（轮间串行）；每条回复过 HandoffParser，命中且本轮未出现 → 加入 `pendingHandoff` | 3 人对话「A 提点 B → B 回」两轮编排有单测 |
| 7 | **接力深度上限**（默认 `maxDepth: 1`）：A→B→A→B 无限环必须被截断 | 构造互相 @ 的两个人设，断言 `pendingHandoff` 不再增长 |

**两个容易踩的坑（写在这里免得返工）**：

1. **`@all` 不能产生接力**。路由层里 `@all` 意味着「大家轮流说一遍」，但接力层里如果每条回复都把 `@all` 解析成接力，会变成 N 人 × N 人的自我广播。所以任务 1 里 `@all` 是路由模式，任务 4 里 `@all` 不算接力目标——这个不对称是刻意的。
2. **`unresolved` 必须上报而非静默丢弃**。人设名拼错（`@后端专家` vs `backend-expert`）在 PoC 阶段是高频错误；静默丢弃会让你以为接力正常，实际 bot 永远接不上话。返回 `unresolved` 让 Claude 接线层能打告警。

**验收**：`planRound({ trigger: @前端专家的消息, room, participants })` 能产出「前端专家回复 → 若其文本里 @后端专家 → pendingHandoff 含 backend-expert」，且全链条不 import 任何 host 运行时模块。

**Claude 接线面**（我在 v0.27 做，你不用管）：
- `desktop-host` 收到用户消息 → `MentionParser.resolveMentions` → `MentionRouter.route` → 逐个 `ContextEngine.buildContext(personaInjector: agentInstructionBuilder.build)` → 调对应 bot 的 WebEngine
- bot 回复回收 → `ChatMessageStore.append` → `HandoffParser.parse` → 命中则下一轮唤醒

---

### v0.27 — 聊天室 UI + 路由 + 上下文注入接线

| 项 | 内容 |
|---|---|
| 负责方 | Claude |
| 工期 | 5-6 天 |
| 依赖 | v0.26（数据层）✅、v0.27a（指令与接力层）、v0.25（SlotRuntime） |
| 关键文件 | `src/ui/studio-chat-ui.ts`（扩展）、`src/host/bot/chat-room-runtime.ts`（新建，接线层） |

**任务清单**：

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 聊天室 UI：共享消息流（复用 v0.19/0.20 自建 UI 基座） | 消息可显示 |
| 2 | 参与者标识：每条消息显示发送者（用户/主bot/子bot），头像+名称 | 能区分谁说的 |
| 3 | @提及输入：输入框支持 @ 选择/输入 bot 名 | @ 能触发 |
| 4 | 接线：调用 v0.27a 的 `MentionRouter.route` + `ParticipantResolver` → 唤醒对应 bot（**不重实现路由算法**） | @谁谁回 |
| 5 | 接线：`round-orchestrator.planRound` 的输出驱动回复顺序（@all / 主持人兜底） | 全员参与、不 @ 也能跑 |
| 6 | 上下文注入：`ContextEngine.buildContext({ personaInjector })` 传入 v0.27a 的 `AgentInstructionBuilder.build` 结果 | bot 能看到上下文+知道自己是谁 |
| 7 | bot 回复回收：WebEngine 读到回复 → `ChatMessageStore.append` → 带 botId 标签回聊天室显示 | 回复进聊天室 |
| 8 | 接线：回复过 v0.27a 的 `HandoffParser.parse` → 命中则下一轮唤醒 | bot 间可接力；`unresolved` 打告警 |
| 9 | 真实摘要器接入：v0.26 留桩的 `ChatSummarizer` 换成接 ModelEngine 的实现 | 长对话不超限 |

**验收**：用户在聊天室发「@前端专家 你怎么看」→ 前端专家 bot 被唤醒 → 看到聊天室上下文 → 基于人设回复 → 回复进聊天室 → 另一个 bot 能看到 → 可追加回应。

> **分工说明**：v0.27 原来的任务 4/6/8/10 是**算法**（路由规则、轮次编排、接力识别），已全部移交 v0.27a（CB）；
> v0.27 自己只留**接线 + UI + 真摘要器**——把 CB 的算法层接到 BotInstance/WebEngine/SQLite 上。算法与接线分开的收益是两边都能独立单测，不用等整条链。

---

### v0.28 — PoC：头脑风暴 ◀═══ 硬决策门

| 项 | 内容 |
|---|---|
| 负责方 | Claude + CB + 用户（评审） |
| 工期 | 3-5 天 |
| 依赖 | v0.26~v0.27 全部完成 |

**PoC 场景**：主 bot 召唤 3 个专家（前端/后端/审计），同一话题，4 人 + 用户在聊天室开头脑风暴。

**任务清单**：

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 准备 3 个 persona 包（前端专家/后端专家/审计专家） | 3 个 persona 可用 |
| 2 | 准备 3 个隐藏窗口 + 3 个 DeepSeek 账号 | 3 bot 就绪 |
| 3 | 对照组 A：单 bot 做同样话题的头脑风暴 | 跑完有记录 |
| 4 | 对照组 B：3 bot + 用户在聊天室头脑风暴 | 跑完有记录 |
| 5 | 量化对比：视角覆盖（前端/后端/审计三维度是否都覆盖） | 数据齐 |
| 6 | 量化对比：洞察数（人工评审「有价值的观点」数） | 数据齐 |
| 7 | 主观满意度：用户主观评分「这次头脑风暴有用」 | 评审结论 |
| 8 | 互动质量：bot 之间有真实互相回应/补充，不是各说各话 | 评审结论 |

**PoC 成功标准**：

| 指标 | 门槛 | 不达标后果 |
|---|---|---|
| 视角覆盖 | 多 bot 覆盖 3 个维度，单 bot 容易陷入单一视角 | 停止 |
| 洞察数 | 多 bot ≥ 单 bot ×1.5 | 停止 |
| 用户满意度 | 用户主观评分「有用」 | 停止 |
| 互动质量 | bot 间有真实互相回应，非各说各话 | 停止 |

> 任一不达标 → 停止，回归单 Bot。不沉没成本。

---

## 6. Phase 3：任务分发 G2（v0.29~v0.31）

> 前提：v0.28 PoC 达标。聊天室已跑通，加长任务 handler。

### v0.29 — 长任务 handler + 离线执行 + 状态回报

| 项 | 内容 |
|---|---|
| 负责方 | Claude |
| 工期 | 4-5 天 |
| 依赖 | v0.28 达标 |

**任务清单**：

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 长任务 handler：@某专家 去做长任务 → bot 进入离线执行模式 | bot 能离开聊天室去执行 |
| 2 | 状态回报：bot 执行中 → 聊天室显示「执行中…」 | 进度可见 |
| 3 | bot「离开」语义：bot 进入离线时聊天室显示状态变化 | 用户知道谁在干活 |
| 4 | bot「回来」语义：bot 完成时回到聊天室 | 回归可见 |
| 5 | 并行执行：多个 bot 可同时离线执行不同任务 | 并行不互阻 |
| 6 | 主 bot 等待：主 bot 等所有子 bot 完成后汇总 | 能等齐 |

**验收**：用户「@并发安全专家 去审计并发问题，@内存专家 去查内存泄漏」→ 2 bot 各自离线执行 → 聊天室显示进度 → 完成后回报。

---

### v0.30 — SubBotReport 协议 + 落盘 + 结果交付

| 项 | 内容 |
|---|---|
| 负责方 | Claude + CB |
| 工期 | 4 天 |
| 依赖 | v0.29 |

**任务清单**：

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 定义 SubBotReport 协议：slotId/dimension/summary(≤500字)/findings[]/evidenceRefs[]/transcriptPath | 接口定义完成 |
| 2 | 全文落盘：runs/<runId>/<slotId>.jsonl（逐条事件流） | 文件落盘可读 |
| 3 | 摘要进聊天室：bot 完成后，summary + findings 回聊天室（不灌全文） | 聊天室收摘要 |
| 4 | evidenceRefs 是指针（文件:行号/日志路径），不内联全文 | 按需拉取 |
| 5 | 主 bot 汇总：收齐所有子 bot 报告 → merge → 出综合报告 | 出汇总报告 |
| 6 | 汇总报告落盘：runs/<runId>/summary.md | 文件落盘可读 |

**验收**：子 bot 离线审计完成 → summary + findings 回聊天室 → 主 bot 收齐 → 出综合报告 → 落盘。

---

### v0.31 — PoC：审计会议

| 项 | 内容 |
|---|---|
| 负责方 | Claude + CB + 用户 |
| 工期 | 3-5 天 |
| 依赖 | v0.29~v0.30 |

**PoC 场景**：主 bot 在聊天室分发审计任务给 5 个子 bot，子 bot 离线审计后回报，主 bot 汇总。

**任务清单**：

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 5 个 audit-expert persona（维度不同：并发安全/内存/错误处理/边界/API 契约） | 5 persona 就绪 |
| 2 | 5 个隐藏窗口 + 5 个账号 | 5 bot 就绪 |
| 3 | 对照组：单 bot 串行审计 | 跑完有报告 |
| 4 | 实验组：主 bot 分发 → 5 bot 并行离线审计 → 回报 → 汇总 | 跑完有报告 |
| 5 | 量化对比：总耗时、发现 bug 数、误报率、汇总报告可用性 | 数据齐 |
| 6 | 达标判定 | 见门槛 |

**门槛**：总耗时多 Bot < 单 Bot 70%；发现 bug 数多 Bot ≥ 单 Bot；误报率多 Bot ≤ 单 Bot 1.2 倍；汇总报告人工评审「可直接使用」。

---

## 7. Phase 4：规模+治理 G3（v0.32~v0.34）

### v0.32 — 5+ bot + 人设热插拔 + 干净卸载

| 项 | 内容 | 工期 |
|---|---|---|
| 负责方 | Claude + CB | 5 天 |

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | SlotRuntime 热插拔：加载新人设前干净卸载旧人设 | 换人设不串味 |
| 2 | 卸载清理：上下文重置 + 工具视图回滚 + 记忆加载回滚 | 干净卸载 |
| 3 | 新建 dev-expert + summarizer persona | 3+ persona 可用 |
| 4 | 验证：S1 跑 audit-expert → 卸载 → 加载 dev-expert → 账号/窗口不变 | 热插拔闭环 |
| 5 | 聊天室成员动态进出：bot 加入/离开聊天室 | 动态管理 |

---

### v0.33 — Curator（冲突标记 + 遗忘 + 路由 + 审计回滚）

| 项 | 内容 | 工期 |
|---|---|---|
| 负责方 | CB（记忆层作者）+ Claude（触发调度） | 7 天 |

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | Curator 服务：定时批量扫描记忆层（不每条触发） | 服务能启动 |
| 2 | 写路径零放大模型：记忆写入不经 LLM | 零 LLM 调用 |
| 3 | 阈值唤醒：容量/时间/冲突阈值 | 触发可配 |
| 4 | 冲突检测 + 可信度层级裁决：冲突只标记不自动消解 | 冲突可标记 |
| 5 | 遗忘：过期自动标记 invalidAt + 低可信降权 | 过期失效 |
| 6 | 人设路由：personaTags 隔离，audit 记忆不污染 dev | 跨人设隔离 |
| 7 | 署名制 + 可回滚 + 审计链 | 可追溯 |
| 8 | 每 bot tokenBudget + 全局预算上限 | 超预算停 |

---

### v0.34 — 稳定性硬化

| 项 | 内容 | 工期 |
|---|---|---|
| 负责方 | Claude | 8 天 |

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 窗口冻结检测：标签页后台冻结 → bring_to_front | 冻结能唤醒 |
| 2 | 登录态过期检测 + 重新登录提示 | 过期能感知 |
| 3 | 限流冷却完善：rate-limited → 计时 + 到期恢复 + 任务排队 | 限流不丢任务 |
| 4 | 崩溃恢复：bot 进程异常 → 槽位回 idle + 任务可重派 | 崩溃不丢进度 |
| 5 | 长任务稳定性：120s+ 长命令不断流 | 长任务稳定 |
| 6 | 账号池调度：某账号不可用 → 自动切空闲账号 | 故障可切换 |

---

## 8. Phase 5：生产化 G4（v0.35~v0.38）

### v0.35 — Bot 管理 UI 树

| 项 | 工期 |
|---|---|
| Claude（UI）+ CB（数据绑定） | 8 天 |

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 账号视图：列表 + 状态 + 冷却倒计时 | 可看账号状态 |
| 2 | 槽位视图：列表 + 当前人设 + 状态 + runId | 可看槽位状态 |
| 3 | 人设视图：列表 + prompt 预览 + 工具白名单 | 可看人设详情 |
| 4 | 任务视图：列表 + 分配的槽位/人设 + 进度 + 报告 | 可看任务进度 |
| 5 | 聊天室视图：聊天室管理（创建/删除/邀请） | 可管理房间 |
| 6 | 实时状态推送：Bot 执行步骤经 WS 推到面板 | 实时更新 |
| 7 | 远程审批（复用 v0.20 PWA 基座） | 可远程审批 |

---

### v0.36 — 成本治理 + ApiEngine（OpenAI 兼容）

| 项 | 工期 |
|---|---|
| Claude | 7 天 |

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | ApiEngine 真实现：DeepSeek API（chat completions + function calling） | health() ok |
| 2 | OpenAI 兼容接口：统一 ModelEngine 抽象，API/Web 两种引擎可互换 | 双引擎可切换 |
| 3 | 第三方 LLM 接入：通过 OpenAI 兼容接口接其他模型 | 可接第三方 |
| 4 | 每 bot tokenBudget + 全局预算上限 | 超预算停 |
| 5 | 成本看板：实时 token 消耗 + 预算余额 + 预估日成本 | 可看成本 |
| 6 | Curator 治理批量/异步 | 低成本治理 |

---

### v0.37 — 多平台 + 安全加固

| 项 | 工期 |
|---|---|
| Claude | 7 天 |

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | 三平台回归（Windows/macOS/Linux） | 三平台跑通 |
| 2 | 账号凭证安全存储：API key / profile 不明文落盘 | 凭证加密 |
| 3 | 多 Bot 隔离：bot 间不可互读记忆（除非显式共享） | 隔离验证 |
| 4 | 安全审计：多 Bot 新攻击面（冒充/投毒） | 审计报告 |
| 5 | 日志脱敏：账号/凭证/key 不进日志 | 日志干净 |

---

### v0.38 — 生产版 GA

| 项 | 工期 |
|---|---|
| Claude + CB | 5 天 |

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | P0/P1 关闭 | 无 P0/P1 |
| 2 | 契约测试全过 | 全绿 |
| 3 | 三平台回归 | 全绿 |
| 4 | 安全审计终审 | 无高危 |
| 5 | 文档齐备：用户手册 + 部署指南 + 人设编写指南 | 文档完整 |
| 6 | 首次启动引导：配置账号池 + 选人设 + 配工作区 | 引导流程通 |

---

## 9. 依赖关系图

```
v0.21 记忆v2 ✅ ─┐
                  ├──► v0.25 SlotRuntime ──► v0.27 聊天室UI ──► v0.28 PoC ◀═══决策门
v0.22 Persona/Slot ✅┘           ▲                                         │
                                  │                                         │ 达标
v0.23 BotRegistry ──► v0.24 多窗口┘                                         │
                                  │                                         │
v0.26 聊天室数据层(CB) ────────────┘                                         │
                                                                              ▼
                              v0.29 长任务handler ──► v0.30 SubBotReport ──► v0.31 PoC审计
                                                                              │
                                                                              ▼
                              v0.32 热插拔 ──► v0.33 Curator ──► v0.34 稳定性硬化
                                                              │
                                                              ▼
                              v0.35 UI树 ──► v0.36 成本+API ──► v0.37 多平台 ──► v0.38 GA
```

**关键路径**：v0.23 → v0.24 → v0.25 → v0.27 → **v0.28（决策门）** → v0.29 → v0.30 → v0.31 → ... → v0.38

**可并行**：
- v0.23 ‖ v0.26（Claude ‖ CB）
- v0.24 ‖ v0.26（Claude ‖ CB）

---

## 10. 风险与决策门

### 10.1 硬决策门：v0.28 PoC 头脑风暴

| 门槛 | 不达标后果 |
|---|---|
| 视角覆盖：多 bot 覆盖 3 维度 | **停止整个计划** |
| 洞察数：多 bot ≥ 单 bot ×1.5 | **停止整个计划** |
| 用户满意度：主观评分「有用」 | **停止整个计划** |
| 互动质量：bot 间真实互相回应 | **停止整个计划** |

### 10.2 风险登记

| 风险 | 严重度 | 落点 | 缓解 |
|---|---|---|---|
| R1 价值证伪 | ⭐⭐⭐⭐⭐ | v0.28 | PoC 对照实验，硬决策门 |
| R2 账号稳定 | ⭐⭐⭐⭐ | v0.24/v0.34 | 1槽位:1账号:1窗口 + 健康检查 + 前台化 |
| R3 记忆污染 | ⭐⭐⭐⭐ | v0.33 | 署名制 + personaTags 路由 + 可回滚 |
| R4 上下文丢失 | ⭐⭐⭐ | v0.26 | Ekko 式快照+增量压缩 |
| R5 成本失控 | ⭐⭐⭐ | v0.36 | 写路径零 LLM + tokenBudget + 全局预算 |

### 10.3 最难卡点

| 卡点 | 难度 | 落点 | 性质 |
|---|---|---|---|
| 多窗口寻址 | ⭐⭐⭐⭐ | v0.24 | 全网页路径强制要求，状态机管理 |
| 上下文同步 | ⭐⭐⭐⭐ | v0.26 | Ekko 式快照+增量压缩解决，但有调参 |
| 发言调度 | ⭐⭐⭐ | v0.27 | @路由 + handoff，工程可解 |
| 人设热插拔干净卸载 | ⭐⭐⭐⭐ | v0.32 | 上下文/记忆/工具视图都要回滚 |
| 冲突消解 | ⭐⭐⭐⭐⭐ | v0.33 | 无 ground truth，只标记不裁决 |

---

## 11. 双人分工总表

| 版本 | Claude（主开发） | CodeBuddy（副开发） |
|---|---|---|
| v0.21~v0.22 | — | ✅ 已交付（记忆层 v2 + Persona/Slot） |
| v0.23 | ✅ AgentLoop 去单例 + BotRegistry | — |
| v0.24 | ✅ 多窗口寻址 | — |
| v0.25 | ✅ SlotRuntime + 人设白名单 + Scheduler 接入（已交付，21 测试过） | — |
| v0.26 | — | ✅ 聊天室数据层（消息存储+上下文引擎+房间摘要+@解析） |
| v0.27a | ✅ 人设指令模板（`instructions.ts`） | ⏳ 路由 + 接力 + 轮次编排（见 §5.1a） |
| v0.27 | ⏳ UI + 接线 + 真摘要器 | — |
| v0.28 | PoC 协同 | PoC 协同 |
| v0.29~v0.30 | 长任务 + SubBotReport | 协同 |
| v0.32 | 热插拔 | — |
| v0.33 | 触发调度 | Curator 完整治理 |
| v0.34 | 稳定性硬化 | — |
| v0.35 | UI 树 | 数据绑定 |
| v0.36 | 成本治理 + ApiEngine | — |

**交接面**：`src/host/bot/types.ts`。接口签名锁定后不随意改，需改时走 PR + description。

---

## 12. 与现有版本体系衔接

| 版本 | 状态 | 与本路线图关系 |
|---|---|---|
| v0.1~v0.20 | ✅ 已交付 | 单对话宿主 + 自建聊天 UI（基座） |
| v0.21~v0.22 | ✅ CB 已交付 | Bot 基础设施（记忆层 + Persona/Slot） |
| v0.23~v0.24 | ✅ Claude 已交付（2026-10-14） | AgentLoop 去单例 + BotRegistry + 多窗口寻址 |
| v0.26 | ✅ CB 已交付（2026-10-14） | 聊天室数据层 |
| v0.27a | ⏳ CB 进行中 | 人设指令模板（Claude 已交付 `instructions.ts`）；路由/接力/编排 CB 待做 |
| v0.25 | ✅ Claude 已交付（2026-10-14） | SlotRuntime + 人设白名单 + Scheduler 接入（21 测试过） |
| v0.27+ | ⏳ Claude 待开发 | 聊天室 UI + 接线、真摘要器（依赖 v0.27a CB 算法层） |

> v0.19/0.20 自建聊天 UI 是聊天室 UI 的基座——v0.27 在其上扩展多参与者标识 + @路由。

---

## 13. 工期汇总

| 阶段 | 版本 | 日历日 | 累计 | 决策门 |
|---|---|---|---|---|
| Phase 0 | v0.21~v0.22 | ✅ 0 | 0 | 无 |
| Phase 1 | v0.23~v0.25 | ~12 | 12 | 无 |
| Phase 2 | v0.26~v0.28 | ~14 | 26 | **v0.28 硬** |
| Phase 3 | v0.29~v0.31 | ~12 | 38 | 软 |
| Phase 4 | v0.32~v0.34 | ~20 | 58 | 软 |
| Phase 5 | v0.35~v0.38 | ~25 | 83 | 无 |

**关键节点**：
- **第 12 天**：多窗口 + Bot 实例化跑通
- **第 26 天：v0.28 决策点**——聊天室 PoC 达标则继续
- **第 38 天**：任务分发 PoC
- **第 58 天**：规模 + 治理完整
- **第 83 天**：生产版 GA

> 实际 ×1.5 ≈ 125 天。最大不确定性在 v0.28。

---

*文档结束。CB 下发路线图见 `docs/codebuddy/路线图-CodeBuddy-聊天室数据层-20261014.md`。*
