# v0.14.38 发版说明

发布日期：2026-11-28（tag `v0.14.38`；本版落地**风控安全模式——零自动外发**。背景：11-26 晚封号取证后，出资人 11-28 拍板「把自动续跑等可能被风控的行为都关闭，完成后我登陆另一个号，如果还被风控就考虑停止项目开发」——要的是一个**真·零自动外发**的「纯净 Studio」做存活验证，而不是只在节流上打补丁）

## 这版修了什么

### 风控安全模式：零自动外发（`㊿-c-补⑬`）

**关键事实**：Studio 全部自动 chat/completion 出口都汇聚在 `src/inject/main-world-interceptor.ts` 的 `autoContinueWithPow`——工具续跑、错误重试、协议修复、首轮原样重发四条路全经它；全文件只有它内部一处 chat/completion 出口。所以一道早退闸即可关干净。

1. **常量** `RISK_SAFE_MODE = true`（`src/shared/continuation-prompt.ts`）：本版强制开，注释写明「新号存活验证期，验证通过后改 false 并启用 ⑫ 节流」。
2. **入口早退闸**（`autoContinueWithPow`）：安全模式下——记 trace（`continuation.decision reason='safe-mode'`＋`turn.end stopReason='safe-mode'`）；清 `pending` 与所有「本轮进行中」标志（continuationRetryPending／protocolRepairPending／protocolRepairUsed／firstAttemptResendActive／firstAttemptResendPending／inFirstAttemptResend／streamActive／loopDepth／errorRetryCount）并发出本轮结束事件（避免 Studio 自有 UI 卡「进行中…」）；给用户一行可见提示「安全模式：自动续跑已关闭。工具结果已执行，需要继续请手动发送「继续」」；**return，不发任何请求、不算 PoW**。
3. **排点闸**（防御纵深，6 处）：所有 `autoContinueTimer = setTimeout(... autoContinueWithPow)` 排点在安全模式下**不排**——工具续跑、首轮原样重发、首轮失败升级、错误重试、截断重发、协议修复六处。
4. **保留 ⑫④ 同文重发护栏**：120 秒内同一归一化 prompt 再次提交先弹原生确认——安全模式只关「自动」，不关「手动防重复指纹」。
5. **⑫ 节流代码全留**（轮间 1500±700／退避 4s/8s/16s/速率闸）但全部挂在 `riskSafeMode === false` 分支，本版（true）**不得触发**。

### 行为变化（用户可见）

- **一轮对话 = 单轮**：模型调完工具、工具结果已执行，但**不再自动把结果喂回模型**——需要用户手动发「继续」才会发下一轮。
- 错误/截断/首轮失败**不再自动重试或重发**，直接收尾并提示手动继续。
- 用户首次发送仍直放（同文护栏除外，窗口内同文先弹确认）。

### 不碰

40303/40003 终局判定、额度墙、审批闸、MCP/技能运行期刷新、记忆注入——全部零改动（`response-classifier.ts` blob16 与 ⑫ 交卷态逐字相等）。

## 验证

- 全量闸 **exit=0**（GATE#141，1926.6s）；vitest 全量 **PASS**（344 files）；信息级红仅 upstream-drift（不阻塞）
- entry-freshness PASS（重建 entry.js 494,819 B，blob16 `941384b399d51eae`，safe-mode 锚 27 枚）；host-freshness PASS（main.mjs 842,012 B，sha8 断 `26 33 c2 ce`）
- CI run **46133038318**（head `27e1725`）：completed／success（gate=success／cargo-check=success／doc-drift-upstream-negative=success）
- 测试：新增 `risk-safe-mode.test.ts`（6 格：常量 true／工具调用结束⇒零续跑请求／429⇒不自动重试／截断⇒不自动重发／首轮失败⇒setBusy(false) 必达＋safe-mode 收尾／负控 `riskSafeMode:false` 覆盖⇒⑫ 节流在位）；22 件回归测试件加 `riskSafeMode:false` 覆盖（验节流版自动外发行为不被安全模式误伤）
- 独立窄面（PM 亲自现跑）：tsc EXIT=0＋22 件窄面 191/191 EXIT=0
- 仓外负控：shared 常量 `RISK_SAFE_MODE` 改 false ⇒ ⑬ 全部 5 格红（自动外发请求出现＝⑫ 节流在位）；还原复绿、真树 SHA 全程未动

真机「安全模式行为」格（工具调用后无自动续跑、需手动「继续」）与 ⑫④ confirm 弹窗格由出资人换新号登录后实测兜底——这两个格是行为级，机制层由单测＋负控＋产物面定论。
