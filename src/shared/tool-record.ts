/**
 * 工具调用记录类型（v1.0，对齐 deepseek++ tool-record-codec 结构）
 *
 * 参考 deepseek++ 的 ToolCall / ToolResult / ToolCallRecord 数据结构，
 * 统一 studio 各模块（拦截器、宿主、面板、API）之间的工具调用数据格式。
 */

/** 工具调用来源 */
export type ToolCallSource = 'manual_chat' | 'agent_run' | 'automation' | 'api';

/** 工具执行结果错误 */
export interface ToolExecutionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

/** 工具调用（模型输出的 XML 标签解析后） */
export interface ToolCall {
  /** 唯一调用 ID */
  readonly id: string;
  /** 工具名（如 shell_exec、local_file_read） */
  readonly name: string;
  /** 调用名（通常等于 name，MCP 场景可能不同） */
  readonly invocationName: string;
  /** 解析后的参数 */
  readonly params: Record<string, unknown>;
  /** 原始 XML 标签文本 */
  readonly raw: string;
  /** 来源 */
  readonly source?: ToolCallSource;
  /** 创建时间戳 */
  readonly createdAt?: number;
  /** JSON 解析错误（如果参数不是合法 JSON） */
  readonly parseError?: { message: string; raw: string };
}

/** 工具执行结果 */
export interface ToolResult {
  /** 关联的调用 ID */
  readonly callId: string;
  /** 工具名 */
  readonly name: string;
  /** 是否成功 */
  readonly ok: boolean;
  /** 简短摘要（一行，用于卡片展示和续跑提示词） */
  readonly summary: string;
  /** 详细结果（完整 JSON 或文本） */
  readonly detail: string;
  /** 结果是否被截断（大输出） */
  readonly truncated?: boolean;
  /** 结构化输出（如果有） */
  readonly output?: unknown;
  /** 错误信息（如果失败） */
  readonly error?: ToolExecutionError;
  /** 开始时间戳 */
  readonly startedAt?: number;
  /** 完成时间戳 */
  readonly completedAt?: number;
  /** 耗时（毫秒） */
  readonly durationMs?: number;
}

/** 完整的工具调用记录（调用 + 结果） */
export interface ToolCallRecord {
  /** 记录 ID */
  readonly id: string;
  /** 工具调用 */
  readonly call: ToolCall;
  /** 执行结果 */
  readonly result: ToolResult;
  /** 创建时间戳 */
  readonly createdAt: number;
  /** 来源 */
  readonly source: ToolCallSource;
}

/**
 * 从工具调用和执行结果构造完整记录。
 * 参考 deepseek++ 的记录构造逻辑。
 */
export function createToolCallRecord(
  call: ToolCall,
  result: Omit<ToolResult, 'callId' | 'name'>,
  source: ToolCallSource = 'manual_chat',
): ToolCallRecord {
  return {
    id: call.id,
    call,
    result: { ...result, callId: call.id, name: call.name },
    createdAt: Date.now(),
    source,
  };
}

/**
 * 生成工具结果的简短摘要。
 * 参考 deepseek++ 的 summary 生成逻辑：成功时截取输出前 100 字符，失败时返回错误信息。
 */
export function summarizeToolResult(ok: boolean, output: unknown, error?: string): string {
  if (!ok) {
    return error ? `失败: ${error.slice(0, 100)}` : '执行失败';
  }
  if (output == null) return '成功（无输出）';
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const trimmed = text.trim();
  if (trimmed.length === 0) return '成功（空输出）';
  const firstLine = trimmed.split('\n')[0];
  return firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
}
