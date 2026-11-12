---
title: deepseek-studio 只读代码审计·续审第 2 轮（宿主与注入主体 · 2026-11-12 19:52）
summary: 基线从 b3c058c 前进到 dc76959（4 个提交）。本轮先闭合上轮必达性可疑：round-complete 只在第 8-11 步的 finally 里，会议指令/审计指令两条早退分支的 await 在 try 之外，存在漏推路径，前端依赖不成立（N2-01 P2）。另：R6-01 已修（4facfdb 带注释落地）、Q3 两套判停已对齐、model-engine.ts 95 行纯契约无重试逻辑。新增 2 条（P2×1、P3×1）。
---

# deepseek-studio 代码审计·续审第 2 轮（宿主与注入主体）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未跑 typecheck/vitest/tauri dev、未启动长驻进程。

## 一、基线与范围

| 项 | 实测值 |
|---|---|
| HEAD | `dc76959`（master），上轮基线 `b3c058c` |
| 区间提交数 | **4** |
| 工作区 | 1 个脏文件：`src/ui/studio-chat-ui.ts`（U1-02 修复正在编辑） |
| 区间 diff | 19 文件 +945 / −54 |

提交清单（近→远）：

1. `dc76959` docs(verify)：N-02 真机验收 + CDP 口径 + R2-03/TD-06 归属确认
2. `94690fb` docs(audit)：TD 第 5 轮三份报告入场
3. `c80c315` fix(security)：0.14.21 安全批——R2-07 / TD-14 / N-01 / N-02 + 死代码
4. `4facfdb` fix(inject)：`event:hint` 归类可重试 + 截断工具标签走首轮重试

**脏文件对口影响**：`src/ui/studio-chat-ui.ts` 脏、`main-world-interceptor.ts` 与 `response-classifier.ts` 已在 `4facfdb` 落盘；本轮所有 file:line 对应 `dc76959` 工作区版（唯一脏文件不在本轮四个范围内）。

**范围**：`main-world-interceptor.ts` 剩余主体、`task-loop.ts`、`model-engine.ts`、`memory/storage.ts`、`desktop-host.ts` 回复入口。不碰 Rust 与发布链。

## 二、上轮遗留可疑项的结论

### Q一：round-complete 是否必达——结论：**不是必达，存在漏推路径（前端依赖不成立）**

读实现体（`chat-room-runtime.ts:371-532`）：

1. `onRoundComplete` 确实在 `finally` 里（`:528-531`，注释写明“落盘或摘要抛错也必须解锁 UI”）；但 **try 从 `:453` 才开始**，只包住第 8-11 步（落盘、unresolved、摘要）。
2. 它前面有两个**早退分支**在 try 之外，而且都带 `await`：
   - 会议指令：`:383 await handleMeetingCommand(...)` → `:388` 才推 round-complete；
   - 审计指令：`:408 await auditDispatcher.dispatch(...)` → `:409` 才推 round-complete。
   两者抛错时 `:388`/`:409` 均不执行，也不进 `:528` 的 finally。
3. 另外 `:373 throw new Error('room not found')` 与 `:450 await orchestrator.planRound(...)` 也在 try 之外。
4. 对比：`planRound` 内部是 fail-soft（`round-orchestrator.ts:104-112`，单 bot 异常只记 `errors[persona]` 并 `continue`），因此主讨论路径真的很少抛——**漏推集中在会议/审计两条命令分支**（它们直接 await 摘要服务与离线执行器，后两者都会调模型）。

**结论**：前端的“round-complete 必达”依赖**不成立**。U1-01 那类锁死会在“会议指令或审计指令抛错”时复现（不需要断线）。由于 `studio-chat-room.ts:203` 的修复是“重连时对齐”，而这条路径根本不断线，**修复盖不住它**。

### Q三：两套完成判定是否仍不等价——结论：**已对齐，只剩设计上的 fail-open（不构成缺陷）**

- 页面侧（`main-world-interceptor.ts:2378-2383`）：0 字节且无哨兵 → `no-stream`，**不**当截断，`return false` 交分类器。
- 宿主侧（`web-engine.ts:607-617`）：`hasVisibleOutput: sawNewText && lastText.trim().length > 0`——空流时传 false，`decideCompletion`（`:87-93`）就不会判 `interrupted`；`sawFinishSentinel === undefined` 也不判（`:66-69` 注释明写“undefined 绝不能当成 false”）。
- 因此第 3 轮“两所有者不等价”的核心差异（空流与截断混同）**已被消解**；剩下的只是“宿主完全信任页面自证”这一架构属性（与 R2-01 同源风险面，但没有独立可触发路径，不单列）。

### Q四：model-engine 的重试与退避——结论：**该文件无重试逻辑**

`model-engine.ts` 95 行全是类型契约（`CompletionStatus` 五态、`EngineSendResult`、`ModelEngine` 接口）加一个 `createApiEngineStub`（`:91-95`，health 恒 false）。**没有请求构建、没有退避、没有超时、没有并发控制、没有失败分类**——这些全部在 `web-engine.ts`（`decideCompletion` 是唯一判停真源）与注入层。所以“rate_limit_reached 冷却与重试是否打架”这一问不能在本文件里回答，见第五节第 1 条。

### Q五：memory/storage.ts 的超长 content——结论：**仍无上限（写入侧根因成立）**

`storage.ts:68` 只校 `!params.name || !params.content`（非空），全 `src/host/memory` 搜 `MAX_CONTENT`/`content.length` **零命中**；`INSERT`（`:223-227`）与 `UPDATE`（`:135-138`）直接写原串。第 3 轮 P3“首条超大记忆导致整块注入为空”的写入侧根因**仍在**。
## 三、新增缺陷清单（2 条）

### N2-01（P2）会议/审计指令分支漏推 round-complete，UI 输入框永久锁死

**file:line**：`src/host/bot/chat-room-runtime.ts:371-411`（`handleUserMessage` 入口与两个早退分支）→ `:383`（`await handleMeetingCommand`）→ `:388`（唯一的推入点）→ `:408`（`await auditDispatcher.dispatch`）→ `:409`（推入点）→ 对照 `:453-531`（try 从 453 开始，finally 在 528-531）。

**触发条件**：任一——① 用户在会话里发 `/总结`、`/开会`、`/散会` 等会议命令，而 `summaryService.summarize` 抛错（模型不可用/超时/页面不达）；② 发 `@main 审计` 类命令，而 `auditDispatcher.dispatch` 抛错（离线执行器预检失败、槽无已连接可信页）；③ `roomId` 未配置（`:373`）。

**影响**：`onRoundComplete` 不执行 → UI 的 `roundInProgress` 停在 true（`studio-chat-room.ts:542`）→ 输入框 `disabled`、发送铵文案“进行中…”永不复位。与 U1-01 同一个死锁形态，但**不需要断线**，且重连对齐的修复盖不住它。

**证据类型**：代码级（控制流三跳闭合）。`planRound` 的 fail-soft（`round-orchestrator.ts:104-112`）说明主讨论路径很少抛，反证了“漏推集中在命令分支”这个定位。

**修复建议**：把 `handleUserMessage` 全体包进 `try/finally`（`onRoundComplete?.({roomId, triggerMessageId:'', members:[], contents:{}, pendingHandoff:[]})` 放 finally，真 round 分支里用局部变量覆盖）；最小改法是给 `:383` 与 `:408` 两个 await 各包一层 try/catch，catch 里推同一份合成 round 再把错误推 `onBotError`。

**验收判据**：单测——合一个 `handleMeetingCommand` 抛错的用例，断言 `onRoundComplete` 恰好被调一次且 UI 收到 `round-complete`；当前无任何用例覆盖命令分支的异常路径。

### N2-02（P3）命令分支推的 round-complete 携带空成员集，下游无法区分“真讨论完成”与“命令完成”

**file:line**：`chat-room-runtime.ts:388` 与 `:409`（`{ roomId, triggerMessageId: '', members: [], contents: {}, pendingHandoff: [] }`）对照 `:530`（真 round 对象）→ `desktop-host.ts:1491-1497`（`memberCount: round.members.length` 恒为 0）。

**触发条件**：任何会议/审计命令。
**影响**：当前 UI 只用 `round-complete` 解锁（`studio-chat-room.ts:341-344`），所以**无可见后果**；但 `triggerMessageId` 为空串、`memberCount` 为 0 是两个“看起来像真值”的假值，任何下游拿它们做幂等、去重或轮次计数都会错。属契约缺陷，不入修复梯队前两位。
**证据类型**：代码级。
**修复建议**：合成 round 改成 `kind: 'round-complete', reason: 'command'`（新增可选字段），或让 `members` 填真实参与者。
**验收判据**：UI 能根据 `reason` 区分命令回执与讨论完成；现有用例不变红。

## 四、既有结论的沿用或重判

| 编号 | 上轮结论 | 本轮重判 |
|---|---|---|
| R6-01 | 续跑轮截断静默停摆（P2） | **已修复**：`main-world-interceptor.ts:2362-2370` 现已 `streamActive = false` 后 `return false`，并带注释引用“R6-01（2026-11-12 TD 审计）”，与 `:2215` 同口径 |
| R6-02 | 重发前无人清空旧气泡 | **沿用**：`src/ui/studio-chat-ui.ts` 当前脏（U1-02 修复编辑中），未重读 |
| U1-01 | 重连后 roundInProgress 锁死 | **修复进行中**：`studio-chat-room.ts:203` 已有“U1-01（TD 续审第 1 轮 P2）”的重连对齐注释；但 N2-01 表明服务端还有一条不经断线的漏推路径，**光改前端不够** |
| U1-03 | props.html 死原语 | **未变**：`studio-ui-core.ts:216-219` 仍在 |
| 第 3 轮“两套判停不等价” | 两所有者仍存、且不等价 | **重判为已对齐**（见 Q3），不再构成缺陷 |
| 第 3 轮“记忆饿死”写入侧 | 无 content 上限 | **沿用**（见 Q5） |

## 五、可疑未证实

1. **rate_limit 冷却与首轮退避是否打架**：`response-classifier.ts:166-180` 把 `rate_limit_reached` 判 `retryable`，注入层用 1s/2s 退避；宿主侧 `web-engine.ts` 的 send 重试段未读完，不知道有没有独立的 30s 冷却。缺：`web-engine.ts` 重试段全文。
2. **`planRound` 前置同步调用可能抛**：`round-orchestrator.ts:75` 的 `router.route`、`:116` 的 `handoffParser.parse`、`:123` 的 `participantResolver.resolve` 都不在 try 内，若 registry 快照在并发下被改可能抛。缺：三个实现的并发安全性。
3. **FTS 与主表一致性**：`storage.ts:145`/`:207`/`:234` 把 `syncFtsStrict` 的返回值包成 `ftsWarn` 返回，但 `:223` 的 INSERT 已在前面执行。缺：`syncFtsStrict` 失败时的回滚语义。
4. **finally 里的回调可能吞异常**：`chat-room-runtime.ts:528-531` 的 `onRoundComplete` 若自身抛错（`emitChatRoomEvent` → WS 广播），会覆盖 try 块的原因异常。缺：`emitChatRoomEvent` 是否有内部 try。
5. **淘汰策略边界**：`core.ts:144` `candidates.slice(0, need)` 与 `prepareEviction` 全量取行的关系未重读。

## 六、覆盖与未覆盖

**读完的函数体**（约 420 行）：`main-world-interceptor.ts:2340-2404`、`:2569-2600`、`:2681-2700`（R6-01 段与续跑调度）；`chat-room-runtime.ts:330-550`（handleUserMessage 全段）；`round-orchestrator.ts:69-130`（planRound 异常处理）；`model-engine.ts:1-95`（全文）；`task-loop.ts:230-250`（computeStop）+ 符号表；`web-engine.ts:60-104`（decideCompletion）、`:600-622`（调用点）；`desktop-host.ts:1440-1510`（回调接线）；`memory/storage.ts` 写入/去重/FTS 符号与 SQL 片段。

**未读完（及原因）**：① `main-world-interceptor.ts` 剩余约 2,900 行主体（fetch/xhr 请求构造、工具解析）——本轮目标是宿主侧，优先句了 Q1/Q3/Q4；② `task-loop.ts` 其余约 300 行（run 主循环与退避）；③ `web-engine.ts` 重试段（第五节第 1 条）；④ `memory/storage.ts` 其余约 480 行；⑤ 运行期验证一律未跑。

**设备可用性**：本轮开工时设备离线约 4 分钟（3 次 `device_unreachable`），因此在读写配额上做了取舍——优先把四个问题里的“必达性”与“两套判停等价性”读完，主体通读留给了下一轮。

## 七、修复优先级

1. **N2-01（P2，一个 try/finally）**：`handleUserMessage` 全体包 finally；与 U1-01 的前端重连对齐**成对上线**（只改一边会留下另一条锁死路径）。
2. **R3-04 写入侧（P3，一处长度上限）**：`storage.ts:68` 加 content 长度上限（如 8KB）+ 截断标记，堵住“首条超大记忆饿死整块注入”。
3. **N2-02（P3）**：合成 round 加 `reason: 'command'`。
4. **U1-03 / 遗留 7 条**：按要求不变。

---

**本轮工作量与结果**：读 7 个文件的关键段（约 420 行）；新增 **2 条**（N2-01 P2、N2-02 P3）；上轮那个可疑项（round-complete 必达性）定成 **“不是必达，存在漏推路径”**（会议/审计命令分支的 await 在 try 之外）；R6-01 核实为**已修复**，Q3 重判为**已对齐**，Q4 的 model-engine 是**纯契约文件**，Q5 的 content **仍无上限**。未读完：`main-world-interceptor.ts` 主体、`task-loop.ts` 主循环、`web-engine.ts` 重试段、`memory/storage.ts` 剩余 SQL；运行期未验证。
## 八、补充取证（Q二：工具调用去重）

上轮“断流与续跑三件套”里的去重一项，本轮已读完实现（`src/shared/tool-call-dedupe.ts:1-70` + 调用点）：

1. **去重确实存在，且分两层**：`claim(callId)`（`:30-34`）拦“同一次解析被重复投递”，`claimSignature(name, params)`（`:38-43`）拦“模型吐完全相同的调用”，签名用 `stableSerialize`（`:57-69`，键排序）保证参数顺序无关。
2. **两层生命周期不同**：callId 集只在**新用户回合**清（`main-world-interceptor.ts:2772`）；签名集在**每条流开始时**清（`:2286` `onStreamBegin = () => toolCallDedupe.resetSignatures()` → `dedupe.ts:44-46`）。
3. 因此结论：**“同一轮、跨流”的重复调用不被拦截**。接口注释（`dedupe.ts:14`）自己声明是“同一流内”，所以这是设计边界，不当作缺陷入清单，但它在 R6-01 的续跑场景里正好是最常见的形态（模型下一轮重同一份 write），列入可疑 N2-03 等产品拍板。
4. 另记：`loopState.streamHadVisibleText = false` 在 `:2784` 与 `:2791` 重复赋值（无副作用，仅行数噪声，不入清单）。

**修复优先级补充**：跨流签名去重列为“待拍板”，不建议本轮改——去掉按流清空会让合法的“下一轮重跑同一命令”也被拦。

---

**交付状态**：报告已落盘到 `docs\审计报告\TD\` 并发布到存储；前七份未动。未读完的部分（`main-world-interceptor.ts` 其余主体、`task-loop.ts` 主循环、`web-engine.ts` 重试段、`memory/storage.ts` 剩余 SQL）留待下一轮。
## 九、补充缺陷（task-loop 超时竞速）

### N2-04（P3）轮超时只放弃等待、不取消请求，迟到的回复会被下一轮当成自己的

**file:line**：`src/host/kernel/task-loop.ts:300-305`（`Promise.race([withAbort(call, signal), 超时 reject])`）→ `:307-310`（超时分支 `break`，不调任何取消）→ `:292-295`（下一轮 `useWait` 仍会 `waitForNextReply`）。

**触发条件**：某轮超过 `roundTimeoutMs`（默认 120s，`:253`）才返回（模型卡住、页面慢）；且 `maxRounds > 1` 且有工具轮。

**影响**：`Promise.race` 不会取消 `call`，`withAbort` 只在 `signal` 中止时生效。超时后本次 `send`/`waitForNextReply` 仍在飞；它的回复（属于上一轮）会被下一轮的 `waitForNextReply` 当成新回复消费，`history` 里就出现“第 N 轮的回答接在第 N+1 轮”的错位。另外断网挂死时该请求永不 settle，会持续占住一个页面会话。

**证据类型**：代码级（`Promise.race` 无取消语义是 JS 语言事实，与 `:307-310` 的 `break` 闭合）。

**修复建议**：`RoundTimeoutError` 分支里主动 `engine.abort?.()`（或向 `withAbort` 传入一个内部 `AbortController` 并在超时时 abort），确保超时后旧请求不再回写。

**验收判据**：单测——引擎 `send` 返回前先超时，断言超时后旧 promise 的 resolve 不会进 `history`（旧实现会进）。

---

**工作量补充**：本补充节读完 `task-loop.ts:250-340`（run 主循环）与 `tool-call-dedupe.ts:1-70`（全文），新增 **1 条**（N2-04 P3）、**1 条**可疑（N2-03 跨流签名去重）。累计本轮：新增 3 条（P2×1、P3×2）。