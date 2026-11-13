// 宿主打包选项单一真源（2026-11-13 host-freshness 派卡判据②）：
// esbuild.host.mjs（构建脚本）与 tools/audit/host-freshness.mjs（新鲜度闸）都从这里取
// build 选项——两份各写一遍，将来改 external/banner 时闸会假绿（与 entry-freshness
// 单源化同一教训：esbuild.inject.mjs 曾与闸里复刻的参数漂移）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 宿主打包入口（与 esbuild.host.mjs 原值一致）。 */
export const HOST_ENTRY = path.join(__dirname, '..', 'src', 'api', 'main.ts');

/**
 * 宿主 bundle 的 esbuild 选项（outfile 入参化）。
 * 选项本体从 esbuild.host.mjs L27-49 原样迁移，注释随迁；改这里＝同时改构建与闸。
 */
export function hostBuildOptions(outfile) {
  return {
    entryPoints: [HOST_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    // 宿主 engines 要求 node >= 24；这里目标压到 node20 保证字节码更保守。
    target: 'node20',
    outfile,
    sourcemap: false,
    minify: false,
    // ws 的可选原生加速（bufferutil / utf-8-validate）：装了就用、没装 ws 内部自己
    // try/catch 回退 JS 实现。原生模块**不能**打进单文件，故 external。
    // banner 注入的 require 让 esbuild 生成的 __require 走真实 require
    // （ESM 输出里 __require 本来会抛 "Dynamic require of ... is not supported"）。
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
      js: [
        "import { createRequire as __dshCreateRequire } from 'node:module';",
        'const require = __dshCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'info',
  };
}
