/**
 * M10-10 收口：审计快照加密落盘。
 *
 * 契约：
 *   1. 记忆正文不出现在 memory_log 的明文列里（db 文件里搜不到原文）；
 *   2. 加密后 rollback 仍能还原被 purge 的行（可解密）；
 *   3. forget 模式把审计快照一并抹掉，只留 sha256 指纹。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { MemoryStore } from '../../src/host/memory-store';

// 与 memory-store 同款延迟加载：Vite 会把静态 import 'node:sqlite' 误解析成裸模块。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

const opened: MemoryStore[] = [];
const tmpRoot = path.join(os.tmpdir(), `studio-mem-audit-${Date.now()}`);

function newStore(): { store: MemoryStore; dbPath: string } {
  const dbPath = path.join(tmpRoot, `mem-${Math.random().toString(36).slice(2, 8)}.db`);
  const store = new MemoryStore(dbPath);
  opened.push(store);
  return { store, dbPath };
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('M10-10 审计快照加密', () => {
  it('审计表里只有密文：删除后 db 文件搜不到正文，但 rollback 仍能还原', async () => {
    const { store, dbPath } = newStore();
    const canary = 'AUDIT-SEAL-CANARY-20261030';
    const r = store.save({ type: 'user', name: '加密用户', content: `内容 ${canary}` });
    expect(r.ok).toBe(true);

    // 主表 memories 仍存正文明文（这是注入源，必须可读）；
    // 审计表 memory_log 的 before/after/note 三列必须全是密文。
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const logs = probe
        .prepare('SELECT before_json, after_json, note FROM memory_log')
        .all() as unknown as Record<string, string | null>[];
      expect(logs.length).toBeGreaterThan(0);
      for (const row of logs) {
        for (const col of ['before_json', 'after_json', 'note'] as const) {
          const v = row[col];
          if (v === null) continue;
          expect(v.startsWith('enc1:')).toBe(true);
          expect(() => JSON.parse(v)).toThrow();
        }
      }
    } finally {
      probe.close();
    }
    // 密文列的存在证明快照不是明文落盘。
    expect(fs.readFileSync(dbPath).toString('latin1')).toContain('enc1:');

    store.remove(r.id!);
    store.compact();

    // 删完之后 db 文件里连原文都不该有（审计快照也不能把它带回来）。
    expect(fs.readFileSync(dbPath).toString('latin1')).not.toContain(canary);

    // 但 rollback 依旧可用（快照能解密）。
    const purge = (await store.listLog({ memoryId: r.id })).find((e) => e.op === 'purge');
    expect(purge).toBeTruthy();
    expect((await store.rollback(purge!.id)).ok).toBe(true);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe(`内容 ${canary}`);
  });

  it('forget 模式：审计快照被抹掉，只留 sha256 指纹', async () => {
    const { store, dbPath } = newStore();
    const canary = 'AUDIT-FORGET-CANARY-20261030';
    const r = store.save({ type: 'project', name: '待抹除项目', content: canary });
    expect(r.ok).toBe(true);

    expect(store.remove(r.id!, { forget: true })).toBe(true);
    store.compact();

    const entries = await store.listLog({ memoryId: r.id });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.before).toBeNull();
      expect(e.after).toBeNull();
    }
    const notes = entries.map((e) => e.note ?? '').join(' ');
    expect(notes).toContain('sha256:');
    expect(notes).not.toContain(canary);

    expect(fs.readFileSync(dbPath).toString('latin1')).not.toContain(canary);
  });
});
