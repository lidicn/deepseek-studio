/**
 * tools/audit/empty-files.ts — 检查 0 字节空文件（防 P0）
 *
 * 审计发现：两个项目都栽在「核心源文件 0 字节」上，靠运行时报错才发现。
 * 一行检查能防住。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const skipDirs = new Set(['node_modules', '.git', 'dist', 'target', '.output', 'coverage', 'logs']);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (skipDirs.has(e)) continue;
    const full = join(dir, e);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, out);
      } else if (st.size === 0 && /\.(ts|tsx|js|mjs|json|md)$/.test(e)) {
        out.push(full.replace(root + '\\', '').replace(root + '/', ''));
      }
    } catch {
      // ignore
    }
  }
}

const empty: string[] = [];
walk(root, empty);

if (empty.length > 0) {
  console.error('❌ 发现 0 字节空文件：');
  for (const f of empty) console.error(`  ${f}`);
  process.exit(1);
} else {
  console.log('✅ 无 0 字节空文件');
}
