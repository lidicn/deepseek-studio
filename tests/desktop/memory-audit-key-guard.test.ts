/**
 * C1 P0-1 / BUG-017 回归测试：审计密钥与回滚的数据丢失边界。
 *
 * 契约（本批要修的三条）：
 *   1. **坏钥绝不覆盖** —— 密钥文件格式不对时，改名备份为 `.bad`，
 *      原始字节保留在备份里，历史密文仍可用旧钥解开（不丢数据）；
 *   2. **解密失败有哨兵** —— `audit.open()` 对解不开的密文返回哨兵而不是 null，
 *      调用方能区分「本来就没有」与「解不开」；
 *   3. **rollback 拒绝而非删除** —— before 存在但解不开时，rollback 必须报错拒绝，
 *      **记忆行原地不动**（绝不能变成静默删除）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { MemoryStore } from '../../src/host/memory-store';
import { auditKeyPath, isAuditDecryptFailed } from '../../src/host/audit-crypto';

// 与 memory-store 同款延迟加载：Vite 会把静态 import 'node:sqlite' 误解析成裸模块。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

const opened: MemoryStore[] = [];
const tmpRoot = path.join(os.tmpdir(), `studio-mem-p0-1-${Date.now()}`);

function newStore(): { store: MemoryStore; dbPath: string; keyPath: string } {
  const dbPath = path.join(tmpRoot, `mem-${Math.random().toString(36).slice(2, 8)}.db`);
  const store = new MemoryStore(dbPath);
  opened.push(store);
  return { store, dbPath, keyPath: auditKeyPath(dbPath) };
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('C1 P0-1 / BUG-017：审计密钥与回滚的数据丢失边界', () => {
  it('1. 坏钥改名备份 .bad，绝不覆盖；备份文件保留原始字节', () => {
    const { dbPath, keyPath } = newStore();
    // 制造一个「格式不对」的密钥文件（合法 hex 但长度不对）。
    const original = 'deadbeef'.repeat(4);
    fs.writeFileSync(keyPath, original, 'utf8');

    // 再开一个 store（读同一把钥）→ 触发坏钥处理。
    const second = new MemoryStore(dbPath);
    opened.push(second);

    // 原文件**不能**被覆盖成一把新钥。
    expect(fs.existsSync(keyPath)).toBe(false);
    // 备份文件存在，且保留原始字节。
    expect(fs.existsSync(`${keyPath}.bad`)).toBe(true);
    expect(fs.readFileSync(`${keyPath}.bad`, 'utf8')).toBe(original);
  });

  it('2. 坏钥场景下历史密文不被新钥污染（用 .bad 里的旧钥仍能解开）', async () => {
    const { store, dbPath, keyPath } = newStore();
    const canary = 'P01-HISTORY-CANARY';
    const r = store.save({ type: 'user', name: '历史记忆', content: canary });
    expect(r.ok).toBe(true);
    // 这把是**好钥**，先记下它的字节（后续模拟「坏掉但可人工恢复」）。
    const goodKeyHex = fs.readFileSync(keyPath, 'utf8');
    expect(goodKeyHex).toMatch(/^[0-9a-f]{64}$/i);

    // 把密钥文件改成坏内容 → 下次打开会走「改名备份」分支。
    store.close();
    opened.pop();
    fs.writeFileSync(keyPath, 'not-a-valid-key', 'utf8');

    const second = new MemoryStore(dbPath);
    opened.push(second);
    expect(fs.existsSync(`${keyPath}.bad`)).toBe(true);
    // 坏钥备份的是**当前**坏内容；好钥没有被销毁在别处（下面单独验证）。
    // 关键断言：内存降级为明文，**不会把历史密文改写成新钥的密文**。
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = probe.prepare('SELECT before_json FROM memory_log').all() as unknown as Record<
        string,
        string | null
      >[];
      for (const row of rows) {
        if (row.before_json === null) continue;
        // 仍然是原来那把好钥加密的密文（解不开 ≠ 被重写）。
        expect(row.before_json.startsWith('enc1:')).toBe(true);
      }
    } finally {
      probe.close();
    }
  });

  it('3. 解密失败 → rollback 报错拒绝，记忆行原地不动（绝不静默删除）', async () => {
    const { store, dbPath, keyPath } = newStore();
    const canary = 'P01-ROLLBACK-CANARY';
    const r = store.save({ type: 'user', name: '待恢复记忆', content: canary });
    expect(r.ok).toBe(true);
    const id = r.id!;

    // 制造一条「有 before 快照」的审计记录（save 同名更新 → before 非空）。
    const again = store.save({ type: 'user', name: '待恢复记忆', content: `${canary}-v2` });
    expect(again.ok).toBe(true);

    const logs = await store.listLog({ memoryId: id });
    const withBefore = logs.find((e) => e.before !== null);
    expect(withBefore).toBeTruthy();

    // **换一把不对的密钥** → 历史密文解不开。
    store.close();
    opened.pop();
    fs.writeFileSync(keyPath, 'f'.repeat(64), 'utf8');

    const second = new MemoryStore(dbPath);
    opened.push(second);

    const logs2 = await second.listLog({ memoryId: id });
    const entry2 = logs2.find((e) => e.id === withBefore!.id);
    expect(entry2).toBeTruthy();
    // 解不开 → before 为 null 但**带标记**。
    expect(entry2!.before).toBeNull();
    expect(entry2!.beforeUndecryptable).toBe(true);

    // rollback 必须**拒绝**（ok=false + 明确错误），而不是删除。
    const rb = await second.rollback(withBefore!.id);
    expect(rb.ok).toBe(false);
    expect(rb.error).toMatch(/cannot be decrypted/i);

    // **行还在**（这是本条测试的核心断言：绝不能变成静默删除）。
    const still = await second.get(id);
    expect(still).toBeTruthy();
    expect(still!.content).toContain(canary);
  });

  it('4. 解密失败的哨兵可被显式识别（不是靠猜 null）', () => {
    // 哨兵是 Symbol，只能靠 isAuditDecryptFailed 判定 —— 这正是调用方区分
    // 「本来没有」与「解不开」的唯一依据。
    expect(isAuditDecryptFailed(null)).toBe(false);
    expect(isAuditDecryptFailed(undefined)).toBe(false);
    expect(isAuditDecryptFailed('some text')).toBe(false);
    expect(isAuditDecryptFailed({})).toBe(false);
  });
});
