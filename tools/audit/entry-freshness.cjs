#!/usr/bin/env node
/**
 * tools/audit/entry-freshness.cjs —— entry.js 新鲜度机械闸（R1.5 缺口加固①）
 *
 * 原理：esbuild 构建确定性（锁版本 + 同参数 → 字节级复现）。重建 entry 产物，与跟踪的
 * src-tauri/inject/entry.js 做 sha256 比对；不一致 → exit 1。
 *
 * 单一真源（20261106 PM 派卡 · 单源化）：不再在闸里复刻 esbuild 参数（曾因此与
 * esbuild.inject.mjs 两份定义漂移）。改为跑 `node esbuild.inject.mjs` 并设 STUDIO_INJECT_OUTFILE
 * 让它把 entry 产出到临时文件（esbuild.inject.mjs 在该 env 下跳过 agent-panel 与 target/debug
 * 同步），再比对字节。参数只有 esbuild.inject.mjs 一处定义。
 *
 * 用法（gate 阻塞级）：node tools/audit/entry-freshness.cjs
 * 可选 --tracked <path>：用指定文件作为「被比对对象」（默认 src-tauri/inject/entry.js），
 *   供负控测试篡改临时副本而不碰跟踪产物；缺省时行为完全不变。
 * mtime 二次检查：源码 mtime 晚于产物 mtime 时打 WARN（非阻塞）—— 抓不到「源码没动、产物被
 *   手工改过」，故只做提示，主判据仍是字节比对。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const trackedDefault = path.join(root, 'src-tauri', 'inject', 'entry.js');
const injectScript = path.join(root, 'esbuild.inject.mjs');

function sha8(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8).toUpperCase();
}

(async () => {
  // --tracked <path> 覆盖被比对对象（负控用，不改缺省行为）。
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--tracked');
  const tracked = (ti !== -1 && argv[ti + 1]) ? path.resolve(argv[ti + 1]) : trackedDefault;
  if (!fs.existsSync(tracked)) { console.error('[entry-freshness] FAIL: 跟踪文件缺失 ' + tracked); process.exit(1); }

  // 单一真源重建：让 esbuild.inject.mjs 把 entry 产出到临时文件，不碰跟踪产物。
  const out = path.join(os.tmpdir(), 'entry-freshness-check.js');
  const prevOut = process.env.STUDIO_INJECT_OUTFILE;
  process.env.STUDIO_INJECT_OUTFILE = out;
  try {
    execSync(`node "${injectScript}"`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  } catch (e) {
    console.error('[entry-freshness] ERROR: esbuild.inject.mjs 重建失败:', (e && e.message) ? e.message : String(e));
    process.exit(1);
  } finally {
    if (prevOut === undefined) delete process.env.STUDIO_INJECT_OUTFILE; else process.env.STUDIO_INJECT_OUTFILE = prevOut;
  }
  if (!fs.existsSync(out)) { console.error('[entry-freshness] FAIL: 重建未产出临时文件 ' + out); process.exit(1); }

  const a = sha8(tracked), b = sha8(out);
  if (a !== b) {
    console.error(`[entry-freshness] FAIL: 陈旧构建？跟踪=${a} 重建=${b}`);
    console.error('[entry-freshness] 修复：node esbuild.inject.mjs（重建+同步）后重跑');
    process.exit(1);
  }

  // mtime 二次检查（非阻塞）：源码晚于产物 → 提示可能忘重建（但字节已一致，故只 WARN）。
  const entrySrc = path.join(root, 'src', 'desktop', 'entry.ts');
  if (fs.existsSync(entrySrc)) {
    const srcM = fs.statSync(entrySrc).mtimeMs;
    const trackedM = fs.statSync(tracked).mtimeMs;
    if (srcM > trackedM) {
      console.warn(`[entry-freshness] WARN: 源码 mtime 晚于产物（字节已一致，可能刚重建过；若字节将变会由主判据拦）`);
    }
  }

  console.log('[entry-freshness] PASS (' + a + ') — 打印此指纹可作提交信息「重建 ' + a + '」');
})().catch((e) => { console.error('[entry-freshness] ERROR:', e.message); process.exit(1); });
