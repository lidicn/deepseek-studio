// @vitest-environment jsdom
/**
 * 记忆面板取数回归（M10-5 后续）。
 *
 * 背景：面板此前只读 `globalState.memories`，而这个数组**从来没有人写过**——
 * 广播只落在 `globalThis.__studioMemories`（调试全局）。结果是库里有 25 条记忆，
 * 面板永远显示「暂无保存的记忆」。本文件锁死三条：
 *   ① 打开面板就从宿主拉一次（memory.list）；
 *   ② 宿主广播到达后重渲染；
 *   ③ 「已归档」页签走 memory.listArchived，并给出恢复/彻底删除两个出口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSettingsPanel } from '../../src/ui/studio-settings-panel';
import { globalEvents, globalState, setHostBridge } from '../../src/ui/studio-ui-core';

type Row = { id: string; type: string; name: string; content: string };

let panel: ReturnType<typeof createSettingsPanel> | null = null;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function stubBridge(active: Row[], archived: Row[]) {
  return {
    sendToolCall: vi.fn(async (req: { invocationName: string }) => {
      if (req.invocationName === 'memory.list') return { ok: true, data: { memories: active } };
      if (req.invocationName === 'memory.listArchived') return { ok: true, data: { memories: archived } };
      return { ok: false, error: 'unsupported-in-test' };
    }),
    log: () => undefined,
  };
}

function memoryPanelText(): string {
  return document.querySelector('[data-tab-panel="memory"]')?.textContent ?? '';
}

afterEach(() => {
  panel?.destroy();
  panel = null;
  globalEvents.clear();
  globalState.memories = [];
  document.body.innerHTML = '';
});

describe('记忆面板取数', () => {
  it('打开面板即拉取生效记忆并渲染（不再恒为空）', async () => {
    setHostBridge(stubBridge(
      [
        { id: 'mem-1', type: 'user', name: '用户身份', content: 'lidicn' },
        { id: 'mem-2', type: 'project', name: '项目决策', content: '走 API 路径' },
      ],
      [],
    ));
    panel = createSettingsPanel();
    document.body.appendChild(panel.container);

    panel.open('memory');
    await flush();
    await flush();

    const text = memoryPanelText();
    expect(text).toContain('用户身份');
    expect(text).toContain('项目决策');
    expect(text).not.toContain('暂无保存的记忆');
    expect(globalState.memories.map((m) => m.id)).toEqual(['mem-1', 'mem-2']);
  });

  it('宿主广播到达后重渲染（ui:memories-updated）', async () => {
    setHostBridge(stubBridge([], []));
    panel = createSettingsPanel();
    document.body.appendChild(panel.container);

    panel.open('memory');
    await flush();
    await flush();
    expect(memoryPanelText()).toContain('暂无保存的记忆');

    globalState.memories = [{ id: 'mem-9', type: 'user', name: '刚保存的记忆', content: 'x' }];
    globalEvents.emit('ui:memories-updated');
    expect(memoryPanelText()).toContain('刚保存的记忆');
  });

  it('「已归档」页签走 memory.listArchived，并提供恢复与彻底删除', async () => {
    const bridge = stubBridge([], [{ id: 'mem-a', type: 'user', name: '归档的记忆', content: 'y' }]);
    setHostBridge(bridge);
    panel = createSettingsPanel();
    document.body.appendChild(panel.container);

    panel.open('memory');
    await flush();

    const archivedBtn = Array.from(document.querySelectorAll('.studio-memory-toolbar button'))
      .find((b) => (b.textContent ?? '').includes('已归档')) as HTMLButtonElement;
    expect(archivedBtn).toBeTruthy();
    archivedBtn.click();
    await flush();
    await flush();

    const text = memoryPanelText();
    expect(text).toContain('归档的记忆');
    expect(text).toContain('恢复');
    expect(text).toContain('彻底删除');
    expect(bridge.sendToolCall.mock.calls.some(([r]) => r.invocationName === 'memory.listArchived')).toBe(true);
  });
});
