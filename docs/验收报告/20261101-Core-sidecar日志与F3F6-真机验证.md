# Core 收口卡 ①②③ 真机验证报告（sidecar 日志 / F3 观测补齐 / F6 快速失败）

- 日期：2026-11-01
- 席位：Core（内核/宿主）
- 窗口：本轮唯一实现者，UI 交窗后接手，验完即交窗
- 构建：`cargo build` **EXIT=0，87.4s**（日志 `logs/verify-exit/cargo-build-sidecar.log`）
- 产物：`src-tauri/target/debug/deepseek-studio.exe` 2026-11-01 09:58:05 / 20 048 896 B
- 注入产物：`src-tauri/inject/entry.js` 420 500 B（UI 的 `F623B720…`，本轮未改）

## 一、结论

| 卡 | 项 | 结论 |
|---|---|---|
| ① | sidecar 运行时日志落盘 | **PASS**（C1/C2/C2b/C3/C4 全过，`SCRIPT_EXIT=0`） |
| ② | C1-F3 `memory.select` 观测补齐 | **PASS**（Verify 真机取证：trace `msel` 行与 audit `canonicalTarget` 的 `seq` 对齐，见 §3.3） |
| ③ | C1-F6 读不到快速失败 | 部分取证：**页端消失已 PASS**（12.0s / `empty-response`，15s 线内）；`read-no-data` 分支由单测锁定，F6b 真机由 Verify 补（见 §4） |

## 二、① sidecar 运行时日志落盘（真机 PASS）

脚本：`logs/verify-exit/verify-sidecar-log.ps1`（GUI 方式启动、**不重定向 stdout/stderr**，正是「日志会丢」的原场景）

实跑输出（`logs/verify-exit/sidecar-log-run-20261101-r2.log`）：

```
[pre] 预检通过：无实例、8760 空闲、9222 空闲
[pre] sidecar 日志目录：C:\Users\lidicn\AppData\Roaming\deepseek-studio\logs（启动前已有 1 个）
[run] 已启动 pid=27824（GUI 模式，无 stdout 重定向）
[PASS] sidecar /healthz 就绪 耗时 5.5s
[PASS] 主窗口可见
[PASS] C3 无可见控制台黑框 console windows=1 visible=0
[PASS] C1 日志文件已新建 新增 1 个：sidecar-1793498380535.log
[PASS] C2 日志非空且含启动行 size=572B/486chars
[PASS] C4 进程按时退出 tClose→exit=1892ms
[PASS] C4 退出码=0 exitCode=0
[PASS] C4 无残留 Studio 进程
[PASS] C4 无残留 node 宿主
[PASS] C4 8760 已释放
[PASS] C2b 退出后日志完整可读 exit后=486chars / 运行中=486chars
==== verify-sidecar-log 结果：PASS ====
SCRIPT_EXIT=0 elapsedSec=13.7
```

摘要：`logs/verify-exit/sidecar-log-20261101-095946.summary.json`

**日志内容**（`sidecar-1793498380535.log`，8 行 / 572 B，全部为启动行，无用户内容）：

```
[automation] started, 0 tasks loaded
[deepseek-studio] 聊天室模式启用：Dry Run 测试室
(node:24228) ExperimentalWarning: SQLite is an experimental feature ...
(Use `node --trace-warnings ...` to show where the warning was created)
[deepseek-studio] 本地 HTTP API on http://127.0.0.1:8760
[deepseek-studio] token 取自 DEEPSEEK_STUDIO_TOKEN 或 ~/.config/deepseek-studio/config.json
[deepseek-studio] 工作区: E:\NAS\deepseek-studio（区内自动放行，区外按策略）
[deepseek-studio] 命令审批档位: 完全放开 (full)
```

**修复前后的对照**（这是本卡的存在意义）：修前 exe（00:27:54 构建）下，该目录 `sidecar-*.log` 计数为 **0**——GUI 启动一条日志都不留；修后每次启动新建 1 个文件，内容完整。

**C3 的读法**：`console windows=1 visible=0` 表示本进程关联到 1 个 `ConsoleWindowClass` 窗口对象，但**不可见**（`CREATE_NO_WINDOW` 生效，没有黑框弹到桌面上）。判据是 `visible=0`，不是 `windows=0`。

### 2.1 首轮 FAIL 是**脚本自身的 bug**，如实记账

首轮（`sidecar-log-run-20261101.log`）C1–C4 全 PASS，C2b **FAIL**。定位后确认是判据实现缺陷、**不是产品缺陷**：

- `$contentLen = (Get-Item $logPath).Length` 取的是**字节数**（572 B）；
- `$text2.Length` 是**字符数**（486 chars，中文 UTF-8 多字节）；
- 判定写成 `字符数 >= 字节数` → 只要日志含中文就**恒为 false**。

修正：C2 与 C2b 统一按**字符数**比较，退出后再给 300 ms 让最后一次 flush 落盘，并让 C2b 打印两侧读数（`exit后=486chars / 运行中=486chars`）便于复核。修后重跑全 PASS。

这条记在报告里而不是悄悄改掉，是因为「判据单位错会让中文日志永远判不过」这类坑会在别的验收里复现。

## 三、② C1-F3 `memory.select` 观测补齐（代码核对完成，真机未取证）

### 3.1 落盘路径（已实盘确认）

`src/host/trace-log.ts:22` → `nodePath.resolve(process.cwd(), 'logs', 'trace')`。
sidecar 子进程由 `src-tauri/src/sidecar.rs:300` 的 `cmd.current_dir(&self.project_root)` 启动，cwd = 项目根，故落盘位置为：

```
E:\NAS\deepseek-studio\logs\trace\trace-<UTC日期>.jsonl
```

实盘确认该目录存在、`trace-2026-11-01.jsonl` 已在（98 B）。页端 trace 与宿主 trace 写**同一个文件**，靠 `kind` 字段区分。

### 3.2 打点位置（`src/host/desktop-host.ts`）

- `1581`：`const mselSeq = name === 'memory.select' ? ++mselSeqCounter : 0;`（全局单调递增）
- `1587-1589`：audit 增 `canonicalTarget: 'sel:<conversationId>#<mselSeq>'`
- `1591-1606`：`name === 'memory.select'` 时 `appendTraceLine` 写一行
  `{kind:'msel', at, sessionId, seq, durationMs, ok, count, reason}`

### 3.3 真机取证结果（Verify 执行，**已取证**）

本席位交窗时该卡尚无真机证据：`memory.select` 是**模型主动调用的 capability**（`desktop-host.ts:818`），不是自动路径，我手上那轮 E2E 的 `trace-2026-11-01.jsonl` 只有 1 行页端回合记录、无 `msel` 行。

后续由 **Verify** 定位到真实触发条件并跑通：`memory.select` 不是声明给模型的工具（能力前导只声明 `memory_save`，`main-world-interceptor.ts:716/734`），而是**页端预取**在开关打开时调用（`src/desktop/entry.ts:344-349`，注释写明 feature flag 默认关）。打开该开关后触发成功，读数：

| 通道 | 读数 |
|---|---|
| trace `msel` 行 | `sessionId=host-agent, seq=1, durationMs=40, ok=true, count=7` |
| audit `canonicalTarget` | `sel:host-agent#1` |
| 对齐结论 | 两处 `seq` 同为 **1**，`sessionId` 同为 `host-agent` → **对齐成立** |

这正好落在 §3.4 第 3 条要求的判据上：不是「有 msel 行」就算过，而是 trace 的 `seq` 与 audit 的 `canonicalTarget` 必须指向同一轮。故 ② 记为 **PASS（已取证）**。

### 3.4 取证指引（已按此执行，保留作复跑口径）

1. 起实例，在一个**有记忆的会话**里发送一条会诱导记忆检索的话（例如点名「用 memory.select 查一下我的偏好」）；
2. 查 `E:\NAS\deepseek-studio\logs\trace\trace-<UTC日期>.jsonl`，找 `"kind":"msel"` 行；
3. 判据：该行含 `sessionId`（非空）、`seq`（≥1 且单调）、`durationMs`（≥0 整数）、`ok`；audit 侧对应 `canonicalTarget` 恰为 `sel:<同一 sessionId>#<同一 seq>`（两处 seq 必须一致，这是「能对齐」的关键）；
4. 若模型没调用 `memory.select`，本轮**不构成失败**，只记「未触发」，换提示词再试。

## 四、③ C1-F6 读不到快速失败（按场景分三行，不合并）

- 实现：`src/host/engine/web-engine.ts` 增 `maxEmptyReads`（默认 10 ≈ 15 s），`send()` 与 `waitForNextReply()` 两条路径连续读不到即返回 `completion='disconnected'` + `reason='read-no-data'`；`model-engine.ts` 的 `EngineSendResult` 增 additive 字段 `reason?: string`。
- 用例：`tests/desktop/web-engine-f1.test.ts` 第 10 条——3 拍 × 20 ms 内返回 `read-no-data`，不烧满 120 s 看门狗。

**速度线与原因分类是两条独立判据**：速度线看「是否在 15 s 级内返回、不再烧满 120 s」，原因分类看 `reason` 能否区分场景。两者不互相替代。

| # | 场景 | 走哪条路 | 读数 | 结论 |
|---|---|---|---|---|
| 1 | **页端消失**（page target 关闭） | `state='hard'` → `tryReconnect` → `disconnected` | 12.0 s 返回 500，`reason=empty-response` | **PASS**：15 s 线内、不烧 120 s。`reason` 不是 `read-no-data` 属**预期**——页没了不是「页活着读不到」 |
| 2 | **页存活但无消息** | 修复前误判 `hard` → 重连×3 → `empty-response`；修复后 `state='empty'` → 空读计数 → `read-no-data` | 修复前 11.8 s / `empty-response`（分类 FAIL）；修复后单测 `read-no-data after 3 empty reads` | **已修复**（真因见 §4.1） |
| 3 | **正常但读不到** | 同 #2 的空读计数路径 | `web-engine-f1.test.ts` 第 10/11/12 条 | 单测锁定 |

### 4.1 真因（20261101 真机取证，三处证据互证）

**不是「chat-read 没有 error 字段」，而是宿主路由层把 `error` 改名成了 `reason`，而引擎只读 `error`。**

| # | 证据 | 读数 |
|---|---|---|
| 1 | HTTP 层原始返回体（`/v1/tools/execute`） | `{"ok":false,"reason":"no-messages-found"}` |
| 2 | 引擎侧打点（本轮临时加的一行） | `[web-engine] read-hard err=`（**空串**） |
| 3 | 源码 | `desktop-host.ts:1811` `routeExecution` 返回 `{ ok: r.ok, reason: r.error, data: r.data }`——把能力层的 `error` **映射成 `reason`** |

链路：`chat-read.ts:197` 返回 `{ok:false, error:'no-messages-found'}` → `routeExecution` 映射成 `{ok:false, reason:'no-messages-found'}` → `web-engine.ts:197` 读 `r.error` 得空串 → 不含 `no-messages` → 判 `state='hard'` → `tryReconnect`×3（退避 500/1000/1500）→ `disconnected` → 任务层 `task-loop.ts` 映射成 `empty-response`。

**为什么闸门没拦住**：`web-engine.ts:41` 把 `dispatch` 声明成 `Promise<ExecuteResult>`（只有 `error?`），而实际注入的是返回 `ToolExecutionResult`（只有 `reason?`）的 `routeExecution`。**类型声明与运行时形状不一致**，TS 按错的形状检查，于是「读 `r.error` 得空串」在 `tsc` 与单测下完全隐形；单测 mock 又照着错类型写 `error`，两头都对不上真机。

### 4.2 修法（三处，均在 Core 域）

1. `web-engine.ts:41`：`dispatch` 的类型显式声明 `{ ok; data?; error?; reason? }`——两种字段都在，并在注释里写明「`error` 是能力层、`reason` 是路由层」。
2. `web-engine.ts:211`：`const err = String(r.error ?? r.reason ?? '')`。
3. `web-engine.ts:322`（`health()`）：`reason: r.error ?? r.reason ?? 'chat-read-failed'`。
4. 用例：mock 改成**真机形状** `{ok:false, reason:'no-messages-found'}`（第 10、11 条），新增第 12 条锁「能力层 `error` 形状也认」（防只修一边）、第 13 条负控锁「`no-page-for-dom-capability` 仍走重连，不被当软失败吞掉」。

### 4.2b 端到端补丁（Verify 复验后追加，PM 裁定「尾巴现在补掉」）

Verify 复验确认**引擎层已能区分**（`read-no-data after 10 empty reads (wait path, elapsedMs=15852)` → `reason=read-no-data`），但 **API 层仍不可区分**：`/v1/agent/send` 两种场景都回 `(empty-response)`。根因是任务层把引擎的 `reason` 丢了：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `task-loop.ts` `computeStop()` | 只吃 `content/toolCalls/timedOut`，`read-no-data` 在这一层被丢弃 | 增第 4 参 `engineReason`；空内容+0 工具调用时 `engineReason==='read-no-data'` → `'read-no-data'`，否则 `'empty-response'` |
| `TaskLoopStopReason` | 无 `read-no-data` | 新增该成员 |
| `requireTaskLoopReply()` | 失败列表不含 `read-no-data` | 补入（否则会被当成成功回复返回） |
| `web-engine.ts` `maxEmptyReads` 默认值 | **10** 拍（10×1500ms+读取代价 ≈ **15.85s**，超 15s 线 0.85s） | **9** 拍（≈13.5s+读取代价，留余量后仍严格 <15s） |

### 4.3 修后读数

- `npx tsc --noEmit` **EXIT=0**
- `web-engine-f1.test.ts` **13/13 通过**（原 10 条 + 新增 3 条）
- 相邻套件 `web-engine-transport` + `web-engine-reconnect` + `trace-log` **40/40 通过**
- 任务层：`kernel-task-loop.test.ts` 新增 #65/#66，5 套件合计 **123/123 通过**
  - #65：引擎 `reason='read-no-data'` → `stopReason='read-no-data'`，`requireTaskLoopReply` 抛错文案含 `read-no-data`
  - #66 负控：引擎无 `reason`（页端消失）→ 仍 `empty-response`，且**不**含 `read-no-data`（两种场景 API 层可区分）
- 用例 11 实测日志：`read-no-data after 3 empty reads (wait path, elapsedMs=92)` → `wait-end completion=disconnected reason=read-no-data`
- 用例 13 负控实测日志：`read-hard err=no-page-for-dom-capability`（走重连，`reason` 为空）

**修后 API 层文案**：页存活无消息 → `task loop returned no successful reply (read-no-data)`；页端消失 → `... (empty-response)`。用户可据此区分「该重开页面」还是「页在、只是没读到」。

#1 的关键点记在这里，免得后面被当成缺陷：`read-no-data` 的**设计触发条件就是「页还活着、但连续读到 no-messages」**；页端整个消失走的是重连路径，`reason=empty-response` 是对的。两种场景的 `reason` 必须能区分——这正是本卡「别把断开和空读混成一类」的意图。

## 四之二、退出回退复现（关 page target → CloseMainWindow）

按 Verify 建议的两步取证（关 page target 后、CloseMainWindow 前查主窗；记 `CloseMainWindow()` 返回值），实跑一次：

| 项 | 读数 |
|---|---|
| 关 page target | `ok=true`（id `A746AEA9`） |
| 关之前主窗 | `handle=0x24D1478`、`isWindow=true`、**`visible=true`**、标题 `DeepSeek++ Studio`、`hasExited=false` |
| **`CloseMainWindow()` 返回值** | **`true`**（不是 false） |
| `tClose→exit` | **3936 ms** |
| 退出码 / 残留 | exitCode=0；studio 0 / node 宿主 0 / webview2 0 / 8760 已释放 |

p0 时间线（stderr 重定向抓到，完整）：

```
hide main (first, before any log write)      +0ms
close-requested: main                        +517ms
close-flow begin (main)                      +441ms
prevent_close done                           +437ms
exit-closure entered            [Thread 13]  +663ms
sidecar shutdown begin                       +8ms
sidecar shutdown returned                    +1719ms
run_on_main_thread queued ok=true            +5ms
main-thread teardown entered    [Thread 1]   同毫秒
destroy begin: main → destroy done: main     +6ms
teardown: terminated app webviews = 0
calling app.exit(0) → returned                +5ms
calling std::process::exit(0)                 +6ms
```

**结论：关 page target 之后 `CloseMainWindow` 不会挂 20 s**——返回 `true`、主窗仍可见、3936 ms 干净退出、无残留。Verify 那次 20 s 更像**探针操作顺序/上一轮实例遗留**造成的假象，不是产品缺陷。`terminate_tree` 杀不到「上一轮遗留 node」的假设**本轮未复现**（残留 0），但代码上确实只从当前 `child_pid` 展开子孙，保留为独立缺陷候选待查。

## 五、环境与残留

| 项 | 读数 |
|---|---|
| studio 进程 | 0 |
| studio 专属 webview2 | 0 |
| node 宿主（`src/api/main.ts`） | 0 |
| 端口 8760 / 9222 | 均无监听 |
| 本轮新建 sidecar 日志 | 2 个（首轮 + 修判据后重跑），各 572 B |
| tClose→exit | 1908 ms / 1892 ms（两次） |

## 六、本轮改动文件（均为我域内）

| 文件 | 卡 |
|---|---|
| `src-tauri/src/sidecar.rs` | ① stdout/stderr 落盘 + `CREATE_NO_WINDOW` |
| `src/host/trace-log.ts`（新） | ② 宿主 trace 落盘通道 |
| `src/host/desktop-host.ts` | ② `msel` 打点 + `canonicalTarget` |
| `src/host/engine/web-engine.ts` | ③ `maxEmptyReads` 快速失败 |
| `src/host/engine/model-engine.ts` | ③ `reason?: string`（additive） |
| `tests/desktop/trace-log.test.ts`（新） | ② 落盘路径与单行化 |
| `tests/desktop/web-engine-f1.test.ts` | ③ 第 10 条快速失败用例 |

工作树中 `src/inject/*`、`src/ui/*`、`entry.js` 的改动属 **UI 域**，本轮未触碰；`docs/项目总路线图.md` 属 PM。

## 七、自检

- `npx tsc --noEmit`：**EXIT=0**
- `cargo build`：**EXIT=0**（87.4 s）
- 定向用例：`web-engine-f1` + `web-engine-transport` + `web-engine-reconnect` = 48 例全过；`trace-log` = 2/2
- 全量 gate 未跑（按纪律由 PM 统一执行）

## 八、未提交

按纪律不 commit/push，改动留在工作树，由 PM 统一提交。
