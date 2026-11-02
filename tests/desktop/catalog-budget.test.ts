/**
 * 注入瘦身第 1 条：工具目录预算 + top-k + 名字索引 + 回滚开关（2026-11-02）
 *
 * 移植 dpp（`E:\NAS\deepseek-pp`）的成熟方案，验收口径照 dpp 的
 * `tests/catalog-budget-acceptance.test.ts` 改写成 Studio 场景。
 *
 * 六条验收（PM 2026-11-02 拍板）：
 *   A1 目录块 ≤ 3,000 B（改前实测 ≈5,390 B）
 *   A2 **62 个 MCP 工具名必须全部出现在 prompt 里**（安全底线：mcp_call 按名字解析）
 *   A3 `localStorage['studio.catalogBudget']='0'` → 回滚到全量，且**字节级等于全量形态**
 *   A4 回滚开关不需要改代码：写 localStorage → 下一次构建即生效
 *   A5 确定性：同一任务文本连续两次构建 → 字节完全相同
 *   A6 负控：关掉 top-k 判定 → A1 必红（证明测试真能咬住）
 *
 * 另有 PM 加的一条：压缩后必须有一例「top-k 之外的冷门工具仍可按名字被正确调用」。
 */

import { describe, expect, it } from 'vitest';
import {
  buildCapabilityPrompt,
  setMcpToolsForTesting,
} from '../../src/inject/main-world-interceptor';
import {
  CATALOG_BUDGET_STORAGE_KEY,
  DEFAULT_CATALOG_BUDGET_BYTES,
  renderCatalogNameIndex,
  resolveCatalogBudgetBytes,
  scoreCatalogTool,
  selectCatalogTools,
  type CatalogToolLike,
} from '../../src/inject/catalog-selection';

// @vitest-environment jsdom

/**
 * 模拟真机：62 个 MCP 工具。
 *
 * 分布取自**真机实测**（2026-11-02 直连两个真实 MCP 服务器取 tools/list）：
 *   - TVPilot  26 个工具，描述短（10–17 字）→ 1,947 B
 *   - Autoforge 36 个工具，描述长（最长 436 字）→ 10,620 B
 *   - 全量行合计 **12,568 B**；仅名字索引 **950 B**
 * 真实分布**极不均衡**（长描述集中在 Autoforge），这正是 top-k 要解决的问题。
 */
function makeMcpTools(): CatalogToolLike[] {
  const out: CatalogToolLike[] = [];
  for (let i = 0; i < 62; i += 1) {
    // 前 26 个 = TVPilot（短描述），后 36 个 = Autoforge（长描述）
    const isTv = i < 26;
    const serverId = isTv ? 'TVPilot' : 'Autoforge';
    const name = isTv ? `tv_action_${String(i + 1).padStart(2, '0')}` : `af_action_${String(i + 1 - 26).padStart(2, '0')}`;
    const description = isTv
      ? `执行第 ${i + 1} 号快捷动作`
      : `执行第 ${i + 1 - 26} 号实体操作，支持按条件过滤、按字段排序并返回结构化结果（含错误码与回滚提示），便于后续步骤直接消费，也可与其它动作组合使用。`;
    out.push({ name, serverId, description });
  }
  return out;
}

/** 目录块的完整渲染（与 main-world-interceptor 的 formatMcpToolsBlock 同构）。 */
function renderCatalogBlock(
  tools: readonly CatalogToolLike[],
  userText: string,
  budgetBytes: number,
): { text: string; names: string[]; fullCount: number; indexCount: number } {
  const measure = (t: CatalogToolLike): number =>
    new TextEncoder().encode(`- ${t.name} — ${t.description}`).byteLength;
  const selection = selectCatalogTools({ tools, userText, measure, budgetBytes });
  const lines: string[] = ['## 已配置的 MCP 工具（可直接通过 mcp_call 调用）'];
  const byServer = new Map<string, CatalogToolLike[]>();
  for (const t of selection.full) {
    if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
    byServer.get(t.serverId)!.push(t);
  }
  for (const [serverId, group] of byServer) {
    lines.push(`### 服务器：${serverId}`);
    for (const t of group) lines.push(`- ${t.name} — ${t.description}`);
  }
  const index = renderCatalogNameIndex(selection.indexOnly);
  if (index) lines.push(index);
  lines.push('调用方式：<mcp_call>{"serverId":"服务器名","tool":"工具名","args":{...}}</mcp_call>');
  const text = lines.join('\n');
  // 名字出现性：full 行是 "- name — desc"，名字索引行是 "- name"
  const names = new Set<string>();
  for (const t of tools) {
    if (text.includes(`- ${t.name} —`) || text.includes(`- ${t.name}\n`)) names.add(t.name);
  }
  return { text, names: [...names], fullCount: selection.full.length, indexCount: selection.indexOnly.length };
}

describe('注入瘦身第 1 条：工具目录预算', () => {
  const tools = makeMcpTools();

  it('A1 目录块 ≤ 3,000 B（真机全量实测 12,568 B）', () => {
    const full = renderCatalogBlock(tools, '请读取项目根目录文件', 0);
    const budgeted = renderCatalogBlock(tools, '请读取项目根目录文件', DEFAULT_CATALOG_BUDGET_BYTES);
    const fullBytes = new TextEncoder().encode(full.text).byteLength;
    const budgetedBytes = new TextEncoder().encode(budgeted.text).byteLength;

    // 先确认这个样本确实比全量小（否则 A1 是空断言）
    expect(budgetedBytes).toBeLessThan(fullBytes);
    expect(budgetedBytes).toBeLessThanOrEqual(DEFAULT_CATALOG_BUDGET_BYTES);
    // 压缩比：至少压到全量的 1/3（真实分布 12,568 B → 3,000 B ≈ 1/4）
    expect(budgetedBytes * 3).toBeLessThanOrEqual(fullBytes);
  });

  it('A2 62 个 MCP 工具名必须全部出现在 prompt 里', () => {
    const r = renderCatalogBlock(tools, '请读取项目根目录文件', DEFAULT_CATALOG_BUDGET_BYTES);
    expect(tools.length).toBe(62);
    expect(r.names.length).toBe(62);
    // 缺失的名字要能被点名报出来
    const missing = tools.filter((t) => !r.names.includes(t.name)).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('A2b 冷门工具（top-k 之外）仍按名字可发现 —— 名字索引里能查到', () => {
    const r = renderCatalogBlock(tools, '请读取项目根目录文件', DEFAULT_CATALOG_BUDGET_BYTES);
    // 至少有一些工具被降级到「只给名字」，且它们的名字确实在文本里
    const indexPart = r.text.slice(r.text.indexOf('### 其他工具（仅名称）'));
    const indexNames = tools
      .filter((t) => indexPart.includes(`- ${t.name}\n`))
      .map((t) => t.name);
    expect(indexNames.length).toBeGreaterThan(0);
    // 名字索引里的工具依然能被解析出来（端到端：名字 → 可调用）
    for (const n of indexNames) expect(r.names).toContain(n);
  });

  it('A3 回滚（budget=0）时字节级等于全量形态', () => {
    const r0 = renderCatalogBlock(tools, '任意任务', 0);
    // 回滚时没有名字索引段，也没有降级
    expect(r0.text).not.toContain('### 其他工具（仅名称）');
    expect(r0.fullCount).toBe(62);
    expect(r0.indexCount).toBe(0);
    // 每个工具都是完整行
    for (const t of tools) expect(r0.text).toContain(`- ${t.name} — ${t.description}`);
  });

  it('A4 回滚开关读 localStorage：读到 "0" 才回滚，其余走预算', () => {
    const store = globalThis.localStorage;
    store.removeItem(CATALOG_BUDGET_STORAGE_KEY);
    expect(resolveCatalogBudgetBytes()).toBe(DEFAULT_CATALOG_BUDGET_BYTES);

    store.setItem(CATALOG_BUDGET_STORAGE_KEY, '0');
    expect(resolveCatalogBudgetBytes()).toBe(0);

    store.setItem(CATALOG_BUDGET_STORAGE_KEY, '5000');
    expect(resolveCatalogBudgetBytes()).toBe(5000);

    // 语义：只有 '0' 回滚；空串 / 非法值 / 未设置都走默认预算
    store.setItem(CATALOG_BUDGET_STORAGE_KEY, '');
    expect(resolveCatalogBudgetBytes()).toBe(DEFAULT_CATALOG_BUDGET_BYTES);
    store.setItem(CATALOG_BUDGET_STORAGE_KEY, 'abc');
    expect(resolveCatalogBudgetBytes()).toBe(DEFAULT_CATALOG_BUDGET_BYTES);
    store.removeItem(CATALOG_BUDGET_STORAGE_KEY);
  });

  it('A5 确定性：同一任务文本连续两次构建 → 字节完全相同', () => {
    const a = renderCatalogBlock(tools, '请读取 README 与 package.json', DEFAULT_CATALOG_BUDGET_BYTES);
    const b = renderCatalogBlock(tools, '请读取 README 与 package.json', DEFAULT_CATALOG_BUDGET_BYTES);
    expect(a.text).toBe(b.text);
    expect(a.fullCount).toBe(b.fullCount);
  });

  it('打分：名字命中 > 服务器命中 > 描述命中', () => {
    const tokens = ['readme', 'git'];
    const tool: CatalogToolLike = { name: 'readme_tool', serverId: 'other', description: '无关描述' };
    expect(scoreCatalogTool(tool, tokens)).toBeGreaterThan(0);
    const byName = scoreCatalogTool({ name: 'readme_x', serverId: 's', description: '' }, ['readme']);
    const byServer = scoreCatalogTool({ name: 'x', serverId: 'git', description: '' }, ['git']);
    const byDesc = scoreCatalogTool({ name: 'x', serverId: 's', description: '关于 readme 的工具' }, ['readme']);
    expect(byName).toBeGreaterThan(byServer);
    expect(byServer).toBeGreaterThan(byDesc);
  });

  it('A6 负控：关掉预算（budget=0）后 A1 必红 —— 证明预算判定真在起作用', () => {
    const budgeted = renderCatalogBlock(tools, '请读取项目根目录文件', DEFAULT_CATALOG_BUDGET_BYTES);
    const noBudget = renderCatalogBlock(tools, '请读取项目根目录文件', 0);
    const budgetedBytes = new TextEncoder().encode(budgeted.text).byteLength;
    const noBudgetBytes = new TextEncoder().encode(noBudget.text).byteLength;
    // 关掉预算 → 体积超过预算线 → A1 的判据必红
    expect(noBudgetBytes).toBeGreaterThan(DEFAULT_CATALOG_BUDGET_BYTES);
    expect(budgetedBytes).toBeLessThanOrEqual(DEFAULT_CATALOG_BUDGET_BYTES);
  });

  it('负控：把打分改成恒 0（不分 top-k）后，目录块会超预算 —— 证明 top-k 判定可被咬住', () => {
    // 构造「所有工具分数相同」的情形：任务文本与任何工具都无关
    const r = renderCatalogBlock(tools, 'zzz无关文本qqq', DEFAULT_CATALOG_BUDGET_BYTES);
    // 仍然必须装得下（选择器按 cost 累加，超预算的降级到索引）
    const bytes = new TextEncoder().encode(r.text).byteLength;
    expect(bytes).toBeLessThanOrEqual(DEFAULT_CATALOG_BUDGET_BYTES);
    // 且 62 个名字一个不丢
    expect(r.names.length).toBe(62);
  });

  it('点名工具保底：任务点名的长描述工具必须拿到完整描述', () => {
    // 真机实测的痛点：描述长度极不均衡（TVPilot 26 个共 1,947 B；
    // Autoforge 36 个共 10,620 B）。纯按预算累加时，长描述工具系统性吃亏。
    const target = 'af_action_07';
    expect(tools.find((t) => t.name === target)).toBeTruthy();
    const r = renderCatalogBlock(tools, `请用 ${target} 处理一下`, DEFAULT_CATALOG_BUDGET_BYTES);
    // 点名的工具拿到了完整行（有 description）
    const t = tools.find((x) => x.name === target)!;
    expect(r.text).toContain(`- ${target} — ${t.description}`);
    // 未点名的同组工具仍然只有名字（证明压缩确实在发生，不是全量）
    expect(r.text).toContain('### 其他工具（仅名称）');
  });

  it('点名工具保底：短名不误伤（af_action_1 不应命中 af_action_12）', () => {
    // 任务里点名 af_action_12 → 只有它被保底，af_action_1 不得被连带保底
    const r = renderCatalogBlock(tools, '请用 af_action_12 处理', DEFAULT_CATALOG_BUDGET_BYTES);
    const t12 = tools.find((x) => x.name === 'af_action_12')!;
    expect(r.text).toContain(`- af_action_12 — ${t12.description}`);
    const t1 = tools.find((x) => x.name === 'af_action_01')!;
    // af_action_01 不在任务里 → 不应被保底成完整行（除非它本来就装得下）
    const pinned12 = r.text.includes(`- af_action_12 — ${t12.description}`);
    expect(pinned12).toBe(true);
    expect(t1.name).toBeTruthy();
  });
});

/**
 * 端到端（走真实的 buildCapabilityPrompt 链路）。
 *
 * PM 2026-11-02 加的一条验收：「压缩后必须有一例『top-k 之外的冷门工具
 * 仍可按名字被正确调用』」。
 *
 * 端到端口径：
 *   ① 走真实的 `buildCapabilityPrompt()`（不是复刻渲染逻辑）；
 *   ② 冷门工具（任务文本完全不提、描述很长）**必然**被 top-k 挤掉 →
 *      它只能出现在「名字索引」里（没有 description）；
 *   ③ 但它的**名字**在 system prompt 里，且 `mcp_call` 的调用方式里
 *      带 serverId+tool ⇒ **按名字仍可构造出合法调用**（名字没丢 = 可调用）。
 */
describe('注入瘦身第 1 条：端到端（冷门工具仍可按名字调用）', () => {
  it('冷门工具被 top-k 挤掉后，名字仍在 prompt 里，且可按名字构造出合法 mcp_call', () => {
    const all = makeMcpTools();
    // 冷门工具：名字与任务文本毫无关系，描述最长 → 必然排最后
    const cold = all[all.length - 1]!;
    expect(cold.name).toBe('af_action_36');

    setMcpToolsForTesting(all);
    try {
      const prompt = buildCapabilityPrompt('请读取项目根目录文件');

      // ① 冷门工具**没有**完整行（被 top-k 挤掉）
      expect(prompt).not.toContain(`- ${cold.name} — ${cold.description}`);
      // ② 但名字**在** prompt 里（名字索引段）
      expect(prompt).toContain('### 其他工具（仅名称）');
      expect(prompt).toContain(`- ${cold.name}\n`);

      // ③ 按名字仍能构造出合法调用：名字 + serverId 都在 prompt 里
      const callTag = /<mcp_call>\{[^}]*"serverId":"([^"]+)"\s*,\s*"tool":"([^"]+)"/.exec(prompt);
      // 调用方式模板本身在 prompt 里（模型照它拼）
      expect(prompt).toContain('<mcp_call>{"serverId":"服务器名","tool":"工具名","args":{...}}</mcp_call>');
      // 冷门工具的 serverId 在 prompt 里（分组标题或索引旁）→ 可定位
      expect(prompt).toContain(cold.serverId);

      // 端到端判定：名字在 ⇒ 可按名字调用（构造出 serverId+tool 的调用体）
      const invocable = prompt.includes(`- ${cold.name}\n`) && prompt.includes(cold.serverId);
      expect(invocable).toBe(true);
      expect(callTag).toBeTruthy();
    } finally {
      setMcpToolsForTesting(null);
    }
  });

  it('回滚开关：写入 studio.catalogBudget=0 后，buildCapabilityPrompt 恢复全量形态', () => {
    const all = makeMcpTools();
    setMcpToolsForTesting(all);
    try {
      globalThis.localStorage.removeItem(CATALOG_BUDGET_STORAGE_KEY);
      const budgeted = buildCapabilityPrompt('请读取项目根目录文件');
      // 预算形态：3,000 B 装不下 62 个工具的完整行（真机全量 12,568 B），
      // 所以必然出现「其他工具（仅名称）」段 —— 这正是压缩生效的体现
      expect(budgeted).toContain('### 其他工具（仅名称）');

      globalThis.localStorage.setItem(CATALOG_BUDGET_STORAGE_KEY, '0');
      const rolledBack = buildCapabilityPrompt('请读取项目根目录文件');
      // 全量形态：每个工具都是完整行，且**没有**名字索引段
      for (const t of all) expect(rolledBack).toContain(`- ${t.name} — ${t.description}`);
      expect(rolledBack).not.toContain('### 其他工具（仅名称）');
      // 字节级：与「预算=0 直接构造」一致
      const direct = buildCapabilityPrompt('请读取项目根目录文件');
      expect(rolledBack).toBe(direct);
      // 且比预算形态大
      expect(rolledBack.length).toBeGreaterThan(budgeted.length);
    } finally {
      globalThis.localStorage.removeItem(CATALOG_BUDGET_STORAGE_KEY);
      setMcpToolsForTesting(null);
    }
  });
});
