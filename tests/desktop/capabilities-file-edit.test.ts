/**
 * file.edit 能力测试（M5-2）
 *
 * 覆盖：纯函数 applyTextEdit + 能力外壳 createFileEditCapability
 * 全部用临时目录，不依赖真实仓库树。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  applyTextEdit,
  countOverlappingOccurrences,
  createFileEditCapability,
  EDIT_TOOL_ID,
} from '../../src/capabilities/edit-engine';
import { createWorkspace } from '../../src/host/workspace';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'edit-engine-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 纯函数核心
// ---------------------------------------------------------------------------

describe('applyTextEdit 纯函数', () => {
  it('唯一匹配：替换成功', () => {
    const out = applyTextEdit('hello world', [{ oldString: 'world', newString: 'there' }]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe('hello there');
      expect(out.changed).toBe(true);
      expect(out.replacements).toBe(1);
    }
  });

  it('no-op：oldString === newString 时 changed=false', () => {
    const out = applyTextEdit('hello', [{ oldString: 'hello', newString: 'hello' }]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.changed).toBe(false);
      expect(out.replacements).toBe(0);
    }
  });

  it('未命中：返回 old-string-not-found', () => {
    const out = applyTextEdit('hello', [{ oldString: 'xyz', newString: 'abc' }]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('old-string-not-found');
  });

  it('多命中：返回 match-ambiguous', () => {
    const out = applyTextEdit('aaa', [{ oldString: 'aa', newString: 'b' }]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('match-ambiguous');
  });

  it('批量：多条按顺序应用', () => {
    const out = applyTextEdit('a=1; b=2;', [
      { oldString: 'a=1', newString: 'a=10' },
      { oldString: 'b=2', newString: 'b=20' },
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe('a=10; b=20;');
      expect(out.replacements).toBe(2);
    }
  });

  it('批量原子性：第二条失败时第一条不落盘', () => {
    const out = applyTextEdit('a=1; b=2;', [
      { oldString: 'a=1', newString: 'a=10' },
      { oldString: 'xyz', newString: 'abc' },
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('old-string-not-found');
  });
});

describe('countOverlappingOccurrences', () => {
  it('正常计数', () => {
    expect(countOverlappingOccurrences('ababa', 'aba')).toBe(2);
  });

  it('空 needle 抛 TypeError', () => {
    expect(() => countOverlappingOccurrences('abc', '')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 能力外壳
// ---------------------------------------------------------------------------

describe('createFileEditCapability 外壳', () => {
  it('id 是 file.edit', () => {
    const cap = createFileEditCapability({ workspace: null });
    expect(cap.id).toBe(EDIT_TOOL_ID);
    expect(EDIT_TOOL_ID).toBe('file.edit');
  });

  it('未配置工作区 → workspace-unconfigured', async () => {
    const cap = createFileEditCapability({ workspace: null });
    const res = await cap.execute({ path: 'a.txt', edits: [{ oldString: 'x', newString: 'y' }] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('workspace-unconfigured');
  });

  it('缺 path → missing-argument', async () => {
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({ edits: [{ oldString: 'x', newString: 'y' }] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing-argument');
  });

  it('正常替换 → ok + changed', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'hello world');
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: 'world', newString: 'there' }],
    });
    expect(res.ok).toBe(true);
    expect(res.isError).toBe(false);
    const data = res.data as { unchanged: boolean; replacements: number };
    expect(data.unchanged).toBe(false);
    expect(data.replacements).toBe(1);
    const after = await fsp.readFile(path.join(tmpDir, 'a.txt'), 'utf8');
    expect(after).toBe('hello there');
  });

  it('未命中 → not-found，文件未变', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: 'xyz', newString: 'abc' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not-found');
    const after = await fsp.readFile(path.join(tmpDir, 'a.txt'), 'utf8');
    expect(after).toBe('hello');
  });

  it('多命中 → invalid-argument(match-ambiguous)', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'aaa');
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: 'aa', newString: 'b' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
  });

  it('目标不存在 → not-found(target-missing)', async () => {
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'nonexistent.txt',
      edits: [{ oldString: 'x', newString: 'y' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not-found');
  });

  it('越界路径 → outside-workspace', async () => {
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: '../outside.txt',
      edits: [{ oldString: 'x', newString: 'y' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('outside-workspace');
  });

  it('空 oldString → invalid-argument(empty-old-string)', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: '', newString: 'x' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
  });

  it('CRLF 文件：CRLF oldString 成功', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'line1\r\nline2\r\n');
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: 'line1', newString: 'LINE1' }],
    });
    expect(res.ok).toBe(true);
    const after = await fsp.readFile(path.join(tmpDir, 'a.txt'), 'utf8');
    expect(after).toBe('LINE1\r\nline2\r\n');
  });

  it('BOM 文件：编辑后 BOM 保留', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), Buffer.concat([bom, Buffer.from('hello')]));
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: 'hello', newString: 'HELLO' }],
    });
    expect(res.ok).toBe(true);
    const after = await fsp.readFile(path.join(tmpDir, 'a.txt'));
    expect(after[0]).toBe(0xef);
    expect(after[1]).toBe(0xbb);
    expect(after[2]).toBe(0xbf);
  });

  it('dryRun=true：不落盘', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: 'hello', newString: 'HELLO' }],
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    const data = res.data as { unchanged: boolean };
    expect(data.unchanged).toBe(true);
    const after = await fsp.readFile(path.join(tmpDir, 'a.txt'), 'utf8');
    expect(after).toBe('hello');
  });

  it('expectedSha256 不匹配 → io-error(content-changed)', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'a.txt',
      edits: [{ oldString: 'hello', newString: 'HELLO' }],
      expectedSha256: crypto.createHash('sha256').update('wrong').digest('hex'),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('io-error');
  });

  it('目录 → invalid-argument(not-a-file)', async () => {
    await fsp.mkdir(path.join(tmpDir, 'sub'));
    const ws = createWorkspace(tmpDir);
    const cap = createFileEditCapability({ workspace: ws });
    const res = await cap.execute({
      path: 'sub',
      edits: [{ oldString: 'x', newString: 'y' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
  });
});
