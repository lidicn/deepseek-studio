/**
 * dev-main.ts — 开发期宿主入口（**显式声明形态**，设计稿 §8.3 / PM 裁定② 2026-11-06）
 *
 * 为什么需要它：`STUDIO_DISTRIBUTION` 只由 Rust 在 spawn sidecar 时注入，而
 * `npm start`（= `tsx src/api/main.ts`，也是 tauri.conf 的 beforeDevCommand 链路）
 * **不经 Rust** → env 缺失 → 落进 fail-safe `installed` → **dev 行为被切走**
 * （技能目录不再命中 `~/.agents/skills`、`ensureMcpConfig` 不再写示例）。
 *
 * 原则：**谁启动它，谁告诉它形态** —— Node 侧仍不许自己推断形态，
 * 这里只是让「开发启动方」显式声明 `dev`；已显式设置时一律尊重（不覆盖）。
 *
 * 跨平台：不用 shell 的 `set X=1&&` 串（Windows cmd 专有、且会和 `&&` 语义打架），
 * 而是在 Node 进程内设置后再动态 import 真正的入口。
 */

process.env.STUDIO_DISTRIBUTION ??= 'dev';

await import('./main');

// TS: 顶层 await 只允许出现在 **module** 里；本文件只有动态 import、没有静态 import/export
// → 必须显式标记为 module，否则 `tsc` 报 TS1375。空 export 无任何运行期副作用。
export {};
