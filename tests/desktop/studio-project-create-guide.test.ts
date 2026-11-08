// @vitest-environment jsdom
/**
 * UI 双卡（项目创建文本路径＋首启引导）行为回归。
 *
 * 卡①：装版下 `folder.pick`（原生对话框）不可用，「创建新项目」旧行为是
 *   「关面板＋emit ui:new-project → 重开同一空面板」死循环 ⇒ 无输入入口。
 *   现改法：内联「粘贴路径＋名字（默认路径末段）→ project.create」表单，
 *   folder.pick 失败必须可见提示（不许静默）。
 * 卡②：工作区根未设时（装版必现），picker 与设置面板各给一次首启引导：
 *   一句话说清「工作区＝AI 能读写哪个目录」＋入口指向＋一次「跳过」（本会话）。
 *   不给工作区设任何默认值（安装目录子目录＝允许 AI 自改写，路线决定已否决）。
 *
 * 宿主工具面按 desktop-host.ts 现状桩（project.list 动态反映 created、
 * folder.pick 必败、workspace.set 回 root）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectPicker } from '../../src/ui/studio-project-picker';
import { createSettingsPanel } from '../../src/ui/studio-settings-panel';
import { globalEvents, globalState, setHostBridge } from '../../src/ui/studio-ui-core';

type Project = { id: string; name: string; path: string };

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeBridge(initial: Project[] = []) {
  const created: Project[] = [];
  const calls: Array<{ invocationName: string; params: Record<string, unknown> }> = [];
  const bridge = {
    sendToolCall: vi.fn(async (req: { invocationName: string; params?: Record<string, unknown> }) => {
      calls.push({ invocationName: req.invocationName, params: req.params ?? {} });
      switch (req.invocationName) {
        case 'project.list':
          return { ok: true, data: { projects: [...initial, ...created] } };
        case 'project.create': {
          const p = { name: String(req.params?.name ?? ''), path: String(req.params?.path ?? '') };
          if (!p.name || !p.path) return { ok: false, error: 'name and path are required' };
          const id = p.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
          created.push({ id, ...p });
          return { ok: true, data: { id, ...p } };
        }
        case 'folder.pick':
          // 桩模拟"取不到文件夹"失败面（#38 接线后宿主＝env 优先→回落原生选择器；取消/超时/无 GUI 均返失败）：
          // 本桩用自带短串（不抄宿主真串）：宿主错误串的行为锁在 tests/desktop/host-side-tools.test.ts；
          // 本桩只验「失败可见提示」路径，不验错误文案（宿主文案口径变化时本桩不跟变、不假同步）。
          return { ok: false, error: 'folder.pick unavailable' };
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
  return { bridge, calls, created };
}

function textBtn(root: ParentNode, text: string): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '').includes(text)) as HTMLButtonElement | null;
}

beforeEach(() => {
  globalState.workspaceRoot = null;
  globalState.workspaceGuideDismissed = false;
  globalState.currentProject = null;
});

afterEach(() => {
  globalEvents.clear();
  globalState.workspaceRoot = null;
  globalState.workspaceGuideDismissed = false;
  globalState.currentProject = null;
  document.body.innerHTML = '';
});

describe('项目选择器：粘贴路径创建（卡①）', () => {
  it('粘贴路径 → 创建 → 项目出现在列表（project.create 落盘 + 列表刷新）', async () => {
    const { bridge, calls } = makeBridge();
    setHostBridge(bridge);
    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();

    textBtn(picker.container, '创建新项目（粘贴路径')!.click();
    const path = picker.container.querySelector<HTMLInputElement>('[data-studio-path-input]')!;
    const name = picker.container.querySelector<HTMLInputElement>('[data-studio-name-input]')!;
    path.value = 'E:\\dev\\alpha';
    path.dispatchEvent(new Event('input'));
    expect(name.value).toBe('alpha'); // 名字默认取路径末段
    picker.container.querySelector<HTMLButtonElement>('[data-studio-create-btn]')!.click();
    await flush();
    await flush();

    const createCall = calls.find((c) => c.invocationName === 'project.create');
    expect(createCall?.params).toEqual({ name: 'alpha', path: 'E:\\dev\\alpha' });
    expect(picker.container.querySelector('.studio-picker-list')!.textContent).toContain('alpha'); // 列表已渲染新项目
  });

  it('手动填过名字后不再被路径末段覆盖', async () => {
    const { bridge, calls } = makeBridge();
    setHostBridge(bridge);
    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();

    textBtn(picker.container, '创建新项目（粘贴路径')!.click();
    const path = picker.container.querySelector<HTMLInputElement>('[data-studio-path-input]')!;
    const name = picker.container.querySelector<HTMLInputElement>('[data-studio-name-input]')!;
    name.value = 'beta';
    name.dispatchEvent(new Event('input'));
    path.value = 'E:\\dev\\alpha';
    path.dispatchEvent(new Event('input'));
    expect(name.value).toBe('beta');
    picker.container.querySelector<HTMLButtonElement>('[data-studio-create-btn]')!.click();
    await flush();
    await flush();

    expect(calls.find((c) => c.invocationName === 'project.create')?.params).toEqual({ name: 'beta', path: 'E:\\dev\\alpha' });
  });

  it('空路径点创建 ⇒ 可见提示、不发调用', async () => {
    const { bridge, calls } = makeBridge();
    setHostBridge(bridge);
    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();

    textBtn(picker.container, '创建新项目（粘贴路径')!.click();
    picker.container.querySelector<HTMLButtonElement>('[data-studio-create-btn]')!.click();
    await flush();

    const hint = picker.container.querySelector<HTMLElement>('.studio-picker-hint')!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('请先粘贴项目目录路径');
    expect(calls.some((c) => c.invocationName === 'project.create')).toBe(false);
  });

  it('folder.pick 失败 ⇒ 可见提示（不再静默），指向粘贴路径入口（判据③）', async () => {
    const { bridge, calls } = makeBridge();
    setHostBridge(bridge);
    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();

    textBtn(picker.container, '通过本地文件夹创建项目')!.click();
    await flush();
    await flush();

    expect(calls.some((c) => c.invocationName === 'folder.pick')).toBe(true);
    const hint = picker.container.querySelector<HTMLElement>('.studio-picker-hint')!;
    expect(hint.hidden).toBe(false);
    // R′（#39）：文案改如实（#38 接线后失败原因＝取消/超时/无 GUI，非"装版不支持"）；
    // 旧断言「装版暂不支持系统文件夹对话框」随文案改，按纪律④补负断言堵假话回流
    expect(hint.textContent).toContain('未能取到文件夹');
    expect(hint.textContent).not.toContain('暂不支持');
    expect(hint.textContent).toContain('粘贴');
    expect(hint.textContent).toContain('创建新项目（粘贴路径）');
  });
});

describe('项目选择器：列表点选生效（卡①判据②，既有链路证明仍通）', () => {
  it('点项目 ⇒ workspace.set 生效 ⇒ globalState.workspaceRoot 更新 + 事件发出', async () => {
    const { bridge, calls } = makeBridge([{ id: 'alpha', name: 'Alpha', path: 'C:\\dev\\alpha' }]);
    setHostBridge(bridge);
    let switched: unknown = null;
    let changed: unknown = null;
    const off1 = globalEvents.on('ui:project-switched', (p) => { switched = p; });
    const off2 = globalEvents.on('ui:workspace-changed', (r) => { changed = r; });

    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();

    picker.container.querySelector<HTMLElement>('.studio-picker-item')!.click();
    await flush();
    await flush();

    const setCall = calls.find((c) => c.invocationName === 'workspace.set');
    expect(setCall?.params).toEqual({ root: 'C:\\dev\\alpha' });
    expect(globalState.workspaceRoot).toBe('C:\\dev\\alpha');
    expect(switched).toEqual({ id: 'alpha', name: 'Alpha', path: 'C:\\dev\\alpha' });
    expect(changed).toBe('C:\\dev\\alpha');
    off1();
    off2();
  });
});

describe('首启引导：工作区未设（卡②）', () => {
  it('picker：root 未设 ⇒ 引导可见（一句话说清概念）；点「跳过」本会话不再显示', async () => {
    const { bridge } = makeBridge();
    setHostBridge(bridge);
    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();

    const guide = picker.container.querySelector<HTMLElement>('[data-studio-workspace-guide]')!;
    expect(guide.hidden).toBe(false);
    expect(guide.textContent).toContain('AI 能读写哪个目录');

    guide.querySelector<HTMLElement>('[data-studio-guide-skip]')!.click();
    expect(guide.hidden).toBe(true);
    expect(globalState.workspaceGuideDismissed).toBe(true);

    picker.close();
    picker.open();
    await flush();
    expect(picker.container.querySelector<HTMLElement>('[data-studio-workspace-guide]')!.hidden).toBe(true); // 本会话不再显示
  });

  it('picker：root 已设 ⇒ 引导不显示；点选成功 ⇒ 跳过态复位', async () => {
    const { bridge } = makeBridge([{ id: 'alpha', name: 'Alpha', path: 'C:\\dev\\alpha' }]);
    setHostBridge(bridge);
    globalState.workspaceRoot = 'C:\\dev\\alpha';

    const picker = createProjectPicker();
    document.body.appendChild(picker.container);
    picker.open();
    await flush();
    expect(picker.container.querySelector<HTMLElement>('[data-studio-workspace-guide]')!.hidden).toBe(true);

    globalState.workspaceRoot = null;
    globalState.workspaceGuideDismissed = true; // 模拟用户跳过后又清空了工作区
    picker.container.querySelector<HTMLElement>('.studio-picker-item')!.click();
    await flush();
    await flush();
    expect(globalState.workspaceRoot).toBe('C:\\dev\\alpha');
    expect(globalState.workspaceGuideDismissed).toBe(false); // 设上工作区后跳过态复位
  });
});

describe('设置面板：工作区页签首启引导（卡②）', () => {
  it('root 未设 ⇒ 引导可见（概念＋入口指向）；点「跳过」本会话不再显示', async () => {
    const { bridge } = makeBridge();
    setHostBridge(bridge);
    const panel = createSettingsPanel();
    document.body.appendChild(panel.container);
    panel.open('workspace');
    await flush();

    const guide = panel.container.querySelector<HTMLElement>('[data-studio-workspace-guide]')!;
    expect(guide.hidden).toBe(false);
    expect(guide.textContent).toContain('AI 能读写哪个目录');
    expect(panel.container.textContent).toContain('选择项目'); // 入口指向既有「选择项目」按钮

    guide.querySelector<HTMLElement>('[data-studio-guide-skip]')!.click();
    expect(guide.hidden).toBe(true);
    expect(globalState.workspaceGuideDismissed).toBe(true);
    panel.destroy();
  });

  it('粘贴路径保存成功 ⇒ globalState.workspaceRoot 生效、引导消失、跳过态复位', async () => {
    const { bridge, calls } = makeBridge();
    setHostBridge(bridge);
    globalState.workspaceGuideDismissed = true;
    const panel = createSettingsPanel();
    document.body.appendChild(panel.container);
    panel.open('workspace');
    await flush();
    await flush();

    const input = panel.container.querySelector<HTMLInputElement>('.studio-workspace-input')!;
    input.value = 'D:\\dev\\beta';
    textBtn(panel.container, '保存')!.click();
    await flush();
    await flush();

    const setCall = calls.find((c) => c.invocationName === 'workspace.set');
    expect(setCall?.params).toEqual({ root: 'D:\\dev\\beta' });
    expect(globalState.workspaceRoot).toBe('D:\\dev\\beta');
    expect(globalState.workspaceGuideDismissed).toBe(false);
    expect(panel.container.querySelector<HTMLElement>('[data-studio-workspace-guide]')!.hidden).toBe(true);
    panel.destroy();
  });
});
