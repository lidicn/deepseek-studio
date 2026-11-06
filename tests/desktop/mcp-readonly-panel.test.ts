// @vitest-environment jsdom
/**
 * 页面内 MCP 面板**只读化**（PM 2026-11-02，(B) 方案「明文密钥不过页面」）
 *
 * 背景：DeepSeek 页面内的 UI 面板与模型拦截器**同一个 `globalThis`**（Core 核实：
 * 同 bundle、同 main world、同 host 实例）→ 页面里的任何写路径都是模型够得着的路径。
 * MCP 配置里装着凭据（env / headers 的值、url 的 userinfo、args 的 `--token xxx`），
 * 所以页面内一律**只读**：写操作全部搬到工作台（独立 origin `127.0.0.1:8760`）。
 *
 * 三层断言：
 *   1. **行为层**：弹窗渲染后没有可编辑控件；只读 `mcp.get`；「去工作台编辑」调
 *      `window.__studioOpenWorkbench`（已有 Tauri 命令，不新开凭据面）。
 *   2. **结构层**：源码里没有写类工具调用、没有可编辑元素构造。
 *   3. **负控层**：判据函数对 **v1.0 可写实现的快照**必须判 false ——
 *      证明「只读」这条判据**有区分力**，不是恒真断言。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `vi.mock` 的工厂会被 hoist 到文件顶部 → 不能直接引用顶层 `const`（TDZ）。
// 必须用 `vi.hoisted` 把 mock 一起提升。
const { callHostToolMock } = vi.hoisted(() => ({ callHostToolMock: vi.fn() }));
vi.mock('../../src/ui/studio-ui-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/studio-ui-core')>();
  return { ...actual, callHostTool: callHostToolMock };
});

import { createMcpConfigDialog } from '../../src/ui/studio-mcp-dialog';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DIALOG_SRC = path.join(REPO_ROOT, 'src', 'ui', 'studio-mcp-dialog.ts');
const PANEL_SRC = path.join(REPO_ROOT, 'src', 'ui', 'studio-settings-panel.ts');
const FIXTURE_V1 = path.join(HERE, 'fixtures', 'mcp-panel-v1-writable.fixture.txt');

/**
 * 「页面内只读」判据 —— 单一事实源，行为测试与负控共用。
 *
 * 命中任一条即判为**非只读**：
 *   - 调了写类工具（mcp.save / mcp.test / mcp.remove）
 *   - 构造了可编辑控件（input / textarea / select）
 *   - 没有工作台入口（`__studioOpenWorkbench`）
 */
export function isPagePanelReadonly(source: string): boolean {
  const writeCalls = ['mcp.save', 'mcp.test', 'mcp.remove'];
  for (const call of writeCalls) {
    if (source.includes(`'${call}'`) || source.includes(`"${call}"`)) return false;
  }
  if (/el\(\s*'input'|el\(\s*'textarea'|el\(\s*'select'|createElement\(\s*'input'/.test(source)) return false;
  if (!source.includes('__studioOpenWorkbench')) return false;
  return true;
}

afterEach(() => {
  document.body.replaceChildren();
  callHostToolMock.mockReset();
  // 卡 C：两个入口桥都要清掉，防跨用例污染（主路径闭包 vs 回落工作台桥）。
  delete (window as unknown as { __studioOpenMcpSettings?: () => void }).__studioOpenMcpSettings;
  delete (window as unknown as { __studioOpenWorkbench?: () => void }).__studioOpenWorkbench;
});

describe('页面内 MCP 弹窗：只读行为', () => {
  it('渲染后没有任何可编辑控件', async () => {
    callHostToolMock.mockResolvedValue({
      ok: true,
      data: {
        id: 'fs',
        config: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'server'],
          env: { API_KEY: '****' },
          headers: { Authorization: '****' },
        },
      },
    });

    const dialog = createMcpConfigDialog();
    document.body.appendChild(dialog.container);
    dialog.open('fs');
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelectorAll('input').length).toBe(0);
    expect(document.querySelectorAll('textarea').length).toBe(0);
    expect(document.querySelectorAll('select').length).toBe(0);
  });

  it('只读 mcp.get，绝不调写类工具', async () => {
    callHostToolMock.mockResolvedValue({ ok: true, data: { config: { transport: 'stdio', command: 'npx' } } });

    const dialog = createMcpConfigDialog();
    document.body.appendChild(dialog.container);
    dialog.open('fs');
    await new Promise((r) => setTimeout(r, 0));

    const calls = callHostToolMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain('mcp.get');
    expect(calls).not.toContain('mcp.save');
    expect(calls).not.toContain('mcp.test');
    expect(calls).not.toContain('mcp.remove');
  });

  it('显示宿主侧掩码后的值（****），不显示明文', async () => {
    callHostToolMock.mockResolvedValue({
      ok: true,
      data: { config: { transport: 'stdio', command: 'npx', env: { API_KEY: '****' } } },
    });

    const dialog = createMcpConfigDialog();
    document.body.appendChild(dialog.container);
    dialog.open('fs');
    await new Promise((r) => setTimeout(r, 0));

    const text = dialog.container.textContent ?? '';
    expect(text).toContain('API_KEY');
    expect(text).toContain('****');
  });

  it('（兜底）「去工作台编辑」：__studioOpenMcpSettings 缺失 → 回落 open_workbench 桥（旧构建不打红）', async () => {
    callHostToolMock.mockResolvedValue({ ok: true, data: { config: { transport: 'stdio', command: 'npx' } } });
    const opened: number[] = [];
    // 主路径闭包**不设**（模拟旧构建 / Core 注入未就位），并显式删净确保顺序无关；
    // 按钮的 `openMcpSettings` 兜底必须落到 open_workbench 桥。
    delete (window as unknown as { __studioOpenMcpSettings?: () => void }).__studioOpenMcpSettings;
    (window as unknown as { __studioOpenWorkbench?: () => void }).__studioOpenWorkbench = () => { opened.push(1); };

    const dialog = createMcpConfigDialog();
    document.body.appendChild(dialog.container);
    dialog.open('fs');
    await new Promise((r) => setTimeout(r, 0));

    const btn = Array.from(dialog.container.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('去工作台编辑'));
    expect(btn).toBeTruthy();
    btn!.click();
    expect(opened.length).toBe(1);
  });

  it('（主路径）「去工作台编辑」：优先调 __studioOpenMcpSettings、**不**回落 open_workbench（卡 C 真回归）', async () => {
    callHostToolMock.mockResolvedValue({ ok: true, data: { config: { transport: 'stdio', command: 'npx' } } });
    const mcpOpened: number[] = [];
    const wbOpened: number[] = [];
    (window as unknown as { __studioOpenMcpSettings?: () => void }).__studioOpenMcpSettings = () => { mcpOpened.push(1); };
    (window as unknown as { __studioOpenWorkbench?: () => void }).__studioOpenWorkbench = () => { wbOpened.push(1); };

    const dialog = createMcpConfigDialog();
    document.body.appendChild(dialog.container);
    dialog.open('fs');
    await new Promise((r) => setTimeout(r, 0));

    const btn = Array.from(dialog.container.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('去工作台编辑'));
    expect(btn).toBeTruthy();
    btn!.click();
    // 主路径命中：__studioOpenMcpSettings 被调；回落的 open_workbench **不得**被调。
    expect(mcpOpened.length).toBe(1);
    expect(wbOpened.length).toBe(0);
  });
});

describe('页面内 MCP 面板：结构锁', () => {
  it('弹窗源码满足只读判据', () => {
    expect(isPagePanelReadonly(fs.readFileSync(DIALOG_SRC, 'utf8'))).toBe(true);
  });

  it('设置面板没有写类 emit / 工具调用', () => {
    const src = fs.readFileSync(PANEL_SRC, 'utf8');
    expect(src).not.toContain("'ui:mcp-add'");
    expect(src).not.toContain("'ui:mcp-edit'");
    expect(src).not.toContain("'mcp.remove'");
    expect(src).not.toContain("'mcp.save'");
  });
});

describe('负控：只读判据能咬住缺口', () => {
  it('v1.0 可写实现必须被判为非只读', () => {
    const v1 = fs.readFileSync(FIXTURE_V1, 'utf8');
    expect(isPagePanelReadonly(v1)).toBe(false);
  });
});
