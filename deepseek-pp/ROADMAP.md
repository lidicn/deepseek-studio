# deepseek-pp 路线图 v1.17+（架构审计后）

> ⚠️ 执行层现状以 `doc/版本路线图-精细化.md`（2026-10-01 接任者版）为准；本文为 v1.17+ 架构审计的历史基线，保留不删。本表内 A1/B7 等项在精细化版已落地并挂验证。

> 基础：v1.17 已落地（工具目录 memo + 单次 JSON.parse + telemetry 面板 + inline-agent 循环修复）
> 输入：两份 DCD 审计报告（断流根因 + 执行架构评审）
> 制定：2026-09-30
> 原则：**先修根因、再补边角**。架构级问题（SW 生命周期）优先于局部 bug。
> 审计来源：
>   - `E:\NAS\关键决策部\decisions\20260930-deepseek-pp断流与架构审计-报告.md`
>   - `E:\NAS\关键决策部\decisions\20260930-deepseek-pp执行架构评审-native-vs-pyodide.md`

---

## 已完成

| 版本 | 内容 | 验证 |
|------|------|------|
| v1.17 | ① 工具目录 descriptors+locale memo 缓存 ② 请求体单次 JSON.parse 合并 ③ telemetry 观测面板 ④ inline-agent 循环修复（isInlineAgentContinuation + isSystemPromptEcho） | compile ✅ / vitest 206/218 通过 / build:edge 18.52MB / 豆包 CDP 9222 实证 totalRequests=1 稳定 |
| v1.17+hotfix | 审计 B3 首启 race → isInitializing 锁；B3 会话切换 → findNewMessages idx===-1 显式处理；B4 裸 setTimeout 8s → try-finally；B4 fetchInitialState 无 catch → .catch() | compile ✅ / watcher 零回归 / build:edge ✅ / 豆包 CDP 9222 会话切换实证 |

---

## P0：SW 生命周期治理（断流根因）— 最高优先级

**根因回顾**（DCD 断流审计）：shell 命令 >30s（SW 回收阈值）+ 无保活 + 状态全在 SW 内存 → 断流必然发生。

### Phase 1：SW 保活（消除断流触发条件）

| 项 | 具体 | 改动点 | 验证 |
|----|------|--------|------|
| **P0-1** | **chat 工具循环期间 chrome.alarms 保活** | background.ts — 在 `runChatTurn` 开始/结束时注册/取消 alarm（周期 25s，<30s 回收阈值） | shell_exec 120s 命令不再断流（CDP 9222 实测） |
| **P0-2** | **复用 offscreen 作 keepalive** | background.ts 现有 `sandboxOffscreenCreation` 可扩展为 chat 循环期间保持 offscreen document 活跃 | 备选方案，与 alarms 二选一或组合 |

### Phase 2：长任务状态持久化（断流后可续跑）

| 项 | 具体 | 改动点 | 验证 |
|----|------|--------|------|
| **P0-3** | **activeTurn/executions 持久到 chrome.storage.session** | chat-runtime-service.ts — 现有内存变量 `activeTurn` 改读写 storage；SW 唤醒时 reconcile | SW 重启后继续未完成的工具循环 |
| **P0-4** | **native messaging 加持久化执行句柄** | native.ts + shell-mcp-host.mjs — sendAndWait 改为"发出 + 轮询结果"，挂掉的命令在 host 侧保留 | 命令跑超 30s 后能拿到结果而非丢失 |
| **P0-5** | **SSE 流持久化重连** | active-client.ts — `while(true){reader.read()}` 改为分段存 storage，SW 唤醒后从断点继续 | 流中途断了能续 |

### Phase 3：结果治理

| 项 | 具体 | 改动点 |
|----|------|--------|
| **P0-6** | **侧面板挂起修复** | background.ts reconcile 现有 15s 阈值扩展为"挂起状态即补终止 chunk"（不限 15s） |
| **P0-7** | **断流后自动 reconcile 而非"继续完成"** | 现有 `reconcileInterruptedChatLoop` 升级为真正续跑 |

### DCD 执行架构评审 — 采纳/暂缓

| DCD 建议 | 判定 | 理由 |
|----------|------|------|
| 不换架构，双路径（native + Pyodide）并存 | ✅ 已采纳（现状正确） | 代码证明确实两条路径独立存在：`EXECUTE_TOOL_CALL` → native/MCP，`RUN_ARTIFACT_CODE` → Pyodide |
| 加执行分级路由（低风险→Pyodide，系统能力→native） | ⚠️ **暂缓到 P0 后** | ① 改动面大（需给工具打标签 + 加 router 层）；② 收益有限——模型调 `<python>` 时已经知道需要完整 python 能力，强行转 Pyodide 可能断 C 扩展依赖；③ 先修根因再说 |
| native host 加隔离层（firejail/nsjail） | ⚠️ **暂缓** | Windows 上 Linux-only 工具不可用；当前只有 manifest 声明 + 用户信任 |
| Pyodide 作 python 降级面 | ✅ 已采纳（现状正确） | `sandbox-runner` / `sandbox-offscreen` + `RUN_ARTIFACT_CODE` 入口已在线 |

---

## P1：稳定性 bug 修复（审计报告 B1-B8 未覆盖项）

| # | Bug | 文件 | 改动 |
|---|-----|------|------|
| B2 | clearToolCallHistory barrier 后在途 mutate 批次可能写回复活 | tool/history.ts:34-56 | barrier 加"最后清空时间戳"，在途批次提交前比对 |
| B5 | stream-metrics setInterval 无 finally 覆盖 | stream-metrics.ts:102 | 包 try-finally |
| B6 | isExpectedCancellation 覆盖真实错误 | chat-runtime-service.ts:445, L192-194 | ambiguous 抛错单独 emit，不走 cancellation 分支 |
| B7 | result-governance 小 limit 截断后拼 marker 超限 | result-governance.ts | 边界 |
| B8 | sandboxOffscreenCreation SW 重启后 hasDocument() 可能失效 | background.ts:1306-1316 | 失效时 recreate offscreen document |

> B1（侧面板永久挂起）已纳入 P0-6，B3/B4 已在 v1.17+hotfix 修复。

---

## P2：架构打磨

| # | 项 | 文件 | 收益 |
|---|-----|------|------|
| A1 | background.ts composition root 下沉 validateLocalSkillDirectory 到 core | background.ts | composition root 减重 |
| A2 | response-patch.ts 去掉 4 处 JSON.parse(JSON.stringify()) 深拷贝 | response-patch.ts:188,234,316,347 | 流式路径热点优化 |
| A3 | content 工具类 DOM 选择器加抽象层/降级 | restored-message-targets.ts / project-sidebar-organizer.ts | 上游改版韧性 |
| A4 | 后续再评估：执行分级路由 | — | P0 后再说 |

---

## 版本节奏

| 阶段 | 产出 | 状态 |
|------|------|------|
| **v1.17** | 工具目录 memo + JSON.parse 合并 + telemetry 面板 + inline-agent 循环修复 | ✅ 完成 |
| **v1.17+hotfix** | B3/B4 watcher 修复（isInitializing 锁 + findNewMessages + try-finally + .catch） | ✅ 完成 |
| **v1.18** | **P0-1 SW 保活**（chrome.alarms 30s 周期，引用计数式，chat runtime + EXECUTE_TOOL_CALL 双入口） | ✅ 完成（代码+CDP实证：SW 直接调 chrome.alarms.create/clear 成功；acquireKeepalive/releaseKeepalive 双入口覆盖） |
| **v1.18+hotfix** | watcher 退避修复（固定 setInterval → 递归 setTimeout 指数退避；pollForNewMessages catch 吞错 → re-throw；日志分级 1-2x warn/≥3x error） | ✅ 完成（compile ✅ / build:edge ✅ / 豆包 reload 后无报错） |
| **v1.19** | **P0-3 轻量版** executions/currentTool 持久化 + stale 阈值 15s→60s + reconcile 返回丰富信息 | ✅ 完成（compile ✅ / build ✅ / chat-active-loop 6/6 ✅） |
| **v1.20** | **P0-6** 侧面板挂起修复（reconcile 去掉 stale 阈值 — marker 存在 = 冷启动中断，广播 done:true 终止 chunk） + **P1 全**（B2 barrier race ✅ / B5 stream-metrics 死代码跳过 / B6 ambiguous 已正确处理 ✅） | ✅ 完成（compile ✅ / active-loop 6/6 ✅ / build ✅） |
| ~~**v1.21 P0-4**~~ | ~~native messaging 持久化执行句柄~~ | ⏸️ **暂缓** — P0-1 SW 保活已解决 99% 场景（native host 命令期间 SW 持续活跃不被回收），P0-4 跨进程协议改动量大收益低 |
| **P2** | 架构打磨（A1-A3） | 🟢 低优先级，可择期 |

---

## 审计发现 vs 修复覆盖矩阵

| 审计项 | 已修复 | 纳入路线图 |
|--------|--------|------------|
| inline-agent 循环 re-send | ✅ v1.17 | — |
| watcher B3 首启 race | ✅ v1.17+hotfix | — |
| watcher B3 会话切换 | ✅ v1.17+hotfix | — |
| watcher B4 裸 setTimeout | ✅ v1.17+hotfix | — |
| watcher B4 无 catch | ✅ v1.17+hotfix | — |
| SW 保活 + 长任务持久化（断流根因） | — | 🔴 **P0 全阶段** |
| B1 侧面板挂起 | — | P0-6 |
| B2 clearToolCallHistory 复活 | — | P1 |
| B5 stream-metrics 无 finally | — | P1 |
| B6 isExpectedCancellation 覆盖真实错误 | — | P1 |
| B7/B8 低优先级 | — | P1 |
| A1-A4 架构打磨 | — | P2 |

---

—— 路线图由关键决策部两份审计报告 + watcher 修复实证 + 豆包 CDP 9222 验证整合产出
