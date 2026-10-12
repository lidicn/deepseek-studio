/**
 * 工具结果统一格式（v1.2，纯模块，无上游运行时依赖 / 无 DOM 依赖）
 *
 * 对齐 Pi Agent 的 content / details / isError / terminate 结果规范。
 * 与 src/shared/tool-contract.ts 同构：页端（浏览器 IIFE）与宿主（Node）共享同一份逻辑。
 *
 * 兼容契约（严格）：
 *   - 旧字段 ok / data / error / reason / snapshot 一律保留，永不删除；
 *   - 新字段全部可选，缺省时消费方（UI / 续跑）回退到旧格式；
 *   - 本模块只做「构造 + 解释」，不改写旧字段，不引入任何副作用。
 */

// ---------------------------------------------------------------- 类型

/** Pi Agent 风格的内容片段。第一阶段只支持 text。 */
export interface ToolResultContentPart {
  type: 'text';
  text: string;
}

/**
 * 新增的可选结果字段。语义真相源。
 * （ToolExecutionResult / ExecuteResult / ToolCardData.result 均结构等价于此，
 *   为便于 grep 验收，那三处显式重复声明了同样的四个字段。）
 */
export interface ToolResultExtras {
  /** 给模型看的纯文本内容。 */
  content?: ToolResultContentPart[];
  /** 给 UI 看的元数据（exitCode / durationMs / path 等）。 */
  details?: Record<string, unknown>;
  /** 显式错误标记（语义上等价于 !ok，但更清晰）。 */
  isError?: boolean;
  /** 提示跳过自动续跑（批次内全部为 true 时才生效）。 */
  terminate?: boolean;
}

/**
 * 宿主执行工具后的完整结果（新旧字段并存）。
 * 旧字段保留以兼容现有调用方。
 */
export interface ToolExecutionResult {
  ok: boolean;
  reason?: string;
  data?: unknown;
  snapshot?: { total: number; byKind: Record<string, number> };
  // 新增：Pi Agent 风格的统一结果格式
  content?: ToolResultContentPart[];
  details?: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}

/** 旧格式工具卡片结果（保持 tool-card-ui.ts 现有契约）。 */
export interface LegacyToolCardResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 工具卡片结果 = 旧格式 + 新格式字段。 */
export type ToolCardResult = LegacyToolCardResult & ToolResultExtras;

// ---------------------------------------------------------------- 构造

/** 把纯文本包装成 content 数组。 */
export function textContent(text: string): ToolResultContentPart[] {
  return [{ type: 'text', text: text ?? '' }];
}

/**
 * shell.exec / python.exec 成功结果的新格式部分。
 * content = [{type:'text', text: stdout}]
 * details = { exitCode, durationMs, cwd?, argv? }
 */
export function buildExecExtras(input: {
  stdout: string;
  exitCode: number;
  durationMs: number;
  cwd?: string;
  argv?: string[];
}): ToolResultExtras {
  return {
    content: textContent(input.stdout ?? ''),
    details: {
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(Array.isArray(input.argv) ? { argv: input.argv } : {}),
    },
    isError: false,
  };
}

/**
 * file.read 成功结果的新格式部分。
 * content = [{type:'text', text: 文件内容}]
 * details = { path, size, offset?, limit? }
 */
export function buildFileReadExtras(input: {
  content: string;
  path: string;
  size: number;
  offset?: number;
  limit?: number;
}): ToolResultExtras {
  return {
    content: textContent(input.content ?? ''),
    details: {
      path: input.path,
      size: input.size,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
    isError: false,
  };
}

/** 失败结果的新格式部分。isError=true，details 带错误码。 */
export function buildErrorExtras(input: {
  message: string;
  code?: string | number;
  details?: Record<string, unknown>;
}): ToolResultExtras {
  return {
    content: textContent(input.message ?? ''),
    details: {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.details ?? {}),
    },
    isError: true,
  };
}

// ---------------------------------------------------------------- 解释：UI 文本

/**
 * 把 content 数组拼接为纯文本。
 * 返回 null 表示「content 缺省或为空数组」→ 调用方应回退旧格式；
 * 返回 '' 表示「content 显式声明了空输出」→ 直接显示空。
 */
export function joinContent(content: ToolResultContentPart[] | undefined): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

function formatJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

/**
 * 旧格式回退逻辑（逐字节保留 tool-card-ui.ts 原行为）：
 *   error → data.stdout（含 CLIXML 清洗）→ data string → JSON.stringify
 */
function legacyResultText(result: LegacyToolCardResult): string {
  if (result.error) return result.error;
  if (result.data == null) return '';

  if (typeof result.data === 'object' && result.data !== null && 'stdout' in result.data) {
    const d = result.data as Record<string, unknown>;
    const stdout = typeof d.stdout === 'string' ? d.stdout : '';
    const stderr = typeof d.stderr === 'string' ? d.stderr : '';
    const exitCode = d.exitCode;

    // 清理 PowerShell stderr 中的 CLIXML 垃圾（#< CLIXML ... Completed-1 等）
    const cleanStderr = stderr
      .replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '')
      .replace(/System\.Management\.Automation\.[\s\S]*?Completed-1/g, '')
      .replace(/\bCompleted-1\b/g, '')
      .replace(/Preparing modules for first use\./g, '')
      .trim();

    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout.trimEnd());
    if (cleanStderr) parts.push(`[stderr]\n${cleanStderr}`);
    if (!result.ok && exitCode !== undefined && exitCode !== 0) {
      parts.push(`[exit-code] ${exitCode}`);
    }
    return parts.join('\n\n') || '(empty output)';
  }

  if (typeof result.data === 'string') return result.data;

  return formatJson(result.data);
}

/**
 * 格式化工具结果显示文本。
 *
 * 1. result.content 存在且非空 → 拼接所有 text 片段，直接作为纯文本（最工整）
 * 2. 否则回退旧格式（error → data.stdout → data string → JSON.stringify）
 * 3. result.isError === true → 加前缀 "[错误] "
 *
 * 注意：前缀只由 isError 驱动，不看 ok。旧格式 ok:false 的显示文案因此零变化。
 */
export function formatToolResultText(result: ToolCardResult): string {
  const contentText = joinContent(result.content);
  const base = contentText !== null ? contentText : legacyResultText(result);

  if (result.isError !== true) return base;
  return base ? `[错误] ${base}` : '[错误]';
}

// ---------------------------------------------------------------- 解释：续跑闸门

/**
 * 判断一个批次的工具结果是否应跳过自动续跑。
 *
 * 语义（与 Pi Agent 一致）：terminate 是「提示」而非「强制」——
 * 只有当批次内**所有**结果都显式 terminate === true 时才跳过；
 * 只要有一个结果 terminate 缺省或为 false，就正常续跑。
 *
 * fail-open 约定：
 *   - 空批次 → 不跳过（避免「队列异常为空」被当成「全部终止」而永久停跑）；
 *   - null / undefined 条目 → 视为「未声明终止」，同样不跳过。
 */
export function shouldSkipAutoContinue(
  results: ReadonlyArray<{ terminate?: boolean } | null | undefined>,
): boolean {
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.every((r) => !!r && r.terminate === true);
}
