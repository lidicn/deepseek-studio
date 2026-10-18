/**
 * consent-whitelist-store.ts — 持久白名单存储
 *
 * 文件：~/.config/deepseek-studio/consent-whitelist.json
 * fs 全部注入，单测用 mock。
 */

import type { ActionKind, WhitelistEntry } from './consent-router';

export interface WhitelistFile {
  readonly version: 1;
  readonly entries: readonly WhitelistEntry[];
}

export type WhitelistError = 'invalid-argument' | 'io-error' | 'limit-exceeded' | 'not-found';

export interface WhitelistStore {
  readonly path: string;
  load(): { entries: readonly WhitelistEntry[]; error?: WhitelistError };
  add(input: { toolId: string; action: ActionKind; pathPattern: string; workspaceHash: string; ttlMs?: number; note?: string }):
    { ok: true; entry: WhitelistEntry } | { ok: false; error: WhitelistError; detail?: string };
  remove(id: string): { ok: true } | { ok: false; error: WhitelistError };
  list(workspaceHash?: string): readonly WhitelistEntry[];
  invalidateWorkspace(workspaceHash: string): number;
}

const MAX_ENTRIES = 200;
const MAX_PATTERN_LEN = 512;

function generateId(): string {
  return 'wl_' + crypto.randomUUID().slice(0, 8);
}

export function createWhitelistStore(deps: {
  homedir: string;
  readFile(p: string): string;
  writeFile(p: string, data: string): void;
  mkdirp(p: string): void;
}): WhitelistStore {
  const path = `${deps.homedir}/.config/deepseek-studio/consent-whitelist.json`;
  let cache: WhitelistFile | null = null;

  function loadInternal(): { entries: readonly WhitelistEntry[]; error?: WhitelistError } {
    if (cache) return { entries: cache.entries };
    try {
      const raw = deps.readFile(path);
      const parsed = JSON.parse(raw) as WhitelistFile;
      if (parsed.version !== 1) return { entries: [], error: 'invalid-argument' };
      cache = parsed;
      return { entries: parsed.entries };
    } catch {
      return { entries: [] };
    }
  }

  function save(entries: readonly WhitelistEntry[]): void {
    deps.mkdirp(`${deps.homedir}/.config/deepseek-studio`);
    const data = JSON.stringify({ version: 1, entries }, null, 2);
    deps.writeFile(path, data);
    cache = { version: 1, entries };
  }

  return {
    path,
    load: loadInternal,
    add(input) {
      // 校验 pattern
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

      const entry: WhitelistEntry = {
        id: generateId(),
        toolId: input.toolId,
        action: input.action,
        pathPattern: input.pathPattern,
        workspaceHash: input.workspaceHash,
        createdAt: Date.now(),
        ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
        ...(input.note ? { note: input.note } : {}),
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
    invalidateWorkspace(workspaceHash) {
      const { entries } = loadInternal();
      const filtered = entries.filter((e) => e.workspaceHash !== workspaceHash);
      save(filtered);
      return entries.length - filtered.length;
    },
  };
}
