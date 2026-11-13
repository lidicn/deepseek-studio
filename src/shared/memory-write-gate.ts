/**
 * 长期记忆写入硬闸（2026-11-13）
 *
 * ── 现场（真机会话 chat:ff7fc62f，2026-11-12 23:34–23:45）──
 * 用户第 1 句只说了「使用Autoforge mcp 查询客厅有哪些设备」，全程没有「记住 / 记一下 /
 * 别忘了」。模型仍然先调两次 `memory.save`：
 *   [1] {"type":"user","name":"用户角色","content":"用户使用 AutoForge MCP 和 TVPilot MCP 管理客厅设备/电视。"}
 *   [3] {"type":"project","name":"客厅设备查询","content":"用户希望查询客厅有哪些设备，使用 AutoForge MCP 的 af_list_entities 工具。"}
 * 用户说「继续完成」时同样两条又被写一遍（同名 upsert 覆盖），随后同一个 `af_list_entities`
 * 调用被固化记忆推着重放（91858 字节 ×2）。
 *
 * 注入提示词里早就写了「只有用户明确要求『记住』才调用 memory_save」，但**提示词不是闸**：
 * 模型可以不听。本模块是宿主侧的硬闸——提示词被无视时，写库这一步仍然会被拒绝。
 *
 * ── 两道判据（顺序固定）──
 * ① 任务快照（**无条件**）：`type=project` 且命中任务句式或具体工具名 → 一律拒。
 *    这类内容是「这一轮在干什么」，属于对话上下文，不是长期偏好/决策；写进长期记忆会被
 *    下一轮当成事实重新执行（上面的重放就是后果）。
 * ② 显式指令（需要证据）：用户本轮话语里没有记忆指令 → 拒。
 *    证据由宿主解析（页端落进宿主 KV 的 `user-message` 事件 + 宿主侧台账），
 *    **拿不到证据同样拒绝**（fail-closed：不静默放行）。
 *
 * 词表与句式都做成可配置参数：将来要加「帮我存一条」这类说法，只改词表，不改判据结构。
 */

/** 显式记忆指令词表（缺省值；`options.cueWords` 可整体替换）。 */
export const DEFAULT_MEMORY_CUE_WORDS: readonly string[] = [
  '记住',
  '请记住',
  '帮我记住',
  '帮我记一下',
  '记一下',
  '记一笔',
  '记着',
  '记下',
  '记下来',
  '记录下来',
  '存一下',
  '存起来',
  '保存下来',
  '保存记忆',
  '写入记忆',
  '添加到记忆',
  '别忘了',
  '别忘记',
];

/**
 * 否定语境：出现「不用/不必/无需/不要/别/没」+ 记忆动词时，**不算**指令。
 * 没有这一条时「不用记住这个」会因为含 `记住` 被误判成放行 —— 那正好是要拦的方向。
 */
const MEMORY_CUE_NEGATION = /(不用|不必|无需|不需要|不要|别|没|无需再)\s*(记住|记下|记一下|记着|记录|保存|存)/;

/** 任务句式（`type=project` 时命中即判为任务快照）。 */
export const DEFAULT_TASK_PHRASES: readonly string[] = [
  '用户希望',
  '用户要求',
  '用户想要',
  '用户需要',
  '用户想查',
  '用户要查',
  '帮我',
  '请帮',
  '请查询',
  '请查',
  '查询一下',
  '查一下',
  '去查',
  '本次任务',
  '当前任务',
  '这个任务',
  '接下来要',
  '接下来查',
  '需要你',
  '任务是',
];

/**
 * 具体工具名（`type=project` 时命中即判为任务快照）。
 * 覆盖审计点名的三类：`af_*`、`*_list_*`（以及同类动宾工具名）、`memory.*`。
 */
export const DEFAULT_TOOL_NAME_PATTERN =
  /\baf_[a-z0-9_]+\b|\b[a-z][a-z0-9]*_(?:list|get|query|search|create|update|delete|export|import|run)_[a-z0-9_]+\b|\bmemory\.[a-z][a-z0-9_.]*\b/i;

export type MemorySaveGateCode =
  /** 任务快照（无条件拒绝）。 */
  | 'memory-save-task-snapshot'
  /** 本轮用户消息没有显式记忆指令。 */
  | 'memory-save-needs-explicit-instruction'
  /** 宿主拿不到本轮用户消息（fail-closed）。 */
  | 'memory-save-no-user-turn';

export interface MemorySaveGateInput {
  /** `user` / `project`（其余取值按非 project 处理）。 */
  readonly type: string;
  readonly name: string;
  readonly content: string;
  /**
   * 本轮用户消息原文。`undefined` / 空白 = 宿主没有证据 → 拒绝（fail-closed）。
   * 注意：调用方**不得**把模型自己生成的内容塞进来当证据。
   */
  readonly userText?: string | undefined;
}

export type MemorySaveGateResult =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly code: MemorySaveGateCode;
      /** 直接回给模型的可读原因（含错误码前缀，便于日志 grep）。 */
      readonly error: string;
    };

export interface MemorySaveGateOptions {
  readonly cueWords?: readonly string[];
  readonly taskPhrases?: readonly string[];
  readonly toolNamePattern?: RegExp;
}

/** 用户本轮话语里是否有**显式**记忆指令（含否定语境过滤）。 */
export function hasExplicitMemoryCue(userText: string | undefined, options?: MemorySaveGateOptions): boolean {
  const text = typeof userText === 'string' ? userText : '';
  if (!text.trim()) return false;
  if (MEMORY_CUE_NEGATION.test(text)) return false;
  const words = options?.cueWords ?? DEFAULT_MEMORY_CUE_WORDS;
  return words.some((w) => w.length > 0 && text.includes(w));
}

/** 该条记忆是否是「这一轮在干什么」的任务快照。 */
export function isTaskSnapshot(
  input: Pick<MemorySaveGateInput, 'type' | 'name' | 'content'>,
  options?: MemorySaveGateOptions,
): boolean {
  if (String(input.type ?? '').trim().toLowerCase() !== 'project') return false;
  const haystack = `${input.name ?? ''}\n${input.content ?? ''}`;
  const phrases = options?.taskPhrases ?? DEFAULT_TASK_PHRASES;
  if (phrases.some((p) => p.length > 0 && haystack.includes(p))) return true;
  const pattern = options?.toolNamePattern ?? DEFAULT_TOOL_NAME_PATTERN;
  return pattern.test(haystack);
}

/**
 * 闸门判定（纯函数）。
 *
 * 顺序：任务快照 → 无证据 → 无指令 → 放行。任务快照放最前，是因为它**不因用户说了
 * 「记住」而变合法**：用户让人记住「去查客厅设备」也不该把任务本身固化成长期记忆。
 */
export function evaluateMemorySaveGate(
  input: MemorySaveGateInput,
  options?: MemorySaveGateOptions,
): MemorySaveGateResult {
  if (isTaskSnapshot(input, options)) {
    return {
      allow: false,
      code: 'memory-save-task-snapshot',
      error:
        'memory-save-task-snapshot: 未写入记忆 —— 这条内容是任务快照（含任务句式或具体工具名），'
        + '不是长期偏好/决策。任务进度留在对话上下文里即可，不要写进长期记忆。',
    };
  }
  const userText = typeof input.userText === 'string' ? input.userText : '';
  if (!userText.trim()) {
    return {
      allow: false,
      code: 'memory-save-no-user-turn',
      error:
        'memory-save-no-user-turn: 未写入记忆 —— 宿主无法定位本轮用户消息，按 fail-closed 拒绝。'
        + '只有用户本人明确要求保存时才允许写库。',
    };
  }
  if (!hasExplicitMemoryCue(userText, options)) {
    return {
      allow: false,
      code: 'memory-save-needs-explicit-instruction',
      error:
        'memory-save-needs-explicit-instruction: 未写入记忆 —— 本轮用户消息里没有「记住 / 记一下 / 别忘了」这类明确指令。'
        + '推断出来的偏好不要替用户存；用户明确要求后再保存。',
    };
  }
  return { allow: true };
}
