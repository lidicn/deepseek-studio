// @vitest-environment node
/**
 * tests/desktop/mcp-remove-config-path.test.ts —— K9 的"读写同源"锁（2026-11-09）。
 *
 * ── 缺口形状 ──
 * `mcp-controller.ts` 的 `defaultConfigPath()` 有**三级**优先级：
 *   `STUDIO_MCP_CONFIG`（整条路径 override）→ `STUDIO_CONFIG_DIR` → `~/.config/deepseek-studio`。
 * 而 `desktop-host.ts` 的 `mcp.remove` 工具原先按 `STUDIO_CONFIG_DIR ?? ~/.config` 自己推导，
 * **不认 `STUDIO_MCP_CONFIG`** ⇒ 一旦设了 override 就是"读 A、写 B"，
 * `remove` 返回成功但服务器其实还在（或删掉了另一份里的同名条目）。
 *
 * ── 判据（这是本文件存在的理由）──
 * **"写的那份必须是读的那份"，而不是"两边推导公式要一致"。**
 * 所以断言分两半，缺一不可：
 *   (i)  **被删的是控制器读的那份**；
 *   (ii) **未被读取的那份逐字节不变**。
 * 只断言 (i) 会被"两边一起读错同一个文件"的实现骗过去——那正是本族缺陷的原始形态。
 *
 * ── 为什么单开一份文件、不在 `c1p1-mcp-workbench-host.test.ts` 里加断言 ──
 * 那份文件 `L60-61` 设 `STUDIO_MCP_CONFIG`、`_setup-isolated-config.ts:L23-24` 又把
 * `STUDIO_CONFIG_DIR` 指向别处（双变量同设），且带两轮全量 gate flaky 的重构史
 * （`L33-46` 记录了 `vi.resetModules()` 撑爆模块 fetch RPC 的机制）。
 * 本文件用**显式 `new McpController(path)`**，不碰单例、不碰 env、不需要模块重载。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpController, removeMcpServer } from '../../src/host/mcp-controller';

/**
 * 宿主的 `mcp.remove` 走的是**模块级** `removeMcpServer(serverId, controller.configFilePath)`，
 * 而不是控制器方法（`McpController` 上没有 `removeServer`）。本文件照宿主真实调用形态测，
 * 不自造 API。
 */
function removeVia(c: McpController, id: string) {
  return removeMcpServer(id, c.configFilePath);
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST = path.join(REPO_ROOT, 'src', 'host', 'desktop-host.ts');

/** A＝装版 `STUDIO_CONFIG_DIR`/*（被**不**读取的那份）；B＝`STUDIO_MCP_CONFIG`（控制器真正读的那份）。 */
let dirA = '';
let dirB = '';
let pathA = '';
let pathB = '';

function writeServers(file: string, ids: readonly string[]): void {
  const servers: Record<string, unknown> = {};
  for (const id of ids) {
    servers[id] = { command: 'node', args: ['x.js'], env: {}, transport: 'stdio' };
  }
  writeFileSync(file, JSON.stringify({ servers }, null, 2), 'utf8');
}

beforeAll(() => {
  dirA = mkdtempSync(path.join(os.tmpdir(), 'k9-cfgdir-'));
  dirB = mkdtempSync(path.join(os.tmpdir(), 'k9-override-'));
  pathA = path.join(dirA, 'mcp-servers.json');
  pathB = path.join(dirB, 'mcp-servers.json');
});

afterAll(() => {
  for (const d of [dirA, dirB]) {
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判据 */
      }
    }
  }
});

/** 取 `'tool.name': {` 到**下一个**同类 handler 键之间的实现片段。 */
function handlerSlice(src: string, tool: string): string {
  const keyRe = /^[ \t]*'([a-zA-Z]+\.[a-zA-Z]+)':\s*\{/gm;
  const marks: { idx: number; name: string }[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = keyRe.exec(src)) !== null) marks.push({ idx: mm.index, name: mm[1] });
  const i = marks.findIndex((m) => m.name === tool);
  expect(i, `找不到 ${tool} 的处理段`).toBeGreaterThanOrEqual(0);
  const end = i + 1 < marks.length ? marks[i + 1].idx : src.length;
  return src.slice(marks[i].idx, end);
}

function removeHandlerSlice(src: string): string {
  return handlerSlice(src, 'mcp.remove');
}

/** 去掉整行注释，避免"注释里提到某标识符"被当成代码里用了它（假红）。 */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map((l) => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n');
}

describe('① 控制器的配置路径就是它读写的那份（override 生效）', () => {
  it('显式 configPath 构造 ⇒ configFilePath 原样返回', () => {
    writeServers(pathB, ['onlyB']);
    const c = new McpController(pathB);
    expect(c.configFilePath).toBe(pathB);
  });

  it('configFilePath 是只读访问器、不是可写字段（私有字段不被外部篡改）', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src', 'host', 'mcp-controller.ts'), 'utf8');
    expect(src).toContain('get configFilePath(): string');
    expect(src).toContain('private readonly configPath: string');
  });
});

describe('② 读写同源：删的是控制器那份，另一份逐字节不变', () => {
  it('(i) 删 B 里的服务器 ⇒ 真的从 B 消失', async () => {
    const dirB2 = mkdtempSync(path.join(os.tmpdir(), 'k9-override2-'));
    const pB = path.join(dirB2, 'mcp-servers.json');
    try {
      writeServers(pB, ['onlyB', 'keepMe']);
      const c = new McpController(pB);
      const r = removeVia(c, 'onlyB');
      expect(r.ok, `removeMcpServer 应成功：${r.error ?? ''}`).toBe(true);
      const after = JSON.parse(readFileSync(pB, 'utf8')) as { servers: Record<string, unknown> };
      expect(Object.keys(after.servers)).toEqual(['keepMe']);
    } finally {
      rmSync(dirB2, { recursive: true, force: true });
    }
  });

  it('(ii) 负控：只存在于 A（未被读取那份）的服务器 ⇒ 删不到，且 A 逐字节不变', () => {
    writeServers(pathA, ['onlyA']);
    writeServers(pathB, ['onlyB']);
    const bytesABefore = readFileSync(pathA);
    const bytesBBefore = readFileSync(pathB);

    const c = new McpController(pathB);
    // 控制器读 B，B 里没有 onlyA ⇒ 必失败（如果这里成功，说明路径取错了文件）
    const r = removeVia(c, 'onlyA');
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/not\s*found|不存在|missing/i);

    // ★ 核心判据 (ii)：未被读取的那份**逐字节**不变
    expect(readFileSync(pathA).equals(bytesABefore), 'A 不应被本次删除改动').toBe(true);
    expect(readFileSync(pathB).equals(bytesBBefore), 'B 也不应被改动（删除失败）').toBe(true);
  });

  it('(ii) 对照：控制器路径读的那份被删后，A 仍逐字节不变（证明写入没跑到 A）', () => {
    const dirA2 = mkdtempSync(path.join(os.tmpdir(), 'k9-cfgdir2-'));
    const dirB3 = mkdtempSync(path.join(os.tmpdir(), 'k9-override3-'));
    const pA = path.join(dirA2, 'mcp-servers.json');
    const pB = path.join(dirB3, 'mcp-servers.json');
    try {
      writeServers(pA, ['ghost']);
      writeServers(pB, ['ghost']);
      const bytesABefore = readFileSync(pA);

      const c = new McpController(pB);
      const r = removeVia(c, 'ghost');
      expect(r.ok).toBe(true);

      // B 里的 ghost 没了
      const afterB = JSON.parse(readFileSync(pB, 'utf8')) as { servers: Record<string, unknown> };
      expect(Object.keys(afterB.servers)).toEqual([]);
      // A 里的 ghost 还在，且文件逐字节未变
      expect(readFileSync(pA).equals(bytesABefore), 'A 不应被删除操作改动').toBe(true);
    } finally {
      rmSync(dirA2, { recursive: true, force: true });
      rmSync(dirB3, { recursive: true, force: true });
    }
  });
});

describe('③ 源码锁：mcp.remove 用 controller.configFilePath，不自行推导 STUDIO_CONFIG_DIR', () => {
  it('处理段内出现 configFilePath、且不出现 STUDIO_CONFIG_DIR / 强转读私有字段', () => {
    const slice = stripLineComments(removeHandlerSlice(readFileSync(HOST, 'utf8')));
    expect(slice).toContain('configFilePath');
    expect(slice).not.toContain('STUDIO_CONFIG_DIR');
    expect(slice).not.toContain('as unknown as');
  });

  it('处理段只取一次控制器实例（取路径 / 删除 / reload 用同一个对象）', () => {
    const slice = removeHandlerSlice(readFileSync(HOST, 'utf8'));
    const takeCalls = slice.match(/getMcpController\(\)/g) ?? [];
    expect(takeCalls.length, '同一 handler 里只应取一次单例').toBe(1);
    expect(slice).toContain('controller.reload()');
  });

  it('设置窗那条正确路径（remove(id)）仍用同一个访问器（防止回退成强转）', () => {
    const host = readFileSync(HOST, 'utf8');
    const at = host.indexOf('async remove(id)');
    expect(at).toBeGreaterThanOrEqual(0);
    const slice = stripLineComments(host.slice(at, at + 900));
    expect(slice).toContain('controller.configFilePath');
    expect(slice).not.toContain('as unknown as');
  });

  it('defaultConfigPath 的三级优先级在注释里写全（防下一个人只按两级去"修"）', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src', 'host', 'mcp-controller.ts'), 'utf8');
    const at = src.indexOf('function defaultConfigPath');
    expect(at).toBeGreaterThanOrEqual(0);
    const slice = src.slice(at, src.indexOf('}', at));
    expect(slice).toContain('STUDIO_MCP_CONFIG');
    expect(slice).toContain('STUDIO_CONFIG_DIR');
  });
});
