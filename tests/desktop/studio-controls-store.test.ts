import { describe, expect, it, vi } from 'vitest';
import { createStudioControlsStore } from '../../src/ui/studio-controls-store';

describe('StudioControlsStore', () => {
  it('refresh 从 settings.get 读取宿主真值并通知订阅者', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'settings.get') {
        return { ok: true, data: { workspaceRoot: 'E:/NAS/demo', policyMode: 'workspace' } };
      }
      return { ok: false, error: 'unexpected' };
    });
    const store = createStudioControlsStore({ call });
    const seen: string[] = [];
    const off = store.subscribe((snapshot) => seen.push(`${snapshot.loading}:${snapshot.policyMode}`));

    await store.refresh();

    expect(call).toHaveBeenCalledWith('settings.get', {});
    expect(store.getSnapshot()).toMatchObject({
      workspaceRoot: 'E:/NAS/demo',
      policyMode: 'workspace',
      loading: false,
      error: null,
    });
    expect(seen.at(-1)).toBe('false:workspace');
    off();
    store.destroy();
  });

  it('setPolicy 成功时以宿主返回值更新，失败时不乐观改值', async () => {
    let mode: 'auto' | 'full' = 'auto';
    const call = vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === 'settings.get') {
        return { ok: true, data: { workspaceRoot: null, policyMode: mode } };
      }
      if (name === 'policy.set') {
        if (params.mode === 'full') return { ok: false, error: 'denied-by-test' };
        mode = params.mode as 'auto' | 'full';
        return { ok: true, data: { mode } };
      }
      return { ok: false, error: 'unexpected' };
    });
    const store = createStudioControlsStore({ call });

    expect(await store.setPolicy('full')).toBe(false);
    expect(store.getSnapshot().policyMode).toBe('auto');
    expect(store.getSnapshot().error).toBe('denied-by-test');

    expect(await store.setPolicy('auto')).toBe(true);
    expect(store.getSnapshot().policyMode).toBe('auto');
    expect(store.getSnapshot().error).toBeNull();
    store.destroy();
  });

  it('setWorkspace 持久化后 refresh，并以返回路径为准', async () => {
    let workspaceRoot = 'E:/NAS/old';
    const call = vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === 'workspace.set') {
        workspaceRoot = String(params.root);
        return { ok: true, data: { root: workspaceRoot } };
      }
      if (name === 'settings.get') {
        return { ok: true, data: { workspaceRoot, policyMode: 'auto' } };
      }
      return { ok: false, error: 'unexpected' };
    });
    const store = createStudioControlsStore({ call });

    expect(await store.setWorkspace('E:/NAS/bin')).toBe(true);
    expect(store.getSnapshot().workspaceRoot).toBe('E:/NAS/bin');
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      'workspace.set',
      'settings.get',
    ]);
    store.destroy();
  });
});
