/**
 * SubBotReport 协议（v0.30 · Claude 主开发）
 *
 * 子 bot 离线审计任务的 prompt 构建 + 输出解析。离线执行器（offline-runner.ts）拿到
 * 子 bot 的自由文本回复后，用本模块解析成结构化 SubBotReport，落盘供汇总。
 *
 * 复用 strategy-generator.ts 的 buildStrategyPrompt / parseStrategyOutput / stripCodeFence
 * 模式（:100-144，已被 v0.29 真机验证可用）——WebEngine 无 function calling，只能靠
 * prompt 要求严格 JSON + 解析时宽松兜底。
 *
 * fail-soft 是硬约束：raw 为空 / 非 JSON / 字段非法 —— 一律降级为单条 medium finding
 * （把原始输出塞进 description，不丢内容），绝不 throw。离线执行器的 Promise.allSettled
 * 只吞异常，不应因为解析失败而丢整份报告。
 *
 * 边界：纯函数，不 import desktop-host / 不触碰 CB 文件。
 * 衔接面：types.ts 的 SubBotReport / Finding / FindingSeverity。
 */

import type { Finding, FindingSeverity, SubBotReport } from './types';

const VALID_SEVERITY: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low'];

/** 默认审计维度（detectAuditCommand 未显式指定维度时用）。 */
export const DEFAULT_AUDIT_DIMENSIONS = ['security', 'performance', 'maintainability'];

/**
 * 拼「让 audit-expert 产结构化 SubBotReport」的 prompt。
 * 要求严格 JSON 输出 + 字段说明 + 维度/目标上下文。
 */
export function buildAuditTaskPrompt(dimension: string, target: string): string {
  return [
    `你是安全/质量审计专家。请对目标做「${dimension}」维度的审计，产出结构化报告。`,
    `审计目标：${target}`,
    `审计维度：${dimension}`,
    '',
    '请只输出一个 JSON 对象（不要 markdown 代码块、不要多余文字），字段如下：',
    '  "summary": string          —— 本维度审计摘要（≤500 字，结论先行）',
    '  "findings": array          —— 发现的问题条目，每条含：',
    '    { "id": string, "severity": "critical"|"high"|"medium"|"low",',
    '      "title": string, "location": string（文件:行 或 N/A）,',
    '      "description": string, "evidenceRef": string（证据指针，不内联全文）}',
    '  "evidenceRefs": string[]   —— 证据引用指针列表（文件:行 / 日志路径），不内联全文',
    '',
    'severity 含义：critical=阻断级/可被利用；high=高危需尽快修；medium=中等；low=轻微/建议。',
    '没有发现问题时 findings 返回空数组、summary 说明「该维度未发现问题」。',
    '',
    '示例：',
    '{"summary":"发现 2 个高危问题：SQL 拼接与越权。",',
    ' "findings":[{"id":"F1","severity":"high","title":"SQL 拼接","location":"src/db.ts:42",',
    '              "description":"直接拼接用户输入到 SQL","evidenceRef":"src/db.ts:42"},',
    '             {"id":"F2","severity":"critical","title":"越权","location":"src/api.ts:88",',
    '              "description":"未校验资源归属","evidenceRef":"src/api.ts:88"}],',
    ' "evidenceRefs":["src/db.ts:42","src/api.ts:88"]}',
  ].join('\n');
}

/**
 * 从 audit-expert 原始输出解析 SubBotReport。
 * 宽松：剥离 markdown 代码围栏 → 定位 JSON 子串 → JSON.parse → 校验字段 → 兜底。
 * 绝不 throw：任何异常都降级为单条 medium finding（不丢原始内容）。
 */
export function parseSubBotReport(
  raw: string,
  slotId: string,
  dimension: string,
  transcriptPath: string,
): SubBotReport {
  const text = stripCodeFence(raw ?? '').trim();
  if (!text) {
    return fallbackReport(slotId, dimension, transcriptPath, '(空输出)');
  }

  // 模型可能前后带说明文字，尝试定位首个 { 到末尾 } 的子串（同 parseStrategyOutput :122-138）。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    return fallbackReport(slotId, dimension, transcriptPath, text);
  }

  const slice = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch {
    return fallbackReport(slotId, dimension, transcriptPath, text);
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return fallbackReport(slotId, dimension, transcriptPath, text);
  }

  const o = obj as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary : '';
  const findingsRaw = Array.isArray(o.findings) ? o.findings : [];
  const evidenceRefsRaw = Array.isArray(o.evidenceRefs) ? o.evidenceRefs : [];

  const findings: Finding[] = [];
  for (const f of findingsRaw) {
    const parsed = parseFinding(f);
    if (parsed) findings.push(parsed);
  }

  const evidenceRefs = evidenceRefsRaw.filter((r): r is string => typeof r === 'string');

  return {
    slotId,
    dimension,
    summary: summary || '(未提供摘要)',
    findings,
    evidenceRefs,
    transcriptPath,
  };
}

/** 解析单条 finding，返回 null 表示跳过（缺必填字段）。 */
function parseFinding(f: unknown): Finding | null {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
  const o = f as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : `F${Math.random().toString(36).slice(2, 8)}`;
  const title = typeof o.title === 'string' ? o.title : '';
  const location = typeof o.location === 'string' ? o.location : 'N/A';
  const description = typeof o.description === 'string' ? o.description : '';
  const evidenceRef = typeof o.evidenceRef === 'string' ? o.evidenceRef : location;
  const severity = clampSeverity(o.severity);
  if (!title && !description) return null;
  return { id, severity, title: title || '(无标题)', location, description, evidenceRef };
}

/** severity 钳到合法枚举，未知/缺省降 'medium'。 */
function clampSeverity(v: unknown): FindingSeverity {
  if (typeof v === 'string' && (VALID_SEVERITY as readonly string[]).includes(v)) {
    return v as FindingSeverity;
  }
  return 'medium';
}

/**
 * 解析失败兜底：单条 medium finding，把原始输出塞进 description（不丢内容）。
 * 绝不 throw，永远返一个合法 SubBotReport。
 */
function fallbackReport(
  slotId: string,
  dimension: string,
  transcriptPath: string,
  rawText: string,
): SubBotReport {
  const trimmed = rawText.slice(0, 500);
  return {
    slotId,
    dimension,
    summary: '审计结果（非结构化）——模型未按要求输出 JSON，已降级保留原始内容',
    findings: [
      {
        id: 'F-fallback',
        severity: 'medium',
        title: '审计结果（非结构化）',
        location: 'N/A',
        description: trimmed,
        evidenceRef: 'raw-text',
      },
    ],
    evidenceRefs: ['raw-text'],
    transcriptPath,
  };
}

/** 剥离 ```json ... ``` / ``` ... ``` 围栏（模型常见行为）。 */
export function stripCodeFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1] : text;
}
