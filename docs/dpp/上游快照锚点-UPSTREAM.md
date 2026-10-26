# 上游快照（deepseek-pp）

本目录是 `E:\NAS\deepseek-pp\src` 的**单向只读快照**，作为 DeepSeek++ Studio 的复用源。

| 项 | 值 |
|----|----|
| 上游仓库 | `E:\NAS\deepseek-pp`（MV3 浏览器扩展，WXT + React + TS） |
| 快照 commit | `187f6227e1fed07405c0802374b69c16e29eb6e2`（2026-10-08） |
| 上游版本 | `package.json` → 1.16.0 |
| 拷贝方式 | `robocopy E:\NAS\deepseek-pp\src → E:\NAS\deepseek-studio\deepseek-pp\src /E /XD node_modules dist .git videos .github .wxt` |
| 拷贝规模 | 1,133 文件 / 12.96 MB |

## 包含

- `core/**`（49k 行，零修改复用的主体）
- `entrypoints/**`（content.ts / main-world.content.ts / background.ts / sidepanel / sandbox-*）
- `public/**`（含 `deepseek/sha3_wasm_bg.wasm`、图标、`_locales`）
- `packages/**`（shell-host、multimodal 等原生宿主包）
- `scripts/**`（含 `prompt-freeze.mjs`，prompt-bytes 不变量的守门脚本）
- `tests/**`（273 文件，含 golden fixtures 与契约测试）
- `docs/**`、`AGENTS.md`、`package.json`、`wxt.config.ts`、`tsconfig.json`、`vitest.config.ts`、`package-lock.json`

## 排除

| 路径 | 理由 |
|------|------|
| `node_modules/` | 263 MB，Studio 侧自行 `npm i` |
| `dist/` | 111 MB，WXT 构建产物 |
| `.git/` | 41 MB，上游历史不随快照走 |
| `videos/` | 35 MB，测试媒体素材 |
| `.github/` `.wxt/` | CI 与 WXT 缓存，与桌面构建无关 |

## 约定

1. **`core/**` 与 `entrypoints/content*.ts` 在本仓库内零修改**；需要改动时改上游，或改 Studio 自己的 `src/**` 适配层。
2. 本目录不是 submodule，是拷贝快照；重新同步用同一条 robocopy 命令（覆盖式，本地改动会被覆盖，故第 1 条必须遵守）。
3. `AGENTS.md` 内的架构不变量（prompt bytes、storage key、runtime message 名、工具授权路径）对 Studio 同样生效。
