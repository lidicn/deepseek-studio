/**
 * distribution.ts — 装版 / 开发树形态判定（单一真相源，设计稿 §8.3）
 *
 * 形态由 **Rust 侧**在 spawn sidecar 时注入 `STUDIO_DISTRIBUTION=installed|dev`：
 * 判据是「实际走了 `main.rs` 的哪条宿主入口分支」（`:1130` 之后的任一 return → installed；
 * `:1111` / `:1127` → dev），经 `HostEntry` 的结构体字段承载，**编译器强制三个构造点都填**。
 *
 * Node 侧**只读不算**：不许自己推断 exe / resource 路径，也不许读 `cfg!(debug_assertions)`
 * （它只能分「debug 构建 / release 构建」，分不了「release 构建但从仓库运行」）。
 *
 * **fail-safe**：读不到 env 或值非法 → 一律按 `installed` 处理。
 * 理由＝**判错代价不对称**：
 *   - dev 误判 installed → 开发者少了示例配置，自己立刻发现；
 *   - installed 误判 dev → 用户机被写上假 MCP + 空技能目录，**没人会发现**。
 */

import os from 'node:os';
import path from 'node:path';

export type StudioDistribution = 'installed' | 'dev';

/** 读形态；缺省 / 非法值一律 `installed`（fail-safe）。 */
export function resolveStudioDistribution(
  env: NodeJS.ProcessEnv = process.env,
): StudioDistribution {
  return env.STUDIO_DISTRIBUTION?.trim().toLowerCase() === 'dev' ? 'dev' : 'installed';
}

/** 是否装版形态（装版 = 跳过 dev 专属行为）。 */
export function isInstalledDistribution(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveStudioDistribution(env) === 'installed';
}

/**
 * 用户配置目录：`STUDIO_CONFIG_DIR` 优先，缺省回落 `~/.config/deepseek-studio`。
 *
 * 缺省分支与历史行为逐字节一致（dev 行为不变）；`homedir` 显式传入供注入式单测使用。
 * 全仓 5 处写死 homedir 的落点统一走这里（设计稿 §8.2）。
 */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir?: string,
): string {
  const fromEnv = env.STUDIO_CONFIG_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(homedir ?? os.homedir(), '.config', 'deepseek-studio');
}

/**
 * 装版落点根目录（设计稿 §8「机械推导」节）。
 *
 * 批 N+1 起 Rust 会同时注入 `STUDIO_CONFIG_DIR` 与 `STUDIO_LOG_DIR`，二者形如
 * `<data>/config`、`<data>/logs`；本函数从**已注入的**两个 env 反推出那个共同的
 * `<data>`，供「首启迁移」把老目录的东西搬过去。
 *
 * 只做**字符串推导**，不猜 exe 位置、不读注册表：
 *   - 两个 env 都没有（纯粹老装版 / dev）→ `null`，调用方据此跳过迁移；
 *   - 两个都指向同一父目录 → 返回该父目录（装版正常态）；
 *   - 只有一个，或父目录不一致（用户手工只设了一个）→ 返回 `null`，
 *     **宁可这次不迁移，也不往一个推导错的位置搬用户数据**（判错代价不对称）。
 *
 * 迁移本身的判据在地面（`config-migration.ts`），这里只回答「装版要把数据放到哪」。
 */
export function resolveStudioDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const cfg = env.STUDIO_CONFIG_DIR?.trim();
  const log = env.STUDIO_LOG_DIR?.trim();
  if (!cfg || !log) return null;
  const cfgParent = path.dirname(cfg);
  const logParent = path.dirname(log);
  if (normalizeForCompare(cfgParent) !== normalizeForCompare(logParent)) return null;
  // 两者必须是真的两个不同子目录（同一个值说明调用方把 config/log 注成了同一处 → 不迁移）
  if (normalizeForCompare(cfg) === normalizeForCompare(log)) return null;
  return cfgParent;
}

/** 路径比较用归一（Windows 大小写不敏感、分隔符混用；末尾分隔符不算差异）。 */
function normalizeForCompare(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * 日志目录：`STUDIO_LOG_DIR` 优先，缺省**逐字镜像 Rust 侧的回落链**
 * （`sidecar.rs`：`dirs::config_dir()/deepseek-studio/logs`）。
 *
 * 为什么要在 Node 侧镜像：面板要显示**真实路径**（PM 裁定十），
 * 而 Rust 的回落值 Node 拿不到；镜像它比让面板显示模板串诚实得多。
 * `dirs::config_dir()` 在 Windows = `%APPDATA%`、在类 Unix = `~/.config`，
 * 故这里按平台分支，与 Rust 行为对齐。
 *
 * 返回值带 `source`：面板可据此区分「装版注入了」与「回落值」（诊断用）。
 */
export function resolveLogDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir?: string,
): { dir: string; source: 'env' | 'fallback' } {
  const fromEnv = env.STUDIO_LOG_DIR?.trim();
  if (fromEnv) return { dir: fromEnv, source: 'env' };
  const home = homedir ?? os.homedir();
  const configRoot =
    process.platform === 'win32'
      ? env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming')
      : path.join(home, '.config');
  return { dir: path.join(configRoot, 'deepseek-studio', 'logs'), source: 'fallback' };
}
