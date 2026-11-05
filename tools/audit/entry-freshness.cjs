#!/usr/bin/env node
/**
 * tools/audit/entry-freshness.cjs —— entry.js 新鲜度机械闸（R1.5 缺口加固①）
 *
 * 原理：esbuild 构建确定性（锁版本 + 同参数 → 字节级复现，2026-11-05 实测为证）。
 * 重建到临时文件，与跟踪的 src-tauri/inject/entry.js 做 sha256 比对；不一致 → exit 1。
 * 用法（gate 阻塞级）：node tools/audit/entry-freshness.cjs
 * 可选 --tracked <path>：用指定文件作为「被比对对象」（默认 src-tauri/inject/entry.js），
 *   供负控测试篡改临时副本而不碰跟踪产物；缺省时行为完全不变。
 * 无本机路径，可入库。失败时顺带打印建议：node esbuild.inject.mjs 后重跑。
 */
const { createRequire } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..', '..');
const req = createRequire(path.join(root, 'package.json'));
const { build } = req('esbuild');

(async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = path.join(os.tmpdir(), 'entry-freshness-check.js');
  await build({
    entryPoints: [path.join(root, 'src/desktop/entry.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
    outfile: out, logLevel: 'silent', minify: true,
    define: { __STUDIO_APP_VERSION__: JSON.stringify(String(pkg.version)) },
  });
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 8).toUpperCase();
  // 默认比对跟踪产物 src-tauri/inject/entry.js；--tracked <path> 改比对对象（负控用，不改缺省行为）。
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--tracked');
  const tracked = (ti !== -1 && argv[ti + 1]) ? path.resolve(argv[ti + 1]) : path.join(root, 'src-tauri/inject/entry.js');
  if (!fs.existsSync(tracked)) { console.error('[entry-freshness] FAIL: 跟踪文件缺失 ' + tracked); process.exit(1); }
  const a = h(tracked), b = h(out);
  if (a !== b) {
    console.error(`[entry-freshness] FAIL: 陈旧构建？跟踪=${a} 重建=${b}`);
    console.error('[entry-freshness] 修复：node esbuild.inject.mjs（重建+同步）后重跑');
    process.exit(1);
  }
  console.log('[entry-freshness] PASS (' + a + ') — 打印此指纹可作提交信息「重建 ' + a + '」');
})().catch((e) => { console.error('[entry-freshness] ERROR:', e.message); process.exit(1); });
