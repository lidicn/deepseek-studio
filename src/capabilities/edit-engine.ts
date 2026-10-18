/**
 * 局部改文件引擎（file.edit，v0.2）
 *
 * 对齐 docs/设计稿/M5-编程工具链最终设计稿.md 第 5 节。
 *
 * 契约：
 *   edit({ path, edits[], expectedSha256?, dryRun? })
 *     → { ok: true,  data: EditEngineData }              // 成功（含 dryRun / no-op）
 *     → { ok: false, error: '<§6.1 词表>' }             // 细分原因在 data.reason
 *
 * 分层：
 *   · applyTextEdit / countOverlappingOccurrences —— 纯函数核心（无 IO）
 *   · createFileEditCapability —— ExecutableCapability 外壳（工作区边界 + 读写盘）
 *
 * 边界：
 *   - 唯一匹配硬约束：oldString 必须恰好命中 1 次，否则整批拒绝
 *   - 原子性：同目录临时文件 + rename 单点替换，失败原文件零字节改动
 *   - 保真：BOM 原样拼回、CRLF/LF 不归一化、非 UTF-8 直接拒
 *   - 错误码全部复用 CONTRACTS §6.1 七个固定码
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isWorkspaceConfigured, type WorkspaceContext } from '../host/workspace';
import type { CapabilityContext, ExecutableCapability, ExecuteResult } from './types';

/** 单次 edit 允许处理的最大文件字节数（默认 2 MiB）。 */
export const DEFAULT_MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** 能力 id：沿用 file.* 命名空间。 */
export const EDIT_TOOL_ID = 'file.edit';

// ---------------------------------------------------------------------------
// 一、纯函数核心
// ---------------------------------------------------------------------------

export interface EditInstruction {
  readonly oldString: string;
  readonly newString: string;
}

export type ApplyTextEditResult =
  | { ok: true; text: string; changed: boolean; replacements: number }
  | {
      ok: false;
      reason: 'old-string-not-found' | 'match-ambiguous' | 'overlapping-edits';
      occurrences?: number;
    };

/**
 * 统计 needle 在 haystack 中的出现次数（允许重叠）。
 * 'aaa' 对 'aa' 计 2 次。空 needle 抛 TypeError。
 */
export function countOverlappingOccurrences(haystack: string, needle: string): number {
  if (typeof haystack !== 'string' || typeof needle !== 'string') {
    throw new TypeError('countOverlappingOccurrences: args must be strings');
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
    from = i + 1;
  }
  return count;
}

/**
 * 批量顺序替换：每条 oldString 必须在当前文本里恰好命中 1 次。
 * 任何一条失败 → 整体返回错误，不落盘。
 */
export function applyTextEdit(text: string, edits: readonly EditInstruction[]): ApplyTextEditResult {
  let current = text;
  let changed = false;
  let replacements = 0;

  for (let i = 0; i < edits.length; i++) {
    const { oldString, newString } = edits[i];
    if (oldString.length === 0) {
      return { ok: false, reason: 'overlapping-edits' };
    }
    const idx = current.indexOf(oldString);
    if (idx === -1) {
      return { ok: false, reason: 'old-string-not-found' };
    }
    const second = current.indexOf(oldString, idx + 1);
    if (second !== -1) {
      return { ok: false, reason: 'match-ambiguous', occurrences: countOverlappingOccurrences(current, oldString) };
    }
    if (oldString !== newString) {
      current = current.slice(0, idx) + newString + current.slice(idx + oldString.length);
      changed = true;
      replacements += 1;
    }
  }

  return { ok: true, text: current, changed, replacements };
}

// ---------------------------------------------------------------------------
// 二、能力外壳
// ---------------------------------------------------------------------------

export interface EditEngineData {
  path: string;
  applied: number;
  replacements: number;
  unchanged: boolean;
  bom: boolean;
  newline: 'lf' | 'crlf' | 'mixed';
  bytesBefore: number;
  bytesAfter: number;
  sha256Before: string;
  sha256After: string;
  candidates?: Array<{ line: number; text: string; score: number }>;
  matches?: Array<{ line: number; text: string; index: number }>;
  hint?: string;
}

export interface EditCapabilityOptions {
  workspace?: WorkspaceContext | null;
  maxEditBytes?: number;
}

/** 与 file.ts 一致的参数取值语义。 */
function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function fail(error: string, reason: string, extra: Record<string, unknown> = {}): ExecuteResult {
  return {
    ok: false,
    error,
    data: { reason, ...extra },
    content: [{ type: 'text', text: `edit failed: ${error} (${reason})` }],
    details: { reason, ...extra },
    isError: true,
  };
}

function success(data: EditEngineData, summary: string): ExecuteResult {
  return {
    ok: true,
    data,
    content: [{ type: 'text', text: summary }],
    details: { ...data },
    isError: false,
  };
}

/** 探测文件编码特征。 */
function detectEncoding(buf: Buffer): { bom: boolean; text: string; newline: 'lf' | 'crlf' | 'mixed' } | { unsupported: true } {
  // BOM
  let offset = 0;
  let bom = false;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    offset = 3;
  }
  // 严格 UTF-8 解码（fatal: true 遇到非法字节抛异常）
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(offset));
    // NUL 检测
    if (text.includes('\0')) return { unsupported: true };
    // 换行探测
    const lfCount = (text.match(/\n/g) || []).length;
    const crlfCount = (text.match(/\r\n/g) || []).length;
    let newline: 'lf' | 'crlf' | 'mixed' = 'lf';
    if (crlfCount > 0 && crlfCount === lfCount) newline = 'crlf';
    else if (crlfCount > 0) newline = 'mixed';
    return { bom, text, newline };
  } catch {
    return { unsupported: true };
  }
}

/** 构造 file.edit 能力。 */
export function createFileEditCapability(options: EditCapabilityOptions = {}): ExecutableCapability {
  const maxEditBytes = options.maxEditBytes ?? DEFAULT_MAX_EDIT_BYTES;

  return {
    id: EDIT_TOOL_ID,
    async execute(params: Record<string, unknown>, ctx?: CapabilityContext): Promise<ExecuteResult> {
      if (!isWorkspaceConfigured(options.workspace)) {
        return fail('workspace-unconfigured', 'workspace-unconfigured');
      }

      const rawPath = firstString(params, ['path', 'filePath', 'target']);
      if (!rawPath) {
        return fail('missing-argument', 'missing-path');
      }

      const workspace = options.workspace ?? null;
      const within = workspace ? workspace.resolveWithin(rawPath) : null;
      const resolved = within
        ? within
        : ctx?.allowOutsideWorkspace === true
          ? path.resolve(rawPath)
          : null;
      if (!resolved) {
        return fail('outside-workspace', 'outside-workspace', { path: rawPath });
      }

      // edits 参数
      const rawEdits = params.edits;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return fail('invalid-argument', 'edits-shape');
      }
      if (rawEdits.length > 20) {
        return fail('invalid-argument', 'edits-shape', { max: 20 });
      }
      const edits: EditInstruction[] = [];
      for (const e of rawEdits) {
        if (
          typeof e !== 'object' ||
          e === null ||
          typeof (e as Record<string, unknown>).oldString !== 'string' ||
          typeof (e as Record<string, unknown>).newString !== 'string'
        ) {
          return fail('invalid-argument', 'edits-shape');
        }
        if ((e as Record<string, string>).oldString.length === 0) {
          return fail('invalid-argument', 'empty-old-string');
        }
        edits.push({
          oldString: (e as Record<string, string>).oldString,
          newString: (e as Record<string, string>).newString,
        });
      }

      const expectedSha256 = typeof params.expectedSha256 === 'string' ? params.expectedSha256 : undefined;
      const dryRun = params.dryRun === true;

      // 读文件
      let stat: import('node:fs').Stats;
      try {
        stat = await fsp.stat(resolved);
      } catch {
        return fail('not-found', 'target-missing', { path: resolved });
      }
      if (stat.isDirectory()) {
        return fail('invalid-argument', 'not-a-file', { path: resolved });
      }
      if (stat.size > maxEditBytes) {
        return fail('limit-exceeded', 'file-too-large', { size: stat.size, max: maxEditBytes });
      }

      const buf = await fsp.readFile(resolved);
      const enc = detectEncoding(buf);
      if ('unsupported' in enc) {
        return fail('invalid-argument', 'unsupported-encoding', { path: resolved });
      }
      const { bom, text: originalText, newline } = enc;

      const sha256Before = crypto.createHash('sha256').update(buf).digest('hex');

      // 乐观锁
      if (expectedSha256 && expectedSha256 !== sha256Before) {
        return fail('io-error', 'content-changed', {
          path: resolved,
          expected: expectedSha256,
          actual: sha256Before,
        });
      }

      // 应用编辑
      const result = applyTextEdit(originalText, edits);
      if (!result.ok) {
        // 构造错误详情
        const detail: Record<string, unknown> = { path: resolved, reason: result.reason };
        if (result.reason === 'match-ambiguous') {
          detail.occurrences = result.occurrences;
        }
        return fail('invalid-argument', result.reason, detail);
      }

      if (dryRun) {
        return success(
          {
            path: resolved,
            applied: 0,
            replacements: result.replacements,
            unchanged: true,
            bom,
            newline,
            bytesBefore: buf.length,
            bytesAfter: buf.length,
            sha256Before,
            sha256After: sha256Before,
          },
          `dryRun: would replace ${result.replacements} occurrence(s) in ${resolved}`,
        );
      }

      // 写回（带 BOM）
      const outBuf = result.changed
        ? Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(result.text, 'utf8')])
        : buf;

      if (result.changed) {
        // 原子写：同目录临时文件 + rename
        const dir = path.dirname(resolved);
        const base = path.basename(resolved);
        const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
        try {
          await fsp.writeFile(tmp, outBuf);
          await fsp.rename(tmp, resolved);
        } catch (err) {
          // 清理临时文件
          fsp.unlink(tmp).catch(() => {});
          return fail('io-error', 'write-failed', {
            path: resolved,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const sha256After = crypto.createHash('sha256').update(outBuf).digest('hex');
      return success(
        {
          path: resolved,
          applied: edits.length,
          replacements: result.replacements,
          unchanged: !result.changed,
          bom,
          newline,
          bytesBefore: buf.length,
          bytesAfter: outBuf.length,
          sha256Before,
          sha256After,
        },
        result.changed ? `modified ${resolved} (${result.replacements} replacement(s))` : `unchanged ${resolved}`,
      );
    },
  };
}
