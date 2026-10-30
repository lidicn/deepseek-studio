/**
 * M10-10：记忆审计日志验收测试。
 *
 * 契约：
 *   - save / archive / purge 都留痕；
 *   - rollback 能按「操作前快照」还原被 purge 的行；
 *   - rollback 能撤销候选 promote / reject。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStore } from '../../src/host/memory-store';

const opened: MemoryStore[] = [];
const tmpRoot = path.join(os.tmpdir(), `studio-mem-log-test-${Date.now()}`);

function newStore(): MemoryStore {
  const p = path.join(tmpRoot, `mem-${Math.random().toString(36).slice(2, 8)}.db`);
  const s = new MemoryStore(p);
  opened.push(s);
  return s;
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('M10-10 记忆审计日志', () => {
  it('save 留痕，op=save 且带 after 快照', async () => {
    const s = newStore();
    const r = s.save({ type: 'user', name: '日志用户', content: '内容A' });
    expect(r.ok).toBe(true);
    const log = await s.listLog();
    expect(log.length).toBeGreaterThan(0);
    const e = log[0];
    expect(e.op).toBe('save');
    expect(e.memoryId).toBe(r.id);
    expect(e.after?.name).toBe('日志用户');
  });

  it('invalidate → op=archive，restore → op=restore', async () => {
    const s = newStore();
    const r = s.save({ type: 'user', name: '归档用户', content: '内容B' });
    await s.invalidate(r.id!);
    await s.restore(r.id!);
    const ops = (await s.listLog({ memoryId: r.id })).map((e) => e.op);
    expect(ops).toContain('archive');
    expect(ops).toContain('restore');
  });

  it('remove → op=purge，且 rollback 能把行还原回来', async () => {
    const s = newStore();
    const r = s.save({ type: 'project', name: '待删项目', content: '内容C' });
    expect(s.remove(r.id!)).toBe(true);
    expect(await s.list()).toHaveLength(0);

    const purge = (await s.listLog({ memoryId: r.id })).find((e) => e.op === 'purge');
    expect(purge).toBeTruthy();

    const rb = await s.rollback(purge!.id);
    expect(rb.ok).toBe(true);

    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('待删项目');
    expect(list[0].content).toBe('内容C');
  });

  it('rollback 对新建记录（before=null）是删除该行', async () => {
    const s = newStore();
    const r = s.save({ type: 'user', name: '新建即回滚', content: '内容D' });
    const save = (await s.listLog({ memoryId: r.id })).find((e) => e.op === 'save');
    expect(save!.before).toBeNull();
    const rb = await s.rollback(save!.id);
    expect(rb.ok).toBe(true);
    expect(await s.list()).toHaveLength(0);
  });

  it('rollback 能撤销 candidate-promote：记忆删除，候选还原', async () => {
    const s = newStore();
    const c = s.addCandidate({ type: 'user', name: '候选甲', content: '内容E' });
    const p = await s.promoteCandidate(c.id!);
    expect(p.ok).toBe(true);
    expect(await s.list()).toHaveLength(1);

    const entry = (await s.listLog()).find((e) => e.op === 'candidate-promote');
    expect(entry).toBeTruthy();
    const rb = await s.rollback(entry!.id);
    expect(rb.ok).toBe(true);

    expect(await s.list()).toHaveLength(0);
    const cands = await s.listCandidates();
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe('候选甲');
  });

  it('rollback 能撤销 candidate-reject：候选还原', async () => {
    const s = newStore();
    const c = s.addCandidate({ type: 'user', name: '候选乙', content: '内容F' });
    await s.rejectCandidate(c.id!, '先留着');
    expect(await s.listCandidates()).toHaveLength(0);

    const entry = (await s.listLog()).find((e) => e.op === 'candidate-reject');
    expect(entry).toBeTruthy();
    const rb = await s.rollback(entry!.id);
    expect(rb.ok).toBe(true);
    expect(await s.listCandidates()).toHaveLength(1);
  });

  it('rollback 不存在的 logId 返回 ok:false', async () => {
    const s = newStore();
    const rb = await s.rollback(999999);
    expect(rb.ok).toBe(false);
  });
});