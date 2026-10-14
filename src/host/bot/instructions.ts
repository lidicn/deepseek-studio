/**
 * v0.27a：聊天室人设指令模板（AgentInstructionBuilder 的默认实现）
 *
 * 这一段的定位很窄：**产出文本，不做调度**。
 *   - 谁该回复、以什么顺序 → MentionRouter / RoundOrchestrator（CodeBuddy）
 *   - 上下文长什么样       → ContextEngine（CodeBuddy，v0.26）
 *   - 人设+房间说明什么    → 本文件
 *
 * 纯函数、无 IO、无副作用：同入参必同出串，因此可在 jest/vitest 里直接断言。
 * 不 import web-engine / desktop-host / registry —— 这是它能被 v0.27a 独立测试的前提。
 */

import type { AgentInstructions, AgentInstructionBuilder } from './types';

/** 指令模板的可选配置。全部有默认值，v0.28 PoC 直接 zero-config 跑。 */
export interface AgentInstructionTemplateOptions {
  /** 人设描述缺省时的兜底文案。 */
  fallbackDescription?: string;
  /** 房间描述/话题。v0.27a 契约里 RoomConfig 没有 description 字段，先从这里补进来。 */
  roomDescription?: string;
}

/**
 * 默认人设指令构建器。
 *
 * 内容规则（写死在输出里，避免 bot 越界）：
 *   1. 身份      —— 你是谁、负责哪个维度
 *   2. 房间      —— 房间名 + 谁在场
 *   3. 已有摘要  —— 之前聊到哪（ContextEngine 传进来，本文件只排版）
 *   4. 边界      —— 不越权、不扮演别人、别重复别人说过的
 *   5. 接力约定  —— 需要别人接着说时怎么标
 *
 * 规则 4/5 不是客套：多 bot 最容易出的两类失败就是「三个人都说同一段」和「A 一直抢话」。
 * 这两条约束写在系统提示词里，比事后修剪便宜得多。
 */
export function createAgentInstructionBuilder(
  options: AgentInstructionTemplateOptions = {},
): AgentInstructionBuilder {
  const fallbackDescription = options.fallbackDescription ?? '该角色默认描述未提供';
  const roomDescription = options.roomDescription ?? '';

  return {
    build(ctx): AgentInstructions {
      const { agentName, roomName, agentDescription, memberNames, summary } = ctx;
      const others = memberNames.filter((n) => n !== agentName);

      const lines: string[] = [];
      lines.push(`# 你的身份`);
      lines.push(`你是「${agentName}」。`);
      lines.push(`职责范围：${agentDescription.trim() || fallbackDescription}`);
      lines.push('');
      lines.push(`# 房间：${roomName}`);
      if (roomDescription) lines.push(`讨论主题：${roomDescription}`);
      lines.push(`在场成员：${memberNames.length > 0 ? memberNames.join('、') : '（仅你一人）'}`);
      lines.push('');
      lines.push(`# 已进行的讨论（摘要）`);
      lines.push(summary.trim() || '（这是房间的第一条消息，尚无历史）');
      lines.push('');
      lines.push(`# 行为边界`);
      lines.push(`1. 只在「${agentName}」的职责范围内发言，超出范围不要装作了解。`);
      lines.push(`2. 不要替其他人发言，也不要复述别人已经说过的结论。`);
      if (others.length > 0) {
        lines.push(`3. 需要「${others.join('、')}」接着讨论时，在回复里用 @点名，例如 @${others[0]}。`);
      } else {
        lines.push(`3. 现在房间里只有你，无需 @点名。`);
      }
      lines.push(`4. 拿不准的不要下结论，说清楚你是推测。`);

      return { instructions: lines.join('\n') };
    },
  };
}
