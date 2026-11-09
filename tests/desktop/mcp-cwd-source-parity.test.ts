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
 *
 * ── 射程声明（#51，2026-11-09，必读）────────────────────────────
 * ⚠️ **本文件只声称「策略层契约」与「能力层源码落点」，不声称授权/策略「管线」行为。**
 * ①③ 用 `evaluatePolicy` **直连策略层**，② 是**读源码**定位；三者都**看不见**
 * 「送到策略层之前字段是否已被删／被改写」这一类失效——#50 第一发闸红正是那种
 * （`buildPolicyParams` 曾对所有工具无条件剔除 `cwd`，本文件的用例全绿而闸红）。
 * ⇒ **管线的证据只在 `tests/desktop/k7-pipeline-injection.test.ts`**
 *   （`createDesktopHost`＋`invokeTool` 真装置）。改授权管线输入对象时，
 *   **必须去那枚文件补锁**，别在本文件里"补到绿"就算完。
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

  it('mcp.test 的顶层 cwd 仍然优先（旧形状不回归）', () => {
    // 本条测的是「顶层优先」这条契约，**只适用 `mcp.test`**——它的 `params.cwd` 就是
    // 调用方要测的那个落点，顶层优先是对的。
    // ⚠️ `mcp.call`／`mcp.save` 的反面锁见 `tests/desktop/mcp-spawn-target.test.ts`
    // （那里要求"顶层 cwd 不得参与判定"，因为这两枚的落点在**持久化配置**里、
    //  而 `params.cwd` 是调用方可写的）。别把本条读成全局契约去"统一" `policy.ts`。
    const v = policy('mcp.test', { config: { command: 'npm test', cwd: `${WS_ROOT}/a` }, cwd: outside });
    expect(v.outside).toBe(true);
  });
});

/** 取 `'tool.name': {` 到下一个同类 handler 键之间的实现片段（锁的射程＝所属处理段）。 */
function handlerSlice(src: string, tool: string): string {
  const keyRe = /^[ \t]*'([a-zA-Z]+\.[a-zA-Z]+)':\s*\{/gm;
  const marks: { idx: number; name: string }[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = keyRe.exec(src)) !== null) marks.push({ idx: mm.index, name: mm[1] });
  const i = marks.findIndex((m) => m.name === tool);
  if (i < 0) throw new Error(`找不到 ${tool} 的处理段`);
  const end = i + 1 < marks.length ? marks[i + 1].idx : src.length;
  return src.slice(marks[i].idx, end);
}

describe('② 能力层 spawn 落点取自 config.cwd（源码定位）', () => {
  it('mcp-controller 的两处 spawn 都用 config.cwd 作为 cwd', () => {
    const src = readFileSync(CONTROLLER, 'utf8');
    // spawn(config.command, …, { … cwd: config.cwd, … }) —— 两处（testConnection 与真实连接）
    const matches = src.match(/cwd:\s*config\.cwd/g) ?? [];
    expect(matches.length, 'mcp-controller 里应有 2 处 spawn 使用 config.cwd').toBeGreaterThanOrEqual(2);
  });

  it('desktop-host 把 params.config.cwd 原样递给 controller（段内短标识符）', () => {
    const src = readFileSync(HOST, 'utf8');
    // ── 锁写法修正（#50，2026-11-09）──
    // 原实现锁的是**整行表达式**
    //   `cwd:\s*typeof config\.cwd === 'string' \? config\.cwd : undefined`
    // 它有两个失效方向：
    //   · 太紧：等价改写（换可选链、三元拆行）就**假红**，下一个人会去"修"断言；
    //   · 太松：写成全文件计数 `≥2` 时，别的 handler 也能满足它（假绿）。
    // 现在只锁**短标识符 `config.cwd`**，且**锁在所属处理段内**——
    // 段外命中不算，段内换写法也不会误红。
    for (const tool of ['mcp.test', 'mcp.save']) {
      const slice = handlerSlice(src, tool);
      expect(slice, `${tool} 段内应把 config.cwd 递给 controller`).toContain('config.cwd');
    }
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
