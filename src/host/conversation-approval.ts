/**
 * 对话级放行表（"一个对话只审批一次"）
 *
 * 用户诉求：完全放开档不该每个执行都弹一次审批；希望**一个对话审批一次**，
 * 之后同一对话内的调用不再打扰。失效条件（任一命中即作废）：
 *   - 换对话（conversationId 变化）
 *   - 换工作区（workspaceHash 变化）
 *   - 换审批档位（policyMode 变化）
 *   - **换工具（toolId 变化）** ← C1 P1 安全批 R3-01 新增
 *   - **换目标（canonicalTarget 变化）** ← C1 P1 安全批 R3-01 新增
 *   - 页端断开 / 宿主停止
 *
 * 与 grant（会话级）刻意分开：grant 绑"工具+目标"，本表绑"对话"。
 * 本表只覆盖"逐次询问"这一层，hard-deny 与策略层 deny 永不受影响
 * （它们在 authorization.ts 里先于本表判定）。
 *
 * ── C1 P1 安全批 R3-01：key 必须含 toolId + canonicalTarget ──
 *
 * 缺陷（PM 核实）：原 key **刻意不含工具名**（旧注释：「一个对话审批一次覆盖该对话内全部调用」），
 * 于是用户在 `file.read` 上点一次「本次对话始终允许」→ 同对话内
 * `shell.exec` / `file.write`（含**工作区外**）/ `policy.set` **全部静默放行**。
 * 一次「读个文件」的同意，被放大成了「这个对话里随便干什么都行」。
 *
 * 修法：key 纳入 **toolId + canonicalTarget** →
 * 同意只对「这个工具 + 这个目标」生效；换个工具或换个路径**必须重新问**。
 * 这不违背「一个对话审批一次」的用户诉求 ——
 * 诉求是「别每个执行都弹」，不是「一次同意覆盖所有工具」。
 */

export interface ConversationApprovalKeyInput {
  /** 发起者（botId ?? 'main'）。 */
  readonly principal: string;
  /** 工作区指纹（换工作区即失效）。 */
  readonly workspaceHash: string;
  /** 审批档位（换档位即失效）。 */
  readonly policyMode: string;
  /** 页端会话标识；无对话身份时不允许对话级放行。 */
  readonly conversationId: string;
  /**
   * C1 P1 安全批 R3-01：工具 id。
   *
   * **必须纳入 key** —— 否则在 `file.read` 上的一次同意会放行同对话内的 `shell.exec`。
   */
  readonly toolId: string;
  /**
   * C1 P1 安全批 R3-01：规范目标（工具的目标归一化结果）。
   *
   * **必须纳入 key** —— 否则对 `A.txt` 的同意会放行对 `B.txt`（或工作区外路径）的访问。
   */
  readonly canonicalTarget: string;
}

/**
 * 对话级放行的 key。
 *
 * C1 P1 安全批 R3-01：key 含 **toolId + canonicalTarget** ——
 * 一次同意只对「这个工具 + 这个目标」有效，换工具或换目标必须重新询问。
 * （旧实现刻意不含工具名，是 R3-01 缺陷的直接来源。）
 */
export function conversationApprovalKeyOf(input: ConversationApprovalKeyInput): string {
  return [
    input.principal,
    input.workspaceHash,
    input.policyMode,
    input.conversationId,
    input.toolId,
    input.canonicalTarget,
  ].join('|');
}

export interface ConversationApprovalStore {
  /** 该 key 是否已被放行。 */
  check(key: string): boolean;
  /** 记录一次对话级放行。 */
  grant(key: string): void;
  /** 清空全部（工作区/档位/断线/宿主停止时调用）。 */
  clearAll(): void;
  /**
   * 递增世代号并清空放行。用于丢弃"回调返回时已换代"的迟到授权：
   * 用户点按钮的那一刻策略档位或工作区可能已被改掉，此时不得再放行。
   */
  bumpGeneration(): number;
  /**
   * 只递增世代号、保留已有放行。用于页端瞬时断开/重连：
   * 在途的同意回调必须作废，但「本对话已放行」不应因为一次重连被清掉。
   */
  invalidateInFlight(): number;
  /** 当前世代号。 */
  currentGeneration(): number;
}

export function createConversationApprovalStore(): ConversationApprovalStore {
  const approved = new Set<string>();
  let generation = 0;
  return {
    check(key) {
      return approved.has(key);
    },
    grant(key) {
      approved.add(key);
    },
    clearAll() {
      approved.clear();
    },
    bumpGeneration() {
      generation += 1;
      approved.clear();
      return generation;
    },
    invalidateInFlight() {
      generation += 1;
      return generation;
    },
    currentGeneration() {
      return generation;
    },
  };
}
