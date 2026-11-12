---
title: deepseek-studio 只读代码审计·最近提交定向（TD · 第 6 轮 · 2026-11-12 14:20）
summary: 自 b3c058c（v0.14.20）起提交数为 0，本轮实际审计对象是 5 个未提交的工作区改动（+86/−16，全部在 inject 错误分类与断流结算链）。逐行读完两处源码改动与三处测试改动后，新增 3 条：R6-01（P2）续跑轮截断工具标签时既不重试也不报错、静默停摆；R6-02（P3）忽略 clear_response 导致重试后新旧回复拼接；R6-03（P3）fetch 路径新测试无正向断言。前五轮 7 条遗留项本轮未被触碰，状态未变。
---

# deepseek-studio 代码审计·最近提交定向（TD · 第 6 轮）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未跑 typecheck/vitest/tauri dev、未启动长驻进程。

## 一、审计范围与基线

| 项 | 实测值 |
|---|---|
| HEAD | `b3c058c4e0e64ae0b419ee5c99724fb86d23c9c0` |
| 分支 | master |
| `git rev-list --count b3c058c..HEAD` | **0** |
| 工作区 | 5 M + 1 ??（?? 为本轮之前的第 5 轮报告目录） |

**提交数为 0**，因此本轮审计对象不是提交历史，而是**当前未提交的工作区改动**：`git diff` = **5 文件 +86 / −16**。

| 文件 | 增/删 |
|---|---|
| `src/inject/main-world-interceptor.ts` | +21 / −10 |
| `src/inject/response-classifier.ts` | +24 / −1 |
| `tests/desktop/response-classifier.test.ts` | +30 / −0 |
| `tests/desktop/qd-r4-stream-break-regression.test.ts` | +7 / −3 |
| `tests/desktop/qd-r4-fetch-path-regression.test.ts` | +4 / −2 |

> 注：`git diff` 对四个含 CRLF 的文件告警“CRLF will be replaced by LF”，属行尾归一化提示，不计入变更。

**快照声明**：本轮所有 file:line 对应上述 HEAD 的工作区（即含未提交改动的版本）。这五份文件之外的工作区与 HEAD 一致。

## 二、改动概览

这两处源码改动是同一个现场问题的两条腿（提交说明与代码注释均标注 R6/R7，2026-11-12 实跑）：

1. **`response-classifier.ts:162-183` 新增 `event: hint` 帧分类**。DeepSeek 上游瞬态故障以 `event: hint` + `{type:'error', finish_reason:'generation_err' | 'rate_limit_reached'}` 下发，没有 `code/status/error/message` 四个字段，旧实现落到 `classifyErrorPayload(undefined, '')` 返回 `null`，被当正常帧放行→空回复烧掉唯一一次 protocol repair → 硬失败。新分支把这些帧判为 `retryable`，reason 为 `sse-hint-<finish_reason>`。
2. **`main-world-interceptor.ts:2350-2372` 把“截断工具标签”从硬停改为走首轮重试预算**。旧实现 appendError 后 `return true` 直接收场（文案“本轮不会自动重试”）；新实现：续跑轮直接 `setBusy(false); return false`，首轮则 `escalateFirstAttemptFailure('tool-call-truncated', ...)` 后 `return true`。
3. **`main-world-interceptor.ts:3027-3043`** 错误文案新增 `sse-hint-` 分支，避免把内部 reason 串暴露给用户。
## 三、新增缺陷清单（3 条）

### R6-01（P2）续跑轮遇到截断工具标签：既不重试也不报错，静默停摆

**file:line**：`src/inject/main-world-interceptor.ts:2350-2372`（新分支）→ `:2847`（续跑派发时 `streamActive = true`）→ `:2201`（XHR 侧 `settled === true` 才跳过降级）→ `:2235-2237`（`onStreamEnd()` 补偿）→ `:2494`/`:2536`/`:2558`（续跑调度守卫 `!loopState.streamActive`）。

**触发条件**：自动续跑轮（`loopState.inAutoContinue === true`，由 `:2943` 置位、`:2847` 把 `streamActive` 置 true）中，当前流在工具标签中间断开（`streamTruncatedTag === true`，由 `:1767`/`:2189` 置位）。

**控制流**：新分支只做两件事——`chatUI.setBusy(false)` 与 `return false`。
1. 返回 `false` → XHR 侧 `:2201` 进入降级块，但降级块整体被 `if (!loopState.inAutoContinue)` 包住（`:2204`），续跑轮直接跳过；
2. 于是落到 `:2235` 的 `onStreamEnd()`；
3. `onStreamEnd` 的续跑调度三个入口全部以 `!loopState.streamActive` 为前提（`:2494`/`:2536`/`:2558`），而这里**没有任何一处把 `streamActive` 置 false**（对比：`:1681`、`:1774`、`:1791`、`:2215`、`:2651`、`:2666` 都置了）→ 调度被自己拦住；
4. 本轮至此结束：无错误卡、无重发、`busy` 已被置 false。

**影响**：用户看到的是“转圈停了、答案停在半截、既没报错也没重试”，只能手动重发。这正是 R7 想消掉的“完不成”体验到另一个形态；而它与首轮路径（会重试并出“正在自动重试 n/2”卡）行为不一致。

**证据类型**：代码级（控制流三跳闭合，无需运行时）。

**修复建议**：在 `inAutoContinue` 分支里补 `loopState.streamActive = false;`（与 `:2215` 同口径），再 `return false` 交给 `onStreamEnd` 调度；或在分支内直接 `return true` 并自行调 `scheduleAutoContinue()`——二者选一，不要保持现在“既不收口也不释放”的中间态。

**验收判据**：新增单测——构造 `inAutoContinue=true` + 流在工具标签中途结束，断言 `loopState.streamActive === false` 且续跑请求数 > 1（或出现 `tool-call-truncated` 错误卡）；当前两个 R7 测试都只跑首轮路径，不会变红。

### R6-02（P3）`clear_response` 被忽略：服务端要求清空时，重试后新旧回复会拼在一起

**file:line**：`src/inject/response-classifier.ts:166-180`（新分支只读 `type` / `finish_reason`，未读 `clear_response`）；对照 `tests/desktop/response-classifier.test.ts:78-92` 的用例里 `rate_limit_reached` 帧就是 `clear_response: true`。

**触发条件**：上游下发 `event: hint` 且 `clear_response: true`（限流帧的典型形态）。
**影响**：分类器判 `retryable` 后走退避重发（`main-world-interceptor.ts:2211-2217`），但页面侧的半截回复从未被清空（`finishAssistantMessage({recordFinal:false})` 是“收尾”不是“删除”）→ 重试成功后的新回复接在旧半截后面，呈现为重复/不连贯的答案。
**证据类型**：代码级（字段未被引用）＋测试数据（服务端确实会置 true）。是否构成用户可见缺陷，取决于产品对 `clear_response` 的期望，见第五节第 2 条。
**修复建议**：`ClassifiedResponse` 增加 `clearResponse?: boolean`，`retryable` 分支在重发前把当前助手消息回滚到空（或标记丢弃）。
**验收判据**：`clear_response:true` 的 hint 帧 → 重试后页面上只有一份回复（旧半截不再参与渲染）。

### R6-03（P3）fetch 路径的新测试无正向断言：重试完全不发生也能绿

**file:line**：`tests/desktop/qd-r4-fetch-path-regression.test.ts:133`（改为 `expect(chatUI.setBusy).not.toHaveBeenCalledWith(false)`）；对照 XHR 侧 `qd-r4-stream-break-regression.test.ts:217-219` 写了 `expect(chatRequests(FakeXHR).length).toBeGreaterThan(1)`。

**触发条件**：任何人把 `escalateFirstAttemptFailure` 在 fetch 路径上改成空实现（或 `inAutoContinue` 恒 true）。
**影响**：fetch 路径的用例只断言“没有调 `setBusy(false)`”，**没有任何断言说重发发生了**——一个“什么都不做”的实现同样能通过。而 fetch 是当前主路径（`installFetchHook`），XHR 只是兼容路径。属测试假绿。
**证据类型**：代码级（断言集合）。
**修复建议**：补 `expect(fetchMock).toHaveBeenCalledTimes(2)`（或对重发请求的 body 断言），与 XHR 侧同口径。
**验收判据**：把 `escalateFirstAttemptFailure` 临时改成 `() => {}` 后该用例变红。

## 四、遗留问题点检（只核“是否被本段改动碰到”）

| 编号 | 位置 | 状态 |
|---|---|---|
| R2-03 CDP 默认常开 | `src-tauri/src/main.rs:1745-1769` | 本段 diff 未触碰，**状态未变**（release 仍无条件开 9222/9223） |
| TD-06 端口硬编码 8760 | `src-tauri/src/sidecar.rs:21` | 未触碰，**未变** |
| R2-07 `memory.save` 零审批 | `src/host/tool-definitions.ts:200-203` | 未触碰，**未变** |
| TD-14 配对码非常量比较 | `src/api/agent-lan-access.ts:69-101` | 未触碰，**未变** |
| N-01 `skill.dir.set` 零审批 | `src/host/tool-definitions.ts:144-152` | 未触碰，**未变** |
| N-02 远程页 `updater_install` 权限 | `src-tauri/capabilities/default.json` | 未触碰，**未变** |
| R2-10 PID 级 tree-kill | `src/shared/tree-kill.ts` | 未触碰，**未变** |
## 五、可疑未证实

1. **首轮路径可能重复收尾**：`main-world-interceptor.ts:2348` 先 `finishAssistantMessage({recordFinal:false})`，随后 `escalateFirstAttemptFailure` 的两个分支（`:2651` 区与调度分支）又各调一次。是否造成“空气泡/重复 recordFinal”取决于 `chatUI.finishAssistantMessage` 的幂等性。缺：`src/ui/studio-chat-ui.ts` 该实现的空消息守卫阅读（本轮 diff 未碰它，按纪律未读）。
2. **R6-02 是否应升 P2**：`clear_response` 在 DeepSeek 协议里的确切语义（“丢弃已生成内容”还是“仅提示 UI”）无本地文档。缺：上游协议说明或真机抓包。
3. **`rate_limit_reached` 退避与既有 30s 冷却是否打架**：hint 帧不带 `Retry-After`，退避链是 1s/2s（`errorBackoffMs`），可能在限流窗口内连撞。缺：宿主侧限流冷却（0.14.18 引入）的触发源阅读，确认它是否只认 HTTP 429。
4. **`inAutoContinue` 分支的 `setBusy(false)` 语义**：该分支既不收尾也不报错，却先把转圈关了；若按 R6-01 改为 `return true`，需同步确认 busy 该不该保持。缺：产品对“续跑轮断流时转圈该不该停”的裁定。
5. **reason 字符串契约无类型约束**：UI 文案分支用 `verdict.reason.startsWith(\'sse-hint-\')`（`:3038`）识别，改 reason 格式会静默降级到兜底文案。缺：是否应改为枚举（目前只影响文案，不入清单）。
6. **auto-continue + 截断无任何用例**：本轮两个回归测试都只跑首轮路径，R6-01 的盲区正来源于此。缺：补测试后的红/绿对照。

## 六、覆盖与未覆盖

**本轮覆盖**：5 个改动文件全部逐行读完（`git diff -U6/-U8` 全文 + 上下文），额外交叉读了 `main-world-interceptor.ts` 的 `1620-1830`（beginStream / fetch 结算）、`2060-2250`（XHR 结算与降级块）、`2320-2380`（settleStreamEnd 入口）、`2490-2680`（续跑调度与 escalate）、`2780-2870`（续跑派发与标记复位）五段，共约 260 行；控制流三跳均按“谁置位、谁清位、谁守卫”逐行核。

**未覆盖（及原因）**：① `src/ui/studio-chat-ui.ts` 的 `finishAssistantMessage`（未提交改动未碰它，按“最近提交没碰到的不要读”纪律未读）——它是第五节第 1 条的唯一缺口；② `task-loop.ts` / `model-engine.ts` / `memory/storage.ts`（本轮 diff 未触及）；③ `main-world-interceptor.ts` 其余约 3,000 行主体（fetch/xhr hook 的请求构造段、工具解析段）；④ 运行期验证（未跑 vitest，内存纪律）。

## 七、修复优先级

1. **R6-01（P2，几行）**：`inAutoContinue` 分支补 `loopState.streamActive = false`（或改 `return true` 并自行调度）。验收：新单测在 `inAutoContinue=true` + 截断时变红→修后变绿。
2. **R6-03（P3，一行断言）**：fetch 侧补 `fetchMock` 调用次数断言，防“什么都不做也能绿”。
3. **R6-02（P3）**：待产品确认 `clear_response` 语义后再动；若确认需清空，则重发前回滚半截消息。
4. **遗留 7 条**：按第 5 轮顺序（CDP 默认常开 → `memory.save` 零审批 → 端口硬编码 → 其余），本轮未变。

---

**本轮工作量与结果**：审计区间 `b3c058c..HEAD` 为 **0 个提交**，故实际审的是 5 个未提交文件的 **+86/−16** 工作区改动；全部逐行读完（含上下文约 260 行）；新增 **3 条**（P2×1、P3×2）；遗留 7 条仅点检、状态未变；可疑未证实 6 条。复用旧结论：前五轮的 34 条不再重验，仅按“本段是否碰到”点检。未读完：`studio-chat-ui.ts` 的收尾实现（本轮 diff 未触及），以及 `main-world-interceptor.ts` 剩余主体。