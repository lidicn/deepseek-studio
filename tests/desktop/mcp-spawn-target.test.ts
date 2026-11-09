// @vitest-environment node
/**
 * tests/desktop/mcp-spawn-target.test.ts —— K7 的落点锁（2026-11-09）。
 *
 * ── 为什么要有它 ──
 * #49 修好了 `mcp.test` 的 `config.cwd` 越界判定，但 `mcp.call`／`mcp.save` 两枚仍是洞：
 * 落点在**已持久化／将要持久化的配置**里，不在调用参数里，于是
 * **`mcp.call` 问是问的、但问询里看不见 spawn 到哪儿；`mcp.save` 保存时根本不问落点。**
 *
 * K7 把「判定输入的落点 ＝ 能力层实际 spawn 的落点」（同源不变量）扩到这两枚。
 * 本文件锁的是这条不变量的**四条边**：
 *   ① `resolveSpawnTarget` 是纯函数（不 import controller、不自取配置）；
 *   ② host 侧两个调用点各自给对"哪一份配置"（`mcp.call`→已存；`mcp.save`→要存的）；
 *   ③ `spawnCwd` **不泄进** grant / 授权输入（否则审计里的 `canonicalTarget` 会指错目标）；
 *   ④ **顶层 `cwd` 不得参与判定**（`params.cwd` 是调用方可写的，顶层优先会被利用）。
 *
 * ── 锁写法纪律（今日立的判据，见 `mcp-cwd-source-parity.test.ts` L66 的反面教材）──
 * 只锁**短标识符**、且锁在**所属处理段/函数体内**；不锁整行表达式（等价改写会假红），
 * 也不锁全文件计数（别人写一处就假绿）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluatePolicy } from '../../src/host/policy';
import { createWorkspace } from '../../src/host/workspace';
import { buildPolicyParams, resolveSpawnTarget } from '../../src/host/mcp-spawn-target';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST = path.join(REPO_ROOT, 'src', 'host', 'desktop-host.ts');
const POLICY = path.join(REPO_ROOT, 'src', 'host', 'policy.ts');
const SPAWN_TARGET = path.join(REPO_ROOT, 'src', 'host', 'mcp-spawn-target.ts');

const WS_ROOT = 'C:/ws/k7';
const OUTSIDE = 'C:/outside-k7';

/** 取某个工具 handler 的实现片段：从 `'mcp.xxx': {` 到下一个 `'mcp.` 之间。 */
function handlerSlice(src: string, tool: string): string {
  const start = src.indexOf(`'${tool}': {`);
  expect(start, `找不到 ${tool} 的处理段`).toBeGreaterThanOrEqual(0);
  const nextIdx = src.indexOf("'mcp.", start + 10);
  return nextIdx === -1 ? src.slice(start) : src.slice(start, nextIdx);
}

function evaluate(params: Record<string, unknown>, mode: 'auto' | 'ask' | 'full' | 'workspace' = 'auto', tool = 'mcp.call') {
  return evaluatePolicy({ tool, params, mode, workspace: createWorkspace(WS_ROOT) });
}

describe('① resolveSpawnTarget 是纯解析（不吃 controller、不自取配置）', () => {
  it('有 cwd ⇒ source=config，值原样返回', () => {
    expect(resolveSpawnTarget({ cwd: OUTSIDE })).toEqual({ cwd: OUTSIDE, source: 'config' });
  });

  it('没有 cwd 键 ⇒ source=none、cwd=null', () => {
    expect(resolveSpawnTarget({})).toEqual({ cwd: null, source: 'none' });
    expect(resolveSpawnTarget(null)).toEqual({ cwd: null, source: 'none' });
    expect(resolveSpawnTarget(undefined)).toEqual({ cwd: null, source: 'none' });
  });

  it('空串不算"没写"：如实报 config（否则判定值与实际落点分叉）', () => {
    expect(resolveSpawnTarget({ cwd: '' })).toEqual({ cwd: '', source: 'config' });
  });

  it('源模块不 import controller（否则"内部绝不自取配置"没法靠读源码锁住）', () => {
    const src = readFileSync(SPAWN_TARGET, 'utf8');
    // 只看 import 行：注释里提到 `mcp-controller` 是在解释"为什么不能引"，不算违规
    const imports = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) || /\brequire\(/.test(l))
      .join('\n');
    expect(imports).not.toContain('mcp-controller');
    expect(imports).not.toContain('getMcpController');
    // 纯函数还得不碰 fs / env
    expect(imports).not.toContain("node:fs");
    expect(src).not.toContain('process.env');
  });
});

describe('② host 侧两个调用点各给对"哪一份配置"（段内短标识符）', () => {
  it('mcp.call 的落点解析源自"已存配置"（getServerConfig）', () => {
    const host = readFileSync(HOST, 'utf8');
    // 解析点不在 handler 里，而在授权管线内：取整个文件里的解析段
    const at = host.indexOf('safeMcpServerConfig(String(paramsBag.serverId');
    expect(at, 'mcp.call 的落点必须由 getServerConfig 解析').toBeGreaterThanOrEqual(0);
    const fn = host.indexOf('function safeMcpServerConfig');
    expect(fn).toBeGreaterThanOrEqual(0);
    const fnBody = host.slice(fn, host.indexOf('\n}', fn) + 2);
    expect(fnBody).toContain('getServerConfig');
  });

  it('mcp.save 的落点解析源自"本次要存的配置"（paramsBag.config）', () => {
    const host = readFileSync(HOST, 'utf8');
    const at = host.indexOf("name === 'mcp.save'");
    expect(at).toBeGreaterThanOrEqual(0);
    const slice = host.slice(at, at + 200);
    expect(slice).toContain('paramsBag.config');
  });

  it('解析发生在授权管线内、evaluatePolicy 之前（不是 handler 里）', () => {
    const host = readFileSync(HOST, 'utf8');
    const resolveAt = host.indexOf('const spawnTarget = resolveSpawnTarget(');
    const policyAt = host.indexOf('? evaluatePolicy({');
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(policyAt).toBeGreaterThanOrEqual(0);
    // 解析必须先于策略判定——否则策略层永远看不到 spawnCwd（静默无效改动）
    expect(resolveAt).toBeLessThan(policyAt);
    // 且 handler 段（mcp.call 的 execute）里不出现 spawnCwd 赋值
    const callHandler = handlerSlice(host, 'mcp.call');
    expect(callHandler).not.toContain('spawnCwd');
  });
});

describe('③ spawnCwd 不泄进 grant / 授权输入（防审计 canonicalTarget 指错目标）', () => {
  it('lookupGrant / resolveAuthorization 的入参仍是原 paramsBag（段内不含 spawnCwd）', () => {
    const host = readFileSync(HOST, 'utf8');
    // 两者都在授权判定段内：从 paramsBag 定义到 resolveAuthorization 结束
    const from = host.indexOf('const paramsBag = (params ?? {})');
    const to = host.indexOf('const auth = resolveAuthorization({');
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    const authSlice = host.slice(to, host.indexOf('});', to));
    expect(authSlice).toContain('params: paramsBag');
    expect(authSlice).not.toContain('spawnCwd');
    // grant 查找同样吃原对象
    const grantAt = host.indexOf('grant: lookupGrant(');
    expect(grantAt).toBeGreaterThan(from);
    expect(host.slice(grantAt, grantAt + 120)).not.toContain('spawnCwd');
  });

  it('routeExecution 拿到的仍是原 params（能力层不因判定多出字段）', () => {
    const host = readFileSync(HOST, 'utf8');
    const at = host.indexOf('routeExecution(def, name, params,');
    expect(at).toBeGreaterThanOrEqual(0);
  });
});

describe('③b buildPolicyParams：剔除而非覆盖（硬约束第 4 条）', () => {
  const bag = { serverId: 's1', tool: 't', args: { a: 1 } };

  it('顶层 cwd / workdir 被剔除，spawnCwd 是唯一落点来源', () => {
    const out = buildPolicyParams('mcp.call', { ...bag, cwd: `${WS_ROOT}/sub`, workdir: `${WS_ROOT}/w` }, {
      cwd: OUTSIDE,
      source: 'config',
    });
    expect('cwd' in out).toBe(false);
    expect('workdir' in out).toBe(false);
    expect(out.spawnCwd).toBe(OUTSIDE);
    // 其它字段原样保留（判定要用 serverId/args 之外的东西时才不会丢）
    expect(out.serverId).toBe('s1');
    expect(out.args).toEqual({ a: 1 });
  });

  it('不改动入参对象本身（paramsBag 与 params 是同一个对象）', () => {
    const src = { ...bag, cwd: `${WS_ROOT}/sub` };
    const before = JSON.stringify(src);
    buildPolicyParams('mcp.call', src, { cwd: OUTSIDE, source: 'config' });
    expect(JSON.stringify(src)).toBe(before);
  });

  it('只给 mcp.call / mcp.save 加 spawnCwd；python.exec 等不加', () => {
    for (const tool of ['mcp.call', 'mcp.save']) {
      expect(buildPolicyParams(tool, bag, { cwd: OUTSIDE, source: 'config' }).spawnCwd).toBe(OUTSIDE);
    }
    for (const tool of ['python.exec', 'shell.exec', 'file.write']) {
      expect('spawnCwd' in buildPolicyParams(tool, bag, { cwd: OUTSIDE, source: 'config' })).toBe(false);
    }
  });

  it('★ 端到端：伪装负控穿过 buildPolicyParams 后仍被判越界（不只是 evaluatePolicy 认这个字段）', () => {
    // 这枚是本文件**最要紧的**一枚：上面 ④ 那几枚只证明 `evaluatePolicy` 认 `spawnCwd`，
    // 若 host 侧根本没接线（不塞 spawnCwd / 用浅拷贝把顶层 cwd 带进来），它们**全都是绿的**。
    // 第一版本文件正是栽在这里——红态探针把 host 的注入改成恒 false，18 枚全绿。
    const params = buildPolicyParams(
      'mcp.call',
      { serverId: 's1', tool: 't', cwd: `${WS_ROOT}/sub` }, // 调用方伪造的区内 cwd
      { cwd: OUTSIDE, source: 'config' }, // 真实落点（持久化配置里）
    );
    const v = evaluatePolicy({
      tool: 'mcp.call',
      params,
      mode: 'auto',
      workspace: createWorkspace(WS_ROOT),
    });
    expect(v.decision).toBe('require-consent');
    expect(v.outside).toBe(true);
  });
});

describe('③c 接线锁：host 必须真的用 buildPolicyParams（行为级测不到这一层）', () => {
  it('evaluatePolicy 的入参对象来自 buildPolicyParams，不是浅拷贝', () => {
    const host = readFileSync(HOST, 'utf8');
    const buildAt = host.indexOf('const policyParams: Record<string, unknown> = buildPolicyParams(');
    expect(buildAt, 'host 必须经 buildPolicyParams 构造判定用对象').toBeGreaterThanOrEqual(0);
    const useAt = host.indexOf('params: policyParams', buildAt);
    expect(useAt, 'params 必须传 policyParams（不是 paramsBag）').toBeGreaterThan(buildAt);
    // 反向：不得出现"浅拷贝 + 加 spawnCwd"的**代码**写法（注释里解释"为什么不能这么写"不算违规）
    const codeOnly = host
      .split('\n')
      .map((l) => (l.trimStart().startsWith('//') || l.trimStart().startsWith('*') ? '' : l))
      .join('\n');
    expect(codeOnly).not.toContain('...paramsBag, spawnCwd');
  });

  it('其余消费者仍吃原 paramsBag（多一个字段会改 grant key / 审计 canonicalTarget）', () => {
    const host = readFileSync(HOST, 'utf8');
    for (const marker of ['checkHardDeny(name, paramsBag', 'whitelistHit(name, paramsBag', 'lookupGrant(name, paramsBag']) {
      expect(host, `应继续吃原对象：${marker}`).toContain(marker);
    }
  });
});

describe('④ 顶层 cwd 不得参与判定（调用方可写，顶层优先会被利用）', () => {  it('spawnCwd 区外 ⇒ require-consent 且 outside（auto 档）', () => {
    const v = evaluate({ serverId: 's1', spawnCwd: OUTSIDE });
    expect(v.decision).toBe('require-consent');
    expect(v.outside).toBe(true);
  });

  it('spawnCwd 区内 ⇒ 不产生越界询问', () => {
    const v = evaluate({ serverId: 's1', spawnCwd: `${WS_ROOT}/sub` });
    expect(v.outside).not.toBe(true);
  });

  it('伪装负控：顶层 cwd 指区内 + spawnCwd 指区外 ⇒ 仍越界（顶层不得覆盖解析结果）', () => {
    const v = evaluate({ serverId: 's1', cwd: `${WS_ROOT}/sub`, spawnCwd: OUTSIDE });
    expect(v.decision).toBe('require-consent');
    expect(v.outside).toBe(true);
  });

  it('反向负控：顶层 cwd 指区外 + spawnCwd 指区内 ⇒ 不得判越界', () => {
    const v = evaluate({ serverId: 's1', cwd: OUTSIDE, spawnCwd: `${WS_ROOT}/sub` });
    expect(v.outside).not.toBe(true);
  });

  it('没有 spawnCwd 时两枚 MCP 工具落回原口径（不新造判定）', () => {
    const call = evaluate({ serverId: 's1' });
    expect(call.outside).not.toBe(true);
    const save = evaluate({ serverId: 's1', config: { command: 'x' } }, 'auto', 'mcp.save');
    expect(save.outside).not.toBe(true);
  });

  it('python.exec（在 EXECUTION_TOOLS 里但无 spawnCwd）逐字不变：被条件本身排除', () => {
    const autoClean = evaluatePolicy({
      tool: 'python.exec',
      params: { code: 'print(1)' },
      mode: 'auto',
      workspace: createWorkspace(WS_ROOT),
    });
    expect(autoClean).toEqual({ decision: 'allow', reason: 'not-governed' });

    // 带风险代码 ⇒ 仍按 python.exec 自己的分支走 require-consent
    const autoRisky = evaluatePolicy({
      tool: 'python.exec',
      params: { code: 'shutil.rmtree("x")' },
      mode: 'auto',
      workspace: createWorkspace(WS_ROOT),
    });
    expect(autoRisky.decision).toBe('require-consent');
    expect(autoRisky.reason).toBe('risk-detected');

    // full 档 ⇒ allow + riskFlags 如实记录（原口径）
    const fullRisky = evaluatePolicy({
      tool: 'python.exec',
      params: { code: 'shutil.rmtree("x")' },
      mode: 'full',
      workspace: createWorkspace(WS_ROOT),
    });
    expect(fullRisky.decision).toBe('allow');
  });
});

describe('⑤ 策略层只认 spawnCwd（源码形状：不回落到 cwd / workdir / config.cwd）', () => {
  it('K7 分支里读的是 spawnCwd 这一枚', () => {
    const src = readFileSync(POLICY, 'utf8');
    const at = src.indexOf('K7（2026-11-09）');
    expect(at, '策略层应有 K7 分支').toBeGreaterThanOrEqual(0);
    const slice = src.slice(at, src.indexOf("if (tool === 'python.exec')", at));
    expect(slice).toContain("firstString(params, ['spawnCwd'])");
    // 关键：这段里不得出现 cwd/workdir 的回退
    expect(slice).not.toContain("['cwd', 'workdir']");
    expect(slice).not.toContain('nestedConfigString');
  });

  it('workspace 档现有硬拒未被削弱（K7 不改变 workspace 档语义）', () => {
    const v = evaluate({ serverId: 's1', spawnCwd: `${WS_ROOT}/sub` }, 'workspace');
    expect(v.decision).toBe('deny');
    expect(v.reason).toBe('mode-restricted');
  });

  it('full 档：越界落点如实记 outside（交由授权层的 !outsideRequested 决定问不问）', () => {
    const v = evaluate({ serverId: 's1', spawnCwd: OUTSIDE }, 'full');
    expect(v.decision).toBe('allow');
    expect(v.outside).toBe(true);
  });
});
