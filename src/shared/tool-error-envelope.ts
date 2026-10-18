/**
 * 统一工具错误信封（v0.1）
 *
 * 对齐 docs/设计稿/M5-编程工具链最终设计稿.md 第 7 节。
 * 所有工具失败返回统一结构，让模型能区分：
 *   - 永久失败（重试无意义）
 *   - 可重试失败（网络/临时）
 *   - 需要用户介入（权限/确认）
 */

export type ToolErrorKind =
  | 'permanent'     // 永久失败：参数错、文件不存在、越界
  | 'retryable'     // 可重试：网络抖动、临时锁、资源暂时不可用
  | 'user_action'   // 需要用户介入：权限不足、需要确认
  | 'internal';     // 宿主内部 bug

export interface ToolErrorEnvelope {
  /** 错误码（复用 CONTRACTS §6.1） */
  code: string;
  /** 人类可读的错误描述 */
  message: string;
  /** 错误分类 */
  kind: ToolErrorKind;
  /** 建议动作 */
  suggestion: string;
  /** 调试详情（可选） */
  detail?: Record<string, unknown>;
}

/**
 * 把错误码映射到分类和建议。
 */
const ERROR_MAP: Record<string, { kind: ToolErrorKind; suggestion: string }> = {
  'missing-argument': { kind: 'permanent', suggestion: '检查参数名和必填项' },
  'invalid-argument': { kind: 'permanent', suggestion: '修正参数格式后重试' },
  'workspace-unconfigured': { kind: 'user_action', suggestion: '先调用 workspace.set 配置工作区' },
  'outside-workspace': { kind: 'permanent', suggestion: '文件必须在工作区内' },
  'not-found': { kind: 'permanent', suggestion: '确认路径存在；file.read 之前先 file.list 查' },
  'io-error': { kind: 'retryable', suggestion: '临时 IO 错误，稍后重试；持续失败检查权限' },
  'limit-exceeded': { kind: 'retryable', suggestion: '并发超限，等当前任务结束再试' },
};

export function buildErrorEnvelope(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): ToolErrorEnvelope {
  const entry = ERROR_MAP[code] ?? { kind: 'internal', suggestion: '检查宿主日志' };
  return {
    code,
    message,
    kind: entry.kind,
    suggestion: entry.suggestion,
    ...(detail ? { detail } : {}),
  };
}

/**
 * 判断错误是否可重试。
 */
export function isRetryable(envelope: ToolErrorEnvelope): boolean {
  return envelope.kind === 'retryable';
}
