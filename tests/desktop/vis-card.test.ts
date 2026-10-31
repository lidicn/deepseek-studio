// @vitest-environment jsdom
/**
 * 可视化卡片（A2UI 子集）注入层测试。
 *
 * 覆盖：XSS 转义、未知 type 降级、深度/节点上限、版本不匹配 ⇒ 保留原文、
 * 空清单、无围栏的裸 JSON 识别、端到端挂载与失败回退。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyVisCards, getVisCardDiagnostics } from '../../src/inject/vis-card';
import { escapeHtml } from '../../src/inject/vis/escape';
import { findVisDocuments, matchJsonEnd } from '../../src/inject/vis/text-detect';
import { renderToHtml } from '../../src/inject/vis/render';
import { resetVisRegistryForTests } from '../../src/inject/vis/registry';
import { registerCoreVisComponents } from '../../src/inject/vis/components';

function doc(text: string): string {
  return JSON.stringify({ v: 1, root: { type: 'Text', text } });
}

function scope(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('vis escape', () => {
  it('转义 & < > " \'', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });

  it('渲染结果不含未转义的尖括号', () => {
    const { html } = renderToHtml({ v: 1, root: { type: 'Text', text: '<b>hi</b>' } });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('vis render 降级', () => {
  beforeEach(() => {
    resetVisRegistryForTests();
    registerCoreVisComponents();
  });

  it('版本不匹配 ⇒ failed 且 html 为空', () => {
    const res = renderToHtml({ v: 99, root: { type: 'Text', text: 'x' } });
    expect(res.outcome.status).toBe('failed');
    expect(res.html).toBe('');
  });

  it('未知 type ⇒ 降级但仍出卡（可读标题）', () => {
    const res = renderToHtml({ v: 1, root: { type: 'Nope', title: '神秘卡片' } });
    expect(res.outcome.status).toBe('degraded');
    expect(res.html).toContain('神秘卡片');
  });

  it('超深嵌套 ⇒ 降级', () => {
    let node: any = { type: 'Text', text: 'leaf' };
    for (let i = 0; i < 12; i += 1) node = { type: 'Column', children: [node] };
    const res = renderToHtml({ v: 1, root: node });
    expect(res.outcome.reasons.join(',')).toContain('max_depth');
  });

  it('根节点缺失 ⇒ failed', () => {
    const res = renderToHtml({ v: 1 });
    expect(res.outcome.status).toBe('failed');
  });
});

describe('vis text-detect', () => {
  it('matchJsonEnd 正确配平（含字符串内括号）', () => {
    const text = '{"a":"}"}';
    expect(matchJsonEnd(text, 0)).toBe(text.length - 1);
  });

  it('识别无围栏的裸 JSON 段落', () => {
    const root = scope(`<p>前言</p><p>${doc('hello')}</p>`);
    const found = findVisDocuments(root, 3);
    expect(found.length).toBe(1);
    expect((found[0].doc as any).root.text).toBe('hello');
  });

  it('排除 pre/code 内的 JSON（围栏走单独通道）', () => {
    const root = scope(`<pre><code>${doc('x')}</code></pre>`);
    const found = findVisDocuments(root, 3, {
      exclude: (el) => el.closest('pre,code') !== null,
    });
    expect(found.length).toBe(0);
  });
});

describe('applyVisCards 端到端', () => {
  it('围栏 JSON ⇒ 替换为 Shadow DOM 卡片，原代码块消失', () => {
    const root = scope(`<pre><code>${doc('fenced')}</code></pre>`);
    const n = applyVisCards(root);
    expect(n).toBe(1);
    expect(root.querySelector('pre')).toBeNull();
    const host = root.querySelector('.ds-studio-vis-host') as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.shadowRoot?.textContent).toContain('fenced');
    expect(getVisCardDiagnostics().rendered).toBe(1);
  });

  it('裸 JSON 段落 ⇒ 替换为卡片', () => {
    const root = scope(`<p>${doc('bare')}</p>`);
    const n = applyVisCards(root);
    expect(n).toBe(1);
    expect(root.querySelector('p')).toBeNull();
    expect(root.querySelector('.ds-studio-vis-host')).toBeTruthy();
  });

  it('非法 JSON ⇒ 保留原始代码块，不出卡', () => {
    const root = scope(`<pre><code>{ not json </code></pre>`);
    const n = applyVisCards(root);
    expect(n).toBe(0);
    expect(root.querySelector('pre')?.textContent).toContain('not json');
  });

  it('版本不匹配 ⇒ 保留原始代码块', () => {
    const root = scope(`<pre><code>{"v":99,"root":{"type":"Text","text":"x"}}</code></pre>`);
    const n = applyVisCards(root);
    expect(n).toBe(0);
    expect(root.querySelector('pre')).toBeTruthy();
  });

  it('普通文本 ⇒ 不动 DOM', () => {
    const root = scope('<p>hello world</p>');
    const n = applyVisCards(root);
    expect(n).toBe(0);
    expect(root.querySelector('p')?.textContent).toBe('hello world');
  });

  it('旧式 ranking-list（无 v/root）⇒ 自动迁移为卡片', () => {
    const legacy = JSON.stringify({
      type: 'ranking-list',
      title: '2026 高分悬疑电影',
      items: [{ rank: 1, title: '痴迷', imdb: 8.2 }],
    });
    const root = scope(`<pre><code>${legacy}</code></pre>`);
    const n = applyVisCards(root);
    expect(n).toBe(1);
    expect(getVisCardDiagnostics().upgraded).toBe(1);
    expect(root.querySelector('pre')).toBeNull();
    const shadow = root.querySelector('.ds-studio-vis-host')?.shadowRoot;
    expect(shadow?.textContent).toContain('2026 高分悬疑电影');
    expect(shadow?.textContent).toContain('痴迷');
    expect(shadow?.textContent).toContain('IMDb 8.2');
    // 旧数据没有海报字段，但每条仍要生成 2:3 海报位，不能只剩文字。
    const placeholder = shadow?.querySelector('.ds-studio-vis-img--placeholder') as HTMLElement | null;
    expect(placeholder).toBeTruthy();
    expect(placeholder?.classList.contains('ds-studio-vis-ratio-2x3')).toBe(true);
  });

  it('旧式榜单带 http 海报 ⇒ 输出真实 img', () => {
    const legacy = JSON.stringify({
      type: 'ranking-list',
      title: '2026 悬疑剧',
      items: [{ rank: 1, name: '余炽之上', score: '9.2', poster: 'https://example.com/yuchizhishang.jpg' }],
    });
    const root = scope(`<pre><code>${legacy}</code></pre>`);
    expect(applyVisCards(root)).toBe(1);
    const shadow = root.querySelector('.ds-studio-vis-host')?.shadowRoot;
    const img = shadow?.querySelector('img.ds-studio-vis-img') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('https://example.com/yuchizhishang.jpg');
    // WebView 虚拟滚动下 lazy 会永不加载，海报必须 eager 拉取。
    expect(img?.getAttribute('loading')).toBe('eager');
  });

  it('旧式榜单的 javascript: 海报地址 ⇒ 降级占位', () => {
    const legacy = JSON.stringify({
      title: '危险榜单',
      items: [{ rank: 1, name: 'x', poster: 'javascript:alert(1)' }],
    });
    const root = scope(`<pre><code>${legacy}</code></pre>`);
    expect(applyVisCards(root)).toBe(1);
    const shadow = root.querySelector('.ds-studio-vis-host')?.shadowRoot;
    expect(shadow?.querySelector('img')).toBeNull();
    expect(shadow?.querySelector('.ds-studio-vis-img--placeholder')).toBeTruthy();
  });

  it('旧式结构但没有可迁移条目 ⇒ 保留原始代码块', () => {
    const legacy = JSON.stringify({ type: 'ranking-list', title: '空榜单', items: [] });
    const root = scope(`<pre><code>${legacy}</code></pre>`);
    expect(applyVisCards(root)).toBe(0);
    expect(root.querySelector('pre')?.textContent).toContain('空榜单');
  });

  it('合法榜单含海报位 ⇒ 出卡并保留 2:3 海报框', () => {
    const ranking = {
      v: 1,
      root: {
        type: 'Column',
        children: [
          { type: 'Text', text: '2026 悬疑片 Top 1', variant: 'title' },
          {
            type: 'Row',
            children: [
              { type: 'Image', src: null, alt: '痴迷 海报', ratio: '2/3', fallback: { hue: 18 } },
              { type: 'Column', children: [{ type: 'Text', text: '痴迷', variant: 'subtitle' }] },
            ],
          },
        ],
      },
    };
    const root = scope(`<pre><code>${JSON.stringify(ranking)}</code></pre>`);
    expect(applyVisCards(root)).toBe(1);
    const shadow = root.querySelector('.ds-studio-vis-host')?.shadowRoot;
    const placeholder = shadow?.querySelector('.ds-studio-vis-img--placeholder') as HTMLElement | null;
    expect(placeholder).toBeTruthy();
    expect(placeholder?.classList.contains('ds-studio-vis-ratio-2x3')).toBe(true);
    expect(placeholder?.style.getPropertyValue('--ds-studio-vis-hue')).toBe('18');
  });

  it('远程图加载失败 ⇒ 占位继承 hue 与比例', () => {
    const doc = {
      v: 1,
      root: {
        type: 'Row',
        children: [
          {
            type: 'Image',
            src: 'https://example.com/poster.jpg',
            alt: '示例海报',
            ratio: '2/3',
            fallback: { hue: 275 },
          },
        ],
      },
    };
    const root = scope(`<pre><code>${JSON.stringify(doc)}</code></pre>`);
    expect(applyVisCards(root)).toBe(1);
    const shadow = root.querySelector('.ds-studio-vis-host')?.shadowRoot;
    const img = shadow?.querySelector('img.ds-studio-vis-img') as HTMLImageElement | null;
    expect(img?.style.getPropertyValue('--ds-studio-vis-hue')).toBe('275');
    img?.dispatchEvent(new Event('error'));
    const placeholder = shadow?.querySelector('.ds-studio-vis-img--placeholder') as HTMLElement | null;
    expect(placeholder?.classList.contains('ds-studio-vis-ratio-2x3')).toBe(true);
    expect(placeholder?.style.getPropertyValue('--ds-studio-vis-hue')).toBe('275');
  });
});
