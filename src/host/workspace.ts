/**
 * 工作区边界（v0.5）
 *
 * 三档命令审批模式的地基：「工作区间内的文件可以访问，其余审批」这句话要成立，
 * 前提是「在不在工作区间」的判定必须可靠。其中最容易被忽略的是**符号链接越狱**：
 * 一个位于工作区内的软链接若指向 /etc 或 C:\Windows，词法路径检查会放行，
 * 但真实写入位置在工作区外。因此这里对所有已存在的目标做 realpath 二次校验。
 *
 * 依赖注入：所有 fs 能力通过 deps 注入，便于单测构造 Windows 路径与符号链接场景，
 * 也避免注入侧打包产物（entry.js）间接引入 node:fs。
 */

import path from 'node:path';
import os from 'node:os';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';

export const WORKSPACE_ENV_KEY = 'STUDIO_WORKSPACE_ROOT';
export const WORKSPACE_CONFIG_KEY = 'workspaceRoot';

export type WorkspaceErrorCode =
  /** 环境变量未设置 */
  | 'env-unset'
  /** 配置文件不存在或不可解析 */
  | 'config-missing'
  /** 配置文件里没有 workspaceRoot */
  | 'config-key-missing'
  /** 路径存在但不是一个目录 */
  | 'not-a-directory';

export interface WorkspaceResolution {
  readonly root: string | null;
  /** 解析来源，用于宿主日志与排障。 */
  readonly source: 'env' | 'config' | 'none';
  readonly error?: WorkspaceErrorCode;
}

export interface WorkspaceDeps {
  realpath(p: string): string;
  statSync(p: string): Stats | undefined;
  resolve(p: string): string;
}

export interface WorkspaceContext {
  readonly root: string;
  /** 目标是否落在工作区内（含符号链接二次校验）。 */
  contains(target: string): boolean;
  /**
   * 解析出绝对路径；仅当确实在工作区内才返回，否则返回 null。
   * 能力实现应优先使用这个方法，而不是自行拼接路径。
   */
  resolveWithin(target: string): string | null;
}

const defaultDeps: WorkspaceDeps = {
  realpath: (p) => realpathSync(p),
  statSync: (p) => {
    try {
      return statSync(p);
    } catch {
      return undefined;
    }
  },
  resolve: (p) => path.resolve(p),
};

export function defaultConfigPath(homedir: string = os.homedir()): string {
  return path.join(homedir, '.config', 'deepseek-studio', 'config.json');
}

/**
 * 解析工作区根：环境变量优先 → 用户配置 → 失败（fail-closed）。
 * 刻意**不**隐式回落到进程 cwd：一旦静默采用 cwd，
 * 「工作区内自动放行」就会变成「宿主进程所在目录全部自动放行」，这是不可接受的面。
 */
export function resolveWorkspaceRoot(options: {
  env?: Record<string, string | undefined>;
  homedir?: string;
  readConfig?: (configPath: string) => unknown;
  cwd?: string;
} = {}): WorkspaceResolution {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const envRoot = env[WORKSPACE_ENV_KEY];
  if (typeof envRoot === 'string' && envRoot.trim().length > 0) {
    return { root: path.resolve(envRoot.trim()), source: 'env' };
  }

  const configPath = defaultConfigPath(options.homedir);
  try {
    const raw = options.readConfig?.(configPath);
    if (raw === undefined || raw === null) return { root: null, source: 'none', error: 'config-missing' };
    const bag = raw as Record<string, unknown>;
    const candidate = bag[WORKSPACE_CONFIG_KEY];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return { root: null, source: 'none', error: 'config-key-missing' };
    }
    return { root: path.resolve(candidate.trim()), source: 'config' };
  } catch {
    return { root: null, source: 'none', error: 'config-missing' };
  }
}

/**
 * 大小写归一化：Windows 文件系统大小写不敏感，
 * 若按大小写敏感比较，`ws/foo` 与 `WS/FOO` 会被判成两个不同位置而绕过包含判定。
 */
function normalizeForCompare(p: string, caseSensitive: boolean): string {
  const normalized = path.normalize(p).replace(/[\\/]+$/, '');
  return caseSensitive ? normalized : normalized.toLowerCase();
}

/** 词法包含判定：rootReal / child 均为大小写归一化后的绝对路径。 */
function lexicallyInside(rootNorm: string, childNorm: string): boolean {
  if (childNorm === rootNorm) return true;
  const rel = path.relative(rootNorm, childNorm);
  if (rel === '') return true;
  // rel 以 '..' 开头或本身是绝对路径 → 逃逸
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  // Windows 盘符不同（如 C: vs D:）时 relative 会给出绝对路径，已在上一步拦截
  return !rel.split(path.sep).includes('..');
}

export function createWorkspace(root: string, deps: Partial<WorkspaceDeps> = {}): WorkspaceContext {
  const d: WorkspaceDeps = { ...defaultDeps, ...deps };
  const caseSensitive = path.sep === '/' && process.platform !== 'win32';
  const rootAbs = d.resolve(root);
  // 根自身也做 realpath：工作区根若本身就是软链接，其内部所有文件的真实前缀会与之不同。
  let rootReal = rootAbs;
  try {
    rootReal = d.realpath(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  const rootNorm = normalizeForCompare(rootReal, caseSensitive);

  function containsRaw(target: string): boolean {
    const abs = d.resolve(target);
    if (!lexicallyInside(rootNorm, normalizeForCompare(abs, caseSensitive))) return false;
    // 目标已存在 → 必须再验真实路径，防止「工作区内的软链接指向外部」
    if (d.statSync(abs) !== undefined) {
      try {
        const real = d.realpath(abs);
        return lexicallyInside(rootNorm, normalizeForCompare(real, caseSensitive));
      } catch {
        // fail-closed：无法确定真实路径就当作不在工作区内
        return false;
      }
    }
    // 目标不存在且词法上落在工作区内 → 允许（新建文件的场景）
    return true;
  }

  return {
    root: rootAbs,
    contains: containsRaw,
    resolveWithin(target) {
      const abs = d.resolve(target);
      return containsRaw(abs) ? abs : null;
    },
  };
}

/**
 * 可变工作区上下文（M1）：面板「打开文件夹」后热切换，无需重启宿主。
 *
 * 能力（file/shell）在创建时捕获的是这个代理对象的引用；
 * setRoot 换掉内部实现后，已注册能力下一次调用即用新边界。
 * 策略层（policy.ts）保持纯函数：desktop-host 传 `proxy.current` 给 evaluatePolicy。
 */
export interface MutableWorkspaceContext extends WorkspaceContext {
  /** 当前生效的真实工作区；null 表示未配置（文件类能力不可用）。 */
  readonly current: WorkspaceContext | null;
  /** 是否已配置工作区（供能力层区分「未配置」与「越界」）。 */
  readonly configured: boolean;
  setRoot(root: string | null): void;
}

export function createMutableWorkspace(initial: WorkspaceContext | null = null): MutableWorkspaceContext {
  let inner = initial;
  return {
    get current() {
      return inner;
    },
    get configured() {
      return inner !== null;
    },
    get root() {
      return inner?.root ?? '';
    },
    contains(target) {
      return inner ? inner.contains(target) : false;
    },
    resolveWithin(target) {
      return inner ? inner.resolveWithin(target) : null;
    },
    setRoot(root) {
      inner = root ? createWorkspace(root) : null;
    },
  };
}

/**
 * 判断工作区是否真正可用。兼容两种形态：
 *   - null / undefined → 不可用
 *   - MutableWorkspaceContext（configured === false）→ 不可用
 *   - 普通静态 WorkspaceContext → 可用
 */
export function isWorkspaceConfigured(ws: WorkspaceContext | null | undefined): boolean {
  if (!ws) return false;
  const mutable = ws as Partial<MutableWorkspaceContext>;
  return mutable.configured !== false;
}

/**
 * 把 workspaceRoot / policyMode 等补丁合并写回用户配置（~/.config/deepseek-studio/config.json）。
 * 保留未知键；目录不存在则创建；文件权限 0600（配置里含 API token，不能放宽）。
 */
export function persistConfigPatch(
  patch: Record<string, unknown>,
  options: { homedir?: string; readFile?: (p: string) => string; writeFile?: (p: string, data: string) => void } = {},
): { ok: boolean; error?: string } {
  const cfgPath = defaultConfigPath(options.homedir);
  let bag: Record<string, unknown> = {};
  try {
    const raw = options.readFile ? options.readFile(cfgPath) : readFileSync(cfgPath, 'utf8');
    bag = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 不存在 / 不可解析：以空配置起步（与 loadConfig 的容错口径一致）
    bag = {};
  }
  bag = { ...bag, ...patch };
  try {
    const data = JSON.stringify(bag, null, 2);
    if (options.writeFile) {
      options.writeFile(cfgPath, data);
    } else {
      mkdirSync(path.dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, data, { mode: 0o600 });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
