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
import type { WorkspaceContext } from '../host/workspace';

/**
 * 卡 ㊿-b ②：**本文件专用的 text content 构造器**（不用 `shared/tool-result-format` 的
 * `textContent`）。原因：`ExecuteResult.content` 与 `ToolResultExtras.content` 是**两份
 * 独立内联声明的形状**（text 段必带 `text:string`），跨模块引用会把类型统一工作牵进
 * `src/inject/**`（UI 席位写域）。这里的字面量构造 `type:'text'` 窄化后**同时满足**
 * 两种声明，不需要任何接口改动。
 */
function textContentLocal(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

/**
 * 遍历预算（卡 ㊿-b ②）。
 *
 * 现场（装版 storage.json，turn 4922ceac）：`search_files{operation:grep,
 * root:"E:/NAS/AutoForge", query:"--timeout", glob:"*.sh"}` 从发起算起跑了
 * **75,002 ms** 才被页端 75s 超时截断（`err=host-timeout`），而**宿主侧那趟遍历
 * 没有被取消**——页端放弃后它继续读文件，成为孤儿遍历。
 *
 * 根因有两条，彼此独立：
 *   1. 遍历**没有任何预算**：`walk()` 只有调用方传的 `limit`（那是"命中条数上限"，
 *      对 grep 而言命中为 0 时等于没有上限），深度、目录项数、读取文件数、耗时全无约束。
 *   2. 没有取消通道：页端超时只是"不再等"，宿主仍在跑。
 *
 * 这里补的是 1（预算）；2 由 `signal` 承担（宿主把页端 tool-cancel 传下来）。
 *
 * 取值口径：预算要"能跑完一次正常检索"，又不能让一次错参数把宿主拖进分钟级。
 * 15s 软预算 < 页端 75s 硬超时，留足余量让**宿主先自己收口**并给出可读的截断原因，
 * 而不是让页端先超时、用户只看到一句 host-timeout。
 */
export interface SearchLimits {
  /** 目录下钻深度上限（root 的直接子项为第 1 层）。默认 12。 */
  maxDepth?: number;
  /** 遍历产出的目录项上限（文件+目录，计入 scanned.entries）。默认 20,000。 */
  maxEntries?: number;
  /** grep 实际读取的文件数上限。默认 4,000。 */
  maxFiles?: number;
  /** 软耗时预算（ms）。默认 15,000。 */
  timeBudgetMs?: number;
  /**
   * 卡 ㊿-b-补3（CI 竞态）：**每目录项闸钩**（可选，生产路径不传＝零行为差）。
   *
   * 语义：walk 在**每个目录项产出前** `await` 一次它——测试用它把遍历"门住"，
   * 先断言「闸已被触达（遍历确在途）」再发 cancel，最后放闸。
   * 用途仅限测试注入受控暂停；生产调用方一律不传。
   * 它落在 signal 检查**之后**、产出**之前**：闸打开后，下一个检查点（本项或下一项）才读 abort。
   */
  onEntryAwait?: () => Promise<void> | void;
}

/** 截断原因（机器可读），同时决定给模型的下一步建议。 */
export type SearchTruncationReason =
  | 'limit'        // 调用方 limit 命中条数到顶
  | 'max-depth'    // 深度到顶
  | 'max-entries'  // 目录项数到顶
  | 'max-files'    // 读取文件数到顶
  | 'time-budget'; // 软耗时到顶

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_FILES = 4_000;
const DEFAULT_TIME_BUDGET_MS = 15_000;

/** 截断/越界时可执行的一句话（模型读得到，用户也能照做）。 */
function truncationHint(reason: SearchTruncationReason): string {
  switch (reason) {
    case 'limit':
      return '结果已按 limit 截断；需要更多请提高 limit 或缩小 root。';
    case 'max-depth':
      return '遍历已按最大深度截断；请把 root 指到更深一层的目录再检索。';
    case 'max-entries':
      return '遍历已按目录项上限截断（目录太大）；请缩小 root、或加 glob/pattern 只扫需要的文件。';
    case 'max-files':
      return '已按扫描文件数上限截断；请用 glob 限定文件类型或缩小 root。';
    case 'time-budget':
      return '已按耗时预算截断（本轮未扫完整个目录树）；请缩小 root 或用 glob 限定文件类型。';
    default:
      return '结果已截断。';
  }
}

/** 预算归一化：显式传入且为正数才生效，否则用默认值。 */
function resolveBudget(input: SearchLimits | undefined): Pick<Required<SearchLimits>, 'maxDepth' | 'maxEntries' | 'maxFiles' | 'timeBudgetMs'> {
  const pick = (v: unknown, fallback: number): number => {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  return {
    maxDepth: pick(input?.maxDepth, DEFAULT_MAX_DEPTH),
    maxEntries: pick(input?.maxEntries, DEFAULT_MAX_ENTRIES),
    maxFiles: pick(input?.maxFiles, DEFAULT_MAX_FILES),
    timeBudgetMs: pick(input?.timeBudgetMs, DEFAULT_TIME_BUDGET_MS),
  };
}

export interface ListFilesInput {
  root: string; // 调用方注入的工作区根（绝对路径）
  /**
   * C1 P1 安全批 TD-01：工作区上下文。
   *
   * **root 必须落在工作区内** —— 否则 `root` 就是任意绝对路径的入口
   * （配合 `approvalClass:'none'` = 零审批 → 任意绝对路径递归搜盘）。
   * 判定用现成的 `WorkspaceContext.resolveWithin`（含 realpath 二次校验）。
   */
  workspace?: WorkspaceContext | null;
  pattern?: string; // 文件名通配：* = 任意串，? = 单字符；缺省 = 全部
  recursive?: boolean; // 默认 true
  limit?: number; // 默认 500，超出截断并标 truncated
  /** 卡 ㊿-b ②：遍历预算（缺省见 DEFAULT_*）。 */
  limits?: SearchLimits;
  /** 卡 ㊿-b ②：取消信号。abort 后尽快返回 `cancelled`，不留孤儿遍历。 */
  signal?: AbortSignal;
}

export interface GrepFilesInput {
  root: string;
  /** C1 P1 安全批 TD-01：同 ListFilesInput.workspace（root 必须在工作区内）。 */
  workspace?: WorkspaceContext | null;
  query: string; // 默认按子串；regex=true 时按正则
  regex?: boolean;
  caseInsensitive?: boolean;
  glob?: string; // 可选：只在匹配该文件名通配的文件内检索
  limit?: number; // 默认 200 条命中，超出截断
  /** 卡 ㊿-b ②：遍历预算（缺省见 DEFAULT_*）。 */
  limits?: SearchLimits;
  /** 卡 ㊿-b ②：取消信号。 */
  signal?: AbortSignal;
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
 * - **不在工作区内 → outside-workspace**（C1 P1 安全批 TD-01）
 *
 * ── C1 P1 安全批 TD-01 ──
 *
 * 原实现只校验「非空 / 绝对 / 存在 / 是目录」，**没有工作区约束** ——
 * 配合工具定义里的 `approvalClass:'none'`（零审批），等于**任意绝对路径递归搜盘**：
 * 模型只要给出 `root:"C:\\Users\\xxx"`，就能把用户主目录的文件名与内容列出来。
 *
 * 现在：`root` 必须落在工作区内。判定用**现成的** `WorkspaceContext.resolveWithin`
 * （内部含 realpath 二次校验，符号链接越狱一并被拦住）—— 不新写路径判定逻辑。
 *
 * 「工作区未配置」与「越界」要**区分开**（`file.ts` 同款口径）：
 *   - 未配置工作区（`workspace === null`）→ `missing-argument`（能力不可用，不是用户越界）
 *   - 配置了但 root 在外面                  → `outside-workspace`
 *   - **没传 workspace（`undefined`）**    → **不施加工作区约束**（见下）
 *
 * 为什么 `workspace` 是三态而不是「必填」：
 *   本模块是**通用能力**（只交付模块 + 单测，不注册工具、不接线），
 *   直接调用它的场景（如单测、未来的内部检索）不一定有工作区。
 *   所以：**传了才约束**。真正的闸门在**工具接线层**（desktop-host）——
 *   那里 `workspace` **必传**（`mutableWorkspace.current`），
 *   而工具的 `approvalClass` 同时从 `none` 改成 `mode`（走正常审批闸门）。
 *   两道闸是独立的：能力侧管「能不能读这个目录」，档位管「要不要问用户」。
 */
async function resolveRoot(
  root: unknown,
  workspace?: WorkspaceContext | null,
): Promise<{ absRoot: string } | { error: string; extras?: Partial<ExecuteResult> }> {
  if (!isNonEmptyString(root)) return { error: 'missing-argument' };
  if (!path.isAbsolute(root)) return { error: 'invalid-argument' };
  let absRoot: string;
  if (workspace === undefined) {
    // 未传工作区上下文 → 不施加工作区约束（模块通用用法）。
    absRoot = path.resolve(root);
  } else if (workspace === null) {
    // 工作区已启用但**未配置根** → 文件类能力不可用（不是用户越界）。
    return { error: 'missing-argument' };
  } else {
    // TD-01：工作区约束。resolveWithin 返回 null = 越界。
    const within = workspace.resolveWithin(root);
    if (!within) return { error: 'outside-workspace' };
    absRoot = path.resolve(within);
  }
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(absRoot);
  } catch {
    return { error: 'io-error' };
  }
  /**
   * 卡 ㊿-b ②：`root` 指向文件时必须是**可操作错误**，不能只回一个 `invalid-argument`。
   *
   * 现场（turn 4922ceac，dt=31499→31535）：模型发了
   * `search_files{root:"E:/NAS/AutoForge/src/autoforge/af_service.py"}`，
   * 宿主回 `invalid-argument`（一个裸码），模型不知道"这个工具不能检索单文件"，
   * 于是下一轮换个写法再撞（`missing-argument` 那枚同族：两者都是"靠试错学工具契约"）。
   *
   * 这里把下一步写进 content（模型可见）与 details.reason（机器可读）：
   *   - 检索单个文件 → `local_file_read`
   *   - 一定要在这个文件里搜内容 → `operation:"grep"` 且 `root` 指向**父目录**
   *     （再用 glob 限定到该文件名）
   */
  if (!st.isDirectory()) {
    const kind = st.isFile() ? 'file' : 'other';
    const parent = path.dirname(absRoot);
    const what = kind === 'file' ? '一个文件' : '一个非目录项';
    return {
      error: 'invalid-argument',
      extras: {
        content: textContentLocal(
          `search_files 的 root 必须是目录，本次收到的是${what}：${absRoot}（invalid-argument）。`
          + '要读取单个文件，请改用 local_file_read；'
          + `要在该文件里检索内容，请把 operation 设为 grep 并把 root 指向其父目录 ${parent}`
          + (kind === 'file' ? `，再用 glob:"${path.basename(absRoot)}" 限定到该文件。` : '。'),
        ),
        details: { reason: 'root-not-directory', kind, root: absRoot, parent },
        isError: true,
      },
    };
  }
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
  depth: number; // 相对 root 的层数：root 的直接子项 = 1
}

/** 遍历控制状态：walk 写、调用方读（用于向结果里披露"为什么停"）。 */
interface WalkControl {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly signal?: AbortSignal;
  entries: number; // 已产出条目数
  dirs: number; // 已展开目录数
  /** 终止性原因（到顶即不再继续）；深度只记标志位，不终止同层兄弟。 */
  stop?: SearchTruncationReason;
  /** 因深度上限而没下钻过（结果可能不完整，但遍历正常完成）。 */
  depthLimited: boolean;
  aborted: boolean;
  /**
   * 卡 ㊿-b-补3：每目录项闸钩（可选；生产构造点不传 ⇒ 零行为差、零额外 await）。
   * 落点＝abort 检查**之后**、产出**之前**（PM 硬约束②）：cancel 到达后遍历真的停下，
   * 测试放闸不会放行一整棵树。
   */
  readonly onEntryAwait?: () => Promise<void> | void;
}

/**
 * 惰性遍历 root 下条目（基于 readdir withFileTypes，不跟随符号链接）。
 * - 仅当 recursive 且条目是真实目录（非 symlink）时才下钻。
 * - visited 记录已展开目录的绝对路径，作为防循环纵深防御（环链主要靠不跟随 symlink 阻断）。
 * - 单个不可读目录跳过，不整体失败。
 *
 * 卡 ㊿-b ②：遍历必须有预算与取消，否则一次 `root:"E:/NAS/AutoForge"` 的 grep
 * 会读完整棵树（现场 75,002 ms 才被页端截断）。三条闸都在**每个目录项**上判，
 * 所以最坏情况是"多读一个 dirent"，不是"多读一棵子树"。
 */
async function* walk(
  absRoot: string,
  recursive: boolean,
  ctrl: WalkControl,
): AsyncGenerator<WalkEntry> {
  const visited = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: absRoot, depth: 0 }];
  while (stack.length > 0) {
    if (ctrl.signal?.aborted) {
      ctrl.aborted = true;
      return;
    }
    if (ctrl.stop) return;
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    if (visited.has(dir)) continue;
    visited.add(dir);
    ctrl.dirs += 1;

    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of dirents) {
      if (ctrl.signal?.aborted) {
        ctrl.aborted = true;
        return;
      }
      if (ctrl.stop) return;
      // 卡 ㊿-b-补3：测试闸钩（可选）——只在传了才 await（硬约束①：生产零额外开销）；
      // 落点在 abort 检查之后（硬约束②）：放闸后下一检查点才读 abort，不会放行整棵树。
      if (ctrl.onEntryAwait) await ctrl.onEntryAwait();
      // 先判预算再产出：上限命中时这一枚**不计入** entries（否则会多算一枚）。
      if (ctrl.entries >= ctrl.maxEntries) {
        ctrl.stop = 'max-entries';
        return;
      }
      const full = path.join(dir, d.name);
      const isSym = d.isSymbolicLink();
      const isDir = d.isDirectory();
      const childDepth = depth + 1;
      ctrl.entries += 1;
      yield { full, name: d.name, isDir, isSymlink: isSym, depth: childDepth };
      // 不跟随符号链接：仅真实目录才入栈下钻
      if (recursive && isDir && !isSym) {
        if (childDepth >= ctrl.maxDepth) {
          ctrl.depthLimited = true;
          continue;
        }
        stack.push({ dir: full, depth: childDepth });
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

/** 取消出口：与宿主 onToolResult 的 `cancelled` 相位同词（/cancel|abort|stopped/ 命中）。 */
function cancelled(): ExecuteResult {
  return {
    ok: false,
    error: 'cancelled',
    content: textContentLocal(
      '本次检索已被取消（页端超时或调用方撤销），遍历未完成、结果不完整。'
      + '需要结果请缩小 root 后重发；不要原样重试同一发。',
    ),
    details: { reason: 'cancelled' },
    isError: true,
  };
}

/** 截断披露：机器可读的 truncatedReason + 模型可执行的 hint。 */
function withTruncation(
  base: Record<string, unknown>,
  reason: SearchTruncationReason | undefined,
): Record<string, unknown> {
  if (!reason) return { ...base, truncated: false };
  return { ...base, truncated: true, truncatedReason: reason, hint: truncationHint(reason) };
}

export async function listFiles(input: ListFilesInput): Promise<ExecuteResult> {
  const rootCheck = await resolveRoot(input.root, input.workspace);
  if ('error' in rootCheck) return { ok: false, error: rootCheck.error, ...(rootCheck.extras ?? {}) };
  const absRoot = rootCheck.absRoot;

  const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
  const recursive = input.recursive !== false; // 默认 true
  const nameRe = input.pattern ? globToRegExp(input.pattern) : null;

  const budget = resolveBudget(input.limits);
  const deadline = Date.now() + budget.timeBudgetMs;
  const ctrl: WalkControl = {
    maxDepth: budget.maxDepth,
    maxEntries: budget.maxEntries,
    signal: input.signal,
    // 卡 ㊿-b-补3：测试闸钩透传（可选；生产不传＝undefined＝零行为差）。
    ...(input.limits?.onEntryAwait ? { onEntryAwait: input.limits.onEntryAwait } : {}),
    entries: 0,
    dirs: 0,
    depthLimited: false,
    aborted: false,
  };

  const entries: ListedEntry[] = [];
  let truncReason: SearchTruncationReason | undefined;

  for await (const e of walk(absRoot, recursive, ctrl)) {
    if (nameRe && !nameRe.test(e.name)) continue;
    const rel = toRel(absRoot, e.full);
    if (rel === null) continue; // 越界丢弃

    if (entries.length >= limit) {
      truncReason = 'limit';
      break;
    }
    if (Date.now() > deadline) {
      truncReason = 'time-budget';
      ctrl.stop = 'time-budget';
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

  if (ctrl.aborted) return cancelled();
  if (!truncReason) truncReason = ctrl.stop ?? (ctrl.depthLimited ? 'max-depth' : undefined);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return ok(withTruncation(
    {
      root: absRoot,
      entries,
      total: entries.length,
      limits: budget,
      scanned: { entries: ctrl.entries, dirs: ctrl.dirs },
    },
    truncReason,
  ));
}

export async function grepFiles(input: GrepFilesInput): Promise<ExecuteResult> {
  const rootCheck = await resolveRoot(input.root, input.workspace);
  if ('error' in rootCheck) return { ok: false, error: rootCheck.error, ...(rootCheck.extras ?? {}) };
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

  const budget = resolveBudget(input.limits);
  const deadline = Date.now() + budget.timeBudgetMs;
  const ctrl: WalkControl = {
    maxDepth: budget.maxDepth,
    maxEntries: budget.maxEntries,
    signal: input.signal,
    // 卡 ㊿-b-补3：测试闸钩透传（可选；生产不传＝undefined＝零行为差）。
    ...(input.limits?.onEntryAwait ? { onEntryAwait: input.limits.onEntryAwait } : {}),
    entries: 0,
    dirs: 0,
    depthLimited: false,
    aborted: false,
  };

  const matches: Array<{ file: string; line: number; text: string }> = [];
  let truncReason: SearchTruncationReason | undefined;
  let filesScanned = 0;

  for await (const e of walk(absRoot, true, ctrl)) {
    if (e.isDir || e.isSymlink) continue; // 只检索普通文件，不跟随链接
    if (fileRe && !fileRe.test(e.name)) continue;
    const rel = toRel(absRoot, e.full);
    if (rel === null) continue; // 越界丢弃

    if (filesScanned >= budget.maxFiles) {
      truncReason = 'max-files';
      ctrl.stop = 'max-files';
      break;
    }
    if (Date.now() > deadline) {
      truncReason = 'time-budget';
      ctrl.stop = 'time-budget';
      break;
    }

    let content: string;
    try {
      content = await fs.readFile(e.full, 'utf-8');
    } catch {
      continue; // 单个文件读不了（权限/二进制等）就跳过，不整体失败
    }
    filesScanned += 1;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (matcher(line)) {
        if (matches.length >= limit) {
          truncReason = 'limit';
          break;
        }
        matches.push({ file: rel, line: i + 1, text: line.slice(0, MAX_LINE_LEN) });
      }
    }
    if (truncReason === 'limit') break;
  }

  if (ctrl.aborted) return cancelled();
  if (!truncReason) truncReason = ctrl.stop ?? (ctrl.depthLimited ? 'max-depth' : undefined);

  return ok(withTruncation(
    {
      root: absRoot,
      matches,
      limits: budget,
      scanned: { entries: ctrl.entries, dirs: ctrl.dirs, files: filesScanned },
    },
    truncReason,
  ));
}
