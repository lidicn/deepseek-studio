// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { createSettingsPanel } from '../../src/ui/studio-settings-panel';

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

  it('日志路径行：稳定表述，非盘符绝对路径形态、无本机专属片段', () => {
    const handle = mount('diagnostics');
    const text = allTextLines(handle.container).join('\n');
    // 形态：不含任何 `X:\` / `X:/` 开头行
    for (const line of text.split('\n')) expect(line).not.toMatch(DRIVE_ABS_PATH);
    // 本机专属片段
    expect(text).not.toContain('E:\\NAS');
    expect(text).not.toContain('C:\\Users');
    expect(text).not.toContain('tauri-real.log');
    handle.destroy();
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
