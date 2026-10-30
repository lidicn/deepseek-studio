// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initSkillPopup, setSkillPopupSkills, stopSkillPopup } from '../../src/inject/skill-popup';

const SKILLS = [
  { name: 'imagegen', description: '生成或编辑位图' },
  { name: 'skill-creator', description: '创建或更新 skill' },
  { name: 'openai-docs', description: 'OpenAI 文档查询' },
];

function mountComposer(): HTMLTextAreaElement {
  document.body.innerHTML = '<textarea id="chat-input"></textarea>';
  return document.querySelector('textarea#chat-input') as HTMLTextAreaElement;
}

function type(el: HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

function popup(): HTMLElement | null {
  return document.querySelector('.ds-studio-skill-popup');
}

describe('skill-popup（移植自 dpp 的对话框输入 / 技能提示）', () => {
  beforeEach(() => {
    // jsdom 未实现 scrollIntoView
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  });

  afterEach(() => {
    stopSkillPopup();
    document.body.innerHTML = '';
  });

  it('输入 / 弹出技能列表，首项高亮', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    type(ta, '/');

    const el = popup();
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe('block');
    const items = el!.querySelectorAll('.ds-studio-skill-item');
    expect(items).toHaveLength(3);
    expect(items[0].querySelector('.ds-studio-skill-trigger')?.textContent).toBe('/imagegen');
    expect(items[0].classList.contains('ds-studio-active')).toBe(true);
  });

  it('浮层层级高于 Studio chat overlay，否则会被不透明消息层遮住', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    type(ta, '/');

    const css = document.getElementById('ds-studio-skill-popup-css')?.textContent ?? '';
    const zIndex = /\.ds-studio-skill-popup\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1];
    expect(Number(zIndex)).toBeGreaterThan(2147483000);
  });

  it('窗口过矮时按输入框上沿压缩浮层高度，避免顶出视口', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    vi.spyOn(ta, 'getBoundingClientRect').mockReturnValue({
      top: 100, bottom: 160, left: 10, right: 610, width: 600, height: 60, x: 10, y: 100, toJSON: () => ({}),
    } as DOMRect);
    type(ta, '/');

    const el = popup()!;
    expect(parseInt(el.style.maxHeight, 10)).toBe(84);
    expect(parseInt(el.style.maxHeight, 10)).toBeLessThan(220);
  });

  it('document_start 时 body 尚未创建，DOMContentLoaded 后完成挂载', () => {
    document.body.remove();
    expect(document.body).toBeNull();

    initSkillPopup(SKILLS);
    expect(document.getElementById('ds-studio-skill-popup-css')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__studioSkillPopup).toBeTypeOf('function');

    const body = document.createElement('body');
    body.innerHTML = '<textarea id="chat-input"></textarea>';
    document.documentElement.appendChild(body);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(document.getElementById('ds-studio-skill-popup-css')).not.toBeNull();
    const ta = document.querySelector('textarea#chat-input') as HTMLTextAreaElement;
    type(ta, '/');
    expect(popup()!.style.display).toBe('block');
    expect(popup()!.querySelectorAll('.ds-studio-skill-item')).toHaveLength(3);
  });

  it('按前缀过滤', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    type(ta, '/open');
    const items = popup()!.querySelectorAll('.ds-studio-skill-item');
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.ds-studio-skill-trigger')?.textContent).toBe('/openai-docs');
  });

  it('ArrowDown / ArrowUp 切换高亮项', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    type(ta, '/');

    press(ta, 'ArrowDown');
    let items = popup()!.querySelectorAll('.ds-studio-skill-item');
    expect(items[1].classList.contains('ds-studio-active')).toBe(true);
    expect(items[0].classList.contains('ds-studio-active')).toBe(false);

    press(ta, 'ArrowUp');
    items = popup()!.querySelectorAll('.ds-studio-skill-item');
    expect(items[0].classList.contains('ds-studio-active')).toBe(true);
  });

  it('Enter 把选中技能写入输入框（原生 setter + 作废 React valueTracker）', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    const setValue = vi.fn();
    (ta as unknown as { _valueTracker?: unknown })._valueTracker = { setValue };

    type(ta, '/');
    press(ta, 'ArrowDown');
    const ev = press(ta, 'Enter');

    expect(ev.defaultPrevented).toBe(true);
    expect(setValue).toHaveBeenCalled();
    expect(ta.value).toBe('/skill-creator ');
    expect(popup()!.style.display).toBe('none');
  });

  it('Shift+Enter 放行（不吞事件、不写入）', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    type(ta, '/');
    const ev = press(ta, 'Enter', { shiftKey: true });

    expect(ev.defaultPrevented).toBe(false);
    expect(ta.value).toBe('/');
  });

  it('Escape 关闭浮层', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    type(ta, '/');
    expect(popup()!.style.display).toBe('block');
    press(ta, 'Escape');
    expect(popup()!.style.display).toBe('none');
  });

  it('技能清单为空时给空提示，而不是静默无反应', () => {
    const ta = mountComposer();
    initSkillPopup([]);
    type(ta, '/');
    const el = popup();
    expect(el!.style.display).toBe('block');
    expect(el!.querySelector('.ds-studio-skill-empty')).not.toBeNull();
    expect(el!.querySelector('.ds-studio-skill-item')).toBeNull();
  });

  it('setSkillPopupSkills 热更新清单后可用', () => {
    const ta = mountComposer();
    initSkillPopup([]);
    type(ta, '/');
    expect(popup()!.querySelector('.ds-studio-skill-empty')).not.toBeNull();

    setSkillPopupSkills(SKILLS);
    const items = popup()!.querySelectorAll('.ds-studio-skill-item');
    expect(items).toHaveLength(3);
  });

  it('输入含空格（已选完）后不再弹浮层', () => {
    const ta = mountComposer();
    initSkillPopup(SKILLS);
    type(ta, '/');
    expect(popup()!.style.display).toBe('block');
    type(ta, '/imagegen x');
    expect(popup()!.style.display).toBe('none');
  });
});
