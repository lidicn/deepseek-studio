/**
 * search-files —— 本地、纯函数、离线文件检索能力（ORD-001）
 *
 * 只交付模块 + 单测，供主进程后续挂成 search_files 工具；
 * 本模块不注册工具、不接线、不访问网络、不 spawn、不读 process.env 密钥。
 *
 * 边界（fail-closed，纵深防御）：
 * - root 由调用方注入；模块只在注入 root 之内遍历。
 * - 不跟随符号链接：用 Dirent 判定，遇到 symlink 不递归、不作为文件读取，仅作为普通条目列出。
 * - 任何解析后越出 root 的路径一律丢弃（不依赖调用方授权）。
 *
 * 失败一律返回 { ok:false, error:<错误码> }，不抛异常给调用方。
 * 错误码词表见 docs/PM/roadmap/CONTRACTS.md §6.1。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecuteResult } from './types';

export interface ListFilesInput {
  root: string; // 调用方注入的工作区根（绝对路径）
  pattern?: string; // 文件名通配：* = 任意串，? = 单字符；缺省 = 全部
  recursive?: boolean; // 默认 true
  limit?: number; // 默认 500，超出截断并标 truncated
}

export interface GrepFilesInput {
  root: string;
  query: string; // 默认按子串；regex=true 时按正则
  regex?: boolean;
  caseInsensitive?: boolean;
  glob?: string; // 可选：只在匹配该文件名通配的文件内检索
  limit?: number; // 默认 200 条命中，超出截断
}

export interface ListedEntry {
  path: string; // 相对 root，用 / 分隔
  type: 'file' | 'dir';
  size?: number; // 仅文件填充
}

const DEFAULT_LIST_LIMIT = 500;
const DEFAULT_GREP_LIMIT = 200;
const MAX_LINE_LEN = 200;

function ok(data: unknown): ExecuteResult {
  return { ok: true, data };
}

function fail(error: string): ExecuteResult {
  return { ok: false, error };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** 把文件名通配（* 任意串，? 单字符）编译为 basename 精确匹配正则。 */
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (const ch of glob) {
    if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else {
      // 转义其余正则元字符，避免误匹配
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re);
}

/**
 * 校验并归一化 root。
 * - 缺/空 → missing-argument
 * - 非绝对路径 → invalid-argument
 * - 不存在/不可读 → io-error
 * - 存在但不是目录 → invalid-argument
 */
async function resolveRoot(
  root: unknown,
): Promise<{ absRoot: string } | { error: string }> {
  if (!isNonEmptyString(root)) return { error: 'missing-argument' };
  if (!path.isAbsolute(root)) return { error: 'invalid-argument' };
  const absRoot = path.resolve(root);
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(absRoot);
  } catch {
    return { error: 'io-error' };
  }
  if (!st.isDirectory()) return { error: 'invalid-argument' };
  return { absRoot };
}

/**
 * 把 root 下的绝对子路径换算成相对 root 的 posix（'/' 分隔）路径。
 * 越出 root（含 root 自身）返回 null，由调用方丢弃。
 */
function toRel(root: string, full: string): string | null {
  const rel = path.relative(root, full);
  if (rel === '') return null; // root 自身，不列为条目
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 越界
  return rel.split(path.sep).join('/');
}

interface WalkEntry {
  full: string; // 绝对路径
  name: string; // basename
  isDir: boolean;
  isSymlink: boolean;
}

/**
 * 惰性遍历 root 下条目（基于 readdir withFileTypes，不跟随符号链接）。
 * - 仅当 recursive 且条目是真实目录（非 symlink）时才下钻。
 * - visited 记录已展开目录的绝对路径，作为防循环纵深防御（环链主要靠不跟随 symlink 阻断）。
 * - 单个不可读目录跳过，不整体失败。
 */
async function* walk(absRoot: string, recursive: boolean): AsyncGenerator<WalkEntry> {
  const visited = new Set<string>();
  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (visited.has(dir)) continue;
    visited.add(dir);

    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of dirents) {
      const full = path.join(dir, d.name);
      const isSym = d.isSymbolicLink();
      const isDir = d.isDirectory();
      yield { full, name: d.name, isDir, isSymlink: isSym };
      // 不跟随符号链接：仅真实目录才入栈下钻
      if (recursive && isDir && !isSym) {
        stack.push(full);
      }
    }
  }
}

function resolveLimit(inputLimit: unknown, fallback: number): number {
  if (typeof inputLimit === 'number' && Number.isFinite(inputLimit) && inputLimit > 0) {
    return Math.floor(inputLimit);
  }
  return fallback;
}

export async function listFiles(input: ListFilesInput): Promise<ExecuteResult> {
  const rootCheck = await resolveRoot(input.root);
  if ('error' in rootCheck) return fail(rootCheck.error);
  const absRoot = rootCheck.absRoot;

  const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
  const recursive = input.recursive !== false; // 默认 true
  const nameRe = input.pattern ? globToRegExp(input.pattern) : null;

  const entries: ListedEntry[] = [];
  let truncated = false;

  for await (const e of walk(absRoot, recursive)) {
    if (nameRe && !nameRe.test(e.name)) continue;
    const rel = toRel(absRoot, e.full);
    if (rel === null) continue; // 越界丢弃

    if (entries.length >= limit) {
      truncated = true;
      break;
    }

    const entry: ListedEntry = { path: rel, type: e.isDir ? 'dir' : 'file' };
    if (!e.isDir) {
      try {
        const st = await fs.lstat(e.full);
        entry.size = st.size;
      } catch {
        // 取不到 size 不影响列表本身
      }
    }
    entries.push(entry);
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return ok({ root: absRoot, entries, total: entries.length, truncated });
}

export async function grepFiles(input: GrepFilesInput): Promise<ExecuteResult> {
  const rootCheck = await resolveRoot(input.root);
  if ('error' in rootCheck) return fail(rootCheck.error);
  const absRoot = rootCheck.absRoot;

  if (!isNonEmptyString(input.query)) return fail('missing-argument');

  const limit = resolveLimit(input.limit, DEFAULT_GREP_LIMIT);
  const caseInsensitive = input.caseInsensitive === true;

  let matcher: (line: string) => boolean;
  if (input.regex) {
    try {
      const re = new RegExp(input.query, caseInsensitive ? 'i' : '');
      matcher = (line: string) => re.test(line);
    } catch {
      return fail('invalid-argument');
    }
  } else {
    const needle = caseInsensitive ? input.query.toLowerCase() : input.query;
    matcher = (line: string) =>
      caseInsensitive ? line.toLowerCase().includes(needle) : line.includes(needle);
  }

  const fileRe = input.glob ? globToRegExp(input.glob) : null;

  const matches: Array<{ file: string; line: number; text: string }> = [];
  let truncated = false;

  for await (const e of walk(absRoot, true)) {
    if (e.isDir || e.isSymlink) continue; // 只检索普通文件，不跟随链接
    if (fileRe && !fileRe.test(e.name)) continue;
    const rel = toRel(absRoot, e.full);
    if (rel === null) continue; // 越界丢弃

    let content: string;
    try {
      content = await fs.readFile(e.full, 'utf-8');
    } catch {
      continue; // 单个文件读不了（权限/二进制等）就跳过，不整体失败
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (matcher(line)) {
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({ file: rel, line: i + 1, text: line.slice(0, MAX_LINE_LEN) });
      }
    }
    if (truncated) break;
  }

  return ok({ root: absRoot, matches, truncated });
}
