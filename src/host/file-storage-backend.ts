/**
 * 文件落盘 KV backend（v0.7）
 *
 * 替换内存版 createMemoryStorageKvBackend：local storage 原子写 JSON 到磁盘，
 * 重启后数据不丢。session 轨仍走内存（R13：授权态不落盘）。
 *
 * 原子写：先写 .tmp 再 rename，避免崩溃留下半截文件。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StorageKvBackend, StorageKvWriteBatch } from '../bridge/storage';

export interface FileStorageKvBackendOptions {
  /** 存储文件绝对路径（如 ~/.config/deepseek-studio/storage.json）。 */
  filePath: string;
}

export function createFileStorageKvBackend(options: FileStorageKvBackendOptions): StorageKvBackend {
  const { filePath } = options;
  let writeChain: Promise<void> = Promise.resolve();

  async function ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  async function readAll(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      // 文件损坏：不静默吞掉，但也不让宿主起不来——返回空并打警告
      console.warn(`[storage] failed to read ${filePath}, starting empty: ${(err as Error).message}`);
      return {};
    }
  }

  async function writeBatch(batch: StorageKvWriteBatch): Promise<void> {
    // 串行化写：避免并发写交错。
    //
    // QD-R2-02 修复（写链静默丢数据）：
    // 旧写法 `writeChain.then(work, onRejected)` 里，onRejected 只打 warn 不 rethrow——
    // 这意味着「前一批失败」会让**当前这批的 work 根本不执行**，但 `await writeChain`
    // 照样 resolve。调用方以为写成功了，实际数据没落盘。
    //
    // 新写法把两件事拆开：
    //   1. 前一批失败 → `.catch()` 吞掉并告警，让当前批照样执行（不被毒化）；
    //   2. 当前批自己失败 → 自然沿链 reject，`await writeChain` 抛给调用方。
    // 这样调用方要么拿到确认（写成功），要么拿到 reject（写失败），二选一，
    // 不再有「调用方拿到 resolve 但数据没写」的中间态。
    writeChain = writeChain
      .catch((err: unknown) => {
        console.warn(`[storage] previous write failed, chain continues: ${(err as Error).message}`);
      })
      .then(async () => {
        const current = await readAll();
        for (const key of batch.remove) delete current[key];
        for (const [key, value] of Object.entries(batch.set)) current[key] = value;
        await ensureDir();
        const tmp = `${filePath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(current, null, 2), 'utf8');
        await fs.rename(tmp, filePath);
      });
    await writeChain;
  }

  return { readAll, writeBatch };
}
