/**
 * tests/desktop/p2-atomic-write-convergence.test.ts
 *
 * P2 非原子写收紧（PM 卡，2026-11-07）：把散在 `src/host/**` 的手写 tmp+rename 收敛到
 * `src/shared/atomic-write.ts` 的唯一实现。
 *
 * 为什么收敛（不是洁癖，是两条实打实的性质）：
 *   1. **临时文件名的并发唯一性**：三处手工实现用的是 `${目标}.tmp` 这种**确定性名**，
 *      同一路径两次写会互相覆写临时文件 —— rename 出来的可能是**另一次写的内容**；
 *      helper 用 `.${base}.tmp-${pid}-${counter}`，进程内单调唯一。
 *   2. **失败必须清临时文件**：手工实现没有任何清理腿，崩几轮就在用户目录留一堆 `.tmp`。
 *
 * 本文件同时提供 PM 点名的两枚负控的**正向面**（负控本身在交卷里单独演示）：
 *   - 「摘掉 cleanup ⇒ 断言红」对应的正向断言＝下面「失败后无 tmp 残留」；
 *   - 「写入中途抛错 ⇒ 目标仍是旧的完整字节」＝rename 未被调用时目标不动。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync, tmpPathFor } from '../../src/shared/atomic-write';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * 剥掉注释行后的源码 —— 结构判据一律**只看代码**。
 *
 * 今天已经栽过两次（`hidden-console-spawn` 的 `windowsHide` 计数、这次我自己写的收敛注释里
 * 就带着 `${configPath}.tmp` 这个原实现形态）：**解释"为什么要改"的注释会让"禁止出现它"的
 * 断言误红**。判据的读数面必须与它想表达的东西同口径。
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p2-atomic-'));
}

describe('P2 · 原子写单一来源', () => {
  const CONVERGED = [
    'src/host/desktop-host.ts',
    'src/host/automation.ts',
    'src/host/config-migration.ts',
  ];

  it('装置自检：三枚被收敛文件读到了真内容', () => {
    for (const rel of CONVERGED) {
      expect(read(rel).length, `${rel} 内容太短，可能路径写错`).toBeGreaterThan(1_000);
    }
  });

  it('① 三枚文件都改用 writeFileAtomicSync，且不再自带 tmp+rename 副本', () => {
    for (const rel of CONVERGED) {
      const src = read(rel);
      const code = codeOnly(src);
      expect(src, `${rel} 未引用共享实现`).toContain("from '../shared/atomic-write'");
      expect(code, `${rel} 未调用 writeFileAtomicSync`).toContain('writeFileAtomicSync(');
      // 手写副本的两个特征：renameSync 调用、`${xxx}.tmp` 确定性临时名
      expect(code, `${rel} 仍有本地 renameSync`).not.toMatch(/\brenameSync\(/);
      expect(code, `${rel} 仍有确定性 .tmp 临时名`).not.toMatch(/`\$\{[A-Za-z_$][\w$]*\}\.tmp`/);
    }
  });

  it('② 临时文件名进程内唯一、与目标同目录、隐藏前缀（并发不互相覆写）', () => {
    const target = path.join(os.tmpdir(), 'p2-unique-target.json');
    const names = Array.from({ length: 20 }, () => tmpPathFor(target));
    // 装置自检：确实生成了 20 个名字（否则 Set 去重后的比较是在空跑）
    expect(names).toHaveLength(20);
    expect(new Set(names).size, 'tmp 名出现重复 ⇒ 并发写会互相覆写').toBe(20);
    for (const n of names) {
      expect(path.dirname(n)).toBe(path.dirname(target)); // 跨目录 rename 会 EXDEV
      expect(path.basename(n).startsWith('.')).toBe(true); // 隐藏前缀，不污染用户可见列表
    }
  });

  it('③ 写入成功后：目标＝新内容、同目录不留任何 .tmp 残留', () => {
    const dir = mkTmpDir();
    const target = path.join(dir, 'config.json');
    fs.writeFileSync(target, '{"old":true}');
    writeFileAtomicSync(target, '{"new":true}', { mode: 0o644 });
    expect(fs.readFileSync(target, 'utf8')).toBe('{"new":true}');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('⑤ 写入成功但 rename 失败 ⇒ 临时文件必须被清理（这条才走得到 cleanup 腿）', () => {
    const dir = mkTmpDir();
    const target = path.join(dir, 'config.json');
    const oldBody = '{"stable":true}';
    fs.writeFileSync(target, oldBody);

    // 关键：让 rename 抛错。此时 tmp 已经写成功（tmpCreated=true）⇒ 唯一的清理机会就是
    // catch 里那条 unlink 腿。若 helper 的 cleanup 被摘掉，本断言必红（负控 (a) 打这里）。
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    try {
      expect(() => writeFileAtomicSync(target, '{"new":true}')).toThrow(/EPERM/);
    } finally {
      spy.mockRestore();
    }

    // 目标未被替换（rename 没成 ⇒ 旧文件仍完整）
    expect(fs.readFileSync(target, 'utf8')).toBe(oldBody);
    // 且临时文件被清掉 —— 这一行就是 cleanup 腿的可观察后果
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('④ 写入时抛错 ⇒ 目标仍是旧的完整字节、且临时文件被清理', () => {
    const dir = mkTmpDir();
    const target = path.join(dir, 'config.json');
    const oldBody = '{"stable":true}';
    fs.writeFileSync(target, oldBody);

    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      expect(() => writeFileAtomicSync(target, '{"new":true}')).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }

    // rename 未被调用 ⇒ 目标一个字节都没动（这正是「原子写」买来的性质）
    expect(fs.readFileSync(target, 'utf8')).toBe(oldBody);
    // 失败清理腿：临时文件不得残留
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
