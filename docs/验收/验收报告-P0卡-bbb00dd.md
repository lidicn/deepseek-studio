# 验收报告 · P0 卡（页面通道首启竞态）· `bbb00dd`（Verify，独立验收，2026-11-06）

> **声明**：不采信 Core/UI 自测，全部自己复现（cargo/tsc/窄面 自跑 + 读码 + 构负控 + 比哈希）。唯一可写域 = `docs/验收/`。脱敏：机器路径用相对。

## 0. 结论：**通过**（无 P0 卡代码缺陷）
13 件（代码 10 + 新增 3）全部核到码上、全绿。Core Rust 半 + UI 页端半 + 裁定三十八 4 条 appendTo + 裁定三十九 共用日志 + 裁定三十七① guard 注释 + 两枚 guard 负控 **真红**（非恒绿形状）。1 条我上轮误报的「host-down 未实现」经实读**撤销**（见 §6，非缺陷）。

## 1. 冻结清单（SHA256[:16] + mtime，验后比对）
13 项验后**全 `OK`**（零漂移）；`git status` 只剩 ` M AGENTS.md`（押着）：

| 文件 | SHA256[:16] | 验后 |
|---|---|---|
| `src-tauri/src/main.rs` | 11830BF38CCD39D3 | OK |
| `src-tauri/src/sidecar.rs` | D54429D17BC605B1 | OK |
| `src/desktop/entry.ts` | 99B348D1087D2339 | OK |
| `src/desktop/grant-acquire.ts` | 0EFF0D2893B5B163 | OK |
| `src/desktop/host-client.ts` | 1E2D6B26038DD707 | OK |
| `src/host/config-migration.ts` | D22576B704A32684 | OK |
| `src/host/desktop-host.ts` | 783D80DBCC7008AA | OK |
| `src/host/host-token.ts` | 32867AE700B006EC | OK |
| `tests/desktop/config-migration.test.ts` | 2F6CCB43A05F9823 | OK |
| `tests/desktop/config-write-guard.test.ts` | F11EACDF17DCF192 | OK |
| `tests/desktop/grant-acquire.test.ts` | A67A08E5198E5C8F | OK |
| `tests/desktop/jti-bounded.test.ts` | D28CC9A6276BD72A | OK |
| `src-tauri/inject/entry.js` | 1D83F607B3300D5E | OK |

## 2. 三闸读数（我亲跑 3 项 + 全量并集采信 PM 原文）
- `cargo test --manifest-path src-tauri/Cargo.toml` → **CARGO_EXIT=0，39 passed / 0 failed**（本笔改 `src-tauri/**`，我亲跑；`logs/verify-p0-cargo.log`）。
- `npx tsc --noEmit` → **TSC_EXIT=0**（我亲跑）。
- P0 窄面（P0 卡 4 直 test + 被触碰 UI 家族 8 枚：`jti-bounded`/`config-write-guard`/`config-migration`/`grant-acquire`/`host-client`×2/`desktop-entry`/`td02-bootstrap-grant`/`page-runtime`/`r2-01`/`r3-03`/`tool-bridge`）→ **VITEST_EXIT=0，Test Files 12 passed / Tests 103 passed / 0 skipped**（我亲跑；`logs/verify-p0-narrow.log`）。
- 全量并集 = **PM 第 12 次闸**（848.7s、12 阻塞全过、`entry-freshness`/`doc-drift`/`lineend-guard` PASS、vitest `267 files / 2816 passed | 1 skipped`、`cargo` 39 passed）——我没并行跑全量（OOM + 归因），采信 PM 原文。

## 3. 逐件核对（码上位置 + 结论）
- **裁定三十九 共用日志**（`main.rs:548-568 grant_log`）：优先 `sidecar::current_log_file()`、`.create(true).append(true)`（**只 O_APPEND、无 seek/定位/缓冲**）、失败退 `eprintln!` 不 panic；`sidecar.rs current_log_file` 暴露宿主那份 `sidecar-<ms>.log`。「取证单点」成立。
- **裁定四十 (B) 唯一入口**（`main.rs:577 resolve_config_dir`）：装版 `<app_data_dir>/config`、dev `~/.config/deepseek-studio`；全仓 `.join(".config")` 只余入口自身 + dev 分支 + 单测（符合修正口径）。
- **裁定三十八 B 子集 4 条 appendTo**（`config-migration.ts`）：`skipped-new-dir-missing:350` / `skipped-already-migrated:357` / `skipped-env-pair` 两处 `:464`(cfg 可解析才落)/`:475` / `failed:521`(走 `resolveFailureLogTarget`) 全落 `migration.log`；**2 条不可行 `no-new-dir:340`/`same-dir:344` 有意不落 + `:61-63` 注释写明「没处落、比不写更糟」**。✓
- **(A) `studio_request_grant`**（`main.rs:683`）：可辨识联合 `GrantReply`（`untagged`，成功 `{ok,grant,expMs}` / 失败 `{ok,error}`，无多余字段，单测 `:2322` serde 断言）；限流 key=`window.label()` + 1s 间隔 + 200 上限 + 触顶 `level=warn`；**已去建窗静态注入**（`grant_request_closure_script` 注入 `__studioRequestGrant`，单测 `:2349` 断 `!script.contains("__studioGrant")`）。
- **窗口销毁回收负控真断条目消失**（`main.rs:2305 grant_rate_entries_are_dropped_when_window_destroyed`）：`grant_rate_forget("bot:S1")` 后 `map.len` 2→1、`!contains_key("bot:S1")`、再取视为新窗口、不存在 label 不 panic。**不是只断 `size ≤ 上限`**。✓
- **jti-bounded `BoundedJtiSet`**（`host-token.ts` + test）：1024 硬上界（按最旧 `exp` 淘汰）+ 过期清扫（add 顺带 + `pruneExpired`）+ 触顶 `level=warn` 只告警一次；负控断**过期项真的消失**（`:28-33`）/ 触顶真的打日志（`:56-62`）。✓
- **`grant_log` `.append(true)` 静态守卫**（`config-write-guard.test.ts:196-267`）：`scanAppendOnlyWriter` 读真 `main.rs` `grant_log` 函数体，断含 `.append(true)` 且不含 `set_len`/`.seek(`/`metadata()`/`len()`；**定位写负控红（`:241`）+ `set_len` 负控红（`:255`）+ 正控通过 + 反假绿断言**。真读真源码、非恒绿。✓
- **UI `grant-acquire.ts`**：可辨识联合 `GrantReply`（`ok:true` 必有 grant/expMs、`ok:false` 必有 error，编译期挡「ok:true 无 data」）；`GRANT_BACKOFF_MS=[500,1000,2000,4000,8000]`；**只 `no-config` 可重试**；`rate-limited`/`no-secret`/`sign-failed`/`bad-aud`/`host-down` 一律停；**单飞**（`inFlight` Map，结算即摘除、不缓存）；**闭包缺失（dev）立即回落 attempts=0、零等待**；形状违反/闭包抛错 → `host-down` 停。✓
- **UI `host-client.ts`**：`connectWsRound` 每轮 `options.urlResolver ? await urlResolver() : options.url`（每轮新 URL、不复用死券，结构消 L2/H1）+ `roundActive` 防双发；**不传 resolver 走 `options.url` = 与改前逐位一致**（test 断）。✓
- **UI `entry.ts`**：`acquireGrant` 接线 + `onState` → 退避期「正在等待宿主就绪…」横幅 / 耗尽「宿主凭据不可用，agent 能力离线（原因：`<枚举>`）」横幅（各枚举不共用）/ dev `attempts===0` 不挂横幅（合法）；`hostAudience` 单源化。✓

## 4. 负控真红（两枚 guard + jti，都按「不是只写了个永远绿的形状」收）
- `config-write-guard`：假源码裸写→红（`:128-143`，批 1）+ **`.append(true)` 定位写/set_len→红（`:241/:255`，P0 卡）** + 反假绿（扫描集>100 + 必含写点）。
- `jti-bounded`：过期消失 / 触顶打日志 / size 有界（非只断上限）。
- `main.rs` 窗口销毁回收：条目真消失（`:2305`）。
- 我独立跑 窄面 12 files / 103 passed、cargo 39、tsc 0，全绿。

## 5. 我 验收到 P0 卡 判据 未覆盖、留给 v0.14.8 真机现场的（不在本 收口 判死活）
- **取券 IPC 往返 p50≤50/p95≤200ms + 端到端 `skill.list` 首次非空 ≤10s**（裁定四十二，须真机装版量）；
- **同一份 sidecar 日志 node `[page-runtime]` + Rust `[studio] grant:` 两类前缀共存、无丢行/交错/覆盖**（裁定三十九 残余推演「Rust+node 真配对无丢行 = 推断」的唯一实证机会）；
- **4 目录差集 + `window-state.json` 关窗 + `TVPilot` 闭环 + `example-filesystem` 归零**（v0.14.8 全新安装现场，靶 = 竞态）。
→ 这些进 v0.14.8 装版验收现场（裁定四十三 合并），不在 P0 卡 收口 判。

## 6. 我 上轮 误报 撤销 + 诚实记录
- **误报「host-down 未实现」**：实读 `grant-acquire.ts:27-33` 六枚举 type **完整**（含 host-down），`host-down` 由 UI 页端在「闭包抛错 / 返回形状违反」时**合成**（`:102/:108`，停、不重试）；Rust `studio_request_grant` 返 **5 真实枚举**（按需签发无 authority 路径、`host-down` N/A）。**「六枚举」在 UI 契约类型层满足，非缺陷**——我上轮按 Rust 侧数到 5 就报偏差，是分层没看全，撤回。
- 我 台账 §七 `:99`「六枚举」措辞不变（对 UI 契约正确）；我 台账 待补 §五/§七 的 v0.14.8 真机判据见本报告 §5。

## 7. 收口
P0 卡 `bbb00dd` **通过**、无代码缺陷。@Verify 台账同步（新 `docs:` 笔）：裁定四十二（`1s 假判据` → 取券 IPC p50/p95 + 端到端 ≤10s + 无可比基线 3 判据）、裁定四十三（v0.14.7 用户重启 决定性实验 取消，真机判据并 v0.14.8 装版现场）。v0.14.8 真机验收现场判据 = 本报告 §5 + 台账 §七。
