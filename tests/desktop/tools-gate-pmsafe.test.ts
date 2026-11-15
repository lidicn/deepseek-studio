/**
 * ⑤ 机械闸契约（20261115 PM 派卡）＋ ⑤-b 写前判定（PM 09:00 实弹）：
 * SafeAppend 自检（粘行/短 token/规模下限/不存在拒写）＋ pre-commit CLAIM 校验
 * （合成四态＋真实人口负控＋pmsafe 通道实弹＋未设 actor 任一在册执行方）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeAppendLog, safeAppendBlock, nextGateRunNo, writeGateRunning, writeGateEnd, decideDryRun } from '../../tools/gate/pmsafe';

/** ⑤-补2（PM 判据）：根路径相对定位——CI checkout 在 D:\a\<repo>\<repo>，任何盘符字面量
 *  都会让套件在干净树上炸（43660126937 前一发 CI 红的根因）。 */
const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(REAL_ROOT, 'scripts', 'install-pre-commit-hook.mjs');
const MIN_BYTES = 100 * 1024;

/** 控制面台账同构夹具：≥100KB（safeAppendBlock 写前判定的规模下限）。 */
function makeBigLog(name: string, opts?: { trailingNewline?: boolean }): string {
  const f = join(tmpdir(), name);
  writeFileSync(f, 'x'.repeat(MIN_BYTES) + (opts?.trailingNewline === false ? '' : '\n'), 'utf8');
  return f;
}

describe('pmsafe · SafeAppend 自检（⑤）', () => {
  it('不粘连：前文件缺尾换行 ⇒ 新记录独立成行且行首是时刻锚', () => {
    const f = makeBigLog(`pmsafe-${Date.now()}.log`, { trailingNewline: false });
    safeAppendLog(f, 'CLAIM commit gate-test 08:15 测试');
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines[0].length).toBe(MIN_BYTES);
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] CLAIM commit gate-test/);
    rmSync(f, { force: true });
  });

  it('幂等：第二次追加不改第一次的字节（追加语义，前缀逐字节不变）', () => {
    const f = makeBigLog(`pmsafe-${Date.now()}.log`);
    safeAppendLog(f, '第一条');
    const before = readFileSync(f, 'utf8');
    safeAppendLog(f, '第二条');
    const after = readFileSync(f, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 第二条\n$/);
    rmSync(f, { force: true });
  });

  it('短 token 不误伤：正文含 AGENTS/TS 逐字回读相等（08:02 AGEN08:02 形态当场抓）', () => {
    const f = makeBigLog(`pmsafe-${Date.now()}.log`);
    const line = 'RELEASE bf0c94b — AGENTS 口径五条落稿，TS 侧无改动';
    safeAppendLog(f, line);
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toContain('AGENTS');
    expect(lines[lines.length - 1]).toContain('TS 侧无改动');
    expect(lines[lines.length - 1].endsWith('AGENTS 口径五条落稿，TS 侧无改动')).toBe(true);
    rmSync(f, { force: true });
  });

  it('多行写入拒绝（参数校验先于目标判定，不创建任何文件）', () => {
    const f = join(tmpdir(), `pmsafe-${Date.now()}.log`);
    expect(() => safeAppendLog(f, '两行\n写入')).toThrow(/拒绝多行/);
    expect(existsSync(f)).toBe(false);
  });

  it('⑤-b 红半：目标不存在 ⇒ 抛错（文案带路径）且事后不新建', () => {
    const ghost = join(tmpdir(), `ghost-PM-LOG-${Date.now()}`);
    expect(() => safeAppendBlock(ghost, 'x')).toThrow(/不存在的文件/);
    expect(() => safeAppendBlock(ghost, 'x')).toThrow(/ghost-PM-LOG/);
    expect(existsSync(ghost)).toBe(false);
  });

  it('⑤-b 红半：目标小于 100KB ⇒ 抛错（疑似误指目标）', () => {
    const small = join(tmpdir(), `small-PM-LOG-${Date.now()}.md`);
    writeFileSync(small, '小文件\n', 'utf8');
    expect(() => safeAppendBlock(small, 'x')).toThrow(/小于 102400 B/);
    rmSync(small, { force: true });
  });

  it('⑤-b 绿半（真实人口同构）：≥100KB 台账正常写，回读逐字相等', () => {
    const f = makeBigLog(`pmsafe-ok-${Date.now()}.log`);
    safeAppendBlock(f, '⑤-b 契约绿半：块级写入验证（本块即写入证据）\n第二行保持原样。');
    const after = readFileSync(f, 'utf8');
    expect(after.endsWith('⑤-b 契约绿半：块级写入验证（本块即写入证据）\n第二行保持原样。\n')).toBe(true);
    rmSync(f, { force: true });
  });
});

describe('pmsafe · 闸自写 RUNNING/END（⑤）', () => {
  it('号段自增：无文件从 1 起，既有 RUNNING 取 max+1；END 行带真实 exit/total', () => {
    const f = makeBigLog(`pmsafe-run-${Date.now()}.log`);
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

// ── pre-commit CLAIM 校验（⑤）：真实临时 git 仓装钩跑 commit 四态（合成人口）──────
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
    execSync(`node "${INSTALLER}"`, opts);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const tryCommit = (): { code: number; out: string } => {
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

  it('无 CLAIM（无 PM-LOG）→ 拦，提示带执行方名', () => {
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

// ── ⑤ 回炉（群PM 实弹裁定）：钩解析与真实人口同构＋⑤-补 未设 actor ─────────────────
// 真实人口形态（运行时现取自真仓 PM-LOG.md，形态漂移 ⇒ 本组测试红、提示钩解析要跟）：
//   CLAIM  「## @HH:mm CLAIM commit+push 群PM｜…」／pmsafe「[时刻] CLAIM commit 群PM …」
//   RELEASE「HH:mm:ss **群PM（…）｜RELEASE <sha> CI run <id> …**」等行级两条件形态
const isRealClaimLine = (l: string, actor: string): boolean => {
  const tokens = l.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'CLAIM') {
      const act = tokens[i + 1] ?? '';
      const who = tokens[i + 2] ?? '';
      if (act.startsWith('commit') && who.startsWith(actor)) return true;
    }
  }
  return false;
};

// ── ⑤ 回炉（群PM 实弹裁定）＋ ⑤-补2：真实人口分两面 ────────────────────────────────
// ① 静态形态锁：今晚真发生过的 CLAIM/RELEASE 行**逐字钉进测试文件**（CI 必跑必判——
//    合成夹具造不出这个洞，见 43660126937 前一发 CI 教训）。
// ② 活锁：运行时现取真行——**仅在本机有 PM-LOG.md 时跑**；干净树显式 skip＋打印 N/A，
//    不得硬失败（真实人口活锁在 CI 上永不可能成立）。
const REAL_PM_LOG = join(REAL_ROOT, 'PM-LOG.md');
const hasRealLog = existsSync(REAL_PM_LOG);
if (!hasRealLog) {
  console.warn('[⑤ 活锁] N/A：本树无 PM-LOG.md（干净 checkout）——运行时真行活锁 skip，静态形态锁已覆盖 CI 侧');
}
const itLive = hasRealLog ? it : it.skip;

describe('pre-commit 真实人口形态锁（静态夹具，CI 必跑）', () => {
  const STATIC_CLAIM_TITLE = '## @08:17 CLAIM commit+push 群PM｜④②c 入库分两笔：第 1 笔 tools/tests 域 2 枚；第 2 笔 scripts/ci.yml';
  const STATIC_CLAIM_HEADING = '### [08:39] CLAIM commit+push 群PM（⑤ 回炉三件落地：钩三形态同构／safeAppendBlock／真实人口负控）';
  const STATIC_CLAIM_PMSAFE = '[2026-11-15 09:02:12] CLAIM commit+push 群PM ⑤-b 契约绿半（块级写入对真台账验证通过）';
  const STATIC_RELEASE = '09:02:12 **群PM（轮询器自动收口）｜RELEASE 43660126937 CI run 43660126937 completed / success（jobs: gate=success / cargo-check=success / doc-drift-upstream-negative=success）**';

  let repoS: string;
  const tryCommitS = (actor?: string): { code: number; out: string } => {
    writeFileSync(join(repoS, 'a.txt'), `x-${Math.random()}\n`, 'utf8');
    execSync('git add a.txt', { cwd: repoS });
    const envPack: Record<string, string | undefined> = { ...process.env };
    if (actor === undefined) delete envPack.GATE_ACTOR;
    else envPack.GATE_ACTOR = actor;
    try {
      execSync('git commit -m t', { cwd: repoS, encoding: 'utf8', env: envPack as NodeJS.ProcessEnv });
      return { code: 0, out: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      return { code: err.status ?? 1, out: (err.stderr || '') + (err.stdout || '') };
    }
  };

  beforeAll(() => {
    repoS = mkdtempSync(join(tmpdir(), 'precommit-static-'));
    const opts = { cwd: repoS, encoding: 'utf8' } as const;
    execSync('git init', opts);
    execSync('git config user.email t@t', opts);
    execSync('git config user.name t', opts);
    writeFileSync(join(repoS, 'a.txt'), 'x\n', 'utf8');
    execSync('git add a.txt', opts);
    execSync(`node "${INSTALLER}"`, opts);
  });

  afterAll(() => {
    if (repoS) rmSync(repoS, { recursive: true, force: true });
  });

  it('标题式 CLAIM（## @HH:mm 前缀）→ 放行', () => {
    writeFileSync(join(repoS, 'PM-LOG.md'), STATIC_CLAIM_TITLE + '\n', 'utf8');
    const r = tryCommitS('群PM');
    expect(r.code, `拦截原文：${r.out}`).toBe(0);
  });

  it('### [HH:mm] 前缀 CLAIM → 放行', () => {
    writeFileSync(join(repoS, 'PM-LOG.md'), STATIC_CLAIM_HEADING + '\n', 'utf8');
    const r = tryCommitS('群PM');
    expect(r.code, `拦截原文：${r.out}`).toBe(0);
  });

  it('pmsafe [时刻] 前缀 CLAIM → 放行', () => {
    writeFileSync(join(repoS, 'PM-LOG.md'), STATIC_CLAIM_PMSAFE + '\n', 'utf8');
    const r = tryCommitS('群PM');
    expect(r.code, `拦截原文：${r.out}`).toBe(0);
  });

  it('RELEASE 真行（hex 锚）把锁还上 → 再提交拦', () => {
    writeFileSync(join(repoS, 'PM-LOG.md'), STATIC_CLAIM_PMSAFE + '\n' + STATIC_RELEASE + '\n', 'utf8');
    const r = tryCommitS('群PM');
    expect(r.code).not.toBe(0);
  });

  it('未设 GATE_ACTOR ＋ pmsafe 形态 CLAIM → 放行（任一在册执行方）', () => {
    writeFileSync(join(repoS, 'PM-LOG.md'), STATIC_CLAIM_PMSAFE + '\n', 'utf8');
    const r = tryCommitS(undefined);
    expect(r.code, `拦截原文：${r.out}`).toBe(0);
  });

  it('未设 GATE_ACTOR ＋ 无 CLAIM 只有叙述 → 拦', () => {
    writeFileSync(join(repoS, 'PM-LOG.md'), '- 纯叙述一行，没有 CLAIM 记录\n', 'utf8');
    const r = tryCommitS(undefined);
    expect(r.code).not.toBe(0);
  });

  it('⑤-补5 号段锁：新格式 RUNNING 未收口＝真未收口（nextGateRunNo 数到它）', () => {
    // 行首机器锚形态（safeAppendLog 写出的）：[YYYY-MM-DD HH:mm:ss] RUNNING GATE#N
    const f = makeBigLog(`pmsafe-gate-noend-${Date.now()}.log`);
    writeFileSync(
      f,
      'x'.repeat(MIN_BYTES) + '\n[2026-11-15 08:00:00] RUNNING GATE#57 by 私聊PM pid=1 HEAD=c0ffee1 dirty=0\n',
      'utf8',
    );
    expect(nextGateRunNo(f)).toBe(58);
    rmSync(f, { force: true });
  });

  it('⑤-补5 号段锁：旧格式与叙述行不得计入在跑（防粗扫描误冻整条线）', () => {
    // 旧格式（行首 09:58 **RUNNING…）与叙述行（**私聊PM｜看门狗：GATE#94 在跑）都不是
    // 行首机器锚——粗扫描会数出 26 个"未收口"误冻全仓；nextGateRunNo 只认新格式。
    const f = makeBigLog(`pmsafe-gate-old-${Date.now()}.log`);
    writeFileSync(
      f,
      [
        'x'.repeat(MIN_BYTES),
        '09:58 **RUNNING GATE#69 by 私聊PM｜锁表：M5 记忆注入……（旧格式登记）',
        '**私聊PM｜看门狗：GATE#94 在跑……（叙述行）',
        '[2026-11-15 09:59:00] RUNNING GATE#5 by 群PM pid=1 HEAD=abc1234 dirty=0',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(nextGateRunNo(f)).toBe(6);
    rmSync(f, { force: true });
  });

  it('⑤-补6 静态锁①：decideDryRun 在「台账存在」夹具上返回 reject=true', () => {
    const f = makeBigLog(`pmsafe-dd-yes-${Date.now()}.log`);
    const v = decideDryRun(f);
    expect(v.reject).toBe(true);
    expect(v.reason).toContain('PM-LOG.md');
    rmSync(f, { force: true });
  });

  it('⑤-补6 静态锁②：decideDryRun 空树返回 reject=false（N/A 登记链可走）', () => {
    const ghost = join(tmpdir(), `pmsafe-dd-no-${Date.now()}.md`);
    const v = decideDryRun(ghost);
    expect(v.reject).toBe(false);
    expect(existsSync(ghost)).toBe(false);
  });

  it('⑤-补6 静态锁③：拒绝路径下 writeGateRunning 从未被调用（tmp 台账字节不变，模拟 run.ts 现行调用序）', () => {
    // run.ts 现行序：decideDryRun → reject ⇒ 直接 exit，writeGateRunning 不触。
    // 本枚模拟该序并对 tmp 台账断字节——顺序回归（拒绝后置）会在此现形。
    const f = makeBigLog(`pmsafe-dd-nocall-${Date.now()}.log`);
    const beforeBytes = statSync(f).size;
    const before = readFileSync(f, 'utf8');
    const v = decideDryRun(f);
    expect(v.reject).toBe(true);
    // 按现行 run.ts 调用序：reject ⇒ 不调 writeGateRunning（无任何追加动作）
    expect(statSync(f).size).toBe(beforeBytes);
    expect(readFileSync(f, 'utf8')).toBe(before);
    rmSync(f, { force: true });
  });

  it('⑤-补4：CLAIM ＋ 叙述行裸 RELEASE（无 hex）→ 放行（叙述行不许误还锁——杀变异 A）', () => {
    // 变异 A（删 hex 锚子句）下：叙述行命中 RELEASE token ⇒ 锁被误还 ⇒ 本枚红。
    // 现行钩下：叙述行无 hex ⇒ 锁未还 ⇒ 放行。
    writeFileSync(
      join(repoS, 'PM-LOG.md'),
      STATIC_CLAIM_PMSAFE + '\n- 回顾时提到 RELEASE 这个词，但没有凭证编号与 run id（纯叙述）。\n',
      'utf8',
    );
    const r = tryCommitS('群PM');
    expect(r.code, `叙述行误还锁＝hex 锚失效：${r.out}`).toBe(0);
  });

  it('⑤-补4 对照：同夹具追加真 RELEASE（带 hex）→ 拦（两枚之差正是 hex 锚）', () => {
    writeFileSync(
      join(repoS, 'PM-LOG.md'),
      STATIC_CLAIM_PMSAFE + '\n- 回顾时提到 RELEASE 这个词，但没有凭证编号与 run id（纯叙述）。\n' + STATIC_RELEASE + '\n',
      'utf8',
    );
    const r = tryCommitS('群PM');
    expect(r.code).not.toBe(0);
  });
});

// ── ⑤-补5（PM 判据）：闸自写 RUNNING/END 在无台账树上显式 N/A，不抛、不造野件 ──────
describe('pmsafe · 闸自写 N/A 语义（⑤-补5，CI 必跑）', () => {
  it('空树（无 PM-LOG）writeGateRunning 不抛＋返回 0＋不创建文件（防借 N/A 之名造野件）', () => {
    const pm = join(tmpdir(), `nolog-${Date.now()}.md`);
    expect(existsSync(pm)).toBe(false);
    const no = writeGateRunning(pm, { actor: 'gate-test', pid: 1, head: 'abc1234', dirty: 0 });
    expect(no).toBe(0);
    expect(existsSync(pm)).toBe(false);
  });

  it('writeGateEnd(0) 不写不抛（RUNNING 未登记时 END 静默）', () => {
    const pm = join(tmpdir(), `nolog2-${Date.now()}.md`);
    expect(() => writeGateEnd(pm, 0, 0, '0.0')).not.toThrow();
    expect(existsSync(pm)).toBe(false);
  });

  it('有台账时号段自增行为不变（对照，守卫语义不合并）', () => {
    const f = makeBigLog(`pmsafe-gate-${Date.now()}.log`);
    const no1 = writeGateRunning(f, { actor: 'gate-test', pid: 1, head: 'abc1234', dirty: 0 });
    expect(no1).toBe(1);
    const no2 = writeGateRunning(f, { actor: 'gate-test', pid: 2, head: 'abc1234', dirty: 0 });
    expect(no2).toBe(2);
    writeGateEnd(f, no1, 0, '1.0');
    expect(readFileSync(f, 'utf8')).toMatch(/END GATE#1 exit=0 total=1\.0s/);
    rmSync(f, { force: true });
  });
});

describe('pre-commit 真实人口负控（活锁——仅本机跑）', () => {
  let repo2: string;
  let claimLine: string;
  let releaseLine: string;

  if (hasRealLog) {
    beforeAll(() => {
      // 运行时现取真行——取样判据与钩 awk 同构（独立 JS 实现），两实现对拍不一致即测试红
      const pmLog = readFileSync(REAL_PM_LOG, 'utf8');
      const claimLines = pmLog.split('\n').filter((l) => isRealClaimLine(l, '群PM'));
      const releaseLines = pmLog
        .split('\n')
        .filter((l) => /(^|[^A-Za-z0-9])RELEASE([^A-Za-z0-9]|$)/.test(l) && /[0-9a-f]{7,}/.test(l));
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
      execSync(`node "${INSTALLER}"`, opts);
    });

    afterAll(() => {
      if (repo2) rmSync(repo2, { recursive: true, force: true });
    });
  }

  const tryCommitReal = (actor?: string): { code: number; out: string } => {
    writeFileSync(join(repo2, 'a.txt'), `x-${Math.random()}\n`, 'utf8');
    execSync('git add a.txt', { cwd: repo2 });
    const envPack: Record<string, string | undefined> = { ...process.env };
    if (actor === undefined) delete envPack.GATE_ACTOR;
    else envPack.GATE_ACTOR = actor;
    try {
      execSync('git commit -m t', { cwd: repo2, encoding: 'utf8', env: envPack as NodeJS.ProcessEnv });
      return { code: 0, out: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      return { code: err.status ?? 1, out: (err.stderr || '') + (err.stdout || '') };
    }
  };

  itLive('真实 CLAIM 行（## @HH:mm CLAIM commit+push 群PM｜…）→ 放行（回炉主洞）', () => {
    writeFileSync(join(repo2, 'PM-LOG.md'), claimLine + '\n', 'utf8');
    const r = tryCommitReal('群PM');
    expect(r.code, `真实 CLAIM 被拦＝钩仍与人口不同构：${r.out}`).toBe(0);
  });

  itLive('pmsafe 通道落的 CLAIM 行（[时刻] 前缀）→ 放行（PM 08:38 实弹形态）', () => {
    const pm = makeBigLog(`precommit-real-pm-${Date.now()}.log`);
    safeAppendLog(pm, 'CLAIM commit 群PM 08:38 ④②c 入库（pmsafe 通道实弹）');
    // 通道写出的整本日志（100KB 夹具＋CLAIM 行）替换临时仓 PM-LOG——钩读的是同一人口
    writeFileSync(join(repo2, 'PM-LOG.md'), readFileSync(pm, 'utf8'), 'utf8');
    const r = tryCommitReal('群PM');
    expect(r.code, `pmsafe 通道 CLAIM 被拦＝钩不认 [时刻] 前缀形态：${r.out}`).toBe(0);
    rmSync(pm, { force: true });
  });

  itLive('⑤-补：未设 GATE_ACTOR ＋ pmsafe 通道真 CLAIM 行 → 放行（缺省按任一在册执行方判，不拦死）', () => {
    const pm = makeBigLog(`precommit-noactor-${Date.now()}.log`);
    safeAppendLog(pm, 'CLAIM commit 群PM 09:00 ⑤-补 实弹（未设 actor 也须放行）');
    writeFileSync(join(repo2, 'PM-LOG.md'), readFileSync(pm, 'utf8'), 'utf8');
    const r = tryCommitReal(undefined);
    expect(r.code, `未设 actor 被拦＝机制仍绑在"记得设环境变量"上：${r.out}`).toBe(0);
    rmSync(pm, { force: true });
  });

  itLive('⑤-补：未设 GATE_ACTOR ＋ 已 RELEASE 的 CLAIM → 仍拦（任一模式也认锁状态）', () => {
    const pm = makeBigLog(`precommit-rel-${Date.now()}.log`);
    safeAppendLog(pm, 'CLAIM commit 群PM 09:01 ⑤-补 已收口案例');
    safeAppendLog(pm, 'RELEASE abc1234 43657387584');
    writeFileSync(join(repo2, 'PM-LOG.md'), readFileSync(pm, 'utf8'), 'utf8');
    const r = tryCommitReal(undefined);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('任一在册执行方');
    rmSync(pm, { force: true });
  });

  itLive('⑤-补：未设 GATE_ACTOR ＋ 无 CLAIM 只有叙述（含 RELEASE＋hex）→ 拦', () => {
    writeFileSync(
      join(repo2, 'PM-LOG.md'),
      '叙述行：RELEASE 0059677 CI run 43657387584 的账已由轮询器自写（本行不是 CLAIM）。\n',
      'utf8',
    );
    const r = tryCommitReal(undefined);
    expect(r.code).not.toBe(0);
  });

  itLive('真实人口冒烟：取样行与钩判据同构（CLAIM token＋动作词；RELEASE＋hex 行级两条件）', () => {
    expect(claimLine).toMatch(/CLAIM\s+commit/);
    expect(/(^|[^A-Za-z0-9])RELEASE([^A-Za-z0-9]|$)/.test(releaseLine)).toBe(true);
    expect(/[0-9a-f]{7,}/.test(releaseLine)).toBe(true);
  });

  it('⑤-补6/D1（tmp 化，CI 必跑）：有台账树跑 --dry-run ⇒ 非零退出且台账字节与行数逐字节不变', () => {
    // D1（群PM 09:46 实弹）：拒绝判定若后置于 writeGateRunning，会一边宣称防伪发一边写真伪发。
    // ⑤-补6：spawn 改在 tmp 树（≥100KB 假台账）里跑——回归时污染的是 tmp，不是控制面。
    const tree = mkdtempSync(join(tmpdir(), `dryrun-tree-${Date.now()}-`));
    try {
      mkdirSync(join(tree, 'tools', 'gate'), { recursive: true });
      for (const f of ['run.ts', 'pmsafe.ts', 'step-line.ts']) {
        copyFileSync(join(REAL_ROOT, 'tools', 'gate', f), join(tree, 'tools', 'gate', f));
      }
      writeFileSync(join(tree, 'package.json'), '{"type":"module"}\n', 'utf8');
      const ledger = join(tree, 'PM-LOG.md');
      writeFileSync(ledger, 'x'.repeat(MIN_BYTES) + '\n', 'utf8');
      const beforeBytes = statSync(ledger).size;
      const beforeLines = readFileSync(ledger, 'utf8').split('\n').length;
      let code = 0;
      try {
        execSync('npx tsx tools/gate/run.ts --dry-run', { cwd: tree, encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        code = (e as { status?: number }).status ?? 1;
      }
      expect(code, '有台账树 dry-run 应拒绝（非零退出）').not.toBe(0);
      expect(statSync(ledger).size, '台账字节数被改＝拒绝后置（D1 回归）').toBe(beforeBytes);
      expect(readFileSync(ledger, 'utf8').split('\n').length).toBe(beforeLines);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe('pmsafe · safeAppendBlock（⑤ 回炉：块级写入，命根自检保留）', () => {
  it('整块多行写入：块首行时刻锚、块内换行保留、缺尾换行前文件不粘连', () => {
    const f = makeBigLog(`pmsafe-blk-${Date.now()}.log`, { trailingNewline: false });
    const block = [
      '## @08:38 CLAIM commit+push 群PM｜④②c 入库分两笔',
      '第 1 笔 tools/tests 域 2 枚；第 2 笔 scripts/ci.yml。',
      '范围仅此 4 枚，docs 零触碰。',
    ].join('\n');
    safeAppendBlock(f, block);
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0].length).toBe(MIN_BYTES);
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ## @08:38 CLAIM commit\+push 群PM｜④②c 入库分两笔$/);
    expect(lines[3]).toBe('范围仅此 4 枚，docs 零触碰。');
    rmSync(f, { force: true });
  });

  it('块幂等＋短 token 不误伤：正文含 AGENTS/TS 逐字回读', () => {
    const f = makeBigLog(`pmsafe-blk2-${Date.now()}.log`);
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
  });
});