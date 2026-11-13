---
title: deepseek-studio 只读代码审计·续审第 4 轮（欠账收口 + Rust 生命周期 · 2026-11-12 21:20）
summary: 基线 dc76959，工作区 11 个已修改文件 + 3 个未跟踪报告，.rs 均干净。本轮撤回上轮的 N3-01（aud 绑定实际存在，host-token.ts:393）；孤儿进程定成不需要靠下次启动清扫（宿主自带 2s 探活 self-exit）；CDP 默认常开在 release 同样生效、唯一关法是环境变量，定成 N4-01（P2）。新增 1 条、撤回 1 条。
---

# deepseek-studio 代码审计·续审第 4 轮（欠账收口 + Rust 生命周期）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未跑 cargo/typecheck/vitest/tauri dev、未启长驻进程。

## 一、基线与范围

| 项 | 实测值 |
|---|---|
| HEAD | `dc76959`（master） |
| 脏文件 | **11 个已修改** + 3 个未跟踪报告；.rs 与发布脚本 **均干净** |
| 已修改 | `src-tauri/inject/entry.js`、`src/host/bot/chat-room-runtime.ts`、`src/host/bot/types.ts`、`src/inject/main-world-interceptor.ts`、`src/ui/studio-chat-room.ts`、`src/ui/studio-chat-ui.ts`、`src/ui/studio-ui-core.ts` + 5 个测试 |

**版本标注**：`main-world-interceptor.ts` 脏（连续四轮都在改），本节引用的行号对**工作区版**；其余 TS（`host-token.ts`/`agent-channel.ts`/`desktop-host.ts`/`authority.ts`/`api/main.ts`/`memory/*`）与四个 .rs 均为 **HEAD 版**。`src-tauri/inject/entry.js` 是压缩单行产物，**不逐行审**（不拿它当证据）。

## 二、N3-01 影响面的定论：**撤回**

上轮把 N3-01 定为 P2（“grant 里没有 aud，结构上无法绑定 bot”）。本轮沿调用链读完，**这个结论错了，主动撤回**。

实际链路（三道全在）：

1. `agent-channel.ts:226-229`：连接时从 `?aud=` 读出 aud 并**传给** `options.grantVerifier(token, aud)`；
2. `desktop-host.ts:2625`：把 aud 作第 4 参交给 `verifyBootstrapGrant(authority.hostToken, presented, usedBootstrapJtis, aud)`；
3. `host-token.ts:393`：`if (claims.aud !== expectedAud) return { ok: false, reason: 'aud-mismatch' };`。

所以为 `aud=main` 签的券**不能**以 `aud=bot:x` 连上——卡住它的是 aud 比对本身（不是别的道）。另外 `:394-395` 用 `usedJtis` 做一次性消费，券不能重放。

**上轮为何误判**：我只读了 `authority.ts` 里的 `verifyGrant`（那是 **ToolGrant** 体系，另一套对象），而 `/agent-ws` 用的是 `host-token.ts` 的 **BootstrapGrant**。两套 grant 并存且字段不同，这是真实的认知陷阱；建议在两处文件头互相加一行“另一个 grant 在哪个文件”，否则下一个人还会错一次。

## 三、sidecar 生命周期结论

### (1) 启动失败或子进程早退会不会无限重启 / 占着端口——**不会**

- 硬上限：`MAX_RESTARTS = 5`（`sidecar.rs:29`）、`RESTART_DELAY = 2s`（`:28`）；`do_crash`（`:1007-1021`）到 5 次就 `GaveUp` 并不再重启，`do_restart_cooldown`（`:1023-1037`）的等待循环里也查关停标志。
- 确定性失败不重试：退出码 2（EADDRINUSE）直接 `StartupFailed`（`:981-989`）；健康超时后端口仍有人应答 → 判“外部占用”并 `StartupFailed`（`:929-938`）；`spawn` 本身失败 → `StartupFailed`（`:951-957`）。三条都 `write_crash_log` + `emit`，不会刷屏。
- 端口释放：健康超时时先 `force_kill_process_tree` 再改状态（`:920-923`），不会拿着一个已死子进程空转。

### (2) 主进程异常退出时子进程能不能被回收——**能，不需要靠下次启动**

上轮列的可疑“只能靠下次启动孤儿清扫”**不成立**。宿主自己有一道孤儿防护：`api/main.ts:53-77` 的 `installOrphanGuard`，2s 轮询双判据——`process.ppid` 变化（POSIX）**或** `process.kill(pid, 0)` 探活失败（Windows，`:81-84` 把 `EPERM` 也算存活）→ `exitWithCleanup()` → 先 tree-kill 全部 MCP 子进程再 `exit(0)`（`:56-64`、`:89-92`）。`SIGTERM`/`SIGBREAK` 也走同一条腿（`:72-75`）。

`sidecar.rs:890-892` 首轮 `terminate_host_by_cmdline()` 是**第二道**（处理“宿主自己卡死、探活还在”的残余），不是唯一一道。

## 四、CDP 与窗口结论

### CDP：**默认常开，release 同样生效，环境变量是唯一关法**（定成 N4-01）

`main.rs:1750-1769` 完整函数体已读：

- 门控就是 `if std::env::var_os("STUDIO_DISABLE_CDP").is_none()`（`:1750`）——**没有** `cfg!(debug_assertions)`、**没有** `#[cfg(debug_assertions)]` 包裹，所以 release 装包同样会拼 `--remote-debugging-port`；
- 端口：`STUDIO_CDP_PORT` 可指定，缺省在 9222/9223 里挑一个空闲的（`:1751-1758`）；
- 合并策略：外部已设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 时只做拼接，不覆盖（`:1760-1768`）。

即：**任何拿到本机 9222 端口的人都可 CDP 接管这个 WebView**（里面装着带 host token 的页面）。上轮把它列 P2 是靠权限面推断，本轮把“release 也生效”这一条坐实了。

### 窗口创建：**未读完**

主窗/同意窗的父子与置顶关系在 `main.rs:1364` 附近（导航守卫同段），本轮只读到行号与 `on_navigation` 存在，**未读函数体**。单实例、命令注册表（10 个全显式）已在上轮核过。
## 五、新增缺陷清单（1 条）

### N4-01（P2）CDP 远程调试口默认常开且 release 装包同样生效，唯一关法是环境变量

**file:line**：`src-tauri/src/main.rs:1750`（门控只有 `if std::env::var_os("STUDIO_DISABLE_CDP").is_none()`）→ `:1759`（拼 `--remote-debugging-port={port}`）→ `:1768`（写回 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`）。

**触发条件**：任何用户正常启动 release 装包（未手动设 `STUDIO_DISABLE_CDP=1`）。

**影响**：WebView2 开着一个 CDP 端口（缺省 9222，被占则 9223）。CDP 能力包括 `Runtime.evaluate` 与 `Network.getAllCookies`，而主窗里就跑到 `chat.deepseek.com` 并持有 host token——等于把“页面可被本机任意进程脚本控制”与“会话凭据可读”两件事同时开着。对单人本机工具可以论证“可接受”，但它是**默认值**：用户不知道、也不好关（环境变量需重新启动应用）。

**证据类型**：代码级（控制了构建类型的分支里没有任何 `debug_assertions`）。

**修复建议**：把整块包进 `if cfg!(debug_assertions) { ... }`，release 缺省不开；确实需要远程调试时用 `STUDIO_ENABLE_CDP=1` 显式打开（把“缺省安全”改成“缺省关闭”）。

**验收判据**：release 构建启动后 `Get-NetTCPConnection -LocalPort 9222,9223` 无监听；设 `STUDIO_ENABLE_CDP=1` 后监听出现。当前无任何用例/脚本断言这条。

## 六、可疑未证实

1. **CDP 监听地址是否仅回环**：`main.rs:1752` 只用 `127.0.0.1:p` 做空闲探测，但交给 WebView2 的参数里没有 `--remote-debugging-address`；它缺省听在哪取决于 WebView2 版本（未实跑）。若听 `0.0.0.0` 则 N4-01 从 P2 升 P1。缺：真机 `netstat` 读数。
2. **`usedJtis` 在 Origin 校验前就消费**：`host-token.ts:395` 先记 jti，`agent-channel.ts:245-251` 后校 Origin；一次 Origin 失败会白白烧掉一张券。影响面小（重连会重取），但“校验顺序”与“一次性语义”值得确认。
3. **`do_shutdown` 的 Windows 路径是否真优雅**：`:1049-1055` 走 `force_kill_process_tree`（SIGKILL 语义）后再等 `GRACEFUL_TIMEOUT`，未读完整段；若子进程没有任何落盘机会，“优雅退出”名不副实。
4. **窗口父子/置顶关系**：`main.rs:1364` 函数体未读。
5. **`chat-insert` 语义**（N3-02 的后果面）：仍是压缩产物，未证。

## 七、覆盖与未覆盖

**本轮读完**（TS 约 350 行、Rust 约 300 行，共约 **650 行**）：`agent-channel.ts:96-252`（origin 白名单 + connection 鉴权链）、`desktop-host.ts:2612-2678`（grantVerifier 接线）、`host-token.ts:365-400`（BootstrapGrant 验签全函数）、`api/main.ts:25-92`（孤儿防护全函数）、`sidecar.rs:76-138`、`:856-1055`（do_spawn / do_monitor / do_crash / do_restart_cooldown / do_shutdown 前半）、`main.rs:1728-1772`（CDP 块 + 命令注册）、`storage.ts:556-563`（syncFtsStrict）、`core.ts:130-144` 符号、`main-world-interceptor.ts:1430-1492`（prepareOutgoingBody）。

**仍剩（具体到范围）**：

- `main.rs` 的 `:1364` 窗口创建/导航守卫函数体（约 60 行）、`open_bot_window` / `open_workbench` 主体；
- `sidecar.rs` 的 `spawn_child` 内部（`:620-790`，约 170 行：环境变量注入、日志文件句柄、命令行拼装）；
- `main-world-interceptor.ts` 的 XHR hook 主体（`:1157` 附近）与 `captureChatRequest`（`:1543`）的字段抽取；
- `memory/storage.ts` 的 UPSERT 去重分支（`:92-234`）已看过符号与 SQL，但未逐行；
- 运行期验证：全部未做（未跑 cargo、未实跑安装包、未真机 netstat）。

**为何这些可以留**：它们不再支撑任何尚未定论的安全问题。N3-01 已撤回、孤儿进程已有确定结论、CDP 的“是否 release 也开”已定成“是”；剩下的都是实现细节，不影响“防线是否只有一道”这个总判断。

## 八、九份报告合并索引

| # | 文件名（`docs\审计报告\TD\`） | 新增编号 |
|---|---|---|
| 1 | `deepseek-studio-审计报告-TD-20261102.md` | TD-01 ~ TD-14（P1×4 P2×7 P3×3） |
| 2 | `deepseek-studio-审计报告-TD-第2轮-20261102.md` | R2-01 ~ R2-10 |
| 3 | `deepseek-studio-审计报告-TD-第3轮-20261102.md` | R3-01 ~ R3-04 |
| 4 | `deepseek-studio-审计报告-TD-总报告-20261102.md` | 无新编号（合并去重成 34 条：P1×8 P2×18 P3×8） |
| 5 | `deepseek-studio-审计报告-TD-回归审计-20261112.md` | N-01、N-02（并逐条复核 34 条：已修 25/部分 2/仍存 4/无法判定 3） |
| 6 | `deepseek-studio-审计报告-TD-最近提交-20261112.md` | R6-01 ~ R6-03 |
| 7 | `deepseek-studio-审计报告-TD-续审第1轮-20261112.md` | U1-01 ~ U1-03 |
| 8 | `deepseek-studio-审计报告-TD-续审第2轮-20261112.md` | N2-01、N2-02、N2-04（+ N2-03 列可疑） |
| 9 | `deepseek-studio-审计报告-TD-续审第3轮-20261112.md` | N3-01（**本轮撤回**）、N3-02 |
| 10 | `deepseek-studio-审计报告-TD-续审第4轮-20261112.md`（本文） | N4-01；N3-01 标注撤回 |

**当前活跃缺陷（未被后续轮次判为已修/撤回）**：N4-01（P2，CDP）、N3-02（P3，重试重复插入）、N2-02（P3，空成员集）、U1-01（P2，重连锁死，修复中）、U1-02（P2，重发不清气泡，修复中）、U1-03（P3）、R2-03（= N4-01 同源，以 N4-01 为准）、R2-07（P3，memory.save）、TD-14（P3，配对码）。其余历史条目均已在回归轮定为已修或已消解。

**2026-11-13 状态更新（PM 复核，逐条看码＋跑测，非转述）**：
- **N2-01 已修复** —— `7bcb494` 用 `roundCompleteSent` 一次性守卫收口（`chat-room-runtime.ts:377-389`），四条退出路径（room 不存在 / 会议命令 / 审计命令 / 正常讨论）各推一次；`7e0bcacd` 再给 `onRoundComplete` 加异常隔离，避免 finally 里抛错覆盖原始异常。回归锁：`bot-chat-room-runtime.test.ts` 23 枚（含四种退出路径各一次＋回调抛错不重推）。
- **N2-04 已修复** —— `2325a23` 每轮内部 AbortController 真取消在途请求，迟到 resolve/reject 过 `roundClosed || roundSignal.aborted || generation !== roundGeneration` 丢弃（不落 history、不触发 onDelta），留 `[task-loop] stale-*-dropped` 诊断；新增 `task-loop-round-timeout.test.ts` 7 枚。
- **TD-06 已修复** —— `c050a72` Rust 侧按 `env → config.port → 8760` 单一真相解析（`parse_health_port`/`resolve_health_port_from`/`health_port()`），9 处硬编码全部替换，含 spawn 注入与工作台/聊天室/mcp-settings/consent 窗口 URL；新增 8 枚 `td06_*`，负控（`.or(config)`、残留常量、env 改端口）三条各自翻红。
- 上述三枚修复后全量 gate 绿（16 步阻塞 + 6 步信息，`d3cadfc`），已推送 `origin/master`。
- 本报告未覆盖的同类项（`host-tools-adapter.ts:21`、`task-loop.ts:189` 的空串失败文案）同批收口于 `d4807f3`；`src/shared/tool-loop.ts:39` 的 `[unknown error]` 是 `String(e)` 自身抛错的兜底，非同类，未动。

---

**本轮工作量与结果**：读 **11 个文件**的关键段，**TS 约 350 行 + Rust 约 300 行 = 约 650 行**。新增 **1 条**（N4-01 P2），撤回 **1 条**（N3-01）。

**两个待判问题的定论**：
- **N3-01（券能不能以别的 aud 连）**：**不能**。卡住它的是 `host-token.ts:393` 的 `claims.aud !== expectedAud` 本身，不是别的道；上轮的结论作废。
- **孤儿进程（主进程被强杀后子进程怎么办）**：**能自回收，不需要靠下次启动**。宿主 `api/main.ts:53-77` 的 2s 探活双判据（ppid 变化 / `kill(pid,0)` 失败）触发 `exitWithCleanup()`，先 tree-kill MCP 子进程再 `exit(0)`；`sidecar.rs:890-892` 的首轮清扫是第二道。

**本报告之后仍未覆盖**：`main.rs:1364` 窗口创建/导航守卫函数体、`open_bot_window`/`open_workbench` 主体、`sidecar.rs:620-790` 的 `spawn_child` 内部、`main-world-interceptor.ts` 的 XHR hook 主体与 `captureChatRequest` 字段抽取、`storage.ts:92-234` 的 UPSERT 去重分支；以及全部运行期验证（cargo / 安装包 / 真机 netstat）。