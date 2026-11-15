/**
 * ⑤ 机械闸契约（20261115 PM 派卡）：SafeAppend 自检 + pre-commit CLAIM 校验。
 * 三个判据形态当场抓今晚三次损伤：06:35 粘行（缺尾换行）、08:02 AGEN08:02（短 token
 * 被占位符替换连坐）、07:58 假"已修"（判据与模式不一致）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeAppendLog, safeAppendBlock, nextGateRunNo, writeGateRunning, writeGateEnd } from '../../tools/gate/pmsafe';

describe('pmsafe · SafeAppend 自检（⑤）', () => {
  it('不粘连：前文件缺尾换行 ⇒ 新记录独立成行且行首是时刻锚', () => {
    const f = join(tmpdir(), `pmsafe-${Date.now()}.log`);
    writeFileSync(f, '上一条没有尾换行', 'utf8'); // 故意制造 06:35 粘行隐患
    safeAppendLog(f, 'CLAIM commit gate-test 08:15 测试');
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('上一条没有尾换行');
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] CLAIM commit gate-test/);
    rmSync(f, { force: true });
  });

  it('幂等：第二次追加不改第一次的字节（追加语义，前缀逐字节不变）', () => {
    const f = join(tmpdir(), `pmsafe-${Date.now()}.log`);
    safeAppendLog(f, '第一条');
    const before = readFileSync(f, 'utf8');
    safeAppendLog(f, '第二条');
    const after = readFileSync(f, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 第二条\n$/);
    rmSync(f, { force: true });
  });

  it('短 token 不误伤：正文含 AGENTS/TS 逐字回读相等（08:02 AGEN08:02 形态当场抓）', () => {
    const f = join(tmpdir(), `pmsafe-${Date.now()}.log`);
    const line = 'RELEASE bf0c94b — AGENTS 口径五条落稿，TS 侧无改动';
    safeAppendLog(f, line);
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toContain('AGENTS');
    expect(lines[lines.length - 1]).toContain('TS 侧无改动');
    expect(lines[lines.length - 1].endsWith('AGENTS 口径五条落稿，TS 侧无改动')).toBe(true);
    rmSync(f, { force: true });
  });

  it('多行写入拒绝（行级自检前提）＋ 时刻锚正则断言', () => {
    const f = join(tmpdir(), `pmsafe-${Date.now()}.log`);
    expect(() => safeAppendLog(f, '两行\n写入')).toThrow(/拒绝多行/);
    expect(existsSync(f)).toBe(false); // 抛错前未写任何字节
    rmSync(f, { force: true });
  });
});

describe('pmsafe · 闸自写 RUNNING/END（⑤）', () => {
  it('号段自增：无文件从 1 起，既有 RUNNING 取 max+1；END 行带真实 exit/total', () => {
    const f = join(tmpdir(), `pmsafe-run-${Date.now()}.log`);
    expect(nextGateRunNo(f)).toBe(1);
    const no1 = writeGateRunning(f, { actor: 'gate-test', pid: 4242, head: 'abc1234', dirty: 0 });
    expect(no1).toBe(1);
    const no2 = writeGateRunning(f, { actor: 'gate-test', pid: 4243, head: 'abc1234', dirty: 3 });
    expect(no2).toBe(2);
    writeGateEnd(f, no1, 0, '17.3');
    const text = readFileSync(f, 'utf8');
    expect(text).toContain('RUNNING GATE#1 by gate-test pid=4242 HEAD=abc1234 dirty=0');
    expect(text).toContain('RUNNING GATE#2 by gate-test pid=4243 HEAD=abc1234 dirty=3');
    expect(text).toMatch(/END GATE#1 exit=0 total=17\.3s/);
    rmSync(f, { force: true });
  });
});

// ── pre-commit CLAIM 校验（⑤）：真实临时 git 仓装钩跑 commit 三态 ──────────────────
describe('pre-commit CLAIM 校验（⑤）', () => {
  let repo: string;
  const env = { GATE_ACTOR: 'gate-test' } as Record<string, string>;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'precommit-'));
    const opts = { cwd: repo, encoding: 'utf8' } as const;
    execSync('git init', opts);
    execSync('git config user.email t@t', opts);
    execSync('git config user.name t', opts);
    writeFileSync(join(repo, 'a.txt'), 'x\n', 'utf8');
    execSync('git add a.txt', opts);
    execSync('node E:/NAS/deepseek-studio/scripts/install-pre-commit-hook.mjs', opts);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const tryCommit = (): { code: number; out: string } => {
    // 每次都重新 stage 一枚文件——暂存区非空是 hook 的前置条件（空则短路放行）
    writeFileSync(join(repo, 'a.txt'), `x-${Math.random()}\n`, 'utf8');
    execSync('git add a.txt', { cwd: repo });
    try {
      execSync('git commit -m t', { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
      return { code: 0, out: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      return { code: err.status ?? 1, out: (err.stderr || '') + (err.stdout || '') };
    }
  };

  it('无 CLAIM → 拦（exit 1，提示缺什么）', () => {
    const r = tryCommit();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('CLAIM commit gate-test');
  });

  it('CLAIM commit gate-test 未 RELEASE → 放行（exit 0）', () => {
    writeFileSync(join(repo, 'PM-LOG.md'), 'CLAIM commit gate-test 08:15 测试范围\n', 'utf8');
    const r = tryCommit();
    expect(r.code).toBe(0);
  });

  it('CLAIM 已被 RELEASE 收口 → 再拦（锁已还）', () => {
    writeFileSync(join(repo, 'PM-LOG.md'), 'CLAIM commit gate-test 08:15 测试范围\nRELEASE abc1234 43657387584\n', 'utf8');
    const r = tryCommit();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('未 RELEASE');
  });

  it('末 40 行窗口：CLAIM 在窗口外 → 拦（窗口判据生效）', () => {
    const filler = Array.from({ length: 45 }, (_, i) => `填 ${i}`).join('\n');
    writeFileSync(join(repo, 'PM-LOG.md'), `CLAIM commit gate-test 08:15 测试范围\n${filler}\n`, 'utf8');
    const r = tryCommit();
    expect(r.code).not.toBe(0);
  });
});

// ── ⑤ 回炉（群PM 实弹裁定）：钩解析与真实人口同构＋块级写入 ──────────────────────────
// 真实人口形态（现取自真仓 PM-LOG.md，形态漂移 ⇒ 本组测试红、提示钩解析要跟）：
//   CLAIM  「## @HH:mm CLAIM commit+push 群PM｜…」（合成对照「CLAIM commit <actor> …」）
//   RELEASE「HH:mm:ss **群PM（…）｜RELEASE <sha> CI run <id> …**」
const REAL_ROOT = 'E:\\NAS\\deepseek-studio';
describe('pre-commit 真实人口负控（⑤ 回炉）', () => {
  let repo2: string;
  let claimLine: string;
  let releaseLine: string;

  beforeAll(() => {
    // 运行时现取真行——不钉死字面量，PM-LOG 形态再演进测试也跟得住。
    // 取样判据与钩 awk 同构（字段扫描：独立 CLAIM token＋动作词 commit*＋执行方前缀），
    // 但独立实现——两实现对同一行不一致即测试红（负控有效性的自证）。
    const pmLog = readFileSync(join(REAL_ROOT, 'PM-LOG.md'), 'utf8');
    const isClaimLine = (l: string): boolean => {
      const tokens = l.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'CLAIM') {
          const act = tokens[i + 1] ?? '';
          const who = tokens[i + 2] ?? '';
          if (act.startsWith('commit') && who.startsWith('群PM')) return true;
        }
      }
      return false;
    };
    const claimLines = pmLog.split('\n').filter(isClaimLine);
    const releaseLines = pmLog.split('\n').filter((l) => /(^|[^A-Za-z0-9])RELEASE([^A-Za-z0-9]|$)/.test(l) && /[0-9a-f]{7,}/.test(l));
    expect(claimLines.length, 'PM-LOG 必须能取到真实 CLAIM 行（取不到＝形态漂移，钩解析要跟）').toBeGreaterThan(0);
    expect(releaseLines.length, 'PM-LOG 必须能取到真实 RELEASE 行').toBeGreaterThan(0);
    claimLine = claimLines[claimLines.length - 1];
    releaseLine = releaseLines[releaseLines.length - 1];
    repo2 = mkdtempSync(join(tmpdir(), 'precommit-real-'));
    const opts = { cwd: repo2, encoding: 'utf8' } as const;
    execSync('git init', opts);
    execSync('git config user.email t@t', opts);
    execSync('git config user.name t', opts);
    writeFileSync(join(repo2, 'a.txt'), 'x\n', 'utf8');
    execSync('git add a.txt', opts);
    execSync('node E:/NAS/deepseek-studio/scripts/install-pre-commit-hook.mjs', opts);
  });

  afterAll(() => {
    if (repo2) rmSync(repo2, { recursive: true, force: true });
  });

  const tryCommitReal = (): { code: number; out: string } => {
    writeFileSync(join(repo2, 'a.txt'), `x-${Math.random()}\n`, 'utf8');
    execSync('git add a.txt', { cwd: repo2 });
    try {
      execSync('git commit -m t', {
        cwd: repo2,
        encoding: 'utf8',
        env: { ...process.env, GATE_ACTOR: '群PM' },
      });
      return { code: 0, out: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      return { code: err.status ?? 1, out: (err.stderr || '') + (err.stdout || '') };
    }
  };

  it('真实 CLAIM 行（## @HH:mm CLAIM commit+push 群PM｜…）→ 放行（回炉主洞）', () => {
    writeFileSync(join(repo2, 'PM-LOG.md'), claimLine + '\n', 'utf8');
    const r = tryCommitReal();
    expect(r.code, `真实 CLAIM 被拦＝钩仍与人口不同构：${r.out}`).toBe(0);
  });

  it('pmsafe 通道落的 CLAIM 行（[时刻] 前缀）→ 放行（PM 08:38 实弹形态：awk 按空格切 $1=[2026-11-15）', () => {
    // 走真实 pmsafe 单行通道写 CLAIM——钩必须认带 [时刻] 前缀的形态
    safeAppendLog(join(repo2, 'PM-LOG.md'), 'CLAIM commit 群PM 08:38 ④②c 入库（pmsafe 通道实弹）');
    const r = tryCommitReal();
    expect(r.code, `pmsafe 通道 CLAIM 被拦＝钩不认 [时刻] 前缀形态：${r.out}`).toBe(0);
  });

  it('真实 CLAIM + 真实 RELEASE → 拦（锁已还——危险侧，实弹曾未覆盖）', () => {
    writeFileSync(join(repo2, 'PM-LOG.md'), claimLine + '\n' + releaseLine + '\n', 'utf8');
    const r = tryCommitReal();
    expect(r.code).not.toBe(0);
  });

  it('真实人口冒烟：取样行确为 commit+push/commit 形态（防取到叙述行）', () => {
    expect(claimLine).toMatch(/CLAIM\s+commit/);
    expect(releaseLine).toMatch(/RELEASE\s+[0-9a-f]{7,}/);
  });
});

describe('pmsafe · safeAppendBlock（⑤ 回炉：块级写入，命根自检保留）', () => {
  it('整块多行写入：块首行时刻锚、块内换行保留、缺尾换行前文件不粘连', () => {
    const f = join(tmpdir(), `pmsafe-blk-${Date.now()}.log`);
    writeFileSync(f, '上一条没有尾换行', 'utf8');
    const block = ['## @08:38 CLAIM commit+push 群PM｜④②c 入库分两笔', '第 1 笔 tools/tests 域 2 枚；第 2 笔 scripts/ci.yml。', '范围仅此 4 枚，docs 零触碰。'].join('\n');
    safeAppendBlock(f, block);
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('上一条没有尾换行');
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ## @08:38 CLAIM commit\+push 群PM｜④②c 入库分两笔$/);
    expect(lines[3]).toBe('范围仅此 4 枚，docs 零触碰。');
    rmSync(f, { force: true });
  });

  it('块幂等＋短 token 不误伤：正文含 AGENTS/TS 逐字回读', () => {
    const f = join(tmpdir(), `pmsafe-blk2-${Date.now()}.log`);
    const block = 'RELEASE bf0c94b\nAGENTS 口径五条落稿，TS 侧无改动';
    safeAppendBlock(f, block);
    const before = readFileSync(f, 'utf8');
    safeAppendBlock(f, '第二条');
    const after = readFileSync(f, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(before).toContain('AGENTS 口径五条落稿，TS 侧无改动');
    rmSync(f, { force: true });
  });

  it('safeAppendLog 单行仍拒多行、内部走同一回读命根', () => {
    const f = join(tmpdir(), `pmsafe-log-${Date.now()}.log`);
    expect(() => safeAppendLog(f, '两行\n写入')).toThrow(/拒绝多行/);
    expect(existsSync(f)).toBe(false);
    rmSync(f, { force: true });
  });
});
