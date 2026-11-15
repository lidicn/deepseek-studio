/**
 * ⑥ BOM 漂移检测契约（20261115 PM 派卡）：
 * 加 BOM→红／去 BOM→红／保持无→绿／保持有→绿（存量不误伤）＋新增文件不判＋集成两枚。
 * 夹具全 tmp；git 集成用真实临时仓（beforeAll init）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBomDrift, scanBomDrift, resolveBase, decideBomFace } from '../../tools/audit/bom-drift';
import { spawnSync } from 'node:child_process';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('bom-drift · 纯判据四态（⑥）', () => {
  it('1. 加 BOM（HEAD 无→工作区有）→ 红（added）', () => {
    const v = detectBomDrift([{ path: 'docs/a.md', headHasBom: false, workHasBom: true }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.direction).toBe('added');
    expect(v[0]?.file).toBe('docs/a.md');
  });

  it('2. 去 BOM（HEAD 有→工作区无）→ 红（removed）', () => {
    const v = detectBomDrift([{ path: 'docs/b.md', headHasBom: true, workHasBom: false }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.direction).toBe('removed');
  });

  it('3. 保持无 BOM → 绿（零命中）', () => {
    expect(detectBomDrift([{ path: 'a.ts', headHasBom: false, workHasBom: false }])).toHaveLength(0);
  });

  it('4. 保持有 BOM → 绿（存量不误伤）', () => {
    expect(detectBomDrift([{ path: 'b.ts', headHasBom: true, workHasBom: true }])).toHaveLength(0);
  });

  it('5. 新增文件（HEAD 无版本）→ 不判；混合清单只报漂移', () => {
    const v = detectBomDrift([
      { path: 'new.ts', headHasBom: null, workHasBom: true },
      { path: 'flip.md', headHasBom: false, workHasBom: true },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toBe('flip.md');
  });
});

// ── 集成（真实临时 git 仓）：scanBomDrift 的 git diff 人口＋字节级 BOM 判定 ──
describe('bom-drift · 集成（真实临时仓）', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'bomdrift-'));
    const opts = { cwd: repo, encoding: 'utf8' } as const;
    execSync('git init', opts);
    execSync('git config user.email t@t', opts);
    execSync('git config user.name t', opts);
    // HEAD：一枚带 BOM 的 md、一枚不带 BOM 的 ts
    writeFileSync(join(repo, 'with-bom.md'), '\uFEFF# 带 BOM 的存量\n', 'utf8');
    writeFileSync(join(repo, 'no-bom.ts'), '// 不带 BOM\n', 'utf8');
    execSync('git add -A', opts);
    execSync('git commit -m init', opts);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('6. 集成：两文件内容改动但 BOM 保持 → 绿（存量不误伤）；同文件剥 BOM → 红', () => {
    // 先造内容改动（BOM 两侧一致——改动让文件进 diff 人口，BOM 不翻转 ⇒ 绿）
    writeFileSync(join(repo, 'no-bom.ts'), '// 不带 BOM（微调）\n', 'utf8');
    const bomBody = readFileSync(join(repo, 'with-bom.md'), 'utf8');
    writeFileSync(join(repo, 'with-bom.md'), bomBody + '\n微调行。\n', 'utf8');
    const clean = scanBomDrift(repo);
    expect(clean.issues).toHaveLength(0);
    expect(clean.scanned).toBe(2);
    // 剥掉存量 BOM → 红（removed）
    const stripped = readFileSync(join(repo, 'with-bom.md'), 'utf8').replace(/^\uFEFF/, '');
    writeFileSync(join(repo, 'with-bom.md'), stripped, 'utf8');
    const red = scanBomDrift(repo);
    expect(red.issues).toHaveLength(1);
    expect(red.issues[0]?.direction).toBe('removed');
    // 还原（本仓是一次性夹具，不留脏态）
    writeFileSync(join(repo, 'with-bom.md'), '\uFEFF' + stripped, 'utf8');
  });

  it('7. 集成：HEAD 无 BOM 的文件被加 BOM → 红（added）', () => {
    writeFileSync(join(repo, 'no-bom.ts'), '\uFEFF// 不带 BOM\n', 'utf8');
    const v = scanBomDrift(repo);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]?.direction).toBe('added');
    expect(v.issues[0]?.file).toBe('no-bom.ts');
    // 还原
    writeFileSync(join(repo, 'no-bom.ts'), '// 不带 BOM\n', 'utf8');
  });
});

// ── ⑥ 甲案（PM 20261115 裁定）：CI 推送基线复判面 + 回落链 ──────────────────────────
describe('bom-drift · 推送基线模式（⑥ 甲案）', () => {
  let repo: string;
  let beforeSha: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'bomdrift-base-'));
    const opts = { cwd: repo, encoding: 'utf8' } as const;
    execSync('git init', opts);
    execSync('git config user.email t@t', opts);
    execSync('git config user.name t', opts);
    // base 提交：一枚无 BOM 文件
    writeFileSync(join(repo, 'a.ts'), '// base\n', 'utf8');
    execSync('git add -A', opts);
    execSync('git commit -m base', opts);
    beforeSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    // HEAD 提交：同文件被加 BOM（推送批次里的翻转）
    writeFileSync(join(repo, 'a.ts'), '\uFEFF// base\n', 'utf8');
    execSync('git add -A', opts);
    execSync('git commit -m "add bom"', opts);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('8. 基线存在翻转 → 红（CI 复判面：base 无 BOM vs HEAD 有 BOM）', () => {
    const v = scanBomDrift(repo, { base: beforeSha });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]?.direction).toBe('added');
    expect(v.issues[0]?.file).toBe('a.ts');
  });

  it('9. 基线无翻转 → 绿（两 commit 均无 BOM，内容改动不误伤）', () => {
    execSync(`git reset -q --hard ${beforeSha}`, { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// base（微调）\n', 'utf8');
    execSync('git add -A', { cwd: repo });
    execSync('git commit -q -m tweak', { cwd: repo });
    const v = scanBomDrift(repo, { base: beforeSha });
    expect(v.issues).toHaveLength(0);
    expect(v.scanned).toBe(1);
  });

  it('9b. ⑥-补3：base 面含基线外文件（HEAD 新增）⇒ 排除、stderr 零输出（排除≠失败）', () => {
    execSync(`git reset -q --hard ${beforeSha}`, { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// base\n', 'utf8');
    writeFileSync(join(repo, 'brand-new.ts'), '\uFEFF// HEAD 新增、带 BOM\n', 'utf8');
    execSync('git add -A', { cwd: repo });
    execSync('git commit -q -m "add new file with bom"', { cwd: repo });
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REAL_ROOT, 'tools', 'audit', 'bom-drift.ts'), '--root', repo, '--base', beforeSha],
      // ⑥-补5：显式带 CI=true——CI 与本机走同一条路（今晚"本机绿 CI 红"那类的防回归）
      { cwd: REAL_ROOT, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
    );
    expect(r.status).toBe(0);
    // ⑥-补3 的语义：基线外文件的 git fatal 不许喷进闸日志（stdio 拦截）——
    // 断 stderr 不含 fatal（npx/node 链自身可能留空行杂音，零字节断言过脆）。
    expect(r.stderr ?? '').not.toContain('fatal:');
    expect(r.stdout ?? '').toContain('通过');
    expect(r.stdout ?? '').not.toContain('brand-new.ts'); // HEAD 新增文件被排除、不被判
  });

  it('18. ⑥-补4：--root 缺值 ⇒ exit 2＋用法提示，不崩栈', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REAL_ROOT, 'tools', 'audit', 'bom-drift.ts'), '--root'],
      { cwd: REAL_ROOT, encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr ?? '').toContain('用法:');
    expect(r.stderr ?? '').toContain('--root');
  });

  it('19. ⑥-补4：--base 缺值 ⇒ exit 2＋用法提示，不静默回落、不崩栈', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(REAL_ROOT, 'tools', 'audit', 'bom-drift.ts'), '--base'],
      { cwd: REAL_ROOT, encoding: 'utf8' },
    );
    expect(r.status).toBe(2);
    expect(r.stderr ?? '').toContain('用法:');
    expect(r.stderr ?? '').toContain('--base');
  });

  it('20. ⑦-补3：--root 指非 git 目录 ⇒ 任何模式（work／CI na／CI base／--base／--dry-run）都 exit 2——root 合法性先于基线可达性，拒绝文案一行不喷栈', () => {
    // ⑦-补3（CI run 43678777228/43679288904 连红收口）：夹具前提不许依赖 tmpdir 的位置运气
    //——runner 上 tmp 的祖先可能含 .git ⇒ 预检通过 ⇒ 走 work 面 ⇒ 假绿 exit 0。
    // 用 GIT_CEILING_DIRECTORIES 把 ceiling 圈死在 nonGit 的父目录，两环境确定成立。
    const parent = mkdtempSync(join(tmpdir(), 'nongit-parent-'));
    const nonGit = join(parent, 'nongit-x');
    mkdirSync(nonGit);
    try {
      // 夹具自证：带 ceiling 时该目录必须真的不在工作树内；不成立判红并写明，禁止 skip
      const probe = spawnSync('git', ['-C', nonGit, 'rev-parse', '--is-inside-work-tree'], {
        cwd: REAL_ROOT,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: parent },
      });
      const fixtureOk = probe.status !== 0;
      expect(
        fixtureOk,
        `夹具环境不成立：GIT_CEILING_DIRECTORIES=${parent} 下 rev-parse RC=${probe.status}、stdout=${JSON.stringify(probe.stdout)}——nonGit 落进了 git 树内，测试前提被破坏（不 skip、判红）`,
      ).toBe(true);
      // 六格全跑：work／CI na（无基线）／CI base（env 有值）／CI base（argv --base）／
      // 非 CI base（argv）／--dry-run 组合——「任何模式都先 exit 2」是排序语义的锁
      const cases: { label: string; args: string[]; env: Record<string, string | undefined> }[] = [
        { label: 'work', args: [], env: { ...process.env, GIT_CEILING_DIRECTORIES: parent } },
        { label: 'CI na', args: [], env: { ...process.env, CI: 'true', GIT_CEILING_DIRECTORIES: parent } },
        { label: 'CI base(env)', args: [], env: { ...process.env, CI: 'true', BOM_BASE: 'HEAD', GIT_CEILING_DIRECTORIES: parent } },
        { label: 'CI base(argv)', args: ['--base', 'HEAD~1'], env: { ...process.env, CI: 'true', GIT_CEILING_DIRECTORIES: parent } },
        { label: 'work base(argv)', args: ['--base', 'HEAD~1'], env: { ...process.env, GIT_CEILING_DIRECTORIES: parent } },
        { label: 'dry-run', args: ['--dry-run'], env: { ...process.env, GIT_CEILING_DIRECTORIES: parent } },
      ];
      for (const c of cases) {
        const r = spawnSync(
          process.execPath,
          ['--import', 'tsx', join(REAL_ROOT, 'tools', 'audit', 'bom-drift.ts'), '--root', nonGit, ...c.args],
          { cwd: REAL_ROOT, encoding: 'utf8', env: c.env as NodeJS.ProcessEnv },
        );
        // 失败即自证：status／stdout／stderr 全文＋两枚 git 真值探针的 rc，红时日志直接给出根因
        const topoRc = spawnSync('git', ['-C', nonGit, 'rev-parse', '--show-toplevel'], {
          cwd: REAL_ROOT, encoding: 'utf8', env: c.env as NodeJS.ProcessEnv,
        }).status;
        const insideRc = spawnSync('git', ['-C', nonGit, 'rev-parse', '--is-inside-work-tree'], {
          cwd: REAL_ROOT, encoding: 'utf8', env: c.env as NodeJS.ProcessEnv,
        }).status;
        const diag = `[${c.label}] status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)} show-toplevel RC=${topoRc} is-inside RC=${insideRc} ceiling=${parent}`;
        expect(r.status, `非 git root 应任何模式都 exit 2 拦截: ${diag}`).toBe(2);
        const errLines = (r.stderr ?? '').split('\n').filter((l) => l.trim().length > 0);
        expect(errLines.length, `stderr 应恰 1 行拒绝文案: ${diag}`).toBe(1);
        expect(r.stderr ?? '', `应含拒绝文案且不喷栈: ${diag}`).toContain('不在 git 工作树内');
        expect(r.stderr ?? '', `不许喷 node 栈: ${diag}`).not.toContain('node:internal');
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('22. ⑦-补3 之 5：--root 指 git 树内但无 HEAD 的空仓 ⇒ exit 2＋一行文案，不裸抛喷栈', () => {
    const solo = mkdtempSync(join(tmpdir(), 'bomdrift-emptyrepo-'));
    const opts = { cwd: solo, encoding: 'utf8' } as const;
    execSync('git init', opts); // 空仓：树内（is-inside=true）但无 HEAD
    try {
      const r = spawnSync(
        process.execPath,
        ['--import', 'tsx', join(REAL_ROOT, 'tools', 'audit', 'bom-drift.ts'), '--root', solo],
        { cwd: REAL_ROOT, encoding: 'utf8' },
      );
      const diag = `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`;
      expect(r.status, `空仓应 exit 2 而非裸抛喷栈: ${diag}`).toBe(2);
      const errLines = (r.stderr ?? '').split('\n').filter((l) => l.trim().length > 0);
      expect(errLines.length, `stderr 应恰 1 行: ${diag}`).toBe(1);
      expect(r.stderr ?? '').toContain('没有 HEAD');
      expect(r.stderr ?? '').not.toContain('node:internal');
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  it('10. 回落链：BOM_BASE 全零 → HEAD~1（仍能判）', () => {
    execSync(`git reset -q --hard ${beforeSha}`, { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '\uFEFF// base\n', 'utf8');
    execSync('git add -A', { cwd: repo });
    execSync('git commit -q -m "add bom again"', { cwd: repo });
    const base = resolveBase(repo, '0'.repeat(40));
    expect(base).toBe('HEAD~1');
    const v = scanBomDrift(repo, { base: base! });
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0]?.direction).toBe('added');
  });

  it('11. 无父提交（单 commit 仓）→ resolveBase undefined ⇒ scanned=0 语义内空', () => {
    const solo = mkdtempSync(join(tmpdir(), 'bomdrift-solo-'));
    const opts = { cwd: solo, encoding: 'utf8' } as const;
    execSync('git init', opts);
    execSync('git config user.email t@t', opts);
    execSync('git config user.name t', opts);
    writeFileSync(join(solo, 'a.ts'), '// only\n', 'utf8');
    execSync('git add -A', opts);
    execSync('git commit -m only', opts);
    expect(resolveBase(solo, '0'.repeat(40))).toBeUndefined();
    const v = scanBomDrift(solo, { base: undefined });
    expect(v.issues).toHaveLength(0);
    expect(v.scanned).toBe(0);
    rmSync(solo, { recursive: true, force: true });
  });
});

// ── ⑥-补（群PM 判据）：判据面决策纯函数 ──────────────────────────────────────────────
describe('bom-drift · decideBomFace（⑥-补，CI 必跑）', () => {
  it('12. GHOST 态（BOM_BASE 全零，新分支首推）⇒ mode=na（缺失≠干净，不许打「通过」）', () => {
    const v = decideBomFace({ CI: 'true', BOM_BASE: '0'.repeat(40) });
    expect(v.mode).toBe('na');
    expect(v.reason).toContain('缺失≠干净');
  });

  it('13. CI ＋ BOM_BASE 有值 ⇒ mode=base（复判面；对象可达性由 resolveBase 后判）', () => {
    const v = decideBomFace({ CI: 'true', BOM_BASE: '43660126937' });
    expect(v.mode).toBe('base');
  });

  it('14. 本机（非 CI、无 env）⇒ 仍 work 面（回落链不许吃掉本机射程）', () => {
    expect(decideBomFace({}).mode).toBe('work');
    expect(decideBomFace(undefined).mode).toBe('work');
    expect(decideBomFace({ CI: undefined, BOM_BASE: undefined }).mode).toBe('work');
  });

  it('15. ⑥-补2：非 CI ＋ argv --base ⇒ mode=base（显式开关不许被静默吞）', () => {
    const v = decideBomFace({}, ['--base', 'HEAD~1']);
    expect(v.mode).toBe('base');
    expect(v.baseRaw).toBe('HEAD~1');
  });

  it('16. ⑥-补2：非 CI 无参数 ⇒ work 面（对照）', () => {
    expect(decideBomFace({}, []).mode).toBe('work');
    expect(decideBomFace({}, []).baseRaw).toBeUndefined();
  });

  it('20. ⑥-补5：CI ＋ argv --base ⇒ base（环境默认值不得吞掉显式意图——今日 CI 红的靶）', () => {
    const v = decideBomFace({ CI: 'true' }, ['--base', 'HEAD~1']);
    expect(v.mode).toBe('base');
    expect(v.baseRaw).toBe('HEAD~1');
  });

  it('21. ⑥-补5：CI ＋ argv --base 优先于 env BOM_BASE（双给时 argv 赢）', () => {
    const v = decideBomFace({ CI: 'true', BOM_BASE: '43660126937' }, ['--base', 'HEAD~1']);
    expect(v.mode).toBe('base');
    expect(v.baseRaw).toBe('HEAD~1');
  });
});