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
