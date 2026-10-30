/**
 * M10-11：workspace 隔离验收测试。
 *
 * 契约：
 *   - default workspace 沿用历史单库路径；
 *   - 非 default workspace 用独立 .db，互相看不到对方的记忆；
 *   - workspace 索引文件登记了所有用过的 id。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MemoryStore,
  DEFAULT_WORKSPACE_ID,
  workspaceSlug,
  workspaceStorePath,
  listWorkspaceIds,
} from '../../src/host/memory-store';

const opened: MemoryStore[] = [];
function track(s: MemoryStore): MemoryStore { opened.push(s); return s; }
const tmpRoot = path.join(os.tmpdir(), `studio-mem-ws-test-${Date.now()}`);
let basePath = '';

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  basePath = path.join(tmpRoot, 'memories.db');
});

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('M10-11 workspace 隔离', () => {
  it('default workspace 沿用原路径，不生成 .ws- 文件', () => {
    expect(workspaceStorePath(basePath, DEFAULT_WORKSPACE_ID)).toBe(basePath);
    expect(workspaceStorePath(basePath, '')).toBe(basePath);
  });

  it('非 default workspace 生成独立的 .ws-<slug>.db 路径', () => {
    const p = workspaceStorePath(basePath, 'proj-a');
    expect(p).not.toBe(basePath);
    expect(path.dirname(p)).toBe(path.dirname(basePath));
    expect(path.basename(p)).toMatch(/^memories\.ws-.+\.db$/);
    expect(p).toBe(workspaceStorePath(basePath, 'proj-a'));
    expect(p).not.toBe(workspaceStorePath(basePath, 'proj-b'));
  });

  it('workspaceSlug 清洗非法字符并带 hash 尾巴，不撞名', () => {
    expect(workspaceSlug('a/b')).toMatch(/^a_b-[0-9a-f]{8}$/);
    expect(workspaceSlug('a/b')).not.toBe(workspaceSlug('a_b'));
  });

  it('workspace A 的记忆在 workspace B 不可见', async () => {
    const a = track(new MemoryStore(basePath, { workspaceId: 'proj-a' }));
    const b = track(new MemoryStore(basePath, { workspaceId: 'proj-b' }));

    const ra = a.save({ type: 'project', name: 'A的记忆', content: '只属于A' });
    expect(ra.ok).toBe(true);

    expect(await a.list()).toHaveLength(1);
    expect(await b.list()).toHaveLength(0);
    expect(await b.search('只属于A')).toHaveLength(0);

    const rb = b.save({ type: 'project', name: 'B的记忆', content: '只属于B' });
    expect(rb.ok).toBe(true);
    expect(await b.list()).toHaveLength(1);
    expect(await a.list()).toHaveLength(1);
    expect((await a.list())[0].name).toBe('A的记忆');
    expect((await b.list())[0].name).toBe('B的记忆');
  });

  it('getWorkspaceId 返回所属 workspace', () => {
    const a = track(new MemoryStore(basePath, { workspaceId: 'proj-a' }));
    expect(a.getWorkspaceId()).toBe('proj-a');
    const d = track(new MemoryStore(basePath));
    expect(d.getWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('workspace 索引文件登记所有用过的 id', () => {
    track(new MemoryStore(basePath, { workspaceId: 'proj-a' }));
    track(new MemoryStore(basePath, { workspaceId: 'proj-b' }));
    const ids = listWorkspaceIds(basePath);
    expect(ids).toContain(DEFAULT_WORKSPACE_ID);
    expect(ids).toContain('proj-a');
    expect(ids).toContain('proj-b');
  });
});