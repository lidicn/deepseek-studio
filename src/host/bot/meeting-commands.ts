/**
 * 会议命令与关键词检测（v0.29 · Claude 主开发）
 *
 * 聊天室用户的会议控制入口。两条路径：
 *   - 显式命令（`/散会`、`@main 总结`）—— 最高优先级，绝不与正常讨论混淆
 *   - 自然语言关键词（"开始讨论"、"散会"）—— 兜底，零学习成本，误判风险有限
 *
 * 纯函数、无 IO、无副作用：同入参必同出串，可在 jest 里直接断言。
 *
 * 两个刻意的设计决定：
 *   1. **不依赖 mention-parser**。`@main` 不在 `memberPersonas` 时会被当普通 @提及处理，
 *      本函数对**原始文本**判定，因此必须在 `stripMentionTokens` 之前调用 —— 否则将来
 *      若把 `main` 加入 `memberPersonas`，`@main 开始` 会被剥成 `开始`，命令就丢了。
 *   2. **关键词只在文本两端匹配**。`"这个会议结束了吗"`（疑问句，关键词在句中）不会触发
 *      散会；`"现在散会"`（结尾）会触发。两端之外一律视为普通讨论。
 *
 * 衔接面见 plan buzzing-puzzling-deer.md（v0.29 会议生命周期）。
 */

export type MeetingCommandKind = 'start' | 'end' | 'summarize' | 'none';

export interface MeetingCommand {
  /** 命令类型；'none' 表示普通消息，走原聊天室路由。 */
  readonly kind: MeetingCommandKind;
  /** true = 显式命令（/命令 或 @main 变体）；false = 自然语言关键词。 */
  readonly explicit: boolean;
  /**
   * 剥离命令标记后的净文本。显式 start 命中时作为会议主题；
   * 关键词命中时为原文（是真实对话内容，需落盘）；显式 end/summarize 时同样给出（不落盘）。
   */
  readonly cleanText: string;
}

/** 空白分隔（不含换行；JS \s 已覆盖全角空格 　）。 */
const WS = /[^\S\n]*/;

/** 显式 start：`/会议开始`、`/开会`、`@main 开始[会议]`。alternation 长优先。 */
const EXP_START: readonly RegExp[] = [
  new RegExp(`^/+(?:会议开始|开会)${WS.source}`),
  new RegExp(`^@main${WS.source}(?:开始会议|开始)${WS.source}`, 'i'),
];

/** 显式 end：`/散会`、`/会议结束`、`@main 结束|散会`。 */
const EXP_END: readonly RegExp[] = [
  new RegExp(`^/+(?:散会|会议结束)${WS.source}`),
  new RegExp(`^@main${WS.source}(?:结束|散会)${WS.source}`, 'i'),
];

/** 显式 summarize：`/总结`、`@main 现在总结|总结一下|总结`。 */
const EXP_SUMMARIZE: readonly RegExp[] = [
  new RegExp(`^/+总结${WS.source}`),
  new RegExp(`^@main${WS.source}(?:现在总结|总结一下|总结)${WS.source}`, 'i'),
];

/** 自然语言关键词 —— 只匹配文本开头或结尾，句中不算。 */
const KW_START: readonly string[] = ['开始讨论', '开始会议', '我们来聊聊', '开始吧', '开会'];
const KW_END: readonly string[] = ['总结并结束', '就到这里', '会议结束', '到此为止', '散会'];

/** 在给定文本开头（trim 后）匹配首个显式命令，返回匹配到的命令词本身。 */
function matchExplicit(text: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** 两端匹配自然语言关键词（任一关键词出现在 trim 后文本的开头或结尾）。 */
function matchKeywordEnds(text: string, keywords: readonly string[]): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  for (const kw of keywords) {
    if (t.startsWith(kw) || t.endsWith(kw)) return true;
  }
  return false;
}

/**
 * 检测一条聊天室消息是否含会议控制意图。
 *
 * 判定顺序（优先级）：显式 start → 显式 end → 显式 summarize → 关键词 end → 关键词 start。
 * 显式一律先于关键词；end 先于 start（`"总结并结束"` 含"总结"，若 summarize 将来有关键词需重排）。
 *
 * 重复命令（如 idle 状态再发"散会"）此处仍返回 end —— 状态机层面的幂等由
 * `ChatRoomStateStore` / 接线层处理，不在解析层做状态判断（保持纯函数）。
 */
export function detectMeetingCommand(text: string): MeetingCommand {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return { kind: 'none', explicit: false, cleanText: '' };

  const matchedStart = matchExplicit(trimmed, EXP_START);
  if (matchedStart) {
    return { kind: 'start', explicit: true, cleanText: trimmed.slice(matchedStart.length).trim() };
  }

  const matchedEnd = matchExplicit(trimmed, EXP_END);
  if (matchedEnd) {
    return { kind: 'end', explicit: true, cleanText: trimmed.slice(matchedEnd.length).trim() };
  }

  const matchedSum = matchExplicit(trimmed, EXP_SUMMARIZE);
  if (matchedSum) {
    return { kind: 'summarize', explicit: true, cleanText: trimmed.slice(matchedSum.length).trim() };
  }

  if (matchKeywordEnds(trimmed, KW_END)) {
    return { kind: 'end', explicit: false, cleanText: trimmed };
  }

  if (matchKeywordEnds(trimmed, KW_START)) {
    return { kind: 'start', explicit: false, cleanText: trimmed };
  }

  return { kind: 'none', explicit: false, cleanText: trimmed };
}
