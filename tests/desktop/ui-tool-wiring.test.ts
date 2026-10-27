/**
 * E1：页端直调宿主的工具名必须「三处一致」的静态守卫。
 *
 * 背景（2026-10-26 线上故障）：`9d093dc` 把点号形式的工具名从模型表移除（方向正确：
 * 不能让模型直调宿主 id），但漏了把它们迁进 UI_ONLY_TOOLS。结果 UI / interceptor
 * 直调的 `mcp.list` / `shell.exec` / `file.read` 在 `mapUpstreamToolInvocation` 返回
 * null，被回执 `unknown-tool`——MCP 工具目录连续 10 次加载失败、技能面板「在文件夹中
 * 显示」与「查看 SKILL.md」整条不可达。这类「定义了 ≠ 接上了」的缺陷单测盖不住，
 * 因为它横跨三个真源：src/ui|src/inject 的调用点、shared/tool-contract 的映射表、
 * host 侧的登记表与能力实现。
 *
 * 本测试把「调用点清单」变成可编程查询：扫源码得到所有直调名，逐个断言可达。
 * 任何一处名字改了/删了/漏登记，这里立刻红。
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  MODEL_INVOCATION_DECLARED_NAMES,
  SUPPORTED_INVOCATION_NAMES,
  UI_ONLY_INVOCATION_NAMES,
  isSupportedUpstreamTool,
  mapUpstreamToolInvocation,
} from '../../src/shared/tool-contract';
import { DEFAULT_TOOL_DEFINITIONS } from '../../src/host/tool-definitions';

const DEF_IDS = new Set(DEFAULT_TOOL_DEFINITIONS.map((d) => d.id));

/** desktop-host 内联宿主能力表里的 id（`'x.y': { id: 'x.y',` 形态）。 */
const HOST_INLINE_IDS = (() => {
  const src = readFileSync(path.join(repoRoot(), 'src/host/desktop-host.ts'), 'utf8');
  const ids = new Set<string>();
  const re = /'([a-z0-9_.]+)':\s*\{\s*id:\s*'\1'/g;
  for (const m of src.matchAll(re)) ids.add(m[1]);
  return ids;
})();

function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'package.json')) && existsSync(path.join(cwd, 'src/host/desktop-host.ts'))) {
    return cwd;
  }
  // vitest 以仓库根为 cwd 启动；命中不了说明运行环境异常，直接失败而不是猜路径。
  throw new Error(`cannot locate repo root from cwd=${cwd}`);
}

/** 递归收集 src 下的非测试 .ts 文件。 */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      collectSources(p, acc);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

type CallSite = { name: string; file: string; via: 'callHostTool' | 'sender' };

/**
 * 扫描所有页端 → 宿主的直调点。两种写法都要覆盖：
 *  - UI 组件：callHostTool('name', …)
 *  - 注入层：sender({ …, invocationName: 'name', … })
 */
function scanDirectCalls(): CallSite[] {
  const files = collectSources(path.join(repoRoot(), 'src'));
  const found: CallSite[] = [];
  for (const f of files) {
    const rel = path.relative(repoRoot(), f).replace(/\\/g, '/');
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/callHostTool\(\s*['"]([^'"]+)['"]/g)) {
      found.push({ name: m[1], file: rel, via: 'callHostTool' });
    }
    for (const m of text.matchAll(/invocationName:\s*['"]([^'"]+)['"]/g)) {
      found.push({ name: m[1], file: rel, via: 'sender' });
    }
  }
  return found;
}

const calls = scanDirectCalls();
const uniqueNames = [...new Set(calls.map((c) => c.name))].sort();

describe('E1 页端直调工具名接线守卫', () => {
  it('扫描到直调点（防止正则失效导致守卫静默通过）', () => {
    expect(calls.length).toBeGreaterThan(10);
    // 这三处是 2026-10-26 故障的当事调用点，必须仍被扫到。
    const names = new Set(calls.map((c) => c.name));
    expect(names.has('mcp.list')).toBe(true);
    expect(names.has('shell.exec')).toBe(true);
    expect(names.has('file.read')).toBe(true);
  });

  it('每个直调名都能经 mapUpstreamToolInvocation 映射（不回执 unknown-tool）', () => {
    const dead = uniqueNames
      .map((n) => ({ n, mapped: mapUpstreamToolInvocation(n, {}) }))
      .filter((x) => !x.mapped)
      .map((x) => `${x.n} ← ${calls.filter((c) => c.name === x.n).map((c) => c.file).join(', ')}`);
    expect(dead, `以下页端直调名未登记进映射表（会回执 unknown-tool）:\n${dead.join('\n')}`).toEqual([]);
  });

  it('每个直调名映射后的 id 都有宿主实现（登记表 + 宿主能力表）', () => {
    const missing: string[] = [];
    for (const n of uniqueNames) {
      const mapped = mapUpstreamToolInvocation(n, {});
      if (!mapped) continue; // 上一条用例已报
      const hasDef = DEF_IDS.has(mapped.id);
      const hasExec = HOST_INLINE_IDS.has(mapped.id);
      // 页端执行侧（DOM 能力，如 shell.exec 无页时回退 Node 能力）也允许只在登记表出现。
      if (!hasDef) missing.push(`${n} → ${mapped.id}: 未登记进 DEFAULT_TOOL_DEFINITIONS`);
      else if (!hasExec && !DEF_IDS.has(mapped.id)) missing.push(`${n} → ${mapped.id}: 无宿主实现`);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('宿主 RPC 类直调名绝不进模型面（模型不得直调 settings.get / memory.purge 等）', () => {
    const hostRpcLike = uniqueNames.filter((n) => n.includes('.'));
    const leaked = hostRpcLike.filter((n) => SUPPORTED_INVOCATION_NAMES.includes(n));
    expect(leaked, `点号形式的宿主 RPC 泄漏进模型可调表: ${leaked.join(', ')}`).toEqual([]);
    // 交叉校验：模型面声明名集合与映射表模型段一致（GAP-1 同源防线）。
    expect([...MODEL_INVOCATION_DECLARED_NAMES].sort()).toEqual([...SUPPORTED_INVOCATION_NAMES].sort());
  });

  // ===== T2: memory 工具集存在性守卫 =====
  it('M10 完整记忆工具集均已登记进 DEFAULT_TOOL_DEFINITIONS（7 个）', () => {
    const ALL_MEMORY_IDS = [
      'memory.save', 'memory.delete', 'memory.list', 'memory.listArchived',
      'memory.unarchive', 'memory.purge', 'memory.select',
    ];
    const missing = ALL_MEMORY_IDS.filter((id) => !DEF_IDS.has(id));
    expect(missing, `memory 工具未在 DEFAULT_TOOL_DEFINITIONS 注册: ${missing.join(', ')}`).toEqual([]);
  });

  it('memory 只读/删/归档工具全在 UI_ONLY_TOOLS（agent 可见集只保留 memory.save）', () => {
    // memory.save 是唯一对 agent 开放的记忆工具（模型通过 memory_save 下划线名调用）；
    // delete/purge/unarchive 是高危，list/listArchived 是 UI 内部，select 是页面选择器——
    // 它们全应被排除在 SUPPORTED_INVOCATION_NAMES 之外。
    const AGENT_CLOSED = [
      'memory.delete', 'memory.list', 'memory.listArchived', 'memory.unarchive', 'memory.purge', 'memory.select',
    ];
    for (const id of AGENT_CLOSED) {
      expect(SUPPORTED_INVOCATION_NAMES, `${id} 不应出现在 agent 可见集`).not.toContain(id);
      expect(UI_ONLY_INVOCATION_NAMES, `${id} 应为 UI_ONLY`).toContain(id);
    }
    expect(isSupportedUpstreamTool('memory_save')).toBe(true); // 下划线形式可达
  });
});
