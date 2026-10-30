/**
 * M10-9：记忆候选池验收测试。
 *
 * 契约：
 *   - 候选**不进正式注入**（list / search / formatForPrompt 都看不到）；
 *   - promote 之后才成为正式记忆，且候选从池子里消失；
 *   - reject 之后候选从池子里消失，且内容留在审计日志里可回滚。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStore } from '../../src/host/memory-store';

const opened: MemoryStore[] = [];
const tmpRoot = path.join(os.tmpdir(), `studio-mem-cand-test-${Date.now()}`);

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

describe('M10-9 记忆候选池', () => {
  it('addCandidate 校验：非法 type / 缺 name / 缺 content 都拒绝', () => {
    const s = newStore();
    expect(s.addCandidate({ type: 'note', name: 'x', content: 'y' }).ok).toBe(false);
    expect(s.addCandidate({ type: 'user', name: '', content: 'y' }).ok).toBe(false);
    expect(s.addCandidate({ type: 'user', name: 'x', content: '' }).ok).toBe(false);
  });

  it('候选不进 list / search / formatForPrompt', async () => {
    const s = newStore();
    const r = s.addCandidate({
      type: 'project',
      name: '候选项目',
      content: 'AlphaForge 渲染管线',
      tags: ['render'],
      reason: '用户口头提到',
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBeTruthy();

    expect(await s.list()).toHaveLength(0);
    expect(await s.search('AlphaForge')).toHaveLength(0);
    expect(s.formatForPrompt([])).not.toContain('AlphaForge');

    const cands = await s.listCandidates();
    expect(cands).toHaveLength(1);
    expect(cands[0].name).toBe('候选项目');
    expect(cands[0].tags).toEqual(['render']);
    expect(cands[0].reason).toBe('用户口头提到');
  });

  it('getCandidate 能按 id 取回，错的 id 返回 undefined', async () => {
    const s = newStore();
    const r = s.addCandidate({ type: 'user', name: 'n', content: 'c' });
    expect(await s.getCandidate(r.id!)).toBeTruthy();
    expect(await s.getCandidate('cand-not-exist')).toBeUndefined();
  });

  it('promoteCandidate：转正后正式可见，且候选池移除', async () => {
    const s = newStore();
    const r = s.addCandidate({ type: 'project', name: '候选项目', content: 'PromoteMe 内容', tags: ['a'] });
    const p = await s.promoteCandidate(r.id!);
    expect(p.ok).toBe(true);
    expect(p.id).toBeTruthy();

    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('候选项目');
    expect(await s.search('PromoteMe')).toHaveLength(1);

    expect(await s.listCandidates()).toHaveLength(0);
  });

  it('promoteCandidate：对不存在的候选返回 ok:false', async () => {
    const s = newStore();
    const p = await s.promoteCandidate('cand-nope');
    expect(p.ok).toBe(false);
  });

  it('rejectCandidate：候选消失，正式记忆不出现，内容留在日志里', async () => {
    const s = newStore();
    const r = s.addCandidate({ type: 'user', name: '待否决', content: 'RejectMe 内容' });
    expect(await s.rejectCandidate(r.id!, '不适合长期保留')).toBe(true);

    expect(await s.listCandidates()).toHaveLength(0);
    expect(await s.list()).toHaveLength(0);

    const log = await s.listLog();
    const entry = log.find((e) => e.op === 'candidate-reject');
    expect(entry).toBeTruthy();
    expect(entry!.note).toContain('RejectMe 内容');
  });

  it('rejectCandidate：不存在的候选返回 false', async () => {
    const s = newStore();
    expect(await s.rejectCandidate('cand-nope')).toBe(false);
  });
});