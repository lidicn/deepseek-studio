/**
 * QD-R3 复现件（标的 = HEAD `dcedede`，2026-10-22）。
 *
 * 运行方式（vitest include 只认 tests/desktop 与 tests/e2e）：
 *   在 **纯 HEAD 副本树** 的 tests/desktop/ 下运行：
 *     git archive HEAD | tar -x -C <copy-tree>
 *     cp docs/审计报告/QD/复现用例/qd-r3-repro.test.ts <copy-tree>/tests/desktop/zz-qd-r3-repro.test.ts
 *     cd <copy-tree> && npx vitest run tests/desktop/zz-qd-r3-repro.test.ts
 *   最后一次实测（2026-10-22 23:26，HEAD 副本树 E:/NAS/tmp/studio-head-dcedede）：
 *     5 failed | 2 passed (7)，REPRO_RC=1 —— 原始日志见同目录 qd-r3-repro-run.log。
 *
 * 约定：每条 it() 断言「期望的正确行为」——红 = 缺陷复现，绿 = 证伪。
 * 只读：不写被审仓源码；临时目录建在 E:/NAS/tmp 下并在用例尾部清理。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { evaluatePolicy, isFileTool, isProcessTool } from '../../src/host/policy';
import type { WorkspaceContext } from '../../src/host/workspace';
import { mapUpstreamToolInvocation, isSupportedUpstreamTool, SUPPORTED_INVOCATION_NAMES } from '../../src/shared/tool-contract';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';
import { listFiles } from '../../src/capabilities/search-files';
import { needsConsent } from '../../src/host/tool-registry';
import { DEFAULT_TOOL_DEFINITIONS } from '../../src/host/tool-definitions';

const WS_ROOT = path.resolve('E:/NAS/tmp/qd-r3-ws');
const ws: WorkspaceContext = {
  root: WS_ROOT,
  contains(target: string): boolean {
    const resolved = path.resolve(target);
    return resolved === WS_ROOT || resolved.startsWith(WS_ROOT + path.sep);
  },
  resolveWithin(target: string): string | null {
    const resolved = path.resolve(target);
    return this.contains(resolved) ? resolved : null;
  },
};

describe('QD-R3-01 search_files: model-reachable but policy not-governed', () => {
  it('A. model surface reaches search_files (parser + gate + mapping)', () => {
    expect(isSupportedUpstreamTool('search_files')).toBe(true);
    expect(SUPPORTED_INVOCATION_NAMES).toContain('search_files');
    const p = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
    const r = p.feed('<search_files>{"operation":"list","root":"E:/"}</search_files>');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].invocationName).toBe('search_files');
    const mapped = mapUpstreamToolInvocation('search_files', r.calls[0].params);
    expect(mapped?.id).toBe('search_files');
    expect(mapped?.params.root).toBe('E:/');
  });

  it('B. workspace mode must deny an outside root [expected deny; reproduces if not]', () => {
    const verdict = evaluatePolicy({
      tool: 'search_files',
      params: { operation: 'list', root: 'E:/' },
      mode: 'workspace',
      workspace: ws,
    });
    expect(verdict.decision).toBe('deny');
  });

  it('C. capability actually lists an outside directory (no workspace knowledge)', async () => {
    const outside = path.join('E:/NAS/tmp', `qd-r3-outside-${process.pid}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'TOKEN=repro\n');
    try {
      const r = await listFiles({ root: outside, recursive: true, limit: 10 });
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r.data)).toContain('secret.txt');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('D1. dispatch policy-gate predicate is false for search_files [expected true; reproduces if not]', () => {
    const name = mapUpstreamToolInvocation('search_files', { root: 'E:/' })?.id ?? '';
    expect(name).toBe('search_files');
    // desktop-host.ts:1218 `if (isFileTool(name) || isProcessTool(name))` — 两个都为 false 则
    // 整段策略闸门（evaluatePolicy + routeConsent）被跳过。
    expect(isFileTool(name) || isProcessTool(name)).toBe(true);
  });

  it('D2. search_files def risk must be consent-bearing [expected privileged; reproduces if not]', () => {
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'search_files');
    expect(def?.risk).toBe('privileged');
  });

  it('D3. consent threshold must demand consent for a read-risk host tool [expected true; reproduces if not]', () => {
    expect(needsConsent({ risk: 'read' })).toBe(true);
  });
});

describe('QD-R3-02 committed prompt catalog vs model table', () => {
  it('E. every model-reachable name must be advertised in TOOL_CAPABILITY_PROMPT', async () => {
    const src = await fs.readFile('src/inject/main-world-interceptor.ts', 'utf-8');
    // 点号键是下划线工具的别名，prompt 用下划线形式声明即可；只断言各规范名。
    const missing = SUPPORTED_INVOCATION_NAMES.filter(
      (name) => !name.includes('.') && !src.includes(`- ${name} —`),
    );
    expect(missing).toEqual([]);
  });
});
