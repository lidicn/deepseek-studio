// 宿主单文件打包：src/api/main.ts → src-tauri/host/main.mjs（ESM，platform=node）。
//
// TD-04（发版阻断）为什么要这个产物：
//   旧路径是 sidecar 直接跑 `node ./node_modules/tsx/dist/cli.mjs src/api/main.ts`，
//   它要求**目标机**同时具备 ① PATH 里有 node ② 安装目录里有 node_modules/tsx。
//   `tsx` 在 package.json 的 devDependencies 里，打包安装时根本不会带过去 → 安装版起不来宿主。
//   本脚本把整棵宿主依赖图打成**一个 mjs 文件**，装进 Tauri 资源里随包分发。
//
// 产物落位：
//   - `src-tauri/host/main.mjs` —— 打包源，由 tauri.conf.json 的 bundle.resources 映射进安装包；
//   - `src-tauri/target/debug/host/main.mjs` —— dev 态同步副本（与 esbuild.inject.mjs 同一套路）。
//
// 静态资源（agent.html/css/webmanifest/sw/icon、dist/agent-panel.js）**不进这个文件**：
//   它们由 bundle.resources 以「与仓库根同构」的目录结构随包分发，宿主运行时用
//   STUDIO_RESOURCE_ROOT（sidecar 传入 = Tauri resource_dir()）当资源根去找，
//   路径结构与开发树完全一致（<res>/src/ui/agent.html、<res>/dist/agent-panel.js）。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outfile = path.join(__dirname, 'src-tauri/host/main.mjs');
fs.mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(__dirname, 'src/api/main.ts')],
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
});

const bytes = fs.statSync(outfile).size;
console.log(`[host] bundled → ${outfile} (${bytes} B)`);

// dev 态同步：tauri dev 的工作目录是 target/debug/，sidecar 在 dev 下也走资源目录。
const debugHostDir = path.join(__dirname, 'src-tauri/target/debug/host');
if (fs.existsSync(path.dirname(debugHostDir))) {
  fs.mkdirSync(debugHostDir, { recursive: true });
  fs.copyFileSync(outfile, path.join(debugHostDir, 'main.mjs'));
  console.log(`[host] synced to ${debugHostDir}`);
}
