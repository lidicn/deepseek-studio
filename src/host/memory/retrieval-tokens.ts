/**
 * 记忆检索 · 查询分词口径（F5）
 *
 * 缺陷来源：docs/验收/20261102-M15P1-记忆注入真机复验.md §10.4 / §10.6（F5，高）
 *   - 任务文本 137 字、点名「TVPilot 工具清单核实」→ 注入的 10 条记忆里**没有它**；
 *   - 同一查询缩到 14 字 → **能**召回；
 *   - 两条**完全不同**的中文任务 → 选出的记忆块**逐字节相同**（都是空集）。
 *
 * 根因（src/host/memory/core.ts:76 + retrieval.ts:75/95）：查询按 `split(/\s+/)` 切 token。
 *   中文长句没有空格 → token 是长 CJK 串 → trigram 短语匹配要求**整段出现** → 失配；
 *   LIKE 兜底也是 `%整句%` → 同样失配 → 中文长任务召不回任何记忆。
 *
 * ## 默认取值（v2 口径）
 *   - CJK 连续段做**双字切分（bigram）**；拉丁串 / 路径**仍按空白整段切**（口径不变）。
 *   - 显式引号片段（「」『』《》“”‘’""）作为**短语 token 直接参与匹配**：
 *     用户显式点名，必须能召回（召回保证，不改排序——排序语义由 pinned/user 规则主导）。
 *
 * ## 回退口径
 *   环境变量 `STUDIO_MEMORY_TOKENIZER=legacy` → 回到旧的空白切分口径（与改前字节级一致）。
 *   每次查询现读 env，因此回滚**不需要重启宿主**。
 *
 * ## 两个刻意的取舍（写在这里，避免下一个人重复讨论）
 *
 * 1. **FTS 与 LIKE 取不同子集，但同源**。
 *    `memories_fts` 用 `tokenize='trigram'`（core.ts:45）→ **2 字符 token 必然失配**
 *    （既有代码注释 retrieval.ts:34-40 已记这条）。所以：
 *      - FTS 侧用 ≥3 字符的 token（拉丁整段 + CJK 三字组）；
 *      - LIKE 侧用全部短 token（bigram + 拉丁 + 点名短语）。
 *    两侧都从**同一份分词结果**派生 → 仍满足既有纪律「两分支必须同口径」。
 *
 * 2. **token 数有上界**（见下方 MAX_*）。LIKE 侧的代价是 O(行数 × token 数 × 3 列)，
 *    不设上界会拖爆页端 `MEM_SELECT_WAIT_BUDGET_MS = 120`（src/inject/main-world-interceptor.ts:285，
 *    该常量**不属于本域，不许改**）。上界触发时按「点名片段 → CJK bigram → 拉丁」的优先级截断，
 *    并置 `truncated = true` 供观测。
 *
 *    **为什么 LIKE 侧（bigram）比 FTS 侧（trigram）宽得多**：
 *    - 成本实测（304 行库）：LIKE ≈ 0.3 ms/token；FTS5 trigram ≈ 12 ms 固定 + ≈ 4 ms/短语
 *      （8 短语 44 ms、24 短语 156 ms）。**LIKE 每个字符覆盖的性价比高约一个数量级**。
 *    - FTS 侧只留 6 个短语：保 bm25 排序与「FTS 命中而 LIKE 未命中」的保险，不承担召回主力。
 *    - LIKE 侧 bigram 上界取 40，并**沿整句等距采样**（不是只取句首）→ 专名落在句尾也能被覆盖。
 *    - 按存储上限 `MAX_MEMORIES = 500`（src/host/memory/types.ts:97）折算最坏规模：
 *      FTS ≈ 12 + 6×4 = 36 ms，LIKE ≈ 50 token × 0.3 ms（500 行约 ×1.6）≈ 24 ms → 合计 ≈ 60 ms，
 *      留在页端 120 ms 预算内。
 *    - 已知取舍：长句里**2 字**的中文专名，若既没被等距采样覆盖、又不带引号点名，可能召不回；
 *      ≥3 字的专名由 trigram + bigram 覆盖，显式点名片段另有独立预算与排序加权。
 */

/** 回退开关（环境变量）：`'legacy'` → 旧空白切分口径。 */
export const TOKENIZER_MODE_ENV = 'STUDIO_MEMORY_TOKENIZER';

/**
 * CJK bigram 上限（**LIKE 侧**，召回主力）。
 *
 * 成本模型（本机实测，304 行库，日志 logs/verify-exit/f5-profile3.cjs）：
 *   - LIKE：≈ 0.3 ms / token（16 token 4.4 ms、32 → 7.1 ms、64 → 19.2 ms、136 → 53.4 ms）；
 *   - FTS5 trigram：≈ 12 ms 固定 + ≈ 4 ms / 短语（1 → 17.8 ms、8 → 44.1 ms、24 → 156 ms）。
 *   ⇒ **LIKE 每个字符覆盖的性价比比 FTS 高约一个数量级** → 召回主力放 LIKE，
 *     FTS 侧只留少量短语（保 bm25 排序 + 「FTS 命中而 LIKE 未命中」的保险）。
 */
export const MAX_CJK_BIGRAMS = 40;
/** CJK trigram 上限（FTS 侧，走索引但短语查询贵 → 少而精）。 */
export const MAX_CJK_TRIGRAMS = 6;
/** 拉丁 / 路径 token 上限（两侧共用）。 */
export const MAX_LATIN_TOKENS = 6;
/** 显式点名片段条数上限。 */
export const MAX_QUOTED_PHRASES = 4;
/** 每个点名片段的分解 token 上限。 */
export const MAX_QUOTED_DECOMPOSED = 6;

export interface RetrievalTokenSet {
  /** LIKE 分支使用的 token（短 token 优先：bigram + 拉丁 + 点名短语）。 */
  readonly like: readonly string[];
  /** FTS 分支使用的 token（≥3 字符，trigram 索引才有命中能力）。 */
  readonly fts: readonly string[];
  /** 显式点名的片段原文（召回保证用）。 */
  readonly quoted: readonly string[];
  /** 是否因上界丢过 token（观测用）。 */
  readonly truncated: boolean;
}

const CJK_CLASS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
const CJK_TEST_RE = new RegExp(`[${CJK_CLASS}]`);
const RUN_RE = new RegExp(`[${CJK_CLASS}]+|[^\\s${CJK_CLASS}]+`, 'g');

/** 成对引号（用户显式点名的常见写法）。 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['“', '”'],
  ['‘', '’'],
  ['"', '"'],
];

/** 抽取显式点名片段（长度 1–64，非空）。 */
export function extractQuotedPhrases(query: string): string[] {
  const out: string[] = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let idx = 0;
    for (;;) {
      const start = query.indexOf(open, idx);
      if (start < 0) break;
      const end = query.indexOf(close, start + open.length);
      if (end < 0) break;
      const phrase = query.slice(start + open.length, end).trim();
      if (phrase.length > 0 && phrase.length <= 64) out.push(phrase);
      idx = end + close.length;
    }
  }
  return out;
}

/** 旧口径：按空白切分（回滚用；与改前行为一致）。 */
function legacyTokenSet(q: string): RetrievalTokenSet {
  const toks = q.split(/\s+/).filter(Boolean);
  return { like: toks, fts: toks, quoted: [], truncated: false };
}

/** 当前是否处于回退口径（每次查询现读 env → 回滚无需重启宿主）。 */
export function isLegacyTokenizer(): boolean {
  const raw = process.env[TOKENIZER_MODE_ENV];
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'legacy';
}

/**
 * 把查询切成检索 token 集合（v2 口径的实现体；测试可直接调它断言上界）。
 */
export function buildRetrievalTokenSet(query: string): RetrievalTokenSet {
  const q = (query ?? '').trim();
  if (!q) return { like: [], fts: [], quoted: [], truncated: false };

  const quoted = extractQuotedPhrases(q).slice(0, MAX_QUOTED_PHRASES);
  const like: string[] = [];
  const fts: string[] = [];
  let truncated = false;

  const pushLike = (t: string): void => {
    if (t && !like.includes(t)) like.push(t);
  };
  const pushFts = (t: string): void => {
    if (t && [...t].length >= 3 && !fts.includes(t)) fts.push(t);
  };

  // 1) 显式点名片段优先：短语本身直接参与匹配（召回保证）。
  let quotedBudget = MAX_QUOTED_DECOMPOSED;
  for (const phrase of quoted) {
    pushLike(phrase);
    pushFts(phrase);
    for (const seg of phrase.match(RUN_RE) ?? []) {
      if (quotedBudget <= 0) {
        truncated = true;
        break;
      }
      if (CJK_TEST_RE.test(seg)) {
        const chars = [...seg];
        for (let i = 0; i + 1 < chars.length && quotedBudget > 0; i++) {
          pushLike(chars.slice(i, i + 2).join(''));
          quotedBudget--;
        }
        for (let i = 0; i + 2 < chars.length && quotedBudget > 0; i++) {
          pushFts(chars.slice(i, i + 3).join(''));
          quotedBudget--;
        }
      } else {
        pushLike(seg);
        pushFts(seg);
        quotedBudget--;
      }
    }
  }

  // 2) 正文分词：CJK 连续段 → bigram(LIKE) + trigram(FTS)；拉丁整段 → 两侧都用。
  //    **均匀采样**：预算用尽时不是只取句首，而是沿整句等距取 → 专名出现在句尾也能被覆盖
  //    （真机缺陷的形态正是「长句 + 专名可能落在任意位置」）。
  let cjkBigrams = 0;
  let cjkTrigrams = 0;
  let latin = 0;
  for (const run of q.match(RUN_RE) ?? []) {
    if (CJK_TEST_RE.test(run)) {
      const chars = [...run];
      if (chars.length === 1) {
        // 单字无区分度：长句里不收（避免 '%工%' 这类噪声 token）；
        // 但**整条查询就这一个字**时保留（旧口径能召回，不能平白丢能力）。
        if (like.length === 0 && fts.length === 0 && quoted.length === 0) pushLike(chars[0]!);
        continue;
      }
      // bigram：位置 0..len-2，**均匀覆盖整段（含句尾）**，最多 MAX_CJK_BIGRAMS 个。
      // 注意不能写成「按 stride 步进再截断」——那样预算用尽时尾部没被覆盖（句尾专名仍召不回）。
      const bgTotal = chars.length - 1;
      const bgCount = Math.min(MAX_CJK_BIGRAMS, bgTotal);
      for (let k = 0; k < bgCount; k++) {
        const i = bgCount === 1 ? 0 : Math.round((k * (bgTotal - 1)) / (bgCount - 1));
        pushLike(chars.slice(i, i + 2).join(''));
        cjkBigrams++;
      }
      if (bgTotal > bgCount) truncated = true;
      // trigram：同理，均匀覆盖，最多 MAX_CJK_TRIGRAMS 个（FTS 侧短语很贵）。
      const tgTotal = chars.length - 2;
      if (tgTotal > 0) {
        const tgCount = Math.min(MAX_CJK_TRIGRAMS, tgTotal);
        for (let k = 0; k < tgCount; k++) {
          const i = tgCount === 1 ? 0 : Math.round((k * (tgTotal - 1)) / (tgCount - 1));
          pushFts(chars.slice(i, i + 3).join(''));
          cjkTrigrams++;
        }
        if (tgTotal > tgCount) truncated = true;
      }
    } else {
      if (latin >= MAX_LATIN_TOKENS) {
        truncated = true;
        continue;
      }
      pushLike(run);
      pushFts(run);
      latin++;
    }
  }

  return { like, fts, quoted, truncated };
}

/**
 * 对外入口：按当前口径（v2 / legacy）切 token。
 * @param query 原始查询文本
 */
export function tokenizeRetrievalQuery(query: string): RetrievalTokenSet {
  const q = (query ?? '').trim();
  if (!q) return { like: [], fts: [], quoted: [], truncated: false };
  if (isLegacyTokenizer()) return legacyTokenSet(q);
  return buildRetrievalTokenSet(q);
}
