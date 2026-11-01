# 20261101 两域真机验收（sidecar 日志 / F3 / F6 + UI 可视化与 F5）

- 验收席位：Verify（独立验收，不写业务代码）
- 委托人：Studio-PM；被验对象：Core（① sidecar 运行时日志、② F3 `msel` 打点、③ F6 快速失败）、UI（④ 可视化 + C1-F5）
- 判据来源：PM 本卡四条 + F6 三行口径（2026-11-01 追加）
- 实例：`target\debug\deepseek-studio.exe`（20,048,896 B，11-01 09:58:05；晚于 `sidecar.rs` 09:23:37 → 含最新 Rust 改动）
- 注入产物：`entry.js` 420,500 B / `F623B720513535CE`（源与 `target\debug\inject` 同哈希）
- 我方工具（全部自写，不改被验方脚本）：`logs/verify-f1f2/{f3-msel-probe,f6-no-page-probe,f6b-empty-reads-probe,f6b-live-nomsg-probe,set-memsel-flag,page-state,mem-baseline}.*`、`logs/verify-exit/verify-sidecar-log.ps1`（独立重跑）

**总结论：① PASS、② PASS（已取证）、③ 速度线 PASS 但 `read-no-data` 分类 FAIL、④ UI 两域 PASS。** ③ 的 FAIL 是**实现缺陷**（软失败信号读错字段），不是取证问题，见 §4。

---

## 1. 前置

- 开跑前：无实例、无 cargo、8760/9222 空闲。
- 工作树：PM 报「11 文件」，实测 `git status --porcelain` **23 条**（13 改 + 10 未跟踪）。多出来的：`tests/desktop/web-engine-f1.test.ts`、`docs/项目总路线图.md`（改）；`src/host/trace-log.ts`、`src/inject/raw-tool-text.ts`、`tests/desktop/{raw-tool-text,trace-log}.test.ts`、`AGENTS.md`、`docs/Audit/*`、`docs/设计文档/*`、`docs/验收报告/*`（新增）。**提交时别漏新增源文件**（`trace-log.ts` 是 F3 落盘的实现）。

## 2. ① sidecar 运行时日志：**PASS**

独立重跑 `verify-sidecar-log.ps1`（`logs/verify-exit/verify-sidecar-verify-run.log`），12 项全 PASS；我不引用其结论，另做独立复核：

| 项 | 我的读数 |
|---|---|
| C1 新建日志 | `%APPDATA%\deepseek-studio\logs\sidecar-1793521778322.log`（本轮新建，此前目录内 2 个） |
| C2 非空 + 启动行 | 572 B / **486 字符** / 8 行内容，含 `[deepseek-studio] 本地 HTTP API on http://127.0.0.1:8760` 等启动行 |
| C3 不弹黑框 | `console windows=1 visible=0`（有窗口对象但不可见 → `CREATE_NO_WINDOW` 生效） |
| C4 干净退出 | `tClose→exit=2074ms`、`exitCode=0`、无 studio 残留、无 node 宿主、8760 释放 |
| C2b 退出后完整 | 退出后 486 chars = 运行中 486 chars（**按字符数比，避开 Core 首轮踩的字节/字符坑**） |

- 我自己读日志内容确认：8 行全是启动信息，**无 `chat_session_id` / `parent_message_id` / `"prompt"` / 能力前导原文**（raw-hits=0）→ 日志落盘本身不泄漏会话内容。
- 历史对照：修前同目录 `sidecar-*.log` 为 2 个（09:58:32、09:59:41），本轮每次启动新增 1 个 → 「原来不落盘」这条修复成立。

## 3. ② F3 `msel` 打点：**PASS（已取证）**

### 3.1 第一次尝试：未触发，且根因是**能力没对模型暴露**

按 PM 口径发「请检索我的记忆…」，模型回：*「当前工具集只提供 memory_save（写入长期记忆），没有 memory_search / memory_list 之类的读取接口」*，send 200 / 13.3s。trace 无 `msel` 行、audit 无 `memory.select`。

代码侧确认这不是模型偷懒：能力前导只声明了 `memory_save`（`src/inject/main-world-interceptor.ts:716`、`:734`），而 `memory.select` 是**页端预取**调的（`src/desktop/entry.ts:344-350`，注释写明「feature flag 默认关」）。→ **「诱导模型调用」这条路结构上走不通**。

### 3.2 打开页内 flag 后触发成功

`window.__studioMemorySelect = true`（`set-memsel-flag.mjs`）→ 发一轮（200 / 12.1s）→ 取证：

```
trace : {"kind":"msel","at":1793522105611,"sessionId":"host-agent","seq":1,"durationMs":40,"ok":true,"count":7}
audit : {tool:"memory.select", outcome:"executed", durationMs:40, at:1793522105611,
         canonicalTarget:"sel:host-agent#1"}
```

- **对齐成立**：audit `canonicalTarget` 的 `#1` = trace 的 `seq=1`，`at` 完全相同（1793522105611），`durationMs` 两边都是 40。
- 字段齐全：`sessionId/seq/durationMs/ok/count` 全在，`reason=null`（成功）。
- 第二次触发同样成立（`seq=2, durationMs=82`）→ 序号单调递增。
- 一点如实说明：`sessionId` 是 **`host-agent`**，不是 DeepSeek 会话 id；audit 与 trace 自洽，但若日后要按「用户会话」维度对账，这个键名需要留意。

## 4. ③ F6 快速失败：**速度线 PASS / 分类 FAIL**（按 PM 三行口径）

| 场景 | 构造方式 | 返回 | 耗时 | `reason` | 判定 |
|---|---|---|---|---|---|
| **页端消失** | 发一轮后关掉 page target（CDP `/json/close`） | 500 `task loop returned no successful reply (empty-response)` | **12001ms** | `empty-response`（无 `read-no-data`） | 速度线 **PASS**（<15s、不烧 120s）；原因分类**不满足** |
| **页存活无消息** | 发一轮后清空消息节点（`ds-sc-message-list` + 虚拟列表项），`chat-read` 实测返回 `no-messages-found` | 500 同上 | **11790ms** | `empty-response`（无 `read-no-data`） | 同上 |
| **正常但读不到** | 同「页存活无消息」路径（`chat-read` 软失败） | 500 同上 | ~11.8s | `empty-response` | 同上 |

### 4.1 根因（决定性，代码 + 实测双向印证）

1. `chat-read` 的软失败返回体是 **`{ok:false, reason:'no-messages-found'}`，没有 `error` 字段**（我直接调 `/v1/tools/execute` 打印键值确认；带不带 `ensureLatest` 都一样）。
2. 引擎取错误串读的是 `r.error`：`src/host/engine/web-engine.ts:197` → `const err = String(r.error ?? '')` → 空串 → `:200` 的 `err.includes('no-messages')` 为 false → **判成 `state:'hard'`**。
3. 于是走 `tryReconnect()`（3 次 × 退避 500/1000/1500ms）→ 仍失败 → 返回 `completion:'disconnected'`、`content:''`（该分支**提前 return，不打 `wait-end`**，与我日志里「只有 wait-start/B-start、没有 wait-end」完全吻合）。
4. 任务层 `computeStop()` 把「内容空 + 无工具调用」映射成 `empty-response`（`src/host/kernel/task-loop.ts:196-199`），engine 的 `reason` 在这里被丢弃。

→ **`read-no-data` 分支在真机上不可达**：只要 `chat-read` 是软失败（页端在、读不到），引擎永远先判 hard。该分支目前只有单测覆盖（`tests/desktop/web-engine-f1.test.ts:244`，mock 的 dispatch 返回的是 **`error` 串**）——**单测 mock 的形状与真机返回体不一致**，所以单测绿、真机路径断。

### 4.2 建议修法（不属我改，供 PM 派卡）

- `web-engine.ts:197`：改成 `const err = String(r.error ?? (r as {reason?:string}).reason ?? '')`，或直接按 `ok===false && reason.startsWith('no-messages')` 判 empty；
- 同时让 `read-no-data` 的 `reason` 透传到任务层（`computeStop` 或 agent-loop 映射），否则用户仍只看到 `empty-response`，两种场景依旧不可区分。

## 5. ④ UI 两域：**PASS**

### 5.1 C1-F5（`--phase f5`）

- **首次 FAIL 是我的环境前置问题，不是产品缺陷**：页面停在首页 → `currentKey='route:/'` → 脚本 `storageKey=null`（它只对会话页算 KV key）→ 注入没落地 → `found:false`。导航到会话页后重跑。
- 重跑 **PASS**：`scopedText="我先查一下目录。查完了，没有找到目标文件。\n已隐藏 search_files 的调用原文（这条调用当时没有执行）"`；`hasRawTagInScope=false`、`hasRawParamsInScope=false`、`markdownHasTag=false`、`bodyHasRawTag=false`、`noteCount=1`。**正文无标签、无参数原文，提示行只有一条。**

### 5.2 坏图降级 + 负缓存（`--phase fallback`）

- **PASS**：`cardCount=1`、`imgs=0`、**`placeholders=2`**、**`brokenImgs=0`**、`imageFetchFrames=1`（同一坏 URL 用两次只发 1 次 `image_fetch` → 负缓存生效）。

### 5.3 静态复核（不占窗口时先做的）

- `vis-card.ts:190-208`：`dataUrl===null` 分支先 `replaceWithPlaceholder` 再判 `isConnected`，且有 `complete && naturalWidth===0` 的绑定前竞态兜底 —— 与 UI 报的修法一致。
- `continuationReasonForReply()` 在 `raw-tool-text.ts:119`，真实判定点在 `main-world-interceptor.ts:2523`；单测 3 例覆盖「散文→no-tools / 留原文→tool-text-unparsed / 带属性→tool-text-unparsed」+ 负控。
- 用例数：`vis-card` 21、`raw-tool-text` 13、`studio-chat-ui` 27。

## 6. 我自己的错（不记任何席位账）

| # | 我的错 | 后果 | 状态 |
|---|---|---|---|
| P12 | `f3-msel-probe.mjs` / `f6*.mjs` 退出时 node 报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` | 数据已完整打印，但进程退出码 `-1073740791`（非 0）；**还差点把 Core 引向「node abort → 孤儿」的错误归因** | **已修**：4 份脚本改为 `ws.terminate()` + 120ms 收尾再 `exit`（语法自检通过），待下轮真机确认不再出现。Core 独立复核结论一致：sidecar 6 份日志里断言 **0 命中**，只在我的探针产物里 |
| P13 | `goto-conv.mjs` 里正则写成 `/^\\/(?:a\\/)?…/`（模板字符串里 `\/` 被吃） | 判定恒抛异常 → 误报 `NOT_READY`，白等一轮 | 已绕过（改用 `page-state.mjs` 直读） |
| P14 | F6 首轮设计错：把「关掉 page target」当成「页存活无消息」 | 测的是 hard/disconnected 路径，不是 `read-no-data` 路径；被 PM 指出后才构造对 | 已补 F6b 两次构造 |
| P15 | 上一轮实例 `CloseMainWindow` 20s 未退出（当时我刚关掉它的 page target） | 需强杀进程树 | 记为观察项：**外部关掉 page target 后，窗口关闭会挂住**；正常实例本轮 2046ms 干净退出 |

### 6.1 给 Core 复现 20s 挂住的一条替代假设（未验证，供设计取证）

我当时的操作是：**先**用 CDP `/json/close/<pageId>` 关掉 page target，**再**调 `CloseMainWindow()`。这里有个前置问题值得先排除：

- 关掉 page target 后，主窗对应的 WebView 页面已经没了；`CloseMainWindow()` 依赖向主窗投递 `WM_CLOSE`，**如果主窗句柄已失效/窗口已不存在，它可能直接返回 false 而不是「投递后卡住」**——那样「20s 未退出」就不是 shutdown 卡住，而是**应用根本没收到关闭请求**。
- 建议复现时先加一步取证：关 page target 之后、调 `CloseMainWindow` 之前，先 `Get-StudioWindows -ProcessId <pid>` 看主窗是否还在、`Visible` 是什么；再记录 `CloseMainWindow()` 的**返回值**。若返回 false → 归因就落在「页端被外部破坏后窗口对象失效」，与 `terminate_tree` 杀不到孤儿是两件事。
- 我这边能提供的旁证只有：正常路径（不关 page target）三次退出 1892/1908/2074ms 全干净；挂住那次是唯一关过 page target 的。

## 7. 副作用与库状态

- 用户会话新增消息 **5 条**（F3 两次诱导 + F6/F6b/F6b2 各一次），未删除（删聊天记录属用户数据操作）。
- 记忆库只读复核：`memories=23 / pinned=0 / FTS=23 / 孤儿=0 / integrity=ok`，mtime 未变（`2026-10-31T06:31:14Z`）→ 与 C1 基线一致，复验未写入用户记忆。
- trace 新增 2 行 `msel`（`logs/trace/trace-2026-11-01.jsonl`），仅结构字段。
- 收尾：实例 `CloseMainWindow` **2046ms** 干净退出、studio 进程 0、node 宿主 0、8760/9222 释放、Studio 专属 webview2 **0**。
- 隐私：本轮所有产物只留长度/计数/布尔，未落用户会话原文。

## 8. 结论

| 项 | 判定 | 依据 |
|---|---|---|
| ① sidecar 运行时日志 | **PASS** | 12 项自测全过 + 我独立读日志内容（8 行启动行、无原文） |
| ② F3 `msel` 打点 | **PASS** | trace `seq=1/2` + audit `sel:host-agent#1` 对齐，字段齐全 |
| ③ F6 速度线 | **PASS** | 12.0s / 11.8s，均 < 15s，不烧 120s |
| ③ F6 原因分类 | **FAIL** | 两场景都返回 `empty-response`；`read-no-data` 因 `r.error` vs `reason` 字段错位在真机不可达（§4.1） |
| ④ UI F5 | **PASS** | 正文无标签/无参数、提示行 1 条 |
| ④ UI 坏图降级 + 负缓存 | **PASS** | 0 破图、2 占位、`image_fetch` 1 帧 |

**建议：UI 两域与 ①② 可随批提交；③ 建议单开小卡修 `web-engine.ts:197` 的字段读取 + `reason` 透传（改动很小，但属 Core 域，我不动）。**

---

## 9. F6 修复后的复验（2026-11-01 17:00，Core 修完、PM 采信真因后）

### 9.1 代码侧先核（不引用 Core 读数）

- `web-engine.ts` `dispatch` 类型改为 `{ ok, data?, error?, reason? }`（原来只有 `error?`，与注入的 `routeExecution` 形状不一致）；
- `:211` 与 `:322` 均为 `r.error ?? r.reason ?? ''`；
- `desktop-host.ts:1811/1831` 仍是 `reason: r.error`（改名点在路由层，Core 的根因描述与代码一致）；
- 新增一行取证打点 `[web-engine] read-hard err=…`。

### 9.2 两条场景的实测（同一实例、同一 exe 09:58:05）

| 场景 | 构造 | 引擎日志（决定性） | 耗时 | API 返回体 |
|---|---|---|---|---|
| **页存活无消息** | 发一轮后清空消息节点（`chat-read` 实测 `no-messages-found`） | `[web-engine] read-no-data after 10 empty reads (wait path, elapsedMs=15852)` → `wait-end completion=disconnected elapsedMs=15852 contentLen=0 reason=read-no-data` | send 总计 22728ms（wait 段 15852ms） | 500 `(empty-response)` |
| **页端消失** | 发一轮后关 page target | `[web-engine] read-hard err=page-disconnected` → `read-hard err=no-page-for-dom-capability`（无 read-no-data） | 11286ms | 500 `(empty-response)` |

### 9.3 结论：**引擎层区分成立，API 层仍不可区分**

- ✅ 引擎层：`read-no-data`（10 次空读后主动失败）vs `hard/page-disconnected`（页端没了走重连）**两条路径已分开**，日志一眼可辨，修复有效。
- ❌ API 层：两种场景的 `/v1/agent/send` 返回体**都是** `task loop returned no successful reply (empty-response)`。原因：`read-no-data` 没有透传到任务层——`grep reason src/host/agent-loop.ts src/host/kernel/task-loop.ts` **0 命中**，`computeStop()` 只看 `content/toolCalls`（`task-loop.ts:196-199`），引擎的 `reason` 在这一层被丢弃。
  → PM 卡里第 1 条「把 `read-no-data` 透传到任务层」**只做了一半**（引擎侧做了，任务层没做）。
- ⚠️ 速度线：wait 段 **15852ms**，比 PM 的 15s 线**超 0.85s**（10 拍 × 1.5s 本身就是 15s，加读取代价必然溢出）。若要严格 ≤15s，建议 `maxEmptyReads` 由 10 降到 9（13.5s）。

### 9.4 我上轮那条「20s 挂住」观察项：**本轮未复现，降级**

- 本轮同样「关 page target 后 CloseMainWindow」：**1952ms 干净退出**、exitCode 0、残留 0。与 Core 的复现结论（3936ms、`CloseMainWindow()` 返回 true）一致。
- 故 P15 从「疑似缺陷」降级为「**一次未复现的异常，疑与上一轮遗留状态/探针顺序有关**」，不记产品缺陷。报告 §6.1 的替代假设也一并作废（主窗当时确实还在）。

### 9.5 收尾

- 实例 1952ms 干净退出；studio 0 / node 宿主 0 / 8760·9222 释放 / Studio 专属 webview2 **0**。
- 本轮探针退出**不再出现** `UV_HANDLE_CLOSING` 断言（P12 的修法生效，4 份脚本全绿）。
- 用户会话新增 2 条消息（F6b2 + F6 各一次），未删除。

---

## 10. F6 尾巴修完后的最终复验（2026-11-01 17:12）：**四条全过 → 通过**

Core 补了两处（`computeStop()` 第 4 参 `engineReason` 分流 + `maxEmptyReads` 默认 10→9），我跑 `logs/verify-f1f2/f6-final.ps1`（自检→起实例→两条场景→干净关实例），**四条判据全 PASS，EXIT=0**：

| 判据 | 结果 | 读数（原文） |
|---|---|---|
| ① 页存活无消息 → 返回体可见 `read-no-data` | **PASS** | `{"ok":false,"error":"task loop returned no successful reply (read-no-data)"}` |
| ② 页端消失 → 返回体**不含** `read-no-data` | **PASS** | `{"ok":false,"error":"task loop returned no successful reply (empty-response)"}` |
| ③ wait 段 ≤15000ms | **PASS** | **14264ms**（9 拍 × 1.5s + 读取代价，留了 736ms 余量） |
| ④ 引擎日志仍可区分 | **PASS** | A：`[web-engine] read-no-data after **9** empty reads (wait path, elapsedMs=14264)` → `wait-end completion=disconnected … reason=read-no-data`；B：`read-hard err=page-disconnected` → `read-hard err=no-page-for-dom-capability`（无 read-no-data） |

- 端到端口径现在**真的可区分**：页端消失 = `empty-response`，页存活无消息 = `read-no-data`，两者不再合并。
- 拍数确认：日志是 **9** 空读（不再是 10），`elapsedMs=14264` 在 15s 线内。
- 收尾：`close=5264ms`、studio 0、node 宿主 0、8760/9222 释放、Studio 专属 webview2 0（脚本 finally 里打印）。
- 产物：`logs/verify-f1f2/f6-final-run.log`；宿主日志 `%APPDATA%\deepseek-studio\logs\sidecar-1793523886958.log`。
- 用户会话新增 2 条消息（两条场景各一次），未删除。

### 10.1 两域验收总表（收口）

| 项 | 判定 |
|---|---|
| ① sidecar 运行时日志 | **PASS** |
| ② F3 `msel` 打点（trace/audit 对齐） | **PASS** |
| ③ F6 快速失败（速度线 + 原因分类） | **PASS**（本轮四条全过） |
| ④ UI 可视化 + C1-F5 | **PASS** |

→ **两域验收整体通过，可进批次提交。**
