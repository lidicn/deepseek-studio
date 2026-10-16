# CodeBuddy 路线图与开发计划（Bot 平台 v2 · 聊天室基石版）

> 下发：2026-10-14（主开发 Claude，v2 已更新——契约落盘）
> 基线：总路线图 `docs/架构文档/路线图-Bot平台-v0.21-v0.38-20261014.md`（v2 聊天室基石版）
> 你已交付：v0.21 记忆层 v2 + v0.22 Persona/Slot 注册表（分支 feat/bot-data，commit d568aff，44 测试全过）
> **契约已落盘**：`src/host/bot/types.ts` 已追加「聊天室数据层」接口节——**你直接 import 使用，不再需要本地类型草稿**
> **交接回复**：`docs/交接单/v0.26-聊天室数据层-回复单-20261014.md`（你的 9 个问题已逐条回复）

---

## 0. 范式转变（必读）

经多轮讨论，产品形态从「并行审计仪表盘」转向 **协作聊天室**：

- **聊天室是统一消息总线**——所有 bot 和用户挂在上面
- 聊天室同时是 **协作空间（头脑风暴）+ 任务面板（分发）+ 记录系统**
- 任务分发不是另一种模式，是聊天室上的「长任务消息类型」
- **先做聊天室（G1），后做任务分发（G2）**——聊天室是基石

你的第一批（记忆层 v2 + Persona/Slot）是 **Phase 0 基础设施**，已完成。接下来进入 **Phase 2 聊天室 G1 的数据层（v0.26）**，这是你能与 Claude 的 Phase 1（v0.23~v0.25）**并行**的独立任务。

详细背景见：
- `docs/架构文档/路线图-Bot平台-v0.21-v0.38-20261014.md`（总路线图 v2）
- `docs/调研报告/ekko-studio-源码核实报告-20261014.md`（**你的 v0.26 直接参考这个**）
- `docs/交接单/v0.26-聊天室数据层-回复单-20261014.md`（你的疑问已逐条回复）

---

## 1. 全局分工（你在哪）

| 版本 | 内容 | 谁做 | 你的状态 |
|---|---|---|---|
| v0.21 记忆层 v2 | SQLite+FTS5 | **CB** | ✅ 已交付 |
| v0.22 Persona/Slot | 注册表+铁律 | **CB** | ✅ 已交付 |
| v0.23 BotRegistry | AgentLoop 去单例 | Claude | ⏳ |
| v0.24 多窗口寻址 | 隐藏 WebviewWindow | Claude | ⏳ |
| v0.25 SlotRuntime | 人设注入+Scheduler 接入 | Claude | ⏳ |
| **v0.26 聊天室数据层** | **消息存储+上下文引擎+房间摘要+@解析** | **CB** | **⏳ 你的下一批** |
| v0.27 聊天室 UI | 路由+人设指令注入 | Claude | ⏳ |
| v0.28 PoC 头脑风暴 | 决策门 | 两人 | ⏳ |

---

## 2. 你的任务：v0.26 聊天室数据层

### 2.0 已锁定决策（不再需要问）

以下决策已在回复单中拍板，**不再变更，直接执行**：

| 项 | 决策 |
|---|---|
| 契约 | ✅ types.ts 已追加聊天室数据层接口，你直接 import，**不需要本地草稿** |
| 分支 | ✅ 继续 `feat/bot-data` |
| DB 复用 | ✅ 方案 A：MemoryStore 加 `getDb(): DatabaseSync \| null` + `isInMemoryFallback(): boolean`，ChatMessageStore 复用同一连接建表 |
| 摘要器 | ✅ v0.26 留桩（计数器），不接 ModelEngine；真实摘要 v0.27 由 Claude 接 |
| systemPrompt | ✅ string，只放 summary；`PersonaInjector` 钩子已预留（v0.27 接） |
| 消息 FTS5 | ✅ 不做，按 id/范围查询 |
| 聚合门面 | ✅ 不聚合，四个类各自独立 |
| id 格式 | ✅ `msg-<base36时间戳>-<6位随机>`（与 Memory.id 同款） |
| timestamp | ✅ `Date.now()`（毫秒） |
| participantId | ✅ 填 **persona 名**（如 `audit-expert`），不填 botId |
| 测试 DB | ✅ 临时文件为主 + 内存降级另跑一组 |
| 衔接面 | ✅ 只限 types.ts，不碰 agent-loop/channel/desktop-host/web-engine |
| 你碰的文件 | ✅ `src/host/bot/` 下新建 + 小改 `memory-store.ts`（加 getDb） |

### 2.1 直接参考：Ekko Studio 源码

**务必先读** `docs/调研报告/ekko-studio-源码核实报告-20261014.md`——你的 v0.26 借鉴 Ekko 的 4 个机制：

| 机制 | Ekko 源码位置 | 你要做什么 |
|---|---|---|
| @解析 | `mention-routing.ts`：`resolveMentionTargets` / `stripMentionRoutingTokens` / 边界判断 | `MentionParser` |
| 上下文引擎 | `context-engine/compressor.ts`：快照+增量压缩+per-room 锁 | `ContextEngine` |
| 房间摘要 | `room-summary.ts`：CAS 租约 + claim/commit/renew | `RoomSummaryService` |
| 人设指令 | `agent-prompt.ts`：`buildAgentInstructions` | **Claude v0.27 做**，你只预留钩子 |

### 2.2 你要实现的 4 个接口（已在 types.ts 锁定）

```ts
// 直接 import type { ... } from './types'，不要自己定义

// 消息存储
ChatMessageStore: {
  append(msg: Omit<ChatMessage,'id'> & { id?: string }): ChatMessage;
  getMessages(roomId: string, opts?: { throughMessageId?: string; limit?: number }): ChatMessage[];
  count(roomId: string): number;
}

// 上下文引擎
ContextEngine: {
  buildContext(input: {
    roomId: string; agentName: string; currentMessageId: string;
    personaInjector?: PersonaInjector;   // v0.27 接，v0.26 可选
    roomName?: string; agentDescription?: string; memberNames?: readonly string[];
  }): Promise<ChatContext>;
  getSnapshot(roomId: string): ChatContextSnapshot | null;
}

// 房间摘要
RoomSummaryService: {
  summarize(roomId: string): Promise<void>;
  getSummary(roomId: string): ChatContextSnapshot | null;
}

// @解析（纯算法）
MentionParser: {
  resolveMentions(content: string, participants: ReadonlyArray<{name:string; id?:string}>): StructuredMention[];
  stripMentionTokens(content: string, participants: ...): string;
  isAllMentioned(content: string): boolean;
}
```

**复用的类型**（已在 types.ts 定义）：
- `ChatMessage` / `ChatContextSnapshot` / `ChatContext`
- `StructuredMention` / `ChatSenderType` / `ChatSummarizer` / `PersonaInjector`

### 2.3 文件清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/host/bot/mention-parser.ts` | 新建 | `MentionParser` 实现：@all/@具体名解析，CJK/emoji 边界（参考 Ekko `isBeforeBoundary`/`isAfterBoundary`） |
| `src/host/bot/chat-room-store.ts` | 新建 | `ChatMessageStore` 实现：SQLite 建表 chat_messages + append/getMessages/count + 降级内存 |
| `src/host/bot/context-engine.ts` | 新建 | `ContextEngine` 实现：快照+增量压缩+per-room 锁+桩摘要器 |
| `src/host/bot/room-summary.ts` | 新建 | `RoomSummaryService` 实现：CAS 租约 + claim/commit/renew |
| `src/host/memory-store.ts` | 小改 | 加 `getDb()` + `isInMemoryFallback()`（非破坏性扩展） |
| `tests/desktop/bot-mention-parser.test.ts` | 新建 | @all/@具体/CJK 边界/剥离 |
| `tests/desktop/bot-chat-room-store.test.ts` | 新建 | append/getMessages/count/降级 |
| `tests/desktop/bot-context-engine.test.ts` | 新建 | 快照命中/未命中/增量不重算/压缩锁 |
| `tests/desktop/bot-room-summary.test.ts` | 新建 | CAS 并发不覆盖/租约过期恢复 |

### 2.4 任务清单（细颗粒度，按开工顺序）

#### 第 1 步：MentionParser（最独立，纯算法）

| # | 任务 | 完成标志 |
|---|---|---|
| 1 | `resolveMentions(content, participants)`：遍历 participants，对每个 name 调 `findMentionRanges` 找 @位置 | 返回 StructuredMention[] |
| 2 | `@all` 检测：`isAllMentioned(content)` 判断是否含 `@all`（大小写不敏感） | bool |
| 3 | `stripMentionTokens(content, participants)`：把 @标记替换为空，留净内容 | 净内容 |
| 4 | CJK/emoji 边界判断：参考 Ekko `isBeforeBoundary`（前面非 `[a-zA-Z0-9_]`）+ `isAfterBoundary`（后面空白或标点） | 中文 @能命中，英文前缀不误命中 |
| 5 | 引用块屏蔽：Ekko 用 `maskQuotedMessageBlocks` 把 `<quoted_message>` 块内 @ 不解析 | 引用块内 @ 被忽略 |
| 6 | 单测：`@前端专家 你怎么看` → `[{type:'agent', participantId:'前端专家'}]` | npm test 绿 |
| 7 | 单测：`@all 大家说说` → `[{type:'all'}]` | npm test 绿 |
| 8 | 单测：`邮箱admin@x.com` → 不误命中 | npm test 绿 |

#### 第 2 步：MemoryStore 扩展 + ChatMessageStore

| # | 任务 | 完成标志 |
|---|---|---|
| 9 | MemoryStore 加 `getDb(): DatabaseSync \| null`（返回内部 db 句柄，降级时 null） | getDb() 可用 |
| 10 | MemoryStore 加 `isInMemoryFallback(): boolean` | 可查降级状态 |
| 11 | ChatMessageStore 构造时传入 MemoryStore，复用 getDb() 建表 | 共享 db 连接 |
| 12 | `CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PK, room_id, sender_id, sender_type, content, timestamp, mentions_json)` | 表建好 |
| 13 | `append(msg)`：生成 id（`msg-<base36>-<6随机>`）+ 存 mentions 的 JSON + 插入 + 返回 ChatMessage | 消息可存 |
| 14 | `getMessages(roomId, {throughMessageId, limit})`：按 timestamp 排序，取到 throughMessageId 为止（含），limit 截断 | 范围查询正确 |
| 15 | `count(roomId)` | 总数正确 |
| 16 | 降级模式：getDb()=null 时用内存数组实现同样接口 | 降级不崩 |
| 17 | 单测：append 返回的 id 符合 `msg-` 前缀格式 | npm test 绿 |
| 18 | 单测：getMessages throughMessageId 范围正确 | npm test 绿 |
| 19 | 单测：降级模式下 append/getMessages 仍工作 | npm test 绿 |

#### 第 3 步：ContextEngine

| # | 任务 | 完成标志 |
|---|---|---|
| 20 | 构造注入 `messageStore` + `summarizer` + `config`（triggerTokens 默认 4000） | 可构造 |
| 21 | `buildContext` 路径 A（有快照）：读快照→取快照后新消息→估算 token(summary+新消息)→不超阈值原样返回 | 快照命中 |
| 22 | `buildContext` 路径 B（无快照）：估算全部消息 token→不超阈值全量返回→超阈值调 summarizer 全量压缩 | 全量压缩 |
| 23 | `buildContext` 路径 A 增量：超阈值时只压缩快照后新消息（调 summarizer），更新快照 version+1，返回 | 增量不重算 |
| 24 | per-room 压缩锁：`_compressLocks = Map<roomId, Promise>`，防并发快照覆盖 | 并发安全 |
| 25 | `buildContext` 返回 ChatContext：systemPrompt=summary（personaInjector 为空时），messages=注入序列，meta 四字段 | 契约返回值 |
| 26 | personaInjector 非空时：systemPrompt = personaInjector({...,summary}) | 钩子可接入 |
| 27 | `getSnapshot(roomId)`：返回快照或 null | 诊断可用 |
| 28 | 单测：有快照且不超阈值 → 返回 summary+新消息，不调 summarizer | npm test 绿 |
| 29 | 单测：第二次 buildContext（同一房间同范围）→ 不重算已摘要部分（summarizer 桩计数=0 新调用） | npm test 绿 |
| 30 | 单测：超阈值 → 调 summarizer，快照 version+1 | npm test 绿 |
| 31 | 单测：并发 buildContext 同房间 → 压缩锁生效（summarizer 只调一次） | npm test 绿 |

#### 第 4 步：RoomSummaryService

| # | 任务 | 完成标志 |
|---|---|---|
| 32 | `summarize(roomId)`：claim 租约（token + leaseExpiresAt）→ 调 ContextEngine summarizer → commit（CAS version 校验） | 摘要可生成 |
| 33 | claim 失败（已有租约）→ 不覆盖，等租约或返回 | 并发不覆盖 |
| 34 | 租约过期恢复：`recoverExpiredLease(roomId, now)` → 过期租约可被新 claim 接管 | 过期可恢复 |
| 35 | commit CAS：`saveSnapshotIfCurrent(snapshot, expectedVersion)` 版本不匹配则放弃 | CAS 生效 |
| 36 | `getSummary(roomId)`：返回当前快照 | 诊断可用 |
| 37 | `summaryEveryTurns` 配置：每 N 轮触发一次（由调用方判断，服务只管 claim/commit） | 可配 |
| 38 | 单测：并发 summarize 同房间 → 只一个成功 commit，其余放弃 | npm test 绿 |
| 39 | 单测：租约过期后新 summarize 可接管 | npm test 绿 |
| 40 | 单测：CAS 版本不匹配 → commit 放弃不覆盖 | npm test 绿 |

### 2.5 桩摘要器约定

v0.26 不接 ModelEngine。用桩：

```ts
export function defaultStubSummarizer(messages: readonly ChatMessage[]): Promise<string> {
  // 桩：返回可识别固定串，测试可断言调用次数+传入范围
  const first = messages[0]?.id ?? '';
  const last = messages.at(-1)?.id ?? '';
  return Promise.resolve(`[stub-summary:${messages.length}msgs:${first}..${last}]`);
}
```

真实摘要（接 ModelEngine）由 Claude v0.27 接入，你只需保证 `summarizer` 是可注入的构造参数。

### 2.6 约束（严格遵守）

- ✅ **不改 types.ts 的已有接口**（聊天室接口已由 Claude 定义，你只实现不改）
- ✅ 不碰 `agent-loop.ts` / `agent-channel.ts` / `desktop-host.ts` / `web-engine.ts`
- ✅ 只在 `src/host/bot/` 下新建 + 小改 `memory-store.ts`（加 getDb/isInMemoryFallback）
- ✅ DB 复用 MemoryStore 的连接，不另开 db 文件
- ✅ 降级路径：复用 MemoryStore 的内存降级机制
- ✅ 验收：`tsc --noEmit` 0 错误；新增测试全过；全量回归无新失败

### 2.7 验收标准

- `tsc --noEmit` 0 错误
- 新增测试全过（预估 ~25 用例：mention 8 + store 4 + context 4 + summary 3 + 边界 6）
- 全量回归不引入新失败
- `buildContext(roomId, 'audit-expert', msgId)` 返回 ChatContext，meta 四字段齐
- `resolveMentions("@前端专家", [{name:'前端专家'}])` 返回 `[{type:'agent',participantId:'前端专家'}]`
- 并发 buildContext 同房间 → 压缩锁生效
- 并发 summarize 同房间 → CAS 只一个成功

### 2.8 工期

5-7 天。可与 Claude 的 v0.23~v0.25 并行。

---

## 3. 你后续的任务（预告，不是现在做）

| 版本 | 你的任务 | 时机 |
|---|---|---|
| v0.28 | PoC 协同（准备 persona 包、测试数据） | v0.26 完成后 |
| v0.30 | SubBotReport 协议落盘部分（runs/ 目录管理） | v0.29 完成后 |
| v0.33 | **Curator 完整治理**（冲突标记+遗忘+路由+审计回滚）——你的记忆层 v2 的延伸 | v0.32 完成后 |
| v0.35 | UI 数据绑定 | v0.34 完成后 |

**v0.33 Curator 是你后面的大活**——基于你的记忆层 v2，做阈值唤醒 + 冲突检测 + 遗忘 + 署名 + 回滚。现在不用管，知道方向即可。

---

## 4. 分支与合流

- 继续在 `feat/bot-data` 分支开发
- v0.26 完成后写交接卡（同你第一批格式）→ Claude review → 合流
- 耦合面只有 `src/host/bot/types.ts`（你只实现不改）
- 接口签名锁定后不随意改，需改时走 PR + description

---

## 5. 你的启动清单

1. 读 `docs/交接单/v0.26-聊天室数据层-回复单-20261014.md`（你的 9 个问题已回复）
2. 读 `docs/调研报告/ekko-studio-源码核实报告-20261014.md`（4 个机制源码级说明）
3. 读 `src/host/bot/types.ts` 的「聊天室数据层」接口节（**直接 import 用，不自己定义**）
4. 小改 `src/host/memory-store.ts`：加 `getDb()` + `isInMemoryFallback()`
5. 开工顺序：**MentionParser → ChatMessageStore → ContextEngine → RoomSummaryService**（每个做完带测试）

---

*文档结束。契约已锁定，疑问已回复，你可以开工了。*
