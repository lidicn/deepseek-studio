/**
 * MentionParser（v0.26 聊天室数据层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts（Claude 锁定的聊天室数据层接口）。
 * 纯算法，不依赖任何 host 基础设施，可完全独立开发测试。
 *
 * 借鉴 Ekko Studio 的 mention-routing.ts：
 *   - 边界判断（isBeforeBoundary / isAfterBoundary）：@ 前缀非 [A-Za-z0-9_@]，
 *     名后接非 [A-Za-z0-9_]（含 CJK/emoji/标点/空白/结尾）= 有效 @。
 *   - 据此：邮箱 `admin@x.com` 因 @ 前是字母而不误命中；中文 `@前端专家` 能命中。
 *   - 引用块屏蔽：<quoted_message> 块内 @ 不解析（对齐 Ekko maskQuotedMessageBlocks）。
 *   - 最长匹配：同一 @ 位置若有多个参与者名可匹配（含子串），取最长者，避免重复命中。
 */

import type { MentionParser, StructuredMention } from './types';

/** 单条解析结果（含在原文中的区间，供 stripMentionTokens 使用）。 */
interface RawMention {
  type: 'all' | 'agent';
  /** type='agent' 时的参与者名（persona 名）。 */
  participantId?: string;
  /** @ 符号起始下标（含）。 */
  start: number;
  /** 名结束下标（不含）。 */
  end: number;
}

/** 名字字符集：[A-Za-z0-9_] 视为「连续性」字符，其后是边界。 */
const WORD_CHAR = /[A-Za-z0-9_]/;
/** @ 前的非边界字符（即会令 @ 失效的前缀，如邮箱本地部分、标识符）。 */
const BEFORE_INVALID = /[A-Za-z0-9_@]/;

/** 引用块正则：<quoted_message ...> ... </quoted_message>。 */
const QUOTED_BLOCK_RE = /<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/gi;

/**
 * 屏蔽引用块：把 <quoted_message> 整段（含标签）替换成等长的空格，
 * 使块内 @ 不参与解析，同时保持下标对齐原文。
 */
function maskQuotedMessageBlocks(content: string): string {
  return content.replace(QUOTED_BLOCK_RE, (match) => ' '.repeat(match.length));
}

/**
 * 在（已屏蔽引用块的）文本中查找所有 @提及。
 * participants 为房间成员（通常传 [{ name: personaName }]）。
 * 只认最长匹配 + 前后边界，返回带区间的原始提及。
 */
function findMentions(
  content: string,
  participants: ReadonlyArray<{ name: string; id?: string }>,
): RawMention[] {
  const masked = maskQuotedMessageBlocks(content);

  // 候选 token：@all 特例 + 每个参与者名（大小写不敏感匹配，记录原名）。
  const tokens: ReadonlyArray<{ lower: string; raw: string; isAll: boolean; name?: string }> = [
    { lower: 'all', raw: 'all', isAll: true },
    ...participants.map((p) => ({ lower: p.name.toLowerCase(), raw: p.name, isAll: false, name: p.name })),
  ];

  const result: RawMention[] = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== '@') {
      i += 1;
      continue;
    }
    // @ 前边界：开头，或前一字符不是「连续性/@」字符。
    const before = i === 0 ? '' : masked[i - 1];
    if (before !== '' && BEFORE_INVALID.test(before)) {
      i += 1;
      continue;
    }
    // 在该 @ 后尝试匹配最长 token。
    let best: { token: (typeof tokens)[number]; len: number } | null = null;
    for (const t of tokens) {
      const len = t.raw.length;
      if (i + 1 + len > masked.length) continue;
      const slice = masked.slice(i + 1, i + 1 + len);
      if (slice.toLowerCase() !== t.lower) continue;
      // @ 后边界：名后字符为空，或非连续性字符。
      const afterIdx = i + 1 + len;
      const after = afterIdx >= masked.length ? '' : masked[afterIdx];
      const afterBoundary = after === '' || !WORD_CHAR.test(after);
      if (!afterBoundary) continue;
      if (!best || len > best.len) best = { token: t, len };
    }
    if (best) {
      const start = i;
      const end = i + 1 + best.len;
      result.push(
        best.token.isAll
          ? { type: 'all', start, end }
          : { type: 'agent', participantId: best.token.name, start, end },
      );
      i = end; // 跳过已匹配的 @名，避免内部重复扫描
    } else {
      i += 1;
    }
  }
  return result;
}

/** 默认 MentionParser 实现。无状态，可单例复用。 */
export class DefaultMentionParser implements MentionParser {
  resolveMentions(
    content: string,
    participants: ReadonlyArray<{ name: string; id?: string }>,
  ): StructuredMention[] {
    return findMentions(content, participants).map((m) =>
      m.type === 'all' ? { type: 'all' } : { type: 'agent', participantId: m.participantId },
    );
  }

  isAllMentioned(content: string): boolean {
    // 仅检测 @all（不依赖参与者列表）。
    return findMentions(content, []).some((m) => m.type === 'all');
  }

  stripMentionTokens(
    content: string,
    participants: ReadonlyArray<{ name: string; id?: string }>,
  ): string {
    const mentions = findMentions(content, participants).sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const m of mentions) {
      out += content.slice(cursor, m.start); // 保留 @名 之前的内容
      let skip = m.end;
      // 顺带吃掉紧跟的一个空白字符，清理「@名 内容」里的多余空格
      if (skip < content.length && /\s/.test(content[skip])) skip += 1;
      cursor = skip;
    }
    out += content.slice(cursor);
    return out;
  }
}

/**
 * 提取所有 @标记的区间（含 @all 与未注册名），供 HandoffParser 识别「未注册 @名 → unresolved」。
 *
 * 与 findMentions 的区别：findMentions 只认 participants 里的名字 + @all；extractMentionRanges 把
 * @ 后直到「空白或句读」之间的整段都当作 token 取出（含 CJK/字母/数字/连字符/emoji），不预先过滤。
 * 这样 HandoffParser 才能发现「拼错/未注册的名字」——这些 findMentions 根本不会返回。
 *
 * 复用引用块屏蔽（块内 @ 不提取），与 DefaultMentionParser 行为一致。
 * 这是非破坏附加导出，不改动 DefaultMentionParser 既有行为（保 v0.26 的 17 测试）。
 */
const MENTION_STOP = /[\s，。！？；：、,.!?;:]/;

export function extractMentionRanges(
  content: string,
): ReadonlyArray<{ name: string; start: number; end: number }> {
  const masked = maskQuotedMessageBlocks(content);
  const ranges: Array<{ name: string; start: number; end: number }> = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== '@') {
      i += 1;
      continue;
    }
    // @ 前边界：开头，或前一字符不是「连续性/@」字符（与 findMentions 一致，屏蔽邮箱等）。
    const before = i === 0 ? '' : masked[i - 1];
    if (before !== '' && BEFORE_INVALID.test(before)) {
      i += 1;
      continue;
    }
    // 取 @ 后直到空白/句读的极大串。
    let j = i + 1;
    while (j < masked.length && !MENTION_STOP.test(masked[j])) j += 1;
    const name = masked.slice(i + 1, j);
    if (name.length > 0) ranges.push({ name, start: i, end: j });
    i = j > i ? j : i + 1;
  }
  return ranges;
}

/** 共享单例（与 PersonaRegistry 等保持一致的使用方式）。 */
export const mentionParser: MentionParser = new DefaultMentionParser();
