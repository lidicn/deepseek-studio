# Ekko Studio 群聊机制源码核实报告

> 日期：2026-10-14
> 方法：直接拉取 GitHub API + raw 源码（EKKOLearnAI/ekko-studio，main 分支）
> 目的：核实调研报告中 Ekko Studio 群聊机制的描述，为 deepseek-studio 的 Bot 聊天室设计提供源码级参考

---

## 0. 核实结论：Ekko Studio 是真的，群聊机制是源码级可证的

| 项 | 调研报告描述 | 核实结果 |
|---|---|---|
| 项目存在 | EKKOLearnAI/ekko-studio | ✅ HTTP 200，11,401 星，TypeScript+Vue，2026-04 创建 |
| 群聊机制存在 | Socket.IO + 房间 + @提及 + 上下文压缩 | ✅ 源码可证 |
| 多 Agent 运行时 | Hermes/Ekko/Coding 三家族 | ✅ `agent` 类型枚举含 16 种运行时 |
| @提及路由 | @某 Agent 才触发它回复 | ✅ `mention-routing.ts` 实现完整 |
| 上下文压缩 | 历史超 token 阈值自动摘要 | ✅ `context-engine/compressor.ts` 摘要+快照机制 |

---

## 1. Ekko Studio 的真实定位

**一个本地优先的多 Agent AI 工作区**（不是多账号浏览器自动化）。

- 描述原文：*"Ekko Studio is a local-first AI workspace for multi-agent chat, coding, and visual workflows, available on desktop and the web."*
- 技术栈：TypeScript(20M 行) + Vue(3M 行) + Python(534K 行)
- 官网：ekkostudio.xyz
- 许可：NOASSERTION（非标准 OSI 许可）

**关键区别**：Ekko 的 "Agent" 不是「浏览器里登录的网页账号」，而是**不同的 AI 运行时/CLI 进程**——Hermes、Claude Code、Codex、Pi、Grok、OpenCode 等。它管理的是「多个 CLI Agent 进程在一个聊天室里协作」，不是「多个浏览器窗口」。

---

## 2. 群聊调度机制（源码级）

### 2.1 Agent 类型枚举（16 种运行时）

```ts
// agent-clients.ts
agent?: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok'
      | 'opencode' | 'dsh' | 'cursor' | 'antigravity' | 'qwen'
      | 'kimi' | 'codebuddy' | 'qoder' | 'copilot' | 'zcode'
```

每种 agent 是一个独立的 CLI 进程或 API 调用路径，不是浏览器窗口。

### 2.2 @提及路由（核心调度入口）

```ts
// mention-routing.ts
export const ALL_AGENTS_MENTION = 'all'

// 核心函数：
isAgentMentioned(content, agentName)     // @前端专家 → 前端专家被点名
isAllAgentsMentioned(content)            // @all → 所有人被点名
resolveMentionTargets(agents, content)   // 解析消息里 @ 了谁
stripMentionRoutingTokens(content)       // 剥离 @ 标记，只留净内容
```

**调度逻辑**（从 `agent-clients.ts` 和 JEV 文档推断）：
1. 用户发消息 → `resolveMentionTargets` 解析 @ 了谁
2. **显式 @** → 只有被 @ 的 Agent 回复（优先级最高）
3. **@all 或无 @** → 所有 Agent 依次/并发回复
4. **handoff** → Agent A 把消息接力给 Agent B（`handoffChainId`）
5. **continuation** → 续跑（`continuationAttemptId`）
6. **智能分派**（JEV 可选增强）→ 没 @ 时推荐一个 Agent 回复

> 调研报告说的「串行轮次（同轮并发、轮间串行）」是 Hermes Bot Mode 的内部机制（调研报告 §2.3），不是 Ekko 工作区层。Ekko 工作区层的调度更灵活——按 @ 路由 + handoff + continuation 优先级排队。

### 2.3 上下文引擎（核心共享机制）

```ts
// context-engine/compressor.ts — ContextEngine.buildContext()
// 流程：
// 1. 读持久化快照（summary + lastMessageId）from SQLite
// 2. 有快照 → 收集新消息 → 估算 token = summary + 新消息
//    a. 不超阈值 → 原样返回
//    b. 超阈值 → 增量压缩（摘要新消息），更新快照，返回
// 3. 无快照 → 估算全部消息 token
//    a. 不超阈值 → 全量返回
//    b. 超阈值 → 全量压缩，存快照，返回
```

**关键设计**：
- **快照机制**：每个房间维护 `{ summary, lastMessageId }`，已摘要的旧消息不重复传
- **增量压缩**：只摘要快照之后的新消息，避免全量重算
- **per-room 压缩锁**：`_compressLocks` 防并发快照覆盖
- **token 估算**：`contextTokenEstimator` 可自定义（支持精确计数的 provider）
- **触发阈值**：`config.triggerTokens` 超过才压缩

### 2.4 人设注入（agent-prompt.ts）

```ts
buildAgentInstructions({
  agentName,         // "前端专家"
  roomName,          // "头脑风暴会议"
  agentDescription,  // 人设描述
  memberNames,       // 房间所有成员名（让 bot 知道有谁在场）
  members,           // 成员详情
})
```

每个 Agent 回复前，系统提示词里注入：你是谁、房间叫什么、房间里有谁、你的职责是什么。

### 2.5 房间摘要（room-summary.ts）

```ts
interface GroupRoomSummary {
  roomId: string
  summary: string                        // 压缩后的历史摘要
  summaryThroughMessageId: string       // 摘要到哪条消息为止
  summaryThroughMessageTimestamp: number
  summarizedTurnCount: number           // 已摘要的轮次数
  status: 'idle' | 'summarizing' | 'success' | 'failed'
  version: number                       // 版本号（CAS 并发控制）
  updatedAt: number
}
```

**租约 + CAS 机制**：摘要生成用 `claimRoomSummaryRun`（租约）+ `commitRoomSummaryRun`（CAS 提交），防止并发摘要互相覆盖。`summaryEveryTurns` 控制每 N 轮触发一次摘要。

### 2.6 Agent 间消息接力（agent-relay.ts）

```ts
type RelayRunRequest = {
  protocolVersion: 2
  runId: string
  room: { id, name, summaryProfile? }
  members: Array<{ userId?, id?, name, description? }>
  agents: Array<{ agentId?, id?, name, description? }>
  message: MentionMessage
  runtimeContext: GroupRuntimeContext     // ← 上下文（summary + history）
  attachments: RelayAttachment[]
  workspaceApi?: { token, access }        // 共享工作区
}
```

Agent 可以**跨实例接力**（remote relay）：一个 Studio 实例的 Agent 可以把消息 relay 到另一个实例的 Agent。`handoffChainId` 追踪接力链，`continuationAttemptId` 追踪续跑身份。

---

## 3. 与 deepseek-studio 的关键差异

| 维度 | Ekko Studio | deepseek-studio（你的构想） |
|---|---|---|
| Agent 本体 | CLI 进程 / API 调用 | **DeepSeek 网页窗口**（全网页路径） |
| 并发模型 | 天然多进程并发 | 受网页版单窗口限制 |
| 上下文存储 | SQLite（session 表 + 快照表） | 需自建（当前无） |
| Agent 通信 | Socket.IO + HTTP API | 需自建（当前 WS 是单 agent） |
| 人设隔离 | per-profile（`~/.hermes/profiles/`） | personas/ 目录（types.ts 已定义） |
| 工具调用 | 各 agent 自带（Claude Code/Codex 有自己的工具链） | 走 studio 统一授权链（已有） |
| 成本 | 各 agent 自带 API key | 网页版免费（但受风控） |

**核心启示**：Ekko 的群聊机制（@路由 + 上下文快照压缩 + 人设注入 + 房间摘要）是**运行时无关**的——它不关心 Agent 底层是 CLI 进程还是浏览器窗口。deepseek-studio 可以**借鉴这套调度和上下文机制**，只是把 Agent 底层从「CLI 进程」换成「DeepSeek 网页窗口/API」。

---

## 4. 可直接借鉴的 5 个机制

| # | 机制 | Ekko 源码位置 | 对 studio 的价值 |
|---|---|---|---|
| 1 | **@提及路由** | `mention-routing.ts` | 用户 @谁谁回，防全员乱说话 |
| 2 | **上下文快照+增量压缩** | `context-engine/compressor.ts` | 解决「网页版上下文有限」的痛点——旧消息摘要、新消息原样注入 |
| 3 | **人设指令注入** | `agent-prompt.ts` `buildAgentInstructions` | 每个 bot 回复前注入「你是谁、房间有谁、你的职责」 |
| 4 | **房间摘要 CAS** | `room-summary.ts` | 防并发摘要覆盖，版本控制 |
| 5 | **消息接力 handoff** | `agent-relay.ts` | bot 间传递任务（前端专家→后端专家） |

---

## 5. 修正调研报告的 3 个偏差

| 调研报告原文 | 实际核实 | 修正 |
|---|---|---|
| "实时通信基于 Socket.IO" | ✅ 准确 | 源码用 `socket.io` + `socket.io-client` |
| "上下文压缩：历史超 token 阈值时自动对话摘要" | ✅ 准确，但更复杂 | 不是简单摘要，是**快照+增量压缩**——已摘要的旧消息存快照，只压缩新消息 |
| "Hermes 群聊的串行轮次（同轮并发、轮间串行）" | ⚠️ 需区分 | 这是 **Hermes Bot Mode 内部**的机制，不是 Ekko 工作区层。Ekko 工作区层按 **@路由 + handoff + continuation** 调度，更灵活 |

---

## 6. 对 studio Bot 聊天室设计的直接启示

1. **调度模式选 @路由 + handoff**（不选串行轮次）——更灵活，用户可以 @指定，也可以 handoff 让 bot 间接力。Hermes 的串行轮次太死板（最多 3 轮 × 10 条），不适合头脑风暴这种开放讨论。

2. **上下文引擎是必做项**——这是解决「网页版上下文有限」的关键。studio 的网页 bot 各自窗口上下文有限，需要 Ekko 式的快照+增量压缩：旧消息摘要存盘，每次只注入「摘要 + 最近 N 条原文」。

3. **studio 的独特优势仍成立**——Ekko 的 Agent 是 CLI/API 进程，studio 的 Agent 是 DeepSeek 网页窗口 + 后续 API 兼容。ModelEngine 双引擎抽象让 studio 可以网页/API 混用，Ekko 做不到（它不管理浏览器窗口）。

4. **不需要照搬 Ekko 的远程 relay**——Ekko 的 `agent-relay.ts` 是跨 Studio 实例接力（多机协作），studio 单机多窗口不需要这层。

---

*报告结束。原始调研报告见 `docs/调研报告/bot机制与开源生态调研报告-20261014.md`。*
