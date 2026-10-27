/**
 * @vitest-environment jsdom
 *
 * tool-card-ui.redesign 的 DOM 级单测（v2.0 过程流渲染器）。
 * 覆盖验收点全部场景（running / succeeded / failed / denied / cancelled /
 * terminated、长结果折叠展开 / 图片网格 / 同 callId 不重复建卡 / <script> 转义 / reduced-motion），
 * 并按 §4 要求补足边界与异常路径。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolCardData } from '../../src/inject/tool-card-ui.redesign';
import {
  buildParamBrief,
  createRedesignedToolCard,
  deriveToolStatus,
  formatDurationMs,
  updateRedesignedToolCardByCallId,
} from '../../src/inject/tool-card-ui.redesign';
import { formatToolResultText } from '../../src/shared/tool-result-format';

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

function itemOf(container: HTMLElement): HTMLElement {
  return q<HTMLElement>(container, '.ds-flow-item');
}

function textOf(root: ParentNode, selector: string): string {
  return Array.from(root.querySelectorAll(selector))
    .map((node) => node.textContent ?? '')
    .join(' · ');
}

function openItem(container: HTMLElement): HTMLElement {
  const item = itemOf(container);
  q<HTMLButtonElement>(item, '.ds-flow-row').click();
  return item;
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('running 渲染与行级结构', () => {
  it('running：状态 running、活动指示、行可展开', () => {
    const container = makeContainer();
    const data: ToolCardData = {
      toolName: 'read_file',
      params: { path: 'src/a.ts', query: 'render', mode: 'r', limit: 20, extra: 1 },
      durationMs: 120,
    };
    expect(createRedesignedToolCard(data, 'call-1', container)).toBe('call-1');

    // 顶部摘要行默认收起列表
    const summary = q<HTMLButtonElement>(container, '.ds-flow-summary');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(textOf(container, '.ds-flow-summary-text')).toContain('已调用工具');

    // 展开列表
    summary.click();
    expect(container.querySelector('.ds-flow-list')?.hasAttribute('hidden')).toBe(false);

    const item = itemOf(container);
    expect(item.getAttribute('role')).toBe('listitem');
    expect(item.dataset.callId).toBe('call-1');
    expect(item.dataset.status).toBe('running');

    // running 态有脉动 dot
    const dot = q<HTMLElement>(item, '.ds-flow-dot');
    expect(getComputedStyle(dot).backgroundColor).not.toBe('transparent');

    // 行按钮默认折叠 body
    const row = q<HTMLButtonElement>(item, '.ds-flow-row');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    const bodyId = row.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    const body = document.getElementById(bodyId!);
    expect(body?.hasAttribute('hidden')).toBe(true);

    // 工具名 + 摘要 + 状态 + 耗时 都在行里
    expect(textOf(item, '.ds-flow-tool')).toBe('read_file');
    expect(textOf(item, '.ds-flow-status')).toBe('执行中');
    // running 态用实时 Date.now()-startedAt，应为亚秒级
    const runningTime = textOf(item, '.ds-flow-time');
    expect(runningTime.endsWith('ms')).toBe(true);
    // running 态 status 不 quiet（有颜色）
    expect(q<HTMLElement>(item, '.ds-flow-status').className).not.toContain('--quiet');
  });

  it('标题行含工具名，running 态实时秒表总是 ms 级', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'shell', params: { cmd: 'ls' }, durationMs: 0 }, 'c0', container);
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = itemOf(container);
    expect(textOf(item, '.ds-flow-tool')).toBe('shell');
    // running 态实时秒表（Date.now()-startedAt），总是亚秒级
    expect(textOf(item, '.ds-flow-time').endsWith('ms')).toBe(true);
  });

  it('formatDurationMs 边界：毫秒 / 秒 / 分钟 / 非法输入', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(200)).toBe('200ms');
    expect(formatDurationMs(1250)).toBe('1.3s');
    expect(formatDurationMs(2000)).toBe('2.0s');
    expect(formatDurationMs(125000)).toBe('2m 5s');
    expect(formatDurationMs(Number.NaN)).toBe('');
    expect(formatDurationMs(-1)).toBe('');
  });
});

describe('终态语义：succeeded / failed / denied / cancelled / terminated', () => {
  it('succeeded 更新：quiet 状态、耗时覆盖、结果在展开体', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 'search', params: { q: 'x' } };
    createRedesignedToolCard(data, 'c2', container);
    updateRedesignedToolCardByCallId('c2', data, { ok: true, data: 'hello world' }, container, 800);

    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = itemOf(container);
    expect(item.dataset.status).toBe('succeeded');
    expect(textOf(item, '.ds-flow-status')).toBe('已执行');
    // succeeded 态 status 走 quiet（1px 裁剪）
    expect(q<HTMLElement>(item, '.ds-flow-status').className).toContain('--quiet');
    expect(textOf(item, '.ds-flow-time')).toBe('800ms');

    // 展开条目 → 输出区可见
    q<HTMLButtonElement>(item, '.ds-flow-row').click();
    const body = q<HTMLElement>(item, '.ds-flow-body');
    expect(body.hasAttribute('hidden')).toBe(false);

    const tagOut = Array.from(body.querySelectorAll('.ds-flow-tag')).map(t => t.textContent);
    expect(tagOut).toContain('输出');

    const pre = q<HTMLElement>(body, '.ds-flow-out .ds-flow-pre');
    expect(pre.textContent).toContain('hello world');
  });

  it('failed：ok=false → 失败态，错误颜色', () => {
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

    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = itemOf(container);
    expect(item.dataset.status).toBe('failed');
    expect(textOf(item, '.ds-flow-status')).toBe('失败');

    q<HTMLButtonElement>(item, '.ds-flow-row').click();
    const body = q<HTMLElement>(item, '.ds-flow-body');
    const errorPre = q<HTMLElement>(body, '.ds-flow-pre--error');
    expect(errorPre.textContent).toContain('ENOENT');
  });

  it('denied：details.status=permission_denied 与错误文案两条路径', () => {
    const c1 = makeContainer();
    const d1: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d1, 'd1', c1);
    updateRedesignedToolCardByCallId(
      'd1',
      d1,
      { ok: false, error: 'nope', details: { status: 'permission_denied' } },
      c1,
    );
    q<HTMLButtonElement>(c1, '.ds-flow-summary').click();
    expect(itemOf(c1).dataset.status).toBe('denied');
    expect(textOf(itemOf(c1), '.ds-flow-status')).toBe('被拒');

    const c2 = makeContainer();
    const d2: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d2, 'd2', c2);
    updateRedesignedToolCardByCallId('d2', d2, { ok: false, error: 'Permission denied by user' }, c2);
    q<HTMLButtonElement>(c2, '.ds-flow-summary').click();
    expect(itemOf(c2).dataset.status).toBe('denied');
  });

  it('cancelled：details.status 与错误文案两条路径', () => {
    const c1 = makeContainer();
    const d1: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d1, 'x1', c1);
    updateRedesignedToolCardByCallId('x1', d1, { ok: false, details: { status: 'cancelled' } }, c1);
    q<HTMLButtonElement>(c1, '.ds-flow-summary').click();
    expect(textOf(itemOf(c1), '.ds-flow-status')).toBe('已取消');

    const c2 = makeContainer();
    const d2: ToolCardData = { toolName: 'run', params: {} };
    createRedesignedToolCard(d2, 'x2', c2);
    updateRedesignedToolCardByCallId('x2', d2, { ok: false, error: 'aborted by user' }, c2);
    q<HTMLButtonElement>(c2, '.ds-flow-summary').click();
    expect(itemOf(c2).dataset.status).toBe('cancelled');
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
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = itemOf(container);
    expect(item.dataset.status).toBe('terminated');
    expect(textOf(item, '.ds-flow-status')).toBe('已终止');
  });

  it('deriveToolStatus 优先级与边界', () => {
    expect(deriveToolStatus(undefined)).toBe('running');
    expect(deriveToolStatus({ ok: true })).toBe('succeeded');
    expect(deriveToolStatus({ ok: false })).toBe('failed');
    expect(deriveToolStatus({ ok: true, isError: true })).toBe('failed');
    expect(deriveToolStatus({ ok: false, error: 'x', details: { status: 'denied' } })).toBe('denied');
    expect(deriveToolStatus({ ok: true, terminate: true })).toBe('terminated');
    expect(deriveToolStatus({ ok: false, error: 'UNKNOWN', details: { status: 'weird-value' } })).toBe('failed');
    expect(deriveToolStatus({ ok: true, details: { status: 'running' } })).toBe('running');
    expect(deriveToolStatus({ ok: false, error: 'cancelled: timeout', terminate: true })).toBe('terminated');
  });
});

describe('信息架构：参数摘要 / 结果折叠 / 图片网格', () => {
  it('参数摘要由 buildParamBrief 生成，完整 JSON 在展开体的 muted pre', () => {
    const params = {
      path: `src/${'a'.repeat(80)}`,
      query: 'render',
      mode: 'r',
      limit: 20,
      extra: 1,
    };
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'grep', params, durationMs: 12 }, 'p1', container);
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = openItem(container);

    // 行摘要包含 buildParamBrief 的结果
    const brief = q<HTMLElement>(item, '.ds-flow-brief');
    // BRIEF_KEYS 里 query 在 path 前，先命中
    expect(brief.textContent).toBe('render');
    // buildParamBrief 返回 string
    expect(typeof buildParamBrief(params, 96)).toBe('string');
    // BRIEF_KEYS 里 query 在 path 前，返回 'render'
    expect(buildParamBrief(params, 96)).toBe('render');

    // 展开体里有参数 JSON（muted pre）
    const body = q<HTMLElement>(item, '.ds-flow-body');
    const paramTag = Array.from(body.querySelectorAll('.ds-flow-tag')).find(t => t.textContent === '参数');
    expect(paramTag).toBeTruthy();
    const mutedPre = q<HTMLElement>(body, '.ds-flow-pre--muted');
    expect(mutedPre.textContent).toContain('extra');
    expect(mutedPre.textContent).toContain('path');
  });

  it('长结果 >2048 字符默认 .ds-flow-clamp + .ds-flow-more，点后展开', () => {
    const longText = 'x'.repeat(5000);
    const data: ToolCardData = { toolName: 'read_file', params: {} };
    const container = makeContainer();
    createRedesignedToolCard(data, 'r1', container);
    updateRedesignedToolCardByCallId('r1', data, { ok: true, data: longText }, container);
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = openItem(container);

    const clamp = q<HTMLElement>(item, '.ds-flow-clamp');
    expect(clamp).not.toBeNull();
    const moreBtn = q<HTMLButtonElement>(item, '.ds-flow-more');
    expect(moreBtn.textContent).toContain('展开全部');

    moreBtn.click();
    expect(item.querySelector('.ds-flow-clamp')).toBeNull();
    expect(item.querySelector('.ds-flow-more')).toBeNull();

    // formatToolResultText 对 data 字符串直接返回
    expect(formatToolResultText({ ok: true, data: 'abc' })).toBe('abc');
    expect(formatToolResultText({ ok: true, data: '' })).toBe('');
  });

  it('图片结果保留网格，危险协议被白名单过滤', () => {
    const result: ToolCardData['result'] = {
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
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = openItem(container);

    const shots = item.querySelectorAll('.ds-flow-shot');
    expect(shots.length).toBe(2);
    expect(shots[0].getAttribute('src')).toBe('https://example.com/a.png');
    expect(shots[1].getAttribute('src')).toBe('data:image/png;base64,AAAA');
    // 危险协议已丢弃 → 图片数正好 2

    // 输出 pre 里有 content 中的文本（选 .ds-flow-out 下的 pre，避开参数 muted pre）
    const pre = q<HTMLElement>(item, '.ds-flow-out .ds-flow-pre');
    expect(pre.textContent).toContain('截图完成');
  });

  it('纯图片结果不出空文本 pre；无 result 时 body 只有参数段', () => {
    const onlyImages: ToolCardData['result'] = {
      ok: true,
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/z.png' } }],
    };
    const d1: ToolCardData = { toolName: 'shot', params: {} };
    const c1 = makeContainer();
    createRedesignedToolCard(d1, 'z1', c1);
    updateRedesignedToolCardByCallId('z1', d1, onlyImages, c1);
    q<HTMLButtonElement>(c1, '.ds-flow-summary').click();
    const item1 = openItem(c1);
    expect(item1.querySelectorAll('.ds-flow-shot').length).toBe(1);
    // 纯图片无文本 pre（只有 .ds-flow-shots）
    expect(item1.querySelectorAll('.ds-flow-out').length).toBe(1);

    // 空 result → failed 态（ok=true 无 data）不对，create 时无 result 是 running
    // 改为：running 态下 body 只有参数行
    const d2: ToolCardData = { toolName: 'noop', params: {} };
    const c2 = makeContainer();
    createRedesignedToolCard(d2, 'z2', c2);
    q<HTMLButtonElement>(c2, '.ds-flow-summary').click();
    const item2 = openItem(c2);
    // running 态 body 有参数 tag 但没有输出 tag
    const body2 = q<HTMLElement>(item2, '.ds-flow-body');
    const tags2 = Array.from(body2.querySelectorAll('.ds-flow-tag')).map(t => t.textContent);
    expect(tags2).toContain('参数');
    expect(tags2).not.toContain('输出');
  });
});

describe('callId 生命周期', () => {
  it('同 callId 重复更新不重复建卡', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 't', params: {} };
    createRedesignedToolCard(data, 'same', container);
    updateRedesignedToolCardByCallId('same', data, { ok: true, data: 'a' }, container);
    updateRedesignedToolCardByCallId('same', data, { ok: true, data: 'b' }, container, 42);
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    expect(container.querySelectorAll('.ds-flow-item').length).toBe(1);
    expect(textOf(container, '.ds-flow-summary-text')).toContain('1 次');
    const item = itemOf(container);
    expect(textOf(item, '.ds-flow-time')).toBe('42ms');
  });

  it('create 重复 callId 也不重复建卡', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 't', params: {} };
    createRedesignedToolCard(data, 'dup', container);
    createRedesignedToolCard(data, 'dup', container);
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    expect(container.querySelectorAll('.ds-flow-item').length).toBe(1);
    expect(textOf(container, '.ds-flow-summary-text')).toContain('1 次');
  });

  it('DOM 重渲染后按 callId 重建条目', () => {
    const container = makeContainer();
    const data: ToolCardData = { toolName: 'rebuild', params: { a: 1 } };
    createRedesignedToolCard(data, 'rb', container);
    itemOf(container).remove();
    updateRedesignedToolCardByCallId('rb', data, { ok: false, error: 'boom' }, container);
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    expect(container.querySelectorAll('.ds-flow-item').length).toBe(1);
    expect(itemOf(container).dataset.status).toBe('failed');
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
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = itemOf(container);

    expect(item.querySelectorAll('script').length).toBe(0);
    expect(item.querySelectorAll('img').length).toBe(0);
    expect(item.textContent).toContain('<script>alert(1)</script>');
    expect(item.textContent).toContain('<script>alert(2)</script>');
    expect(item.innerHTML).toContain('&lt;script');
  });

  it('危险图片协议被丢弃，仅 https / data:image 保留', () => {
    const result: ToolCardData['result'] = {
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
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    expect(itemOf(container).querySelectorAll('img').length).toBe(0);
  });

  it('不改写既有 DOM，新建节点均为 ds-flow- 前缀', () => {
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
    const nodes = Array.from(container.querySelectorAll('*'));
    for (const node of nodes) {
      if (node === native) continue;
      const className = (node as HTMLElement).className;
      if (typeof className !== 'string' || className.trim() === '') continue;
      for (const name of className.split(/\s+/)) {
        expect(name.startsWith('ds-flow')).toBe(true);
      }
    }
  });
});

describe('可访问性与降级', () => {
  it('条目行 aria-expanded / aria-controls / 可聚焦', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'a11y', params: { p: 1 } }, 'a1', container);
    q<HTMLButtonElement>(container, '.ds-flow-summary').click();
    const item = itemOf(container);

    const row = q<HTMLButtonElement>(item, '.ds-flow-row');
    row.focus();
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    row.click();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(row.getAttribute('aria-controls')!);
    expect(body).not.toBeNull();
    expect(body?.hasAttribute('hidden')).toBe(false);
  });

  it('根摘要按钮可键盘操作', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 't', params: {} }, 'a2', container);
    const summary = q<HTMLButtonElement>(container, '.ds-flow-summary');
    const list = q<HTMLElement>(container, '.ds-flow-list');

    summary.focus();
    expect(document.activeElement).toBe(summary);
    expect(summary.type).toBe('button');

    summary.click();
    expect(list.hasAttribute('hidden')).toBe(false);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.ds-flow')?.getAttribute('data-open')).toBe('true');

    summary.click();
    expect(list.hasAttribute('hidden')).toBe(true);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
  });

  it('样式：无渐变、左侧发丝线时间线、深色与 reduced-motion 降级', () => {
    const container = makeContainer();
    createRedesignedToolCard({ toolName: 'style', params: {} }, 'st', container);
    const css = document.querySelector('style[data-ds-flow-style]')?.textContent ?? '';

    // 无装饰性渐变（mask-image 里的 linear-gradient 用于 clamp 淡出不是装饰）
    expect(css).not.toMatch(/background[-\w]*:\s*[^;]*gradient/i);
    expect(css).toContain('border-left: 1px solid var(--dsf-rule)');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@keyframes ds-flow-pulse');

    const reduced = /@media \(prefers-reduced-motion: reduce\)/.test(css);
    expect(reduced).toBe(true);
    expect(css).toContain('animation: none !important');
    expect(css).toContain('transition: none !important');
  });
});

describe('异常与边界路径', () => {
  it('container 非法 → 抛 TypeError', () => {
    const data: ToolCardData = { toolName: 't', params: {} };
    expect(() => createRedesignedToolCard(data, 'e1', null as unknown as HTMLElement)).toThrow(TypeError);
    expect(() =>
      updateRedesignedToolCardByCallId('e1', data, { ok: true }, undefined as unknown as HTMLElement),
    ).toThrow(TypeError);
  });

  it('结果文本：isError 加 [错误] 前缀 / 旧格式回退 / content 优先', () => {
    expect(formatToolResultText({ ok: false, error: 'boom', isError: true })).toBe('[错误] boom');
    expect(formatToolResultText({ ok: false, error: 'boom' })).toBe('boom');
    expect(formatToolResultText({ ok: true, data: 'plain' })).toBe('plain');
    expect(formatToolResultText({ ok: true, data: { stdout: 'out', stderr: 'err' } })).toBe('out\n\n[stderr]\nerr');
    expect(formatToolResultText({ ok: true, data: { stderr: 'err' } })).toContain('"stderr": "err"');
    expect(formatToolResultText({ ok: true, data: { code: 1 } })).toContain('"code": 1');
    expect(
      formatToolResultText({
        ok: true,
        data: 'ignored',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        ],
      }),
    ).toBe('a');
    expect(formatToolResultText({ ok: true })).toBe('');
  });

  it('循环引用 data 不抛异常，回退字符串', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => formatToolResultText({ ok: true, data: circular })).not.toThrow();
    expect(typeof formatToolResultText({ ok: true, data: circular })).toBe('string');
  });
});
