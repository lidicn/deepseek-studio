/**
 * HandoffParser（v0.27a 聊天室指令与接力层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 HandoffParser（Claude 锁定）。
 *
 * 从 bot 回复里拆「净内容 + 接力目标」。纯算法。
 *
 * 设计（据答疑回复 Q4）：
 *   - 净内容 = MentionParser.stripMentionTokens(content, participants)：
 *     剥掉「已注册 @名 + @all」，但**保留未注册 @名**原文（让调用方/用户看到拼错，不致误删）。
 *   - unresolved = 用 extractMentionRanges 定位所有 @标记，未命中 participants 的名字进 unresolved。
 *   两边职责清晰：MentionParser 管剥离，本类管接力识别 + 未注册上报。
 *
 * 三条写死规则之一：@all 视为无接力（防 N×N 自我广播）；未注册名 → unresolved 上报，不静默丢弃。
 */

import type { HandoffParser, HandoffResolution, MentionParser } from './types';
import { extractMentionRanges } from './mention-parser';

export class DefaultHandoffParser implements HandoffParser {
  constructor(private readonly parser: MentionParser) {}

  parse(
    content: string,
    participants: ReadonlyArray<{ name: string; id?: string }>,
  ): HandoffResolution {
    // 净内容：剥已注册 @名 + @all，保留未注册 @名。
    const stripped = this.parser.stripMentionTokens(content, participants);

    // 接力识别：所有 @标记（含 @all 与未注册名），与 stripped 独立计算。
    const lowerToCanonical = new Map<string, string>(
      participants.map((p) => [p.name.toLowerCase(), p.name]),
    );
    const targets: string[] = [];
    const unresolved: string[] = [];
    const seenTarget = new Set<string>();
    const seenUnres = new Set<string>();

    for (const r of extractMentionRanges(content)) {
      const lower = r.name.toLowerCase();
      if (lower === 'all') continue; // @all 不算接力（防 N×N 自我广播）
      const canonical = lowerToCanonical.get(lower);
      if (canonical) {
        if (!seenTarget.has(canonical)) {
          seenTarget.add(canonical);
          targets.push(canonical);
        }
      } else {
        // 未注册（拼错/未配置）→ 上报，不丢弃。
        if (!seenUnres.has(r.name)) {
          seenUnres.add(r.name);
          unresolved.push(r.name);
        }
      }
    }

    return { content: stripped, targets, unresolved };
  }
}
