// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioControlsStore } from '../../src/ui/studio-controls-store';
import { createSettingsPanel } from '../../src/ui/studio-settings-panel';
import { globalEvents } from '../../src/ui/studio-ui-core';

let panel: ReturnType<typeof createSettingsPanel> | null = null;

afterEach(() => {
  panel?.destroy();
  panel = null;
  globalEvents.clear();
  document.body.innerHTML = '';
});

describe('Studio settings panel + shared controls', () => {
  it('open(tab) 深链定位左侧导航，并把共享 store 同步到表单', async () => {
    let policyMode: 'workspace' | 'auto' | 'full' = 'auto';
    const controls = createStudioControlsStore({
      call: vi.fn(async (name: string, params: Record<string, unknown>) => {
        if (name === 'settings.get') {
          return { ok: true, data: { workspaceRoot: 'E:/NAS/demo', policyMode } };
        }
        if (name === 'policy.set') {
          policyMode = params.mode as typeof policyMode;
          return { ok: true, data: { mode: policyMode } };
        }
        return { ok: false, error: 'no-host-bridge' };
      }),
    });
    panel = createSettingsPanel({ controls });
    document.body.appendChild(panel.container);

    panel.open('skills');
    expect(document.querySelector('[data-tab-id="skills"]')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-tab-panel="skills"]')?.classList.contains('active')).toBe(true);

    await controls.refresh();
    const workspaceInput = document.querySelector('.studio-workspace-input') as HTMLInputElement;
    expect(workspaceInput.value).toBe('E:/NAS/demo');

    await controls.setPolicy('workspace');
    expect(document.querySelector('[data-mode="workspace"]')?.classList.contains('selected')).toBe(true);
  });

  it('点击遮罩不关闭设置 Modal', () => {
    const controls = createStudioControlsStore({
      call: vi.fn(async () => ({ ok: false, error: 'no-host-bridge' })),
    });
    panel = createSettingsPanel({ controls });
    document.body.appendChild(panel.container);
    panel.open('general');

    const overlay = panel.container.querySelector('.studio-modal-overlay') as HTMLElement;
    overlay.click();
    expect(overlay.style.display).toBe('flex');
    controls.destroy();
  });
});
