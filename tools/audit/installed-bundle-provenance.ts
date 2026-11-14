#!/usr/bin/env tsx
/**
 * tools/audit/installed-bundle-provenance.ts — 装版 bundle 溯源（只读，不入闸）
 *
 * 背景（2026-11-14 事故定性）：出资人装版被开发树产物覆盖成「exe 0.14.20 + bundle 11-13
 * 开发树」的混血版，登录 422/掉登录由它而来。规约（AGENTS.md 真机取证环境条）严禁向装版
 * 资源目录拷贝开发树产物；本脚本把「装版实测自证」从人的自觉机械化成一行可跑的读数。
 *
 * 核心判据（PM 2026-11-14 定）：NSIS 安装时 bundle 与 exe 同批落地，因此
 *   max(entry.js mtime, main.mjs mtime) > exe mtime  ⇒  装后被覆盖 ⇒ 混血。
 * 注意：装版指纹与 dev 树当前产物指纹不同**并不必然**是被覆盖——也可能只是旧发布产物；
 * 可机械化的只有时刻关系。字节级比对只作参照、不参与判定。
 *
 * 三态结论（每态必须点名是哪两枚文件给出的判定）：
 *   同源               —— bundle 均不晚于 exe（与安装批一致）
 *   混血(mtime 倒挂 Δ=…h) —— 任一 bundle 晚于 exe（Δ＝晚的小时数）
 *   装版缺失或未安装     —— 目录或任一文件不存在（点名缺哪枚）
 *
 * 命名空间纪律：输出分「装版资源目录」与「dev 树当前产物」两段，各自列 bytes/mtime/sha16，
 * 两段永不相加、永不对拼（dev 段仅参照）。sha16 一律断形态（每两位一组加空格），
 * 另附字节数作通道安全等价锚（AGENTS：连续 8/16 位 hex 会被通道掩成占位符）。
 *
 * 本脚本对装版目录**只开读句柄**（existsSync/statSync/readFileSync），严禁任何写操作。
 *
 * ⚠ 若将来把本脚本接入 gate（现为独立工具、未入闸）：按 AGENTS 规约，阻塞级闸步骤
 *   第一次必须在干净 checkout 上真跑到——本机永远有装版/dev 产物，本地绿证明不了
 *   CI 语义（2026-11-14 host-freshness 连红 19 发的同型教训）。
 *
 * 用法：
 *   npx tsx tools/audit/installed-bundle-provenance.ts
 *   npx tsx tools/audit/installed-bundle-provenance.ts --install-dir <path> [--dev-root <path>]
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/** 装版资源目录默认值（NSIS 安装布局）。 */
export function defaultInstallDir(): string {
  const lad = process.env.LOCALAPPDATA ?? '';
  return lad ? join(lad, 'DeepSeek++ Studio') : '';
}

export interface BundleRow {
  name: string;
  bytes: number | null;
  mtimeMs: number | null;
  mtimeText: string;
  sha16: string | null;
  missing: boolean;
}

function fmtMtime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** sha16 断形态：每两位一组加空格（通道安全），另附字节数作等价锚。 */
export function brokenSha16(hex: string): string {
  return (hex.match(/.{2}/g) ?? []).join(' ');
}

function rowOf(path: string, name: string): BundleRow {
  if (!existsSync(path)) {
    return { name, bytes: null, mtimeMs: null, mtimeText: '（缺失）', sha16: null, missing: true };
  }
  const st = statSync(path);
  const buf = readFileSync(path);
  const sha16 = createHash('sha256').update(buf).digest('hex').slice(0, 16).toUpperCase();
  return { name, bytes: st.size, mtimeMs: st.mtimeMs, mtimeText: fmtMtime(st.mtimeMs), sha16, missing: false };
}

/** 装版资源目录三态判定（纯函数，供测试）。 */
export interface ProvenanceVerdict {
  state: '同源' | '混血' | '装版缺失或未安装';
  /** 判定依据：点名哪两枚文件给出该结论。 */
  basis: string;
  /** 混血时＝bundle 晚于 exe 的小时数（1 位小数）；其余 null。 */
  deltaHours: number | null;
  missing: string[];
}

export function classifyProvenance(exe: BundleRow, entry: BundleRow, main: BundleRow): ProvenanceVerdict {
  const missing = [exe, entry, main].filter((r) => r.missing).map((r) => r.name);
  if (missing.length > 0) {
    return { state: '装版缺失或未安装', basis: `缺失文件：${missing.join('、')}`, deltaHours: null, missing };
  }
  const exeMs = exe.mtimeMs as number;
  const entryMs = entry.mtimeMs as number;
  const mainMs = main.mtimeMs as number;
  const latest = mainMs >= entryMs ? main : entry;
  const latestMs = Math.max(entryMs, mainMs);
  if (latestMs > exeMs) {
    const delta = (latestMs - exeMs) / 3_600_000;
    return {
      state: '混血',
      basis: `${latest.name}(${latest.mtimeText}) 晚于 ${exe.name}(${exe.mtimeText})`,
      deltaHours: Math.round(delta * 10) / 10,
      missing: [],
    };
  }
  return {
    state: '同源',
    basis: `${entry.name}(${entry.mtimeText}) 与 ${main.name}(${main.mtimeText}) 均不晚于 ${exe.name}(${exe.mtimeText})`,
    deltaHours: null,
    missing: [],
  };
}

export interface ProvenanceResult {
  verdict: ProvenanceVerdict;
  installDir: string;
  installRows: BundleRow[];
  devRoot: string;
  devRows: BundleRow[];
}

/** 扫描装版目录（只读）。installDir 缺失/为空 ⇒ 三态之「装版缺失或未安装」。 */
export function scanInstallDir(installDir: string, devRoot: string): ProvenanceResult {
  const installRows: BundleRow[] = [];
  let verdict: ProvenanceVerdict;
  if (!installDir || !existsSync(installDir)) {
    verdict = {
      state: '装版缺失或未安装',
      basis: installDir ? `装版目录不存在：${installDir}` : '装版目录未定（LOCALAPPDATA 缺失且未传 --install-dir）',
      deltaHours: null,
      missing: ['装版目录'],
    };
  } else {
    const exe = rowOf(join(installDir, 'deepseek-studio.exe'), 'deepseek-studio.exe');
    const entry = rowOf(join(installDir, 'inject', 'entry.js'), 'inject\\entry.js');
    const main = rowOf(join(installDir, 'host', 'main.mjs'), 'host\\main.mjs');
    installRows.push(exe, entry, main);
    verdict = classifyProvenance(exe, entry, main);
  }

  // dev 树当前产物：仅参照，不参与判定（命名空间 B）。
  const devRows: BundleRow[] = [
    rowOf(join(devRoot, 'src-tauri', 'host', 'main.mjs'), 'src-tauri\\host\\main.mjs'),
    rowOf(join(devRoot, 'src-tauri', 'inject', 'entry.js'), 'src-tauri\\inject\\entry.js'),
  ];

  return { verdict, installDir, installRows, devRoot, devRows };
}

function printRow(r: BundleRow): void {
  if (r.missing) {
    console.log(`  ${r.name.padEnd(24)} 缺失`);
    return;
  }
  const sha = r.sha16 ? brokenSha16(r.sha16) : '（无）';
  console.log(`  ${r.name.padEnd(24)} bytes=${String(r.bytes).padStart(10)}  mtime=${r.mtimeText}  sha16(断)=${sha}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const getArg = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };
  const installDir = getArg('--install-dir') ?? defaultInstallDir();
  // dev 树根＝tools/audit 的上两级（与其它 tools/audit 脚本同推导），可 --dev-root 覆盖（测试用）。
  const devRoot = getArg('--dev-root') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const result = scanInstallDir(installDir, devRoot);

  console.log('=== 装版 bundle 溯源（installed-bundle-provenance，只读）===');
  console.log(`[命名空间 A：装版资源目录] ${result.installDir || '（未定）'}`);
  for (const r of result.installRows) printRow(r);
  console.log(`[命名空间 B：dev 树当前产物] ${result.devRoot}（仅参照，不参与判定，两段永不对拼）`);
  for (const r of result.devRows) printRow(r);
  const dh = result.verdict.deltaHours;
  console.log(`\n结论：${result.verdict.state}${dh !== null ? `(mtime 倒挂 Δ=${dh.toFixed(1)}h)` : ''}`);
  console.log(`判定依据：${result.verdict.basis}`);
  console.log('判据：NSIS 安装批 bundle 与 exe 同批落地；bundle mtime 晚于 exe ⇒ 装后被覆盖（混血）。');
  if (result.verdict.state === '混血') {
    console.log('处置提示：该装版正在跑修复前 bundle（登录 422/掉登录风险未消除）；按规约严禁再向装版拷产物，');
    console.log('  真机验收走 dev 树实例（先关装版——同 identifier 单实例锁会拦下 dev 进程）。');
  }
  process.exit(0);
}

const isDirectRun =
  typeof process.argv[1] === 'string' && process.argv[1].replace(/\\/g, '/').endsWith('tools/audit/installed-bundle-provenance.ts');
if (isDirectRun) main();
