/**
 * 元宝信号检测器
 *
 * 从页面文本中检测审计信号：
 *   ROUND_N_DONE  - 第 N 轮完成
 *   ALL_DONE      - 全部完成
 *   NEED_DECISION - 需要人工决策
 *   NEED_CONTINUE - 需要继续
 *
 * 双重检测：
 *   1. DOM MutationObserver（可靠，与 yuanbao_watcher.py 同语义但在页面内运行）
 *   2. SSE/fetch 拦截（提前感知，可选）
 */

const ROUND_RE = /ROUND[_\s-]*(\d+)[_\s-]*DONE/g;
const ALL_DONE_RE = /ALL_DONE/g;
const NEED_DECISION_RE = /NEED_DECISION/g;
const NEED_CONTINUE_RE = /NEED_CONTINUE/g;

// 模板上下文关键词：命中说明信号出现在提示词说明里，不是 AI 真实输出
const TEMPLATE_HINTS = ['输出', '例如', '示例', '标记', '格式', '写作', '必须', '回复', '当你', '请在'];

export interface AuditSignals {
  /** 已完成的轮次编号集合 */
  rounds: Set<number>;
  /** 是否检测到 ALL_DONE */
  allDone: boolean;
  /** 是否检测到 NEED_DECISION */
  needDecision: boolean;
  /** 是否检测到 NEED_CONTINUE */
  needContinue: boolean;
  /** 最后更新时间戳 */
  lastUpdate: number;
}

export function emptySignals(): AuditSignals {
  return {
    rounds: new Set(),
    allDone: false,
    needDecision: false,
    needContinue: false,
    lastUpdate: 0,
  };
}

/**
 * 判断匹配位置是否为真实信号（而非模板说明）。
 *
 * 规则：
 *   1. 信号独占一行（行首到信号之间只有空白）→ 真实
 *   2. 否则检查信号前 12 个字符是否含模板说明词
 */
function isRealSignal(text: string, matchIndex: number, matchLen: number): boolean {
  const lineStart = text.lastIndexOf('\n', matchIndex - 1) + 1;
  const beforeOnLine = text.slice(lineStart, matchIndex);
  const afterEnd = matchIndex + matchLen;
  const lineEnd = text.indexOf('\n', afterEnd);
  const afterOnLine = text.slice(afterEnd, lineEnd === -1 ? text.length : lineEnd);

  // 信号独占一行（前后只有空白）→ 真实
  if (beforeOnLine.trim() === '' && afterOnLine.trim() === '') {
    return true;
  }

  // 行内出现：检查前面的模板词（缩小到 12 字符）
  const pre = text.slice(Math.max(0, matchIndex - 12), matchIndex);
  return !TEMPLATE_HINTS.some((h) => pre.includes(h));
}

/** 从页面文本中提取所有信号 */
export function detectSignals(text: string): AuditSignals {
  const signals = emptySignals();
  if (!text) return signals;

  let m: RegExpExecArray | null;

  ROUND_RE.lastIndex = 0;
  while ((m = ROUND_RE.exec(text)) !== null) {
    if (isRealSignal(text, m.index, m[0].length)) {
      signals.rounds.add(parseInt(m[1], 10));
    }
  }

  ALL_DONE_RE.lastIndex = 0;
  while ((m = ALL_DONE_RE.exec(text)) !== null) {
    if (isRealSignal(text, m.index, m[0].length)) {
      signals.allDone = true;
      break;
    }
  }

  NEED_DECISION_RE.lastIndex = 0;
  while ((m = NEED_DECISION_RE.exec(text)) !== null) {
    if (isRealSignal(text, m.index, m[0].length)) {
      signals.needDecision = true;
      break;
    }
  }

  NEED_CONTINUE_RE.lastIndex = 0;
  while ((m = NEED_CONTINUE_RE.exec(text)) !== null) {
    if (isRealSignal(text, m.index, m[0].length)) {
      signals.needContinue = true;
      break;
    }
  }

  signals.lastUpdate = Date.now();
  return signals;
}

/**
 * 合并新检测到的信号到已有状态。
 * 返回新增的轮次编号（空数组表示无变化）。
 */
export function mergeSignals(current: AuditSignals, detected: AuditSignals): number[] {
  const newRounds: number[] = [];
  for (const r of detected.rounds) {
    if (!current.rounds.has(r)) {
      current.rounds.add(r);
      newRounds.push(r);
    }
  }
  if (detected.allDone) current.allDone = true;
  if (detected.needDecision) current.needDecision = true;
  if (detected.needContinue) current.needContinue = true;
  if (newRounds.length > 0) current.lastUpdate = Date.now();
  return newRounds.sort((a, b) => a - b);
}

/**
 * 获取页面可见文本（限定在聊天区域，避免侧边栏污染）
 */
export function getChatText(): string {
  // 优先限定到聊天消息容器
  const selectors = [
    '.chat-container',
    '[class*="chat-content"]',
    '[class*="message-list"]',
    '[class*="conversation"]',
    'main',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent && el.textContent.length > 50) {
      return el.textContent;
    }
  }
  return document.body.innerText || '';
}
