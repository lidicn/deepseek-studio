/**
 * QD-02 复现用例：edit-engine 的替换串未做 `$` 转义 ⇒ 静默数据损坏
 *
 * 运行方式（本文件所在目录不在 vitest include 面内，需临时复制到 tests/desktop/ 跑）：
 *   cp docs/审计报告/QD/复现用例/qd-02-edit-engine-dollar.test.ts tests/desktop/
 *   npx vitest run tests/desktop/qd-02-edit-engine-dollar.test.ts
 *   rm tests/desktop/qd-02-edit-engine-dollar.test.ts
 *
 * 判定：断言写的是"字面写入"这一期望行为 ⇒ **用例失败＝缺陷复现（Verified-实证）**。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyEdits } from '../../src/host/kernel/edit-engine';

function withFile(content: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qd02-'));
  writeFileSync(join(dir, 'a.txt'), content, 'utf-8');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('QD-02 applyEdits 替换串的 $ 特殊模式', () => {
  it("QD-02a newText 含 $` 时应原样写入（实际会被展开为『匹配点之前的原文』）", () => {
    const { dir, cleanup } = withFile('Hello world');
    try {
      const res = applyEdits(dir, [{ path: 'a.txt', oldText: 'world', newText: 'X$`Y' }]);
      const after = readFileSync(join(dir, 'a.txt'), 'utf-8');
      expect(res.ok).toBe(true);
      expect(res.files[0].replacements).toBe(1);
      expect(after).toBe('Hello X$`Y');
    } finally {
      cleanup();
    }
  });

  it('QD-02b newText 含 $& 时写入结果应为字面 $&（实际被展开为匹配到的原文本身）', () => {
    const { dir, cleanup } = withFile('Hello world');
    try {
      const res = applyEdits(dir, [{ path: 'a.txt', oldText: 'world', newText: '$&!' }]);
      const after = readFileSync(join(dir, 'a.txt'), 'utf-8');
      expect(res.ok).toBe(true);
      expect(after).toBe('Hello $&!');
    } finally {
      cleanup();
    }
  });

  it('QD-02c 唯一性预检查用 split 计数、替换用 replace，二者对重叠匹配口径不同', () => {
    const { dir, cleanup } = withFile('aaa');
    try {
      const res = applyEdits(dir, [{ path: 'a.txt', oldText: 'aa', newText: 'b' }]);
      expect(res.ok).toBe(false);
      expect(res.files[0].error).toMatch(/not unique/);
    } finally {
      cleanup();
    }
  });
});
