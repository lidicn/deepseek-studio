// @vitest-environment node
/**
 * C1 P1 安全批 · TD-01：search_files 必须受工作区边界约束。
 *
 * ── 缺陷（审计 TD-01，PM 核实成立）──
 *
 * `search_files` 的 `root` 参数**直通未校验**（`resolveRoot` 只校验
 * 「非空 / 绝对 / 存在 / 是目录」），而工具定义的 `approvalClass` 是
 * `'none'`（**零审批**）→ 模型只要给出 `root: "C:\\Users\\xxx"`，
 * 就能把工作区外的目录树与文件内容列出来（越界搜盘）。
 *
 * ── 本文件的断言口径 ──
 *
 * 1. **能力侧**：工作区外的 root → `outside-workspace`（不再返回条目）。
 * 2. **能力侧**：工作区未配置 → `missing-argument`（与 file.ts 同款口径：
 *    「能力不可用」≠「用户越界」）。
 * 3. **档位侧**：search_files 纳入策略治理（不再落到 `not-governed allow`）。
 * 4. **接线侧**：工具层必须把 workspace 传进能力（root 直通的那条路已被堵）。
 */

import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { grepFiles, listFiles } from '../../src/capabilities/search-files';
import { createWorkspace } from '../../src/host/workspace';
import { evaluatePolicy, isSearchTool } from '../../src/host/policy';

const roots: string[] = [];

function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'td01-'));
  roots.push(r);
  return r;
}

afterAll(() => {
  for (const r of roots) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

describe('TD-01 · 能力侧：工作区外的 root 被拒', () => {
  it('工作区外的 root → outside-workspace（list）', async () => {
    const ws = createWorkspace(mkRoot());
    const outside = mkRoot();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET_PASSWORD=12345');

    const res = await listFiles({ root: outside, workspace: ws });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('outside-workspace');
  });

  it('工作区外的 root → outside-workspace（grep），且读不到外部内容', async () => {
    const ws = createWorkspace(mkRoot());
    const outside = mkRoot();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET_PASSWORD=12345');

    const res = await grepFiles({ root: outside, workspace: ws, query: 'SECRET_PASSWORD' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('outside-workspace');
  });

  it('工作区内的 root 正常检索（不误伤）', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello world');
    const ws = createWorkspace(root);

    const list = await listFiles({ root, workspace: ws });
    expect(list.ok).toBe(true);
    const data = list.data as { entries: Array<{ path: string }> };
    expect(data.entries.some((e) => e.path === 'a.txt')).toBe(true);

    const grep = await grepFiles({ root, workspace: ws, query: 'hello' });
    expect(grep.ok).toBe(true);
    const g = grep.data as { matches: Array<{ file: string }> };
    expect(g.matches.some((m) => m.file === 'a.txt')).toBe(true);
  });

  it('工作区未配置（workspace=null）→ missing-argument（能力不可用，不是越界）', async () => {
    const root = mkRoot();
    const res = await listFiles({ root, workspace: null });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing-argument');
  });

  it('未传 workspace（undefined）→ 不施加约束（模块通用用法保持不变）', async () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    const res = await listFiles({ root });
    expect(res.ok).toBe(true);
    const data = res.data as { entries: Array<{ path: string }> };
    expect(data.entries.some((e) => e.path === 'a.txt')).toBe(true);
  });

  it('工作区子目录在区内 → 放行', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'world');
    const ws = createWorkspace(root);
    const res = await listFiles({ root: path.join(root, 'sub'), workspace: ws });
    expect(res.ok).toBe(true);
  });
});

describe('TD-01 · 档位侧：search_files 纳入策略治理', () => {
  it('search_files 被识别为受治理的检索工具', () => {
    expect(isSearchTool('search_files')).toBe(true);
    expect(isSearchTool('file.read')).toBe(false);
  });

  it('区内 root → allow（不再落到 not-governed）', () => {
    const root = mkRoot();
    const ws = createWorkspace(root);
    const v = evaluatePolicy({ tool: 'search_files', params: { root }, mode: 'auto', workspace: ws });
    expect(v.decision).toBe('allow');
    expect(v.reason).toBe('inside-workspace');
  });

  it('区外 root → auto 档 require-consent（要问用户）', () => {
    const ws = createWorkspace(mkRoot());
    const outside = mkRoot();
    const v = evaluatePolicy({ tool: 'search_files', params: { root: outside }, mode: 'auto', workspace: ws });
    expect(v.decision).toBe('require-consent');
    expect(v.reason).toBe('outside-workspace');
  });

  it('区外 root → workspace 档 deny（该档位的承诺就是「不越界」）', () => {
    const ws = createWorkspace(mkRoot());
    const outside = mkRoot();
    const v = evaluatePolicy({ tool: 'search_files', params: { root: outside }, mode: 'workspace', workspace: ws });
    expect(v.decision).toBe('deny');
    // 审计 TD-01 的验收判据原文：越界的 reason 是 outside-workspace
    expect(v.reason).toBe('outside-workspace');
  });

  it('工作区未配置 → deny（fail-closed）', () => {
    const v = evaluatePolicy({ tool: 'search_files', params: { root: mkRoot() }, mode: 'auto', workspace: null });
    expect(v.decision).toBe('deny');
    expect(v.reason).toBe('workspace-unconfigured');
  });
});

describe('TD-01 · 契约：审批档位与规范目标', () => {
  it('search_files 的 approvalClass 是 mode（不再是零审批的 none）', async () => {
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'search_files')!;
    expect(def.approvalClass).toBe('mode');
    // mode 类必须绑定规范目标，否则 grant 无从精确命中
    expect(def.canonicalTargetKind).toBe('search-root');
  });

  it('canonicalTarget 绑定被检索的 root（换目录 = 换目标）', async () => {
    const { canonicalTargetOf } = await import('../../src/host/authorization');
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'search_files')!;
    const a = canonicalTargetOf(def, { root: 'C:/proj/a' }).target;
    const b = canonicalTargetOf(def, { root: 'C:/proj/b' }).target;
    expect(a).not.toBe(b);
    expect(a).toBe('c:/proj/a');
  });
});

describe('TD-01 · 接线侧：工具层必须传 workspace', () => {
  it('宿主真实调用 search_files 越界 root → 被拒（root 直通的那条路已被堵）', async () => {
    const { createDesktopHost } = await import('../../src/host/desktop-host');
    const wsRoot = mkRoot();
    const outside = mkRoot();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET_PASSWORD=12345');

    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(wsRoot),
      // full 档：策略层不会拦（越界在能力层与档位层之外也不该被 full 静默放行），
      // 因此这条用例证明的是**能力层**的约束确实生效。
      policyMode: 'full',
    });
    await host.start();
    try {
      const res = await host.invokeTool('search_files', { operation: 'list', root: outside });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('outside-workspace');
      // 越界内容不得出现在结果里
      expect(JSON.stringify(res.data ?? {})).not.toContain('SECRET_PASSWORD');
    } finally {
      await host.stop();
    }
  });

  it('宿主真实调用 search_files 区内 root → 正常列出（不误伤）', async () => {
    const { createDesktopHost } = await import('../../src/host/desktop-host');
    const wsRoot = mkRoot();
    fs.writeFileSync(path.join(wsRoot, 'a.txt'), 'hello');

    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(wsRoot),
      policyMode: 'full',
    });
    await host.start();
    try {
      const res = await host.invokeTool('search_files', { operation: 'list' });
      expect(res.ok).toBe(true);
      const data = res.data as { entries: Array<{ path: string }> };
      expect(data.entries.some((e) => e.path === 'a.txt')).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it('审计 TD-01 验收判据：workspace 档越界 → error=outside-workspace 且审计 outcome=policy-denied', async () => {
    const { createDesktopHost } = await import('../../src/host/desktop-host');
    const wsRoot = mkRoot();
    const outside = mkRoot();

    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(wsRoot),
      policyMode: 'workspace',
    });
    await host.start();
    try {
      const res = await host.invokeTool('search_files', { operation: 'list', root: outside });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('outside-workspace');
      const rec = host.audit.list().filter((r) => r.tool === 'search_files').at(-1);
      expect(rec?.outcome).toBe('policy-denied');
    } finally {
      await host.stop();
    }
  });
});
