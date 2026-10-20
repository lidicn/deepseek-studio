// @vitest-environment jsdom
/**
 * F4：Studio 设置入口。
 *
 * 覆盖三处实测踩过的坑：
 * 1. 账号菜单只在点击后渲染 → 点击驱动注入。
 * 2. 菜单项文本被嵌套（icon + span）→ 选中外层菜单项，不插到内层 span 后。
 * 3. 弹窗标题也叫「系统设置」→ 只认账号菜单（同组含 退出登录/帮助与反馈）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installStudioSettingsEntry,
  findSystemSettingsAnchor,
  injectSettingsMenuItem,
} from '../../src/ui/studio-settings-entry';
import { globalEvents } from '../../src/ui/studio-ui-core';

const host = {
  sendToolCall: async () => ({ ok: true }),
  log: () => {},
};

/** 账号菜单骨架：含锚点「系统设置」+ 同组的退出登录，匹配真实结构。 */
function buildAccountMenu(): void {
  document.body.innerHTML = `
    <div id="menu">
      <div class="mi"><svg></svg><span>下载手机应用</span></div>
      <div class="mi" id="anchor"><svg></svg><span>系统设置</span></div>
      <div class="mi"><svg></svg><span>帮助与反馈</span></div>
      <div class="mi"><svg></svg><span>退出登录</span></div>
    </div>`;
}

/** 只有标题的官方设置弹窗（不应被误插）。 */
function buildSettingsModal(): void {
  document.body.innerHTML = `
    <div id="modal">
      <div class="title">系统设置</div>
      <div class="tabs"><span>通用设置</span><span>账号管理</span></div>
    </div>`;
}

let handle: { destroy(): void } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  globalEvents.clear();
  vi.useRealTimers();
});

describe('F4: Studio 设置入口', () => {
  it('账号菜单里找不到锚点时返回 null（不误插弹窗标题）', () => {
    buildSettingsModal();
    expect(findSystemSettingsAnchor()).toBeNull();
    expect(injectSettingsMenuItem()).toBe(false);
  });

  it('找到账号菜单锚点，并把入口插在外层菜单项之后（不是内层 span）', () => {
    buildAccountMenu();
    expect(injectSettingsMenuItem()).toBe(true);
    const injected = document.querySelector('[data-studio-settings-entry="1"]') as HTMLElement;
    expect(injected).toBeTruthy();
    expect(injected.textContent).toBe('Studio 设置');
    // 必须紧跟外层 #anchor，而不是内层 span
    expect(injected.previousElementSibling?.id).toBe('anchor');
    expect(injected.parentElement?.id).toBe('menu');
  });

  it('点击账号后（菜单异步出现）也能注入', () => {
    document.body.innerHTML = '<div id="app"></div>';
    handle = installStudioSettingsEntry(host);
    // 模拟用户点击账号 → 菜单随后渲染
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    buildAccountMenu();
    vi.advanceTimersByTime(400);
    expect(document.querySelector('[data-studio-settings-entry="1"]')).toBeTruthy();
  });

  it('点击入口会触发 ui:settings', () => {
    buildAccountMenu();
    handle = installStudioSettingsEntry(host);
    vi.advanceTimersByTime(1100);
    const injected = document.querySelector('[data-studio-settings-entry="1"]') as HTMLElement;
    expect(injected).toBeTruthy();
    let fired = 0;
    globalEvents.on('ui:settings', () => { fired += 1; });
    injected.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fired).toBe(1);
  });

  it('destroy 移除入口并解绑', () => {
    buildAccountMenu();
    handle = installStudioSettingsEntry(host);
    vi.advanceTimersByTime(1100);
    expect(document.querySelector('[data-studio-settings-entry="1"]')).toBeTruthy();
    handle.destroy();
    handle = null;
    expect(document.querySelector('[data-studio-settings-entry="1"]')).toBeNull();
  });

  it('幂等：重复调用不重复插入', () => {
    buildAccountMenu();
    expect(injectSettingsMenuItem()).toBe(true);
    expect(injectSettingsMenuItem()).toBe(true);
    expect(document.querySelectorAll('[data-studio-settings-entry="1"]').length).toBe(1);
  });
});