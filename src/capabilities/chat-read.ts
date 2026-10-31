/**
 * chat-read 能力（v0.3.3 → 20261031 F1 重做）
 *
 * F1 根因（真机取证，见 docs/验收/20261031-C1-F1F2-真机复现.md 与
 * docs/验收/_probe/deepseek-dom-census-*.json）：
 *   1. 旧选择器（`.ds-assistant-message-main-content` / `.ds-markdown` / `[class*="message-item"]`…）
 *      在**现网 chat.deepseek.com 上 0 命中或只命中非消息节点**（`.ds-markdown` 命中 12 个、
 *      每个只有 8 个字符——是按钮文案，不是消息）→ 宿主 `messages.at(-1)` 取到垃圾或空串。
 *   2. 更致命的是：`ok:true` 但 `messages` 被空文本 filter 掉 → 宿主把「读不到」当成「读到了空」，
 *      于是 `lastText` 恒为空、永远等不到「与基线不同」→ 空转到 120s 看门狗 → 对外 500 timeout。
 *   3. `messages.at(-1)` 取的是**最后一条消息**，而最后一条往往就是**用户自己刚发的气泡**
 *      （含 Studio 记忆注入块，~10k 字符）→ 宿主把「我刚发的 prompt」当成模型回答。
 *
 * 本次改动：
 *   - 选择器换成真机普查配方：**虚拟列表**结构（`.ds-virtual-list > .ds-virtual-list-items >
 *     .ds-virtual-list-visible-items > <消息项>`），旧选择器保留作兜底；
 *   - 每条消息带**标识**（`id` / `index`），整体带 `sessionId`（会话 id 取自 URL `/a/chat/s/<id>`）
 *     —— 协议层要能对账「这段文本属于哪一轮」，否则宿主只能靠猜；
 *   - **fail-closed**：读不到非空文本一律 `ok:false / no-messages-found`，绝不返回「ok:true + 空」；
 *   - 支持 `ensureLatest`：把虚拟列表滚到底部，强制挂载最新消息项
 *     （虚拟列表只挂载视口内的项，答案没挂载时纯选择器物理上读不到）。
 */

import type { ContentCapabilityController } from '../inject/types';
import type { ExecutableCapability, ExecuteResult } from './types';
import { queryAll } from './dom';

/**
 * 消息项选择器（20261031 真机普查配方，按命中率排序）：
 *   - `.ds-virtual-list-visible-items > *` = 当前挂载的消息项（真机命中 3 条）
 *   - `.ds-virtual-list ._81e7b5e`         = 消息项类名兜底
 * 旧选择器保留在后面（历史站点版本 / 非虚拟列表布局）。
 */
const MESSAGE_SELECTORS = [
  '.ds-virtual-list-visible-items > *',
  '.ds-virtual-list ._81e7b5e',
  '.ds-assistant-message-main-content',
  '.ds-markdown',
  '[class*="message-item"]',
  '[class*="chat-message"]',
  '#chat-messages > *',
  '.message',
];

const USER_HINT = /(^|\s)(user|human|你|我发)/i;
const ASSISTANT_HINT = /(^|\s)(assistant|bot|ai|deepseek|助理|助手|思考|reasoning)/i;

/** 虚拟列表的滚动容器候选（普查结构里滚动发生在 .ds-scroll-area / .ds-virtual-list 上）。 */
const SCROLL_CONTAINER_SELECTORS = [
  '.ds-virtual-list',
  '.ds-scroll-area',
  '[class*="scroll-area"]',
  '[class*="virtual-list"]',
];

function inferRole(el: Element): 'user' | 'assistant' | 'unknown' {
  const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
  const head = (el.textContent ?? '').slice(0, 48);
  if (USER_HINT.test(cls) || USER_HINT.test(head)) return 'user';
  if (ASSISTANT_HINT.test(cls) || ASSISTANT_HINT.test(head)) return 'assistant';
  return 'unknown';
}

/**
 * 取元素的正文：优先取**文本量最大的后代**（DeepSeek 的气泡是消息项下的独立子节点），
 * 没有带文本的后代时退回元素自身文本。
 */
function extractText(el: Element): string {
  let best = '';
  for (const cand of Array.from(el.querySelectorAll('*'))) {
    const t = (cand.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > best.length) best = t;
  }
  if (best.length > 0) return best;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 当前会话 id（`/a/chat/s/<uuid>`）；取不到返回空串（不猜）。 */
function currentSessionId(): string {
  try {
    const path = globalThis.location?.pathname ?? '';
    const m = /\/a\/chat\/s\/([0-9a-zA-Z-]{8,})/.exec(path);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * Studio 注入层的对话镜像（**SSE 派生**，见 src/ui/studio-chat-ui.ts:1025-1035）：
 *   `.ds-sc-message-list` 容器，助手消息 = `.ds-sc-msg-assistant`，正文 = `.ds-sc-markdown`，
 *   内容来自拦截器解析的 `final-answer` 事件。
 *
 * 为什么必须读它（F1 复验 20261031 结论）：DeepSeek 的**虚拟列表只挂载视口内的项**，
 * 真机会话 26 条消息只挂 3 条、而且挂的是**最老的三条用户消息**，
 * `.ds-virtual-list` 的 `scrollHeight == clientHeight == 180`（没有占位高度，滚不动），
 * `atBottom` 恒 true —— 任何「DOM + 滚动」方案在这台机器上都读不到本轮答案。
 * 而镜像由我们自己的注入层按 SSE 渲染，**不受虚拟列表影响**，是宿主可达的权威答案源。
 */
function readStudioMirror(): { count: number; assistantTexts: string[] } {
  const list = document.querySelector('.ds-sc-message-list');
  if (!list) return { count: 0, assistantTexts: [] };
  const nodes = Array.from(list.querySelectorAll('.ds-sc-msg-assistant'));
  const assistantTexts = nodes
    .map((n) => {
      const md = n.querySelector('.ds-sc-markdown');
      return (md?.textContent ?? n.textContent ?? '').replace(/\s+/g, ' ').trim();
    })
    .filter((t) => t.length > 0);
  return { count: nodes.length, assistantTexts };
}

/** 能力前导注入（Studio 在**每条**用户消息里都会塞 ~10k 的能力说明块）。 */
const CAPABILITY_PREAMBLE = '[studio-tool-capability]';

/** 从列表元素的祖先里找真正的滚动容器（虚拟列表自身可能 scrollHeight==clientHeight，滚不动）。 */
function scrollCandidates(): HTMLElement[] {
  const seed = document.querySelector('.ds-virtual-list') ?? document.querySelector('[class*="virtual-list"]');
  const out: HTMLElement[] = [];
  let el: Element | null = seed;
  while (el && el !== document.body && out.length < 6) {
    const h = el as HTMLElement;
    let overflowY = '';
    try {
      overflowY = globalThis.getComputedStyle(h).overflowY;
    } catch {
      overflowY = '';
    }
    if (overflowY === 'auto' || overflowY === 'scroll' || h.scrollHeight > h.clientHeight + 4) {
      out.push(h);
    }
    el = el.parentElement;
  }
  for (const sel of SCROLL_CONTAINER_SELECTORS) {
    for (const n of Array.from(document.querySelectorAll(sel))) {
      const h = n as HTMLElement;
      if (!out.includes(h)) out.push(h);
    }
  }
  return out;
}

/**
 * 把虚拟列表滚到底，强制挂载最新消息项（尽力而为）。
 * 注意：不把 `scrollHeight == clientHeight` / `atBottom` 当「已是最新」的依据——
 * 真机实测这两个指标会**反向撒谎**（列表只有 180px 却 atBottom=true）。
 */
function scrollToLatest(): void {
  for (const h of scrollCandidates()) {
    try {
      h.scrollTop = h.scrollHeight;
      h.dispatchEvent(new Event('scroll', { bubbles: true }));
    } catch {
      /* 滚不动就跳过 */
    }
  }
}

export function createChatReadCapability(): ContentCapabilityController & ExecutableCapability {
  return {
    id: 'chat-read',
    start() {},
    async stop() {},
    async execute(params?: Record<string, unknown>): Promise<ExecuteResult> {
      const doc = globalThis.document;
      if (!doc) return { ok: false, error: 'no-document' };

      // ensureLatest：宿主在等答案时要求「先把最新消息装进 DOM」。
      if (params?.ensureLatest === true) {
        scrollToLatest();
        // 虚拟列表挂载是异步的（下一帧才替换可见项），等一拍再读。
        await new Promise<void>((res) => setTimeout(res, 60));
      }

      const root = (doc.querySelector('#chat-container') ?? doc.querySelector('#root') ?? doc.body) as ParentNode;
      const sessionId = currentSessionId();
      const nodes = queryAll(root, MESSAGE_SELECTORS);
      const messages = nodes
        .map((n, index) => {
          const text = extractText(n);
          return {
            role: inferRole(n),
            text,
            index,
            id: sessionId ? `${sessionId}#${index}` : `local#${index}`,
            // 用户在真机上的每条消息都带 ~10k 的能力前导注入块，不是对话内容。
            injected: text.includes(CAPABILITY_PREAMBLE),
          };
        })
        .filter((m) => m.text.length > 0);

      // 第二个来源：Studio 注入层的 SSE 派生镜像（虚拟列表挂不全时的权威答案源）。
      const mirror = readStudioMirror();

      // fail-closed：两个来源都没有内容就是「读不到」，不是「读到空」。
      if (messages.length === 0 && mirror.assistantTexts.length === 0) {
        return { ok: false, error: 'no-messages-found' };
      }

      return {
        ok: true,
        data: {
          sessionId,
          count: messages.length,
          messages,
          mirror: {
            count: mirror.count,
            assistantTexts: mirror.assistantTexts,
            lastAssistantText: mirror.assistantTexts.at(-1) ?? '',
          },
        },
      };
    },
  };
}
