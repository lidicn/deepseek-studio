/**
 * tests/desktop/tools-lineend-guard.test.ts — lineend-guard 正负控回归（不进 run.ts 步数口径，仅窄面跑）。
 *
 * 正控：本仓（HEAD 已全 LF）跑 → exit 0。
 * 负控：临时仓无 text=auto 声明、autocrlf=false → CRLF 文本文件原样进 index（i/crlf）→ exit 1 + 点名。
 * 豁免：临时仓声明 `*.bin -text`（binary）→ CRLF 的 .bin 文件 i/crlf 但豁免 → exit 0（不硬编码扩展名）。
 *
 * 注：本仓 `.gitattributes:4` 的 `* text=auto eol=lf` 会让 git add 时把文本文件归一化成 LF 进 index，
 * 故「文本文件 i/crlf」在本仓正常情况下不会出现；i/crlf 只发生在未声明 text=auto 或声明 -text/binary 的文件上。
 * 本测试用「无 text=auto 的临时仓」造 i/crlf 负控，验证断言机制生效。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'audit', 'lineend-guard.ts');

function runGuard(rootPath: string): { code: number; output: string } {
  try {
    const stdout = execSync(`npx tsx "${SCRIPT}" --root "${rootPath}"`, {
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

function mkTempRepo(gitattributes?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineend-guard-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config core.autocrlf false', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  if (gitattributes !== undefined) fs.writeFileSync(path.join(dir, '.gitattributes'), gitattributes);
  return dir;
}

describe('tools/audit/lineend-guard 正负控', () => {
  const scratch: string[] = [];
  afterAll(() => { for (const p of scratch) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } } });

  it('正控：本仓跑 → exit 0（index 侧全 LF）', () => {
    const r = runGuard(ROOT);
    expect(r.code, `正控应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('[lineend-guard] PASS');
  });

  it('负控：临时仓无 text=auto、CRLF 文本原样进 index → exit 1 + 点名该文件', () => {
    const dir = mkTempRepo(); scratch.push(dir);
    fs.writeFileSync(path.join(dir, 'bad.txt'), 'a\r\nb\r\n');
    execSync('git add bad.txt', { cwd: dir });
    const r = runGuard(dir);
    expect(r.code, `负控应 exit 1，实际输出：${r.output}`).toBe(1);
    expect(r.output).toContain('[lineend-guard] FAIL');
    expect(r.output).toContain('bad.txt');
  });

  it('豁免：.gitattributes 声明 *.bin -text → CRLF 的 .bin 文件 i/crlf 但豁免 → exit 0', () => {
    const dir = mkTempRepo('*.bin -text\n'); scratch.push(dir);
    fs.writeFileSync(path.join(dir, 'data.bin'), 'x\r\ny\r\n');
    execSync('git add .gitattributes data.bin', { cwd: dir });
    const r = runGuard(dir);
    expect(r.code, `豁免应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('[lineend-guard] PASS');
  });
});
