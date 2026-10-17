/**
 * tools/coverage/check.ts — 简易覆盖率门禁（S9）
 *
 * 不引 c8/nyc。扫描 src/host/kernel/** 和 src/host/engine/** 下每个 .ts 文件，
 * 检查它是否被某个 tests/desktop/*.test.ts import。被 import 算覆盖。
 *
 * 阈值：kernel >= 80%，engine >= 70%。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (e.endsWith(ext)) out.push(full);
  }
  return out;
}

function collectTestImports(root: string): Set<string> {
  const testDir = join(root, 'tests', 'desktop');
  const imports = new Set<string>();
  for (const f of walk(testDir, '.test.ts')) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      imports.add(m[1]);
    }
  }
  return imports;
}

function checkDir(dir: string, root: string, testImports: Set<string>): { covered: string[]; uncovered: string[]; pct: number } {
  const files = walk(dir, '.ts').filter((f) => !f.endsWith('.d.ts'));
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const f of files) {
    const rel = relative(root, f).replace(/\\/g, '/');
    // 去掉 .ts 后缀，检查测试 import 路径是否包含
    const base = rel.replace(/\.ts$/, '');
    const isCovered = [...testImports].some((imp) => {
      const impResolved = imp.replace(/^\.\.\/\.\.\//, '');
      return impResolved.includes(base) || base.includes(impResolved);
    });
    if (isCovered) covered.push(rel);
    else uncovered.push(rel);
  }
  const total = covered.length + uncovered.length;
  const pct = total > 0 ? (covered.length / total) * 100 : 100;
  return { covered, uncovered, pct };
}

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const testImports = collectTestImports(root);

  const kernel = checkDir(join(root, 'src', 'host', 'kernel'), root, testImports);
  const engine = checkDir(join(root, 'src', 'host', 'engine'), root, testImports);

  console.log('=== 覆盖率门禁（import 粗门禁）===');
  console.log(`kernel: ${kernel.pct.toFixed(1)}% (${kernel.covered.length}/${kernel.covered.length + kernel.uncovered.length})`);
  if (kernel.uncovered.length > 0) {
    for (const f of kernel.uncovered) console.log(`  未覆盖: ${f}`);
  }
  console.log(`engine: ${engine.pct.toFixed(1)}% (${engine.covered.length}/${engine.covered.length + engine.uncovered.length})`);
  if (engine.uncovered.length > 0) {
    for (const f of engine.uncovered) console.log(`  未覆盖: ${f}`);
  }

  if (kernel.pct < 80 || engine.pct < 70) {
    console.error('\n覆盖率不达标');
    process.exit(1);
  }
  console.log('\n覆盖率门禁：通过');
  process.exit(0);
}

main();
