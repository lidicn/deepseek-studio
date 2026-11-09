// 注入脚本单文件打包：src/desktop/entry.ts → src-tauri/inject/entry.js（IIFE，浏览器，无外部依赖）。
// 由 tauri.conf 的 beforeDevCommand / beforeBuildCommand 调用，产物供 main.rs include_str! 注入。
// M1：同时打包智能体面板前端 src/ui/agent-panel.ts → dist/agent-panel.js（供 /agent.js 服务）。
//
// 单一真源钩子（20261106 Gate 单源化）：设 STUDIO_INJECT_OUTFILE=<路径> 时，entry 产物写到该路径
// 而非 src-tauri/inject/entry.js，且跳过 agent-panel 打包与 target/debug 同步——供 entry-freshness
// 闸重建到临时文件做字节比对，参数只有本脚本一处定义（不再在闸里复刻 esbuild 参数）。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gateMode = !!process.env.STUDIO_INJECT_OUTFILE;

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
  outfile: process.env.STUDIO_INJECT_OUTFILE ?? 'src-tauri/inject/entry.js',
  logLevel: 'info',
  minify: true,
  define: {
    __STUDIO_APP_VERSION__: JSON.stringify(String(pkg.version)),
  },
});

// 自动同步到 Tauri debug 运行时目录（工作目录是 target/debug/）—— 闸模式跳过（产物在临时路径）。
if (!gateMode) {
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

  // 卡 C（MCP 独立原生窗口）：/mcp-settings 页面壳 JS。src/ui/mcp-settings-panel.ts →
  // dist/mcp-settings-panel.js（IIFE，浏览器，与 agent-panel 同型）。宿主路由 /mcp-settings.js
  // 服务它（src/api/main.ts 的 mcpSettingsPage.jsPath 契约，与 :127 逐字一致）。
  // 独立产物，不进 entry.js、不参与 entry-freshness 字节比对，故同样置于 gateMode 跳过区。
  await build({
    entryPoints: [path.join(__dirname, 'src/ui/mcp-settings-panel.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/mcp-settings-panel.js',
    logLevel: 'info',
    minify: true,
  });

  // K3（审批重设计 v1，2026-11-09）：/consent 审批窗口页面壳 JS。src/ui/consent-panel.ts →
  // dist/consent-panel.js（IIFE，浏览器，与上面两枚同型）。宿主路由 /consent.js 服务它
  // （src/api/main.ts 的 consentWindowPage.jsPath 契约，tauri.conf.json resources 已配旁路映射）。
  // 独立产物，不进 entry.js、不参与 entry-freshness 字节比对，故同样置于 gateMode 跳过区。
  await build({
    entryPoints: [path.join(__dirname, 'src/ui/consent-panel.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile: 'dist/consent-panel.js',
    logLevel: 'info',
    minify: true,
  });
}
