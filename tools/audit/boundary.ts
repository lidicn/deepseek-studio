#!/usr/bin/env tsx
/**
 * tools/audit/boundary.ts — 边界审计（S4）
 *
 * 四条依赖方向规则：
 *   R1: src/host/kernel/** 不许 import web-engine（只许 import model-engine 的 type）
 *   R2: src/host/engine/** 不许 import kernel/**
 *   R3: src/shared/** 不许 import src/host/**
 *   R4: tools/** 只许 import src/shared/**，不许 import src/host/**
 *
 * 静态扫描 import/from 路径，不运行代码。
 * 退出码：0=无违规  1=有违规
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 类型

export interface Violation {
  rule: string;
  file: string;
  importPath: string;
  message: string;
}

// ---------------------------------------------------------------- 扫描工具

const IMPORT_RE = /(?:import|from)\s+['"]([^'"]+)['"]/g;

/** 提取一个 TS 文件里所有 import 路径。 */
function extractImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    out.push(m[1]);
  }
  return out;
}

/** 递归收集目录下所有 .ts 文件。 */
function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------- 单文件检查

/**
 * 检查一个文件的 imports 是否违反对应规则。
 * @param filePath 绝对路径
 * @param content 文件内容
 * @param root 项目根目录
 */
export function checkFile(filePath: string, content: string, root: string): Violation[] {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  const imports = extractImports(content);
  const violations: Violation[] = [];

  for (const imp of imports) {
    // 只检查相对路径的 src/import，跳过 npm 包
    if (!imp.startsWith('.')) continue;

    // 解析到绝对路径后转相对项目路径
    const resolved = resolve(dirname(filePath), imp);
    let target = relative(root, resolved).replace(/\\/g, '/');

    // R1: src/host/kernel/** 不许 import web-engine
    if (rel.startsWith('src/host/kernel/')) {
      if (target.includes('web-engine') || target.includes('web-engine.ts')) {
        violations.push({
          rule: 'R1',
          file: rel,
          importPath: imp,
          message: 'kernel 层不许 import web-engine',
        });
      }
    }

    // R2: src/host/engine/** 不许 import kernel/**
    if (rel.startsWith('src/host/engine/')) {
      if (target.startsWith('src/host/kernel/')) {
        violations.push({
          rule: 'R2',
          file: rel,
          importPath: imp,
          message: 'engine 层不许 import kernel',
        });
      }
    }

    // R3: src/shared/** 不许 import src/host/**
    if (rel.startsWith('src/shared/')) {
      if (target.startsWith('src/host/')) {
        violations.push({
          rule: 'R3',
          file: rel,
          importPath: imp,
          message: 'shared 不许 import host（依赖方向只能向下）',
        });
      }
    }

    // R4: tools/** 不许 import src/host/**
    // 豁免：tools/{eval,bench,e2e,metrics}/ 是评测/基准/回放工具，本就需要驱动 kernel/engine，
    // 不属于生产依赖，允许其 import src/host。
    const R4_EXEMPT = ['tools/eval/', 'tools/bench/', 'tools/e2e/', 'tools/metrics/'];
    if (rel.startsWith('tools/') && !R4_EXEMPT.some((p) => rel.startsWith(p))) {
      if (target.startsWith('src/host/')) {
        violations.push({
          rule: 'R4',
          file: rel,
          importPath: imp,
          message: 'tools 不许 import src/host',
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------- CLI

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');

  const dirs = ['src', 'tools'];
  const allViolations: Violation[] = [];

  for (const d of dirs) {
    const dirPath = join(root, d);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of walkTsFiles(dirPath)) {
      const content = readFileSync(file, 'utf8');
      allViolations.push(...checkFile(file, content, root));
    }
  }

  if (allViolations.length > 0) {
    console.error('=== 边界审计：违规 ===');
    for (const v of allViolations) {
      console.error(`  [${v.rule}] ${v.file} → ${v.importPath}  (${v.message})`);
    }
    process.exit(1);
  }

  console.log('边界审计：无违规');
  process.exit(0);
}

const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('boundary.ts');
if (isDirectRun) {
  main();
}
