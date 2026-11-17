/**
 * 卡㊴：dev 专用 identifier 的 **opt-in 切片**锁（零实例、零 Rust 改动）。
 *
 * 背景（设计稿 §一 第 1／2／3 行，均为现读）：dev 与装版共用 `identifier`
 * ⇒ 共用单实例互斥量 `com.deepseek.studio-sim`、共用同一份 WebView2 档案根。
 * 本卡只做**准入**那一半：给 dev 一条**可选**启动路径，用一份只覆盖 identifier 的
 * 开发配置经 `--config` 合入；打包用的 `tauri.conf.json` 一字不改。
 *
 * 四件断言（PM 卡面）：
 *   ① 默认 `identifier` 仍是 `com.deepseek.studio`（打包面一字未改）；
 *   ② dev 配置**只**覆盖 `identifier` 一个键，且只被新命令 `tauri:dev:isolated` 引用
 *      （`tauri:dev` 原文必须是 `tauri dev`，不许被顺手改）；
 *   ③ `scripts/m3-collect.ps1` 仍**刻意**指向装版 —— 设计稿 §四 写明那是度量脚本的本意，
 *      不是缺陷；这一条是防"顺手修"的锁，红了要改的是**调用方**，不是它；
 *   ④ 两枚 identifier 不同名。
 *
 * 本卡**不**断的（留给 ② 窗口的现场，避免把没验过的写成判据）：`--config` 合入后
 * 运行时的锁名与 EBWebView 档案根是否真变成 `…-dev-sim`／`com.deepseek.studio.dev\EBWebView`
 * —— 本卡不允许起实例，`--config` 的合并语义此前只经 CLI `--help` 静态确认。
 *
 * **根 seam 只为负控，且加了双闸**：只有 `STUDIO_DEV_IDENT_LOCK_NEGCTL=1` **且**
 * `process.env.CI` 未设时，才认 `STUDIO_DEV_IDENT_LOCK_ROOT` 指的副本树；否则**一律仓库根**。
 * 理由：单个残留 env 就能把锁静默改指另一棵树还报绿，正是本仓反复被咬的假绿灯。
 * ⇒ **CI 与本仓默认永远锁真仓**；seam 只服务本地负控（PM 裁定 2026-11-17 09:2x）。
 *
 * 两枚附加锁（不在 PM 卡面四件里，均为本席按"恒真断言不算锁"补的真回归）：
 *   ⑤ dev 配置**不得**用 Tauri CLI 会自动识别的文件名（否则打包 identifier 被静默改掉＝P0）；
 *   ⑥ `tauri:dev:isolated` 不得设 `STUDIO_LOG_DIR`（钉住"别把 dev 同源日志拆成两处"这个决定）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_ROOT =
  process.env.STUDIO_DEV_IDENT_LOCK_ROOT &&
  process.env.STUDIO_DEV_IDENT_LOCK_NEGCTL === '1' &&
  !process.env.CI
    ? resolve(process.env.STUDIO_DEV_IDENT_LOCK_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CONF = join(REAL_ROOT, 'src-tauri', 'tauri.conf.json');
const DEV_CONF = join(REAL_ROOT, 'src-tauri', 'tauri.conf.dev.json');
const PKG = join(REAL_ROOT, 'package.json');
const M3_COLLECT = join(REAL_ROOT, 'scripts', 'm3-collect.ps1');

const DEFAULT_IDENTIFIER = 'com.deepseek.studio';
const DEV_IDENTIFIER = 'com.deepseek.studio.dev';
const DEV_CONFIG_FLAG = 'src-tauri/tauri.conf.dev.json';

interface TauriConf {
  identifier?: string;
  [k: string]: unknown;
}
interface Pkg {
  scripts?: Record<string, string>;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

describe('卡㊴：dev 专用 identifier 的 opt-in 切片', () => {
  it('① 默认 identifier 仍是 com.deepseek.studio（打包面一字未改）', () => {
    expect(readJson<TauriConf>(DEFAULT_CONF).identifier).toBe(DEFAULT_IDENTIFIER);
  });

  it('② dev 配置只覆盖 identifier 一个键，且只被 tauri:dev:isolated 引用', () => {
    const devConf = readJson<TauriConf>(DEV_CONF);
    expect(Object.keys(devConf)).toEqual(['identifier']);

    const scripts = readJson<Pkg>(PKG).scripts ?? {};
    // 原命令必须逐字未变（本卡不许动它）
    expect(scripts['tauri:dev']).toBe('tauri dev');
    // 新命令：只加 --config，指向 dev 配置
    expect(scripts['tauri:dev:isolated']).toBe(`tauri dev --config ${DEV_CONFIG_FLAG}`);

    // 全量扫：除新命令外任何脚本都不得引用 dev 配置（防"顺手"把打包/其他路径也指过去）
    const referencing = Object.entries(scripts)
      .filter(([, cmd]) => cmd.includes('tauri.conf.dev.json'))
      .map(([name]) => name);
    expect(referencing).toEqual(['tauri:dev:isolated']);
  });

  it('③ scripts/m3-collect.ps1 仍刻意指向装版（不是缺陷，别顺手修）', () => {
    const src = readFileSync(M3_COLLECT, 'utf8');
    // 现读原文（设计稿 §四 ②）：$installTrace = Join-Path $env:APPDATA 'com.deepseek.studio\logs\trace'
    expect(src).toContain("Join-Path $env:APPDATA 'com.deepseek.studio\\logs\\trace'");
    // 反向锁：它不该被改成 dev 根（改了就等于度量脚本读错树）
    expect(src).not.toContain('com.deepseek.studio.dev');
  });

  it('④ 两枚 identifier 不同名，且 dev 那枚是 com.deepseek.studio.dev', () => {
    const dev = readJson<TauriConf>(DEV_CONF).identifier;
    expect(dev).toBe(DEV_IDENTIFIER);
    expect(dev).not.toBe(DEFAULT_IDENTIFIER);
  });

  it('⑤ dev 配置不得用 CLI 会自动识别的文件名（改名＝静默改掉打包 identifier）', () => {
    // 现读凭据（PM 2026-11-17 09:1x 扫 @tauri-apps/cli 二进制的 ASCII 串）：CLI 自动识别的
    // 只有下面 6 枚；两枚 release*.yml 全程按**字面路径**读 `src-tauri/tauri.conf.json`。
    // ⇒ 谁把 dev 配置改名成 `tauri.windows.conf.json` 之类，打包 identifier 会被**静默**改掉（P0）。
    // 名单写死为常量，不在运行时读 node_modules 里的二进制（那不可靠、也不该由测试依赖）。
    const CLI_AUTO_NAMES = [
      'tauri.conf.json',
      'tauri.linux.conf.json',
      'tauri.macos.conf.json',
      'tauri.windows.conf.json',
      'tauri.android.conf.json',
      'tauri.ios.conf.json',
    ];
    const scripts = readJson<Pkg>(PKG).scripts ?? {};
    const cmd = scripts['tauri:dev:isolated'] ?? '';
    const m = cmd.match(/--config\s+(\S+)/);
    expect(m, 'isolated 命令必须带 --config <file>').toBeTruthy();
    const referenced = basename(m![1]); // 命令行点名的文件名（这是真正会进构建的那枚）
    // 主判据先跑：命令行只要指到自动识别名，打包 identifier 就会被静默改掉
    expect(CLI_AUTO_NAMES, `命令行引用的 ${referenced} 落在 CLI 自动识别名里`).not.toContain(referenced);
    expect(existsSync(DEV_CONF), `${DEV_CONF} 必须存在`).toBe(true);
    expect(basename(DEV_CONF)).toBe(referenced); // 防"改了文件名没改命令"两处不同步
  });

  it('⑥ 裁定锁：isolated 命令不得设 STUDIO_LOG_DIR（别把 dev 的一处日志拆成两处）', () => {
    // 依据（2026-11-17 PM 裁定 L4833／L4840＋本席现读）：dev 下 Rust 的 `crash_log_path`
    // 走 `HostEntry::log_dir()`（dev＝None），且 `sidecar.rs` 明确**不读父进程 env**
    // ⇒ 只在 npm script 里设 env，等于把 dev 本来同源的一处日志拆成两处
    //（node 侧落 dev 专档、Rust 监管/崩溃日志仍落回落根），"哪棵树写的"又变成靠猜。
    // 所以这条钉的是**决定本身**：将来谁要加回来，必须先动 Rust 注入条件与它三枚契约断言，
    // 那是改验收口径（公告④先报 PM），不该顺手加在 npm script 里。
    const scripts = readJson<Pkg>(PKG).scripts ?? {};
    const isolated = scripts['tauri:dev:isolated'] ?? '';
    expect(isolated).not.toContain('STUDIO_LOG_DIR');
    // 也不许用任何 env 赋值前缀（Windows `set ` 或 POSIX `X=Y ` 两种形态）
    expect(isolated).not.toMatch(/^set\s/i);
    expect(isolated).not.toMatch(/^[A-Z_][A-Z0-9_]*=/);
    for (const [name, cmd] of Object.entries(scripts)) {
      expect(cmd, `脚本 ${name} 不该设 STUDIO_LOG_DIR`).not.toContain('STUDIO_LOG_DIR');
    }
  });

});
