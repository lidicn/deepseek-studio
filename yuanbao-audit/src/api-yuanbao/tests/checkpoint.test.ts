import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteFile,
  cleanupTempFiles,
  defaultCheckpointPath,
  defaultConfigDir,
  loadCheckpoint,
  normalizeCheckpoint,
  saveCheckpoint,
  type CheckpointIo,
} from '../checkpoint';
import type { LoopStatus } from '../audit-loop';

const FIXED_NOW = 1700000000123;
const TEST_PROJECT = 'test-project';
const TEST_SESSION_URL = 'https://yuanbao.tencent.com/chat/test';

function withMeta(s: LoopStatus) {
  return { ...s, project: TEST_PROJECT, sessionUrl: TEST_SESSION_URL };
}

async function tmpDir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'yuanbao-cp-'));
}

test('save → load 往返恢复完整状态（含 version/updatedAt）', async () => {
  const dir = await tmpDir();
  const file = defaultCheckpointPath(dir);
  const status: LoopStatus = { state: 'paused', rounds: 3, target: 5, lastRound: 1699999999000 };

  const saved = await saveCheckpoint(file, withMeta(status), undefined, () => FIXED_NOW);
  assert.equal(saved.project, TEST_PROJECT);
  assert.equal(saved.sessionUrl, TEST_SESSION_URL);

  const loaded = await loadCheckpoint(file);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.checkpoint.state, 'paused');
    assert.equal(loaded.checkpoint.rounds, 3);
    assert.equal(loaded.checkpoint.project, TEST_PROJECT);
  }
  await fsp.rm(dir, { recursive: true, force: true });
});

test('原子写：先写同目录 tmp、再 rename 覆盖目标，收尾目录 fsync', async () => {
  const calls: string[] = [];
  const mem = new Map<string, string>();
  const io: CheckpointIo = {
    async ensureDir(dir) { calls.push(`mkdir:${dir}`); },
    async writeFileSynced(file, data) { calls.push(`write:${path.basename(file)}`); mem.set(file, data); },
    async rename(from, to) { calls.push(`rename:${path.basename(from)}->${path.basename(to)}`); mem.set(to, mem.get(from) as string); mem.delete(from); },
    async read(file) {
      const v = mem.get(file);
      if (v === undefined) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
      return v;
    },
    async list() { return [...mem.keys()].map((f) => path.basename(f)); },
    async remove(file) { calls.push(`remove:${path.basename(file)}`); mem.delete(file); },
    async fsyncDir() { calls.push('fsync-dir'); },
  };

  const file = '/data/checkpoint.json';
  await saveCheckpoint(file, withMeta({ state: 'running', rounds: 1, target: 2, lastRound: null }), io, () => FIXED_NOW);

  const writeIdx = calls.findIndex((c) => /^write:checkpoint\.json\.tmp-/.test(c));
  const renameIdx = calls.findIndex((c) => /^rename:checkpoint\.json\.tmp-/.test(c));
  assert.ok(writeIdx >= 0);
  assert.ok(renameIdx > writeIdx);
  assert.ok(calls.includes('fsync-dir'));

  const parsed = JSON.parse(mem.get(file) as string);
  assert.equal(parsed.rounds, 1);
  assert.equal(parsed.project, TEST_PROJECT);
});

test('rename 失败：清理 tmp 并把错误向上抛', async () => {
  const removed: string[] = [];
  const io: CheckpointIo = {
    async ensureDir() {},
    async writeFileSynced() {},
    async rename(from) { throw new Error(`rename boom: ${from}`); },
    async read() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    async list() { return []; },
    async remove(file) { removed.push(path.basename(file)); },
    async fsyncDir() {},
  };
  await assert.rejects(() => atomicWriteFile('/data/checkpoint.json', '{}', io), /rename boom/);
  assert.equal(removed.length, 1);
});

test('缺失文件 → reason=missing', async () => {
  const dir = await tmpDir();
  const loaded = await loadCheckpoint(defaultCheckpointPath(dir));
  assert.deepEqual(loaded, { ok: false, reason: 'missing' });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('损坏 JSON → reason=corrupt 且文件保持原样', async () => {
  const dir = await tmpDir();
  const file = defaultCheckpointPath(dir);
  await fsp.writeFile(file, '{"rounds": ', 'utf8');
  const loaded = await loadCheckpoint(file);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.reason, 'corrupt');
  assert.equal(await fsp.readFile(file, 'utf8'), '{"rounds": ');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('schema 不符 → null', async () => {
  const base = { version: 1, state: 'running', rounds: 1, target: 2, lastRound: null, updatedAt: 1, project: 'p', sessionUrl: 'u' };
  assert.equal(normalizeCheckpoint({ ...base, state: 'bogus' }), null);
  assert.equal(normalizeCheckpoint({ ...base, rounds: -1 }), null);
  assert.equal(normalizeCheckpoint({ ...base, target: 0 }), null);
  assert.equal(normalizeCheckpoint({ ...base, project: '' }), null);
  assert.equal(normalizeCheckpoint({ ...base, sessionUrl: '' }), null);
  assert.equal(normalizeCheckpoint({ ...base, version: 2 }), null);
  const cp = normalizeCheckpoint({ ...base, rounds: 2.7, target: 3.2 });
  assert.notEqual(cp, null);
  assert.equal(cp?.rounds, 2);
});

test('重启恢复：落盘后再读回', async () => {
  const dir = await tmpDir();
  const file = defaultCheckpointPath(dir);
  const status: LoopStatus = { state: 'running', rounds: 2, target: 3, lastRound: 1699999999000 };
  await saveCheckpoint(file, withMeta(status), undefined, () => FIXED_NOW);
  const reloaded = await loadCheckpoint(file);
  assert.equal(reloaded.ok, true);
  if (reloaded.ok) {
    assert.equal(reloaded.checkpoint.rounds, 2);
    assert.equal(reloaded.checkpoint.lastRound, 1699999999000);
  }
  await fsp.rm(dir, { recursive: true, force: true });
});

test('cleanupTempFiles 只清 *.tmp-*', async () => {
  const dir = await tmpDir();
  await fsp.writeFile(path.join(dir, 'checkpoint.json.tmp-1-abc'), 'x', 'utf8');
  await fsp.writeFile(path.join(dir, 'audit-log.jsonl'), 'z', 'utf8');
  const n = await cleanupTempFiles(dir);
  assert.equal(n, 1);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('默认配置目录 = ~/.config/yuanbao-audit', () => {
  assert.equal(defaultConfigDir({}, '/home/u'), path.join('/home/u', '.config', 'yuanbao-audit'));
  assert.equal(defaultConfigDir({ YUANBAO_AUDIT_CONFIG_DIR: '/custom' }, '/home/u'), '/custom');
});
