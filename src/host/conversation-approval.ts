/**
 * 对话级放行表（"一个对话只审批一次"）
 *
 * 用户诉求（出资人 08:2x 原话）：「**该整个对话就是整个对话**。该某次放行就是某次放行。
 * 该完全放开，就彻底关闭审批。」
 *
 * ── K2（2026-11-09）语义变更：key 去掉 `toolId` 与 `canonicalTarget` ──
 *
 * 旧 key = `principal|workspaceHash|policyMode|conversationId|toolId|canonicalTarget`。
 * 后两项是 C1 P1 安全批 R3-01 加进来的，当时修对了一个真实漏洞（"点一次 file.read
 * 放行同对话全部工具"），但**副作用是"一次对话审批一次"在 `python.exec`/`shell.exec`
 * 这类工具上永远不可能成立**——它们的 `canonicalTarget` 天然每次调用都变
 * （设计稿 D2：这正是"每次都重新审批"的成因）。
 *
 * 现在 key 只保留**四个语境维度**，失效条件写在下面的 `ConversationApprovalKeyInput` 上。
 *
 * ⚠️ **安全代价必须明示，不藏**：一次「本对话始终允许」= 该对话内**任何**工具
 * （含 `python.exec` 任意代码、`memory.purge`）都不再询问，直到换对话/工作区/档位。
 * 补偿防线（不在本文件，但都在）：
 *   ① hard-deny 地板与策略层 deny **仍在** `authorization.ts` 里先于本表判定（它们是拒绝，不是询问）；
 *   ② **越界不吃对话级放行**——`authorization.ts` 的 `if (conversationApproved && !outsideRequested)`
 *      这一条**保留不变**（R3-01b 的修法，§1.4 硬规则 5：跨工作区必须逐次确认）；
 *   ③ 每次放行写审计。
 *
 * ⚠️ 第 ② 条以前有"key 里含 canonicalTarget"作为**第一道**保险（越界路径 B 的同意
 * 换到区内路径 A 就自然不命中）。**去掉 canonicalTarget 后，`!outsideRequested` 成了
 * 唯一那道门**——所以它从"第二道"升格为"唯一一道"，任何删它的改动都必须先过出资人。
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
}

/**
 * 对话级放行的 key：**只由四个语境维度构成**。
 *
 * K2（2026-11-09）：不再含 `toolId` / `canonicalTarget`——见文件头"语义变更"。
 */
export function conversationApprovalKeyOf(input: ConversationApprovalKeyInput): string {
  return [
    input.principal,
    input.workspaceHash,
    input.policyMode,
    input.conversationId,
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
