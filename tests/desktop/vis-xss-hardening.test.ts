// @vitest-environment jsdom
/**
 * 可视化卡片 XSS 加固专项（QA-1 / G-INFO-1 配套）。
 *
 * 背景：移植 B 的 vis 模块以 innerHTML 落卡片。文本出口已由 escapeHtml 转义，
 * 但「模型内容 → HTML 字符串 → innerHTML」这条链一旦漏转义即为 XSS。
 * 本次在两个赋值点（vis-card.createHost / vis/render.renderToFragment）加 DOMPurify 兜底，
 * 本文件把「兜底确实生效」钉成断言：
 *  1. 属性位注入（alt/src）⇒ 落 DOM 后不得出现可执行属性或额外元素；
 *  2. 文本位注入 ⇒ 渲染为纯文本，不得生成真实元素节点；
 *  3. 直接对 DOMPurify.sanitize 做反证：事件属性与 script 必被剥除。
 */
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
import { applyVisCards } from '../../src/inject/vis-card';

/**
 * 用 textContent 装配代码块内容。
 * 不能用 innerHTML 拼：payload 里的 <script>/<img> 会被外层 HTML 解析器提前吃掉，
 * 那样断言的是"被吃掉的 payload"，而不是渲染出口的转义行为（假绿）。
 */
function scope(docText: string): HTMLElement {
  const root = document.createElement('div');
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = docText;
  pre.appendChild(code);
  root.appendChild(pre);
  document.body.appendChild(root);
  return root;
}

function hostOf(root: HTMLElement): ShadowRoot {
  const host = root.querySelector('.ds-studio-vis-host') as HTMLElement;
  expect(host).toBeTruthy();
  return host.shadowRoot as ShadowRoot;
}

describe('vis XSS 加固', () => {
  it('属性位注入 ⇒ 不产生事件属性，也不产生额外元素', () => {
    const payload = '"><img src=x onerror="alert(1)">';
    const doc = JSON.stringify({
      v: 1,
      root: { type: 'Image', src: 'https://example.com/a.png', alt: payload },
    });
    const root = scope(doc);
    expect(applyVisCards(root)).toBe(1);

    const shadow = hostOf(root);
    const imgs = Array.from(shadow.querySelectorAll('img'));
    expect(imgs.length).toBe(1); // 只应有卡片自己的那张图，注入的 <img> 不成立
    for (const img of imgs) {
      expect(img.getAttribute('onerror')).toBeNull();
      expect(img.getAttribute('src')).toBe('https://example.com/a.png');
    }
    // 注入串只会以「已转义的属性值」形式出现（alt="">...onerror=..."），
    // 断言的是 DOM 上不存在可执行属性，而不是 innerHTML 里不含该子串。
    expect(shadow.querySelectorAll('[onerror]').length).toBe(0);
    expect(shadow.querySelectorAll('img').length).toBe(1);
  });

  it('文本位注入 ⇒ 渲染为纯文本，不生成真实元素节点', () => {
    const doc = JSON.stringify({
      v: 1,
      root: { type: 'Text', text: '<script>alert(1)</script><img src=x onerror=alert(2)>' },
    });
    const root = scope(doc);
    expect(applyVisCards(root)).toBe(1);

    const shadow = hostOf(root);
    expect(shadow.querySelector('script')).toBeNull();
    expect(shadow.querySelector('img')).toBeNull();
    expect(shadow.textContent).toContain('<script>alert(1)</script>');
  });

  it('DOMPurify 反证：事件属性与 script 被剥除', () => {
    const dirty = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
    const clean = DOMPurify.sanitize(dirty);
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('javascript:');
  });
});
