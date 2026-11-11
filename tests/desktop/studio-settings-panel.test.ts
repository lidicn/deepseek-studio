// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { createSettingsPanel } from '../../src/ui/studio-settings-panel';
import { setHostBridge, type StudioHostBridge } from '../../src/ui/studio-ui-core';

/**
 * 设置面板假路径卡（PM 2026-11-05，用户真机发现）：发行版面板曾显示写死的
 * 开发机路径（`E:\NAS\deepseek-studio\tauri-real.log`，陈旧未入库文件）与假版本
 * （`v1.0.0`，打包产物里命中）——用户看到的「每一条都得是真的」。
 *
 * 本文件按**形态**钉死（不钉具体值，防「换成另一个常量」绕过）：
 *  - 版本行：值必须**等于运行时来源**（`globalThis.__STUDIO_APP_VERSION__`，构建期
 *    esbuild.define 注入 = package.json version；测试注入任意值即应原样渲染）；
 *  - 日志路径行：不得为盘符绝对路径形态（`X:\` / `X:/`），不得含本机专属片段；
 *  - 归档位置行：整行不存在（发行版没有 `archive/legacy/`）；
 *  - 通用形态：面板内**任何文本行**不以盘符绝对路径开头（防将来新增行又写死）。
 */

function setInjectedVersion(v: string | undefined): void {
  const g = globalThis as { __STUDIO_APP_VERSION__?: string };
  if (v === undefined) delete g.__STUDIO_APP_VERSION__;
  else g.__STUDIO_APP_VERSION__ = v;
}

/** 等一拍，让面板 mount 后异步的 `fillPathRows`（`settings.get` 往返）完成。 */
function flushOneTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** 造一个 `settings.get` 返回给定 `data` 的桥。 */
function settingsBridge(data: unknown): StudioHostBridge {
  return {
    sendToolCall: async (req) =>
      req.invocationName === 'settings.get' ? { ok: true, data } : { ok: true, data: null },
    log: () => {},
  };
}

/** 无宿主桥（sendToolCall 失败）——模拟宿主不可达，语义等同未接桥。 */
const deadBridge: StudioHostBridge = {
  sendToolCall: async () => ({ ok: false, error: 'dead-bridge' }),
  log: () => {},
};

/** 收集面板渲染出的所有文本节点的去空白值（createShadowContainer 是 light DOM，container 即根）。 */
function allTextLines(root: Node): string[] {
  const walker = root.ownerDocument!.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const out: string[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = (n.nodeValue ?? '').trim();
    if (t) out.push(t);
  }
  return out;
}

const DRIVE_ABS_PATH = /^[A-Za-z]:[\\/]/; // 盘符绝对路径形态（X:\ 或 X:/）

describe('设置面板：假路径/假版本防线（形态断言）', () => {
  afterEach(() => {
    setInjectedVersion(undefined);
    setHostBridge(deadBridge); // 复位桥：后续用例回到「宿主不可达 → 不可用」语义
    document.body.innerHTML = '';
  });

  function mount(tab?: 'general' | 'diagnostics') {
    const handle = createSettingsPanel({});
    document.body.appendChild(handle.container);
    handle.open(tab ?? 'general');
    return handle;
  }

  it('版本行 = 运行时来源值（注入 0.999-test 即渲染 0.999-test；绝不硬编码）', () => {
    setInjectedVersion('0.999-test');
    const handle = mount('general');
    const lines = allTextLines(handle.container);
    const versionRow = lines.filter((l) => l === '0.999-test');
    expect(versionRow.length).toBeGreaterThanOrEqual(1);
    // 占位形态断言（可选但锁住旧病）：
    expect(lines.join('\n')).not.toContain('v1.0.0');
    handle.destroy();
  });

  it('无注入（dev 树/测试）→ 版本行 = unknown（仍非任何硬编码版本）', () => {
    setInjectedVersion(undefined);
    const handle = mount('general');
    const lines = allTextLines(handle.container);
    expect(lines).toContain('unknown');
    expect(lines.join('\n')).not.toContain('v1.0.0');
    handle.destroy();
  });

  /** P4 UX 卡（0.14.10）：「诊断与关于」页补了版本行（值仍走 runtimeAppVersion()）。
   *  负控须证明「版本行真的渲染出构建期版本」——钉在**诊断页**那个 `[data-settings-version]` 上，
   *  不是泛泛断言 DOM 里有 span。取**诊断页专属**节点（`[data-tab-panel=diagnostics]` 作用域）。 */
  function diagnosticsVersionText(handle: { container: HTMLElement }): string | null {
    const el = handle.container.querySelector('[data-tab-panel="diagnostics"] [data-settings-version]');
    return el ? el.textContent : null;
  }

  it('P4 负控：诊断页版本行渲染构建期版本（注入 0.999-test ⇒ 诊断页显示 0.999-test，非空、非硬编码）', () => {
    setInjectedVersion('0.999-test');
    const handle = mount('diagnostics');
    expect(diagnosticsVersionText(handle)).toBe('0.999-test'); // 构建期值真的渲染进诊断页
    expect(handle.container.textContent).not.toContain('v1.0.0');
    handle.destroy();
  });

  it('P4 负控：dev 树（无 define）→ 诊断页版本行 = unknown（非空、非缺失）', () => {
    setInjectedVersion(undefined);
    const handle = mount('diagnostics');
    expect(diagnosticsVersionText(handle)).toBe('unknown'); // dev 形态兜底 unknown，而非空串
    handle.destroy();
  });

  it('③ 日志/配置路径行（无宿主桥 / sendToolCall 失败）：显式「不可用」，不出现模板串、不出现盘符形态', async () => {
    // 旧断言替换报备（规矩④，2026-11-06 裁定十）：删的是旧「日志路径行：稳定表述」一条
    //（锁模板串稳定文案的时代），换成此条 + 下面两条真值分支。
    setHostBridge(deadBridge);
    const handle = mount('diagnostics');
    await flushOneTick();
    const lines = allTextLines(handle.container);
    const text = lines.join('\n');
    // 值节点与 label 节点是两个独立文本节点：按**精确值行**断（防模板串/占位回退），不用跨行拼接串。
    // P4 UX 卡（0.14.10）：宿主未连上（deadBridge）→「不可用」须说清「宿主未连接、不是路径不存在」。
    expect(lines).toContain('sidecar 日志：不可用（宿主未连接，读不到） · 宿主 trace：不可用（宿主未连接，读不到）');
    expect(lines).toContain('不可用（宿主未连接，读不到）');
    expect(text).toContain('不可用'); // 子串（数组 toContain 是严格相等，加注释后配置行非纯「不可用」）
    // 旧模板串不许复活
    expect(text).not.toContain('<用户配置目录>');
    expect(text).not.toContain('<运行数据目录>');
    expect(text).not.toContain('~/.config/deepseek-studio');
    expect(text).not.toContain('tauri-real.log');
    // 本机专属片段 + 盘符形态（旧断言语义延续）
    expect(text).not.toContain('E:\\NAS');
    expect(text).not.toContain('C:\\Users');
    for (const line of text.split('\n')) expect(line).not.toMatch(DRIVE_ABS_PATH);
    handle.destroy();
  });

  it('③ 日志/配置路径行（宿主返回 env 注入真值）：原样显示 logDir/configDir，dataDir 作数据根展示', async () => {
    setHostBridge(settingsBridge({ logDir: '/opt/studio/logs', logDirSource: 'env', configDir: '/opt/studio/config', dataDir: '/opt/studio/data' }));
    const handle = mount('general');
    await flushOneTick();
    const text = allTextLines(handle.container).join('\n');
    expect(text).toContain('/opt/studio/logs');
    expect(text).toContain('/opt/studio/config');
    expect(text).toContain('宿主 trace 在数据根下（/opt/studio/data）');
    // env 来源不该带「回落」标注
    expect(text).not.toContain('（回落值，非注入）');
    handle.destroy();
  });

  it('③ 日志行（logDirSource=fallback）标注「回落值，非注入」；dataDir=null → 宿主 trace 显「不可用」', async () => {
    setHostBridge(settingsBridge({ logDir: '/opt/studio/logs', logDirSource: 'fallback', configDir: '/opt/studio/config', dataDir: null }));
    const handle = mount('diagnostics');
    await flushOneTick();
    const text = allTextLines(handle.container).join('\n');
    expect(text).toContain('/opt/studio/logs（回落值，非注入）');
    expect(text).toContain('宿主 trace：不可用（当前形态未注入数据根）');
    expect(text).toContain('/opt/studio/config');
    // P4 UX 回归：宿主可达（settings.get 取到 data）→ 不得误标「宿主未连接」（那是真·宿主没连上的信号）。
    expect(text).not.toContain('宿主未连接，读不到');
    handle.destroy();
  });

  // ── 2026-11-06 第 9 次闸回归（fail-visible：取不到就显「不可用」，面板挂载期任何路径零 unhandled rejection）──

  /** {ok:true} 但无 data：旧实现在此形态下 info===undefined → `info.logDir` 裸解引用 TypeError（闸红根因）。 */
  function okWithoutDataBridge(): StudioHostBridge {
    return {
      sendToolCall: async (req) =>
        req.invocationName === 'settings.get' ? { ok: true } : { ok: true, data: null },
      log: () => {},
    };
  }

  /** sendToolCall 一律 reject（宿主进程死/WS 断）：面板不得抛、不得静默、不得留 unhandled rejection。 */
  function rejectingBridge(): StudioHostBridge {
    return {
      sendToolCall: async (): Promise<never> => {
        throw new Error('bridge-down');
      },
      log: () => {},
    };
  }

  /** 捕获挂载窗口内的 unhandled rejection（process + window 双源，与 gate「Errors」行同源）。 */
  function captureUnhandledRejections(): { dispose(): void; items(): unknown[] } {
    const items: unknown[] = [];
    const onProc = (reason: unknown) => items.push(reason);
    const onWin = (e: Event) => items.push(e);
    process.on('unhandledRejection', onProc);
    window.addEventListener('unhandledrejection', onWin);
    return {
      dispose(): void {
        process.off('unhandledRejection', onProc);
        window.removeEventListener('unhandledrejection', onWin);
      },
      items: () => items,
    };
  }

  /** 挂载期异步路径（fillPathRows/loadMcp/loadSkills/reloadActive/reloadArchived/controls.refresh）全部 settle，
   * 并越过 unhandled rejection 的报告窗口（microtask 队列清空后才上报）。 */
  async function settleMount(ms = 80): Promise<void> {
    await flushOneTick();
    await new Promise((r) => setTimeout(r, ms));
  }

  function assertPathRowsUnavailable(handle: { container: HTMLElement }): void {
    const lines = allTextLines(handle.container);
    // P4 UX 卡（0.14.10）：宿主未连上（sendToolCall reject / ok:false / 无 data）→「不可用（宿主未连接，读不到）」。
    expect(lines).toContain('sidecar 日志：不可用（宿主未连接，读不到） · 宿主 trace：不可用（宿主未连接，读不到）');
    expect(lines).toContain('不可用（宿主未连接，读不到）');
  }

  it('③ 回归（第 9 次闸）：宿主返回 {ok:true} 但无 data → 路径行显「不可用」且零 unhandled rejection', async () => {
    const ur = captureUnhandledRejections();
    let handle: ReturnType<typeof mount> | undefined;
    try {
      setHostBridge(okWithoutDataBridge());
      handle = mount('diagnostics');
      await settleMount();
      assertPathRowsUnavailable(handle);
    } finally {
      handle?.destroy();
      ur.dispose();
    }
    expect(ur.items()).toEqual([]);
  });

  it('③ 回归（第 9 次闸）：sendToolCall reject（宿主不可达）→ 路径行显「不可用」、各拉取区可见提示、且零 unhandled rejection', async () => {
    const ur = captureUnhandledRejections();
    let handle: ReturnType<typeof mount> | undefined;
    try {
      setHostBridge(rejectingBridge());
      handle = mount('diagnostics');
      await settleMount();
      assertPathRowsUnavailable(handle);
      // 挂载期其余拉取路径 fail-visible（不是静默吞掉）：MCP 区/技能区/记忆区各有可见提示
      const text = allTextLines(handle.container).join('\n');
      expect(text).toContain('MCP 列表获取失败');
      expect(text).toContain('技能列表获取失败');
      expect(text).toContain('记忆列表获取失败');
    } finally {
      handle?.destroy();
      ur.dispose();
    }
    expect(ur.items()).toEqual([]);
  });

  it('③ 回归（第 9 次闸）：宿主返回 {ok:false} → 路径行显「不可用」且零 unhandled rejection', async () => {
    const ur = captureUnhandledRejections();
    let handle: ReturnType<typeof mount> | undefined;
    try {
      setHostBridge(deadBridge); // {ok:false} 形态
      handle = mount('diagnostics');
      await settleMount();
      assertPathRowsUnavailable(handle);
    } finally {
      handle?.destroy();
      ur.dispose();
    }
    expect(ur.items()).toEqual([]);
  });

  it('归档位置行整行不存在（发行版没有 archive/legacy/ 目录）', () => {
    const handle = mount('diagnostics');
    const text = allTextLines(handle.container).join('\n');
    expect(text).not.toContain('归档位置');
    expect(text).not.toContain('archive/legacy');
    handle.destroy();
  });

  it('通用形态：面板内任何文本行不以盘符绝对路径开头（防将来新增行又写死）', () => {
    const handle = mount('general');
    const offenders = allTextLines(handle.container).filter((l) => DRIVE_ABS_PATH.test(l));
    expect(offenders).toEqual([]);
    handle.destroy();
  });

  it('负控形态：若有人把日志路径改回 `E:\\NAS\\...` 字面量，上述「非盘符形态」断言必红', () => {
    // 说明性负控（与形态断言同源）：DRIVE_ABS_PATH 对旧病句子的匹配自证。
    expect('E:\\NAS\\deepseek-studio\\tauri-real.log').toMatch(DRIVE_ABS_PATH);
    expect('C:/Users/lidicn/x.log').toMatch(DRIVE_ABS_PATH);
    expect('运行时数据目录：~/.config/deepseek-studio/').not.toMatch(DRIVE_ABS_PATH);
  });
});

/**
 * C-2 卡（手动「检查更新」入口，PM 16:3x 派卡＋预批验收口径）：
 * 诊断页一枚「检查更新」按钮 ⇒ `invoke('updater_check', { force: true })`（绕过进程内一次性缓存，
 * 真机不重启即可再查一次）；null ⇒ 状态行＝两态合一文案「没有可用更新，或本次检查未成功」
 * （不得写「已是最新」＝假绿）；非 null ⇒ 走现有更新卡（字段不破、不叠卡）。
 * 负控：摘掉 force 实参／改两态文案 ⇒ 下述必红。
 */
describe('设置面板：手动「检查更新」入口（C-2 卡，诊断页）', () => {
  const tauriGlobal = globalThis as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => unknown } };

  afterEach(() => {
    delete tauriGlobal.__TAURI_INTERNALS__;
    setHostBridge(deadBridge);
    document.body.innerHTML = '';
  });

  function mountDiag() {
    const handle = createSettingsPanel({});
    document.body.appendChild(handle.container);
    handle.open('diagnostics');
    return handle;
  }

  it('诊断页有按钮；点击 ⇒ invoke 实参带 { force: true }（PM 判据①：绕过一次性缓存）；null ⇒ 状态行＝两态合一文案（判据②：不写「已是最新」）', async () => {
    setHostBridge(settingsBridge({ logDir: '/tmp/x' }));
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    tauriGlobal.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => { calls.push({ cmd, args }); return null; }, // updater_check → null（无更新/检查失败，两态合一）
    };
    const handle = mountDiag();
    const btn = handle.container.querySelector('[data-settings-check-update]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    await flushOneTick();
    const checkCalls = calls.filter((c) => c.cmd === 'updater_check');
    expect(checkCalls.length).toBe(1);
    expect(checkCalls[0].args).toEqual({ force: true });
    const status = handle.container.querySelector('[data-settings-updater-status]')!;
    expect(status.textContent).toBe('没有可用更新，或本次检查未成功');
    expect(status.textContent).not.toContain('已是最新');
    handle.destroy();
  });

  it('非 null ⇒ 现有更新卡落地（判据③：字段不破、不叠卡）；不重启再点一次仍能发起检查（invoke 两次、每次 force: true）', async () => {
    setHostBridge(settingsBridge({ logDir: '/tmp/x' }));
    let checkInvocations = 0;
    const checkArgs: Array<Record<string, unknown> | undefined> = [];
    tauriGlobal.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => {
        if (cmd === 'updater_check') {
          checkInvocations += 1;
          checkArgs.push(args);
          return { version: '9.9.9', notes: '测试说明', currentVersion: '9.9.8' };
        }
        if (cmd === 'updater_progress') return { state: 'idle' };
        return undefined;
      },
    };
    const handle = mountDiag();
    const btn = handle.container.querySelector('[data-settings-check-update]') as HTMLButtonElement;
    btn.click();
    await flushOneTick();
    const cards = document.querySelectorAll('#studio-update-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('v9.9.9');
    expect(handle.container.querySelector('[data-settings-updater-status]')!.textContent).toContain('发现新版本 v9.9.9');
    // 不重启再点一次 ⇒ 仍发起新检查（UI 无短路；缓存旁路由 Rust 侧 force 语义保证）
    btn.click();
    await flushOneTick();
    expect(checkInvocations).toBe(2);
    expect(checkArgs).toEqual([{ force: true }, { force: true }]);
    // 旧卡先关再开：全 DOM 仍只有一枚卡（不叠卡）
    expect(document.querySelectorAll('#studio-update-card').length).toBe(1);
    handle.destroy();
  });

  it('重入保护：检查在飞时连点只发一次；完成后新点击发起新检查', async () => {
    setHostBridge(settingsBridge({ logDir: '/tmp/x' }));
    let calls = 0;
    let resolveCheck: ((v: unknown) => void) | null = null;
    tauriGlobal.__TAURI_INTERNALS__ = {
      invoke: (cmd) => {
        if (cmd === 'updater_check') {
          calls += 1;
          return new Promise((res) => { resolveCheck = res; });
        }
        return undefined;
      },
    };
    const handle = mountDiag();
    const btn = handle.container.querySelector('[data-settings-check-update]') as HTMLButtonElement;
    btn.click();
    await flushOneTick();
    btn.click();
    btn.click();
    await flushOneTick();
    expect(calls).toBe(1); // 在飞守卫：连点不叠发
    resolveCheck!(null);
    await flushOneTick();
    btn.click();
    await flushOneTick();
    expect(calls).toBe(2); // 检查结束后可再发起
    handle.destroy();
  });
});

/**
 * 待修② UI 文案卡（0.14.19，PM 19:5x 放窗）：rate-limited 终局改冷却后，
 * 设置页「宿主未连接，读不到」是误报（宿主活着、取券通道在冷却）。
 * 文案口径（PM 定字）：「宿主限流（冷却中），30 秒后自动重试一次」——与
 * entry.ts surfaceGrantFailure stopNote（rate-limited 分支）逐字一致、不许第二套说法。
 * 面板经页端痕迹 window.__studioGrantStatus（entry.ts setGrantStatus 写入）识别限流态。
 * 负控：把限流分支摘掉／把文案改成「已是最新」类 ⇒ 下述必红；
 * 摘 open() 里的 `fillPathRows()`（重取半边）⇒「重取半边」那条必红。
 */
describe('设置面板：限流态误报文案（待修②，noDataNote 分支）', () => {
  const RATE_LIMIT_NOTE = '宿主限流（冷却中），30 秒后自动重试一次';
  const g = globalThis as { __studioGrantStatus?: unknown };

  function setGrantStatus(st: unknown): void {
    if (st === undefined) delete g.__studioGrantStatus;
    else g.__studioGrantStatus = st;
  }

  afterEach(() => {
    setGrantStatus(undefined); // 防痕迹泄漏到后续用例（其他用例的「宿主未连接」断言依赖无痕迹）
    setHostBridge(deadBridge);
    document.body.innerHTML = '';
  });

  function mountDiag() {
    const handle = createSettingsPanel({});
    document.body.appendChild(handle.container);
    handle.open('diagnostics');
    return handle;
  }

  it('限流态（__studioGrantStatus lastError=rate-limited）＋取不到数据 ⇒ 路径行显示限流冷却文案、不出现「宿主未连接」（误报回归锁）', async () => {
    setHostBridge(deadBridge); // settings.get 无数据
    setGrantStatus({ stage: 'resolver-invoked', failed: true, aud: 'main', lastError: 'rate-limited', cause: null, ts: 1_000 });
    const handle = mountDiag();
    await flushOneTick();
    const lines = allTextLines(handle.container);
    expect(lines).toContain(`sidecar 日志：不可用（${RATE_LIMIT_NOTE}） · 宿主 trace：不可用（${RATE_LIMIT_NOTE}）`);
    expect(lines).toContain(`不可用（${RATE_LIMIT_NOTE}）`);
    expect(lines.join('\n')).not.toContain('宿主未连接'); // 限流态宿主活着，「未连接」是误报
    handle.destroy();
  });

  it('取不到数据但痕迹非限流（lastError=host-down）⇒ 仍走旧文案「宿主未连接，读不到」（旧分支不被误伤）', async () => {
    setHostBridge(deadBridge);
    setGrantStatus({ stage: 'resolver-invoked', failed: true, aud: 'main', lastError: 'host-down', cause: null, ts: 1_000 });
    const handle = mountDiag();
    await flushOneTick();
    const lines = allTextLines(handle.container);
    expect(lines).toContain('sidecar 日志：不可用（宿主未连接，读不到） · 宿主 trace：不可用（宿主未连接，读不到）');
    expect(lines.join('\n')).not.toContain(RATE_LIMIT_NOTE);
    handle.destroy();
  });

  it('取到数据（宿主可达）⇒ 即使痕迹在限流态也不显示限流注记（数据在就不注记）', async () => {
    setHostBridge(settingsBridge({ logDir: '/opt/studio/logs', logDirSource: 'env', configDir: '/opt/studio/config' }));
    setGrantStatus({ stage: 'resolver-invoked', failed: true, aud: 'main', lastError: 'rate-limited', cause: null, ts: 1_000 });
    const handle = mountDiag();
    await flushOneTick();
    const text = allTextLines(handle.container).join('\n');
    expect(text).toContain('/opt/studio/logs');
    expect(text).not.toContain(RATE_LIMIT_NOTE);
    handle.destroy();
  });

  it('重取半边（补刀）：限流态首开显冷却文案 → 宿主恢复后重开面板 ⇒ 路径行翻回真路径（不永久停旧值；摘 open() 里的 fillPathRows 必红）', async () => {
    setHostBridge(deadBridge); // 首开：限流态且取不到数据
    setGrantStatus({ stage: 'resolver-invoked', failed: true, aud: 'main', lastError: 'rate-limited', cause: null, ts: 1_000 });
    const handle = mountDiag();
    await flushOneTick();
    expect(allTextLines(handle.container).join('\n')).toContain(`不可用（${RATE_LIMIT_NOTE}）`);
    handle.close();
    // 宿主恢复：桥开始给真数据、限流痕迹清除（30 s 后自动重试成功）
    setHostBridge(settingsBridge({ logDir: '/opt/studio/logs', logDirSource: 'env', configDir: '/opt/studio/config' }));
    setGrantStatus(undefined);
    handle.open('diagnostics');
    await flushOneTick();
    const text = allTextLines(handle.container).join('\n');
    expect(text).toContain('/opt/studio/logs'); // 文案翻成真路径（重取生效）
    expect(text).not.toContain(RATE_LIMIT_NOTE); // 限流注记消失
    expect(text).not.toContain('宿主未连接');
    handle.destroy();
  });
});
