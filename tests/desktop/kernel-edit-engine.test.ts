/**
 * C-1: edit-engine 测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdits } from '../../src/host/kernel/edit-engine';

describe('C-1 edit-engine', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'edit-engine-test-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('单文件替换成功', () => {
    writeFileSync(join(workspace, 'a.txt'), 'hello world', 'utf-8');
    const result = applyEdits(workspace, [
      { path: 'a.txt', oldText: 'world', newText: 'studio' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.files[0].ok).toBe(true);
    expect(readFileSync(join(workspace, 'a.txt'), 'utf-8')).toBe('hello studio');
  });

  it('oldText 不存在 → 失败', () => {
    writeFileSync(join(workspace, 'a.txt'), 'hello world', 'utf-8');
    const result = applyEdits(workspace, [
      { path: 'a.txt', oldText: 'nonexistent', newText: 'x' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.files[0].error).toContain('not found');
  });

  it('oldText 不唯一 → 失败', () => {
    writeFileSync(join(workspace, 'a.txt'), 'hello hello', 'utf-8');
    const result = applyEdits(workspace, [
      { path: 'a.txt', oldText: 'hello', newText: 'x' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.files[0].error).toContain('not unique');
  });

  it('多文件原子回滚：第 2 个文件失败 → 第 1 个已恢复原样', () => {
    // 准备两个文件
    writeFileSync(join(workspace, 'a.txt'), 'alpha content', 'utf-8');
    writeFileSync(join(workspace, 'b.txt'), 'beta content', 'utf-8');

    // 第 1 个文件编辑会成功，第 2 个会失败（oldText 不存在）
    const result = applyEdits(workspace, [
      { path: 'a.txt', oldText: 'alpha', newText: 'updated-alpha' },
      { path: 'b.txt', oldText: 'nonexistent', newText: 'x' },
    ]);

    expect(result.ok).toBe(false);
    // 预检查阶段失败（第 2 个文件 oldText 不存在）
    expect(result.files.length).toBe(1);
    expect(result.files[0].error).toContain('not found');
    // 预检查拦住了，没应用任何东西
    expect(result.rolledBack).toBe(false);
    // 两个文件都没变
    expect(readFileSync(join(workspace, 'a.txt'), 'utf-8')).toBe('alpha content');
    expect(readFileSync(join(workspace, 'b.txt'), 'utf-8')).toBe('beta content');
  });
});
