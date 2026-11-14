/**
 * tools/audit/installed-bundle-provenance.ts 自身单测（2026-11-14 装版溯源卡，Gate 写域）。
 *
 * 纯函数（classifyProvenance／brokenSha16）直接测；scanInstallDir 用临时目录合成 fixture
 * 跑三态端到端——**对真实装版目录（%LOCALAPPDATA%\DeepSeek++ Studio）零接触**。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brokenSha16,
  classifyProvenance,
  scanInstallDir,
  type BundleRow,
} from '../../tools/audit/installed-bundle-provenance';

const dirs: string[] = [];
function tempDir(prefix = 'prov-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string;
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function row(name: string, mtimeMs: number | null, bytes = 100): BundleRow {
  return mtimeMs === null
    ? { name, bytes: null, mtimeMs: null, mtimeText: '（缺失）', sha16: null, missing: true }
    : { name, bytes, mtimeMs, mtimeText: '', sha16: 'AABBCCDD11223344', missing: false };
}

const T0 = 1_700_000_000_000; // 固定基准，避免浮点漂移
const HOUR = 3_600_000;

describe('brokenSha16（通道安全断形态）', () => {
  it('16 位 hex → 每 2 位一组加空格（8 组 23 字符）', () => {
    expect(brokenSha16('3D6D8505F62840E9')).toBe('3D 6D 85 05 F6 28 40 E9');
    expect(brokenSha16('3D6D8505F62840E9')).toHaveLength(23);
  });
});

describe('classifyProvenance 三态（每态点名判定文件）', () => {
  it('bundle 均不晚于 exe → 同源', () => {
    const v = classifyProvenance(row('exe', T0), row('entry', T0 - HOUR), row('main', T0));
    expect(v.state).toBe('同源');
    expect(v.deltaHours).toBe(null);
    expect(v.basis).toContain('entry');
    expect(v.basis).toContain('main');
    expect(v.basis).toContain('exe');
  });

  it('bundle 晚于 exe → 混血，Δ=小时数、basis 点名晚的那枚＋exe', () => {
    const v = classifyProvenance(row('exe', T0), row('entry', T0 + HOUR), row('main', T0 + 2 * HOUR));
    expect(v.state).toBe('混血');
    expect(v.deltaHours).toBe(2);
    expect(v.basis).toContain('main');
    expect(v.basis).toContain('exe');
  });

  it('任一文件缺失 → 装版缺失或未安装，并点名缺哪枚', () => {
    const v1 = classifyProvenance(row('exe', null), row('entry', T0), row('main', T0));
    expect(v1.state).toBe('装版缺失或未安装');
    expect(v1.missing).toContain('exe');
    const v2 = classifyProvenance(row('exe', T0), row('entry', T0), row('main', null));
    expect(v2.state).toBe('装版缺失或未安装');
    expect(v2.missing).toContain('main');
  });
});

describe('scanInstallDir 端到端（临时 fixture，零触真实装版）', () => {
  function makeFakeInstall(installDir: string, opts: { withMain?: boolean } = {}): void {
    mkdirSync(join(installDir, 'inject'), { recursive: true });
    mkdirSync(join(installDir, 'host'), { recursive: true });
    writeFileSync(join(installDir, 'deepseek-studio.exe'), 'EXE');
    writeFileSync(join(installDir, 'inject', 'entry.js'), 'ENTRY');
    if (opts.withMain !== false) writeFileSync(join(installDir, 'host', 'main.mjs'), 'MAIN');
    // exe 早一天；bundle「刚刚」→ mtime 倒挂 ⇒ 混血
    utimesSync(join(installDir, 'deepseek-studio.exe'), new Date(T0), new Date(T0));
    utimesSync(join(installDir, 'inject', 'entry.js'), new Date(T0 + 24 * HOUR), new Date(T0 + 24 * HOUR));
    if (opts.withMain !== false) utimesSync(join(installDir, 'host', 'main.mjs'), new Date(T0 + 24 * HOUR), new Date(T0 + 24 * HOUR));
  }

  it('混血 fixture → 混血，sha16 落断形态，dev 段独立成列', () => {
    const inst = tempDir('prov-install-');
    makeFakeInstall(inst);
    const devRoot = tempDir('prov-dev-'); // 空 dev 树 → dev 段全缺失，但判定不受影响
    const r = scanInstallDir(inst, devRoot);
    expect(r.verdict.state).toBe('混血');
    expect(r.verdict.deltaHours).toBeCloseTo(24, 1);
    const entryRow = r.installRows.find((x) => x.name.includes('entry.js')) as BundleRow;
    expect(entryRow.sha16).toMatch(/^[0-9A-F]{16}$/);
    expect(brokenSha16(entryRow.sha16 as string)).toContain(' ');
    expect(r.devRows.every((x) => x.missing)).toBe(true); // 空 dev 树只影响参照段
    expect(r.verdict.basis).toContain('exe'); // 判定只由装版段给出
  });

  it('bundle 缺失 → 装版缺失或未安装（点名缺哪枚）', () => {
    const inst = tempDir('prov-install-');
    makeFakeInstall(inst, { withMain: false });
    const r = scanInstallDir(inst, tempDir('prov-dev-'));
    expect(r.verdict.state).toBe('装版缺失或未安装');
    expect(r.verdict.missing).toContain('host\\main.mjs');
  });

  it('装版目录不存在 → 装版缺失或未安装（不抛异常）', () => {
    const r = scanInstallDir(join(tempDir('prov-'), 'not-installed'), tempDir('prov-dev-'));
    expect(r.verdict.state).toBe('装版缺失或未安装');
  });

  it('同源 fixture（bundle 不晚于 exe）→ 同源', () => {
    const inst = tempDir('prov-install-');
    makeFakeInstall(inst);
    // bundle 回拨到 exe 之前 ⇒ 同源
    utimesSync(join(inst, 'inject', 'entry.js'), new Date(T0 - HOUR), new Date(T0 - HOUR));
    utimesSync(join(inst, 'host', 'main.mjs'), new Date(T0 - HOUR), new Date(T0 - HOUR));
    const r = scanInstallDir(inst, tempDir('prov-dev-'));
    expect(r.verdict.state).toBe('同源');
    expect(r.verdict.deltaHours).toBe(null);
  });
});
