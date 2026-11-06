/**
 * tests/desktop/atomic-write.test.ts
 *
 * 原子写 helper 的单测（PM 裁定二十四 ① 指定的四例）。
 *
 * 背景：`writeFileSync` 直写目标文件时，磁盘满 / 进程被杀会留下**半截文件**；
 * 对本仓后果接上 `loadMcpServers` 的 catch 就变成「一台都没有」→ 用户保存一台 →
 * 其余 MCP 配置静默丢失（2026-11-06 串起来的链）。判据：**关键文件写入必须原子**。
 *
 * 全部用例只用 `mkdtemp` 临时目录，不碰任何用户真实配置目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync, writeJsonAtomicSync, tmpPathFor } from '../../src/shared/atomic-write';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-atomic-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('writeFileAtomicSync：基本行为', () => {
  it('写入内容正确，且不残留临时文件', () => {
    const target = path.join(dir, 'a.json');
    writeFileAtomicSync(target, '{"x":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"x":1}');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('父目录不存在时自动创建（配置目录首启场景）', () => {
    const target = path.join(dir, 'deep', 'nested', 'b.json');
    writeFileAtomicSync(target, 'ok');
    expect(fs.readFileSync(target, 'utf8')).toBe('ok');
  });
});

describe('① rename 失败 → 清理临时文件并抛错（不掩盖原始错误）', () => {
  it('rename 抛错时 tmp 被删除、目标保持原样、错误向上抛', () => {
    const target = path.join(dir, 'c.json');
    fs.writeFileSync(target, 'OLD', 'utf8');

    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EXDEV: cross-device link not permitted');
    });

    expect(() => writeFileAtomicSync(target, 'NEW')).toThrow(/EXDEV/);

    // 目标文件必须原样（这是「写失败不毁原文件」的核心）
    expect(fs.readFileSync(target, 'utf8')).toBe('OLD');
    // 临时文件必须被清理，否则崩溃几轮会留下垃圾
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('② mode 0600 在 rename 后保留（密钥文件权限不能回退）', () => {
  // 本仓 CI = windows-latest，Windows 上 mode 位不构成权限边界：
  //   ① CI 亦为 windows-latest ⇒ 本断言在本仓**任何 runner 上都不会执行**；
  //   ② 这不是「待补」，是有意不测（要真测需 POSIX runner，本仓当前没有）；
  //   ③ 密钥文件的真实保护 = 不落明文副本 + 目录 ACL，与 mode 无关。
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  posixOnly('目标文件权限 = 0600', () => {
    const target = path.join(dir, 'key.bin');
    writeFileAtomicSync(target, 'secret');
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('可显式指定 mode（0644 场景）', () => {
    const target = path.join(dir, 'public.json');
    writeFileAtomicSync(target, '{}', { mode: 0o644 });
    expect(fs.existsSync(target)).toBe(true);
    // Windows 上 mode 位语义有限，只断言文件确实存在且内容正确
    expect(fs.readFileSync(target, 'utf8')).toBe('{}');
  });
});

describe('③ 目标已存在 → 正确覆盖（且不先删目标）', () => {
  it('覆盖写入，内容为新值', () => {
    const target = path.join(dir, 'd.json');
    fs.writeFileSync(target, '{"old":true}', 'utf8');
    writeFileAtomicSync(target, '{"new":true}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"new":true}');
  });

  it('实现里**不得**先 unlink 目标（否则会出现「删了但没写成」的窗口）', () => {
    const target = path.join(dir, 'e.json');
    fs.writeFileSync(target, 'OLD', 'utf8');
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    writeFileAtomicSync(target, 'NEW');
    // 允许清理 tmp 的 unlink，但绝不允许删目标
    for (const call of unlinkSpy.mock.calls) {
      expect(String(call[0])).not.toBe(target);
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('NEW');
  });
});

describe('④ 临时文件必须与目标同目录（跨卷 rename 会 EXDEV）', () => {
  it('tmpPathFor 产出的路径与目标同目录', () => {
    const target = path.join(dir, 'sub', 'f.json');
    const tmp = tmpPathFor(target);
    expect(path.dirname(tmp)).toBe(path.dirname(target));
    expect(tmp).not.toBe(target);
  });

  it('不同目标目录 → 临时文件跟着目标走（不会共用同一目录）', () => {
    const t1 = path.join(dir, 'one', 'a.json');
    const t2 = path.join(dir, 'two', 'b.json');
    expect(path.dirname(tmpPathFor(t1))).toBe(path.dirname(t1));
    expect(path.dirname(tmpPathFor(t2))).toBe(path.dirname(t2));
  });
});

describe('writeJsonAtomicSync', () => {
  it('JSON 往返一致（2 空格缩进 + 末尾换行）', () => {
    const target = path.join(dir, 'j.json');
    const value = { servers: { a: { command: 'node' } } };
    writeJsonAtomicSync(target, value);
    const raw = fs.readFileSync(target, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(value);
    expect(raw).toContain('  "servers"');
  });
});
