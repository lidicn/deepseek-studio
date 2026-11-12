// @vitest-environment jsdom
/**
 * #38 卡 A：卡 Q 只读扫描（2026-11-08）落定的死事件/静默失败整改回归。
 * 判据＝行为级：① 四个死事件（ui:local-tools-toggled／ui:policy-changed／ui:project-created／
 * ui:open-file）全仓无监听方，已删 emit（防回流）；② ui:open-file 默认取值＝点击复制绝对
 * 路径＋可见提示；③ 右栏文件行点击不再零反应；④ skills「打开目录」失败必须可见（879e7ac 范式）。
 * 活链不受伤：ui:projects-updated（picker loadProjects 发射、sidebar 唯一订阅）仍发射。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInputBar } from '../../src/ui/studio-input-bar';
import { createProjectPicker } from '../../src/ui/studio-project-picker';
import { createRightSidebar } from '../../src/ui/studio-right-sidebar';
import { createSkillsPanel } from '../../src/ui/studio-skills-panel';
import { globalEvents, globalState, setHostBridge } from '../../src/ui/studio-ui-core';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeBridge(overrides: Record<string, () => { ok: boolean; data?: unknown; error?: string }> = {}) {
  const created: Array<{ id: string; name: string; path: string }> = [];
  const calls: Array<{ invocationName: string; params: Record<string, unknown> }> = [];
  const bridge = {
    sendToolCall: vi.fn(async (req: { invocationName: string; params?: Record<string, unknown> }) => {
      calls.push({ invocationName: req.invocationName, params: req.params ?? {} });
      if (overrides[req.invocationName]) return overrides[req.invocationName]();
      switch (req.invocationName) {
        case 'project.list':
          // 动态反映 created（与 879e7ac 桩同形）：创建后 loadProjects 重读，列表随真实数据刷新
          return { ok: true, data: { projects: [...created] } };
        case 'project.create': {
          const name = String(req.params?.name ?? '');
          const path = String(req.params?.path ?? '');
          if (!name || !path) return { ok: false, error: 'name and path are required' };
          const id = name.toLowerCase();
          created.push({ id, name, path });
          return { ok: true, data: { id, name, path } };
        }
        case 'workspace.set':
          return { ok: true, data: { root: String(req.params?.root ?? '') } };
        case 'settings.get':
          return {
            ok: true,
            data: { workspaceRoot: null, policyMode: 'auto', mcpServers: [], skills: [], configDir: null, logDir: null, logDirSource: 'fallback', dataDir: null },
          };
        default:
          return { ok: false, error: 'unsupported-in-test' };
      }
    }),
    log: () => undefined,
  };
  return { bridge, calls };
}

beforeEach(() => {
  globalState.workspaceRoot = null;
  globalState.currentProject = null;
});

afterEach(() => {
  globalEvents.clear();
  globalState.workspaceRoot = null;
  globalState.currentProject = null;
  document.body.innerHTML = '';
});

describe('死事件移除回归（卡 A④：两个 input-bar 死 emit 已删，防回流）', () => {
  it('点「本地电脑」开关：globalState 切换生效，ui:local-tools-toggled 不再发射', async () => {
    const { container } = createInputBar();
    document.body.appendChild(container);
    let toggled = 0;
    const off = globalEvents.on('ui:local-tools-toggled', () => { toggled++; });
    const prev = globalState.localToolsEnabled;
    const toggle = container.querySelector<HTMLElement>('.studio-bar-item.active')!;
    toggle.click();
    await flush();
    expect(globalState.localToolsEnabled).toBe(!prev); // 真实效果仍由 globalState 承载
    expect(toggled).toBe(0); // 死事件不再发射（回流必红）
    off();
  });

  it('点档位选项：globalState.policyMode 更新，ui:policy-changed 不再发射', async () => {
    const { container } = createInputBar();
    document.body.appendChild(container);
    let changed = 0;
    const off = globalEvents.on('ui:policy-changed', () => { changed++; });
    const option = container.querySelectorAll('.studio-mode-option')[1] as HTMLElement;
    option.click();
    await flush();
    expect(globalState.policyMode).not.toBeUndefined();
    expect(changed).toBe(0); // 死事件不再发射
    off();
  });
});

describe('ui:open-file 死事件改「复制绝对路径＋可见提示」（卡 A③）', () => {
  it('复制成功路径（stub 剪贴板）：不发射 ui:open-file、提示可见且含该绝对路径', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { bridge } = makeBridge();
    setHostBridge(bridge);
    const sidebar = createRightSidebar();
    document.body.appendChild(sidebar.container);
    sidebar.show();
    sidebar.addArtifact({ name: 'a.txt', type: 'file', path: 'C:\\dev\\a.txt', modified: 'now' });
    await flush();

    let emitted = 0;
    const off = globalEvents.on('ui:open-file', () => { emitted++; });
    const row = sidebar.container.querySelector('.studio-right-item') as HTMLElement;
    expect(row).not.toBeNull();
    row.click();
    await flush();

    expect(emitted).toBe(0); // 死事件不再发射（回流必红）
    expect(writeText).toHaveBeenCalledWith('C:\\dev\\a.txt'); // 复制的正是该绝对路径
    const hint = sidebar.container.querySelector('.studio-right-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('路径已复制');
    expect(hint.textContent).toContain('C:\\dev\\a.txt');
    off();
    // 清掉本用例的剪贴板 stub，防泄漏到失败路径用例
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('复制失败路径（剪贴板不可用）：提示显「复制失败」而非静默（879e7ac 范式）', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const { bridge } = makeBridge();
    setHostBridge(bridge);
    const sidebar = createRightSidebar();
    document.body.appendChild(sidebar.container);
    sidebar.show();
    sidebar.addArtifact({ name: 'b.txt', type: 'file', path: 'C:\\dev\\b.txt', modified: 'now' });
    await flush();

    const row = sidebar.container.querySelector('.studio-right-item') as HTMLElement;
    row.click();
    await flush();

    // jsdom 无 navigator.clipboard 且 document.execCommand 不可用 ⇒ copyPathToClipboard 返回 false
    const hint = sidebar.container.querySelector('.studio-right-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('复制失败');
  });
});

describe('ui:project-created 死事件删除（卡 A②：侧栏刷新走 ui:projects-updated 活链）', () => {
  it('粘贴创建成功：ui:project-created 不发射、ui:projects-updated 仍发射、列表刷新', async () => {
    const { bridge } = makeBridge();
    setHostBridge(bridge);
    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();

    let created = 0;
    let updated = 0;
    const off1 = globalEvents.on('ui:project-created', () => { created++; });
    const off2 = globalEvents.on('ui:projects-updated', () => { updated++; });

    const btn = picker.container.querySelectorAll('.studio-picker-action-btn')[0] as HTMLElement;
    btn.click(); // 展开粘贴创建表单
    const path = picker.container.querySelector<HTMLInputElement>('[data-studio-path-input]')!;
    path.value = 'E:\\dev\\sweep';
    path.dispatchEvent(new Event('input'));
    picker.container.querySelector<HTMLButtonElement>('[data-studio-create-btn]')!.click();
    await flush();
    await flush();

    expect(created).toBe(0); // 死事件不再发射（回流必红）
    expect(updated).toBeGreaterThan(0); // 活链不受伤
    expect(picker.container.querySelector('.studio-picker-list')!.textContent).toContain('sweep');
    off1();
    off2();
  });
});

describe('skills「打开目录」失败可见（卡 A①：879e7ac 范式，静默失败消除）', () => {
  it('shell.exec 失败 ⇒ 可见失败提示（不再静默）', async () => {
    const { bridge } = makeBridge({
      'skill.list': () => ({ ok: true, data: { dir: 'C:\\skills', skills: [] } }),
      'shell.exec': () => ({ ok: false, error: 'denied-by-consent' }),
    });
    setHostBridge(bridge);
    const panel = createSkillsPanel();
    document.body.appendChild(panel.container);
    panel.open();
    await flush();
    await flush();

    const btn = Array.from(panel.container.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('打开目录'))!;
    btn.click();
    await flush();

    const hint = panel.container.querySelector('.studio-form-hint') as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('打开目录失败');
    panel.close();
  });
});

/**
 * U1-03（TD 续审第 1 轮，P3）：`studio-ui-core.ts` 的 `el()` 死原语 `props.html`
 * （全仓零调用方）已删——innerHTML 任意写口收敛到 renderMarkdown/DOMPurify 产出各点。
 * 回流锁（源扫）：类型成员与分支再现必红；安全 text 通道保留（防过删）。
 */
describe('U1-03 el() 死分支 props.html 删除（防回流）', () => {
  it('studio-ui-core.ts 不再有 props.html 分支与类型成员；text 通道保留', () => {
    const src = readFileSync('src/ui/studio-ui-core.ts', 'utf8');
    expect(src).not.toMatch(/props\?\.html/);
    expect(src).not.toMatch(/html\?:\s*string/);
    expect(src).toMatch(/element\.textContent = props\.text/);
  });
});
