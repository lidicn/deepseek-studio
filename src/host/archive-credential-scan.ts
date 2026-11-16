/**
 * 卡㉕（2026-11-16）：档案面凭证形串「按型计数」——只计数，零行为改动。
 *
 * 背景：卡㉒/㉓ 修的是 sidecar 诊断日志的明文出口，而 `storage.json` 档案里还可能有
 * 凭证形串（`tool-result` 会带回命令 stdout、`final-answer` 是模型正文）。卡㉔ 取证
 * 结论是「本机凭据泄露 0 处；1 处不可归属的高熵串出现在 final-answer 正文」。
 * 本模块不掩码、不改正文、不动档案内容，只把「静默存在」变成**可数**：
 * 每次 KV 落盘批次里按型各命中几枚，落一行宿主诊断。
 *
 * 判据口径（Studio-PM 卡㉕ 定字，改动前先看这三条）：
 *
 * ① **模式必须带前界**：`(?<![A-Za-z0-9])`。`sk-` 不带前界会咬住 `task-…`／`risk-…`／
 *    `disk-…` 这类词内假阳性——2026-11-16 卡㉔ 复核时这条 over-match 制造过一整轮误报
 *    （裸计数 dev 16／装版 150，加前界后独立形 0）。前界只排除「前一字符是字母数字」，
 *    不排除词内连字符之后的合法起点。
 *
 * ② **键体 ≥16 字符** `[A-Za-z0-9_-]{16,}`。实测（`logs/core-card25-class-check.mjs`，
 *    两棵树真档案）该 literal 类与卡㉔ 取证脚本的宽键体类（`Bearer` 后允许 `._~+/-` 与尾 `=`）
 *    **计数逐枚相同**：装版 `bearer=1 <len=50 sha16=0343f9fd7207d8be>`、`sk=0`；dev 树全 0。
 *    故不擅自放宽成宽类——口径与 ㉔ 的对照基线保持一致，验收时可直接对表。
 *
 * ③ **只数本批写入值，绝不数合并后的整对象**。宿主 flush 的实现是「读回整份 → 合并 →
 *    `JSON.stringify` 全量重写」（`file-storage-backend.ts`），若在合并结果上计数，
 *    **每写一次就把历史内容重数一遍**，N 会随写入次数增长而不随出现次数增长，判据当即作废。
 *
 * 本模块不做 IO、不打日志、不抛错：调用方（宿主 flush 处）决定何时落诊断行。
 */

/** 按型计数结果。型名与诊断行里的字段名一一对应（`bearer=N sk=N`）。 */
export interface CredentialShapeCounts {
  bearer: number;
  sk: number;
}

/**
 * 凭证形串模式表。**每个模式都必须带前界**（见文件头判据①），新增型时照抄这个形态。
 * 用 `matchAll` 消费（它内部克隆正则，不会污染 `lastIndex`）。
 */
export const CREDENTIAL_SHAPE_PATTERNS: Record<keyof CredentialShapeCounts, RegExp> = {
  bearer: /(?<![A-Za-z0-9])Bearer[ \t]+[A-Za-z0-9_-]{16,}/g,
  sk: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
};

const SHAPE_KEYS: Array<keyof CredentialShapeCounts> = ['bearer', 'sk'];

function emptyCounts(): CredentialShapeCounts {
  return { bearer: 0, sk: 0 };
}

/** 计数单段文本。不截断、不打印原文。 */
export function countCredentialShapesInText(text: string): CredentialShapeCounts {
  const out = emptyCounts();
  for (const kind of SHAPE_KEYS) {
    const re = CREDENTIAL_SHAPE_PATTERNS[kind];
    // matchAll 内部克隆正则，不复用 lastIndex——同一模式在多个值上连续调用是安全的。
    for (const _ of text.matchAll(re)) {
      out[kind] += 1;
      void _;
    }
  }
  return out;
}

/**
 * 取一个 KV 值的可扫描文本。字符串直接扫；对象/数组按 JSON 序列化后扫
 * （档案里事件流是数组、字段是对象，只扫字符串会漏掉正文与载荷里的命中）。
 * 不可序列化（循环引用等）时返回 null——计数面不因此抛错，也不拖累落盘。
 */
function scanTextOfValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * 计数**一个落盘批次**（`{ set }` 的值面）。调用点必须是批装配处、传本批 `set`，
 * 不是合并后的整对象（判据③）。
 */
export function countCredentialShapesInKvSet(
  set: Record<string, unknown>,
): CredentialShapeCounts {
  const out = emptyCounts();
  for (const value of Object.values(set)) {
    const text = scanTextOfValue(value);
    if (text === null) continue;
    const one = countCredentialShapesInText(text);
    out.bearer += one.bearer;
    out.sk += one.sk;
  }
  return out;
}

/** 是否至少命中一枚（0 命中时调用方整行不落，避免每 100ms 一行刷屏）。 */
export function hasCredentialShapeHit(counts: CredentialShapeCounts): boolean {
  return counts.bearer > 0 || counts.sk > 0;
}

/**
 * 诊断行定字（Studio-PM 卡㉕）：一事件一行、按型分列。
 * 与 ⑫ 甲同族；**不要**套 `<omitted:` 前缀（那是省略标记，语义不同）。
 */
export function formatCredentialShapeHits(counts: CredentialShapeCounts): string {
  return `archive credential-shaped hits: bearer=${counts.bearer} sk=${counts.sk}`;
}
