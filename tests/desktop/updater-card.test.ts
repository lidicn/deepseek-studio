// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  checkUpdate,
  isUpdateSkipped,
  showUpdateCard,
  skipUpdateVersion,
  UPDATE_SKIP_KEY,
  type TauriInternals,
} from '../../src/ui/update-card';

/**
 * 更新卡（TD-updater 卡 · UI 侧）：契约见 src/ui/update-card.ts 头注。
 * 负控口径：`updater_check` 返回 null（无更新/失败）→ 不弹卡、不报错（fail-safe）；
 * 进度只信 `updater_progress` 轮询，不信 `updater_install` 的返回值。
 */

function makeInternals(overrides?: Record<string, unknown>): TauriInternals {
  const calls: Record<string, unknown[]> = {};
  const internals: TauriInternals = {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls[cmd] = args ? [args] : [];
      switch (cmd) {
        case 'updater_check':
          // `!== undefined` 而非 `??`：null 是合法覆盖值（fail-safe 用例要测 null 本身）。
          return overrides?.updater_check_result !== undefined
            ? (overrides.updater_check_result as { version: string; notes: string; currentVersion: string })
            : { version: '0.14.1', notes: '修复若干问题', currentVersion: '0.14.0' };
        case 'updater_install':
          return overrides?.updater_install_result !== undefined
            ? (overrides.updater_install_result as { started: boolean })
            : { started: true };
        case 'updater_progress':
          return overrides?.updater_progress_results
            ? ((overrides.updater_progress_results as unknown[]).shift() ?? { state: 'idle' })
            : { state: 'idle' };
        default:
          return undefined;
      }
    },
  };
  (internals as unknown as { __calls: Record<string, unknown[]> }).__calls = calls;
  return internals;
}

function callsOf(internals: TauriInternals): Record<string, unknown[]> {
  return (internals as unknown as { __calls: Record<string, unknown[]> }).__calls;
}

describe('update-card：checkUpdate', () => {
  it('有更新 → resolve 完整 info', async () => {
    const internals = makeInternals();
    const info = await checkUpdate(internals);
    expect(info).toEqual({ version: '0.14.1', notes: '修复若干问题', currentVersion: '0.14.0' });
    expect(callsOf(internals).updater_check).toBeDefined();
  });

  it('null（无更新/检查失败/网络错误）→ resolve null，不抛错（fail-safe，不弹错给用户）', async () => {
    const internals = makeInternals({ updater_check_result: null });
    const info = await checkUpdate(internals);
    expect(info).toBeNull();
  });

  it('invoke 缺失（非 Tauri）→ resolve null，不抛', async () => {
    const info = await checkUpdate({} as TauriInternals);
    expect(info).toBeNull();
  });

  it('返回值缺 version（坏形状）→ 按 null 处理', async () => {
    const internals = makeInternals({ updater_check_result: { notes: 'x' } });
    expect(await checkUpdate(internals)).toBeNull();
  });
});

describe('update-card：skip 判定', () => {
  beforeEach(() => window.localStorage.clear());

  it('「下次再说」写 localStorage，同版本 isUpdateSkipped=true，换版本=false', () => {
    skipUpdateVersion('0.14.1');
    expect(window.localStorage.getItem(UPDATE_SKIP_KEY)).toBe('0.14.1');
    expect(isUpdateSkipped('0.14.1')).toBe(true);
    expect(isUpdateSkipped('0.14.2')).toBe(false);
  });
});

describe('update-card：卡片渲染与按钮行为', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('渲染版本标题（当前版本）+ 两个按钮', () => {
    const internals = makeInternals();
    const handle = showUpdateCard(
      { version: '0.14.1', notes: '修复若干问题', currentVersion: '0.14.0' },
      internals,
    );
    expect(handle.root.isConnected).toBe(true);
    expect(handle.root.textContent).toContain('发现新版本 v0.14.1');
    expect(handle.root.textContent).toContain('当前 0.14.0');
    expect(handle.root.textContent).toContain('修复若干问题');
    const buttons = handle.root.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    handle.close();
    expect(handle.root.isConnected).toBe(false);
  });

  it('「下次再说」→ 关卡 + 写 skip 记录（负控：不记就同版本反复弹）', () => {
    const internals = makeInternals();
    const handle = showUpdateCard({ version: '0.15.0', currentVersion: '0.14.0' }, internals);
    const [btnInstall, btnLater] = handle.root.querySelectorAll('button');
    btnLater!.click();
    expect(handle.root.isConnected).toBe(false);
    expect(isUpdateSkipped('0.15.0')).toBe(true);
    // 按钮顺序：立即更新在前、下次再说在后
    expect(btnInstall!.textContent).toBe('立即更新');
  });

  it('「立即更新」→ 调 updater_install + 轮询 updater_progress（downloading→done 驱动卡片）', async () => {
    vi.useFakeTimers();
    try {
      const internals = makeInternals({
        updater_progress_results: [
          { state: 'downloading', downloaded: 3, total: 8 },
          { state: 'downloading', downloaded: 8, total: 8 },
          { state: 'done' },
        ],
      });
      const handle = showUpdateCard({ version: '0.14.1', currentVersion: '0.14.0' }, internals);
      const [btnInstall] = handle.root.querySelectorAll('button');
      btnInstall!.click();
      // 进度轮询 500ms 一拍；用 Async 版让 `.then` 微任务在每拍后冲刷完。
      await vi.advanceTimersByTimeAsync(500);
      expect(handle.root.textContent).toContain('正在下载');
      expect(callsOf(internals).updater_install).toBeDefined();
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500); // 第三拍 → done
      expect(handle.root.textContent).toContain('已更新，重启生效');
      const [doneBtn, laterBtn] = handle.root.querySelectorAll('button');
      expect(doneBtn!.textContent).toBe('已更新，重启生效');
      expect((doneBtn! as HTMLButtonElement).disabled).toBe(true);
      expect(laterBtn!.textContent).toBe('关闭');
      handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('install 后 state=error → 显示错误行，不崩', async () => {
    vi.useFakeTimers();
    try {
      const internals = makeInternals({
        updater_progress_results: [{ state: 'error', error: '签名校验失败' }],
      });
      const handle = showUpdateCard({ version: '0.14.1' }, internals);
      handle.root.querySelector('button')!.click();
      await vi.advanceTimersByTimeAsync(500);
      expect(handle.root.textContent).toContain('安装失败：签名校验失败');
      handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('空流负控：无 updater_check 命中（null）时，entry 逻辑不弹卡 —— checkUpdate 返回 null 本身即证据', async () => {
    const internals = makeInternals({ updater_check_result: null });
    const info = await checkUpdate(internals);
    // entry.ts 对 null 的唯一行为就是「不弹卡」；这里锁住返回 null 的语义不变
    expect(info).toBeNull();
  });
});
