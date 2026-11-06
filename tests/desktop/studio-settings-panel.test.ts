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

  it('③ 日志/配置路径行（无宿主桥 / sendToolCall 失败）：显式「不可用」，不出现模板串、不出现盘符形态', async () => {
    // 旧断言替换报备（规矩④，2026-11-06 裁定十）：删的是旧「日志路径行：稳定表述」一条
    //（锁模板串稳定文案的时代），换成此条 + 下面两条真值分支。
    setHostBridge(deadBridge);
    const handle = mount('diagnostics');
    await flushOneTick();
    const lines = allTextLines(handle.container);
    const text = lines.join('\n');
    // 值节点与 label 节点是两个独立文本节点：按**精确值行**断（防模板串/占位回退），不用跨行拼接串
    expect(lines).toContain('sidecar 日志：不可用 · 宿主 trace：不可用（当前形态未注入数据根）');
    expect(lines).toContain('不可用');
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
    expect(lines).toContain('sidecar 日志：不可用 · 宿主 trace：不可用（当前形态未注入数据根）');
    expect(lines).toContain('不可用');
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
