/**
 * consent-whitelist-store.ts — 持久白名单（project 规则）存储 v2
 *
 * 文件：~/.config/deepseek-studio/consent-whitelist.json
 * fs 全部注入，单测用 mock。
 *
 * v1 → v2 迁移（A4 / §19.2）：
 * - v1.pathPattern → v2.targetKind='path' + targetPattern=pathPattern；
 * - 带 ttlMs 的 v1 条目迁成 grantScope='temporary'，不得直接变成永久 project 规则；
 * - v2 条目同时回写 pathPattern 别名，供既有 consent-router.matchWhitelist 不改。
 */

import path from 'node:path';
import type { ActionKind, WhitelistEntry } from './consent-router';

export interface WhitelistFileV2 {
  readonly version: 2;
  readonly entries: readonly WhitelistEntryV2[];
}

export type GrantScope = 'project' | 'temporary';

export interface WhitelistEntryV2 extends WhitelistEntry {
  readonly source: 'user';
  readonly grantScope: GrantScope;
  readonly targetKind: 'path';
  readonly targetPattern: string;
  readonly actionClass: ActionKind;
}

export type WhitelistError = 'invalid-argument' | 'io-error' | 'limit-exceeded' | 'not-found';

export interface WhitelistStore {
  readonly path: string;
  load(): { entries: readonly WhitelistEntryV2[]; error?: WhitelistError; migrated?: boolean };
  add(input: {
    toolId: string;
    action: ActionKind;
    pathPattern: string;
    workspaceHash: string;
    ttlMs?: number;
    note?: string;
  }): { ok: true; entry: WhitelistEntryV2 } | { ok: false; error: WhitelistError; detail?: string };
  remove(id: string): { ok: true } | { ok: false; error: WhitelistError };
  list(workspaceHash?: string): readonly WhitelistEntryV2[];
  invalidateWorkspace(workspaceHash: string): number;
}

const MAX_ENTRIES = 200;
const MAX_PATTERN_LEN = 512;

function generateId(): string {
  return 'wl_' + crypto.randomUUID().slice(0, 8);
}

/** v1 → v2 归一化。脏条目（绝对路径/盘符/..）返回 null，读取时视为无效并记录。 */
function normalizeEntry(raw: Record<string, unknown>): WhitelistEntryV2 | null {
  const id = typeof raw.id === 'string' ? raw.id : null;
  const toolId = typeof raw.toolId === 'string' ? raw.toolId : null;
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : null;
  const workspaceHash = typeof raw.workspaceHash === 'string' ? raw.workspaceHash : null;
  if (!id || !toolId || createdAt === null || !workspaceHash) return null;

  const action = (typeof raw.action === 'string' ? raw.action : 'other') as ActionKind;
  // v2 字段优先；v1 用 pathPattern 回填。
  const targetKind = raw.targetKind === 'path' ? 'path' : 'path';
  const targetPattern = typeof raw.targetPattern === 'string' ? raw.targetPattern
    : typeof raw.pathPattern === 'string' ? raw.pathPattern : null;
  if (!targetPattern) return null;

  // 红线：绝对路径 / 盘符 / .. / 空 / 超长 一律拒绝。
  if (!targetPattern
    || targetPattern.startsWith('/')
    || /^[a-zA-Z]:/.test(targetPattern)
    || targetPattern.includes('..')
    || targetPattern.length > MAX_PATTERN_LEN) {
    return null;
  }

  const ttlMs = typeof raw.ttlMs === 'number' && raw.ttlMs > 0 ? raw.ttlMs : undefined;
  const grantScope: GrantScope = ttlMs ? 'temporary' : 'project';
  const note = typeof raw.note === 'string' ? raw.note : undefined;

  return {
    id,
    toolId,
    action,
    actionClass: action,
    pathPattern: targetPattern, // 别名，供既有 matchWhitelist 不改
    workspaceHash,
    createdAt,
    ...(ttlMs ? { ttlMs } : {}),
    ...(note ? { note } : {}),
    source: 'user',
    grantScope,
    targetKind,
    targetPattern,
  };
}

export function createWhitelistStore(deps: {
  homedir: string;
  readFile(p: string): string;
  writeFile(p: string, data: string): void;
  mkdirp(p: string): void;
  /** T3 可选 override：显式指定 configDir，优先于 STUDIO_CONFIG_DIR 与 homedir 回落；测试中使用。 */
  configDir?: string;
}): WhitelistStore {
  // 对齐 memory-store.ts / workspace.ts / mcp-controller.ts：STUDIO_CONFIG_DIR 优先，
  // 否则回落 ~/.config/deepseek-studio。deps.configDir 允许测试直接钉住目录。
  const configDir = deps.configDir
    ?? process.env.STUDIO_CONFIG_DIR
    ?? path.join(deps.homedir, '.config', 'deepseek-studio');
  const filePath = path.join(configDir, 'consent-whitelist.json');
  let cache: WhitelistFileV2 | null = null;

  function loadInternal(): { entries: readonly WhitelistEntryV2[]; error?: WhitelistError; migrated?: boolean } {
    if (cache) return { entries: cache.entries };
    try {
      const raw = deps.readFile(filePath);
      const parsed = JSON.parse(raw) as { version?: number; entries?: Array<Record<string, unknown>> };
      const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const normalized: WhitelistEntryV2[] = [];
      for (const e of rawEntries) {
        const n = normalizeEntry(e);
        if (n) normalized.push(n); // 脏条目静默丢弃（视为无效并记录在 length 差）
      }
      const migrated = parsed.version !== 2;
      cache = { version: 2, entries: normalized };
      return { entries: normalized, ...(migrated ? { migrated: true } : {}) };
    } catch {
      return { entries: [] };
    }
  }

  function save(entries: readonly WhitelistEntryV2[]): void {
    deps.mkdirp(configDir);
    const data = JSON.stringify({ version: 2, entries }, null, 2);
    deps.writeFile(filePath, data);
    cache = { version: 2, entries };
  }

  return {
    path: filePath,
    load: loadInternal,
    add(input) {
      if (!input.pathPattern || input.pathPattern.length > MAX_PATTERN_LEN) {
        return { ok: false, error: 'invalid-argument', detail: 'pathPattern invalid' };
      }
      if (input.pathPattern.startsWith('/') || /^[a-zA-Z]:/.test(input.pathPattern) || input.pathPattern.includes('..')) {
        return { ok: false, error: 'invalid-argument', detail: 'pathPattern must be relative' };
      }

      const { entries } = loadInternal();
      if (entries.length >= MAX_ENTRIES) {
        return { ok: false, error: 'limit-exceeded', detail: `max ${MAX_ENTRIES} entries` };
      }

      const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : undefined;
      const entry: WhitelistEntryV2 = {
        id: generateId(),
        toolId: input.toolId,
        action: input.action,
        actionClass: input.action,
        pathPattern: input.pathPattern,
        targetKind: 'path',
        targetPattern: input.pathPattern,
        workspaceHash: input.workspaceHash,
        createdAt: Date.now(),
        ...(ttlMs ? { ttlMs } : {}),
        ...(input.note ? { note: input.note } : {}),
        source: 'user',
        grantScope: ttlMs ? 'temporary' : 'project',
      };

      save([...entries, entry]);
      return { ok: true, entry };
    },
    remove(id) {
      const { entries } = loadInternal();
      const filtered = entries.filter((e) => e.id !== id);
      if (filtered.length === entries.length) {
        return { ok: false, error: 'not-found' };
      }
      save(filtered);
      return { ok: true };
    },
    list(workspaceHash) {
      const { entries } = loadInternal();
      if (!workspaceHash) return entries;
      return entries.filter((e) => e.workspaceHash === workspaceHash);
    },
    invalidateWorkspace(workspaceHash: string) {
      const { entries } = loadInternal();
      const filtered = entries.filter((e) => e.workspaceHash !== workspaceHash);
      save(filtered);
      return entries.length - filtered.length;
    },
  };
}
