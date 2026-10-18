/**
 * 局部改文件引擎（edit-engine，v0.1）
 *
 * 契约（§0 真机行为，逐条对齐）：
 *   edit({ path, oldString, newString })
 *     → { ok: true,  result: 'modified' }                            // 成功（含 create / no-op，细节看 data）
 *     → { ok: false, error: 'string-not-found' }                     // oldString 0 处命中
 *     → { ok: false, error: 'multiple-matches' }                     // oldString ≥2 处命中（含自重叠）
 *     → { ok: false, error: 'io-error' }                             // 工作区外 / IO 失败 / 超限 / 撞已有文件
 *     → { ok: false, error: 'not-found' }                            // replace 模式目标文件不存在
 *     → { ok: false, error: 'missing-path' | 'missing-content' | 'workspace-unconfigured' }
 *   oldString 为空串 → write 模式（新建文件，父目录自动补齐）。
 *
 * 分层（纯函数包 + 薄 IO 外壳）：
 *   · applyTextEdit / countOverlappingOccurrences —— 纯函数核心：无 IO、无外部状态；
 *     业务失败一律结构化错误码，仅「用法错误」抛 TypeError（fail-closed，不给错输出）。
 *   · createEditCapability —— ExecutableCapability 外壳：路径边界（复用 workspace.resolveWithin
 *     与 isWorkspaceConfigured）、读写盘、错误码映射，边界语义与 file.ts 一致。
 *
 * 边界：不修改任何既有文件、不加新依赖、不做 consent 闸（allowOutsideWorkspace 只认宿主 ctx，
 * 绝不从 params 读取，防止调用方自授权越界）。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isWorkspaceConfigured, type WorkspaceContext } from '../host/workspace';
import type { CapabilityContext, ExecutableCapability, ExecuteResult } from './types';

/** 单次 edit 允许处理的最大文件字节数。replace 必须整文件可见才能判定唯一命中，故设上限（可配）。 */
export const DEFAULT_MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** 能力 id：沿用 file.* 命名空间（file.read / file.write / file.list / file.stat → file.edit）。 */
export const EDIT_TOOL_ID = 'file.edit';
export type EditToolId = typeof EDIT_TOOL_ID;

// ---------------------------------------------------------------------------
// 一、纯函数核心
// ---------------------------------------------------------------------------

/** 纯函数层错误码（严格取自 §0 词表，不发明新码）。 */
export type EditApplyError = 'string-not-found' | 'multiple-matches';

export interface EditApplySuccess {
  ok: true;
  /** 成功值固定 'modified'（§0 契约字面量）。 */
  result: 'modified';
  /** 替换后的完整文本。 */
  text: string;
  /** 唯一命中的起始下标（UTF-16 code unit，与 String.prototype.indexOf 一致）。 */
  index: number;
  /** 恒为 1（0 / ≥2 走失败分支）。 */
  occurrences: 1;
  /** oldString === newString 时为 false：no-op，外壳应跳过写盘。 */
  changed: boolean;
}

export interface EditApplyFailure {
  ok: false;
  error: EditApplyError;
  /** 0（string-not-found）或 ≥2（multiple-matches），允许重叠计数。 */
  occurrences: number;
}

export type EditApplyOutcome = EditApplySuccess | EditApplyFailure;

/**
 * 统计 needle 在 haystack 中的出现次数（允许重叠）。
 * 空 needle / 非字符串属于用法错误，抛 TypeError。
 */
export function countOverlappingOccurrences(haystack: string, needle: string): number {
  if (typeof haystack !== 'string' || typeof needle !== 'string') {
    throw new TypeError('countOverlappingOccurrences: haystack/needle must be strings');
  }
  if (needle.length === 0) {
    throw new TypeError('countOverlappingOccurrences: needle must be non-empty');
  }
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count += 1;
    from = i + 1; // 允许自重叠命中，歧义必须被看见
  }
  return count;
}

/**
 * 局部替换纯函数：oldString 必须**恰好命中一次**，否则返回结构化错误。
 * 不做任何空白 / 换行 / BOM 归一化——归一化会让 oldString→newString 不再是字面局部改。
 */
export function applyTextEdit(text: string, oldString: string, newString: string): EditApplyOutcome {
  if (typeof text !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string') {
    throw new TypeError('applyTextEdit: text/oldString/newString must be strings');
  }
  if (oldString.length === 0) {
    // 空 oldString 没有文本语义（数学上处处命中），create 模式由外壳负责。
    throw new TypeError('applyTextEdit: oldString must be non-empty (create mode belongs to the shell)');
  }

  const index = text.indexOf(oldString);
  if (index < 0) return { ok: false, error: 'string-not-found', occurrences: 0 };

  const second = text.indexOf(oldString, index + 1);
  if (second >= 0) {
    return { ok: false, error: 'multiple-matches', occurrences: countOverlappingOccurrences(text, oldString) };
  }

  const changed = oldString !== newString;
  const next = changed ? text.slice(0, index) + newString + text.slice(index + oldString.length) : text;
  return { ok: true, result: 'modified', text: next, index, occurrences: 1, changed };
}

// ---------------------------------------------------------------------------
// 二、能力外壳（ExecutableCapability）
// ---------------------------------------------------------------------------

/**
 * 能力层错误码：全部复用既有词表（file.ts 已出现的码 + §0 明示码），
 * 不发明 'file-exists' / 'no-change' 之类新码，语义细节放 data.reason。
 */
export type EditErrorCode =
  | 'missing-path'
  | 'missing-content'
  | 'workspace-unconfigured'
  | 'io-error'
  | 'not-found'
  | 'string-not-found'
  | 'multiple-matches';

export type EditSuccessData = {
  path: string;
  mode: 'create' | 'replace';
  created: boolean;
  changed: boolean;
  /** 写盘后的字节数（utf8）。 */
  bytes: number;
  /** replace 模式改动前的字节数。 */
  oldBytes?: number;
  /** 实际替换次数：1（改动）/ 0（no-op 与 create 模式）。 */
  replacements?: number;
  /** 唯一命中的起始下标。 */
  matchIndex?: number;
  occurrences?: number;
};

/**
 * ExecuteResult 没有 result 字段，而 §0 契约的成功形状带 `result: 'modified'`。
 * 这里用扩展接口满足契约，types.ts 保持原样不动。
 */
export interface EditExecuteResult extends ExecuteResult {
  result?: 'modified';
}

export interface EditCapabilityOptions {
  workspace?: WorkspaceContext | null;
  maxEditBytes?: number;
}

/** 与 ExecutableCapability 兼容，但把结果收窄成带 result 的形状。 */
export interface EditCapability extends ExecutableCapability {
  readonly id: EditToolId;
  execute(params: Record<string, unknown>, ctx?: CapabilityContext): Promise<EditExecuteResult>;
}

/** 与 file.ts 完全一致的参数取值语义（取第一个非空字符串，trim）。 */
function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function editFailure(error: EditErrorCode, data: Record<string, unknown>): EditExecuteResult {
  return {
    ok: false,
    error,
    data,
    content: [{ type: 'text', text: `edit failed: ${error}` }],
    details: data,
    isError: true,
  };
}

function editSuccess(data: EditSuccessData, summary: string): EditExecuteResult {
  return {
    ok: true,
    result: 'modified',
    data,
    content: [{ type: 'text', text: summary }],
    details: { ...data },
    isError: false,
  };
}

/**
 * 构造 file.edit 能力。
 *
 * 检查顺序刻意与 file.ts 对齐：工作区 → 路径 → 载荷，保证宿主错误映射一致。
 * 失败一律结构化错误码，绝不部分写盘。
 */
export function createEditCapability(options: EditCapabilityOptions = {}): EditCapability {
  const maxEditBytes = options.maxEditBytes ?? DEFAULT_MAX_EDIT_BYTES;

  return {
    id: EDIT_TOOL_ID,
    async execute(params: Record<string, unknown>, ctx?: CapabilityContext): Promise<EditExecuteResult> {
      // 兼容可变工作区代理：configured === false 即「未配置」，保持 fail-closed。
      if (!isWorkspaceConfigured(options.workspace)) {
        return editFailure('workspace-unconfigured', { reason: 'workspace-unconfigured' });
      }

      const rawPath = firstString(params, ['path', 'filePath', 'target']);
      if (!rawPath) {
        return editFailure('missing-path', { reason: 'missing-path' });
      }

      const workspace = options.workspace ?? null;
      const within = workspace ? workspace.resolveWithin(rawPath) : null;
      const resolved = within ? within : ctx?.allowOutsideWorkspace === true ? path.resolve(rawPath) : null;
      if (!resolved) {
        // §0：工作区外一律 io-error（与 file.ts 的 outside-workspace 不同，按契约收敛到 io-error，
        // 真实原因留在 data.reason 供宿主诊断）；allowOutsideWorkspace 只认宿主 ctx。
        return editFailure('io-error', { path: rawPath, reason: 'outside-workspace' });
      }

      const oldString = params.oldString;
      const newString = params.newString;
      if (typeof oldString !== 'string' || typeof newString !== 'string') {
        return editFailure('missing-content', {
          path: resolved,
          reason: 'missing-content',
          missing: typeof oldString !== 'string' ? 'oldString' : 'newString',
        });
      }

      // ---- write 模式：oldString === '' → 新建文件（fail-closed：绝不静默覆盖已存在文件）----
      if (oldString.length === 0) {
        try {
          await fsp.mkdir(path.dirname(resolved), { recursive: true });
          await fsp.writeFile(resolved, newString, { encoding: 'utf8', flag: 'wx' });
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'EEXIST') {
            return editFailure('io-error', { path: resolved, mode: 'create', reason: 'file-exists' });
          }
          return editFailure('io-error', {
            path: resolved,
            mode: 'create',
            reason: 'io-failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        const bytes = Buffer.byteLength(newString, 'utf8');
        return editSuccess(
          { path: resolved, mode: 'create', created: true, changed: true, bytes, replacements: 0 },
          `created ${resolved} (${bytes} bytes)`,
        );
      }

      // ---- replace 模式 ----
      try {
        const stat = await fsp.stat(resolved);
        if (stat.isDirectory()) {
          return editFailure('io-error', { path: resolved, reason: 'is-directory' });
        }
        if (stat.size > maxEditBytes) {
          return editFailure('io-error', {
            path: resolved,
            reason: 'file-too-large',
            size: stat.size,
            maxEditBytes,
          });
        }

        const text = await fsp.readFile(resolved, 'utf8');
        const outcome = applyTextEdit(text, oldString, newString);
        if (!outcome.ok) {
          return editFailure(outcome.error, { path: resolved, occurrences: outcome.occurrences });
        }

        const oldBytes = Buffer.byteLength(text, 'utf8');
        const bytes = Buffer.byteLength(outcome.text, 'utf8');
        if (outcome.changed) {
          await fsp.writeFile(resolved, outcome.text, 'utf8');
        }
        return editSuccess(
          {
            path: resolved,
            mode: 'replace',
            created: false,
            changed: outcome.changed,
            bytes,
            oldBytes,
            replacements: outcome.changed ? 1 : 0,
            matchIndex: outcome.index,
            occurrences: outcome.occurrences,
          },
          outcome.changed ? `modified ${resolved}` : `unchanged ${resolved}`,
        );
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          return editFailure('not-found', { path: resolved, reason: 'file-missing' });
        }
        return editFailure('io-error', {
          path: resolved,
          reason: 'io-failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/** 与 createFileTools 对称的装配入口，便于宿主统一挂载（本单不接线）。 */
export function createEditTools(options: EditCapabilityOptions = {}): Record<string, ExecutableCapability> {
  return { [EDIT_TOOL_ID]: createEditCapability(options) };
}
