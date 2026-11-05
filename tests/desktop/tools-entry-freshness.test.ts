/**
 * tests/desktop/tools-entry-freshness.test.ts
 * tools/audit/entry-freshness.cjs 的正负控回归（不进 run.ts，仅窄面跑）。
 *
 * 硬约束（Studio-PM 2026-11-06 批定口径）：
 * - 全程文件级 copy/restore：底本先 copy 到 os.tmpdir()，篡改后从底本 copy 回原样；
 * - 零 git 写命令（checkout / restore / stash / apply 一个都不出现）——
 *   本仓「git checkout -- . 丢过未提交改动」是用户红线；
 * - 还原收尾必须实核：跟踪文件与底本字节相等 + sha256 前 8 位指纹回到已知值。
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
const BACKUP = path.join(os.tmpdir(), `entry-freshness-base-${process.pid}.js`);
// 2026-11-05 产物同步时闸打印的 sha256 前 8 位指纹（`[entry-freshness] PASS (…)`)。
const FINGERPRINT = '7D889328';

function runGate(): { code: number; output: string } {
  try {
    const stdout = execSync(`node "${SCRIPT}"`, {
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

describe('tools/audit/entry-freshness.cjs 正负控', () => {
  afterAll(() => {
    // 兜底还原：无论断言在何处失败，收尾时跟踪文件必须与底本字节一致（文件级 copy，零 git 命令）。
    if (fs.existsSync(BACKUP)) {
      if (!fs.readFileSync(TRACKED).equals(fs.readFileSync(BACKUP))) {
        fs.copyFileSync(BACKUP, TRACKED);
      }
      fs.rmSync(BACKUP, { force: true });
    }
  });

  it('正控：干净树跑闸 → exit 0，指纹 = 已知值', () => {
    fs.copyFileSync(TRACKED, BACKUP); // 底本 = 跑测试那一刻的跟踪产物
    const r = runGate();
    expect(r.code, `正控应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('[entry-freshness] PASS');
    expect(sha8(TRACKED)).toBe(FINGERPRINT);
  });

  it('负控：篡改跟踪产物 → exit 1（改前拦不住、改后拦得住的红证）', () => {
    expect(fs.existsSync(BACKUP), '底本应在正控用例中建立').toBe(true);
    try {
      fs.appendFileSync(TRACKED, '\n//[entry-freshness-tamper-probe]');
      const r = runGate();
      expect(r.code, `篡改后应 exit 1，实际输出：${r.output}`).toBe(1);
      expect(r.output).toContain('[entry-freshness] FAIL');
    } finally {
      fs.copyFileSync(BACKUP, TRACKED); // 文件级还原，无任何 git 写命令
    }
  });

  it('还原转绿：copy 回底本 → exit 0，且字节与底本一致、指纹回到已知值', () => {
    const r = runGate();
    expect(r.code, `还原后应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(fs.readFileSync(TRACKED).equals(fs.readFileSync(BACKUP))).toBe(true);
    expect(sha8(TRACKED)).toBe(FINGERPRINT);
  });
});
