/**
 * 单个用户回合内的工具调用去重。
 *
 * 同一条流被重复消费时，解析器可能把同一个 ParsedToolCall 投递多次。callId 由解析器
 * 在该次解析时生成，因此相同 callId 代表同一次调用，而不是用户发起的两次相同调用。
 * 去重状态必须在每个新用户回合重置，避免把用户后续主动重试误判成重复。
 */
export interface ToolCallDedupe {
  /** 首次见到 callId 返回 true；同一回合内再次见到返回 false。 */
  claim(callId: string): boolean;
  /** 是否已经认领过该 callId。 */
  has(callId: string): boolean;
  /**
   * 首次见到「调用名 + 稳定参数签名」返回 true；同一流内重复签名返回 false。
   * 用于拦截模型在同一轮重复输出完全相同的工具调用。
   */
  claimSignature(invocationName: string, params: Record<string, unknown>): boolean;
  /** 清空当前流的签名，保留 callId 认领记录。 */
  resetSignatures(): void;
  /** 新用户回合开始时清空。 */
  reset(): void;
  /** 当前回合已认领的调用数。 */
  size(): number;
}

export function createToolCallDedupe(): ToolCallDedupe {
  const seen = new Set<string>();
  const signatures = new Set<string>();
  return {
    claim(callId: string): boolean {
      if (seen.has(callId)) return false;
      seen.add(callId);
      return true;
    },
    has(callId: string): boolean {
      return seen.has(callId);
    },
    claimSignature(invocationName: string, params: Record<string, unknown>): boolean {
      const signature = `${invocationName}:${stableSerialize(params)}`;
      if (signatures.has(signature)) return false;
      signatures.add(signature);
      return true;
    },
    resetSignatures(): void {
      signatures.clear();
    },
    reset(): void {
      seen.clear();
      signatures.clear();
    },
    size(): number {
      return seen.size;
    },
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`)
    .join(',')}}`;
}
