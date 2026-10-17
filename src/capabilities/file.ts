/**
 * 宿主侧能力：file.read / file.write / file.list（v0.5）
 *
 * 纵深防御：策略层（policy.ts）已做过工作区判定，这里**再校验一次**。
 * 理由是能力是最后一公里——任何上层改动（新接口、旁路调用、未来 Rust 侧调用）
 * 都不能让「忘记先过策略」变成「直接读写任意文件」。
 *
 * 同样坚持 fail-closed：未配置工作区 → 文件系统能力整体不可用；
 * 越界路径一律拒绝，不做「用户可能知道自己在做什么」的猜测。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isWorkspaceConfigured, type WorkspaceContext } from '../host/workspace';
import type { CapabilityContext, ExecutableCapability, ExecuteResult } from './types';

export const DEFAULT_MAX_READ_BYTES = 512 * 1024;
export const DEFAULT_MAX_LIST_ENTRIES = 500;

export interface FileCapabilityOptions {
  workspace?: WorkspaceContext | null;
  maxReadBytes?: number;
  maxListEntries?: number;
}

export type FileToolId = 'file.read' | 'file.write' | 'file.list' | 'file.stat';

function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

export function createFileCapability(id: FileToolId, options: FileCapabilityOptions = {}): ExecutableCapability {
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;

  /** 解析路径：落在工作区内直接返回；越界时仅当宿主显式授权才返回，否则 null。 */
  const target = (params: Record<string, unknown>, ctx?: CapabilityContext): string | null => {
    const workspace = options.workspace ?? null;
    const raw = firstString(params, ['path', 'filePath', 'target']);
    if (!raw) return null;
    if (!workspace || !isWorkspaceConfigured(workspace)) return null;
    // R1-02：相对路径以工作区根为基准（resolveWithin 内部含 realpath 二次校验，
    // 符号链接越狱在此被拦住）；越界时仅当宿主显式授权才返回。
    const within = workspace.resolveWithin(raw);
    if (within) return within;
    return ctx?.allowOutsideWorkspace === true ? path.resolve(raw) : null;
  };

  return {
    id,
    async execute(params: Record<string, unknown>, ctx?: CapabilityContext): Promise<ExecuteResult> {
      // 兼容可变工作区代理：configured === false 即「未配置」，保持 fail-closed。
      if (!isWorkspaceConfigured(options.workspace)) {
        return { ok: false, error: 'workspace-unconfigured' };
      }
      const resolved = target(params, ctx);
      if (!resolved) {
        return { ok: false, error: firstString(params, ['path', 'filePath', 'target']) ? 'outside-workspace' : 'missing-path' };
      }

      try {
        if (id === 'file.list') {
          const entries = await fsp.readdir(resolved, { withFileTypes: true });
          const items = entries.slice(0, maxListEntries).map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'link' : 'other',
          }));
          return {
            ok: true,
            data: { path: resolved, items, total: entries.length, truncated: entries.length > maxListEntries },
          };
        }

        if (id === 'file.stat') {
          // 目标必须已存在（stat 语义）；区分 ENOENT（不存在）与其他错误（权限/IO）。
          try {
            const info = await fsp.stat(resolved);
            return {
              ok: true,
              data: {
                path: resolved,
                size: info.size,
                isDirectory: info.isDirectory(),
                isFile: info.isFile(),
                modifiedAt: info.mtime.toISOString(),
                createdAt: info.birthtime.toISOString(),
              },
            };
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') return { ok: false, error: 'not-found', data: { path: resolved } };
            return { ok: false, error: 'io-error', data: { path: resolved, detail: String(err) } };
          }
        }

        if (id === 'file.write') {
          const content = params.content;
          if (typeof content !== 'string') return { ok: false, error: 'missing-content' };
          const append = params.append === true;
          if (append) {
            await fsp.appendFile(resolved, content, 'utf8');
          } else {
            await fsp.mkdir(path.dirname(resolved), { recursive: true });
            await fsp.writeFile(resolved, content, 'utf8');
          }
          return { ok: true, data: { path: resolved, bytes: Buffer.byteLength(content, 'utf8'), append } };
        }

        // file.read（v0.9：支持 offset/limit 续读，对齐上游 local_file_read 语义）
        const offset = typeof params.offset === 'number' && params.offset >= 0 ? params.offset : 0;
        const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(params.limit, maxReadBytes) : maxReadBytes;
        const handle = await fsp.open(resolved, 'r');
        try {
          const stat = await handle.stat();
          const buf = Buffer.alloc(Math.min(limit, 4096));
          const chunks: Buffer[] = [];
          let read = 0;
          let curPos = offset;
          for (;;) {
            // v1.7：本次最多读「剩余配额」字节，防止越过 limit（修复 limit 突破 bug）。
            // 之前先 read+=bytesRead 再判 read>=limit，会多读一整块（最多 4095 字节）。
            const toRead = Math.min(buf.length, limit - read);
            if (toRead <= 0) break;
            const { bytesRead } = await handle.read(buf, 0, toRead, curPos);
            if (bytesRead === 0) break;
            chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
            read += bytesRead;
            curPos += bytesRead;
            if (read >= limit) break;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          const moreAvailable = offset + read < stat.size;
          return {
            ok: true,
            data: { path: resolved, text, bytes: read, offset, nextOffset: moreAvailable ? offset + read : null, totalBytes: stat.size, truncated: moreAvailable },
            // v1.2：Pi Agent 风格统一结果格式
            content: [{ type: 'text', text }],
            details: { path: resolved, size: read, offset, limit },
            isError: false,
          };
        } finally {
          await handle.close();
        }
      } catch (err) {
        return {
          ok: false,
          error: 'io-error',
          data: { path: resolved, message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
}

/** 一次性构造四个文件能力，便于宿主装配。 */
export function createFileTools(options: FileCapabilityOptions = {}): Record<string, ExecutableCapability> {
  return {
    'file.read': createFileCapability('file.read', options),
    'file.write': createFileCapability('file.write', options),
    'file.list': createFileCapability('file.list', options),
    'file.stat': createFileCapability('file.stat', options),
  };
}
