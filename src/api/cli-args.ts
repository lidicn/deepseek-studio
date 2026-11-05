/**
 * cli-args.ts — 宿主 CLI 参数解析（纯函数，可单测）
 *
 * 背景（2026-11-06）：这段逻辑原来内联在 `main.ts` 末尾，判据是
 * `argv.filter(a => !a.endsWith('main.ts'))` —— **文件名以 `main.ts` 结尾**就算脚本路径。
 * 加入 dev 入口 `dev-main.ts` 后这条判据的语义变得含糊：
 *   - 旧口径（endsWith）：`main.ts` 与 `dev-main.ts` **都**被过滤（因为都以 `main.ts` 结尾）；
 *   - 只看 `basename === 'main.ts'`：只过滤 `main.ts` → **`dev-main.ts` 会被当成用户参数留下**
 *     → `tsx src/api/dev-main.ts --help` 的 `cliArgs` 变成 `['dev-main.ts','--help']`
 *     → `isQueryOnly = false` → **`--help` 不再是查询，宿主被真的拉起来**（正是要防的孤儿进程）。
 *
 * 所以判据必须是「**枚举脚本入口名**」：两个入口都算脚本路径，其余才算用户参数。
 * 抽成纯函数的原因：`main.ts` 有顶层副作用（会起 8760 宿主），不能为了测这段逻辑去 import 它。
 */

import path from 'node:path';

/** 宿主入口脚本的文件名（`main` = 生产入口，`dev-main` = 开发入口）。 */
export const HOST_SCRIPT_NAMES: ReadonlySet<string> = new Set([
  'main.ts',
  'main.js',
  'dev-main.ts',
  'dev-main.js',
]);

/** CLI 查询类开关（只打印信息、不起宿主）。 */
export const QUERY_FLAGS: ReadonlySet<string> = new Set(['--help', '-h', '--version', '-V']);

/**
 * 取「用户参数」：去掉 node 可执行文件与脚本路径。
 *
 * **实测形态（2026-11-06 07:08，tsx 直接跑探针）**：
 * ```
 * ["C:\\Program Files\\nodejs\\node.exe", "<tmp>\\probe.mjs", "--help"]
 * ```
 * 即 `[node, 脚本路径, ...参数]` —— **argv[1] 就是脚本路径、没有 loader 元素**。
 *
 * 写法上取 `slice(2)`（跳过 node + 脚本），**再按名过滤一次**作为纵深防御：
 * 若将来 tsx 换成 `[node, loader, 脚本, ...]` 形态（loader 占掉 argv[1]），
 * 脚本路径会落到切片后的第一位，靠 basename 过滤仍能去掉它。两种形态都成立。
 */
export function extractCliArgs(argv: readonly string[]): string[] {
  return argv
    .slice(2)
    .filter((a) => !HOST_SCRIPT_NAMES.has(path.basename(a)));
}

/**
 * 是否「只查询」：存在查询开关，且**没有**任何其它实参。
 *
 * 用途：`--help` / `--version` 必须只打印就退出；否则会把整个宿主（含 8760 监听）拉起来，
 * 留下谁都不管的孤儿 node 占端口（20261023 实测该孤儿从 14:39 活到 15:2x，导致后续
 * 启动撞 EADDRINUSE → StartupFailed）。
 */
export function isQueryOnly(argv: readonly string[]): boolean {
  const args = extractCliArgs(argv);
  return args.length > 0 && args.every((a) => QUERY_FLAGS.has(a));
}
