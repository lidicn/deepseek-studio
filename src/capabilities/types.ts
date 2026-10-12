/**
 * 可页端执行能力契约（v0.3.3）
 *
 * 与 inject/types.ts 的 ContentCapabilityController（生命周期：start/stop）正交：
 * ExecutableCapability 是「被宿主经 ws 路由、在真实页面 DOM 中执行一次」的入口。
 * 真实能力 chat-read / chat-insert / chat-send 同时实现两者——loader 负责生命周期，
 * host-client 负责执行。能力执行必须返回结构化 ExecuteResult（ok + 可选 data / error），
 * 失败用 error 码而非抛异常，保证 fail-closed 与前端可呈现。
 */

export interface ExecuteResult {
  ok: boolean;
  /** 成功时回传的结构化数据（如对话消息列表、插入确认）。 */
  data?: unknown;
  /** 失败时的结构化错误码（非异常文本），用于宿主判定与前端呈现。 */
  error?: string;

  // ---- v1.2 新增：Pi Agent 风格统一结果格式（全可选，缺省即回退旧格式）----
  // 语义真相源见 src/shared/tool-result-format.ts 的 ToolResultExtras。
  /** 给模型看的内容（文本 + 图片等多模态）。 */
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
  /** 给 UI 看的元数据（exitCode / durationMs / path 等）。 */
  details?: Record<string, unknown>;
  /** 显式错误标记（等价于 !ok，但语义更清晰）。 */
  isError?: boolean;
  /** 提示跳过自动续跑（批次内全部为 true 时才生效）。 */
  terminate?: boolean;
}

/**
 * 宿主下发给能力的执行上下文（v0.5）。
 *
 * 关键：这里的字段只能由**宿主**填写，绝不能从调用方 params 里读取——
 * 否则「越界访问」就变成了调用方自己说了算的权限。
 */
export interface CapabilityContext {
  /**
   * 策略层已明确批准本次越出工作区的访问（full 档放行，或用户在 ask/auto 档点了同意）。
   * 能力层保留自己的边界检查（纵深防御），但以宿主授权为准，
   * 避免出现「用户选了完全访问 / 点了允许一次，能力却仍拒绝」的割裂行为。
   */
  allowOutsideWorkspace?: boolean;
}

export interface ExecutableCapability {
  readonly id: string;
  execute(params: Record<string, unknown>, ctx?: CapabilityContext): Promise<ExecuteResult>;
}
