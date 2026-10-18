import { describe, it, expect } from 'vitest';
import {
  classifyAction,
  routeConsent,
  type ConsentRouteInput,
  type WhitelistEntry,
} from '../../src/host/consent-router';
import { createWhitelistStore } from '../../src/host/consent-whitelist-store';

function makeInput(overrides: Partial<ConsentRouteInput> = {}): ConsentRouteInput {
  return {
    toolId: 'file.read',
    params: { path: 'README.md' },
    mode: 'full',
    policy: 'allow',
    policyReason: 'not-governed',
    resolvedPath: '/ws/README.md',
    realPath: '/ws/README.md',
    relPath: 'README.md',
    outside: false,
    workspaceRoot: '/ws',
    workspaceHash: 'ws-hash-1',
    whitelist: [],
    now: 1700000000000,
    ...overrides,
  };
}

describe('classifyAction', () => {
  it('file.read → read', () => {
    expect(classifyAction('file.read', {})).toBe('read');
  });
  it('file.write append=true → append', () => {
    expect(classifyAction('file.write', { append: true })).toBe('append');
  });
  it('file.write append=false → write', () => {
    expect(classifyAction('file.write', {})).toBe('write');
  });
  it('search_files grep → search-grep', () => {
    expect(classifyAction('search_files', { operation: 'grep', query: 'x' })).toBe('search-grep');
  });
  it('search_files list → search-list', () => {
    expect(classifyAction('search_files', { operation: 'list', pattern: '*.ts' })).toBe('search-list');
  });
  it('unknown → other', () => {
    expect(classifyAction('unknown.tool', {})).toBe('other');
  });
});

describe('routeConsent · policy 透传', () => {
  it('policy=deny → verdict=deny, reason=policy-deny', () => {
    const r = routeConsent(makeInput({ policy: 'deny', toolId: 'shell.exec' }));
    expect(r.verdict).toBe('deny');
    expect(r.reason).toBe('policy-deny');
  });
});

describe('routeConsent · 硬拒绝地板', () => {
  it('shell.exec format → hard-deny', () => {
    const r = routeConsent(makeInput({
      toolId: 'shell.exec',
      params: { command: 'format C:' },
      policy: 'allow',
    }));
    expect(r.verdict).toBe('deny');
    expect(r.reason).toBe('hard-deny');
    expect(r.hardRule).toBe('dangerous-disk');
  });
  it('shell.exec shutdown → hard-deny', () => {
    const r = routeConsent(makeInput({
      toolId: 'shell.exec',
      params: { command: 'shutdown /s' },
      policy: 'allow',
    }));
    expect(r.hardRule).toBe('power-control');
  });
  it('敏感路径写入 → hard-deny', () => {
    const r = routeConsent(makeInput({
      toolId: 'file.write',
      params: { path: '/etc/passwd' },
      realPath: '/etc/passwd',
      relPath: null,
      outside: true,
      policy: 'allow',
    }));
    expect(r.reason).toBe('hard-deny');
    expect(r.hardRule).toBe('sensitive-path');
  });
});

describe('routeConsent · policy=allow', () => {
  it('→ verdict=safe, reason=policy-allow', () => {
    const r = routeConsent(makeInput({ policy: 'allow' }));
    expect(r.verdict).toBe('safe');
    expect(r.reason).toBe('policy-allow');
  });
});

describe('routeConsent · require-consent + 白名单', () => {
  const wl: WhitelistEntry = {
    id: 'wl_test1',
    toolId: 'file.write',
    action: 'write',
    pathPattern: 'logs/**',
    workspaceHash: 'ws-hash-1',
    createdAt: 1700000000000,
  };

  it('白名单命中 → safe', () => {
    const r = routeConsent(makeInput({
      toolId: 'file.write',
      params: { path: 'logs/a.txt' },
      relPath: 'logs/a.txt',
      policy: 'require-consent',
      whitelist: [wl],
    }));
    expect(r.verdict).toBe('safe');
    expect(r.reason).toBe('whitelist-hit');
    expect(r.matchedEntryId).toBe('wl_test1');
  });

  it('白名单不命中 → ask, reason=whitelist-absent', () => {
    const r = routeConsent(makeInput({
      toolId: 'file.write',
      params: { path: 'src/a.ts' },
      relPath: 'src/a.ts',
      policy: 'require-consent',
      whitelist: [wl],
    }));
    expect(r.verdict).toBe('ask');
    expect(r.reason).toBe('whitelist-absent');
  });

  it('越界 → ask, reason=outside-workspace', () => {
    const r = routeConsent(makeInput({
      toolId: 'file.write',
      params: { path: '/etc/x' },
      relPath: null,
      outside: true,
      policy: 'require-consent',
      whitelist: [wl],
    }));
    expect(r.verdict).toBe('ask');
    expect(r.reason).toBe('outside-workspace');
  });

  it('TTL 过期 → ask, reason=whitelist-expired', () => {
    const expired: WhitelistEntry = { ...wl, createdAt: 1600000000000, ttlMs: 1000 };
    const r = routeConsent(makeInput({
      toolId: 'file.write',
      params: { path: 'logs/a.txt' },
      relPath: 'logs/a.txt',
      policy: 'require-consent',
      whitelist: [expired],
      now: 1700000000000,
    }));
    expect(r.verdict).toBe('ask');
    expect(r.reason).toBe('whitelist-expired');
  });

  it('action 不匹配 → ask, reason=action-mismatch', () => {
    // 同 toolId=file.write，但白名单 entry.action=read，调用是 write
    const wlRead: WhitelistEntry = { ...wl, action: 'read' };
    const r = routeConsent(makeInput({
      toolId: 'file.write',
      params: { path: 'logs/a.txt' },
      relPath: 'logs/a.txt',
      policy: 'require-consent',
      whitelist: [wlRead],
    }));
    expect(r.verdict).toBe('ask');
    expect(r.reason).toBe('action-mismatch');
  });
});

describe('whitelist-store', () => {
  function makeStore() {
    const mem = new Map<string, string>();
    const store = createWhitelistStore({
      homedir: '/home/user',
      readFile: (p) => {
        if (!mem.has(p)) throw new Error('not found');
        return mem.get(p)!;
      },
      writeFile: (p, data) => { mem.set(p, data); },
      mkdirp: () => {},
    });
    return { store, mem };
  }

  it('add + list 成功', () => {
    const { store } = makeStore();
    const r = store.add({
      toolId: 'file.write',
      action: 'write',
      pathPattern: 'logs/**',
      workspaceHash: 'ws-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.pathPattern).toBe('logs/**');
    expect(store.list('ws-1').length).toBe(1);
  });

  it('绝对路径被拒', () => {
    const { store } = makeStore();
    const r = store.add({
      toolId: 'file.write',
      action: 'write',
      pathPattern: '/etc/**',
      workspaceHash: 'ws-1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid-argument');
  });

  it('盘符路径被拒', () => {
    const { store } = makeStore();
    const r = store.add({
      toolId: 'file.write',
      action: 'write',
      pathPattern: 'C:/Windows/**',
      workspaceHash: 'ws-1',
    });
    expect(r.ok).toBe(false);
  });

  it('.. 段被拒', () => {
    const { store } = makeStore();
    const r = store.add({
      toolId: 'file.write',
      action: 'write',
      pathPattern: '../etc/**',
      workspaceHash: 'ws-1',
    });
    expect(r.ok).toBe(false);
  });

  it('remove 成功', () => {
    const { store } = makeStore();
    const r = store.add({
      toolId: 'file.write', action: 'write', pathPattern: 'logs/**', workspaceHash: 'ws-1',
    });
    if (!r.ok) throw new Error('add failed');
    expect(store.remove(r.entry.id).ok).toBe(true);
    expect(store.list().length).toBe(0);
  });

  it('remove 不存在 → not-found', () => {
    const { store } = makeStore();
    expect(store.remove('nonexistent').ok).toBe(false);
  });

  it('invalidateWorkspace 清对应工作区', () => {
    const { store } = makeStore();
    store.add({ toolId: 'file.write', action: 'write', pathPattern: 'a/**', workspaceHash: 'ws-1' });
    store.add({ toolId: 'file.write', action: 'write', pathPattern: 'b/**', workspaceHash: 'ws-2' });
    const removed = store.invalidateWorkspace('ws-1');
    expect(removed).toBe(1);
    expect(store.list('ws-1').length).toBe(0);
    expect(store.list('ws-2').length).toBe(1);
  });

  it('空 store load 返回空数组', () => {
    const { store } = makeStore();
    expect(store.load().entries.length).toBe(0);
  });
});
