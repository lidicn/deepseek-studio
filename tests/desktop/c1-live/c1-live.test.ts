/**
 * 卡㉘（2026-11-16，UI）：三项真机取证探针的离线自检（无实例、不建实例，CI 常绿）。
 * 判据与操作见同目录 JUDGE.md；本件锁住：
 *   ① trace-read CLI 三命令（msel/fuse/turns）的判读与退出码（临时根＋fixture，不碰真 trace）；
 *   ② 判据常量漂移锁（trace-read 镜像常量 ↔ shared 阈值 ↔ 注入层预算字面量）；
 *   ③ cdp.mjs 自包含零依赖（注入层自包含教训同款：不得引 npm 包）＋死端口/用法负控。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  TERMINAL_FUSE_THRESHOLD,
  NON_TERMINAL_FUSE_THRESHOLD,
} from '../../../src/shared/continuation-prompt';

const here = dirname(fileURLToPath(import.meta.url));
const traceRead = join(here, 'trace-read.mjs');
const cdp = join(here, 'cdp.mjs');
const fixture = readFileSync(join(here, 'fixtures', 'sample-trace.jsonl'), 'utf8').trim();

function cli(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

let roots: string[] = [];
function freshRoot(name: string, content: string) {
  const root = mkdtempSync(join(tmpdir(), `c1-live-${name}-`));
  roots.push(root);
  const dir = join(root, 'logs', 'trace');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trace-fx.jsonl'), content, 'utf8');
  return root;
}

beforeAll(() => {
  // 基本面：fixture 里 msel 一枚 90ms PASS＋一枚 300ms FAIL ⇒ 整体 FAIL；fuse-terminal 一行 ⇒ FUSE-FIRED；
  // turns 含 stream-error 异常终态 ⇒ ANOMALY。
  freshRoot('basic', fixture);
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('trace-read CLI（离线，临时根）', () => {
  it('1. msel：300ms 行超 120ms 预算 ⇒ MSEL-VERDICT FAIL，exit 1', () => {
    const r = cli(traceRead, ['msel', '--root', roots[0]]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('MSEL seq=1 at=1799900000000 durationMs=90 ok=true count=5 → PASS');
    expect(r.out).toContain('MSEL seq=2 at=1799900001000 durationMs=300 ok=true count=3 → FAIL(over-budget 300ms)');
    expect(r.out).toContain('MSEL-VERDICT FAIL (n=2, over=1)');
  });

  it('2. msel：全 PASS 根 ⇒ exit 0', () => {
    const root = freshRoot('msel-pass', fixture.split('\n')[0]);
    const r = cli(traceRead, ['msel', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('MSEL-VERDICT PASS (n=1, over=0)');
  });

  it('3. fuse：fuse-terminal 行在 ⇒ FUSE-VERDICT FUSE-FIRED，exit 0；sidecar grep 提示在', () => {
    const r = cli(traceRead, ['fuse', '--root', roots[0]]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('FUSE turn=turn-fx-2 axis=terminal count=3 stopReason=fuse-terminal consistent=true');
    expect(r.out).toContain('FUSE-VERDICT FUSE-FIRED (n=1)');
    expect(r.out).toContain('auto-continue fuse');
  });

  it('4. fuse：count=2 终局轴未达阈值 ⇒ FUSE-WARN 负读数（场景未命中≠缺陷）', () => {
    const root = freshRoot(
      'fuse-below',
      [
        '{"t":"continuation.decision","turnId":"t-b","reason":"fuse-terminal","triggered":false,"count":2}',
        '{"t":"turn.end","turnId":"t-b","finished":true,"stopReason":"fuse-terminal"}',
      ].join('\n'),
    );
    const r = cli(traceRead, ['fuse', '--root', root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('FUSE-WARN turn=t-b count=2 < 3（终局轴未达阈值，非熔断）');
  });

  it('5. fuse：窗口无 fuse 行 ⇒ NO-FUSE-IN-WINDOW，exit 4（合法负读数，非失败）', () => {
    const root = freshRoot('fuse-none', '{"t":"turn.end","turnId":"t-x","finished":true,"stopReason":"completed"}\n');
    const r = cli(traceRead, ['fuse', '--root', root]);
    expect(r.code).toBe(4);
    expect(r.out).toContain('FUSE-VERDICT NO-FUSE-IN-WINDOW');
  });

  it('6. turns：stream-error 不在已知终态集 ⇒ TURNS-VERDICT ANOMALY，exit 1', () => {
    const r = cli(traceRead, ['turns', '--root', roots[0]]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('TURN-ANOMALY turn-fx-4 stopReason=stream-error');
    expect(r.out).toContain('TURNS-VERDICT ANOMALY (n=3, anomalies=1)');
  });

  it('7. locate：根不存在 ⇒ ROOT-MISS，exit 3（负控：不猜根、不落空读）', () => {
    const r = cli(traceRead, ['locate', '--root', join(tmpdir(), 'no-such-c1-live-root')]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('ROOT-MISS');
  });

  it('8. locate：--auto 列候选根（环境无 trace 文件时 exit 3 也要带候选清单）', () => {
    const r = cli(traceRead, ['locate', '--auto']);
    // dev 树 cwd 候选 E:\NAS\deepseek-studio\logs\trace 在 CI/异机可能不存在——不硬断 exit，只断候选面在输出里
    expect(r.out).toContain('DeepSeek++ Studio');
    expect(r.out).toContain('com.deepseek.studio');
  });
});

describe('判据常量漂移锁（探针镜像 ↔ 源文件字面量 ↔ shared 导出）', () => {
  const src = readFileSync(traceRead, 'utf8');

  it('9. trace-read 镜像 TERMINAL_FUSE_N／NON_TERMINAL_FUSE_N 与 shared 导出相等', () => {
    const t = Number(src.match(/\bTERMINAL_FUSE_N = (\d+)/)?.[1]);
    const n = Number(src.match(/\bNON_TERMINAL_FUSE_N = (\d+)/)?.[1]);
    expect(t).toBe(TERMINAL_FUSE_THRESHOLD);
    expect(n).toBe(NON_TERMINAL_FUSE_THRESHOLD);
  });

  it('10. msel 预算镜像 120 且注入层源文件字面量 MEM_SELECT_WAIT_BUDGET_MS = 120 仍在（双钉互锁）', () => {
    expect(src).toMatch(/\bMSEL_TURN_BUDGET_MS = 120/);
    const interceptor = readFileSync(join(here, '../../../src/inject/main-world-interceptor.ts'), 'utf8');
    expect(interceptor).toMatch(/MEM_SELECT_WAIT_BUDGET_MS = 120/);
  });
});

describe('cdp.mjs 自包含与负控（不建实例）', () => {
  const src = readFileSync(cdp, 'utf8');

  it('11. 零 npm 依赖：无 import-from 非 node: 包、无 require（自包含锁，防「自己核自己」式回退）', () => {
    expect(src).not.toMatch(/from\s+'(?!node:)/);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).toContain('[role="button"].ds-button--primary');
  });

  it('12. 死端口：targets --port 1 ⇒ PORT_CLOSED，exit 3，且不挂死（fetch 4s 超时界内）', () => {
    const t0 = Date.now();
    const r = cli(cdp, ['targets', '--port', '1']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('PORT_CLOSED');
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('13. 无命令 ⇒ usage，exit 2', () => {
    const r = cli(cdp, []);
    expect(r.code).toBe(2);
    expect(r.out.toLowerCase()).toContain('usage');
  });

  it('14. trace-read 无命令 ⇒ usage，exit 2', () => {
    const r = cli(traceRead, []);
    expect(r.code).toBe(2);
    expect(r.out.toLowerCase()).toContain('usage');
  });
});
