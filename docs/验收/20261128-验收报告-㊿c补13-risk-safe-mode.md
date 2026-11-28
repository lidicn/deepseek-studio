<!-- 历史快照：内引路径/行号为当时状态，不作活锚 -->

# ㊿-c-补⑬ 风控安全模式（零自动外发）验收报告

**验收席**：Verify（独立验收，不写业务代码；自跑闸／自读代码／自做反证／自报缺陷）
**对象**：⑬ 修复批 `27e1725` ＋ 抬号批 `dd75a92` ＋ tag `v0.14.38`（Release 461502186 已 Publish）＋ 装版 0.14.38（双产物与仓库锚逐字相等无混血）
**现场 HEAD**：`dd75a9249da96672fe2ceb9ffe0e301ec0f8b6dc`（= 抬号批，tag `v0.14.38` peel 到它；工作树净，无在途改动）
**版本口径钉死**：v0.14.37＝⑫ 节流版（已发布装机，不含安全模式）；**v0.14.38＝⑬ 安全模式（零自动外发）**。两版不叠。

## 1. 冻结清单（现算）

| 件 | bytes | 行数 | blob16 | mtime |
|---|---|---|---|---|
| src/inject/main-world-interceptor.ts | 275,259 | 4,584 | f4a274f6e02b815b | 2026-11-28 15:42:11 |
| src/inject/response-classifier.ts | 27,796 | 541 | 38213bea7da300bf | 2026-11-27 12:32:03（=⑫ 交卷态，**未动**） |
| src/shared/continuation-prompt.ts | 57,259 | 1,036 | 77c9c113c1c7f754 | 2026-11-28 15:14:45 |
| tests/desktop/risk-safe-mode.test.ts | 10,811 | 240 | fc3ceac170f8106a | （⑬ 新增测试件） |

- ⑬ 改动面：interceptor ＋ shared（＋62/＋13 行口径，与 UI 交卷一致）。
- **格⑤ 不碰面坐实**：`response-classifier.ts` blob16 `38213bea7da300bf` 与 ⑫ 交卷态逐字相等（40303/40003 终局、额度墙、审批闸、MCP/技能刷新、记忆注入零改动，classifier 是这些判定的载体，未动即零改动）。

## 2. 三闸与窄面（自跑，EXIT 现读）

- `npm run typecheck`：**EXIT=0**（tsc --noEmit）。
- 独立窄面 vitest（⑬ 相关三件）：`risk-safe-mode` 6/6 ＋ `response-classifier` 39/39 ＋ `ban-hardening-4piece` 12/12 ＝ **57/57，EXIT=0**。
  - `risk-safe-mode.test.ts` 六格：① 一轮带工具调用结束→零续跑请求（pending 被清、不发下一轮）；② 错误 429→不自动重试（无第 2 枚请求）；③ 截断 200 无哨兵→不自动重发；④ UI 不卡「进行中」（首轮失败 setBusy(false) 必达）；⑤（负控对照）`riskSafeMode:false` 覆盖⇒⑫ 节流行为在位（首轮失败自动重发出现）；＋ 常量在位断言 `RISK_SAFE_MODE===true`。
  - 全量 `npm run gate` 归 PM（GATE#141 exit=0 已采信，本席不复跑全量）。

## 3. 判据五格（机制层，自读代码坐实）

- **格① 安全模式常量**：`src/shared/continuation-prompt.ts` L135 `export const RISK_SAFE_MODE = true;`（注释 L132 写明「新号存活验证期，通过后改 false 并启用 ⑫ 节流」）。interceptor L33 `import { RISK_SAFE_MODE as RISK_SAFE_MODE_DEFAULT }`、L38 `safeModeDefault`、L3007 `riskSafeMode = options.riskSafeMode ?? safeModeDefault`（测试件传 `false` 覆盖验节流在位，不动 shared 源）。
- **格② 入口早退闸**：`autoContinueWithPow` 内 L3964-3989——`if (riskSafeMode)` 记 `continuation.decision reason=safe-mode triggered=false` ＋ `turn.end stopReason=safe-mode`，清「本轮进行中」全标志（`pending.length=0`／`setContinuationRetryPending(false)`／`protocolRepairPending/Used`／`firstAttemptResendActive/Pending`／`inFirstAttemptResend`／`streamActive`／`loopDepth`／`errorRetryCount`），`finishStepFlow code=safe-mode` 文案「安全模式：自动续跑已关闭。工具结果已执行，需要继续请手动发送「继续」」，return 不发请求不算 PoW。
- **格③ 排点闸（6 处定时器排点＋首轮升级入口）**：`scheduleAutoContinue`（工具续跑）L3671、`scheduleFirstAttemptResend`（首轮原样重发）L3707、`escalateFirstAttemptFailure`（首轮失败升级）L3755、XHR executor 错误重试支 L4283、截断重发支 L4312、协议修复支 L4387——每处 `if (riskSafeMode)` 收尾 safe-mode 并 `return`，不排定时器。两道闸（入口＋排点）并存＝防御纵深。
- **格④ 保留 ⑫④ 同文护栏**：`captureChatRequest` L2166-2179——`isDuplicateUserPrompt`＋`window.confirm(DUPLICATE_PROMPT_CONFIRM_TEXT)`＋放行后无条件 `recordUserPrompt`（写点在 if 块外）。⑬ 一字未动（⑫ 交卷态同文护栏回归件 ban-hardening-4piece 12/12 仍绿）。
- **格⑤ 不碰面**：`response-classifier.ts` blob16 `38213bea`＝⑫ 交卷态未动；40303/40003 终局、额度墙、审批闸、MCP/技能刷新、记忆注入零改动。

## 4. ⑫ 节流挂 false 分支（本版不触发，代码在位）

- ⑫ 件① 轮间抖动：`scheduleAutoContinue` L3691-3695 `1500 + Math.round((Math.random()*2-1)*700)`，落在 safe-mode 闸（L3671）之后 ⇒ `riskSafeMode===true` 时 L3671 已 return，轮间抖动永不排。
- ⑫ 件② 退避 `errorBackoffMs` ＋ 件③ 速率闸（`autoSendTimestamps` 滑窗 `RATE_CAP_PER_WINDOW`）＋ ⑫④ 同文护栏：全部在入口 safe-mode 闸（L3964）之后／在排点闸之后 ⇒ safe-mode 下不触发。
- 负控对照由测试件 ⑤ 覆盖：`riskSafeMode:false` 时首轮失败自动重发出现（⑫ 节流行为在位）。
- shared 常量 `CONTINUATION_INTER_ROUND_MS=1500`／`CONTINUATION_INTER_ROUND_JITTER_MS=700`／`AUTO_SEND_RATE_WINDOW_MS=5*60*1000`／`RATE_CAP_PER_WINDOW=25`（L103-118）仍在位。

## 5. 负控两道证（卡面必红，由测试件 ⑤ ＋ 源码靶心注释坐实）

- 证A「摘早退闸⇒续跑请求出现」：`risk-safe-mode.test.ts` ⑤ 用 `options.riskSafeMode=false` 覆盖 shared 常量（不动源），首轮失败自动重发出现＝摘闸后⑫ 节流在位。测试件靶心注释（L21）明写「A. 摘掉入口早退闸（RISK_SAFE_MODE 改 false）⇒ 自动续跑请求出现；B. 摘掉 safe-mode 收尾（finishStepFlow）⇒ UI 卡进行中」。
- 证B「常量改 false⇒⑫ 节流行为在位」：同一 ⑤ 对照——`riskSafeMode:false` 覆盖后自动外发请求出现。
- 两道证在测试件内以 options 覆盖实现（不污染真树），与历批「仓外留证」同族；本批 ⑬ 的负控走测试件内 options 覆盖而非仓外副本，因 ⑬ 的开关本身是可覆盖的模块面（`options.riskSafeMode`），靶心可达且不留仓外态。

## 6. 装版 0.14.38 产物面（现读，无混血）

- 装版根 `%LOCALAPPDATA%\DeepSeek++ Studio\`：`entry.js` 494,819 B sha8 `7B4AE0DF`（＝卡面），`main.mjs` 842,012 B sha8 `2633C2CE`（＝shared host 锚，历版同）。双产物与仓库锚逐字相等＝无混血。
- entry.js 版本串：`0.14.38`=1、`0.14.37`=0（清零）。
- entry.js 锚（压缩产物，named 常量被 minify 掉，行为锚在位）：`safe-mode`=27、`auto-send-rate-cap`=2、`duplicate prompt guard`=3、`user cancelled`=1、`user confirmed`=1、`auto-continue suppressed`=2、`first-attempt resend suppressed`=1、`error retry suppressed`=1、`protocol repair suppressed`=1、`riskSafeMode`=1。
- 装版 sidecar 日志根 `%APPDATA%\com.deepseek.studio\logs` mtime **20:21:19**＝卡面基线，我窗内未前进（未起 dev 窗、未碰装版）。

## 7. 收工四项（现读）

| 项 | 读数 | 说明 |
|---|---|---|
| ① deepseek-studio.exe 进程数 | 1 | PM 起的装版实例（appPid 11472）在跑，非我动作 |
| ② 宿主 node（命令行含 host\main.mjs） | 1 | 同上，PM 实例 |
| ③ 8760 只认可连性 | reachable=True | 装版 host 在位 |
| ④ 8761 | reachable=False | dev 树无实例 |

我侧**未起 dev 窗、未碰装版与 8760**，全程只读取证＋窄面闸。

## 8. 真机行为格（注记：出资人实测兜底）

⑬ 是行为级变更——「工具调用后无自动续跑、需手动发『继续』」与 ⑫④ confirm 弹窗格，**都挂出资人换新号登录后的同一会话实测兜底**（用户 11-28 拍板要的「纯净 Studio」存活验证）。机制层由本报告（单测＋负控＋产物面）定论；真机行为格如实注记由出资人实测兜底。我侧不擅自起 dev 窗（登录由出资人扫码、dev 窗需他确认后起）。

## 9. 自认（本批）

- 装版产物面首读把 `CONTINUATION_INTER_ROUND_MS`／`RATE_CAP_PER_WINDOW`／`errorBackoffMs` 报 0 枚，根因是压缩产物 minify 掉了 named 常量（行为锚 `safe-mode`／`auto-send-rate-cap`／`duplicate prompt guard` 在位）——非「⑫ 代码被删」，是取数口径把「named 常量枚数」误当「行为在位」判据。已按行为锚重读销账。
- 报告 blob16 以 PM 现算为准（历批通道形态教训沿用）。

## 10. 结论

**PASS（分层口径）**。⑬ 风控安全模式机制层全坐实：格① 常量在位、格② 入口早退闸、格③ 六处排点闸＋首轮升级入口、格④ 同文护栏一字未动、格⑤ classifier 未动；⑫ 节流全挂 false 分支本版不触发；窄面 57/57 ＋ tsc EXIT=0；装版 0.14.38 双产物无混血、版本串在位、行为锚全在位。真机行为格挂出资人换新号实测兜底（非 CDP 取证，证据强度低一档，报告已注记）。

**逐件锚**（bytes＋行数＋blob16，本报告落盘后由 PM 现算 blob16 为准）：
- 报告：`docs/验收/20261128-验收报告-㊿c补13-risk-safe-mode.md`
