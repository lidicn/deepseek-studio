/**
 * 记忆层 v2 验收测试（副开发 CodeBuddy）
 *
 * 契约：src/host/bot/types.ts 的 MemoryStoreV2。
 * 完成标志（分工方案 §2.1）：
 *   - search("并发 bug") 返回相关记忆
 *   - invalidate(id) 后 list() 不返回但数据保留
 *   - listByPersona("audit") 只返回该人设记忆
 *   - formatForPrompt 兼容现有注入格式
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStore } from '../../src/host/memory-store';

const tmpRoot = path.join(os.tmpdir(), `studio-mem-v2-test-${Date.now()}`);
let storePath = '';

function newStore(): MemoryStore {
  storePath = path.join(tmpRoot, `mem-${Math.random().toString(36).slice(2, 8)}.db`);
  return new MemoryStore(storePath);
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('记忆层 v2：基础读写（v1 兼容）', () => {
  it('save 校验：非法 type / 缺字段 / confidence 越界', () => {
    const s = newStore();
    expect(s.save({ type: 'note', name: 'x', content: 'y' }).ok).toBe(false);
    expect(s.save({ type: 'user', name: '', content: 'y' }).ok).toBe(false);
    expect(s.save({ type: 'user', name: 'x', content: '' }).ok).toBe(false);
    expect(s.save({ type: 'user', name: 'x', content: 'y', confidence: 1.5 }).ok).toBe(false);
    s.close();
  });

  it('同 type+name 更新而非重复；内容一致则空操作（不搅动 updatedAt）', async () => {
    const s = newStore();
    const r1 = s.save({ type: 'user', name: '偏好', content: '喜欢深色模式' });
    const before = await s.get(r1.id!);
    await new Promise((r) => setTimeout(r, 5));
    const r2 = s.save({ type: 'user', name: '偏好', content: '喜欢浅色模式' });
    expect(r2.id).toBe(r1.id);
    const after = await s.get(r1.id!);
    expect(after!.content).toBe('喜欢浅色模式');
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
    expect((await s.list()).length).toBe(1);
    // 完全一致 → 同 id 且不搅动
    const r3 = s.save({ type: 'user', name: '偏好', content: '喜欢浅色模式' });
    expect(r3.id).toBe(r1.id);
    expect((await s.get(r1.id!))!.updatedAt).toBe(after!.updatedAt);
    s.close();
  });

  it('remove 硬删除后 list/search 均不可见', async () => {
    const s = newStore();
    const r = s.save({ type: 'user', name: '临时', content: '删除我' });
    expect(s.remove(r.id!)).toBe(true);
    expect(s.remove(r.id!)).toBe(false);
    expect((await s.list()).length).toBe(0);
    expect((await s.search('删除我')).length).toBe(0);
    s.close();
  });

  it('list 排序：置顶优先，然后更新时间倒序（同 v1）', async () => {
    const s = newStore();
    s.save({ type: 'user', name: 'a', content: '1' });
    await new Promise((r) => setTimeout(r, 5));
    s.save({ type: 'user', name: 'b', content: '2' });
    s.save({ type: 'user', name: 'c', content: '3', pinned: true });
    const list = await s.list();
    expect(list.map((m) => m.name)).toEqual(['c', 'b', 'a']);
    s.close();
  });
});

describe('记忆层 v2：search 混合检索', () => {
  it('完成标志：search("并发 bug") 返回相关记忆', async () => {
    const s = newStore();
    s.save({ type: 'project', name: '踩坑记录', content: 'AgentLoop 单例锁导致并发 bug：两个 Bot 并行 send 直接抛 agent-busy', tags: ['agent-loop', '并发'] });
    s.save({ type: 'user', name: '偏好', content: '喜欢深色模式' });
    const hits = await s.search('并发 bug');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('agent-busy');
    s.close();
  });

  it('中文子串命中（trigram 分词，>=3 字符）', async () => {
    const s = newStore();
    s.save({ type: 'project', name: '空调', content: '主卧空调连开 33 小时忘了关' });
    const hits = await s.search('空调连开');
    expect(hits.length).toBe(1);
    s.close();
  });

  it('短查询（<3 字符）走 LIKE 兜底仍命中中文', async () => {
    const s = newStore();
    s.save({ type: 'project', name: '空调', content: '主卧空调连开 33 小时忘了关' });
    const hits = await s.search('空调'); // 2 字符，FTS trigram 不接，LIKE 兜底
    expect(hits.length).toBe(1);
    s.close();
  });

  it('FTS 语法注入不影响（特殊字符被引号包裹）', async () => {
    const s = newStore();
    s.save({ type: 'user', name: 'x', content: 'hello "world" OR (test)' });
    await expect(s.search('" OR DROP TABLE memories; --')).resolves.toBeInstanceOf(Array);
    // 表还在
    expect((await s.list()).length).toBe(1);
    s.close();
  });

  it('标签精确命中加权到最前', async () => {
    const s = newStore();
    s.save({ type: 'user', name: '甲', content: '提到 audit 的一次普通记录' });
    s.save({ type: 'project', name: '乙', content: '与 audit 无关的流水账', tags: ['audit'] });
    const hits = await s.search('audit');
    expect(hits[0].name).toBe('乙'); // 精确标签命中优先
    s.close();
  });

  it('空查询退化为列表（带 limit）', async () => {
    const s = newStore();
    s.save({ type: 'user', name: 'a', content: '1' });
    s.save({ type: 'user', name: 'b', content: '2' });
    expect((await s.search('')).length).toBe(2);
    expect((await s.search('  ', { limit: 1 })).length).toBe(1);
    s.close();
  });

  it('personaTag 过滤 search 结果', async () => {
    const s = newStore();
    s.save({ type: 'project', name: '审计记忆', content: '并发安全清单', personaTags: ['audit'] });
    s.save({ type: 'project', name: '开发记忆', content: '并发安全的代码写法', personaTags: ['dev'] });
    const hits = await s.search('并发', { personaTag: 'audit' });
    expect(hits.length).toBe(1);
    expect(hits[0].name).toBe('审计记忆');
    s.close();
  });
});

describe('记忆层 v2：失效与人设路由', () => {
  it('完成标志：invalidate 后 list 不返回但数据保留（可审计/回滚）', async () => {
    const s = newStore();
    const r = s.save({ type: 'user', name: '旧偏好', content: '22 点睡' });
    await s.invalidate(r.id!);
    await s.invalidate(r.id!); // 幂等
    expect((await s.list()).length).toBe(0);
    expect((await s.get(r.id!))).toBeUndefined();
    const dead = await s.listInvalidated();
    expect(dead.length).toBe(1);
    expect(dead[0].content).toBe('22 点睡');
    expect(dead[0].invalidAt).toBeGreaterThan(0);
    await s.restore(r.id!);
    expect((await s.list()).length).toBe(1);
    s.close();
  });

  it('失效记忆不参与 search', async () => {
    const s = newStore();
    const r = s.save({ type: 'project', name: '空调', content: '主卧空调连开 33 小时' });
    await s.invalidate(r.id!);
    expect((await s.search('空调')).length).toBe(0);
    s.close();
  });

  it('完成标志：listByPersona 只返回该人设记忆', async () => {
    const s = newStore();
    s.save({ type: 'project', name: '审计清单', content: 'x', personaTags: ['audit', 'common'] });
    s.save({ type: 'project', name: '开发约定', content: 'y', personaTags: ['dev'] });
    const audit = await s.listByPersona('audit');
    expect(audit.map((m) => m.name)).toEqual(['审计清单']);
    const dev = await s.listByPersona('dev');
    expect(dev.map((m) => m.name)).toEqual(['开发约定']);
    s.close();
  });

  it('formatForPrompt 输出格式与 v1 一致', async () => {
    const s = newStore();
    s.save({ type: 'user', name: '身份', content: 'lidicn' });
    s.save({ type: 'project', name: '决策', content: '走 API 路径' });
    const text = s.formatForPrompt(await s.list());
    expect(text).toMatch(/^- #mem-\S+ \[user\] 身份: lidicn$/m);
    expect(text).toMatch(/^- #mem-\S+ \[project project\] 决策: 走 API 路径$/m);
    expect(s.formatForPrompt([])).toBe('');
    s.close();
  });
});

describe('记忆层 v2：迁移与降级', () => {
  it('旧 memories.json 首次启动自动导入（原文件保留）', async () => {
    const dbPath = path.join(tmpRoot, 'memories.db');
    const legacy = [
      { id: 'mem-old1', type: 'user', name: '老记忆', content: '迁移我', tags: ['legacy'], pinned: true, createdAt: 1000, updatedAt: 2000 },
    ];
    fs.writeFileSync(path.join(tmpRoot, 'memories.json'), JSON.stringify(legacy), 'utf8');
    const s = new MemoryStore(dbPath);
    const list = await s.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('老记忆');
    expect(list[0].tags).toEqual(['legacy']);
    // FTS 也建了索引
    expect((await s.search('迁移我')).length).toBe(1);
    // 原文件保留作备份
    expect(fs.existsSync(path.join(tmpRoot, 'memories.json'))).toBe(true);
    s.close();
  });

  it('node:sqlite 不可用时降级内存存储，读写检索仍可用', async () => {
    // 非法路径（含 NUL）→ 打开必失败 → 走内存降级
    const s = new MemoryStore(path.join(tmpRoot, 'bad\0path', 'memories.db'));
    expect(s.stats().backend).toBe('memory');
    const r = s.save({ type: 'user', name: '降级', content: '内存模式也能用' });
    expect(r.ok).toBe(true);
    expect((await s.search('内存模式')).length).toBe(1);
    await s.invalidate(r.id!);
    expect((await s.list()).length).toBe(0);
    expect((await s.listInvalidated()).length).toBe(1);
    s.close();
  });

  it('stats 反映 sqlite 后端与计数', async () => {
    const s = newStore();
    s.save({ type: 'user', name: 'a', content: '1' });
    s.save({ type: 'user', name: 'b', content: '2' });
    await s.invalidate((await s.get('mem-x'))?.id ?? (await s.list())[0].id);
    const st = s.stats();
    expect(st.backend).toBe('sqlite');
    expect(st.total).toBe(2);
    expect(st.valid).toBe(1);
    expect(st.invalidated).toBe(1);
    s.close();
  });
});
