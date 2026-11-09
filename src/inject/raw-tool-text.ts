/**
 * raw-tool-text.ts —— 原始工具标签的识别与剥离（渲染层与判定层共用）
 *
 * 真机缺陷（C1-F5，中危）：模型最后一轮直接把工具调用原文吐成正文，
 *   <search_files>{"operation":"list","root":"E:/NAS/deepseek-studio","limit":5}</search_files>
 * 页面把这段渲染成用户可读正文，同时 trace 记 `no-tools → completed` —— 用户以为
 * 模型回答了一句话，实际是一次**没有执行**的工具调用。
 *
 * 这里提供唯一实现，两个使用方：
 *   1. 渲染层（src/ui/studio-chat-ui.ts）：任何进入气泡的文本先过 `stripRawToolText`，
 *      标签不进正文；被剥离时追加一行明确提示，而不是静默消失。
 *   2. 判定层（src/inject/main-world-interceptor.ts）：结尾判「无工具」前先扫一遍，
 *      命中就把 trace 记成 `tool-text-unparsed`，不再谎报 `no-tools`。
 *
 * 相比旧的正则（只认 `search_files` 等固定白名单 + 开标签不得带属性），这里：
 *   - 工具名取自 `MATCHABLE_INVOCATION_NAMES`（匹配面＝规范∪别名，T-4；增删工具/别名自动跟随，声明面仍只含规范名）；
 *   - 开标签允许属性（模型偶尔写 `<search_files operation="list">`）；
 *   - 闭合标签允许空白（`</search_files >`）；
 *   - 未闭合的尾部标签（流被截断）也认，标 `unclosed=true`；
 *   - 不碰普通文本里的 `<`（`a < b`、`</3`、非工具名标签原样保留）。
 */

import { MATCHABLE_INVOCATION_NAMES } from '../shared/tool-contract';

export interface RawToolTextScan {
  /** 剥离工具标签后的文本。 */
  readonly clean: string;
  /** 命中的完整工具标签块数量。 */
  readonly blocks: number;
  /** 命中的工具名（按出现顺序，去重前）。 */
  readonly names: readonly string[];
  /** 是否有未闭合的工具标签（流被截断，或模型没写完闭合标签）。 */
  readonly unclosed: boolean;
}

const EMPTY_SCAN = (text: string): RawToolTextScan => ({ clean: text, blocks: 0, names: [], unclosed: false });

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let cachedKey = '';
let cachedPairRe: RegExp | null = null;
let cachedOpenRe: RegExp | null = null;

function buildRegexes(): { pair: RegExp; open: RegExp } | null {
  const names = [...MATCHABLE_INVOCATION_NAMES].filter(Boolean);
  if (names.length === 0) return null;
  const key = names.join('|');
  if (key === cachedKey && cachedPairRe && cachedOpenRe) {
    return { pair: cachedPairRe, open: cachedOpenRe };
  }
  // 长的名字放前面，避免 `mcp.list` 被 `mcp` 抢先匹配（当前表无前缀冲突，留作防御）。
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  cachedPairRe = new RegExp(`<(${alt})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`, 'g');
  cachedOpenRe = new RegExp(`<(${alt})(?:\\s[^>]*)?>`, 'g');
  cachedKey = key;
  return { pair: cachedPairRe, open: cachedOpenRe };
}

/**
 * 扫描并剥离文本里的原始工具标签。
 *
 * 纯函数、无状态；不改变普通文本里的 `<`（不是工具名的一律原样保留）。
 */
export function scanRawToolText(text: unknown): RawToolTextScan {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (!src) return EMPTY_SCAN(src);
  const res = buildRegexes();
  if (!res) return EMPTY_SCAN(src);

  const names: string[] = [];
  let blocks = 0;

  // 1) 完整成对标签：整块剥掉（标签之间的参数/结果都不进正文）。
  res.pair.lastIndex = 0;
  let clean = src.replace(res.pair, (_match, name: string) => {
    blocks += 1;
    names.push(name);
    return '';
  });

  // 2) 残留的开标签（未闭合）：从该标签起到文本末尾一并剥掉，并标记 unclosed。
  //    流被截断时正文里就只剩这些，绝不能当正文展示。
  let unclosed = false;
  res.open.lastIndex = 0;
  const openMatch = res.open.exec(clean);
  if (openMatch && openMatch.index >= 0) {
    unclosed = true;
    blocks += 1;
    names.push(openMatch[1]);
    clean = clean.slice(0, openMatch.index);
  }

  if (blocks === 0) return EMPTY_SCAN(src);
  return { clean, blocks, names, unclosed };
}

/** 文本里是否存在未执行的工具调用原文（只判不剥）。 */
export function hasRawToolText(text: unknown): boolean {
  return scanRawToolText(text).blocks > 0;
}

/** 剥掉原始工具标签，返回干净文本（无命中时原样返回，不做 trim）。 */
export function stripRawToolText(text: unknown): string {
  return scanRawToolText(text).clean;
}

/**
 * 续跑判定用的 reason：正文里还留着工具调用原文时记 `tool-text-unparsed`，
 * 否则才是 `no-tools`。
 *
 * 为什么单独抽出来：真机缺陷（C1-F5）里 trace 记的是 `no-tools → completed`，
 * 让读者以为「这一轮只是普通问答」；实际是「模型吐了工具调用但没被执行」。
 * 抽成纯函数后可以单测锁死，不依赖 SSE 回放。
 */
export type ContinuationReasonForReply = 'no-tools' | 'tool-text-unparsed';

export function continuationReasonForReply(reply: unknown): ContinuationReasonForReply {
  return hasRawToolText(reply) ? 'tool-text-unparsed' : 'no-tools';
}
