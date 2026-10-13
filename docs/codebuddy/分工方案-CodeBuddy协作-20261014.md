# Bot 基础设施分工方案（Claude 主开发 + CodeBuddy 副开发）

> 日期：2026-10-14
> 基础：侦查报告（地基评估）+ Bot 功能完整计划书 + 三层解耦设计稿
> 决策：分支开发 + 定期集成；Claude 做核心引擎，CodeBuddy 做数据层

---

## 0. 为什么这样切

四块基础设施按依赖深度排序：

| 序 | 设施 | 依赖深度 | 谁做 |
|---|---|---|---|
| 1 | ApiEngine 真实现 | 深（需理解 ModelEngine 抽象 + AgentLoop 调用链） | **Claude** |
| 2 | AgentLoop 去单例 + BotRegistry | 深（核心改造，全局影响） | **Claude** |
| 3 | 记忆层 v2（SQLite+FTS） | 中（独立模块，接口明确） | **CodeBuddy** |
| 4 | Persona/Slot 注册表 | 浅（数据结构+扫描，可单独测） | **CodeBuddy** |

**原则**：依赖深、需全局理解的归主开发；相对独立、可单独验证的归副开发。交接点用接口契约锁定，降低集成冲突。

---

## 1. Claude（主开发）负责

### 1.1 ApiEngine 真实现（model-engine.ts）

当前 `createApiEngineStub()` 是 stub。需实现 `createApiEngine()`：
- 调 DeepSeek 官方 API（chat completions + function calling）
- 复用 `EngineSendResult` 接口（`content` + `toolCalls`）
- 支持并发（API 无多开概念，天然并行）
- API key 管理（keyRef → 从宿主 KV/环境变量取）

**关键文件**：`src/host/engine/model-engine.ts`
**依赖**：`EngineSendResult` 接口定义（在同文件或 types）、`AgentLoop` 如何调 engine
**工期**：3-5 天
**完成标志**：`createApiEngine().send(text)` 返回有效的 `EngineSendResult`，含 content + toolCalls

### 1.2 AgentLoop 去单例 + BotRegistry（agent-loop.ts + agent-channel.ts）

当前 `if (active) throw 'agent-busy'` 是核心阻塞。改造：
- `createAgentLoop` 已是工厂，去掉外层单例装配假设
- 引入 `BotInstance`：`{ id, loop, engine, persona, slotId }`
- `BotRegistry`：管理 N 个 `BotInstance` 生命周期（创建/查询/销毁）
- `agent-channel` 从「单 agent」改为「按 botId 路由」

**关键文件**：`src/host/agent-loop.ts`、`src/host/agent-channel.ts`
**工期**：5-7 天
**完成标志**：两个 `BotInstance` 可并行 `send()`，互不阻塞

---

## 2. CodeBuddy（副开发）负责

### 2.1 记忆层 v2（memory-store.ts 重写）

当前是扁平 JSON（`fs.writeFileSync` 全量重写）。升级为：
- 存储：SQLite（FTS5 全文检索）+ 可选向量索引
- 新增字段：`source`（来源）+ `confidence`（可信度）+ `validAt`/`invalidAt`（失效标记）+ `personaTags`（人设维度）+ `contentHash`（去重）
- 接口：`search(query)` 混合检索；`invalidate(id)` 失效而非删除；`listByPersona(tag)` 路由
- **保留** `formatForPrompt` 兼容现有系统提示词注入

**关键文件**：`src/host/memory-store.ts`
**工期**：7-10 天
**完成标志**：`search("并发 bug")` 返回相关记忆；`invalidate(id)` 后 `list()` 不返回该项但数据保留；`listByPersona("audit")` 只返回该人设记忆

### 2.2 Persona/Slot 注册表

按设计稿第 2 节的三层模型实现数据结构 + 扫描：
- `PersonaRegistry`：扫描 `personas/*/` 目录，加载 prompt.md + tools.json + memory/
- `SlotRegistry`：槽位 ↔ 账号 ↔ 人设 三层绑定
- `Scheduler.assign(slot, persona, task)`：槽位分配

**关键文件**：新建 `src/host/bot/persona-registry.ts`、`src/host/bot/slot-registry.ts`、`src/host/bot/scheduler.ts`
**依赖**：账号层（Account 接口，见设计稿 2.1）
**工期**：5-7 天
**完成标志**：`personaRegistry.load("audit-expert")` 返回完整人设包；`scheduler.assign({slot:'S1', persona:'audit-expert', task:{...}})` 不抛错

---

## 3. 交接点：接口契约

这是两人工作的**唯一耦合面**。Claude 先定义，CodeBuddy 按契约实现。

### 3.1 BotInstance（Claude 定义，CodeBuddy 喂数据）

```ts
// src/host/bot/types.ts（Claude 先建此文件）
interface BotInstance {
  id: string;
  loop: AgentLoop;        // Claude 实现
  engine: ModelEngine;    // Claude 实现（ApiEngine）
  persona: Persona;       // ← CodeBuddy 的 PersonaRegistry 产出
  slotId: string;         // ← CodeBuddy 的 SlotRegistry 产出
}
```

### 3.2 Persona（CodeBuddy 实现此接口）

```ts
// CodeBuddy 在 persona-registry.ts 实现此接口
interface Persona {
  name: string;            // 'audit-expert'
  prompt: string;         // prompt.md 内容
  tools: string[];         // tools.json 白名单
  memoryDir: string;       // memory/ 目录路径
}
interface PersonaRegistry {
  load(name: string): Promise<Persona>;
  list(): string[];
}
```

### 3.3 记忆层接口（CodeBuddy 实现此接口）

```ts
// CodeBuddy 在 memory-store.ts 实现此接口
interface MemoryStoreV2 {
  search(query: string, opts?: { personaTag?: string; limit?: number }): Promise<Memory[]>;
  invalidate(id: string): Promise<void>;
  listByPersona(tag: string): Promise<Memory[]>;
  formatForPrompt(memories: Memory[]): string;  // 兼容现有注入
}
```

**规则**：Claude 先建 `src/host/bot/types.ts` 放接口定义，CodeBuddy 拉取后实现。接口签名锁定后不随意改，需改时两人对齐。

---

## 4. 协调机制

### 4.1 分支策略

- Claude 在 `master` 或 `feat/bot-core` 分支开发
- CodeBuddy 在 `feat/bot-data` 分支开发
- 每完成一个设施 → PR → Code review（Claude 审 CodeBuddy 的，反之亦然）→ 合并

### 4.2 节奏

- **第 1 天**：Claude 先建 `types.ts` 接口契约 + 通知 CodeBuddy 拉取
- **第 1-3 天**：CodeBuddy 开始 Persona/Slot 注册表（最独立，不依赖 Claude 的进度）
- **第 3-5 天**：Claude 完成 ApiEngine；CodeBuddy 完成注册表，开始记忆层 v2
- **第 5-7 天**：Claude 完成 AgentLoop 去单例；第一次集成测试（CodeBuddy 的 Persona/Slot 喂进 Claude 的 BotInstance）
- **第 7-10 天**：CodeBuddy 完成记忆层；第二次集成测试
- **第 10 天后**：进入 G1-P3（Scheduler 调度 + 账号健康检查），两人协同

### 4.3 通信

- 接口变更：改 `types.ts` + 在 PR description 说明影响
- 集成问题：在 GitHub issue 记录，附复现步骤
- Claude 继续推进当前 UI 渲染优化主线，Bot 基础设施并行

---

## 5. 给 CodeBuddy 的启动清单

CodeBuddy 第一天要做的事：

1. `git clone` + `git checkout -b feat/bot-data`
2. 读四份文档（全在 `docs/codebuddy/` 和 `docs/架构文档/`）：
   - `docs/codebuddy/分工方案-CodeBuddy协作-20261014.md`（本文，你的任务清单）
   - `docs/架构文档/侦查报告-studio地基承载力评估-20261014.md`（地基现状）
   - `docs/架构文档/计划书-Bot功能完整版-20261014.md`（整体计划）
   - `docs/架构文档/设计稿-Bot编排-账号槽位人设三层解耦-20261014.md`（三层模型）
3. 读 `src/host/memory-store.ts`（当前实现）+ `src/host/engine/model-engine.ts`（Engine 接口参考）
4. 等 Claude 建好 `src/host/bot/types.ts`，拉取后按接口实现
5. 先做 Persona/Slot 注册表（最独立），后做记忆层 v2

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 接口契约改了对方不知道 | types.ts 改动必走 PR + description 说明 |
| CodeBuddy 不熟代码库踩坑 | 给启动清单 + 指定关键文件路径 |
| 两分支集成时冲突 | 接口契约先行，实现按契约，耦合面只有 types.ts |
| Bot 价值证伪（R1） | G1-P6 PoC 是硬决策门，过不了就停 |
