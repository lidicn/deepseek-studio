<!-- 历史快照：内引路径/行号为 2026-11-23 取证当时状态（HEAD 954b641），不作活锚 -->
# ㊿-c-补⑤ MCP 工具清单运行期刷新 · 真机复验报告（Verify 独立验收）

**批次**：㊿-c-补⑤（`main-world-interceptor.ts` MCP 工具清单运行期刷新——技能侧同族机制搬 MCP 面）
**结论**：**PASS**（四格真机＋全关子格全坐实；负控靶心命中；真树 SHA 未动）
**冻树**：HEAD `954b641715564ed0ee3d3ecd870f124c8dcad363`（commit `954b641`＝UI 交卷入库那笔），工作树 CLEAN
**产物双锚（判据基准＝bytes＋blob16，标对 HEAD 954b641 这版）**：`src-tauri/inject/entry.js` 482,231 B／blob16 `46590ebfbc26522b`；`src-tauri/host/main.mjs` 841,923 B／blob16 `801ce5f580ad81f8`（gitignored，git hash-object 现算）
**实测壳**：起窗脚本 `tauri:dev:isolated` 的 beforeDevCommand（build:inject＋start）＋cargo run 把 dev 壳**重编成 0.14.29**（24,179,712 B／mtime 15:01:05／FileVersion 0.14.29／devStringHit=1，identifier `com.deepseek.studio.dev`）；实际测的是**全量最新态**（新 entry.js＋dev-main.ts 宿主 8761＋0.14.29 壳）。预冻结那枚 0.14.24 壳（24,232,448 B／e3000c60）被本次重编替换，如实注记。
**实机驱动**：dev 窗 appPid=23508（8761＋9222 与装版 8760 并行）；装版 28260/宿主 31264 全程零碰；WS（8761）toggle＋mcp.list，CDP（9222）真实发送抓 `/api/v0/chat/completion` 请求体；驱动 `logs/verify-mcprefresh-live.mjs`／`-live2.mjs`，证据 `logs/verify-mcprefresh-live.json`／`-live2.json`。

## 1. 缺陷与机制（我现读，行号为当时盘）
`main-world-interceptor.ts` 此前 MCP 工具清单只在启动 IIFE 拉一次（`mcp-tools-init`），之后 `currentMcpTools`（约第 469 行模块级私有）永不刷新。本批把技能侧同族机制（TTL＋发送点 kick＋打字预热＋in-flight 复用＋成功才更新）同构搬到 MCP 面：
- 状态块＋函数组约第 666-787 行：`MCP_TOOLS_TTL_MS=5_000`（L666）、`MCP_WAIT_BUDGET_MS=150`（L667）、预热 `600ms` 静默＋`2_000ms` 冷却（L668-669）、`refreshMcpToolsOnce`（L725-760，in-flight 复用＋成功更新含空清单＋失败保留旧清单记 `mcpToolsLastError` 不抛）、`kickMcpToolsRefresh`（L766-770，`isMcpToolsFresh()` L711-719 判 -Infinity 与 TTL 内）、`scheduleMcpToolsPrewarm`（L777-787）。
- 发送点 kick 约第 2504 行 `const mcpWait = isChat && !inFirstAttemptResend ? kickMcpToolsRefresh() : null;`（与技能 kick 同一处），预算并入 `Promise.all`（约第 2585-2588 行 `raceBudget(mcpWait, MCP_WAIT_BUDGET_MS)`）。
- IIFE 双戳约第 4159 / 4170 行（首拉成功＋空清单「已知态」各戳一次共享新鲜度时间戳），预热监听约第 4216 行（`scheduleMcpToolsPrewarm` 与技能同 input 监听）。
- 注入块构建：`buildCapabilityPrompt`（约第 1740 行）拼 `formatMcpToolsBlock`（约第 1616 行，`currentMcpTools.length===0` 时约第 1617 行返 ''），进入真实发送请求体。

宿主侧：`mcp.list` 走 `listEnabledServerIds()`（`mcp-controller.ts` 约第 1013 行），`enabled:false` 的服务器对模型面整体不可见；`mcp.enabled.set` 写盘后 `controller.reload()` ⇒ 注入层重拉即得正确清单。宿主面无缺陷（本轮只改注入层，Core 零动作坐实）。

## 2. 四格真机（CDP 抓真实 `/chat/completion` 请求体，不拿单测冒充）
基线（WS `mcp.list`，两 server 全开）：回 **69 枚**（TVPilot 30＋AutoForge 39）；`mcp.listAll` 两 server 均 `enabled=true`。canary：`tv_*`=TVPilot 工具在否、`af_*`=AutoForge 工具在否；块标记 `## 已配置的 MCP 工具`。

| 时刻（ms） | 场景 | 请求体 len | 块标记 | tv_* | af_* | 判定 |
|---|---|---|---|---|---|---|
| P1 2743 | 双开基线 | 4808 | 有 | 29 | 41 | 两 server 工具都在 |
| **P2a 5834** | **关 TVPilot 后 TTL 内**（gap P2a-P1=3091ms<5s） | 4808 | 有 | **29（仍在）** | 41 | **格②核心：TTL 内缓存未刷新，宿主已 39 但页面仍带 tv_*** |
| **P2b 14362** | **过期后**（gap P2b-P2a=8528ms>5s） | 4822 | 有 | **0（消失）** | 40 | 格①关⇒消失＋格②过期后重拉 |
| P3 24079 | 开回 TVPilot | 4808 | 有 | 29 | 41 | 格①开⇒恢复 |

WS `mcp.list` 追踪与请求体一致：双开 69 → 关 TVPilot 39（`byServer={AutoForge:39}`）→ 开回 69。

**格②「TTL 内不重拉」的行为证明**：P2a 距 P1 刷新仅 3091ms（<5s TTL），宿主侧已 `mcp.list=39`（TVPilot 关），但**请求体仍带 29 枚 tv_*** ⇒ 页面复用 `currentMcpTools` 缓存、TTL 内不重发 mcp.list；到 P2b（8528ms>5s）页面过期重拉、tv_* 消失。这个「stale→fresh」转变就是 TTL 边界。（宿主日志只在启动 init 与刷新**失败**时打 `mcp tools...`，成功刷新静默，故格②以请求体内容转变证，非裸计数。）

**格①「全关⇒整块消失」子格**（`-live2`）：双关（TVPilot＋AutoForge）⇒ `mcp.list` 回 0 ⇒ `formatMcpToolsBlock`（约 L1617 空清单返 ''）⇒ 请求体 **hasMarker=false、tv_*=0、af_*=0**，len 由 ~4800 掉到 3225（块整段被抽走）。开回即复。

**格③「不阻塞发送」**（分层，如实注层级）：代码侧 `raceBudget(mcpWait,150ms)`（约 L2585-2588）＋in-flight 复用（L725-760）坐实有界等待；真机侧四次真实发送**全部发出且请求体被抓到**（无一条被卡住／丢弃）。精确 150ms 超时路径需宿主延迟注入才强触发，本轮未强制，按代码＋「四条真发均完成」合证，不冒充全层完成。

**格④「失败不假清空」**（分层，如实注层级）：代码侧 `refreshMcpToolsOnce` 失败分支（约 L738-748）置 `mcpToolsLastError`、`currentMcpTools` 不动、不抛（对齐技能 `skillsLastError`）；真机强制宿主拒 mcp.list 会破坏在跑的 dev 宿主（不可取），故以代码＋负控＋单测④合证，不冒充全层完成。

## 3. 独立窄面（我侧现跑，非 UI 自测）
`npx vitest run tests/desktop/mcp-tools-refresh.test.ts`＝**5/5 passed EXIT=0**（日志里 `mcp-stub-fail` 是测试④失败用例的预期打印）；`npx tsc --noEmit`＝**EXIT=0**。（全量闸归 PM，我零全量。）

## 4. 负控（仓外副本树 `E:\NAS\negctl-v01429-mcprefresh`，全绝对路径＋node_modules junction）
- 未变异干跑：**5/5 绿**。
- 单点变异（只改副本）：摘发送点 kick（副本约 L2504 `mcpWait=null;`，真树原样未动）⇒ **②红（`expected 1 to be 2`＝mcp.list 未涨、旧清单仍注入，靶心命中）＋③④红**（皆依赖发送点那次 refresh），①⑤绿；EXIT=1（3 failed/2 passed）。⑤绿是因预热（约 L4216）走 `kickMcpToolsRefresh` 独立于发送点 kick。
- **两道证**：① 变异目标 vs 真实现 SHA 对照——真树 `main-world-interceptor.ts` blob16 `0cbd17f33946c6c1`（＝UI 交卷锚，逐字未动），副本变异后 `584f25ab780e01b6`（已变）；② 退出码与输出同读（干跑 EXIT=0 5/5，变异 EXIT=1 ②③④红）。真树 `git status --porcelain` 空（零业务改动）。

## 5. 收尾与纪律
dev 配置根 `~/.config/deepseek-studio`：`mcp-servers.json` 收尾单步写回复同 **SHA `2D5E191FF9459140`**（477 B 基线，两 server 全开、0 枚 `enabled:false`、AutoForge Bearer 凭据金丝雀 intact，凭据值未落证据）；`config.json` 未触碰（SHA `C6B5F30A8E8E2606` 复同）。装版资源目录零碰、零拷开发树产物。未做 commit/push。

## 6. 收工四项
① `deepseek-studio.exe`＝**1**（装版 28260，我的 dev 壳 23508 已退）；② 命令行含 `host\main.mjs` 的宿主 node＝**1**（装版 31264），dev 宿主 `dev-main.ts`＝**0**（已收净）；③ 8760＝True（装版持有，预期）／8761＝False／9222＝False；④ sidecar 根：装版根目录 mtime 01:34:54（未再前进）、最新装版 sidecar 文件 13:20:01（`sidecar-1795368894381.log`，非我测试时段写入）、dev 根 `~/.config/deepseek-studio/logs` absent（历批同）。

## 7. 验收席自认清单（如实记录自己犯的错）
① **live 首跑 P2a 时序错**：`doSend` 抓包等满 2.5s，加上 toggle 后 1200ms，P2a 距 P1 刷新已 >5s（TTL 已过期）⇒ 首跑 P2a 就 refresh 了（tv_*=0），**没证到「TTL 内 stale」**。当场自纠：抓包改「见 marker 即断」＋toggle 后 sleep 降到 500ms ⇒ 重跑 P2a gap=3091ms<5s 落 TTL 内、stale 坐实。真树未污染（只改驱动脚本）。
② **live2 脚本 `const captured` 误写**：声明成 const 又赋 `captured=[]` ⇒ 第 44 行崩溃，且崩在「开回双 server」之前 ⇒ 双 server 被留在全关态、配置漂成 `2E9ED387`。当场自纠（const→let）＋手动单步写回复基线（2D5E191F）＋重跑。
③ **格③④层级**：未强触发 150ms 超时路径与宿主拒 mcp.list（破坏在跑 dev 宿主／需宿主延迟注入），按代码＋负控＋单测合证并明示「不冒充全层完成」，同 ①b 分层口径。
④ **起窗触发 dev 壳重编**：`tauri:dev:isolated` 的 beforeDevCommand＋cargo 把 dev 壳从 0.14.24 重编成 0.14.29（预冻结的五值作废），已按实测 0.14.29 壳报五值，未续用历史锚。
