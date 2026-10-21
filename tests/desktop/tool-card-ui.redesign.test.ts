/**
 * @vitest-environment jsdom
 *
 * tool-card-ui.redesign 的 DOM 级单测。
 * 覆盖验收点 5 全部场景（running / succeeded / failed、denied、cancelled /
 * 长结果折叠展开 / 图片网格 / 同 callId 不重复建卡 / <script> 转义 / reduced-motion），
 * 并按 §4 要求补足边界与异常路径。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolCardData, ToolCardResult } from '../../src/inject/tool-card-ui.redesign';
import {
  createRedesignedToolCard,
  formatDurationMs,
  formatResultText,
  resolveToolStatus,
  summarizeParams,
  summarizeResultText,
  updateRedesignedToolCardByCallId,
} from '../../src/inject/tool-card-ui.redesign';

function makeContainer(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

function q<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const node = root.querySelector<E>(selector);
  if (!node) throw new Error(`missing node: ${selector}`);
  return node;
}

function cardOf(container: HTMLElement): HTMLElement {
  return q<HTMLElement>(container, '.dsx-tool-card');
}

function textOf(root: ParentNode, selector: string): string {
  return Array.from(root.querySelectorAll(selector))
    .map((node) => node.textContent ?? '')
    .join(' · ');
}

function openCard(container: HTMLElement): HTMLElement {
  const card = cardOf(container);
  q<HTMLButtonElement>(card, '.dsx-tool-card-head').click();
  return card;
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('running 渲染与标题行', () => {
  it('running：状态文本、role=group、aria-label、默认折叠、活动指示', () => {
    const container = makeContainer();
    const data: ToolCardData = {
      toolName: 'read_file',
      params: { path: 'src/a.ts', query: 'render', mode: 'r', limit: 20, extra: 1 },
      durationMs: 120,
    };
    expect(createRedesignedToolCard(data, 'call-1', container)).toBe('call-1');

    const card = cardOf(container);
    expect(card.dataset.callId).toBe('call-1');
    expect(card.dataset.status).toBe('running');
    expect(textOf(card, '.dsx-tool-status-text')).toBe('执行中');
    expect(card.getAttribute('role')).toBe('group');
    const ariaLabel = card.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('read_file');
    expect(ariaLabel).toContain('执行中');

    const body = q<HTMLElement>(card, '.dsx-tool-card-body');
    expect(body.hasAttribute('hidden')).toBe(true);
    const head = q<HTMLButtonElement>(card, '.dsx-tool-card-head');
    expect(head.tagName).toBe('BUTTON');
    expect(head.type).toBe('button');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.getAttribute('aria-controls')).toBe(body.id);

    expect(card.querySelector('.dsx-tool-status.dsx-state-running .dsx-dot')).not.toBeNull();
    expect(textOf(card, '.dsx-tool-duration')).toBe('120ms');
    expect(textOf(container, '.dsx-tools-count')).toBe('1');
    expect(textOf(card, '.dsx-tool-hint')).toContain('path:');
    expect(textOf(card, '.dsx-tool-meta')).toContain('暂无结果');
    // 状态文案固定中文、无 emoji
    expect(textOf(card, '.dsx-tool-status-text')).toMatch(/^[一-龥]+$/);
  });

  it('标题行含工具名与耗时，durationMs=0 也显示', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'shell', params: { cmd: 'ls' }, durationMs: 0 }, 'c0', container);
    const card = cardOf(container);
    expect(textOf(card, '.dsx-tool-name')).toBe('shell');
    expect(textOf(card, '.dsx-tool-duration')).toBe('0ms');
  });

  it('formatDurationMs 边界：毫秒 / 秒 / 分钟 / 非法输入', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(200)).toBe('200ms');
    expect(formatDurationMs(1250)).toBe('1.25s');
    expect(formatDurationMs(2000)).toBe('2s');
    expect(formatDurationMs(125000)).toBe('2m 5s');
    expect(formatDurationMs(Number.NaN)).toBe('');
    expect(formatDurationMs(-1)).toBe('');
  });
});

describe('终态语义：succeeded / failed / denied / cancelled / terminated', () => {
  it('succeeded 更新：结果摘要 + 耗时覆盖 + 可展开全文', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 'search', params: { q: 'x' } };
    createRedesignedToolCard(data, 'c2', container);
    updateRedesignedToolCardByCallId('c2', data, { ok: true, data: 'hello world' }, container, 800);

    const card = cardOf(container);
    expect(card.dataset.status).toBe('succeeded');
    expect(textOf(card, '.dsx-tool-status-text')).toBe('已完成');
    expect(textOf(card, '.dsx-tool-duration')).toBe('800ms');
    expect(textOf(card, '.dsx-tool-result-summary')).toContain('hello world');
    expect(q<HTMLElement>(card, '.dsx-tool-result-full').hasAttribute('hidden')).toBe(true);
    const toggle = q<HTMLButtonElement>(card, '.dsx-tool-result-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('展开全文');
    expect(textOf(card, '.dsx-tool-meta')).toContain('文本 11 字符');
  });

  it('failed：ok=false → 执行失败，弱色终态（可见不刺眼）', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 'read_file', params: { path: 'a.ts' } };
    createRedesignedToolCard(data, 'c3', container);
    updateRedesignedToolCardByCallId(
      'c3',
      data,
      { ok: false, error: 'ENOENT: no such file' },
      container,
      30,
    );

    const card = cardOf(container);
    expect(card.dataset.status).toBe('failed');
    expect(card.className).toContain('dsx-state-failed');
    expect(textOf(card, '.dsx-tool-status-text')).toBe('执行失败');
    expect(textOf(card, '.dsx-tool-result-summary')).toContain('ENOENT');
    const css = document.getElementById('dsx-tool-card-style')?.textContent ?? '';
    expect(css).toContain('--dsx-failed-ink: #b91c1c');
    expect(css).toContain('--dsx-failed-line: #fca5a5');
  });

  it('denied：details.status 与错误文案两条路径', () => {
    const c1 = makeContainer();
    const d1: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d1, 'd1', c1);
    updateRedesignedToolCardByCallId(
      'd1',
      d1,
      { ok: false, error: 'nope', details: { status: 'permission_denied' } },
      c1,
    );
    expect(cardOf(c1).dataset.status).toBe('denied');
    expect(textOf(cardOf(c1), '.dsx-tool-status-text')).toBe('已拒绝');

    const c2 = makeContainer();
    const d2: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d2, 'd2', c2);
    updateRedesignedToolCardByCallId('d2', d2, { ok: false, error: 'Permission denied by user' }, c2);
    expect(cardOf(c2).dataset.status).toBe('denied');
  });

  it('cancelled：details.status 与错误文案两条路径', () => {
    const c1 = makeContainer();
    const d1: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d1, 'x1', c1);
    updateRedesignedToolCardByCallId('x1', d1, { ok: false, details: { status: 'cancelled' } }, c1);
    expect(textOf(cardOf(c1), '.dsx-tool-status-text')).toBe('已取消');

    const c2 = makeContainer();
    const d2: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d2, 'x2', c2);
    updateRedesignedToolCardByCallId('x2', d2, { ok: false, error: 'aborted by user' }, c2);
    expect(cardOf(c2).dataset.status).toBe('cancelled');
  });

  it('terminated：terminate=true 优先于成功态', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(data, 't1', container);
    updateRedesignedToolCardByCallId(
      't1',
      data,
      { ok: true, data: 'partial', terminate: true },
      container,
    );
    const card = cardOf(container);
    expect(card.dataset.status).toBe('terminated');
    expect(textOf(card, '.dsx-tool-status-text')).toBe('已终止');
  });

  it('resolveToolStatus 优先级与边界', () => {
    expect(resolveToolStatus(undefined)).toBe('running');
    expect(resolveToolStatus({ ok: true })).toBe('succeeded');
    expect(resolveToolStatus({ ok: false })).toBe('failed');
    expect(resolveToolStatus({ ok: true, isError: true })).toBe('failed');
    expect(resolveToolStatus({ ok: false, error: 'x', details: { status: 'denied' } })).toBe('denied');
    expect(resolveToolStatus({ ok: true, terminate: true })).toBe('terminated');
    expect(resolveToolStatus({ ok: false, error: 'UNKNOWN', details: { status: 'weird-value' } })).toBe('failed');
    expect(resolveToolStatus({ ok: true, details: { status: 'running' } })).toBe('running');
    expect(resolveToolStatus({ ok: false, error: 'cancelled: timeout', terminate: true })).toBe('terminated');
  });
});

describe('信息架构：参数摘要 / 结果折叠 / 图片网格', () => {
  it('参数默认只给关键摘要，完整 JSON 需展开', () => {
    const params = {
      path: `src/${'a'.repeat(80)}`,
      query: 'render',
      mode: 'r',
      limit: 20,
      extra: 1,
    };
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'grep', params, durationMs: 12 }, 'p1', container);
    const card = openCard(container);

    expect(card.querySelectorAll('.dsx-tool-chip:not(.dsx-tool-chip-more)').length).toBe(4);
    expect(textOf(card, '.dsx-tool-chip-more')).toBe('另有 1 项');
    const firstValue = q<HTMLElement>(card, '.dsx-tool-chip-value');
    expect(firstValue.textContent?.endsWith('…')).toBe(true);
    expect(summarizeParams(params, 2).length).toBe(2);
    expect(summarizeParams(params, 2)[0].key).toBe('path');

    const json = q<HTMLElement>(card, '.dsx-tool-params-json');
    const toggle = q<HTMLButtonElement>(card, '.dsx-tool-params-toggle');
    expect(json.hasAttribute('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(json.hasAttribute('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(json.id);
    expect(json.textContent).toContain('extra');
    toggle.click();
    expect(json.hasAttribute('hidden')).toBe(true);
  });

  it('长结果默认折叠摘要，展开全文后再展开全部', () => {
    const longText = 'x'.repeat(5000);
    const data: ToolCardData = { toolName: 'read_file', params: {} };
    const container = makeContainer();
    createRedesignedToolCard(data, 'r1', container);
    updateRedesignedToolCardByCallId('r1', data, { ok: true, data: longText }, container);
    const card = openCard(container);

    const summary = q<HTMLElement>(card, '.dsx-tool-result-summary');
    expect(summary.textContent?.length).toBe(161);
    expect(summary.textContent?.endsWith('…')).toBe(true);
    const full = q<HTMLElement>(card, '.dsx-tool-result-full');
    expect(full.hasAttribute('hidden')).toBe(true);

    const toggle = q<HTMLButtonElement>(card, '.dsx-tool-result-toggle');
    toggle.click();
    expect(full.hasAttribute('hidden')).toBe(false);
    expect(summary.hasAttribute('hidden')).toBe(true);
    const pre = q<HTMLElement>(card, '.dsx-tool-result-text');
    expect(pre.className).toContain('dsx-clamped');
    const expandAll = q<HTMLButtonElement>(card, '.dsx-tool-result-expand-all');
    expect(expandAll.getAttribute('aria-expanded')).toBe('false');

    expandAll.click();
    expect(pre.className).not.toContain('dsx-clamped');
    expect(expandAll.hasAttribute('hidden')).toBe(true);
    expect(expandAll.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('收起');

    toggle.click();
    expect(full.hasAttribute('hidden')).toBe(true);
    expect(summary.hasAttribute('hidden')).toBe(false);

    expect(summarizeResultText('abc')).toBe('abc');
    expect(summarizeResultText('')).toBe('');
    expect(summarizeResultText('a'.repeat(200)).length).toBe(161);
  });

  it('图片结果保留网格，元信息计数正确', () => {
    const result: ToolCardResult = {
      ok: true,
      content: [
        { type: 'text', text: '截图完成' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'javascript:alert(1)' } },
        { type: 'image_url', image_url: { url: 'http://insecure.example.com/b.png' } },
      ],
    };
    const data: ToolCardData = { toolName: 'screenshot', params: {} };
    const container = makeContainer();
    createRedesignedToolCard(data, 'i1', container);
    updateRedesignedToolCardByCallId('i1', data, result, container);
    const card = openCard(container);

    const grid = q<HTMLElement>(card, '.dsx-tool-images');
    const imgs = grid.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute('src')).toBe('https://example.com/a.png');
    expect(imgs[1].getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(imgs[0].getAttribute('alt')).toBe('工具结果图片 1');
    expect(textOf(card, '.dsx-tool-meta')).toContain('图片 2 张');
    expect(textOf(card, '.dsx-tool-meta')).toContain('文本 4 字符');
  });

  it('纯图片结果不出空文本块；空结果显示占位', () => {
    const onlyImages: ToolCardResult = {
      ok: true,
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/z.png' } }],
    };
    const d1: ToolCardData = { toolName: 'shot', params: {} };
    const c1 = makeContainer();
    createRedesignedToolCard(d1, 'z1', c1);
    updateRedesignedToolCardByCallId('z1', d1, onlyImages, c1);
    const card1 = openCard(c1);
    expect(card1.querySelector('.dsx-tool-result-full')).toBeNull();
    expect(card1.querySelector('.dsx-tool-result-summary')).toBeNull();
    expect(card1.querySelectorAll('.dsx-tool-image').length).toBe(1);

    const d2: ToolCardData = { toolName: 'noop', params: {} };
    const c2 = makeContainer();
    createRedesignedToolCard(d2, 'z2', c2);
    updateRedesignedToolCardByCallId('z2', d2, { ok: true }, c2);
    const card2 = openCard(c2);
    expect(textOf(card2, '.dsx-tool-meta')).toContain('（无内容）');
    expect(card2.querySelector('.dsx-tool-result-full')).toBeNull();
    expect(textOf(card2, '.dsx-tool-chips')).toBe('（无参数）');
    expect(textOf(card2, '.dsx-tool-params-toggle')).toBe('完整 JSON');
  });
});

describe('callId 生命周期', () => {
  it('同 callId 重复更新不重复建卡', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 't', params: {} };
    createRedesignedToolCard(data, 'same', container);
    updateRedesignedToolCardByCallId('same', data, { ok: true, data: 'a' }, container);
    updateRedesignedToolCardByCallId('same', data, { ok: true, data: 'b' }, container, 42);
    expect(container.querySelectorAll('.dsx-tool-card').length).toBe(1);
    expect(textOf(container, '.dsx-tools-count')).toBe('1');
    expect(textOf(cardOf(container), '.dsx-tool-result-summary')).toContain('b');
    expect(textOf(cardOf(container), '.dsx-tool-duration')).toBe('42ms');
  });

  it('create 重复 callId 也不重复建卡', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 't', params: {} };
    createRedesignedToolCard(data, 'dup', container);
    createRedesignedToolCard(data, 'dup', container);
    expect(container.querySelectorAll('.dsx-tool-card').length).toBe(1);
    expect(textOf(container, '.dsx-tools-count')).toBe('1');
  });

  it('DOM 重渲染后按 callId 重建卡片', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 'rebuild', params: { a: 1 } };
    createRedesignedToolCard(data, 'rb', container);
    cardOf(container).remove();
    updateRedesignedToolCardByCallId('rb', data, { ok: false, error: 'boom' }, container);
    expect(container.querySelectorAll('.dsx-tool-card').length).toBe(1);
    expect(cardOf(container).dataset.status).toBe('failed');
    expect(textOf(container, '.dsx-tools-count')).toBe('1');
  });

  it('三参形态（data 携带 callId / container）可完成更新', () => {
    const container = makeContainer();
    updateRedesignedToolCardByCallId(
      { toolName: 'inline', params: { k: 1 }, callId: 'k1', container },
      { ok: true, data: 'done' },
      250,
    );
    const card = cardOf(container);
    expect(card.dataset.callId).toBe('k1');
    expect(textOf(card, '.dsx-tool-duration')).toBe('250ms');
    expect(textOf(card, '.dsx-tool-result-summary')).toContain('done');
    expect(card.dataset.status).toBe('succeeded');
  });
});

describe('安全与 DOM 隔离', () => {
  it('<script> 字符串被转义，不产生脚本节点', () => {
    const data: ToolCardData = {
      toolName: '<script>alert(1)</script>',
      params: { payload: '<img src=x onerror=alert(1)>' },
    };
    const container = makeContainer();
    createRedesignedToolCard(data, 's1', container);
    updateRedesignedToolCardByCallId('s1', data, { ok: true, data: '<script>alert(2)</script>' }, container);
    const card = cardOf(container);

    expect(card.querySelectorAll('script').length).toBe(0);
    expect(card.querySelectorAll('img').length).toBe(0);
    expect(card.textContent).toContain('<script>alert(1)</script>');
    expect(card.textContent).toContain('<script>alert(2)</script>');
    expect(card.innerHTML).toContain('&lt;script');
    expect(card.innerHTML).not.toContain('<script');
  });

  it('危险图片协议被丢弃，仅 https / data:image 保留', () => {
    const result: ToolCardResult = {
      ok: true,
      content: [
        { type: 'image_url', image_url: { url: 'javascript:alert(1)' } },
        { type: 'image_url', image_url: { url: 'vbscript:msgbox(1)' } },
        { type: 'image_url', image_url: { url: 'http://a.example.com/x.png' } },
      ],
    };
    const data: ToolCardData = { toolName: 'shot', params: {} };
    const container = makeContainer();
    createRedesignedToolCard(data, 's2', container);
    updateRedesignedToolCardByCallId('s2', data, result, container);
    const card = openCard(container);
    expect(card.querySelector('.dsx-tool-images')).toBeNull();
    expect(card.querySelectorAll('img').length).toBe(0);
  });

  it('不改写既有 DOM，新建节点均为 dsx- 前缀', () => {
    const container = makeContainer();
    const native = document.createElement('div');
    native.className = 'deepseek-message-content';
    native.textContent = '原生内容';
    native.setAttribute('data-reactid', 'x1');
    container.appendChild(native);
    const before = native.outerHTML;

    const data: ToolCardData = { toolName: 'keep', params: { a: 1 } };
    createRedesignedToolCard(data, 'iso', container);
    updateRedesignedToolCardByCallId('iso', data, { ok: true, data: 'ok' }, container);

    expect(native.outerHTML).toBe(before);
    expect(container.firstElementChild).not.toBe(native);
    const nodes = Array.from(container.querySelectorAll('*'));
    for (const node of nodes) {
      if (node === native) continue;
      const className = (node as HTMLElement).className;
      if (typeof className !== 'string' || className.trim() === '') continue;
      for (const name of className.split(/\s+/)) {
        expect(name.startsWith('dsx-')).toBe(true);
      }
    }
  });
});

describe('可访问性与降级', () => {
  it('展开按钮 aria-expanded / aria-controls / 可聚焦', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'a11y', params: { p: 1 } }, 'a1', container);
    const card = openCard(container);

    const head = q<HTMLButtonElement>(card, '.dsx-tool-card-head');
    head.focus();
    expect(document.activeElement).toBe(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');

    const toggle = q<HTMLButtonElement>(card, '.dsx-tool-params-toggle');
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    const json = q<HTMLElement>(card, '.dsx-tool-params-json');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(json.id);
  });

  it('根容器折叠按钮可键盘操作', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 't', params: {} }, 'a2', container);
    const head = q<HTMLButtonElement>(container, '.dsx-tools-head');
    head.focus();
    expect(document.activeElement).toBe(head);
    expect(head.type).toBe('button');

    head.click();
    expect(q<HTMLElement>(container, '.dsx-tools-root').className).toContain('dsx-collapsed');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(q<HTMLElement>(container, '.dsx-tools-body').hasAttribute('hidden')).toBe(true);

    head.click();
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(q<HTMLElement>(container, '.dsx-tools-body').hasAttribute('hidden')).toBe(false);
  });

  it('样式：1px 边框 + 2px 左侧状态线、无渐变、深色与 reduced-motion 降级', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'style', params: {} }, 'st', container);
    const css = document.getElementById('dsx-tool-card-style')?.textContent ?? '';

    expect(css).not.toContain('gradient');
    expect(css).toContain('border-left: 2px solid');
    expect(css).toContain('border: 1px solid var(--dsx-border)');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@keyframes dsx-pulse');

    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(reduced).not.toBeNull();
    const block = reduced?.[1] ?? '';
    expect(block).toContain('animation: none');
    expect(block).toContain('transition: none');
    for (const item of block.match(/animation:\s*[^;]+/g) ?? []) {
      expect(item).toContain('none');
    }
  });
});

describe('异常与边界路径', () => {
  it('container 非法 → 抛 TypeError', () => {
    const data: ToolCardData = { toolName: 't', params: {} };
    expect(() => createRedesignedToolCard(data, 'e1', null as unknown as HTMLElement)).toThrow(TypeError);
    expect(() =>
      updateRedesignedToolCardByCallId('e1', data, { ok: true }, undefined as unknown as HTMLElement),
    ).toThrow(TypeError);
    expect(() => updateRedesignedToolCardByCallId({ ...data, callId: 'e2' }, { ok: true })).toThrow(TypeError);
  });

  it('结果文本：isError 前缀 / 旧格式回退 / content 优先', () => {
    expect(formatResultText({ ok: false, error: 'boom', isError: true })).toBe('错误：boom');
    expect(formatResultText({ ok: false, error: 'boom' })).toBe('boom');
    expect(formatResultText({ ok: true, data: 'plain' })).toBe('plain');
    expect(formatResultText({ ok: true, data: { stdout: 'out', stderr: 'err' } })).toBe('out');
    expect(formatResultText({ ok: true, data: { stderr: 'err' } })).toBe('err');
    expect(formatResultText({ ok: true, data: { code: 1 } })).toContain('"code": 1');
    expect(
      formatResultText({
        ok: true,
        data: 'ignored',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        ],
      }),
    ).toBe('a');
    expect(formatResultText({ ok: true })).toBe('');
  });

  it('循环引用 data 不抛异常，回退字符串', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => formatResultText({ ok: true, data: circular })).not.toThrow();
    expect(typeof formatResultText({ ok: true, data: circular })).toBe('string');
  });
});
