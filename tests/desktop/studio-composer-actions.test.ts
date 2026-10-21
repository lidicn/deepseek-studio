// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findComposerActionAnchor,
  installComposerActions,
  type ComposerSettingsTab,
} from '../../src/ui/studio-composer-actions';
import { createStudioControlsStore } from '../../src/ui/studio-controls-store';
import { globalEvents } from '../../src/ui/studio-ui-core';

function installNativeComposer(): { deepThink: HTMLElement; smartSearch: HTMLElement } {
  document.body.innerHTML = `
    <div id="composer">
      <div id="deep" tabindex="0" class="ds-toggle-button"><span>深度思考</span></div>
      <div id="smart" tabindex="0" class="ds-toggle-button"><span>智能搜索</span></div>
      <button id="attach">附件</button>
      <button id="send">发送</button>
    </div>`;
  const deepThink = document.getElementById('deep') as HTMLElement;
  const smartSearch = document.getElementById('smart') as HTMLElement;
  Object.defineProperty(deepThink, 'getBoundingClientRect', {
    value: () => ({ left: 20, right: 100, top: 700, bottom: 732, width: 80, height: 32, x: 20, y: 700, toJSON() {} }),
  });
  Object.defineProperty(smartSearch, 'getBoundingClientRect', {
    value: () => ({ left: 108, right: 188, top: 700, bottom: 732, width: 80, height: 32, x: 108, y: 700, toJSON() {} }),
  });
  return { deepThink, smartSearch };
}

function makeStore() {
  let workspaceRoot: string | null = 'E:/NAS/deepseek-studio';
  let policyMode: 'workspace' | 'auto' | 'full' = 'auto';
  const call = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === 'settings.get') {
      return { ok: true, data: { workspaceRoot, policyMode } };
    }
    if (name === 'policy.set') {
      policyMode = params.mode as 'workspace' | 'auto' | 'full';
      return { ok: true, data: { mode: policyMode } };
    }
    if (name === 'workspace.set') {
      workspaceRoot = String(params.root);
      return { ok: true, data: { root: workspaceRoot } };
    }
    return { ok: false, error: 'unexpected' };
  });
  return createStudioControlsStore({ call });
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  globalEvents.clear();
  vi.stubGlobal('innerWidth', 1280);
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
  globalEvents.clear();
});

describe('Studio composer quick actions', () => {
  it('支持 DeepSeek 实际的 div.ds-toggle-button 锚点，不修改原生节点', () => {
    const native = installNativeComposer();
    const deepAttrs = native.deepThink.getAttributeNames().map((name) => [name, native.deepThink.getAttribute(name)]);
    const smartAttrs = native.smartSearch.getAttributeNames().map((name) => [name, native.smartSearch.getAttribute(name)]);
    const anchor = findComposerActionAnchor(document);

    expect(anchor?.deepThink).toBe(native.deepThink);
    expect(anchor?.smartSearch).toBe(native.smartSearch);
    expect(native.deepThink.getAttributeNames().map((name) => [name, native.deepThink.getAttribute(name)])).toEqual(deepAttrs);
    expect(native.smartSearch.getAttributeNames().map((name) => [name, native.smartSearch.getAttribute(name)])).toEqual(smartAttrs);
  });

  it('兼容旧版真实 button 锚点', () => {
    document.body.innerHTML = `
      <div id="composer">
        <button id="deep"><span>深度思考</span></button>
        <button id="smart"><span>智能搜索</span></button>
      </div>`;
    expect(findComposerActionAnchor(document)?.deepThink.id).toBe('deep');
    expect(findComposerActionAnchor(document)?.smartSearch.id).toBe('smart');
  });

  it('只保留一个快捷条实例，并在智能搜索右侧定位', () => {
    installNativeComposer();
    const store = makeStore();
    const first = installComposerActions({ store, openSettings: () => {} });
    const second = installComposerActions({ store, openSettings: () => {} });
    cleanup = () => {
      second.destroy();
      store.destroy();
    };
    second.reposition();

    expect(document.querySelectorAll('.studio-composer-actions').length).toBe(1);
    expect(second.container.classList.contains('is-visible')).toBe(true);
    expect(second.container.style.left).toBe('196px');
    expect(first.container.isConnected).toBe(false);
  });

  it('工作区、技能、设置入口走既定动作', () => {
    installNativeComposer();
    const store = makeStore();
    const opened: ComposerSettingsTab[] = [];
    let projectPicker = 0;
    globalEvents.on('ui:project-picker', () => { projectPicker += 1; });
    const handle = installComposerActions({
      store,
      openSettings: (tab) => opened.push(tab),
    });
    cleanup = () => {
      handle.destroy();
      store.destroy();
    };
    handle.reposition();

    (handle.container.querySelector('[data-action="workspace"]') as HTMLElement).click();
    (handle.container.querySelector('[data-action="skills"]') as HTMLElement).click();
    (handle.container.querySelector('[data-action="settings"]') as HTMLElement).click();

    expect(projectPicker).toBe(1);
    expect(opened).toEqual(['skills', 'general']);
  });

  it('审批菜单调用 store 并支持 Escape 关闭', async () => {
    installNativeComposer();
    const store = makeStore();
    const handle = installComposerActions({ store, openSettings: () => {} });
    cleanup = () => {
      handle.destroy();
      store.destroy();
    };
    handle.reposition();
    await Promise.resolve();

    const policyButton = handle.container.querySelector('[data-action="policy"]') as HTMLButtonElement;
    policyButton.click();
    expect(policyButton.getAttribute('aria-expanded')).toBe('true');
    const full = handle.container.querySelector('[data-policy="full"]') as HTMLButtonElement;
    full.click();

    await vi.waitFor(() => {
      expect(store.getSnapshot().policyMode).toBe('full');
      expect(policyButton.getAttribute('aria-expanded')).toBe('false');
    });

    policyButton.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(policyButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('没有原生锚点时隐藏且不遮挡页面', () => {
    document.body.innerHTML = '<div id="composer"></div>';
    const store = makeStore();
    const handle = installComposerActions({ store, openSettings: () => {} });
    cleanup = () => {
      handle.destroy();
      store.destroy();
    };
    handle.reposition();
    expect(handle.container.classList.contains('is-visible')).toBe(false);
  });

  it('Studio 主视图隐藏时快捷条同步隐藏，恢复后重新定位', () => {
    installNativeComposer();
    const store = makeStore();
    const handle = installComposerActions({ store, openSettings: () => {} });
    cleanup = () => {
      handle.destroy();
      store.destroy();
    };
    handle.reposition();
    expect(handle.container.classList.contains('is-visible')).toBe(true);

    window.dispatchEvent(new CustomEvent('studio:visibility-changed', { detail: { visible: false } }));
    expect(handle.container.classList.contains('is-visible')).toBe(false);
    window.dispatchEvent(new CustomEvent('studio:visibility-changed', { detail: { visible: true } }));
    expect(handle.container.classList.contains('is-visible')).toBe(true);
  });
});
