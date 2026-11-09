// @vitest-environment node
/**
 * tests/desktop/mcp-cwd-source-parity.test.ts —— K2·#49 的**同源锁**（第 4 枚）。
 *
 * ── 为什么要有它 ──
 * #49 的缺口不是"策略层看不到嵌套 `config.cwd`"这么简单，而是：
 * **能力层（`mcp-controller.ts` 的 `spawn(cmd, args, { cwd: config.cwd })`）一直在用这个 cwd，
 * 策略层却只读顶层。** 命令可见、落点不可见。
 *
 * 修法（B 案）把策略层拉到与能力层同源。但**同源是两处代码的性质**，不是一处：
 * 将来谁只改策略层（或只改能力层），这枚锁必须红——否则我们又回到"同一个 `config`
 * 里一个字段参与判定、另一个不参与"的老形状。
 *
 * 本文件锁三件事：
 *   ① 策略层确实读 `config.cwd`（行为级，用 `evaluatePolicy` 真跑）；
 *   ② 能力层的 spawn 落点确实取自 `config.cwd`（**读源码定位**，因为它是 spawn 参数，
 *      行为级验证会真起子进程、把测试变成"能不能 spawn"的环境依赖）；
 *   ③ 两处的**取值表达式形状一致**（都从 `config` 取 `cwd`），且策略层另有顶层回退。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluatePolicy } from '../../src/host/policy';
import { createWorkspace } from '../../src/host/workspace';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTROLLER = path.join(REPO_ROOT, 'src', 'host', 'mcp-controller.ts');
const HOST = path.join(REPO_ROOT, 'src', 'host', 'desktop-host.ts');
const POLICY = path.join(REPO_ROOT, 'src', 'host', 'policy.ts');

const WS_ROOT = 'C:/ws/mcp-parity';
const outside = 'C:/outside-parity';

function policy(tool: string, params: Record<string, unknown>) {
  return evaluatePolicy({ tool, params, mode: 'auto', workspace: createWorkspace(WS_ROOT) });
}

describe('① 策略层读 config.cwd（行为级）', () => {
  it('mcp.test：区外 config.cwd ⇒ require-consent 且 outside', () => {
    const v = policy('mcp.test', { config: { command: 'npm test', cwd: outside } });
    expect(v.decision).toBe('require-consent');
    expect(v.outside).toBe(true);
  });

  it('mcp.test：区内 config.cwd ⇒ 不越界', () => {
    const v = policy('mcp.test', { config: { command: 'npm test', cwd: `${WS_ROOT}/a` } });
    expect(v.outside).not.toBe(true);
  });

  it('顶层 cwd 仍然优先（旧形状不回归）', () => {
    const v = policy('mcp.test', { config: { command: 'npm test', cwd: `${WS_ROOT}/a` }, cwd: outside });
    expect(v.outside).toBe(true);
  });
});

describe('② 能力层 spawn 落点取自 config.cwd（源码定位）', () => {
  it('mcp-controller 的两处 spawn 都用 config.cwd 作为 cwd', () => {
    const src = readFileSync(CONTROLLER, 'utf8');
    // spawn(config.command, …, { … cwd: config.cwd, … }) —— 两处（testConnection 与真实连接）
    const matches = src.match(/cwd:\s*config\.cwd/g) ?? [];
    expect(matches.length, 'mcp-controller 里应有 2 处 spawn 使用 config.cwd').toBeGreaterThanOrEqual(2);
  });

  it('desktop-host 把 params.config.cwd 原样递给 controller（不重命名、不丢）', () => {
    const src = readFileSync(HOST, 'utf8');
    const matches = src.match(/cwd:\s*typeof config\.cwd === 'string' \? config\.cwd : undefined/g) ?? [];
    // mcp.test 与 mcp.save 各一处
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('③ 两侧同源（策略层从同一个 config 取 cwd）', () => {
  it('策略层用的是嵌套 config 读取（不是另造一套字段名）', () => {
    const src = readFileSync(POLICY, 'utf8');
    // 判据：cwd 那一行同时含顶层与嵌套两条读法
    const line = src
      .split('\n')
      .find((l) => l.includes('const cwd =') && l.includes('firstString'));
    expect(line, '策略层必须有一行 `const cwd = …`').toBeDefined();
    expect(line as string, '必须含顶层读取').toContain("firstString(params, ['cwd', 'workdir'])");
    expect(line as string, '必须含嵌套读取（#49 的核心）').toContain('nestedConfigString');
  });

  it('负控的形态说明：只读顶层会漏掉嵌套 cwd（回退即红）', () => {
    // 这枚不是断言某个常量，而是把"为什么必须两处都读"写成可执行说明：
    // 若把 policy 那行改回只看顶层，上面 '① 策略层读 config.cwd' 的两枚会立刻红。
    const v = policy('mcp.test', { config: { command: 'npm test', cwd: outside } });
    expect(v.outside, '嵌套 cwd 必须被看见').toBe(true);
  });
});
