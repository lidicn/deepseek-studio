/**
 * tests/desktop/tools-workflow-pwsh-compile.test.ts
 * tools/audit/workflow-pwsh-compile.cjs 的正负控回归（照抄 tools-entry-freshness.test.ts 的形态）。
 *
 * 为什么有这枚（2026-11-10 现场）：v0.14.14 的 Release run 里 step 9「Fetch missing tauri
 * packaging tools」**只活了 1 秒**就 failure —— 三行 `Write-Host "... attempt $attempt: ..."`
 * 让 PowerShell 把 `$attempt:` 当成 `$驱动器:变量` 语法，**解析期整块编译失败、一行都没跑**。
 * 而 compose 测试只做子串/位置断言、`npm run gate` 15 步里没有"workflow 内嵌脚本可解析"，
 * 于是**闸绿、CI 绿，只有真 runner 红**。这条闸就是补这个洞。
 *
 * 硬约束：
 * - 负控只篡改**临时副本目录**（`--dir <tmp>`），真实 workflow 零触碰；跑完 afterAll 兜底删；
 * - 零 git 写命令；
 * - 正控要断言 `blocksParsed > 0`（防空跑假绿：一个块都没抽到也会"0 错误"）；
 * - 抽块规则按 shell 判：显式 `shell: pwsh` 的块 + 未声明 shell 的 windows runner 步；
 *   显式 bash/sh 的跳过（把 bash 喂 PowerShell 解析器＝必假红）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'audit', 'workflow-pwsh-compile.cjs');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

function runAudit(dir?: string): { code: number; output: string } {
  // `--dir` 语义（Gate 2026-11-10 定）：直接指向含 *.yml 的目录，不再要求 .github/workflows 结构。
  const args = [SCRIPT];
  if (dir) args.push('--dir', dir);
  try {
    const stdout = execFileSync('node', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('tools/audit/workflow-pwsh-compile.cjs 正负控', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const p of scratch) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 兜底删，忽略 */ }
    }
  });

  // 审计脚本单次约 23 s（node 启动 + yaml 解析 + 21 块真解析），三枚 it 共用一次正控结果，
  // 否则白跑 46 s。负控走 --dir 平铺副本，只调一次。
  let base: { code: number; output: string } | null = null;
  function baseRun(): { code: number; output: string } {
    if (!base) base = runAudit();
    return base;
  }

  it('正控：真树全部 pwsh 块可被真解析器解析 → exit 0，且 blocksParsed > 0', () => {
    const r = baseRun();
    expect(r.code, `审计脚本应 exit 0，实际 ${r.code}\n${r.output}`).toBe(0);
    // 防空跑假绿：一个块都没抽到也会"0 错误"。
    const m = /blocksParsed\s*=\s*(\d+)/.exec(r.output);
    expect(m, `输出里没有 blocksParsed=N\n${r.output}`).not.toBeNull();
    expect(Number(m![1]), 'blocksParsed 必须 > 0（否则是没抽到块，不是解析通过）').toBeGreaterThan(0);
}, 120_000);

  it('负控：副本里把 `${attempt}:` 拆回 `$attempt:` → exit 1，且报错带文件名与行号', () => {
    const dir = path.join(os.tmpdir(), `wf-pwsh-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    scratch.push(dir);
    // --dir 直接读该目录下的 *.yml（平铺，不建 .github/workflows 结构）。
    for (const f of fs.readdirSync(WF_DIR)) {
      if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
      fs.copyFileSync(path.join(WF_DIR, f), path.join(dir, f));
    }
    const target = path.join(dir, 'release.yml');
    const src = fs.readFileSync(target, 'utf8');
    // 只改一处：把合法的 ${attempt}: 还原成会触发 InvalidVariableReferenceWithDrive 的形态。
    const mutated = src.replace('${attempt}:', '$attempt:');
    expect(mutated, '副本里没找到 `${attempt}:` —— 负控前提不成立（实现可能已改写法）').not.toBe(src);
    fs.writeFileSync(target, mutated, 'utf8');

    const r = runAudit(dir);
    expect(r.code, `篡改后应 exit 1，实际 ${r.code}\n${r.output}`).toBe(1);
    // 必须红在"语法错"上，不能红在"目录找不到"上（后者是假负控）。
    expect(r.output, '负控红在别的原因上（找不到目录/文件），不是解析失败').not.toMatch(/not found at/);
    // 报错必须可复盘——锁**整段自有结构**（PM 2026-11-11 G-1 裁定；G-c 2026-11-11 加 UI=N+1 双标）：
    // 真格式＝`[workflow-pwsh-compile] release.yml step#8（UI=9）: L26: <解析器消息>`
    // 前缀/文件名/step 号/UI 号/行号**全是我们自己的标记**（语言无关），解析器消息只在末尾当附带信息。
    // 以前锁的是解析器原文（中文正则）⇒ CI runner 报英文必红（G-1 事故）。**任何语言串都不许锁。**
    expect(
      r.output,
      `报错缺"自有结构整段"（应为 [workflow-pwsh-compile] <file> step#N（UI=N+1）: LN: <msg>），实际输出：${r.output}`,
    ).toMatch(/\[workflow-pwsh-compile\]\s+\S*release\.ya?ml\s+step#\d+（UI=\d+）:\s*L\d+:\s*\S/);
    // 报错行数 ≥ 1（与上面同源，但独立成格：结构对了却一行都没报，说明筛掉了真错误）
    const errLines = r.output.split(/\r?\n/).filter((l) => /\[workflow-pwsh-compile\].*step#\d+（UI=\d+）:/.test(l));
    expect(errLines.length, '报错行数应 ≥1').toBeGreaterThanOrEqual(1);
}, 120_000);

  it('反误伤：含 shell: bash 的块必须被跳过（blocksSkipped >= 1 且 exit 0）', () => {
    // 零信息断言的修法（PM 2026-11-10 改令③）：当前树里 bash 步是 uses: 不是 run:，
    // 所以 blocksSkipped 恒为 0 —— 锁"字段存在"永远绿、抓不住任何变异。
    // 造一枚合成 workflow（shell: bash + pwsh 解析不了的写法），证明"bash 块被跳过、没被误伤"。
    const dir = path.join(os.tmpdir(), `wf-bash-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    scratch.push(dir);
    for (const f of fs.readdirSync(WF_DIR)) {
      if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
      fs.copyFileSync(path.join(WF_DIR, f), path.join(dir, f));
    }
    // bash 专属写法：[[ ]] ＋ $? —— 喂给 PowerShell 解析器必报错；被跳过则 exit 0。
    const synth = [
      'name: synthetic',
      'on: [push]',
      'jobs:',
      '  s:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: bash-only syntax',
      '        shell: bash',
      '        run: |',
      '          if [[ -n "$x" ]] && echo $?; then',
      '            echo ok',
      '          fi',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'synthetic-bash.yml'), synth, 'utf8');

    const r = runAudit(dir);
    expect(r.code, `含 bash 块的合成目录应 exit 0（bash 被跳过），实际 ${r.code}\n${r.output}`).toBe(0);
    const m = /blocksSkipped\s*=\s*(\d+)/.exec(r.output);
    expect(m, `输出里没有 blocksSkipped=N\n${r.output}`).not.toBeNull();
    expect(Number(m![1]), 'blocksSkipped 必须 >= 1 —— 合成 bash 块没被计数，说明判据没信息量').toBeGreaterThanOrEqual(1);
}, 120_000);

  it('G-b 契约：编译脚本临时文件名含 pid＋时间戳（EBUSY 缓解不退化）', () => {
    const src = fs.readFileSync(SCRIPT, 'utf-8');
    expect(src, '临时文件名缺 process.pid（EBUSY 同名冲突会复发）').toContain('process.pid');
    expect(src, '临时文件名缺 Date.now()（EBUSY 同名冲突会复发）').toContain('Date.now()');
    expect(src, '临时文件名缺 os.tmpdir()').toContain('os.tmpdir()');
    expect(src, '临时名未提为公共函数 tmpPwshPath').toContain('tmpPwshPath');
  });
});
