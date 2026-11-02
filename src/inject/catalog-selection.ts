/**
 * 工具目录预算与选择（注入瘦身第 1 条）
 *
 * 移植自 `E:\NAS\deepseek-pp\src\core\prompt\catalog-selection.ts`（dpp 的成熟方案），
 * **不重新发明**：打分口径、名字索引格式、预算读取与回滚语义都按 dpp 原样对齐。
 *
 * 与 dpp 的两处**必要差异**（Studio 侧实测决定，不是另起炉灶）：
 *
 *  1. **预算值**：dpp 是 8,000 B（它单工具 ≈573 B，42 工具 ≈24 KB）。
 *     Studio 的 MCP 工具**只有 name + description**（≈87 B/工具，62 个 ≈5,390 B），
 *     且工具名必须**全部**出现在 prompt 里（`mcp_call` 按 serverId+tool 名字解析）。
 *     → 预算 3,000 B（PM 2026-11-02 拍板；改前实测 5,390 B，约压 44%）。
 *     dpp 的 8,000 B 在 Studio 等于「没压」（本来就低于 8,000）。
 *
 *  2. **没有「完整块 vs 只给名字」两级可选**：dpp 的工具各有 570 B 描述 + 完整
 *     schema，能给「完整块」或「只给名字」；Studio 的 MCP 工具**本来就只有一行
 *     name + description**。→ 这里只做「top-k 给 name+description，其余只给 name」。
 *
 * 安全底线（与 dpp 同源论证）：目录只是**说明书**，工具调用按名字解析。
 * 隐藏某个工具的 description **不会让它不可调用**，只要**名字还在**。
 * 因此 `renderCatalogNameIndex` 保证 top-k 之外的工具仍然可发现、可调用。
 *
 * 回滚开关（无需改代码）：`localStorage.setItem('studio.catalogBudget', '0')`
 * ⇒ 全量（今日行为，字节级一致）。
 */

/** 默认预算：MCP 块 5,390 B → ≤3,000 B（约 -44%）。PM 2026-11-02 拍板。 */
export const DEFAULT_CATALOG_BUDGET_BYTES = 3_000;

/**
 * 目录固定开销预留（标题行 + 服务器分组标题 + 调用方式说明 + 名字索引头）。
 * 真机实测：62 个 MCP 工具平铺时，固定开销（不含工具行）≈ 500 B 量级。
 */
export const DEFAULT_CATALOG_RESERVE_BYTES = 600;

/** 名字索引段标题（与 dpp 的 `### Other tools (name only)` 语义等价，改中文以贴合 Studio 提示词语言）。 */
export const CATALOG_NAME_INDEX_HEADER = '### 其他工具（仅名称）';

/** 回滚开关的 localStorage 键（PM 2026-11-02 定：点号命名域，与 `studio.chat.contentWidth` 同域）。 */
export const CATALOG_BUDGET_STORAGE_KEY = 'studio.catalogBudget';

/** 参与目录的工具（Studio 侧只有 MCP 工具走目录；固定能力说明不在此列）。 */
export interface CatalogToolLike {
  readonly name: string;
  readonly serverId: string;
  readonly description: string;
}

export interface CatalogSelectionResult<T> {
  /** 给 name + description 的工具（top-k）。 */
  full: T[];
  /** 只给名字的工具（保证可发现性）。 */
  indexOnly: T[];
  bytes: { full: number; index: number; total: number };
  /** 拿到完整行的工具数（便于观测）。 */
  selectedCount: number;
}

export interface CatalogSelectionInput<T extends CatalogToolLike> {
  tools: readonly T[];
  userText: string;
  /** 精确测量某工具完整行的字节数（由调用方注入，避免与模板重复实现）。 */
  measure: (tool: T) => number;
  /** 0 或负数 ⇒ 关闭选择，全部给完整行（回滚用）。 */
  budgetBytes: number;
  /** 预算里要预留给目录固定开销的字节数。 */
  reserveBytes?: number;
  /**
   * 任务**明确点名**的工具（必须在任务文本里以独立词出现）。
   * 这些工具**无条件**拿完整行，即使预算紧张。
   *
   * 为什么需要（真机实测）：62 个工具的描述长度**极不均衡**
   * （TVPilot 26 个共 1,947 B；Autoforge 36 个共 10,620 B，最长 436 字）。
   * 纯按「分数 + 累加预算」时，**描述长的工具会系统性吃亏** ——
   * 实测任务点名 `af_action_07` 时，它前面已排了 28 个短描述工具，
   * 预算在轮到它之前就耗尽 → 它只剩名字、模型看不到描述。
   * 而「用户点名了某个工具」正是最该给全描述的场景。
   */
  pinnedTools?: readonly string[];
}

/** 分词：与 dpp 同口径（小写、字母数字下划线与中文、长度 ≥2、去重、取前 200）。 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter((t) => t.length >= 2);
  return [...new Set(tokens)].slice(0, 200);
}

/**
 * 打分：名字命中 > 服务器命中 > 描述命中（与 dpp 的 name/title/description 同构，
 * Studio 没有 title，用 serverId 顶替 title 的位次）。
 */
export function scoreCatalogTool(
  tool: CatalogToolLike,
  tokens: readonly string[],
): number {
  const name = tool.name.toLowerCase();
  const server = tool.serverId.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 6;
    else if (server.includes(token)) score += 3;
    else if (description.includes(token)) score += 1;
  }
  return score;
}

/**
 * 名字索引：一个工具一行「- name」。
 *
 * **与 dpp 的必要差异**：dpp 的索引行是「- name: 短描述」（带 40 字截断描述），
 * 因为 dpp 只有 42 个工具、描述短，索引约占几百字节。
 * Studio 实测：62 个 MCP 工具的描述较长，若索引也带描述 → 索引自身就 ≈4.7 KB，
 * **光索引就超了 3,000 B 预算**（真机算出来的，不是估计）。
 * 而「保发现性」的**最小充分形式是名字本身** —— 模型只要知道「有这个工具」，
 * 就能按名字调用；描述是锦上添花。
 * → 索引**只留名字**。这既守住预算，又不丢任何工具名。
 */
export function renderCatalogNameIndex(tools: readonly CatalogToolLike[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tool) => `- ${tool.name}`);
  return [CATALOG_NAME_INDEX_HEADER, ...lines].join('\n');
}

function indexBytes(tools: readonly CatalogToolLike[]): number {
  const text = renderCatalogNameIndex(tools);
  return text ? new TextEncoder().encode(text).byteLength : 0;
}

/**
 * 选择（纯函数，除缓存外无副作用）。
 * 保证：`full.length + indexOnly.length === tools.length` —— 一个都不丢。
 */
export function selectCatalogTools<T extends CatalogToolLike>(
  input: CatalogSelectionInput<T>,
): CatalogSelectionResult<T> {
  const tools = input.tools;
  if (tools.length === 0) {
    return { full: [], indexOnly: [], bytes: { full: 0, index: 0, total: 0 }, selectedCount: 0 };
  }

  // 关闭：全部完整行（回滚路径，必须与今日字节级一致）
  if (!(input.budgetBytes > 0)) {
    const fullBytes = tools.reduce((sum, tool) => sum + input.measure(tool), 0);
    return {
      full: [...tools],
      indexOnly: [],
      bytes: { full: fullBytes, index: 0, total: fullBytes },
      selectedCount: tools.length,
    };
  }

  const tokens = tokenize(input.userText);

  // 点名工具：任务文本里以独立词出现（名字或 serverId）→ 无条件保底给完整行。
  const pinned = new Set(input.pinnedTools ?? []);
  const isPinned = (tool: T): boolean => {
    if (pinned.has(tool.name)) return true;
    const text = input.userText.toLowerCase();
    const name = tool.name.toLowerCase();
    // 独立词边界：避免 `af_action_1` 命中 `af_action_12`
    const re = new RegExp(`(^|[^a-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
    return re.test(text);
  };

  // 稳定排序：分数降序，同分保持原始顺序（确定性）。
  // 确定性是硬要求：同一任务文本连续两次构建必须字节完全相同。
  const ranked = tools
    .map((tool, index) => ({ tool, index, score: scoreCatalogTool(tool, tokens) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const full: T[] = [];
  const indexOnly: T[] = [];
  let fullBytes = 0;

  for (const entry of ranked) {
    const cost = input.measure(entry.tool);
    // 点名工具无条件进 full（预算不够也进 —— 这是「用户点名了」的语义）；
    // 其余按预算累加。
    if (isPinned(entry.tool) || fullBytes + cost <= input.budgetBytes) {
      full.push(entry.tool);
      fullBytes += cost;
    } else {
      indexOnly.push(entry.tool);
    }
  }

  // 索引回填：名字索引本身也占字节，若 full + index 超出（预算 - 预留），
  // 就把**分数最低且未被点名**的工具降级成「只给名字」，直到装得下。
  const reserve = input.reserveBytes ?? DEFAULT_CATALOG_RESERVE_BYTES;
  const limit = Math.max(0, input.budgetBytes - reserve);
  while (full.length > 0) {
    const indexSize = indexBytes(indexOnly);
    if (fullBytes + indexSize <= limit) break;
    // 从尾部找「分数最低且未被点名」的那个降级（点名的永远不降级）
    let demoteAt = -1;
    for (let i = full.length - 1; i >= 0; i -= 1) {
      if (!isPinned(full[i]!)) { demoteAt = i; break; }
    }
    if (demoteAt < 0) break; // 全是点名工具：装不下也只能这样
    const [demoted] = full.splice(demoteAt, 1);
    fullBytes -= input.measure(demoted!);
    indexOnly.push(demoted!);
  }

  // 恢复原始顺序渲染（与今日目录排序逻辑解耦）
  const order = new Map(tools.map((tool, i) => [tool, i] as const));
  full.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  indexOnly.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const indexSize = indexBytes(indexOnly);
  return {
    full,
    indexOnly,
    bytes: { full: fullBytes, index: indexSize, total: fullBytes + indexSize },
    selectedCount: full.length,
  };
}

/**
 * 读取预算（同步）。优先级：localStorage 覆盖 > 默认值。
 * 回滚：`localStorage.setItem('studio.catalogBudget', '0')`，再发一次请求即生效。
 *
 * 语义（PM 2026-11-02 定）：读到 `'0'` 才回滚全量，其余（含未设置）走预算。
 */
export function resolveCatalogBudgetBytes(): number {
  try {
    const raw = globalThis.localStorage?.getItem(CATALOG_BUDGET_STORAGE_KEY);
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  } catch {
    // 读不到就用默认值（隐私模式等）
  }
  return DEFAULT_CATALOG_BUDGET_BYTES;
}
