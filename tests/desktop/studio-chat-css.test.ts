/**
 * STUDIO_CHAT_CSS · 文档流式排版视觉契约单测
 * 覆盖 §2.1 的 9 条目标 + 类名契约 + 深色令牌完整性 + 边界/异常路径。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { STUDIO_CHAT_CSS } from '../../src/ui/studio-chat-css';

const SRC = readFileSync(
  fileURLToPath(new URL('../../src/ui/studio-chat-css.ts', import.meta.url)),
  'utf8',
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Rule {
  selector: string;
  body: string;
}

function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

const CSS = stripComments(STUDIO_CHAT_CSS);
const RULES = parseRules(CSS);

const DARK_START = CSS.indexOf('@media (prefers-color-scheme: dark)');
const LIGHT_CSS = DARK_START >= 0 ? CSS.slice(0, DARK_START) : CSS;
const DARK_CSS = DARK_START >= 0 ? CSS.slice(DARK_START) : '';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 选择器中"完整命中"某个类（不会把 .ds-sc-think 误认成 .ds-sc-think-head） */
function selectorHas(selector: string, token: string): boolean {
  // 非正则实现：带点 token 必须匹配在类起始点上（前面是边界字符或开头），
  // 不带点 token 允许前面是复合选择器的连接点号。
  const isNameChar = (ch: string | undefined) => ch !== undefined && /[\w-]/.test(ch);
  const boundary = ' \t\n\r,>+~(:[';
  const dotted = token.startsWith('.');
  let from = 0;
  while (from <= selector.length) {
    const at = selector.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? undefined : selector[at - 1];
    const after = selector[at + token.length];
    const prefixOk =
      at === 0 ||
      before === undefined ||
      // 带点 token：点本身就是类起始，前面的字符只要是选择器边界（非另一个点）即可，
      // 复合选择器 .a.b 中 b 前面是字母属于合法情形。
      (dotted ? before !== '.' : before === '.' || boundary.includes(before));
    const suffixOk = !isNameChar(after);
    if (prefixOk && suffixOk) return true;
    from = at + 1;
  }
  return false;
}

function rulesFor(token: string): Rule[] {
  return RULES.filter((r) => selectorHas(r.selector, token));
}

function bodyOf(token: string): string {
  return rulesFor(token)
    .map((r) => r.body)
    .join('\n');
}

function lastProp(token: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${escapeRe(prop)}\\s*:\\s*([^;]+);`, 'i');
  let value: string | undefined;
  for (const r of rulesFor(token)) {
    const m = r.body.match(re);
    if (m) value = m[1].trim();
  }
  return value;
}

/* ---------------------------------------------------------------- 契约 */

describe('契约：导出与类名清单', () => {
  it('文件只导出 STUDIO_CHAT_CSS 一个常量', () => {
    expect(SRC).toMatch(/export\s+const\s+STUDIO_CHAT_CSS\s*=\s*`/);
    expect(SRC.match(/\bexport\b/g) ?? []).toHaveLength(1);
  });

  const CLASSES = [
    '.ds-studio-chat-container', '.ds-studio-chat-hidden', '.ds-studio-chat-pending',
    '.ds-sc-message-list', '.ds-sc-empty-state', '.ds-sc-empty-title', '.ds-sc-empty-body',
    '.ds-sc-empty-hint', '.ds-sc-error-card', '.ds-sc-error-title', '.ds-sc-error-body',
    '.ds-sc-error-code', '.ds-sc-truncation-note', '.ds-sc-msg-user', '.ds-sc-msg-assistant',
    '.ds-sc-msg-main-bot', '.ds-sc-msg-sub-bot', '.ds-sc-sender-row', '.ds-sc-avatar',
    '.ds-sc-sender', '.ds-sc-copy-btn', '.ds-sc-think', '.ds-sc-think-head',
    '.ds-sc-think-caret', '.ds-sc-think-body', '.ds-sc-think.open', '.ds-sc-streaming',
    '.ds-sc-cursor', '.ds-sc-scroll-btn', '.ds-sc-scroll-btn.show', '.ds-sc-thinking-preface',
    '.ds-sc-markdown', '.ds-sc-code-lang', '.ds-sc-code-copy', '.dsx-tools-root',
    '.ds-sc-inspector', '.ds-sc-inspector.open', '.ds-sc-inspector-head',
    '.ds-sc-inspector-list', '.ds-sc-inspector-item', '.ds-sc-inspector-tool',
    '.ds-sc-inspector-meta', '.ds-sc-inspector-error', '.ds-sc-inspector-close',
    '.ds-sc-status-bar', '.ds-sc-status-dot', '.ds-sc-status-dot.busy',
    '.ds-sc-status-dot.done', '.ds-sc-status-dot.error', '.ds-sc-status-text',
    '.ds-sc-persistence', '.ds-sc-clear-btn', '.ds-sc-inspector-toggle',
  ];

  it.each(CLASSES)('类名 %s 出现在选择器中', (name) => {
    expect(rulesFor(name).length).toBeGreaterThan(0);
  });

  const COMPOUND = [
    '.ds-sc-inspector-toggle[aria-expanded="true"]',
    '.ds-sc-inspector-item[data-phase="succeeded"]',
    '.ds-sc-inspector-item[data-phase="failed"]',
    '.ds-sc-inspector-item[data-phase="denied"]',
    '.ds-sc-inspector-item[data-phase="error"]',
    '.ds-sc-markdown h1', '.ds-sc-markdown h2', '.ds-sc-markdown h3',
    '.ds-sc-markdown p', '.ds-sc-markdown ul', '.ds-sc-markdown ol', '.ds-sc-markdown li',
    '.ds-sc-markdown pre', '.ds-sc-markdown code', '.ds-sc-markdown blockquote',
    '.ds-sc-markdown a', '.ds-sc-markdown table', '.ds-sc-markdown th', '.ds-sc-markdown td',
  ];

  it.each(COMPOUND)('选择器 %s 存在', (sel) => {
    expect(RULES.some((r) => r.selector.includes(sel))).toBe(true);
  });
});

/* ------------------------------------------------------- 目标 ① 文档流 */

describe('目标 ① 助手消息 = 无框正文文档流', () => {
  it('.ds-sc-msg-assistant 相关规则都不含卡片盒属性', () => {
    const rules = rulesFor('.ds-sc-msg-assistant');
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.body, r.selector).not.toMatch(/(^|;|\s)background\s*:/);
      expect(r.body, r.selector).not.toMatch(/(^|;|\s)border(-[a-z]+)?\s*:/);
      expect(r.body, r.selector).not.toMatch(/border-radius\s*:/);
      expect(r.body, r.selector).not.toMatch(/box-shadow\s*:/);
    }
  });

  it('层级靠字号/行高/留白表达', () => {
    const body = bodyOf('.ds-sc-msg-assistant');
    expect(body).toMatch(/line-height\s*:/);
    expect(body).toMatch(/word-break\s*:/);
    expect(body).toMatch(/width\s*:\s*100%/);
  });
});

/* ------------------------------------------------- 目标 ② 发送者行处理 */

describe('目标 ② 发送者行', () => {
  it('main-bot 的发送者行隐藏', () => {
    const rules = rulesFor('.ds-sc-sender-row').filter((r) =>
      r.selector.includes('.ds-sc-msg-main-bot'),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => /display\s*:\s*none/.test(r.body))).toBe(true);
  });

  it('sub-bot 保留身份标识（细左边线 + 小标签）且发送者行可见', () => {
    const own = rulesFor('.ds-sc-msg-sub-bot').filter((r) =>
      /^\S*\.ds-sc-msg-sub-bot\s*\{/.test(r.selector) || r.selector === '.ds-sc-msg-sub-bot',
    );
    expect(own.length).toBe(1);
    expect(own[0].body).toMatch(/border-left\s*:\s*2px\s+solid\s+var\(--ds-violet\)/);
    const senderRow = rulesFor('.ds-sc-sender-row').filter((r) =>
      r.selector.includes('.ds-sc-msg-sub-bot'),
    );
    expect(senderRow.length).toBeGreaterThan(0);
    expect(senderRow.every((r) => !/display\s*:\s*none/.test(r.body))).toBe(true);
    expect(rulesFor('.ds-sc-msg-sub-bot .ds-sc-avatar').length).toBe(1);
    expect(rulesFor('.ds-sc-msg-sub-bot .ds-sc-sender').length).toBe(1);
  });
});

/* ------------------------------------------------- 目标 ③ 用户消息气泡 */

describe('目标 ③ 用户消息 = 右对齐气泡', () => {
  it('保留右对齐气泡形态', () => {
    const body = bodyOf('.ds-sc-msg-user');
    expect(body).toMatch(/align-self\s*:\s*flex-end/);
    expect(body).toMatch(/background\s*:\s*var\(--ds-user-bg\)/);
    expect(body).toMatch(/border-radius\s*:/);
    expect(body).toMatch(/white-space\s*:\s*pre-wrap/);
  });

  it('气泡限宽，不会横穿整行', () => {
    expect(lastProp('.ds-sc-msg-user', 'max-width')).toMatch(/min\(/);
  });
});

/* ------------------------------------------------- 目标 ④ 错误提示降噪 */

describe('目标 ④ 错误提示 = 安静行内', () => {
  it('左侧细线 + 无圆角盒 + 无阴影 + 无大红底', () => {
    const body = bodyOf('.ds-sc-error-card');
    expect(body).toMatch(/border-left\s*:\s*2px\s+solid\s+var\(--ds-danger\)/);
    expect(body).not.toMatch(/border-radius/);
    expect(body).not.toMatch(/box-shadow/);
    expect(body).not.toMatch(/#fff7f7|#fecaca|#f1b7b7/);
  });

  it('标题为小字号（≤12px）', () => {
    const size = lastProp('.ds-sc-error-title', 'font-size');
    expect(size).toBeDefined();
    expect(parseFloat(size as string)).toBeLessThanOrEqual(12);
  });

  it('截断提示与错误同构但用暖色细线', () => {
    const body = bodyOf('.ds-sc-truncation-note');
    expect(body).toMatch(/border-left\s*:\s*2px\s+solid\s+var\(--ds-warn\)/);
    expect(body).not.toMatch(/box-shadow/);
  });
});

/* ------------------------------------------------- 目标 ⑤ 思考块降噪 */

describe('目标 ⑤ 思考块 = 可折叠 + 降噪', () => {
  it('折叠语义保留', () => {
    expect(bodyOf('.ds-sc-think-body')).toMatch(/display\s*:\s*none/);
    expect(bodyOf('.ds-sc-think.open')).toMatch(/display\s*:\s*block/);
    expect(bodyOf('.ds-sc-think-caret')).toMatch(/transform\s*:/);
  });

  it('视觉降噪：极浅底 + 细边线 + 小字号', () => {
    const think = bodyOf('.ds-sc-think');
    expect(think).toMatch(/background\s*:\s*var\(--ds-think-bg\)/);
    expect(think).toMatch(/border-left\s*:\s*2px/);
    expect(think).not.toMatch(/box-shadow/);
    const head = lastProp('.ds-sc-think-head', 'font-size');
    expect(parseFloat(head as string)).toBeLessThanOrEqual(12);
  });
});

/* ------------------------------------------------- 目标 ⑥ 工具条目隔离 */

describe('目标 ⑥ 工具执行条目由独立模块渲染', () => {
  it('本文件不出现独立工具模块的选择器', () => {
    expect(STUDIO_CHAT_CSS).not.toContain('.ds-flow');
  });

  it('工具根节点只保留段落级间距', () => {
    const rules = rulesFor('.dsx-tools-root');
    expect(rules).toHaveLength(1);
    expect(rules[0].body).toMatch(/margin\s*:/);
    expect(rules[0].body).not.toMatch(/background|border|padding|box-shadow/);
  });
});

/* --------------------------------------- 目标 ⑦ Inspector / 状态栏轻量化 */

describe('目标 ⑦ Inspector 与状态栏轻量化', () => {
  it('状态栏细线 + 玻璃面焦散上下文（chrome surface）', () => {
    const body = bodyOf('.ds-sc-status-bar');
    expect(body).toMatch(/border-top\s*:\s*1px\s+solid\s+var\(--ds-line\)/);
    expect(body).toMatch(/background\s*:\s*var\(--ds-chrome-surface\)/);
    expect(body).toMatch(/backdrop-filter\s*:\s*var\(--ds-chrome-blur\)/);
  });

  it('状态点动画保留', () => {
    expect(CSS).toContain('@keyframes ds-sc-pulse');
    expect(CSS).toContain('@keyframes ds-sc-blink');
    expect(bodyOf('.ds-sc-status-dot.busy')).toMatch(/animation\s*:\s*ds-sc-pulse/);
    expect(bodyOf('.ds-sc-cursor')).toMatch(/animation\s*:\s*ds-sc-blink/);
  });

  it('Inspector 条目按 data-phase 区分状态', () => {
    const ok = bodyOf('.ds-sc-inspector-item[data-phase="succeeded"]');
    const bad =
      bodyOf('.ds-sc-inspector-item[data-phase="failed"]') +
      bodyOf('.ds-sc-inspector-item[data-phase="denied"]') +
      bodyOf('.ds-sc-inspector-item[data-phase="error"]');
    expect(ok).toMatch(/border-left-color\s*:\s*var\(--ds-ok\)/);
    expect(bad).toMatch(/border-left-color\s*:\s*var\(--ds-danger\)/);
    expect(ok.trim()).not.toEqual(bad.trim());
    expect(bodyOf('.ds-sc-inspector-item')).not.toMatch(/box-shadow/);
  });

  it('Inspector 开关激活态保留', () => {
    const body = bodyOf('.ds-sc-inspector-toggle[aria-expanded="true"]');
    expect(body).toMatch(/color\s*:\s*var\(--ds-accent-ink\)/);
    expect(body).toMatch(/background\s*:/);
    expect(body).toMatch(/border-color\s*:\s*var\(--ds-accent\)/);
  });
});

/* ------------------------------------------------- 目标 ⑧ Markdown 排版 */

describe('目标 ⑧ Markdown 排版升级', () => {
  it('标题层级 h1 > h2 > h3 且首元素不顶大边距', () => {
    const h1 = parseFloat(lastProp('.ds-sc-markdown h1', 'font-size') as string);
    const h2 = parseFloat(lastProp('.ds-sc-markdown h2', 'font-size') as string);
    const h3 = parseFloat(lastProp('.ds-sc-markdown h3', 'font-size') as string);
    expect(h1).toBeGreaterThan(h2);
    expect(h2).toBeGreaterThan(h3);
    expect(bodyOf('.ds-sc-markdown h1:first-child')).toMatch(/margin-top\s*:\s*0/);
  });

  it('代码块浅底圆角，且 pre code 复位', () => {
    const pre = bodyOf('.ds-sc-markdown pre');
    expect(pre).toMatch(/background\s*:\s*var\(--ds-code-bg\)/);
    expect(pre).toMatch(/border-radius\s*:\s*8px/);
    expect(pre).toMatch(/overflow-x\s*:\s*auto/);
    expect(bodyOf('.ds-sc-markdown pre code')).toMatch(/background\s*:\s*none/);
  });

  it('引用轻量化（细线、无填充）', () => {
    const body = bodyOf('.ds-sc-markdown blockquote');
    expect(body).toMatch(/border-left\s*:\s*2px\s+solid\s+var\(--ds-line-2\)/);
    expect(body).not.toMatch(/background/);
    expect(body).not.toMatch(/box-shadow/);
  });

  it('表格细线', () => {
    expect(bodyOf('.ds-sc-markdown table')).toMatch(/border-collapse\s*:\s*collapse/);
    const cell = bodyOf('.ds-sc-markdown td');
    expect(cell).toMatch(/border\s*:\s*1px\s+solid\s+var\(--ds-line\)/);
    expect(cell).not.toMatch(/box-shadow/);
  });

  it('链接用墨蓝强调而非纯亮蓝', () => {
    expect(bodyOf('.ds-sc-markdown a')).toMatch(/color\s*:\s*var\(--ds-accent-ink\)/);
  });
});

/* ------------------------------------------------- 目标 ⑨ 深色模式 */

describe('目标 ⑨ 深色模式', () => {
  it('存在 prefers-color-scheme: dark', () => {
    expect(DARK_START).toBeGreaterThan(0);
    expect(DARK_CSS).toContain('--ds-bg:');
  });

  it('所有用到的令牌在明暗两套里都有定义（无漏网颜色）', () => {
    const used = new Set([...CSS.matchAll(/var\((--ds-[\w-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(15);
    const light = new Set([...LIGHT_CSS.matchAll(/(--ds-[\w-]+)\s*:/g)].map((m) => m[1]));
    const dark = new Set([...DARK_CSS.matchAll(/(--ds-[\w-]+)\s*:/g)].map((m) => m[1]));
    for (const v of used) {
      expect(light.has(v), '浅色缺少 ' + v).toBe(true);
      expect(dark.has(v), '深色缺少 ' + v).toBe(true);
    }
  });

  it('深色覆盖核心表面/文字/线条/语义色令牌', () => {
    for (const key of [
      '--ds-bg', '--ds-surface', '--ds-ink', '--ds-ink-2', '--ds-ink-3',
      '--ds-line', '--ds-line-2', '--ds-accent', '--ds-user-bg', '--ds-code-bg', '--ds-danger',
    ]) {
      expect(DARK_CSS).toContain(key + ':');
    }
  });
});

/* ------------------------------------------------- 边界与异常路径 */

describe('边界与异常路径', () => {
  it('大括号配平且规则量级合理', () => {
    const open = (CSS.match(/\{/g) ?? []).length;
    const close = (CSS.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThan(30);
  });

  it('模板字符串安全：无反引号、无插值', () => {
    expect(STUDIO_CHAT_CSS).not.toContain('`');
    expect(STUDIO_CHAT_CSS).not.toContain('${');
  });

  it('零依赖：无 @import / url() 外链', () => {
    expect(CSS).not.toMatch(/@import/);
    expect(CSS).not.toMatch(/url\(/);
  });

  it('!important 只出现在隐藏/待揭示两个闸门规则', () => {
    const flagged = RULES.filter((r) => r.body.includes('!important'));
    expect(flagged.length).toBeGreaterThan(0);
    for (const r of flagged) {
      expect(r.selector).toMatch(/ds-studio-chat-hidden|ds-studio-chat-pending/);
    }
  });

  it('overlay 容器保留分层与占位契约', () => {
    const body = bodyOf('.ds-studio-chat-container');
    expect(body).toMatch(/position\s*:\s*fixed/);
    expect(body).toMatch(/z-index\s*:\s*2147483000/);
    expect(body).toMatch(/bottom\s*:\s*280px/);
    expect(body).toMatch(/color-scheme\s*:\s*light/);
    expect(DARK_CSS).toMatch(/color-scheme\s*:\s*dark/);
  });
});
