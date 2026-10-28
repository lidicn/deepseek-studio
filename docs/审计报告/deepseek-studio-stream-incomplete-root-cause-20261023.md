---
title: deepseek-studio「执行未完成 / 模型回复未完整接收（连接中断）」根因定案
summary: 本轮用 storage.json 的事件时间戳把故障钉死在毫秒级：2026-10-23 14:06:42.185 用户消息落库后，141ms、99ms、4ms 内连续冒出「正在自动重试（1/2）」「（2/2）」「已自动重试 2 次仍失败」三条错误，而 2s/4s 的退避窗口一个都没走完，说明一次重试都没有真正发出。真实根因不是网络断流，也不是站点改协议：判定器把「结束」压缩成跨请求共享的单个布尔量 loopState.streamSawDone，被 5 处重置、被任意一条 chat XHR 的 readyState=4 结算，同一 turn 内重复结算 3 次就把 2 次预算烧穿；同时帧解码器的 finish() 全项目零调用，尾部不带空行的最后一帧永远吐不出来。文案里的「连接中断」只是硬编码主语，不代表任何网络事实。
---

# deepseek-studio「执行未完成」根因定案

> 评审对象：`E:\NAS\deepseek-studio`
> 评审方式：只读。未启动 GUI、未登录、未向 chat.deepseek.com 发任何请求、未装依赖、未跑 build/typecheck/vitest、未做 git 写操作。
> 所有行号为本轮 16:21–16:45 读取时的工作区快照。`src/inject/main-world-interceptor.ts` 在评审期间被改动过（mtime 2026-10-23 16:40:06，比 16:21 首读时整体下移约 8 行），引用以锚点文本为准。

---

## 0. 结论速览

**先给结论，再给证据。**

1. **文案骗人。** 「模型回复未完整接收（连接中断）」这句话不是诊断结果，是 `settleStreamEnd` 里一个硬编码中文主语，条件只有一个：**HTTP 状态不是 0/429/5xx、也不是 401/403/402/4xx，且本轮没看到完成哨兵**。它跟「网络有没有断」没有因果关系。真正的网络断连（`xhr.status===0`）走的是另一条分支，文案是「服务器暂时无法访问」。详见第 2 节。

2. **「已自动重试 2 次仍失败」是假账。** 本轮从 `~/.config/deepseek-studio/storage.json`（1,275,906 字节，27 个会话、411 条事件）里取到了唯一一次 `stream-incomplete` 的真实事件序列：同一会话、同一 turnId、四条事件落在 **243 毫秒**之内（141ms / 99ms / 4ms）。而 `errorBackoffMs(0)=2000+` 、`errorBackoffMs(1)=4000+` 的退避窗口一个都没走完。**一次重试请求都没发出去**，计数器就被三次结算推到上限。详见第 3 节。

3. **主因是状态模型，不是协议、不是网络、不是 Electron。** 「这一轮有没有收到哨兵」被压缩成一个跨请求共享的布尔量 `loopState.streamSawDone`：写入点 1 个（XHR 路径），重置点 5 个，结算点散落在两条传输路径上，且结算时只看全局值、不看「这个哨兵是哪条流见到的」。任何一次并发（同一 turn 内多条 chat XHR、跨 turn 的迟到流、页面自己的重发）都会让 A 流的结算读到 B 流的状态。

4. **次因是一个从没被调用过的函数。** `DeepSeekSseFrameDecoder.finish()`（`deepseek-sse-frame-decoder.ts:31-39`）全项目**零调用**——XHR 路径只 `push` 不 `finish`（`main-world-interceptor.ts:928`），fetch 路径同样只 `push`（`:715`）。解码器按「空行」切帧，**尾部没有空行的最后一帧永远留在 buffer 里**，`framesSignalStreamCompletion` 看不到它。这条通道会让「服务端发了 FINISHED、我们没认出来」变成静默失败。

5. **已排除的三条流行解释**：站点改协议（20 份真实抓包 11/11 都带哨兵，且用 185 字节的算术对上了字节级格式）、代理/网络（本机 `ProxyEnable=0`、WinHTTP 直连、无 Clash/v2ray 类进程）、渲染层/Electron（本轮故障全程不涉及渲染进程退出）。另外**也不是「改了没生效」**：运行中的注入包 `src-tauri/inject/entry.js`（2026-10-23 16:00:48，362,079 字节）确实包含 QD-R5 的全部新文案（`模型回复未完整接收`×3、`已自动重试`×4、`FINISHED`×2），而 `deepseek-studio.exe` 是 16:11:08 启动的，晚于打包时间。

---

## 1. 基线与证据来源

### 1.1 仓库基线

| 项 | 值 | 取法 |
|---|---|---|
| 分支 | `feat/bot-core` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `dcededed3443f7454e6d45bcff62d96829c3ca25`（2026-10-22 18:28:02 +0800，`fix(studio-ui): reach dotted tool ids and gate model tool surface`） | `git log -1` |
| 提交数 | 198 | `git rev-list --count HEAD` |
| 脏改动 | 183 条（16:20 首次统计 182，评审期间仍在变动） | `git status --porcelain` |
| 未跟踪 | 950 条 | `git ls-files --others` |
| 注入源码 mtime | `src/inject/main-world-interceptor.ts` 2026-10-23 16:40:06（评审期间被改） | `Get-Item` |
| 注入产物 | `src-tauri/inject/entry.js` 2026-10-23 16:00:48，362,079 B；`src-tauri/target/debug/inject/entry.js` 同尺寸同时间 | `Get-Item` |
| 运行中进程 | `deepseek-studio` PID 31912，启动 2026-10-23 16:11:08 | `Get-Process` |

**结论对应的状态**：代码结论对应上述工作区（16:40 前后）；运行态结论对应 16:00:48 的 `entry.js` + 16:11:08 启动的进程。因为工作区 183 条脏改动且评审期间仍在被编辑，任何「行号级」引用都可能漂移；本文所有关键论断都同时给了锚点文本。

### 1.2 用到的证据源（全部为本轮现读，无一条来自推测）

| 源 | 位置 | 规模 | 用途 |
|---|---|---|---|
| 真实 SSE 抓包 | `logs/cdp-chat-capture/*-response-body.txt` 等 | 20 个响应体 + 20 份请求 JSON + meta | 协议实况（第 4 节） |
| 协议验证算术 | `logs/runtime-out.log:585` | 1 行 | 185 字节切片的字节级校验 |
| 注入层 diag 实跑输出 | `logs/runtime-out.log` | 1,117 行 | 确认 chat 走 XHR、哨兵曾正常抵达 |
| 执行事件库 | `C:\Users\lidicn\.config\deepseek-studio\storage.json` | 1,275,906 B / 27 会话 / 411 事件 | 真实失败分布（第 3 节） |
| sidecar 崩因 | `%APPDATA%\deepseek-studio\logs\crash.jsonl` | 838 行 | 宿主侧区分判据（第 5.5 节） |
| 注入源码 | `src/inject/main-world-interceptor.ts` | 1,833 行（现） | 判定条件树（第 2 节） |
| 帧解码器 | `src/inject/deepseek-sse-frame-decoder.ts` | 150 行 | 哨兵定义与切帧 |
| 文本提取器 | `src/inject/sse-text-extractor.ts` | 238 行 | 两条解析器的边界假设差异 |
| 响应分类器 | `src/inject/response-classifier.ts` | 185 行 | fatal/retryable 边界 |
| UI 错误卡 | `src/ui/studio-chat-ui.ts` | 1,201 行 | 三段文案的装配关系 |

### 1.3 一个必须先说的事：这次故障几乎不可能留下证据

这是「开发者修了两次都没解决」的元原因。

- 采集器 `interceptorTrace` 是**内存环形缓冲**（`createStudioTraceCollector()` 在 `main-world-interceptor.ts:141` 构造），只在页面内存里活着，暴露为 `globalThis.__studioTraceReport`。
- `trace-store.ts` 里那个 `localStorage['ds-studio-traces']`（`trace-store.ts:43`）**在运行时根本不会被写**：`getAllTraces/saveTrace/createTrace` 三个函数全项目零调用（全仓 grep 只有定义处命中）。上一轮若按「读 `ds-studio-traces`」去找现场，必然什么都读不到——这不是没发生，是没落盘。
- 注入层的 `diag` 最终只走到 `console.log`（`src/host/page-runtime.ts:313`）。桌面快捷方式启动时 stdout 没有接收端，`logs/runtime-20261021/*.stdout.log` 那批能看到 `[interceptor] xhr resp[...]` 是因为当时用重定向跑过开发态。
- 我在 `E:\NAS\deepseek-studio\logs`（含 chrome-profile / edge-profile）、`%APPDATA%\deepseek-studio\profiles\*`、`%LOCALAPPDATA%` 下全量 `findstr` 过 `stream-incomplete` 与 `no completion sentinel`，**命中 0 次**。

所以本轮能定案，靠的是 `storage.json` 里被 UI 顺手记下来的 `system-error` 事件时间戳——它不是为诊断设计的，但它有毫秒。反过来说：**第 7 节的第 4 层（可观测性）不是锦上添花，是这个故障能不能被修好的前提**。

---

## 2. 文案到代码的判定条件树

### 2.1 三条文案分别来自哪里

| 用户看到的 | 定义处 | 性质 |
|---|---|---|
| `stream-incomplete`（小字） | `main-world-interceptor.ts` 里作为 `code` 传入；UI 原样渲染 `meta.textContent = code`（`studio-chat-ui.ts:895`） | 错误码，不是文案 |
| `执行未完成`（标题） | `studio-chat-ui.ts:889` `title.textContent = '执行未完成'` | **固定标题**，所有错误码共用 |
| `模型回复未完整接收（连接中断），已自动重试 N 次仍失败。请检查网络后手动重试。`（正文） | `main-world-interceptor.ts:1389`，模板 `${why}，已自动重试 ${firstAttemptRetryCount} 次仍失败。请检查网络后手动重试。`，`why` 由调用方传入 | 唯一能产出用户截图那句的位置 |

`why` 的两个取值：`'服务器暂时无法访问'`（网络/5xx/限流）与 `'模型回复未完整接收（连接中断）'`（哨兵缺失）。用户贴的是后者。

### 2.2 判定条件树（XHR 路径为主，fetch 对称）

```
页面发 POST /api/v0/chat/completion        ← 实测走 XHR，不是 fetch（§4.1）
  │
  ├─ proto.send 包装（:824 起 installXhrHooks，send 包装约 :850）
  │    ├─ 命中 chat 端点 → captureChatRequest(:584)
  │    │     └─ 判定「新用户消息」→ onNewUserMessage() → 重置 firstAttemptRetryCount=0(:1471 区间)
  │    ├─ loopState.streamSawDone = false        ← 重置点①  (:880)
  │    └─ 装上 onreadystatechange 包装（:889 起）
  │
  └─ readyState>=3 每次回调
       ├─ part = responseText.slice(xhr.__dsScanned)     (:904-906)
       ├─ frames = frameDec.push(part)                    (:928)
       ├─ framesSignalStreamCompletion(frames) → streamSawDone = true   ← 唯一写入点 (:943)
       │     命中条件（decoder:134-149）: event:close  ‖  {"p":"response/status","v":"FINISHED"}
       │                                ‖  BATCH 内 {"p":"quasi_status","v":"FINISHED"}
       └─ readyState===4
            ├─ parser.flush()  尾部未闭合工具标签 → streamTruncatedTag
            ├─ settleStreamEnd(loopState, pending, xhr.status)        (:1003)
            │    ├─ abortedByUser → 静默收尾，不报错、不重试（:1112 区间）
            │    ├─ streamTruncatedTag → 'tool-call-truncated'，文案「工具调用被网络中断截断」
            │    ├─ streamSawDone===true → return false（正常，交给业务收尾）
            │    └─ streamSawDone===false
            │         ├─ classifyResponse(httpStatus) === 'fatal'  → return false，改由分类器出「请求失败（auth-billing-401）」
            │         ├─ loopState.inAutoContinue === true         → return false（续跑轮不在此结算）
            │         └─ 否则 → escalateFirstAttemptFailure(
            │                     httpVerdict==='retryable' ? 'network-error' : 'stream-incomplete',
            │                     httpVerdict==='retryable' ? '服务器暂时无法访问' : '模型回复未完整接收（连接中断）')
            │              └─ escalate(:1373)
            │                   ├─ count >= 2 → appendError(code, `…已自动重试 2 次仍失败。请检查网络后手动重试。`)
            │                   └─ count < 2  → count++ → appendError(`…正在自动重试（N/2）...`)
            │                                   → scheduleFirstAttemptResend(errorBackoffMs(count-1))  (:1351)
            └─ if (!loopState.inAutoContinue) { classifyResponse → 各种文案 }  ← 与上面的分支互斥
            └─ prev(…) 调用页面自己的 handler                    (:1040)
```

**关键判据（可直接拿去对号入座）：**

| 分支 | 成立条件 | 产出文案 | 是否消耗首轮预算 |
|---|---|---|---|
| A 网络断连 | `xhr.status===0` | 服务器暂时无法访问 | 是 |
| B 限流/5xx | 429 或 5xx | 服务器暂时无法访问 | 是 |
| C 鉴权/参数 | 401/402/403/4xx | 请求失败（auth-billing-xxx / client-400） | **否** |
| D 流内错误帧 | `event: error` 或载荷 `code∈{0,429,500}` 且带 error/message | sse-error-frame / sse-error-payload | 视 verdict |
| E 工具标签截断 | `parser.flush()` 残留含 `<` | 工具调用被网络中断截断 | **否**（直接报，不重试） |
| F **哨兵缺失** | HTTP 非 A/B/C，且 `!streamSawDone` | **模型回复未完整接收（连接中断）** | 是 |
| G 用户中止 | `__dsAborted` | 无（静默） | 否 |
| H fetch 抛错 | `response.body` 读取抛错 | 读取模型回复时连接中断（`stream-error`） | **否**（文案不同！） |

**所以：「连接中断」这四个字对应的是分支 F，而分支 F 的定义里没有「连接」这个变量。** 它是「我们没见到结束标记」的同义词。分支 H 才真的是读流出错，但它的文案是「读取模型回复时连接中断」，与用户截图不同——这一步就把「网络真的断了」排掉了。

### 2.3 顺手发现的一处死代码（会误导后来人）

`settleStreamEnd` 里还有一段 `appendError('stream-incomplete', …已自动重试 N 次仍失败…请稍后手动重试…)` 的兜底分支（`main-world-interceptor.ts:1165-1173`，锚点 `请稍后手动重试`）。它**永不可达**：上一行 `if (loopState.inAutoContinue) return false;` 已经对同一条件 return，紧随其后的 `if (!loopState.inContinue)` 恒为真且必然 return true。这段死代码的解释是「用户截图那句只能由 escalate 产出」——**这是本轮把 3 条错误定位到 escalate 的推理支点，也是「请稍后手动重试」与截图「请检查网络后手动重试」措辞差异的来源**。建议直接删掉，否则下一个人还会以为这里有第二条路径。

---

## 3. 真实失败的分布与归因（带分母）

### 3.1 分母

`storage.json` → 27 个 `studio.execution.v2.session.*` → 411 条事件：

| 事件类型 | 条数 |
|---|---|
| tool-start | 152 |
| tool-result | 151 |
| final-answer | 50 |
| user-message | 42 |
| system-error | 16 |

`system-error` 的 16 条按 code 拆：

| code | 条数 | 时间窗 | 备注 |
|---|---|---|---|
| `network-error` | 8 | 2026-10-21 21:18:10 → 2026-10-22 17:13:56 | 文案「服务器暂时无法访问。本轮消息不会自动重发…」→ 来自 **分支 C/A 的 else 支**，不是哨兵缺失 |
| `body-error-0` | 3 | 2026-10-21 00:18:49 / :53 / :53 | 「请求失败（body-error-0）」→ 200 内嵌错误体，被分类为 fatal |
| `auto-continue-failed` | 2 | 2026-10-21 07:53:37 / 07:58:31 | 「PoW challenge failed: 422 {"detail":[{"loc":"body"}]}」 |
| `stream-incomplete` | 3 | **2026-10-23 14:06:42（同 1 秒）** | 用户截图这一族，全部来自同一个 turn |

> 口径说明：这是「UI 记录下来的错误事件」的分母，不是「所有流」的分母。`storage.json` 只记录被 `appendError` 上屏的错误；成功轮次只有 `final-answer`（50 条），因此「哨兵缺失 / 出过答案的轮次」≈ 3/53。它**不能**代表「所有 chat 请求的失败率」——因为大量失败可能从未上屏（见 §5.6）。另外 8 条 `network-error` 的文案是「本轮消息不会自动重发」，说明它们走的是**分类器**分支而不是 escalate 分支，与本次故障不是同一条路径。

### 3.2 那一次的毫秒级现场（决定性证据）

会话 `studio.execution.v2.session.2089f743ef7d99e5`，key `chat:0c61d430-25e5-4dab-802d-507b58fae89a`，createdAt 14:06:42.584，updatedAt 14:07:00.276，13 条事件：

```
14:06:42.185  user-message      turn=7cb6463f-3ef0-4471-bf88-982ed61bf01c
14:06:42.326  system-error      stream-incomplete  「…正在自动重试（1/2）...」   +141ms
14:06:42.425  system-error      stream-incomplete  「…正在自动重试（2/2）...」   +99ms
14:06:42.429  system-error      stream-incomplete  「…已自动重试 2 次仍失败。请检查网络后手动重试。」  +4ms
14:06:43.335  tool-start        turn=c14e0eb3-a956-46eb-9c11-3d58e450e881   ← 换了一个 turnId
14:06:47.887  tool-start        turn=c14e0eb3…
14:06:47.939  tool-result       turn=c14e0eb3…
14:06:49.960  tool-result       turn=c14e0eb3…
14:06:50.320  tool-start        turn=c14e0eb3…
14:06:52.950  tool-start        turn=c14e0eb3…
14:06:53.126  tool-result       turn=c14e0eb3…
14:06:54.059  tool-result       turn=c14e0eb3…
14:07:00.276  final-answer      turn=c14e0eb3…
```

从这 13 行能直接读出四个硬事实：

**（1）三次结算发生在 243 毫秒内，重试一次都没发。**
`escalate` 的第一次调度延迟是 `errorBackoffMs(0)`，`response-classifier.ts:127-130` 的实现是 `min(2000·2^attempt, 8000) + jitter`，即 ≥2000ms。第二次 ≥4000ms。三次错误在 243ms 内到齐，**第二次、第三次不可能是重发链的产物**——重发链此刻连第一个 `setTimeout` 都还没触发。所以三条错误 = 三次独立的 `settleStreamEnd → escalate`，一次真重试都没有。

**（2）预算按「结算次数」计，不按「实际发出的请求数」计。**
`firstAttemptRetryCount` 是模块级单值（`:168`），`escalate` 进去先判 `count>=2` 再 `count+=1`（`:1373` 起）。任何一条不相关的 chat XHR 走完 `readyState=4` 都会被记一次账。243ms 内三次结算 ⇒ 预算瞬间烧穿 ⇒ 第 3 条错误在用户看来就是「重试 2 次都失败了」。

**（3）同一时刻有两个 turnId 在跑。**
`7cb6463f…` 在报错，1.1 秒后 `c14e0eb3…` 开始跑工具并在 18 秒后出了 `final-answer`。也就是：**同一个用户消息下，执行链并没有死**，后面的工具与最终答案都正常完成。这直接否掉「服务端流断了/站点挂了」：真断了，那条链不可能在 1 秒后继续跑 4 个工具并出答案。

**（4）失败发生在「用户消息落库后 141 毫秒」。**
141ms 不够任何一次真实生成开始；它够的是一个**立刻结束的响应**（空体、`{}`、或非 SSE 的错误体）。这正好落在分支 F 的分类死角里：`classifyResponse(200, 空/非错误 JSON)` 返回 `'ok'`（`response-classifier.ts:73-89`，其中 `:59` 明确写着「单独 code:0 绝不能误报为上游失败」），于是「没有哨兵」被读成「流被截断」，而不是「这一轮压根没有流」。

### 3.3 归因结论

| 候选 | 成立？ | 依据 |
|---|---|---|
| 网络真的断了 | **否** | 分支 F 的定义里没有网络变量；真断连走 A（status 0）或 H（fetch 抛错），文案都不是这句 |
| 站点改了协议 | **否**（有证据强度上限，见 §4.4） | 11/11 抓包带哨兵；185 字节算术对上字节级格式；同一会话 1 秒后另一条链路正常 |
| 代理/中间盒截断 | **否** | `ProxyEnable=0`、`netsh winhttp` 直连、无代理进程 |
| 渲染层/Electron | **否** | 本轮无 `render-process-gone`、无窗口无响应 |
| **判定器状态被并发/重入污染** | **是（主因）** | 243ms 三次结算 + 两条 turnId 并存 + 全局单布尔 |
| **尾部帧从未 flush** | **是（次因，可造成的漏判通道）** | `finish()` 零调用（§5.1） |
| **重试不幂等 / 计数器跨轮泄漏** | **是（放大器）** | `parent_message_id` 被改写（`:1543`）、count 只在新用户消息时重置（`:1471`） |

**一句话根因**：这条故障不是「流断了」，而是**「结束」这件事被建模成了一个不属于任何一条流的全局布尔量**，于是它既会被别的流清掉、也会被重复结算；而结算的代价是重试预算，预算又是全局的，于是三次误判在 243 毫秒内把「重试 2 次」烧成了既成事实——用户看到的是「重试两次都失败」，实际发生的是「一次都没重试」。
---

## 4. DeepSeek 当前流协议实况（以真实抓包为准）

### 4.1 传输不是 WebSocket，端点也仍是 completion

- **chat 走 XHR，不走 fetch。** `logs/runtime-out.log` 全量统计：`] xhr POST ` 541 行、`] fetch POST ` 111 行；后者 109 行是 `/api/v0/telemetry`、2 行是站内埋点。`xhr POST /api/v0/chat/completion isChat=true bodyType=string` 命中 4 行（`:567 :591 :717 :742`）。**所以「是否已改用 WebSocket」的答案是：没有。**
- 仓库里的两个 WS 探针（`logs/ws-probe.mjs`、`logs/ws-lan-probe.mjs`）打的是 **Studio 自己的宿主通道** `ws://127.0.0.1:8760/agent-ws`，与 chat.deepseek.com 无关，不要拿它当协议证据。
- 20 份抓包里出现的端点：`chat/completion`（SSE）、`chat/create_pow_challenge`（JSON）、`telemetry`、以及 1 份 15,441 字节的非 SSE 体（`34740.130-response-body.txt`，含 `"cache_control":"REPLACE"`；本轮**未核实**它属于哪个端点，因为它可能与本次故障无关，仅登记）。
- 请求侧固定带 `x-client-version: 2.5.0`、`x-client-bundle-id: com.deepseek.chat`、`x-device-id`、`x-client-timezone-offset: 28800`；UA 是 `Microsoft Edge WebView2 ... Edg/155.0.0.0`（说明 Studio 用的是 WebView2 宿主页面，不是 Electron 窗口）。

### 4.2 字节级格式：LF + 空行分隔的 SSE

响应头（20 份中的 SSE 份）：

```
Content-Type: text/event-stream; charset=utf-8
x-ds-sse-heartbeat-timeout-secs: 8
server: CW
x-ds-served-by: chat
```

体（切片，来自 `34740.130` 之外的 11 份 completion 抓包）：

```
event: ready
data: {"request_message_id":…,"response_message_id":…,"model_type":"default"}

data: {"v":" "}                       ← 单字符增量
data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"…"}]}

data: {"v":{"response":{"status":"WIP","fragments":[…],"accumulated_token_usage":…}}}   ← 全量快照

data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: update_session
data: {"updated_at":1792552975.3423269}

event: close
data: {"click_behavior":"none","auto_resume":false}
```

**字节级校验（这条把「格式」钉死了）**：`logs/runtime-out.log:585` 记录了一次真实的 readyState 增量 `xhr resp[185]`，其内容为

```
data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: update_session\ndata: {"updated_at":1792552975.3423269}\n\nevent: close\ndata: {"click_behavior":"none","auto_resume":false}\n\n
```

逐段长度：54 + 2 + 21 + 1 + 41 + 2 + 12 + 1 + 49 + 2 = **185**，与日志里的 `[185]` 完全一致。说明分隔符就是单字节 `LF` + 空行，没有 `\r`、没有额外空格。

### 4.3 结束语义（哨兵）与「原样重发」的前提

- 哨兵有三种等价形态，`deepseek-sse-frame-decoder.ts:134-149` 全部覆盖：`event: close`、`{"p":"response/status","o":"SET","v":"FINISHED"}`、以及 BATCH 内的 `{"p":"quasi_status","v":"FINISHED"}`。
- 11 份 completion 抓包里，**三件套齐全的有 11 份（11/11）**：`quasi_status:FINISHED` + `response/status:FINISHED` + `event: close`。**没有任何一份是「流正常结束但没有 FINISHED」。**
- `[DONE]` 在 20 份里出现 **0 次**，与 `decoder:123-124` 的注释一致——旧式 DONE 判定确实是错的，这一点历史审计没有误判。
- `x-ds-sse-heartbeat-timeout-secs: 8` 说明服务端会持续发心跳，因此「长时间无数据被中间盒掐断」这条路径缺少机制支撑；本机也确实没有代理。
- `event: close` 的载荷里带 `auto_resume` 字段，说明**服务端自己就有一套「流没结束就续」的语义**。Studio 的自动重发是第二套。两套并存时，谁先动谁就把对方的假设打乱（见 §5.6）。

### 4.4 与「站点改用 WebSocket / 改了协议」的正面回答

**没有证据支持站点改用了 WebSocket 或更换传输。**

- 传输：10-21 的实跑日志里 chat 仍是 XHR POST → `text/event-stream`。
- 端点：仍是 `POST https://chat.deepseek.com/api/v0/chat/completion`，路径与 10-20 抓包一致。
- 帧格式：仍是 LF+空行分隔、`event:`/`data:` 双轨、旧式 `[DONE]` 从未出现。
- 结束信号：仍是三件套。
- 序号语义：仍是 `request_message_id` / `response_message_id` / `parent_message_id`。

**这条结论的证据强度上限，必须写在明处**：全部抓包集中在 **2026-10-20 07:51–08:14** 与 **2026-10-21 20:51–23:05** 两个窗口，共 20 个响应体；本轮**没有** 10-22 或 10-23 的抓包，也没有 10-23 的响应字节。所以严格表述是：「**截至最后一次真实抓包（2026-10-21 23:05），协议未变；10-22/10-23 是否变化无证据**」。不过本轮有一条独立旁证把「10-23 协议变了」压得很低：同一会话在 14:06:43 之后，另一条 turn 用同一套代码正常跑完 4 个工具并在 14:07:00 出 `final-answer`——如果 14:06 那一刻协议变了，1 秒后那条链不可能正常。

### 4.5 结构性风险：两条解析器的「帧边界」假设不一致

这是本轮最值得单独拎出来的一条**潜在**缺陷（不是本次故障的直接证据，但会让未来任何格式扰动变成「文字照显示、错误照报」）：

| 解析器 | 切分方式 | 遇到「只有单换行、没有空行」的流 |
|---|---|---|
| `SseTextStreamExtractor`（`sse-text-extractor.ts:101-110`） | `combined.split('\n')`，**逐行独立解析 `data:`** | **照常工作**，文字全部显示 |
| `DsSseFrameDecoder`（`deepseek-sse-frame-decoder.ts:82-125`） | 只在 `/\r?\n\r?\n/` 上切帧 | **一帧都吐不出来**，哨兵永远读不到 |
| `classifyResponse`（`response-classifier.ts:34`） | 只要 body 以 `event:`/`data:` 开头就跳过错误扫描 | 照常返回 `ok` |

三者叠加的结果是：**任何让「空行」消失的变化（服务端格式微调、中间层重排、分块方式变化），都会产生「答案文字完整显示 + 立即报『模型回复未完整接收（连接中断）』」这一个非常具体的症状组合**。这个组合与用户截图完全同形，也是「修了两次都在同一个地方打转」的原因之一：**只查哨兵在不在帧里，不查帧有没有被切出来**。

### 4.6 抓包顺带暴露的另外两条失败族（与本次不同，但别混在一起修）

- `auto-continue-failed / PoW challenge failed: 422 {"detail":[{"loc":"body"}]}`（10-21 两次，`storage.json` 有码有文案）。抓包 `704.1356` / `704.1623` 正是这两次：`POST /api/v0/chat/create_pow_challenge` 被 422 拒，body 是 `{"target_path":"/api/v0/chat/completion"}`。这两份请求头里有一个可疑之处：`"Content-Type": "application/json, application/json"`（**同一个头被写了两次，被 CDP 合并成逗号串**）。服务端对重复 Content-Type 报 `loc: body` 是完全可能的。也就是说 **PoW 挑战失败会直接掐死自动续跑**，这条与截断判据无关，属于独立 bug，建议单独修（`create_pow_challenge` 前显式 `setRequestHeader('Content-Type','application/json')` 一次，且不要在重放头里再带一份）。
- `body-error-0` × 3（10-21 00:18:49/:53/:53，三个会话）：200 内嵌错误体被判 fatal → 「请求失败（body-error-0），本轮消息不会自动重发」。注意 `response-classifier.ts:59` 明确写着「单独 code:0 绝不能误报」，说明这三个样本里 **code:0 与 error 字段同时出现**。这条路径的表现是「不重试、直接停」，与用户截图不同。

---

## 5. 数据消费与重试语义的缺陷清单

每条都给：现象 → 位置 → 后果 → 证据。

### D1（P0）帧解码器的 `finish()` 全项目零调用 → 尾部帧永远出不来

- 位置：`deepseek-sse-frame-decoder.ts:31-39` 定义 `finish()`（注释写着「处理最后未以空行结尾的尾帧」）；调用点 grep 全仓 **0 处**——XHR 路径只有 `frameDec.push(part)`（`main-world-interceptor.ts:928`），fetch 路径只有 `frameDec.push(rawSse)`（`:715`）。
- 后果：解码器必须见到空行才切帧。**如果最后一块在空行之前就结束（连接关闭、分块边界、服务端省略尾部空行），`FINISHED` 就永远留在 `this.buffer` 里**，`framesSignalStreamCompletion` 不可能看到它。
- 证据：源码 grep（本轮 16:32 与 16:40 两次确认）+ `decoder` 的切帧实现（只匹配 `\r?\n\r?\n`）。
- 这是「哨兵缺失」最干净的一条**可证**通道，也解释了为什么它**间歇**发生：取决于最后一块是否恰好含着尾部空行。10-21 那次（§4.2）恰好含着，所以正常。

### D2（P0）「是否结束」是跨请求共享的单个布尔量

- 写入点 **1 个**：`:943`（XHR）、`:715`（fetch）里 `framesSignalStreamCompletion(...) → loopState.streamSawDone = true`。
- 重置点 **5 个**：`:670`（fetch 开始）、`:880`（XHR send 前）、`:1016`（可重试分支）、`:1471`、`:1523`（续跑开始前）。
- 结算点：`:1003`（XHR）、`:782`（fetch），读的都是同一个 `loopState`。
- 后果：**这个布尔量不记录「是哪条 xhr 见的」「什么时候见的」**。A 流的 `true` 会被 B 流的 `false` 覆盖；B 流的结算会读到 A 流的残留。任何并发都会污染它——而并发在这套架构里是常态：一个用户消息下同时存在「页面自己的 completion」+「Studio 的 resend」+「上一个 turn 未收尾的流」+「页面自身的 auto_resume」。
- 证据：`storage.json` 里 14:06:42 那次三条错误 243ms 内到齐，且同一会话同时存在两个 turnId（§3.2）。

### D3（P0）重试预算按「结算次数」计，不按「实际发出的请求数」计

- 位置：`firstAttemptRetryCount`（`:168`，模块级单值）；`FIRST_ATTEMPT_MAX_RETRIES = 2`（`:170`）；`escalateFirstAttemptFailure`（`:1373` 起）里先判 `>=2` 再 `+=1`。
- 后果：**任何一个走完 `readyState=4` 的 chat XHR 都能消耗预算**，包括与当前 turn 无关的流。243ms 内三次结算 ⇒ 预算烧穿 ⇒ 上屏「已自动重试 2 次仍失败」，而实际发出的重试是 **0 次**。
- 证据：`escalate` 之后的调度延迟是 `errorBackoffMs(count-1)`（`response-classifier.ts:127-130`：2000ms 起、封顶 8000ms）；三条错误的时间间隔是 141/99/4ms，退避窗口根本没开始计时。

### D4（P0）结算命中时把页面自己的 handler 吞掉了

- 位置：`settleStreamEnd` 返回 true 时，hook 直接 `return`（`:1003`），而 `prev`（页面原本的 `onreadystatechange`）在 `:1040` 才调用，也就是**被跳过**。
- 后果：一个被判定为「截断」的流，**页面侧永远不知道它结束了**，页面自己的消息会停在 WIP、既不收尾也不触发它自己的 `auto_resume` 逻辑。之后所有以这条消息为 `parent_message_id` 的请求，服务端看到的是一个「没写完的父节点」。
- 证据：控制流顺序（`:1003` 早于 `:1040`，中间无 finally）。

### D5（P1）`xhr.__dsScanned` 只在读/写、从不复位

- 位置：`:904` 读、`:906` 写；`open()` 包装（`:824` 区域）里**没有**复位 `__dsScanned` / `__dsSse` / `__dsParser` / `__dsFrameDec`。
- 后果：如果页面（或任何复用者）用同一个 XHR 对象发第二次请求，增量切片从上一个响应的长度开始 → 第二个响应的**前半段与短尾帧全部被丢掉**，哨兵几乎必然读不到。这与 D1 叠加后，可以让「哨兵缺失」变成稳定复现而不是偶发。
- 证据：全仓 grep `__dsScanned` 只有两处（一读一写）。

### D6（P1）重试不幂等：`parent_message_id` 被改写

- 位置：`:1543` `parsed.parent_message_id = loopState.lastResponseMsgId;`（在自动重发前对原 body 做补丁，`:1512` 一带）。
- 后果：重发不是「原样再来一次」，而是**「接在上一轮那条没写完的消息后面再生成一次」**。首轮与重试的语义因此不同：重试落在一个 WIP 父节点上（D4 又保证了页面侧不会把它收尾）。这既是「重试为什么不能自愈」的解释，也是「第一次失败之后更容易连败」的机制。
- 证据：源码 + `lastResponseMsgId` 的来源（`event: ready` 的 `response_message_id`，`:902` 区域）。

### D7（P1）「0 字节/非 SSE 的 200」被当成「流被截断」

- 位置：分类器对 `200` 且 body 为空/非错误 JSON 的返回是 `'ok'`（`response-classifier.ts:73-89`，`:59` 亦有明文注释）；随后 `settleStreamEnd` 只检查 `streamSawDone`，**不检查本轮到底收到过多少字节/有没有 `event: ready`**。
- 后果：一个 141ms 就结束、根本没进入 SSE 阶段的 200 响应，会被写成「模型回复未完整接收（连接中断）」，并把预算 +1。这是「失败发生在用户消息之后 141ms」最贴合的解释。
- 证据：`storage.json` 的 141ms；分类器实现；缺少「已收到字节数」这个判据（`:922` 一带只统计已扫描长度，不上报）。

### D8（P1）死代码会误导后续定位

- 位置：`:1165-1173`，锚点文案 `请稍后手动重试`，永不可达（上一行同条件已 return，见 §2.3）。
- 后果：看代码的人会以为「还有一条不消耗预算的上报路径」，从而在排查时把 escalate 分支排除掉。

### D9（P1）`readyState` 处理器内部没有异常兜底

- 位置：`:889` 起的 handler 里，`frameDec.push` / `parser.feed` / `sse.feed` / `chatUI.appendToAssistantMessage` / `traceWriter` 调用**不在 try/catch 内**（`:928`、`:943` 一带）。
- 后果：任一调用抛出，都会跳过 `:943` 的哨兵写入 **和** `:1040` 的 `prev` 调用 → 表现为「流静默消失」或「页面输入框卡住」。这类失败在现有日志里**无法与真截断区分**。
- 证据：源码；以及 `logs/runtime-out.log` 里全程**没有任何** `[interceptor]` 异常行（说明此路径至少不是高频）。

### D10（P0，观测层）故障不落盘

- `interceptorTrace` 是内存环（`:141` 区域构造），只在页面里；`trace-store.ts:43` 的 `ds-studio-traces` 是**死键**（三个函数零调用）。
- 注入层 `diag` 只到 `console.log`（`src/host/page-runtime.ts:313`），桌面启动时 stdout 无人接收。
- 全盘 grep `stream-incomplete` / `no completion sentinel`：在 `E:\NAS\deepseek-studio\logs`、`%APPDATA%\deepseek-studio\profiles\*`、chrome/edge profile 下命中 **0** 次。
- 后果：任何一次「连败」都无法事后复盘，只能靠 `storage.json` 里 UI 顺手记下的时间戳倒推——本轮就是靠它定案的。**这是修复这件事的最大工程障碍，不是网络问题。**

---

## 6. 根因定案

### 6.1 主因（证据强度：强，可被一次埋点直接证实或推翻）

> **「本轮有没有收到结束哨兵」被建模成一个不属于任何一条流的全局布尔量，而结算它的代价是同样全局的重试预算。**

三条独立事实同时指向它：

1. **243ms 三次结算**（`storage.json` 毫秒时间戳）：三次 escalate 分别打印了 1/2、2/2 和最终失败，而 2s/4s 的退避窗口一次都没走完 → **顺序不是「失败→等 2s→重发→再失败」，而是「同一瞬间被记了三次账」**。
2. **两个 turnId 并存**（`7cb6463f` 报错、`c14e0eb3` 在 1.1s 后跑工具并成功）→ 同一用户消息下有多条执行链，共享同一个 `loopState`。
3. **唯一写入点 / 五个重置点 / 结算读全局值**（`§5 D2`）→ 结构上无法区分「这条流见到了哨兵」与「别的流见到了哨兵」。

### 6.2 次因（证据强度：强，代码级可证）

> **尾部帧永远不会被 flush**：`finish()` 零调用（D1），所以「服务端发了哨兵但没跟着空行」这一种情况必然漏判。

次因不解释 243ms 的爆发，但它解释「为什么偶发、为什么同一段代码有时对有时错」，而且是**最快能修、修完最不可能回归**的一条。

### 6.3 放大器（证据强度：中强）

- **重试不幂等**（D6）：重试落在 WIP 父节点上，本身不具备自愈能力。
- **结算吞掉 `prev`**（D4）：每一次误判都会在页面侧留下一条永不收尾的消息，污染后续请求的 `parent_message_id`。
- **文案撒谎**（§2）：把「没见到哨兵」写成「连接中断」，把「结算了 3 次」写成「重试了 2 次」，直接导致两次修复都在网络层打转。

### 6.4 明确排除

| 假设 | 排除依据 |
|---|---|
| 站点改用 WebSocket/换传输 | 10-21 实跑日志仍是 XHR POST → `text/event-stream`；仓库里的 WS 探针打的是自家 127.0.0.1:8760 |
| 站点改了帧格式 | 11/11 抓包三件套齐全；185 字节算术对上 LF+空行；同会话 1s 后另一条链正常 |
| 代理/中间盒 | `ProxyEnable=0`、`netsh winhttp` 直连、无代理进程；心跳间隔 8s |
| 渲染层/Electron | 本轮无窗口崩溃、无无响应；故障链在渲染层之外 |
| 「改了没生效」 | `entry.js`（16:00:48）含 `模型回复未完整接收`×3、`已自动重试`×4、`FINISHED`×2；进程 16:11:08 启动 |
| 用户中止被误报 | 中止走 `__dsAborted`（`:832`/`:1112`/`:1474`），静默且不报错 |

### 6.5 什么会推翻本结论（请按此审阅）

- 若按 §7 F12 埋点后，日志显示 **`lastChunkTail` 里出现 `"FINISHED"` 而 `sawSentinel=false`** → 主因改为解码器切帧（D1 升为主因），状态模型降为放大器。
- 若显示 **`bytesTotal===0` 占比高** → 主因改为「请求被拒/空响应被误判为截断」（D7），需要去修「200 + 0 字节」的分类，以及那个 PoW 422。
- 若显示 **同一 turnId 只发生 1 次 settle，却仍然上屏 3 条错误** → 主因改为「计数器跨轮泄漏」（D3 的一种），与并发无关。
- 若显示 **`prevInvoked=false` 的轮次后面必然跟着连败** → D4/D6 的权重需要上调，重试幂等成为第一优先级。

---

## 7. 修复方案

分四层，标注优先级与「每条对应哪个症状」。设计原则：**先让判据不再依赖单一全局布尔量，再让重试变成幂等动作，最后才谈文案。**

### 协议层

- **F1（P0）EOF 必须 flush 帧缓冲。** XHR 路径在 `readyState===4`、fetch 路径在流结束时调用 `frameDec.finish()`，并对 `finish()` 返回的尾帧再跑一次 `framesSignalStreamCompletion`；同时把解码器的边界放宽为「空行 **或** 流结束」。
  对应症状：偶发 `stream-incomplete`；对应缺陷 D1。
- **F2（P0）三态判定取代二态。** 把「本轮结束状态」定义为 `complete`（见到哨兵）/`truncated`（有字节、EOF 无哨兵）/`no-stream`（0 字节或未进入 SSE）。**`no-stream` 不得算截断、不得消耗首轮预算**，应走「请求未产生流」这一类上报。
  对应症状：141ms 假截断；对应缺陷 D7。
- **F3（P1）两条解析器边界对齐。** 给帧解码器加一条回退：若在 EOF 时 buffer 内存在完整 `data:` 行（单换行结尾），也要把它解析成帧（复用 `extractSseTextLine` 的逐行思路），让「文字能显示」与「哨兵能识别」使用同一套边界假设。
  对应症状：未来任何格式扰动；对应缺陷 §4.5。

### 传输层

- **F4（P0）哨兵归属到流。** 新增 `xhr.__dsSentinel`（以及 fetch 侧同类标记），写入与结算都用**本条流自己的**标记；`loopState.streamSawDone` 只做「本轮是否已观测到任意一条流结束」的汇总展示，不再作为结算判据。
  对应症状：连败；对应缺陷 D2。
- **F5（P1）`open()` 复位** `__dsScanned` / `__dsSse` / `__dsParser` / `__dsFrameDec` / `__dsSentinel`。对应缺陷 D5。
- **F6（P0）结算不得吞掉 `prev`。** 把 `prev(...)` 放进 `try/finally`，或在 `:1003` return 前显式调用一次。对应缺陷 D4。
- **F7（P1）`readyState` 处理器整体 `try/catch`**，异常路径也要走完「哨兵判定 + `prev`」，并把异常类型记入 trace。对应缺陷 D9。

### 重试层

- **F8（P0）重试必须幂等。** 删除 `:1543` 对 `parent_message_id` 的改写（或改为显式「新分支」语义并单独标注）；重放体 = 首轮原始 body。对应症状：重试不自愈；对应缺陷 D6。
- **F9（P0）预算绑定 turn。** `firstAttemptRetryCount` 改为按 `turnId` 存（`Map<turnId, number>`）；`escalate` 先校验「这条 XHR 属于当前 turn」，跨轮不继承、不复用。对应症状：243ms 烧穿；对应缺陷 D3。
- **F10（P0）只有真正发出重试才 +1。** `count` 的语义改为「已发出的重试请求数」；预算耗尽的文案用实际发出次数渲染（0 次时必须写「未发出重试」而不是「已重试 2 次」）。对应症状：文案撒谎。
- **F11（P1）重试顺序化。** 第二次重试前必须：`abort` 上一条流 → 清 `__dsScanned`/decoder → 清 `pending`；退避保持 `errorBackoffMs` 的 2s/4s，且**串行不并发**。同时把页面的 `auto_resume` 与自家重发做互斥（任一方向触发时抑制另一方），避免两套续跑语义打架（§4.3）。

### 可观测性

- **F12（P0）落盘 trace，每轮一行 JSONL。** 字段（建议直接照抄，别删减）：
  `ts`、`turnId`、`chatSessionId`、`xhrSeq`、`attempt`、`httpStatus`、`bytesTotal`、`chunkCount`、`firstByteLatencyMs`、`sawEventReady`、`sawSentinelFrame`、`sawEventClose`、`eofWithoutSentinel`、`decoderBufferTail(≤200)`、`lastChunkTail(≤200)`、`settleReason`、`httpVerdict`、`retryScheduled`、`retrySent`、`prevInvoked`、`errorCode`。
  写入位置：宿主侧（`src/host/`）或 `%TEMP%\deepseek-studio-trace\`，**不要**只放页面内存。
  这一步做完，§6.5 的四条判据就都能一眼读出来。
- **F13（P1）让 `diag` 直写文件**（现在只到 `console.log`，`page-runtime.ts:313`），并把 `trace-store.ts` 的死键接上或直接删掉，避免下一个人又被引到 `ds-studio-traces`。
- **F14（P2）清理死代码**：删掉 `:1165-1173` 那段不可达的 `请稍后手动重试` 分支（D8），并给 `settleStreamEnd` 的每个 return 加一行 `trace.record({reason})`。

### 顺带（与本次故障不同源，但建议一起修）

- **F15（P1）PoW 挑战的 422**：`create_pow_challenge` 只设一次 `Content-Type`，并确认请求头重放白名单不会重复注入（抓包里的 `"application/json, application/json"`）。这条不修，自动续跑一旦命中 PoW 失败就是死路（`storage.json` 里已有 2 例）。

---

## 8. 验收判据

### 8.1 单元级（可离线造假流，不需要联网）

1. **切片穷举**：取 §4.2 的 11 份真实 completion body，分别按 1 / 7 / 64 / 1024 字节切片喂进 `DsSseFrameDecoder`，要求 **44/44 都能判定出哨兵**。当前实现会在「最后一块不带尾部空行」的构造用例上失败——这就是 F1 的回归测试。
2. **尾帧用例**：构造 `...data:{"p":"response/status","o":"SET","v":"FINISHED"}` **不带末尾空行**，要求 `finish()` 后能判定 complete。
3. **归属用例**：两条 XHR 交错（A 见哨兵、B 未见），要求 A 的结算为 complete、B 的结算独立为 truncated，且**预算只 +1**（F4+F9）。
4. **幂等用例**：断言重放 body 与首轮 body 逐字节相等（不允许 `parent_message_id` 被改写，F8）。
5. **0 字节用例**：`status=200` 且 body 为空 → `settleReason` 必须是 `no-stream`，**不消耗预算**（F2）。

### 8.2 运行级（需要用户授权，见 §9）

6. 复现一次真实故障，读出 F12 的 trace，按 §6.5 的四条判据裁决主因。
7. 主动造一次真断流（关 Wi-Fi / 拔网线）→ 文案必须是「网络中断/服务器暂时无法访问」，预算只 +1，且 trace 里必须出现 `retrySent=true` 与一次真实的重发请求。
8. 文案真值表核对：`no-stream` / `truncated` / `network` / `fatal` / `aborted` 五种情况必须五种不同文案，「连接中断」只能出现在真的 `network` 上。

### 8.3 回退

F1–F7 均可独立上；建议给 `sentinelV2`（F1+F2+F4 组合）一个运行时开关，出问题可秒回旧判据，但**F12 埋点不要跟着回退**——它是下一次定案的唯一依赖。

---

## 9. 本轮未核实项与需要的授权

### 9.1 没核实的（不要当成已确认）

1. **14:06:42 那三次结算的确切来源**（三个不同 XHR？同一 XHR 重复回调？跨 turn 的迟到流？页面自身 `auto_resume` 发起的第二条流？）。现有证据只能证明「243ms 内被记了三次账、且一次重试都没发出」，**无法唯一确定是哪三条流**。这正是 F12 要解的东西。
2. **站点 JS 版本**。WebView2 内的 bundle 无法在只读方式下无副作用地取到（需要 CDP 或磁盘缓存解析），所以「客户端有没有换实现」只能靠抓包侧面判断；且抓包样本止于 10-21 23:05。
3. `34740.130` 那份 15,441 字节的非 SSE 响应体属于哪个端点未核实（含 `cache_control:"REPLACE"`，可能与会话/历史接口有关）。
4. `logs/ws-*probe*`、`logs/remote-e2e*` 等目录只在文件名层面看过，未读内容。
5. 按约束未启动 GUI、未登录、未向 chat.deepseek.com 发任何请求、未跑 build/typecheck/vitest、未做 git 写操作。因此**「F1–F15 尚未落地，也未经验证」**。

### 9.2 需要用户授权才能钉死的下一步

要让「0 字节 vs 有字节无哨兵」这个岔口闭合，需要二选一：

- **授权一次带日志的运行**：用 `cmd /c "deepseek-studio.exe > %TEMP%\ds-studio-stdout.log 2>&1"` 启动一次（不改代码就能拿到 `[interceptor] xhr resp[...]` 全文），或者
- **授权写一份临时 trace**：允许我在 `src/inject/main-world-interceptor.ts` 里加 F12 的落盘埋点并重新打包 `entry.js`（属于代码改动，本轮受「只读」约束未做）。

在此之前，请把 §6.5 当作审阅这份结论的入口：**它是可以被一次日志推翻的，而在没有那一次日志之前，任何「改网络层」的动作都是在猜。**
