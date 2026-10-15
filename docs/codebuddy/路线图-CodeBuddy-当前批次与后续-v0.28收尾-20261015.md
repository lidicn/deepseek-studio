# CodeBuddy 路线图与当前批次任务（v0.28 PoC 收尾 → v0.29）

> 下发：2026-10-15（主开发 Claude）
> 基线：总路线图 `docs/架构文档/路线图-Bot平台-v0.21-v0.38-20261014.md`
> 你的分支：`feat/bot-data`
> 你已交付：v0.21 记忆层 v2 + v0.22 Persona/Slot + v0.26 聊天室数据层 + v0.27a 路由/接力/编排算法层（commit c8207be）
> Claude 已交付：v0.23 BotRegistry + v0.24 多窗口 + v0.25 SlotRuntime + v0.27 聊天室接线 + v0.28 PoC 互动质量+视角覆盖双门槛达成

---

## 0. 当前进度全景

| 版本 | 内容 | 谁做 | 状态 |
|---|---|---|---|
| v0.21 记忆层 v2 | SQLite+FTS5 | CB | ✅ |
| v0.22 Persona/Slot | 注册表+铁律 | CB | ✅ |
| v0.23 BotRegistry | AgentLoop 去单例 | Claude | ✅ |
| v0.24 多窗口寻址 | 隐藏 WebviewWindow | Claude | ✅ |
| v0.25 SlotRuntime | 人设注入+Scheduler | Claude | ✅ |
| v0.26 聊天室数据层 | 消息存储+上下文+摘要+@解析 | CB | ✅ |
| v0.27a 路由/接力/编排 | mention-router/handoff-parser/round-orchestrator | CB | ✅ |
| v0.27 聊天室接线 | chat-room-runtime + 真机 dry run | Claude | ✅ |
| **v0.28 PoC** | 头脑风暴决策门 | 两人 | 🔄 互动质量+视角覆盖✅ / 洞察数+满意度⏳ |
| **v0.28 收尾** | **聊天室事件结构化推送** | **CB** | **⏳ 你的当前批次** |
| v0.28 UI | 聊天室 UI（悬浮按钮+独立 overlay） | Claude | 🔄 进行中（Claude 正在做） |
| v0.29 | 长任务 handler + 离线执行 | 两人 | ⏳ |

**你当前空闲，下面是你的当前批次任务。**

---

## 1. 分工边界（严格遵守）

| 层 | 谁碰 | 文件范围 |
|---|---|---|
| 数据/算法层（消息存储、上下文、摘要、@解析、路由、接力、编排） | **CB** | `src/host/bot/` 下 |
| 宿主接线层（desktop-host、agent-channel、agent-loop、web-engine） | **Claude** | `src/host/` 下（非 bot/） |
| UI 层（聊天室 UI、侧栏、面板） | **Claude** | `src/ui/` + `src/desktop/` |
| Tauri/Rust 层 | **Claude** | `src-tauri/` |

**本次你只碰 `src/host/bot/` 下的文件 + `src/host/desktop-host.ts` 的一行 hook 接线。** 不碰 UI、不碰 agent-channel 的 WS 协议、不碰 Rust。

---

## 2. 你的当前批次：聊天室事件结构化推送（v0.28 收尾）

### 2.1 背景：为什么需要这个

PoC 跑通了，但有两个缺口卡住门槛 #6（洞察数对照）和 #7（用户满意度），都需要结构化的事件：

1. **`onBotReply` 是 no-op**：当前 `desktop-host.ts:710` 的 `onBotReply` 是空函数。聊天室 UI 收到的是**原始 AgentLoop 事件**（`user`/`status`/`assistant`/`done`），其中 `user` 事件携带的是内部 sentinel+persona 文本，不是用户原文。UI 需要一个**结构化、干净的 bot 回复事件**（带 roomId + persona + botId + senderType + content），才能干净渲染。

2. **无多房间事件隔离**：`agent-channel.ts` 的 `broadcast()` 把所有 bot 事件 fan-out 到所有 socket，**没有 roomId 过滤**。单房间 PoC 够用，但 Claude 正在做的聊天室 UI 需要能区分「这条事件属于哪个房间」——否则日常对话（main bot）的事件会混进聊天室 UI。

### 2.2 你要做的三件事

#### 任务 A：`onBotReply` 结构化推送落地（核心）

**现状**：`chat-room-runtime.ts:338` 已经调 `onBotReply?.({ roomId, persona, botId, senderType, content })`，但 `desktop-host.ts:710` 把它接成了 no-op。

**你要做**：让 `onBotReply` 经 `agentListeners` 推一个**结构化事件**到 WS。具体：

1. 定义新的结构化事件类型（加到 `src/host/agent-loop.ts` 的 `AgentEventType` 或新开一个 `ChatRoomEvent` 类型）：
   ```ts
   // 方案 A（推荐）：扩展 AgentLoopEvent，加 chat-room 专用事件
   type AgentEventType = 'user' | 'assistant' | 'tool' | 'status' | 'error' | 'done'
     | 'chat-bot-reply'   // 结构化 bot 回复
     | 'chat-summary';    // 结构化摘要
   ```
   或方案 B（更干净）：新开 `ChatRoomEvent` 类型，不走 `AgentLoopEvent`，在 `agent-channel.ts` 单独 broadcast。**你选，但要让 Claude 知道你的选择**（影响 UI 怎么收）。

2. `onBotReply` 回调里：把 `{ roomId, persona, botId, senderType, content }` 包成结构化事件 emit 出去。

3. 摘要器输出也推一个结构化事件（`createModelSummarizer` 的结果当前只在 runtime 内部用，没推出去）。

**约束**：你在 `src/host/bot/` 下定义事件类型 + 在 `chat-room-runtime.ts` 里把数据准备好。`desktop-host.ts:710` 的 no-op → emit 接线是 Claude 的接线层活，你写交接单提需求即可。**你不改 `desktop-host.ts` / `agent-channel.ts` / `agent-loop.ts`**。

#### 任务 B：多房间事件隔离（给 AgentLoopEvent 加 roomId）

**现状**：`AgentLoopEvent`（`agent-loop.ts:39`）没有 `roomId` 字段。bot 的 daily 对话和聊天室对话的事件混在一起。

**你要做**：
1. `AgentLoopEvent` 加可选 `roomId?: string`。
2. `AgentLoop.send()` 里：当本次 send 是聊天室驱动的（经 `chat-room-runtime.generateReply` 调来的），emit 的事件带上 roomId。
3. 聊天室 UI（Claude 做）据此过滤：只渲染 `event.roomId === 当前房间` 的事件。

**约束**：`agent-loop.ts` 是 Claude 的接线层文件，**你不直接改它**。你在 `src/host/bot/types.ts` 定义 `roomId` 需求，写交接单提给 Claude，Claude 在 `agent-loop.ts` 加字段 + 在 send 路径带上 roomId。你在 `chat-room-runtime.ts` 的 `generateReply` 调用链里确保传 roomId 上下文可供 Claude 接。

#### 任务 C：洞察数对照的数据层支撑（PoC 门槛 #6）

PoC 门槛 #6 要求「多 bot 洞察数 ≥ 单 bot ×1.5」。需要：
1. 单 bot 对照组跑完一轮 → 记录 assistant 回复的「洞察数」（人工评审或启发式计数）。
2. 多 bot 跑完一轮 → 同样记录。
3. 对照。

**你要做**：在 `ChatMessageStore` 加一个 `tagInsights(roomId, messageId, count, reviewer)` 方法，或更简单——加一个 `insights` JSON 列到 chat_messages 表，让 Claude 的 UI / 评审脚本能给每条 bot 回复打洞察数标签，存下来供对照统计。

**这是轻量活**，主要是给 chat_messages 加一列 + 读写方法。如果你觉得 A+B 工作量已够，C 可以推迟。

### 2.3 文件清单

| 文件 | 动作 | 内容 | 谁改 |
|---|---|---|---|
| `src/host/bot/types.ts` | 小改 | 新 `ChatRoomEvent` 类型（任务 A） | **CB** |
| `src/host/bot/chat-room-runtime.ts` | 小改 | `onBotReply` 数据 shape 已有（:338），摘要器结果也包装成结构化事件返回 | **CB** |
| `src/host/bot/chat-room-store.ts` | 小改 | chat_messages 加 insights 列 + 读写（任务 C，可选） | **CB** |
| `tests/desktop/bot-chat-room-event.test.ts` | 新建 | 结构化事件 shape 单测 | **CB** |
| `src/host/agent-loop.ts` | 小改 | `AgentLoopEvent` 加 `roomId?`（任务 B） | **Claude**（接线层，CB 写交接单提需求） |
| `src/host/desktop-host.ts` | 小改 | `onBotReply` no-op → emit 结构化事件到 agentListeners | **Claude**（接线层，CB 写交接单提需求） |
| `src/host/agent-channel.ts` | 不改 | broadcast 已 fan-out，结构化事件自动到 WS | — |

**边界说明**：CB 在 `src/host/bot/` 下定义事件类型 + 在 `chat-room-runtime.ts` 里把数据准备好（`onBotReply` 的 payload 和摘要器的结果包装）。但 `desktop-host.ts:710` 的 no-op → 实际 emit 接线、`agent-loop.ts` 的 `AgentLoopEvent` 加 `roomId`——这两处是**宿主接线层**，归 Claude。CB 写交接单把需求提清楚，Claude 接。

### 2.4 验收标准（CB 侧）

- `tsc --noEmit` 0 错误（含你定义的新类型）
- 新增测试全过（结构化事件 shape、摘要器结果包装）
- `chat-room-runtime.ts` 里 `onBotReply` 调用点的 payload 字段齐全（roomId/persona/botId/senderType/content）
- 摘要器结果有结构化包装（供 Claude 的 desktop-host emit）
- 全量回归无新失败

### 2.5 衔接面（写交接单给 Claude）

完成后写交接卡到 `docs/交接单/`，告诉 Claude 需要**在接线层做什么**：
- 新 `ChatRoomEvent` 的类型定义和 exact shape
- `chat-room-runtime.ts` 的 `onBotReply` payload 现在长什么样
- 摘要器结果包装成什么 shape 供 emit
- 提需求：Claude 在 `desktop-host.ts:710` 把 no-op 换成 emit `ChatRoomEvent` 到 `agentListeners`
- 提需求：Claude 在 `agent-loop.ts` 给 `AgentLoopEvent` 加 `roomId?`，聊天室驱动的 send 带上 roomId
- Claude 的聊天室 UI 据此收 `ChatRoomEvent` 渲染气泡/摘要、按 `roomId` 过滤

---

## 3. 你后续的任务（预告，不是现在做）

| 版本 | 你的任务 | 时机 |
|---|---|---|
| v0.29 | 长任务离线执行的数据层（runs/ 目录 + 执行记录 + 重放） | v0.28 收尾完成后 |
| v0.30 | SubBotReport 协议落盘（runs/ 管理） | v0.29 完成后 |
| v0.33 | **Curator 完整治理**（冲突+遗忘+路由+审计回滚）——你的记忆层 v2 延伸 | v0.32 完成后 |
| v0.35 | UI 数据绑定 | v0.34 完成后 |

---

## 4. 分支与合流

- 继续 `feat/bot-data` 分支
- 完成后写交接卡 → Claude review → 合流
- 不碰 `feat/bot-core`（Claude 的分支，含聊天室 UI）

---

## 5. 你的启动清单

1. 读本文件 §2（你的任务）+ §2.2（三件事）
2. 读 `src/host/desktop-host.ts:710`（`onBotReply` no-op 现状）
3. 读 `src/host/bot/chat-room-runtime.ts:324-338`（`onBotReply` 调用点 + 数据 shape）
4. 读 `src/host/agent-loop.ts:37-49`（`AgentLoopEvent` 现状，要加 `roomId`）
5. 开工顺序：**任务 A（ChatRoomEvent 类型 + onBotReply 数据准备）→ 任务 C（insights 列，可选）→ 写交接单提需求给 Claude 接接线层（任务 B 的 roomId + onBotReply emit）**
6. Claude 正在并行做聊天室 UI（`src/ui/studio-chat-room.ts`），**你不碰 UI 文件**，但你的事件 shape 会直接影响 UI 怎么收——做完务必写交接单同步

---

*CB 当前空闲已分发任务。Claude 并行做聊天室 UI。两边靠交接单同步事件 shape。*
