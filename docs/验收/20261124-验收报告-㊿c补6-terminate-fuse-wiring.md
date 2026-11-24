<!-- 历史快照：内引路径/行号为 2026-11-24 取证当时状态（HEAD 208cdad / 修复在 f9cfeab），不作活锚 -->
# ㊿-c-补⑥ terminate 透传断链＋熔断判定面 · 真机复验报告（Verify 独立验收）

**批次**：㊿-c-补⑥（`main-world-interceptor.ts` 两处接线修复：缺陷一 terminate 随 `PendingResult` 透传、缺陷二 熔断判定面从 `pending` 切到 `collectedExecutions`）
**结论**：**机制修复坐实（单位＋负控定论、宿主 terminate 前置坐实、真机 135-空转未复现）；真机未干净逼出熔断可见交代（model 配合/早停）——归因已如实标注、报 PM 建议出资人侧目检**
**冻树**：HEAD `208cdad`（v0.14.31，`f9cfeab` 修复的抬号批），工作树 CLEAN
**产物双锚（判据基准＝bytes＋blob16，标对 HEAD 208cdad 这版）**：`entry.js` 482,376 B／blob16 `ead9cdb04082cb55`；`main-world-interceptor.ts` 248,355 B／blob16 `4ada0a33c5dbecd1`；`terminal-fuse-wiring.test.ts` 17,555 B／blob16 `d364d9663cc5665a`
**实测壳**：dev 壳重编成 0.14.31（24,179,712 B／devStringHit=1，identifier `com.deepseek.studio.dev`）；实机＝新 entry.js＋dev-main.ts 宿主 8761＋0.14.31 壳全量最新态。appPid=30332，装版 28244 全程零碰（8760 装版持有）。

## 1. 修复机制（我现读，行号当时盘）
- **缺陷一（terminate 断链）**：success 支 `pr` 构造约 L3281-3290 补 `terminate: r.terminate`（约 L3289，㊿-c-补⑥ 注释在案）；`pending.push(pr)`（约 L3291）与 `collectedExecutions.push(pr)`（约 L3292）同源。reject 支（约 L3322-3326）**不带** terminate（传输层可重试，符合卡面）。折叠回执（约 L3150）带 `terminate: true`（`duplicate-tool-signature` 终局码）。
- **缺陷二（判定面）**：`scheduleAutoContinue`（约 L3348）熔断判定面从 `pending` 切到**当前轮累积 `collectedExecutions`**（约 L3363-3368，按 `currentSessionForExec` 过滤，口径与续跑 prompt 约 L3718-3719 一致）；`pending` 每轮 L1957 清零是根因（模型一轮常只 1 枚 memory_save ⇒ `pending` 桶恒 1 ⇒ `TERMINAL_FUSE_THRESHOLD=3` 永不达）。
- **terminate 闸门**（约 L3407-3422）：`pendingResults = pending.map(p => ({ terminate: p.terminate }))`（约 L3411，读 `p.terminate` 非 `p.result`）→ `shouldSkipAutoContinue`（`every` 语义）→ 命中则 `console.log('[autoContinue] skipped by terminate')`（约 L3413）＋`finishStepFlow`＋`turn.end stopReason=terminate`。
- **熔断**：`evaluateTerminalFuse`（`continuation-prompt.ts` 约 L458，`if (b.count < 3) continue` ⇒ ≥3 触发）→ 命中 `finishStepFlow` 可见交代（terminal 轴「这条不会再重试」约 L3394）＋`turn.end stopReason=fuse-terminal`。

## 2. 宿主侧前置（格A/B 前置，WS 8761 现探）
- `memory_save`（裸 WS，无 user-turn）⇒ `ok=false, error=memory-save-no-user-turn, terminate=true`（终局码＋宿主 `withTerminalSignal` 出口带 terminate）⇒ **格A 前置坐实**：宿主确实在终局拒绝上回 `terminate`。
- `mcp.list`／`mcp_list` ⇒ `ok=true, total=69`（TVPilot 30＋AutoForge 39）⇒ **格B 宿主面坐实**：mcp_list 正常可调、非终局工具不被熔断计入（`evaluateTerminalFuse` 只吃 `bucketTerminalDenials`＝终局拒绝，成功调用不计）。

## 3. 真机（CDP 9222 真实会话＋宿主 8761 日志＋storage.json）
**格A 不空转**：
- 首次「3× memory_save（保存记忆）」⇒ model 调 t1/t2/t3 均 `memory-save-needs-explicit-instruction` 拒绝（ok=false），**auto-continue 停在 hadTools=false 自然收（loop end），memory_save 全批仅 6 次（非 135）** ⇒ **出资人报的 3 分钟 135 连拒空转未复现**。
- storage.json 现读：后期终局拒绝均带 `terminate=true`（早期 `terminate=null` 是历史 session），坐实宿主出口在真会话里也回 terminate。
- **如实归因（报 PM）**：宿主 stdout 无 `auto-continue fuse terminal`/`[autoContinue] skipped by terminate` 行、聊天 DOM 无「不会再重试」等可见交代文案——我强触（6×「保存记忆」被宿主接受 ok=true／4× task-snapshot 只调 1 次）始终没能干净逼出「同 user turn 内 3 枚同 (tool,码) 终局拒绝累积到熔断」的可见交代，model 反复配合（自述「一轮只调一个工具」）或提前停。**真机未观测到熔断 notice 触发**；该机制改由单位＋负控定论（§4/§5）。

**格B mcp_list 正常调**：
- 宿主面 `mcp.list`/`mcp_list` 回 69（§2）；**如实归因**：三发 CDP 提示里 model 把 mcp_list 误调成 memory_save（0 枚真实 mcp_list 模型调用），属 model 行为非代码缺陷；「mcp_list 不被熔断误伤」由代码（熔断只计终局拒绝）＋单位证，不由真机 model 调用证。

## 4. 独立窄面（我侧现跑，非 UI 自测）
`npx vitest run tests/desktop/terminal-fuse-wiring.test.ts`＝**6/6 passed EXIT=0**（3 枚既有回归＋3 枚新格①单轮全 terminate⇒闸门收掉／②跨轮累积 3⇒熔断／③未达 3 不熔断）；`npx vitest run tests/desktop/failure-classification.test.ts`＝**49/49 EXIT=0**；`npx tsc --noEmit`＝**EXIT=0**。（全量闸归 PM，我零全量。）

## 5. 负控（仓外副本树 `E:\NAS\negctl-v01431-fuse6`，全绝对路径＋node_modules junction）
未变异干跑 **6/6 绿**。两处单点变异（各自独立、只改副本）：
- **变异A（格A①）**：摘 success 支 terminate 透传（副本约 L3289 `terminate: r.terminate`→`undefined`）⇒ **①「单轮全 terminate⇒闸门收掉」红**（`expected Array(2) length 1 but got 2`），②③＋3 回归绿；1 failed/5 passed。
- **变异B（格A②）**：判定面改回 `pending`（副本约 L3365-3367 `collectedExecutions`→`pending`）⇒ **②「跨轮累积 3⇒熔断」红**（`expected undefined to be defined`，约 L355），①③＋3 回归绿；1 failed/5 passed。
- **两道证**：① 变异目标 vs 真实现 SHA——真树 `main-world-interceptor.ts` blob16 `4ada0a33c5dbecd1` 全程未动；副本变异A `325668a7`／变异B `11aa1dd8`（各已变）；② 退出码与输出同读（干跑 6/6 EXIT=0，变异A/B 各 1 failed EXIT=1）。真树 `git status --porcelain` 空（零业务改动）。⇒ 两缺陷修复**各自必要**（摘其一即红其格）。

## 6. 收尾与纪律
dev 配置根 `~/.config/deepseek-studio`：`mcp-servers.json` 保持基线（SHA `2D5E191FF9459140` 477 B，本批未动）；`config.json` 未触碰（SHA `C6B5F30A8E8E2606`）。**记忆库清理**：强触 6× memory_save 塌到 1 枚测试条目（id `mem-mwuh0fvu-1bthnv`，name=t1／content=测试／tags=[probe]）已 `memory.delete` 清掉；库内剩 1 枚 `VERIFY-16-WRITEPROBE` 是早前排探针（非我本 session，保留）。装版资源目录零碰、零拷开发树产物。未做 commit/push。

## 7. 收工四项
（收 dev 窗 30332 后读）① `deepseek-studio.exe` 进程数；② 命令行含 `host\main.mjs` 宿主 node 数（装版 28244 那枚独立，dev 宿主是 `dev-main.ts` 不算 main.mjs）；③ 8760＋8761＋9222 认连性；④ 两棵 sidecar 根 mtime。

## 8. 验收席自认清单（如实记录）
① **真机未干净逼出熔断 notice**：强触 3 发（3×保存记忆→拒绝但 model 提前停、6×保存记忆→全被宿主接受 ok=true、4×task-snapshot→model 只调 1 次）都没让「3 枚同码终局拒在同一 turn 累积到熔断」真正落地，宿主 stdout 与聊天 DOM 均无熔断/terminate 可见交代。机制本身由单位（terminal-fuse-wiring ② PASS）＋负控（变异B ② 红）定论，但真机这一格我未观测到、不冒充——**建议出资人在新装版上直接让 agent 对一个被终局拒的工具连调 3 次，目检是否出「这条不会再重试」并停**。
② **强触污染 dev 记忆库**：6× memory_save 塌 1 枚测试条目，已 `memory.delete` 清理、留早前排探针。
③ **误跑 ㊿-c-补⑤ live2**：起窗探活时误触了 ㊿-c-补⑤ 的双关 driver（多做一次真发＋toggle 双 server 开回），已 toggle 回＋配置复基线（SHA 复同），无害。
④ **格B 真机 model 误调**：三发提示 model 皆调 memory_save 而非 mcp_list（0 枚真实 mcp_list 模型调用），格B 靠宿主面＋代码证，未由真机 model 调用证。
