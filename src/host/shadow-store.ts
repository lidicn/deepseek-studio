/**
 * shadow-store.ts — 写前快照回滚（E2）
 *
 * file.edit / file.write / shell.exec 改文件前，把原内容快照到
 * ~/.config/deepseek-studio/shadow/<hash>.bin，支持 rollback。
 *
 * fs 全部注入，单测用 mock。
 */

import { createHash } from 'crypto';

export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_SNAPSHOTS = 500;

export type ShadowError =
  | 'invalid-argument'
  | 'not-found'
  | 'io-error'
  | 'limit-exceeded'
  | 'file-too-large';

export interface SnapshotRecord {
  readonly id: string;
  readonly workspaceHash: string;
  readonly relPath: string;
  readonly absPath: string;
  readonly size: number;
  readonly createdAt: number;
  readonly source: 'file.edit' | 'file.write' | 'shell.exec';
  readonly checksum: string;
}

export interface ShadowStore {
  readonly root: string;
  /** 写前快照。文件不存在则 size=0、checksum='e3b0c44298fc1c149afbf4c8996fb924'。 */
  capture(input: {
    absPath: string;
    relPath: string;
    workspaceHash: string;
    source: SnapshotRecord['source'];
  }): { ok: true; record: SnapshotRecord } | { ok: false; error: ShadowError; detail?: string };
  /** 按 id 回滚：把快照内容写回 absPath。 */
  rollback(id: string): { ok: true; bytes: number } | { ok: false; error: ShadowError; detail?: string };
  /** 列出某工作区的快照。 */
  list(workspaceHash?: string): readonly SnapshotRecord[];
  /** 删除单条快照。 */
  remove(id: string): { ok: true } | { ok: false; error: ShadowError };
  /** 工作区切换时清掉旧快照。 */
  invalidateWorkspace(workspaceHash: string): number;
}

interface ShadowDeps {
  homedir: string;
  readFile(p: string): Buffer;
  writeFile(p: string, data: Buffer): void;
  readJson<T>(p: string): T;
  writeJson(p: string, data: unknown): void;
  exists(p: string): boolean;
  mkdirp(p: string): void;
  unlink(p: string): void;
}

function hashPath(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

function emptyHash(): string {
  return createHash('sha256').update('').digest('hex');
}

export function createShadowStore(deps: ShadowDeps): ShadowStore {
  const root = `${deps.homedir}/.config/deepseek-studio/shadow`;
  const indexPath = `${root}/index.json`;

  function loadIndex(): SnapshotRecord[] {
    if (!deps.exists(indexPath)) return [];
    try {
      const parsed = deps.readJson<{ version: 1; records: SnapshotRecord[] }>(indexPath);
      return parsed.records ?? [];
    } catch {
      return [];
    }
  }

  function saveIndex(records: SnapshotRecord[]): void {
    deps.mkdirp(root);
    deps.writeJson(indexPath, { version: 1, records });
  }

  return {
    root,
    capture({ absPath, relPath, workspaceHash, source }) {
      if (!absPath || !relPath || !workspaceHash) {
        return { ok: false, error: 'invalid-argument', detail: 'missing required fields' };
      }
      if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || relPath.includes('..')) {
        return { ok: false, error: 'invalid-argument', detail: 'relPath must be workspace-relative' };
      }

      let content: Buffer;
      let size = 0;
      let checksum = emptyHash();
      try {
        content = deps.readFile(absPath);
        size = content.length;
        if (size > MAX_SNAPSHOT_BYTES) {
          return { ok: false, error: 'file-too-large', detail: `${size} > ${MAX_SNAPSHOT_BYTES}` };
        }
        checksum = createHash('sha256').update(content).digest('hex');
      } catch {
        content = Buffer.alloc(0);
      }

      const records = loadIndex();
      if (records.length >= MAX_SNAPSHOTS) {
        return { ok: false, error: 'limit-exceeded', detail: `max ${MAX_SNAPSHOTS} snapshots` };
      }

      const id = 'sh_' + createHash('sha1').update(`${absPath}:${Date.now()}`).digest('hex').slice(0, 10);
      const dataPath = `${root}/${id}.bin`;

      deps.mkdirp(root);
      deps.writeFile(dataPath, content);

      const record: SnapshotRecord = {
        id,
        workspaceHash,
        relPath,
        absPath,
        size,
        createdAt: Date.now(),
        source,
        checksum,
      };
      saveIndex([record, ...records]);
      return { ok: true, record };
    },

    rollback(id) {
      const records = loadIndex();
      const rec = records.find((r) => r.id === id);
      if (!rec) return { ok: false, error: 'not-found', detail: id };

      const dataPath = `${root}/${id}.bin`;
      if (!deps.exists(dataPath)) {
        return { ok: false, error: 'io-error', detail: `snapshot file missing: ${dataPath}` };
      }
      const content = deps.readFile(dataPath);
      try {
        deps.writeFile(rec.absPath, content);
      } catch (e) {
        return { ok: false, error: 'io-error', detail: String(e) };
      }
      return { ok: true, bytes: content.length };
    },

    list(workspaceHash) {
      const records = loadIndex();
      if (!workspaceHash) return records;
      return records.filter((r) => r.workspaceHash === workspaceHash);
    },

    remove(id) {
      const records = loadIndex();
      const rec = records.find((r) => r.id === id);
      if (!rec) return { ok: false, error: 'not-found' };
      try { deps.unlink(`${root}/${id}.bin`); } catch { /* ignore */ }
      saveIndex(records.filter((r) => r.id !== id));
      return { ok: true };
    },

    invalidateWorkspace(workspaceHash) {
      const records = loadIndex();
      const kept = records.filter((r) => r.workspaceHash !== workspaceHash);
      for (const r of records) {
        if (r.workspaceHash === workspaceHash) {
          try { deps.unlink(`${root}/${r.id}.bin`); } catch { /* ignore */ }
        }
      }
      saveIndex(kept);
      return records.length - kept.length;
    },
  };
}

export { hashPath };
