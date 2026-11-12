---
title: deepseek-studio 只读代码审计·续审第 1 轮（前端会话层 · 2026-11-12 14:26）
summary: 逐行读 src/ui 三个会话层文件（studio-chat-ui.ts 1378 行、studio-chat-room.ts 903 行、studio-ui-core.ts 412 行，共 2693 行）。上轮两个可疑项有了结论：finishAssistantMessage 幂等（靠 currentAssistant=null 守卫），重复收尾不会双渲；但重发前无人清空旧气泡，R6-02 从 P3 升 P2。新增 2 条：U1-01（P2）断线重连后 roundInProgress 永久锁死、输入框与发送钮一直禁用；U1-03（P3）props.html 死原语仍在（零调用方、无运行时校验）。
---

# deepseek-studio 代码审计·续审第 1 轮（前端会话层）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未跑 typecheck/vitest/tauri dev、未启动长驻进程。

## 一、基线与范围

| 项 | 实测值 |
|---|---|
| HEAD | `b3c058c`（master） |
| 未提交文件 | 5 个：`src/inject/main-world-interceptor.ts`、`src/inject/response-classifier.ts`、`tests/desktop/{qd-r4-fetch-path-regression,qd-r4-stream-break-regression,response-classifier}.test.ts` |
| `git status --porcelain -- src/ui` | **空**（`src/ui` 无未提交改动） |
| 审计文件 | `studio-chat-ui.ts` 64,347 B / 1378 行；`studio-chat-room.ts` 34,069 B / 903 行；`studio-ui-core.ts` 16,695 B / 412 行 |

**脏文件对结论的影响**：本轮审的全在 `src/ui`（干净），前五个脏文件不在本轮范围；但它们正是第 5/6 轮结论的来源，因此本报告引用 `main-world-interceptor.ts:2348`、`:2352` 等处时，对应的是**含未提交改动的工作区版**。

**本轮边界**：不涉及 Rust 侧、`task-loop`、`memory`。

## 二、两个遗留可疑项的结论

### Q1：重复收尾是否幂等——结论：**幂等，不会双渲**

上轮可疑：`main-world-interceptor.ts:2348` 先 `finishAssistantMessage({recordFinal:false})`，`escalateFirstAttemptFailure` 的两个分支又各调一次。

读实现体（`studio-chat-ui.ts:874-932`）后的结论：

1. 首行 `:875 if (!currentAssistant) return;` 是**唯一必要的守卫**：首次调用末尾在 `:927-928` 把 `currentAssistant = null`、`currentRawText = ''` 清掉，所以第二、三次调用直接在第 875 行返回，既不追加气泡也不重复 `recordFinal`（`recordFinalPending` 已在 `:926` 置 false）。
2. `recordFinal` 的记账也是幂等的：`:910` 的条件带 `recordFinalPending`，而该标志只在 `startAssistantMessage` 的 `:810` 重新置 true（即新气泡）。
3. 因此**不存在**“重复追加消息”或“覆盖已有气泡”：`finishAssistantMessage` 只做两件事——把 `.ds-sc-streaming` 换成 markdown（`:885-893`）或在没有可见正文时删除它（`:894-899`）。

**但幂等的代价是一个真风险（不入清单，供 R6-01 修复时参考）**：幂等靠“第一次就把 `currentAssistant` 置空”实现，因此**任何一次提前收尾都会吞掉后续真正的收尾**（`:875` 直接 return）。R6-01 的“半截答案静默停摆”在 UI 侧正是这个形态：`main-world-interceptor.ts:2348` 已经收掉了气泡，后续再无人能把它收成“完成”或“错误”。

### Q2：重试是否接在旧半截后面——结论：**前端根本不为重发做任何清理，R6-02 升 P2**

读实现体后的证据链：

1. `startAssistantMessage`（`studio-chat-ui.ts:752-815`）**每次都是 `document.createElement` 新建节点**（`:755`）并 `messageList.appendChild(msg)`（`:805`），从不碰上一个气泡；
2. `finishAssistantMessage` 只改节点内容：有正文时 `streaming.replaceWith(markdownDiv)`（`:893`，旧正文以 markdown 形式**永久留在列表里**），无正文时 `streaming.remove()`（`:898`，只删流式容器，气泡壳与 sender 行还在）；
3. 全模块**没有“删除当前助手气泡”的原语**：`clearMessagesForSession` 是整列表清空，只在切会话（`:1202`）与 `clearHistory` 里调，重发路径一处未调。

**结论**：重发前无人清空——旧半截（若是正文则已渲染成 markdown，若是被剥的工具标签则只剩一行“已隐藏…”提示）与新回复并排出现。按用户的判据，这从 P3 **升为 P2**，详见第三节 U1-02。
## 三、状态机与授权呈现（Q3/Q4）

**setBusy 的语义（`studio-chat-ui.ts:934-937`）**：只改状态点 class 与文字（`执行中…` / `完成`），**不持有任何状态、不参与任何门控**。重复提交的拦截在宿主侧（`agent-loop.ts:90-92` 的 `agent-busy`），前端无二次确认。因此 R6-01 里那句 `setBusy(false)` 的实际效果是：状态栏先报“完成”，而本轮实际停在半截——**状态栏在说谎**。

**流式重复渲染**：`scheduleStreamRender`（`:824-830`）80ms 节流 + `renderStreaming`（`:831-844`）全量重算 `innerHTML`，同一 streamId 多次回调是幂等的（最终态只取决于 `currentRawText`），无重复追加风险。

**切换会话的竞态**：`activateSession` 用 `sessionGeneration`（`:1165` 自增、`:1214` 比对）做陈旧响应丢弃，切会话不会把旧会话的历史盖到新会话上；`route:` 临时桶分支额外有 `if (currentAssistant !== null) return;`（`:1200`）“回合在飞不清屏”守卫。这两处写法正确。

**授权呈现（R3-01 已修，只核呈现）**：`consent.ts:340-352` 的 `scopeHint` 把“工具 · 风险类 · 目标”三段自然语言拼在一行（原始协议名只进 trace）；按钮集为“允许一次 / 本次对话始终允许”（`:371`），高风险时降为只有前者并附说明（`:379-380`）；四个动作按钮的回调都先校 `e.isTrusted !== true` 就返回（`:432`）。呈现与 R3-01 修复后的授权语义**已对齐**（目标显形、不再无限放行），本项无需再改。

## 四、新增缺陷清单（2 条 + 1 条升 P2）

### U1-01（P2）断线重连后 roundInProgress 永久锁死：输入框与发送钮一直禁用

**file:line**：`studio-chat-room.ts:181`（`roundInProgress` 声明）→ `:542`（发送时置 true）→ `:539`（`if (!text || roundInProgress || !connected) return;` 硬门）→ `:204-210`（`ws.onclose` 只置 `connected=false` 并 `scheduleReconnect()`，**不碰 `roundInProgress`**）→ `:198-203`（`ws.onopen` 只改状态点与文字，**不同步/不复位**）→ `:283-290` 与 `:335-344`（唯一的两个复位点都是服务端推送的 `done` / `round-complete`）。

**触发条件**：专家讨论进行中（`roundInProgress === true`）WebSocket 断开（网络抖动、宿主重启、10s 退避期间）。

**影响**：复位信号只走同一条已断的 WS，重连后无人补发→ `roundInProgress` 永远 true→ `:539` 直接 return、`input.disabled = true`（`:552`）、发送钮文案停在“进行中…”。用户只能关窗重开；且 `thinkingBots` 也不会在重连时清空，会留下陈旧的“思考中”指示器（只在 `:278`/`:284`/`:295` 的事件分支里删）。

**证据类型**：代码级（状态生命周期四跳闭合，无需运行时）。

**修复建议**：`ws.onopen` 里做一次状态对齐（`roundInProgress = false; thinkingBots.clear(); updateComposerState();`），或给 `roundInProgress` 加超时自动释放（如 3×轮时长上限）。

**验收判据**：单测模拟“发送后断线→重连”，断言 `input.disabled === false` 且发送钮文案回到“发送”；当前无任何用例覆盖断线路径。

### U1-02（P2，从 R6-02 升级）重发前无人清空旧助手气泡，新旧回复并排

**file:line**：`studio-chat-ui.ts:752-815`（`startAssistantMessage` 恒新建节点，`:755`/`:805`）→ `:885-893`（`finishAssistantMessage` 把旧正文换成 markdown 留在列表里）→ `:898`（无正文时只删 `.ds-sc-streaming` 容器，气泡壳与 sender 行仍在）→ 重发路径无一处调 `clearMessagesForSession`（它只在 `:1202` 与 `clearHistory` 里）。

**触发条件**：`event: hint` 的 `clear_response: true`（限流帧）或工具标签截断后自动重发（R6-02 / R6-01 两条重试链都走这里）。

**影响**：用户在同一个问题下看到两段助手回复：前半截（已被服务端判为无效并要求清空）+重试后的完整回复；若半截是工具标签，则是一行“已隐藏…”提示后接完整回复。R6-02 只说了“分类器没读 `clear_response`”，本条补上 UI 侧事实：**即使分类器读了，前端也没有可调的清理原语**。

**证据类型**：代码级。

**修复建议**：给 `StudioChatUIHandle` 增 `discardOpenAssistantBubble()`（删当前气泡节点并清三个累积变量），由重试链路在重发前调用；不要用 `clearMessagesForSession`（会连用户消息一起清）。

**验收判据**：新增单测——先 `appendToAssistantMessage('半截')` 再 `finishAssistantMessage({recordFinal:false})` 再 `startAssistantMessage()`，断言 `messageList` 中助手气泡数为 1。

### U1-03（P3）`props.html` 死原语仍在，且无运行时校验

**file:line**：`studio-ui-core.ts:216-219`（`if (props?.html) element.innerHTML = props.html;`，上方 `:216` 是“仅接受静态模板或已经过 DOMPurify 的输出”的**约定式注释**）。

**结论**：上轮把 `:154` 定性为“死原语”，本轮复核：原语**未删除**，只是随文件重排移到了 `:216-219`；`git grep 'html:' -- src/ui` 与 `'{ html'` 均零命中（除 `.html` 静态文件本身）→ **仍为零调用方**。

**影响**：当前无 XSS；但它是一个“靠注释约束、无运行时 sanitize”的 `innerHTML` 写入口，一旦有人给组件传模型输出/记忆正文/工具结果即直接成为注入点（与 R2-01 的页面自答链叠加后危害更大）。

**证据类型**：代码级（全仓调用方检索）。

**修复建议**：直接删除该分支（零调用方无兼容成本），或改成 `DOMPurify.sanitize(props.html)` 并在类型上把 `html` 标为 `never`。

**验收判据**：删除后 `tsc` 无错（零调用方）；若有残留调用方则编译报错——这本身就是验收。
## 五、可疑未证实

1. **前端无轮次超时回滚**：`roundInProgress` 只能被服务端的 `done`/`round-complete` 解开，`reqId`（`:545`）只用作发送去重键，没有任何“服务端无响应”的客户端超时。缺：服务端 `handleUserMessage` 是否保证每条 `send` 必推一次 `round-complete`（异常/抛错分支是否包 finally）。
2. **`isTrusted` 会误伤键盘/辅助技术以外的入口**：`consent.ts:432` 要求真实手势，若将来加快捷键（如 Alt+Y 批准）会被静默丢弃。缺：产品对快捷键审批的预期。
3. **`attachCopy` 的剪贴板异常未包**：`chat-ui` 的复制按钮回调未逐个读完，超长消息时 `navigator.clipboard.writeText` 可能抛 Promise rejection。缺：该函数完整实现。
4. **孤儿错误抑制可能误丢**：`recordEvent` 在 `:625-628` 对“本回合无 user-message”的 `system-error` 直接丢弃；若 `currentTurnId` 在助手续跑时未更新，真实错误会被静默丢掉。缺：真机日志比对。
5. **room 的 token 仍走 query string**（`studio-chat-room.ts:190`）：与 TD-02 的 bootstrap grant 同源，本轮未重审。
6. **`clearHistory` 无代次保护**：`sessionGeneration` 只护 `activateSession`（`:1165`/`:1214`），`clearHistory`（`:1365` 附近）会直接令 `currentAssistant=null` 并清列表；与在飞回合并发时的行为未验证。

## 六、覆盖与未覆盖

**逐行读完**（约 1,500 行）：`studio-chat-ui.ts:348-1378`（工厂体：状态变量、inspector、recordEvent、消息增删、流式节流、`finishAssistantMessage`、`setBusy`、工具卡、`appendError`、历史重放、`activateSession`）；`studio-chat-room.ts:97-300` 与 `330-610`（连接/重连/消息分发/结构化事件/发送/开关）；`studio-ui-core.ts:140-230`。

**扫读/抽样**（约 1,190 行）：`studio-chat-ui.ts:1-347`（接口声明 + `injectChatStyles` + 四段布局测量函数，无业务状态）；`studio-chat-room.ts:615-903`（单一 `CHAT_ROOM_CSS` 模板字符串）与 `48-96`（事件类型声明）；`studio-ui-core.ts:1-139`、`230-412`（容器/样式工具）。这三段不含状态机与渲染分支，不影响本轮 5 个问题的结论。

**未覆盖**：运行期验证（未跑 vitest）；`navigator.clipboard` 与真实 WebView 手势行为（`isTrusted` 在 WebView2 下的实际取值）；服务端 `round-complete` 的必达性（属宿主/bot 层，不在本轮范围）。

## 七、修复优先级

1. **U1-01（P2，约 3 行）**：`ws.onopen` 里复位 `roundInProgress` + 清 `thinkingBots` + `updateComposerState()`。验收：断线重连后输入框可用。
2. **U1-02（P2）**：新增 `discardOpenAssistantBubble()`，在重发前调用（与 R6-02 的分类器修复配套，否则只修分类器不修渲染，用户依旧看到两段）。验收：重发后助手气泡数为 1。
3. **U1-03（P3，删代码）**：删除 `studio-ui-core.ts:216-219` 的 `props.html` 分支，靠编译报错验收零调用方。
4. **遗留 7 条**：按第 5/6 轮顺序，本轮未变。

---

**本轮工作量与结果**：读 3 个文件、共 2,693 行（逐行约 1,500 行、扫读 1,190 行）；新增 **2 条**（U1-01 P2、U1-03 P3）+ **1 条升级**（R6-02 P3 → U1-02 P2）；两个遗留可疑项的结论：Q1 **幂等不成立缺陷**（`finishAssistantMessage` 靠 `currentAssistant=null` 守卫，重复收尾是 no-op），Q2 **升 P2**（前端无清理原语，`startAssistantMessage` 恒新建）。可疑未证实 6 条。未读完：`studio-chat-ui.ts` 样式/测量段、`studio-chat-room.ts` 的 CSS 字符串、`studio-ui-core.ts` 容器工具段（均无状态逻辑）；未做运行期验证。