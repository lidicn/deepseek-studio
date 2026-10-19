// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHostLayoutAdapter } from '../../src/ui/host-layout-adapter';

function stubRect(el: HTMLElement, rect: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...rect }) as DOMRect;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('host-layout-adapter 三档快照/退订/降级 warn（W8/M12）', () => {
  it('L2：无 composer 时 reason=composer-not-found 且 warn 带 degradeReason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createHostLayoutAdapter();
    const snap = adapter.getSnapshot();
    expect(snap.level).toBe('L2');
    expect(snap.degradeReason).toBe('composer-not-found');
    expect(warn).toHaveBeenCalledWith('[host-layout] degraded', {
      level: 'L2',
      degradeReason: 'composer-not-found',
    });
    warn.mockRestore();
  });

  it('L1：有 composer 无 sidebar 时 reason=sidebar-not-found', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ta = document.createElement('textarea');
    stubRect(ta, { top: 500, width: 600, height: 80 });
    document.body.appendChild(ta);
    const adapter = createHostLayoutAdapter();
    const snap = adapter.getSnapshot();
    expect(snap.level).toBe('L1');
    expect(snap.degradeReason).toBe('sidebar-not-found');
    expect(snap.composerTop).toBe(500);
    warn.mockRestore();
  });

  it('L0：composer + 左侧 sidebar 时无 degradeReason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ta = document.createElement('textarea');
    stubRect(ta, { top: 500, width: 600, height: 80 });
    const side = document.createElement('div');
    side.className = 'sidebar';
    stubRect(side, { right: 100, width: 100 });
    document.body.append(ta, side);
    const adapter = createHostLayoutAdapter();
    const snap = adapter.getSnapshot();
    expect(snap.level).toBe('L0');
    expect(snap.degradeReason).toBeNull();
    expect(snap.sidebarRight).toBe(100);
    warn.mockRestore();
  });

  it('observe 退订后 resize 不再回调；dispose 幂等', () => {
    const cb = vi.fn();
    const adapter = createHostLayoutAdapter();
    const unsub = adapter.observe(cb);
    window.dispatchEvent(new Event('resize'));
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    cb.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(cb).toHaveBeenCalledTimes(0);
    // dispose 幂等：连调两次不抛
    adapter.dispose();
    expect(() => adapter.dispose()).not.toThrow();
    const after = adapter.getSnapshot();
    expect(after.level).toBe('L2');
    expect(after.degradeReason).toBe('disposed');
  });
});
