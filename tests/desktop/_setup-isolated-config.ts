/**
 * tests/desktop/_setup-isolated-config.ts — per-file setupFiles
 *
 * 默认把 STUDIO_CONFIG_DIR 指向一个临时目录，避免 createDesktopHost().start() 链
 * 写入真实 ~/.config/deepseek-studio（用户配置目录污染）。
 *
 * 根因：desktop-host.start() → ensureMcpConfig()（mcp-controller.ts:321）与 memory-store
 * （memory-store.ts:147）都读 STUDIO_CONFIG_DIR，缺省回落到 ~/.config/deepseek-studio。
 * 一批 host.start() 集成测试未设 env → start() 即写真目录（mcp-servers.json 含
 * example-filesystem fixture、memories.db、memories.db.audit.key、shadow/）。
 *
 * 仅在 env 未显式设置时注入；显式测试 env 缺失/覆盖/回落的用例自行 delete/set/restore，不受影响。
 *
 * **形态（2026-11-06 PM 裁定② 后补）**：vitest 不经 Rust 启动，`STUDIO_DISTRIBUTION`
 * 没人注入 → 会落进 fail-safe `installed` → **dev 行为被切走**（技能目录不再命中
 * `~/.agents/skills`、`ensureMcpConfig` 不再写示例）。原则是「**谁启动它，谁告诉它形态**」：
 * 测试脚手架属于 dev 启动方，因此在这里显式声明 `dev`（仍只在未设时注入）。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

if (!process.env.STUDIO_CONFIG_DIR) {
  process.env.STUDIO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cfg-iso-'));
}

if (!process.env.STUDIO_DISTRIBUTION) {
  process.env.STUDIO_DISTRIBUTION = 'dev';
}
