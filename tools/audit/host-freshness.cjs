#!/usr/bin/env node
/**
 * tools/audit/host-freshness.cjs —— 宿主 bundle 新鲜度机械闸（2026-11-13 PM 派卡）
 *
 * 现场教训：dev 实例跑了 7 小时前的 src-tauri/host/main.mjs（memory-write-gate 新代码
 * 不在其中），验收探针全部卡到 20s 超时——"闸绿 ≠ 实例在跑的宿主是新的"。entry.js 有
 * entry-freshness 守着，宿主 bundle 此前没有任何新鲜度检查。
 *
 * 原理：用 tools/host-build-options.mjs 的**单一真源**选项把宿主 bundle 重建到临时目录
 * （禁止写跟踪产物），与跟踪的 src-tauri/host/main.mjs 比 sha256；不一致 → exit 1。
 *
 * 用法（gate 阻塞级）：node tools/audit/host-freshness.cjs
 * 可选 --tracked <path>：用指定文件作为「被比对对象」（负控用，不碰跟踪产物）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..', '..');
const trackedDefault = path.join(root, 'src-tauri', 'host', 'main.mjs');
// dev 实际执行的同步副本（esbuild.host.mjs 尾部 copyFileSync 的落点）
const debugCopy = path.join(root, 'src-tauri', 'target', 'debug', 'host', 'main.mjs');

function sha16(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16).toUpperCase();
}

(async () => {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--tracked');
  const tracked = (ti !== -1 && argv[ti + 1]) ? path.resolve(argv[ti + 1]) : trackedDefault;
  if (!fs.existsSync(tracked)) { console.error('[host-freshness] FAIL: 跟踪文件缺失 ' + tracked); process.exit(1); }

  // 单一真源重建：选项与 esbuild.host.mjs 同源（tools/host-build-options.mjs），outfile 落临时目录。
  const { hostBuildOptions, HOST_ENTRY } = await import(pathToFileURL(path.join(root, 'tools', 'host-build-options.mjs')).href);
  const { build } = await import('esbuild');
  if (!fs.existsSync(HOST_ENTRY)) { console.error('[host-freshness] FAIL: 宿主入口缺失 ' + HOST_ENTRY); process.exit(1); }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-freshness-'));
  const out = path.join(outDir, 'main.mjs');
  try {
    await build(hostBuildOptions(out));
  } catch (e) {
    console.error('[host-freshness] ERROR: 宿主 bundle 重建失败:', (e && e.message) ? e.message : String(e));
    process.exit(1);
  }
  if (!fs.existsSync(out)) { console.error('[host-freshness] FAIL: 重建未产出临时文件 ' + out); process.exit(1); }

  const a = sha16(tracked), b = sha16(out);
  if (a !== b) {
    console.error(`[host-freshness] FAIL: 陈旧构建？跟踪=${a} 重建=${b}`);
    console.error('[host-freshness] 修复：npm run build:host（重建+同步）后重跑');
    process.exit(1);
  }

  // dev 同步副本：存在则一并比（它才是 dev 实例真正执行的那份）；不存在只提示、不阻塞
  // （target/debug 是 gitignored 构建目录，干净检出天然没有；esbuild.host.mjs 构建时会补）。
  if (fs.existsSync(debugCopy)) {
    const c = sha16(debugCopy);
    if (c !== a) {
      console.error(`[host-freshness] FAIL: dev 同步副本陈旧？跟踪=${a} debug副本=${c}`);
      console.error('[host-freshness] 修复：npm run build:host（重建+同步）后重跑');
      process.exit(1);
    }
    console.log(`[host-freshness] debug copy OK (${c})`);
  } else {
    console.warn('[host-freshness] WARN: dev 同步副本不存在（干净检出/target 未构建）——跳过该面，跟踪产物比对已过');
  }

  console.log('[host-freshness] PASS (' + a + ') — 打印此指纹可作提交信息「重建 ' + a + '」');
})().catch((e) => { console.error('[host-freshness] ERROR:', e.message); process.exit(1); });
