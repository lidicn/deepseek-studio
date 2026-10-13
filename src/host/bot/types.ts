/**
 * Bot 基础设施接口契约（Claude 主开发定义，CodeBuddy 按此实现）
 *
 * 这是 Claude（核心引擎）与 CodeBuddy（数据层）的唯一交接面。
 * 接口签名锁定后不随意改；需改时走 PR + description 说明影响。
 *
 * 谁实现什么：
 *   - Claude 实现：BotInstance（含 loop + engine）、BotRegistry
 *   - CodeBuddy 实现：Persona、PersonaRegistry、Slot、SlotRegistry、MemoryStoreV2
 *
 * 详见 docs/codebuddy/分工方案-CodeBuddy协作-20261014.md
 */

import type { AgentLoop } from '../agent-loop';
import type { ModelEngine } from '../engine/model-engine';

// ===== Persona 层（CodeBuddy 实现）=====

/** 人设包：提示词 + 工具白名单 + 专属记忆目录。对应 personas/<name>/ 结构。 */
export interface Persona {
  /** 人设名，如 'audit-expert'。对应 personas/ 目录下的子目录名。 */
  readonly name: string;
  /** 系统提示词（personas/<name>/prompt.md 内容）。 */
  readonly prompt: string;
  /** 工具白名单（personas/<name>/tools.json），空数组表示继承全部工具。 */
  readonly tools: readonly string[];
  /** 专属记忆目录绝对路径（personas/<name>/memory/）。 */
  readonly memoryDir: string;
}

/** 人设注册表：扫描 personas/ 目录加载人设包。CodeBuddy 实现。 */
export interface PersonaRegistry {
  /** 加载指定人设包；不存在时抛错。 */
  load(name: string): Promise<Persona>;
  /** 列出所有可用人设名。 */
  list(): string[];
}

// ===== Slot 层（CodeBuddy 实现）=====

/** 账号（凭证层，长期稳定）。对应设计稿 2.1。 */
export interface Account {
  readonly id: string;              // A1..A5
  readonly kind: 'web' | 'api';
  /** 网页版：浏览器 profile 目录；API：keyRef。 */
  readonly loginRef: string;
  status: 'ready' | 'rate-limited' | 'banned' | 'logged-out';
  cooldownUntil?: number;
}

/** 槽位（执行位，可复用）。对应设计稿 2.2。 */
export interface Slot {
  readonly id: string;              // S1..S5 工作槽 + S6 汇总槽
  accountId: string;                // 当前绑定的账号
  state: 'idle' | 'busy';
  currentRunId?: string;            // 正在跑哪个 run
  loadedPersona?: string;           // 当前加载的人设包名
}

/** 槽位注册表：管理槽位 ↔ 账号 ↔ 人设 三层绑定。CodeBuddy 实现。 */
export interface SlotRegistry {
  /** 列出所有槽位。 */
  list(): Slot[];
  /** 按 id 查槽位。 */
  get(id: string): Slot | undefined;
  /** 绑定槽位到账号。 */
  bindAccount(slotId: string, accountId: string): void;
  /** 标记槽位忙碌/空闲。 */
  setState(slotId: string, state: 'idle' | 'busy', runId?: string): void;
}

// ===== 记忆层 v2（CodeBuddy 实现）=====

/** 单条记忆。扩展自现有 Memory，新增治理字段。 */
export interface Memory {
  readonly id: string;
  readonly type: 'user' | 'project';
  name: string;
  content: string;
  tags: string[];
  /** v2 新增：来源（谁写入的）。 */
  source?: string;
  /** v2 新增：可信度 0-1（人工=1，模型推断=0.5 等）。 */
  confidence?: number;
  /** v2 新增：人设维度标签，按人设路由记忆子集。 */
  personaTags?: string[];
  /** v2 新增：失效时间戳（失效而非删除，便于审计/回滚）。null=有效。 */
  invalidAt?: number | null;
}

/** 记忆层 v2：SQLite + FTS5 + 失效标记 + 人设路由。CodeBuddy 实现。 */
export interface MemoryStoreV2 {
  /** 混合检索（FTS 全文 + 可选人设过滤）。 */
  search(query: string, opts?: { personaTag?: string; limit?: number }): Promise<Memory[]>;
  /** 失效一条记忆（标记 invalidAt，不删除数据）。 */
  invalidate(id: string): Promise<void>;
  /** 按人设标签列出记忆（只返回有效记忆）。 */
  listByPersona(tag: string): Promise<Memory[]>;
  /** 列出全部有效记忆（兼容现有 list()）。 */
  list(): Promise<Memory[]>;
  /** 格式化记忆为 prompt 注入文本（兼容现有系统提示词注入）。 */
  formatForPrompt(memories: readonly Memory[]): string;
}

// ===== BotInstance（Claude 实现）=====

/** Bot 实例：一个并发执行体 = loop + engine + 人设 + 槽位。Claude 实现。 */
export interface BotInstance {
  readonly id: string;
  /** Claude 实现的 AgentLoop（已去单例）。 */
  readonly loop: AgentLoop;
  /** Claude 实现的 ModelEngine（ApiEngine 或 WebEngine）。 */
  readonly engine: ModelEngine;
  /** CodeBuddy 的 PersonaRegistry 产出。 */
  persona: Persona;
  /** CodeBuddy 的 SlotRegistry 产出。 */
  slotId: string;
}

/** Bot 注册表：管理 N 个 BotInstance 生命周期。Claude 实现。 */
export interface BotRegistry {
  create(opts: { slotId: string; personaName: string; engine?: ModelEngine }): Promise<BotInstance>;
  get(id: string): BotInstance | undefined;
  list(): BotInstance[];
  destroy(id: string): Promise<void>;
}
