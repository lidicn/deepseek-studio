/**
 * 单个用户回合内的工具调用去重。
 *
 * 同一条流被重复消费时，解析器可能把同一个 ParsedToolCall 投递多次。callId 由解析器
 * 在该次解析时生成，因此相同 callId 代表同一次调用，而不是用户发起的两次相同调用。
 * 去重状态必须在每个新用户回合重置，避免把用户后续主动重试误判成重复。
 *
 * ── N2-03（2026-11-12 续审第 3 轮裁定）：**跨流不拦是故意的，别改成跨流共享** ──
 *
 * 重复投递只发生在**同一条流内**（模型一次输出被解析器重复消费），签名集合按流清空
 * （`resetSignatures`）恰好覆盖这个范围。**跨流出现同一签名是合法重跑**：模型在新流里
 * 重新发起的同一调用是两次真实调用，拦掉它等于吞掉用户的第二次请求。
 *
 * 所以「按流清空会漏掉跨流重复」不是缺陷，是判据边界：
 *   - 流内重复 → `claimSignature` 拦；
 *   - 跨流重跑 → **放行**（本注释即该口径的唯一出处）。
 * 想把 `signatures` 提成跨流共享之前，先回答「用户在新流里重新发起同一调用算不算重复」——
 * 答案是「不算」，那就别动这里。
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
