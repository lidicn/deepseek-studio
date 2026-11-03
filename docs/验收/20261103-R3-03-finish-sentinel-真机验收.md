# R3-03 finish-sentinel 端到端真机验收（Verify · 2026-11-03）

> 执行者：Verify（独立验收）｜窗口：PM 放窗（实例 appPid **2732**，15:52:56 起）
> 依据卡：PM「正常轮不误报 / 真断流 interrupted+500 / 空流不发，三态都要留页侧 `sawFinishSentinel` + 宿主 `completion` 成对读数」
> 被测物：HEAD `ad2fb89`、`b2bbd0e`（R3-03 页端上报）；注入产物 `src-tauri\inject\entry.js` = `src-tauri\target\debug\inject\entry.js` **428,258 B / `C5C97F642FCA859E…`**（两处一致，`finish-sentinel` 命中 **1**）
> 纪律：不改 `src/**`、不 commit/push、不跑全量 gate；产物只落 `docs/验收/` + `logs/verify-r303/`。

---

## 0. 结论

**三态全过（PASS）**。`interrupted` 终态由「死代码」变「可达」：真断流时页端报 `sawFinishSentinel=false` → 宿主 `wait-end completion=interrupted` → 任务层 `requireTaskLoopReply` 抛 → **HTTP 500 `task loop returned no successful reply (interrupted)`**；正常轮不误报、空流不发 false。

| 轮 | 形态 | HTTP | 页侧 `sawFinishSentinel` | 宿主 `completion` | 判据 |
|---|---|---|---|---|---|
| **A-normal** | 正常流（无拦截） | **200** | send-end `=true`；wait-end `=undefined` | `complete` | ✅ 不误报 interrupted |
| **B-no-sentinel** | 真断流（CDP 删 FINISHED+close 共 3 行） | **500** | wait-end `=false` | `wait-end interrupted` | ✅ interrupted + 500 `(interrupted)` |
| **C-empty-stream** | 空流（回放 0 字节） | **200** | 全程 `undefined` | `complete` | ✅ 不误报 false（空流不发） |

**verdict（`logs/verify-r303/r303-e2e.json`，16:01:02 落盘，六项全 true）：**
`A_complete=true, A_notInterrupted=true, B_interrupted=true, B_http500Interrupted=true, C_notFalse=true`。

### 成对读数（原文）
- **B 宿主侧**：`[web-engine][path] wait-end completion=interrupted elapsedMs=4838 contentLen=439 sawFinishSentinel=false`
- **B 任务层**：`body={"ok":false,"error":"task loop returned no successful reply (interrupted)"}`
- **B 断流有效性**：`fulfill removedLines=3, origHasFinished=true, strippedHasFinished=false`（哨兵帧确实被删，非假断流）
- **A 宿主侧**：`send-end completion=complete … sawFinishSentinel=true`（正常轮页端确实看到哨兵 → 报 true）
- **C 宿主侧**：`send-end/wait-end completion=complete … sawFinishSentinel=undefined`（空流 0 字节，页端按设计**不发**）

---

## 1. 实现链（只读核对，非我改动）
`main-world-interceptor.ts:684 emitFinishSentinelOnTurnEnd()`（`turn.end` 公共汇聚点，按轮一次、空流不发）→ `entry.ts:337 host.finishSentinel(round, saw)` → `host-client.ts:415 send({type:'finish-sentinel',round,sawFinishSentinel})` → 宿主 `page-runtime.ts:443`（按 botId 记 `finishSentinels`）→ `web-engine.ts decideCompletion`（`sawFinishSentinel===false` + 有可见输出 ⇒ `interrupted`）。

## 2. 现场勘误（如实记录）
- **有效读数 = 16:01:02 的 `r303-e2e.json`**（实例 2732 在线时跑的）。
- **16:44:35 的 `r303-e2e.log` 是无效重跑**：实例 2732 的主进程在此之前已被**外部**终止（sidecar 尾部 `[deepseek-studio] 父进程 2732 消失，孤儿防护触发 self-exit`），该重跑首行即 `ECONNREFUSED 9222`，未产生新 JSON，不影响 16:01 的有效结论。
- **实例 2732 的退出方式**：主进程外部终止（时间窗 16:41:51→16:44:35 之间，与 Core 重新打包/退出兜底测试重叠）+ sidecar 孤儿防护自退；**非我 `CloseMainWindow` 收口**。

## 3. 残留复核（收工三件套）
| 项 | 值 |
|---|---|
| Studio 进程 | **0** |
| 端口 8760 / 9222 | **free（0 / 0）** |
| Studio 专属 webview2（按命令行 `deepseek-studio` / `com.deepseek.studio` 归属） | **0**（基线 0、退出后 0；其余 webview2 属 WeType/GameViewer/magpie/搜索，未动） |

## 4. 工作树声明（不是我改的）
当前 `git status` 的 7 处改动 + 1 处未跟踪（`sidecar.rs`、`config-loader.ts`、`untrusted-memory.ts`、`untrusted-memory.test.ts`、`src-tauri/inject/entry.js`、`docs/验收/安装包用户视角验收.md`、`docs/验收报告/TD-修复台账.md`、`?? tests/desktop/td07-parse-port.test.ts`）均**非 Verify 产出**（属并行会话 / Core 退出兜底 + 重新打包 / untrusted-memory 卡）。我全程**只读 `src/**`、零改动、零提交**。
> 附注：树里 `src-tauri/inject/entry.js` 现被并行会话重建过（我 15:58 快照指纹 `C5C97F64…` 已非当前树内容）；本验收针对的是**当时运行在实例 2732 里的那份 bundle**（含 `finish-sentinel`，命中 1），结论对「`b2bbd0e` 页端上报可用」有效。

## 5. 未执行 / 待办（不记通过）
- **step7 复跑（长会话 + 关窗）**：等 Core 出含 `26e75ab` 的新安装包（放新目录）+ PM 放窗；届时**只复跑 step7**，不重跑 8 步。
- 本次未跑 `npx tsc --noEmit`（PM 明确不跑全量 gate；本卡未改任何代码，无需编译自证）。

---

## 交付
- 证据：`logs/verify-r303/r303-e2e.json`（有效）/ `r303-e2e.log`（16:44 无效重跑，勘误在 §2）/ `r303-e2e.mjs`（脚本）
- 报告：`docs/验收/20261103-R3-03-finish-sentinel-真机验收.md`（本文件）
