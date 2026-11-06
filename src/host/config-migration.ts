/**
 * config-migration.ts — 装版首启数据迁移（设计稿 §8.5 段 3）
 *
 * **为什么需要它**：批 N+1 段 2 让 Rust 注入 `STUDIO_CONFIG_DIR=<data>/config` 与
 * `STUDIO_LOG_DIR=<data>/logs`。注进去之后，装版读写的就不再是老用户数据所在的
 * `~/.config/deepseek-studio` 与 `%APPDATA%\deepseek-studio\logs` —— **不迁移 = 老用户
 * 配置、记忆、影子备份全部「看起来消失」**。这正是 PM 裁定③ 要求「段 2 必须与段 3 同批」
 * 的原因。
 *
 * **不变量（每条都有对应单测）**：
 *   1. **只搬、不删**：目标已存在则跳过（绝不覆盖新数据）；源文件原样保留（§8.5 判据 3）。
 *   2. **`memories.db` 与 `memories.db.audit.key` 必须成对**：只搬 db 会让老记忆解密失败，
 *      属数据级不可逆（audit-crypto.ts:50 `auditKeyPath()` 是同目录兄弟文件）。
 *      故 db「已存在则跳过」时，若 key 缺而源有，**仍补搬 key**；反之亦然。
 *   3. **代际只跑一次**：`migration.log` 存在且含本轮 `GENERATION` → 整个迁移跳过。
 *      （用户事后主动删掉某文件，不会被下次启动又搬回来。）
 *   4. **幂等**：中途崩溃后重跑，已搬的部分因「目标存在」被跳过，不会重复。
 *   5. **只读源、不扫描全盘**：路径全部由调用方注入，本模块不读 `os.homedir()`。
 *
 * 注：`window-state.json` 只有在调用方把「老 rside 根」显式传进 `legacyDataDir`
 * 时才会被搬（Rust 侧窗口状态路径认 `STUDIO_CONFIG_DIR` 后，它必须跟着走，
 * 否则老用户窗口几何会突然回默认）。dev 形态不传，行为不变。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveStudioDataDir, resolveStudioDistribution, isInstalledDistribution } from '../shared/distribution';

/** 迁移代际：改了搬迁清单就 +1（老机器上会再跑一次增量）。 */
export const GENERATION = 1;
export const MIGRATION_LOG_NAME = 'migration.log';

/** 需要从老配置目录搬到新配置目录的**目录级**条目。 */
export const MIGRATED_DIRS = ['shadow'] as const;

/**
 * 需要从老配置目录搬到新配置目录的**文件级**条目。
 *
 * `memories.db` / `memories.db.audit.key` 由 `migrateMemoryPair` 单独处理（成对语义）。
 * `window-state.json` 一般住在 rside 根（见 `legacyDataDir`），不在这里。
 */
export const MIGRATED_FILES = [
  'config.json',
  'mcp-servers.json',
  MIGRATION_LOG_NAME,
] as const;

/** 记忆库文件名与其审计密钥后缀（audit-crypto.ts:51 `<db名>.audit.key`）。 */
export const MEMORY_DB_NAME = 'memories.db';
export const AUDIT_KEY_SUFFIX = '.audit.key';

export interface MigratePaths {
  /** 老配置目录（历史回落值：`~/.config/deepseek-studio`）。 */
  legacyConfigDir: string;
  /** 新配置目录（Rust 注入的 `STUDIO_CONFIG_DIR`）。 */
  newConfigDir: string;
  /** 老日志目录（历史回落值：`%APPDATA%\deepseek-studio\logs`）；无则 null。 */
  legacyLogDir?: string | null;
  /** 新日志目录（Rust 注入的 `STUDIO_LOG_DIR`）。 */
  newLogDir?: string | null;
  /**
   * 老「数据根」（Windows 上是 `%APPDATA%\deepseek-studio`）：只用于搬 `window-state.json`。
   * 传 null / 省略 = 不搬窗口状态（dev 形态）。
   */
  legacyDataDir?: string | null;
}

export interface MigrateResult {
  /** 是否真正执行了迁移（false = 无新目录 / 同目录 / 本代已跑过）。 */
  ran: boolean;
  /** 跳过原因（便于日志与单测断言）。 */
  skippedReason?:
    | 'same-dir'
    | 'no-new-dir'
    | 'already-migrated'
    | 'new-dir-missing';
  /** 实际搬过去的条目（目标相对路径）。 */
  copied: string[];
  /** 因为目标已存在而跳过的条目（相对路径）。 */
  skippedExisting: string[];
  /** 出错条目（路径 + 原因）；**单条失败不中断整体**，但会让 `ok=false`。 */
  errors: { path: string; error: string }[];
  /** 缺件/半套数据等**必须显式记录**的警告（不阻断迁移，也不许静默）。 */
  warnings: string[];
  /** 逐项明细（source→target + 字节数 + sha256 前 12 位），用于写 migration.log。 */
  details: { rel: string; from: string; to: string; bytes: number; sha256_12: string }[];
  /** 迁移日志落点（ran=true 时）。 */
  logPath?: string;
}

/** 判断 src 与 dst 是否同一路径（Windows 大小写不敏感、分隔符混用）。 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const t = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 递归复制目录：**目标已存在的文件一律跳过**（不覆盖新数据）。
 * 返回 { copied, skippedExisting }（相对 base 的 posix 路径）。
 */
function copyTree(
  src: string,
  dst: string,
  base: string,
  out: OutBag,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    out.errors.push({ path: src, error: String(e) });
    return;
  }
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    const rel = path.relative(base, s).split(path.sep).join('/');
    if (ent.isDirectory()) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch (e) {
        out.errors.push({ path: d, error: String(e) });
        continue;
      }
      copyTree(s, d, base, out);
      continue;
    }
    if (exists(d)) {
      out.skippedExisting.push(rel);
      continue;
    }
    try {
      fs.copyFileSync(s, d);
      out.copied.push(rel);
      out.details.push(detail(rel, s, d));
    } catch (e) {
      out.errors.push({ path: s, error: String(e) });
    }
  }
}

/** 迁移过程中的累积袋（copyTree / copyFileIfAbsent 共用）。 */
interface OutBag {
  copied: string[];
  skippedExisting: string[];
  errors: { path: string; error: string }[];
  details: { rel: string; from: string; to: string; bytes: number; sha256_12: string }[];
  warnings: string[];
}

/** 逐项明细：字节数 + sha256 前 12 位（PM 硬要求 (c)：日志要能对账）。 */
function detail(rel: string, from: string, to: string): {
  rel: string;
  from: string;
  to: string;
  bytes: number;
  sha256_12: string;
} {
  let bytes = 0;
  let hash = '';
  try {
    const buf = fs.readFileSync(to);
    bytes = buf.length;
    hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  } catch {
    // 读不到就留空，不影响迁移本身
  }
  return { rel, from, to, bytes, sha256_12: hash };
}

function copyFileIfAbsent(
  src: string,
  dst: string,
  rel: string,
  out: OutBag,
): void {
  if (!exists(src)) return;
  if (exists(dst)) {
    out.skippedExisting.push(rel);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    out.copied.push(rel);
    out.details.push(detail(rel, src, dst));
  } catch (e) {
    out.errors.push({ path: src, error: String(e) });
  }
}

/**
 * 记忆库**成对**迁移（§8.5 判据：缺一即红）。
 *
 * 语义不是「两个文件各自看目标在不在」，而是**按 db 与 key 的配对状态**决定：
 *   - db 与 key 都缺 → 两个都搬；
 *   - db 在、key 缺 → **只补搬 key**（db 已存在说明是新数据/上次搬过，
 *     但 key 丢了会让老 db 解不开，补上它不会覆盖任何东西）；
 *   - db 缺、key 在 → 只搬 db（key 已就位，db 补上即可解密）。
 * 一句话：**两边各自「缺什么补什么」，但绝不覆盖**。
 */
function migrateMemoryPair(
  legacyConfigDir: string,
  newConfigDir: string,
  out: OutBag,
): void {
  const dbSrc = path.join(legacyConfigDir, MEMORY_DB_NAME);
  const keyName = `${MEMORY_DB_NAME}${AUDIT_KEY_SUFFIX}`;
  const keySrc = path.join(legacyConfigDir, keyName);
  const dbThere = exists(dbSrc);
  const keyThere = exists(keySrc);

  // PM 硬要求 (d)：迁移的职责是「不丢数据」不是「修数据」，但**缺件必须显式记，不许静默**。
  if (dbThere && !keyThere) {
    out.warnings.push(
      `记忆库缺审计密钥：${dbSrc} 存在但 ${keySrc} 不存在 —— ` +
        '已搬 db；新目录下这份记忆可能无法解密，需人工确认（是否曾删过 .audit.key）',
    );
  }
  if (!dbThere && keyThere) {
    out.warnings.push(
      `审计密钥缺记忆库：${keySrc} 存在但 ${dbSrc} 不存在 —— 已搬 key；db 缺失`,
    );
  }
  if (dbThere) copyFileIfAbsent(dbSrc, path.join(newConfigDir, MEMORY_DB_NAME), MEMORY_DB_NAME, out);
  if (keyThere) copyFileIfAbsent(keySrc, path.join(newConfigDir, keyName), keyName, out);

  // 目标侧不成对（例如曾经只搬成功一半）也要报 —— 这条能在真机上抓出「半套数据」。
  const dbDst = exists(path.join(newConfigDir, MEMORY_DB_NAME));
  const keyDst = exists(path.join(newConfigDir, keyName));
  if (dbDst !== keyDst) {
    out.warnings.push(
      `迁移后记忆库不成对：新目录 db=${dbDst ? '有' : '无'} / key=${keyDst ? '有' : '无'} —— 需人工确认`,
    );
  }
}

function readLogGeneration(logPath: string): number | null {
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const m = /^generation=(\d+)$/m.exec(text);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 执行首启迁移（幂等、只搬不删、成对迁移记忆库）。
 *
 * @param paths 全部路径由调用方注入 —— 本模块**从不**自行推导用户主目录。
 */
export function migrateLegacyConfig(paths: MigratePaths): MigrateResult {
  const { legacyConfigDir, newConfigDir } = paths;
  const newLogDir = paths.newLogDir ?? null;
  const legacyLogDir = paths.legacyLogDir ?? null;

  const out: OutBag = {
    copied: [],
    skippedExisting: [],
    errors: [],
    details: [],
    warnings: [],
  };

  // —— 触发条件（先判，避免无谓建目录）——
  if (!newConfigDir) {
    return { ran: false, skippedReason: 'no-new-dir', ...out };
  }
  if (samePath(legacyConfigDir, newConfigDir)) {
    return { ran: false, skippedReason: 'same-dir', ...out };
  }
  // 新目录必须已经由 Rust 建出来：**没有它说明段 2 没生效 / dev 形态**，
  // 这时绝不能凭一个 env 值就在用户机上凭空造目录。
  if (!exists(newConfigDir) || !isDirectory(newConfigDir)) {
    return { ran: false, skippedReason: 'new-dir-missing', ...out };
  }

  const logPath = path.join(newConfigDir, MIGRATION_LOG_NAME);
  const seen = readLogGeneration(logPath);
  if (seen !== null && seen >= GENERATION) {
    return { ran: false, skippedReason: 'already-migrated', ...out, logPath };
  }

  // —— ① 目录级：shadow/ ——
  for (const dirName of MIGRATED_DIRS) {
    const src = path.join(legacyConfigDir, dirName);
    if (!exists(src) || !isDirectory(src)) continue;
    const dst = path.join(newConfigDir, dirName);
    try {
      fs.mkdirSync(dst, { recursive: true });
    } catch (e) {
      out.errors.push({ path: dst, error: String(e) });
      continue;
    }
    copyTree(src, dst, legacyConfigDir, out);
  }

  // —— ② 记忆库成对 ——
  migrateMemoryPair(legacyConfigDir, newConfigDir, out);

  // —— ③ 文件级 ——
  for (const name of MIGRATED_FILES) {
    if (name === MIGRATION_LOG_NAME) continue; // 日志在最后写，不搬
    copyFileIfAbsent(
      path.join(legacyConfigDir, name),
      path.join(newConfigDir, name),
      name,
      out,
    );
  }

  // —— ④ 日志目录（只挪走老目录里的内容，不建无关目录）——
  if (legacyLogDir && newLogDir && !samePath(legacyLogDir, newLogDir)) {
    if (exists(legacyLogDir) && isDirectory(legacyLogDir)) {
      if (exists(newLogDir) && isDirectory(newLogDir)) {
        copyTree(legacyLogDir, newLogDir, legacyLogDir, out);
      }
    }
  }

  // —— ⑤ 窗口状态（老 rside 根 → 新配置目录；仅装版传入 legacyDataDir）——
  if (paths.legacyDataDir) {
    copyFileIfAbsent(
      path.join(paths.legacyDataDir, 'window-state.json'),
      path.join(newConfigDir, 'window-state.json'),
      'window-state.json',
      out,
    );
  }

  // —— ⑥ 记日志（先写 tmp 再 rename，防半截文件）——
  try {
    const body = [
      `generation=${GENERATION}`,
      `at=${new Date().toISOString()}`,
      `from=${legacyConfigDir}`,
      `to=${newConfigDir}`,
      ...(legacyLogDir && newLogDir ? [`logs_from=${legacyLogDir}`, `logs_to=${newLogDir}`] : []),
      `copied=${out.copied.length}`,
      `skipped_existing=${out.skippedExisting.length}`,
      `errors=${out.errors.length}`,
      `warnings=${out.warnings.length}`,
      ...out.details.map(
        (d) => `copied ${d.rel} | ${d.from} -> ${d.to} | bytes=${d.bytes} sha256_12=${d.sha256_12}`,
      ),
      ...out.skippedExisting.map((p) => `skip-existing ${p}`),
      ...out.warnings.map((w) => `warn ${w}`),
      ...out.errors.map((e) => `error ${e.path}: ${e.error}`),
      '',
    ].join('\n');
    const tmp = `${logPath}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, logPath);
  } catch (e) {
    out.errors.push({ path: logPath, error: String(e) });
  }

  return { ran: true, ...out, logPath };
}

/**
 * 启动时调用（宿主首行，早于任何配置读写）。
 *
 * **只在装版 + Rust 已注入两个目录 env 时动作**；dev（含 tsx 回退、vitest）一律直接返回，
 * 行为逐字节不变。老目录的推导规则（历史回落值，与 v0.14.7 逐字一致）：
 *   - 老配置目录 = `~/.config/deepseek-studio`（Node 侧 `resolveConfigDir` 的缺省值）
 *   - 老日志目录 = `%APPDATA%\deepseek-studio\logs`（Rust `dirs::config_dir()` 的缺省值）
 *     —— 在 Windows 上 `dirs::config_dir()` = Roaming，**不等于** `~/.config`，
 *     故 `legacyDataDir` 单独传（`window-state.json` 住在那里）。
 *
 * 失败不影响启动：迁移是尽力而为，异常只打日志（用户不该因为搬家失败而开不了 app）。
 */
export function runStartupMigration(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): MigrateResult | null {
  try {
    if (resolveStudioDistribution(env) !== 'installed') return null;
    const dataDir = resolveStudioDataDir(env);
    if (!dataDir || !isInstalledDistribution(env)) return null;
    const legacyDataDir = path.join(appDataRoot(homedir), 'deepseek-studio');
    const result = migrateLegacyConfig({
      legacyConfigDir: path.join(homedir, '.config', 'deepseek-studio'),
      newConfigDir: env.STUDIO_CONFIG_DIR!.trim(),
      legacyLogDir: path.join(legacyDataDir, 'logs'),
      newLogDir: env.STUDIO_LOG_DIR!.trim(),
      legacyDataDir,
    });
    if (result.ran) {
      console.log(
        `[deepseek-studio] 首启迁移 gen=${GENERATION}: copied=${result.copied.length} ` +
          `skip-existing=${result.skippedExisting.length} errors=${result.errors.length} → ${result.logPath}`,
      );
      for (const e of result.errors) {
        console.error(`[deepseek-studio] 迁移失败 ${e.path}: ${e.error}`);
      }
    } else if (result.skippedReason === 'new-dir-missing') {
      // Rust 应已建出该目录；没有说明段 2 没生效 —— 打一行便于真机排查，不阻断启动。
      console.error(
        `[deepseek-studio] 首启迁移跳过：新配置目录不存在 ${env.STUDIO_CONFIG_DIR}`,
      );
    }
    return result;
  } catch (e) {
    console.error(`[deepseek-studio] 首启迁移异常（已忽略）: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Windows = `%APPDATA%`（= `dirs::config_dir()`）；其它平台 = `~/.config`。 */
function appDataRoot(homedir: string): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA?.trim() || path.join(homedir, 'AppData', 'Roaming');
  }
  return path.join(homedir, '.config');
}
