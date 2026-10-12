// 注入脚本单文件打包：src/desktop/entry.ts → src-tauri/inject/entry.js（IIFE，浏览器，无外部依赖）。
// 由 tauri.conf 的 beforeDevCommand / beforeBuildCommand 调用，产物供 main.rs include_str! 注入。
// M1：同时打包智能体面板前端 src/ui/agent-panel.ts → dist/agent-panel.js（供 /agent.js 服务）。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ['src/desktop/entry.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'src-tauri/inject/entry.js',
  logLevel: 'info',
});

// 自动同步到 Tauri debug 运行时目录（工作目录是 target/debug/）
const debugInjectDir = path.join(__dirname, 'src-tauri/target/debug/inject');
if (fs.existsSync(path.dirname(debugInjectDir))) {
  fs.mkdirSync(debugInjectDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'src-tauri/inject/entry.js'), path.join(debugInjectDir, 'entry.js'));
  console.log(`[inject] synced to ${debugInjectDir}`);
}

await build({
  entryPoints: [path.join(__dirname, 'src/ui/agent-panel.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'dist/agent-panel.js',
  logLevel: 'info',
});
