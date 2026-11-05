/**
 * tests/desktop/tools-entry-freshness.test.ts
 * tools/audit/entry-freshness.cjs 的正负控回归（不进 run.ts，仅窄面跑）。
 *
 * 硬约束（Studio-PM 2026-11-06 批定口径）：
 * - 全程永不篡改跟踪产物 src-tauri/inject/entry.js：负控走 `--tracked <临时副本>`，
 *   篡改只发生在临时副本上，跑完即删（afterAll 兜底 force-clean）；
 * - 零 git 写命令（checkout / restore / stash / apply 一个都不出现）；
 * - 正控为动态断言：闸自报指纹 == 实核 sha8(TRACKED)，不硬编码字面量
 *   （define 注入随版本号变，字面量每次发版必红 —— Studio-PM 2026-11-06 裁定）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'audit', 'entry-freshness.cjs');
const TRACKED = path.join(ROOT, 'src-tauri', 'inject', 'entry.js');
const TMP = os.tmpdir();

function runGate(trackedPath?: string): { code: number; output: string } {
  const args = trackedPath ? `--tracked "${trackedPath}"` : '';
  try {
    const stdout = execSync(`node "${SCRIPT}" ${args}`, {
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

function sha8(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8).toUpperCase();
}

function tmpCopy(): string {
  const p = path.join(TMP, `entry-freshness-copy-${process.pid}-${Date.now()}.js`);
  fs.copyFileSync(TRACKED, p);
  return p;
}

describe('tools/audit/entry-freshness.cjs 正负控', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const p of scratch) {
      try { fs.rmSync(p, { force: true }); } catch { /* 兜底删，忽略 */ }
    }
  });

  it('正控：默认跟踪产物 → exit 0，闸自报指纹 == 实核 sha256（动态断言，永不篡改跟踪文件）', () => {
    const r = runGate();
    expect(r.code, `正控应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('[entry-freshness] PASS');
    // 为什么不用字面量指纹：define 注入随 package.json 版本号变（0.14.6→0.14.7 即换代），
    // 字面量每发一次版必红，给 CI 埋定时炸弹。字节一致性由闸本身负责（重建==跟踪才 PASS），
    // 这里只断言「闸如实比对并报出了正确文件的指纹」。
    const printed = /\[entry-freshness\] PASS \(([0-9A-F]{8})\)/.exec(r.output)?.[1];
    expect(printed, `闸输出未含指纹，实际输出：${r.output}`).toBeTruthy();
    expect(printed).toBe(sha8(TRACKED));
  });

  it('--tracked 干净副本 → exit 0（参数生效、比对逻辑不变）', () => {
    const copy = tmpCopy();
    scratch.push(copy);
    const r = runGate(copy);
    expect(r.code, `干净副本应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('[entry-freshness] PASS');
  });

  it('负控：--tracked 篡改副本 → exit 1（改前拦不住、改后拦得住；跟踪产物零触碰）', () => {
    const copy = tmpCopy();
    scratch.push(copy);
    fs.appendFileSync(copy, '\n//[entry-freshness-tamper-probe]');
    const r = runGate(copy);
    expect(r.code, `篡改副本应 exit 1，实际输出：${r.output}`).toBe(1);
    expect(r.output).toContain('[entry-freshness] FAIL');
  });
});
