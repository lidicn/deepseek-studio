// 注入脚本单文件打包：src/desktop/entry.ts → src-tauri/inject/entry.js（IIFE，浏览器，无外部依赖）。
// 由 tauri.conf 的 beforeDevCommand / beforeBuildCommand 调用，产物供 main.rs include_str! 注入。
// M1：同时打包智能体面板前端 src/ui/agent-panel.ts → dist/agent-panel.js（供 /agent.js 服务）。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 版本真值注入（2026-11-05 假路径卡）：读 package.json 的 version（单一真源，
// 与 tauri.conf.json 同源——发版流的三向版本一致性校验守着它），经 esbuild define
// 变成编译期常量 `__STUDIO_APP_VERSION__`。UI 侧设置面板的版本行读它（产物里是真实
// 版本号，如 0.14.6）；dev 树/单测无 define → typeof 守卫兜底 'unknown'。
// **禁止在 UI 里手写版本常量**（v1.0.0 曾随安装版打进产物，用户看到假版本）。
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

await build({
  entryPoints: ['src/desktop/entry.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'src-tauri/inject/entry.js',
  logLevel: 'info',
  minify: true,
  define: {
    __STUDIO_APP_VERSION__: JSON.stringify(String(pkg.version)),
  },
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
  minify: true,
});
