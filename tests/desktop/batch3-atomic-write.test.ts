/**
 * tests/desktop/batch3-atomic-write.test.ts
 *
 * 批 3（非原子写硬化，2026-11-06）的**验收本体**：A / B / C 三条负控。
 *
 * 三条各自独立（PM 卡片第四条明写：B 不许只当 A 的副作用）：
 *   **A** 写路径中途失败 ⇒ 最终文件保持**旧内容**（不得出现半截），且不留 `.tmp-*` 垃圾；
 *   **B** 写入必须**经 rename 落到最终路径** —— 只挂 tmp 不 rename 必须被抓到；
 *   **C** 并发/重入下不产生 `.tmp-*` 残留堆积，且两个写方**不得串档**。
 *
 * 每条都带**装置自检**（今日口径，缺这条按未交处理）：先证明「这个装置真的能抓到
 * 它要抓的那个形状」，再证明「当前实现没那个形状」。装置自检用**本地复刻的旧写法**
 * （固定 tmp 名 / 只挂 tmp 不 rename / 失败直接写目标）来演示检测力，不去改产品代码。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync, tmpPathFor } from '../../src/shared/atomic-write';

const tmpDirs: string[] = [];

function mkDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'batch3-'));
  tmpDirs.push(d);
  return d;
}

/** 目录里残留的临时文件（helper 约定：`.<base>.tmp-<pid>-<n>`）。 */
function residue(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('A · 写路径中途失败 ⇒ 目标保持旧内容，不留垃圾', () => {
  it('A1：tmp 写失败 → 目标逐字节保持旧内容，且无 .tmp-* 残留', () => {
    const dir = mkDir();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'OLD-CONTENT', 'utf8');

    const realWrite = fs.writeFileSync;
    const spy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((p: fs.PathOrFileDescriptor, d: unknown, o?: unknown) => {
        // 只让**临时文件**的写失败（模拟磁盘满 / 被杀），目标文件的写不受影响
        if (String(p).includes('.tmp-')) throw new Error('ENOSPC (simulated)');
        return (realWrite as (...a: unknown[]) => void)(p, d, o);
      });

    expect(() => writeFileAtomicSync(target, 'NEW-CONTENT', { encoding: 'utf8' })).toThrow(/ENOSPC/);

    // 装置自检（先证明走到了被测分支）：mock 真的被调用过，且调用的是**临时文件**路径
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    const firstPath = String(spy.mock.calls[0][0]);
    expect(firstPath).toContain('.tmp-');
    expect(firstPath).not.toBe(target);

    // 验收断言：目标保持旧内容（没有半截、没有被清空）
    expect(fs.readFileSync(target, 'utf8')).toBe('OLD-CONTENT');
    // 失败路径必须清理临时文件（否则崩几轮后用户目录里全是垃圾）
    expect(residue(dir)).toEqual([]);
  });

  it('A2 装置自检：本地复刻「失败时直接写目标」的旧写法 → A1 的断言确实能抓到它', () => {
    const dir = mkDir();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'OLD-CONTENT', 'utf8');

    // 旧写法复刻：先尝试写 tmp，失败后**降级直接写目标**（这正是「半截/覆盖」的来源）
    const legacyWrite = (): void => {
      const tmp = path.join(dir, '.state.json.tmp-fixed');
      try {
        throw new Error('ENOSPC (simulated)');
      } catch {
        // 降级：直接写目标 —— 危险动作
        fs.writeFileSync(target, 'PARTIAL-NEW', 'utf8');
        void tmp;
      }
    };
    legacyWrite();

    // 证明 A1 的核心断言在这个形状下**会红**（检测力真实存在，不是永远绿）
    expect(fs.readFileSync(target, 'utf8')).not.toBe('OLD-CONTENT');
  });
});

describe('B · 必须经 rename 落到最终路径（只挂 tmp 不 rename 必红）', () => {
  it('B1：写成功后目标=新内容，且**确实调了 renameSync(tmp, target)**（不是直接写目标）', () => {
    const dir = mkDir();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'OLD-CONTENT', 'utf8');

    const spy = vi.spyOn(fs, 'renameSync');
    writeFileAtomicSync(target, 'NEW-CONTENT', { encoding: 'utf8' });

    // 装置自检：这条负控真的走到了 rename 这一步（不是「写了断言没测到路径」）
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    const [from, to] = spy.mock.calls[0].map(String);
    // from 必须是**同目录**的临时文件（跨卷 rename 会 EXDEV）
    expect(path.dirname(from)).toBe(dir);
    expect(path.basename(from)).toContain('.tmp-');
    expect(to).toBe(target);

    // 验收断言：落到最终路径的是新内容；临时文件已被 rename 消费掉
    expect(fs.readFileSync(target, 'utf8')).toBe('NEW-CONTENT');
    expect(fs.existsSync(from)).toBe(false);
    expect(residue(dir)).toEqual([]);
  });

  it('B2 装置自检：本地复刻「只挂 tmp 不 rename」→ B1 的断言确实能抓到它', () => {
    const dir = mkDir();
    const target = path.join(dir, 'state.json');
    fs.writeFileSync(target, 'OLD-CONTENT', 'utf8');

    // 旧写法复刻：只写 tmp，忘了 rename（= 裁定三十七① 那个洞的另一形态）
    fs.writeFileSync(path.join(dir, '.state.json.tmp-fixed'), 'NEW-CONTENT', 'utf8');

    // B1 的两条核心断言在这个形状下**都会红**
    expect(fs.readFileSync(target, 'utf8')).not.toBe('NEW-CONTENT'); // 内容没落到最终路径
    expect(residue(dir).length).toBeGreaterThan(0); // 且留下垃圾
  });
});

describe('C · 并发/重入：不串档、不留 .tmp-* 堆积', () => {
  it('C1：两个写方**同一目标**交错 ⇒ 后提交者的内容不被先写者"搬走"（唯一临时名），且无残留', () => {
    const dir = mkDir();
    const target = path.join(dir, 'a.json');

    const realWrite = fs.writeFileSync;
    let interleaved = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(
      (p: fs.PathOrFileDescriptor, d: unknown, o?: unknown) => {
        (realWrite as (...a: unknown[]) => void)(p, d, o);
        // 在 W1 写完自己的 tmp 之后、rename 之前，插入 **W2 对同一目标的整次写入**。
        // 这正是并发/重入的真实形状：两个写方都想更新同一个文件。
        if (!interleaved && String(p).includes('a.json.tmp')) {
          interleaved = true;
          writeFileAtomicSync(target, 'W2-CONTENT', { encoding: 'utf8' });
        }
      },
    );

    writeFileAtomicSync(target, 'W1-CONTENT', { encoding: 'utf8' });

    // 装置自检：插入确实发生了（否则这条测的就不是交错场景）
    expect(interleaved).toBe(true);
    // 验收断言：W1 的 rename 提交的是**W1 自己的内容**。
    //   唯一临时名 ⇒ W1 的 tmp 没被别人覆写 ⇒ 最终 = W1-CONTENT（W1 最后提交，last-writer-wins 合法）；
    //   固定临时名 ⇒ W2 覆写了 W1 的 tmp ⇒ W1 的 rename 写进去的是 **W2 的内容**
    //   （写方与临时文件的配对被打断 —— 这才是要抓的缺陷）。
    expect(fs.readFileSync(target, 'utf8')).toBe('W1-CONTENT');
    expect(residue(dir)).toEqual([]);
  });

  it('C1b：两个写方**不同目标**交错 ⇒ 互不影响，且无残留', () => {
    const dir = mkDir();
    const targetA = path.join(dir, 'a.json');
    const targetB = path.join(dir, 'b.json');

    const realWrite = fs.writeFileSync;
    let interleaved = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(
      (p: fs.PathOrFileDescriptor, d: unknown, o?: unknown) => {
        (realWrite as (...a: unknown[]) => void)(p, d, o);
        if (!interleaved && String(p).includes('a.json.tmp')) {
          interleaved = true;
          writeFileAtomicSync(targetB, 'B-CONTENT', { encoding: 'utf8' });
        }
      },
    );

    writeFileAtomicSync(targetA, 'A-CONTENT', { encoding: 'utf8' });
    expect(interleaved).toBe(true);
    expect(fs.readFileSync(targetA, 'utf8')).toBe('A-CONTENT');
    expect(fs.readFileSync(targetB, 'utf8')).toBe('B-CONTENT');
    expect(residue(dir)).toEqual([]);
  });

  it('C2 装置自检：本地复刻「固定 tmp 名」旧写法 → C1 的串档断言确实能抓到它', () => {
    const dir = mkDir();
    const targetA = path.join(dir, 'a.json');
    const targetB = path.join(dir, 'b.json');
    const fixed = path.join(dir, 'a.json.tmp'); // 旧写法：固定名（两个写方共用）

    // A 写 tmp → B 覆写同一个 tmp → A rename ⇒ A 搬走 B 的内容
    fs.writeFileSync(fixed, 'A-CONTENT', 'utf8');
    fs.writeFileSync(fixed, 'B-CONTENT', 'utf8');
    fs.renameSync(fixed, targetA);
    void targetB;

    // 证明 C1 的断言在此形状下会红：
    expect(fs.readFileSync(targetA, 'utf8')).not.toBe('A-CONTENT');
  });

  it('C3：tmpPathFor 对同一目标给出**不同**路径（结构性消除共享临时名）', () => {
    const dir = mkDir();
    const target = path.join(dir, 'state.json');
    const names = new Set([tmpPathFor(target), tmpPathFor(target), tmpPathFor(target)]);
    expect(names.size).toBe(3);
    for (const n of names) {
      expect(path.dirname(n)).toBe(dir); // 同目录（EXDEV 防线）
      expect(path.basename(n)).toContain('.tmp-');
    }
  });

  it('C4：连续 60 次写入（两目标交替）后目录里零 .tmp-* 残留', () => {
    const dir = mkDir();
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    for (let i = 0; i < 60; i += 1) {
      writeFileAtomicSync(i % 2 === 0 ? a : b, `v${i}`, { encoding: 'utf8' });
    }
    expect(fs.readFileSync(a, 'utf8')).toBe('v58');
    expect(fs.readFileSync(b, 'utf8')).toBe('v59');
    expect(residue(dir)).toEqual([]);
  });
});
