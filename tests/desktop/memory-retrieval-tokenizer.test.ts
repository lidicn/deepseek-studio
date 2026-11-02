/**
 * F5：记忆检索分词口径回归（中文长句召不回专有名词）
 *
 * 缺陷来源：docs/验收/20261102-M15P1-记忆注入真机复验.md §10.4 / §10.6（F5，高）
 *   - 任务文本 137 字、点名「TVPilot 工具清单核实」→ 注入的 10 条记忆里**没有它**；
 *   - 同一查询缩到 14 字 → **能**召回；
 *   - 两条**完全不同**的中文任务 → 选出的记忆块**逐字节相同**。
 *
 * 根因（src/host/memory/core.ts:76 + src/host/memory/retrieval.ts:75/95）：
 *   查询按 `split(/\s+/)` 切 token；中文长句没有空格 → token 是长 CJK 串 →
 *   trigram 短语匹配要求整段出现 → 失配；LIKE 兜底也是 `%整句%` → 同样失配。
 *
 * **真实入口**：`MemoryStore.search()`（src/host/memory-store.ts:309 → src/host/memory/retrieval.ts:21）。
 *   这正是 `memory.select` 的**唯一**检索调用点（src/host/desktop-host.ts:821
 *   `store.search(taskText, { limit: 12 })`），所以本文件打的是生产链路的真入口，
 *   不是私有函数。
 *
 * 本文件先写红（缺陷态），再改实现转绿；分词器专属断言在实现落地后追加到 §3。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStore } from '../../src/host/memory-store';
import {
  buildRetrievalTokenSet,
  MAX_CJK_BIGRAMS,
  MAX_CJK_TRIGRAMS,
  MAX_LATIN_TOKENS,
  MAX_QUOTED_PHRASES,
} from '../../src/host/memory/retrieval-tokens';

const tmpRoot = path.join(os.tmpdir(), `studio-mem-f5-${Date.now()}`);

/** 所有本轮打开的 store：afterEach 统一 close，避免断言失败时 DB 仍被占用 → rmSync EPERM 级联。 */
const opened: MemoryStore[] = [];

interface Seed {
  type: 'user' | 'project';
  name: string;
  content: string;
  tags?: string[];
}

function seed(s: MemoryStore, rows: Seed[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const r of rows) {
    const res = s.save({ type: r.type, name: r.name, content: r.content, tags: r.tags ?? [] });
    expect(res.ok).toBe(true);
    ids.set(r.name, res.id!);
  }
  return ids;
}

/** 标准库：四条记忆，覆盖「中文专名 / 英文专名 / 路径 / 无关项」四类。 */
const CORPUS: Seed[] = [
  { type: 'project', name: 'TVPilot 工具清单核实', content: 'TVPilot 的 MCP 工具清单已核实，共 62 个工具，其中 autoforge 占 36 个。', tags: ['mcp'] },
  { type: 'project', name: '墨鉴 R3 结论', content: 'agent-channel 与 page-runtime 的会话链路结论：注入体量与请求表面积。', tags: ['audit'] },
  { type: 'project', name: 'Autoforge MCP 配对', content: 'Autoforge 与 MCP 服务器的配对端点已验证，端口与鉴权都通。', tags: ['mcp'] },
  { type: 'project', name: '路径记录', content: '入口文件在 E:/NAS/deepseek-studio/src/host/memory/core.ts，检索口径在 retrieval.ts。' },
];

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  // 先关库再删目录：断言失败时也不留占用句柄（否则 rmSync EPERM 会把行为红淹没成清理红）。
  while (opened.length) {
    const s = opened.pop()!;
    try { s.close(); } catch { /* ignore */ }
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch { /* ignore */ }
});

function newStore(): MemoryStore {
  const s = new MemoryStore(path.join(tmpRoot, `mem-${Math.random().toString(36).slice(2, 8)}.db`));
  opened.push(s);
  return s;
}

describe('F5 · 中文长句召不回点名条目（红→绿）', () => {
  it('中文长句 + 显式点名（书名号引号包裹）能召回点名的那条记忆', async () => {
    const s = newStore();
    const ids = seed(s, CORPUS);
    // 缺陷态：整句是一个长 CJK token → LIKE `%整句%` 与 trigram 短语都失配 → 召不回。
    const q = '请帮我核实一下「TVPilot 工具清单核实」这件事，顺带把相关的历史结论也翻出来看看，谢谢';
    const hits = await s.search(q);
    expect(hits.map((h) => h.id)).toContain(ids.get('TVPilot 工具清单核实'));
    s.close();
  });

  it('中文长句（不带引号、纯中文）也能召回到含中文专名的记忆', async () => {
    const s = newStore();
    const ids = seed(s, CORPUS);
    // 缺陷态：'请核实工具清单这件事' 是一个长 token → 召不回任何东西。
    const hits = await s.search('请核实工具清单这件事');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.id)).toContain(ids.get('TVPilot 工具清单核实'));
    s.close();
  });

  it('短查询仍然召回（不回退）', async () => {
    const s = newStore();
    const ids = seed(s, CORPUS);
    const hits = await s.search('TVPilot 工具清单核实');
    expect(hits.map((h) => h.id)).toContain(ids.get('TVPilot 工具清单核实'));
    s.close();
  });

  it('英文与路径查询不回归', async () => {
    const s = newStore();
    const ids = seed(s, CORPUS);
    const hits = await s.search('E:/NAS/deepseek-studio/src/host/memory/core.ts');
    expect(hits.map((h) => h.id)).toContain(ids.get('路径记录'));

    const hits2 = await s.search('Autoforge');
    expect(hits2.map((h) => h.id)).toContain(ids.get('Autoforge MCP 配对'));
    s.close();
  });

  it('两条不同的中文任务必须选出不同的记忆集（不再逐字节相同）', async () => {
    const s = newStore();
    seed(s, CORPUS);
    const a = (await s.search('请核实工具清单这件事')).map((h) => h.id).sort();
    const b = (await s.search('请检查配对端点那件事')).map((h) => h.id).sort();
    expect(a).not.toEqual(b);
    s.close();
  });

  it('负控：同一条任务重复查询必须得到同一集合（证明上一条断言有分辨力）', async () => {
    const s = newStore();
    seed(s, CORPUS);
    const q = '请核实工具清单这件事';
    const a = (await s.search(q)).map((h) => h.id).sort();
    const b = (await s.search(q)).map((h) => h.id).sort();
    expect(a).toEqual(b);
    s.close();
  });
});

describe('F5 · 分词口径的边界与护栏', () => {
  const ENV_KEY = 'STUDIO_MEMORY_TOKENIZER';

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('引号片段（用户显式点名）直接参与匹配 → 必召回', async () => {
    const s = newStore();
    const ids = seed(s, CORPUS);
    for (const phrase of ['「TVPilot 工具清单核实」', '『TVPilot 工具清单核实』', '《TVPilot 工具清单核实》', '“TVPilot 工具清单核实”']) {
      const hits = await s.search(phrase);
      expect(hits.map((h) => h.id)).toContain(ids.get('TVPilot 工具清单核实'));
    }
    s.close();
  });

  it('显式点名的条目必须真的进到注入窗口（limit=12，即使它较老）', async () => {
    const s = newStore();
    // 先写入被点名的记忆（较老），再写一批更新的无关记忆 → 只靠 updated_at 排序它会被挤出窗口。
    const named = s.save({ type: 'project', name: 'TVPilot 工具清单核实', content: 'TVPilot 的 MCP 工具清单已核实。' });
    expect(named.ok).toBe(true);
    for (let i = 0; i < 20; i++) {
      // 这批"更新的"记录也含查询里的 '核实' → 会被一并召回并按 updated_at 排在前面；
      // 但它们**不含**被点名的完整片段 → 只有排序加权才能把点名条目提到最前。
      s.save({ type: 'project', name: `更新的无关条目 ${i}`, content: `第 ${i} 条记录，核实过一遍。` });
    }
    // memory.select 的真实口径：related 取前 12 条（desktop-host.ts:821 limit: 12）。
    const hits = await s.search('请核实一下「TVPilot 工具清单核实」', { limit: 12 });
    expect(hits.length).toBe(12);
    expect(hits[0]!.id).toBe(named.id!); // 点名条目必须排在最前
    s.close();
  });

  it('长句里专名出现在句尾也能召回（等距采样，不是只取句首）', async () => {
    const s = newStore();
    const ids = seed(s, CORPUS);
    // 专名（纯中文）落在长句**末尾**：若只取句首 bigram 必然召不回 → 验证等距采样。
    const q = '前面是一段很长的与任务无关的中文描述文字'.repeat(8) + '工具清单核实';
    const hits = await s.search(q);
    expect(hits.map((h) => h.id)).toContain(ids.get('TVPilot 工具清单核实'));
    s.close();
  });

  it('token 数有上界（超长查询不会把检索打爆）', () => {
    const set = buildRetrievalTokenSet('测试记忆检索'.repeat(500));
    expect(set.like.length).toBeLessThanOrEqual(MAX_CJK_BIGRAMS + MAX_LATIN_TOKENS + MAX_QUOTED_PHRASES);
    expect(set.fts.length).toBeLessThanOrEqual(MAX_CJK_TRIGRAMS + MAX_LATIN_TOKENS + MAX_QUOTED_PHRASES);
    expect(set.truncated).toBe(true); // 超界被截断（而不是无限膨胀）
  });

  it('超长中文查询的检索耗时远低于页端 120ms 预算', async () => {
    const s = newStore();
    seed(s, CORPUS);
    // 再塞一批无关行，制造一定规模
    for (let i = 0; i < 300; i++) {
      s.save({ type: 'project', name: `无关条目 ${i}`, content: `第 ${i} 条与查询无关的记录内容 abc${i}。` });
    }
    const long = '请帮我把这条很长的中文任务描述继续写下去'.repeat(40);
    const t0 = Date.now();
    const hits = await s.search(long);
    const elapsed = Date.now() - t0;
    expect(Array.isArray(hits)).toBe(true);
    expect(elapsed).toBeLessThan(120); // 页端预算 MEM_SELECT_WAIT_BUDGET_MS = 120
    s.close();
  });

  it('回退口径有效：legacy 下中文长句召不回（开关生效）；英文/路径结果与新口径一致', async () => {
    const s = newStore();
    seed(s, CORPUS);

    process.env[ENV_KEY] = 'legacy';
    const legacyChinese = await s.search('请核实工具清单这件事');
    expect(legacyChinese.length).toBe(0); // 旧口径下召不回 → 证明开关真的切回了旧分词

    const legacyPath = (await s.search('E:/NAS/deepseek-studio/src/host/memory/core.ts')).map((h) => h.id).sort();
    const legacyEnglish = (await s.search('Autoforge')).map((h) => h.id).sort();

    delete process.env[ENV_KEY];
    const v2Path = (await s.search('E:/NAS/deepseek-studio/src/host/memory/core.ts')).map((h) => h.id).sort();
    const v2English = (await s.search('Autoforge')).map((h) => h.id).sort();

    expect(v2Path).toEqual(legacyPath); // 英文/路径不回归
    expect(v2English).toEqual(legacyEnglish);
    s.close();
  });

  it('页端预算常量 MEM_SELECT_WAIT_BUDGET_MS 仍是 120（跨域只读断言，不许被改动）', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/inject/main-world-interceptor.ts'),
      'utf8',
    );
    expect(src).toMatch(/const MEM_SELECT_WAIT_BUDGET_MS = 120;/);
  });
});
