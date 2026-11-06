/**
 * tests/desktop/tools-rust-path-guard.test.ts — rust-path-guard 正负控回归。
 *
 * 判据（裁定四十 修正后口径）：src-tauri/src 递归全部 .rs 里 `.join(".config")` 只允许出现在
 * ① 注释行 ② `fn resolve_config_dir` 函数体内（全仓唯一入口）③ `#[cfg(test)]` 测试断言。
 *
 * 先红后绿（真树实测，20261106）：b147ca5（P0 卡修复前）红 3 处（main.rs:479/:532/:825，含 P1 路
 * 径漂移行 :532——注意：今日 P0 根因是首启竞态，:532 的定性是 P1 路径漂移，裁定五十一 §四）；
 * HEAD（ee4b149）绿（2 处命中全豁免）。本文件用临时 .rs 复现同一机制：
 * 负控 = 越区硬编码必红并点名；豁免 = 唯一入口体内 / 注释 / 单测断言三态全绿。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'audit', 'rust-path-guard.ts');

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

function mkTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-path-guard-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('tools/audit/rust-path-guard 正负控', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const p of scratch) fs.rmSync(p, { recursive: true, force: true });
  });

  it('正控：本仓 HEAD → exit 0（2 处命中全豁免：注释 + 唯一入口 dev 分支）', () => {
    // 与闸缺省同域：只扫 src-tauri/src（递归），不扫整仓（仓库里别的 .rs 不归本判据）
    const r = runGuard(path.join(ROOT, 'src-tauri', 'src'));
    expect(r.code, `正控应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('[rust-path-guard] PASS');
  });

  it('负控：越区硬编码（普通函数体内）→ exit 1 + 点名文件与行', () => {
    const dir = mkTempRepo({
      'src-tauri/src/fake.rs': [
        'fn load_grant_script() -> String {',
        '    let home = dirs::home_dir().unwrap();',
        '    let p = home.join(".config").join("deepseek-studio");', // ← 越区硬编码（P1 路径漂移形状）
        '    std::fs::read_to_string(p.join("config.json")).unwrap_or_default()',
        '}',
      ].join('\n'),
    });
    scratch.push(dir);
    const r = runGuard(dir);
    expect(r.code, `负控应 exit 1，实际输出：${r.output}`).toBe(1);
    expect(r.output).toContain('[rust-path-guard] FAIL');
    expect(r.output).toContain('fake.rs');
    expect(r.output).toContain('deepseek-studio');
  });

  it('豁免三态：唯一入口体内 / 注释行 / #[cfg(test)] 断言 → 全绿', () => {
    const dir = mkTempRepo({
      'src-tauri/src/ok.rs': [
        '/// 文档注释里提到 .join(".config") 也不算违规（注释行豁免）。',
        'fn resolve_config_dir(packaged: bool) -> std::path::PathBuf {',
        '    if packaged {',
        '        return std::path::PathBuf::from("/data/config");',
        '    }',
        '    dirs::home_dir().unwrap().join(".config").join("deepseek-studio")', // ← 唯一入口体内，豁免
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn shape() {',
        '        let p = std::path::PathBuf::from(".").join(".config");', // ← 单测断言区，豁免
        '        assert!(p.ends_with(".config"));',
        '    }',
        '}',
      ].join('\n'),
    });
    scratch.push(dir);
    const r = runGuard(dir);
    expect(r.code, `豁免三态应 exit 0，实际输出：${r.output}`).toBe(0);
    expect(r.output).toContain('[rust-path-guard] PASS');
  });
});
