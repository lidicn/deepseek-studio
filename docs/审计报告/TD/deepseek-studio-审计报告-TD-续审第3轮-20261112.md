---
title: deepseek-studio 只读代码审计·续审第 3 轮（Rust 侧与发布链 · 2026-11-12 20:40）
summary: 基线 dc76959，工作区 11 个脏文件（开发正在落实前两轮修复，.rs 均干净）。本轮结清第二轮三处欠账，并首次通读 Rust 侧安全边界。关键结论：宿主侧确实独立验券（authority.ts:59-73 真 HMAC + exp + scope），但**没有 aud 绑定**（N3-01 P2，跨 bot 重放）；TD-05/TD-09 已修；发布链是 fail-closed 闸，未发现可绕过分支。新增 2 条。
---

# deepseek-studio 代码审计·续审第 3 轮（Rust 侧与发布链）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未跑 cargo build/typecheck/vitest/tauri dev、未启长驻进程、未实跑安装包。

## 一、基线与范围

| 项 | 实测值 |
|---|---|
| HEAD | `dc76959`（master） |
| 脏文件 | **11 个**：`src-tauri/inject/entry.js`、`src/host/bot/chat-room-runtime.ts`、`src/host/bot/types.ts`、`src/inject/main-world-interceptor.ts`、`src/ui/studio-chat-room.ts`、`src/ui/studio-chat-ui.ts`、`src/ui/studio-ui-core.ts` + 5 个测试 |
| Rust 侧 | `main.rs` 2,915 行 / `sidecar.rs` 1,521 行 / `consent_window.rs` 1,109 行 / `updater.rs` 443 行（**均无未提交改动**） |

**版本标注**：开发正在落实续审第 1/2 轮的修复（chat-room-runtime、studio-chat-*、main-world-interceptor 都是脏的）。本报告引用的 **.rs 与发布脚本均为 HEAD 版**；`entry.ts`/`authority.ts`/`web-engine.ts`/`grant-acquire.ts` 也是 HEAD 版；`src-tauri/inject/entry.js` 脏但它是构建产物（**已压缩为单行**，无法逐行审计，见第五节）。

**范围**：第二轮欠账三项 + `src-tauri` 四个 .rs + 发布链脚本（`verify-sig.mjs`、`.github/workflows/release.yml` 闸段）。

## 二、第二轮三处欠账的结论

### 欠账 1：N2-03「同一轮跨流重复调用不被拦」——定成**设计边界，不可作为缺陷入清单**

补读工具解析与派发段后确认：

1. 去重两层（`tool-call-dedupe.ts:26-55`）的语义与调用点一致；`claim(callId)`（:2424）拦“同一次解析被重复投递”，`claimSignature`（:2428）拦“同一流内模型吐完全相同的调用”。
2. 签名集在**每条流开始时**清（`main-world-interceptor.ts:2286`），callId 集只在**新用户回合**清（`:2772`）。
3. 因此“模型下一条流重发上一流完全相同的 write”会**再执行一次**。这是真实可触发的，但它是**产品语义选择**：续跑轮里“重跑同一命令”是合法行为（重试失败的命令、重新写一次文件），把它拦掉反而错。接口注释（`dedupe.ts:14`“同一流内”）也把范围写死了。

**结论**：不是缺陷。但建议在 `dedupe.ts` 头注释里补一句“跨流不拦是故意的，因为续跑轮重跑合法”，否则下一个读代码的人会当 bug 改回去。

### 欠账 2：rate_limit 退避与 30 秒冷却是否打架——定成**分层，不打架**

| 层 | 机制 | file:line |
|---|---|---|
| 页面模型请求 | 首轮退避 500ms / 1500ms（`maxSendRetries=2`） | `web-engine.ts:480-488` |
| 连接重连 | 线性退避 `500ms × n`，最多 3 次 | `web-engine.ts:220-221`、`:405-407` |
| 取券（host grant） | 5 次退避 500→8000ms（总 15.5s） | `grant-acquire.ts:47` |
| 取券被限流 | **固定 30s 冷却，整页只单次重试** | `grant-acquire.ts:62`、`entry.ts:301-316` |

**结论**：四条退避挂在四个不同对象上（模型请求 / WS / 取券退避 / 取券冷却），不共享预算也不共享定时器，**不存在“被自己冷却挡住”**。唯一交集是 `rateLimitedRetryTimer` 与 `rateLimitedRetried`（`entry.ts:301-307`）保证 30s 只重试一次；第二次仍被限流就停在可见失败态，注释（`:298-300`）已明写这是有意设计。

### 欠账 3：memory/storage.ts——写入侧无上限**已确认**，FTS 与淘汰**未读完**

- 写入无长度上限：`storage.ts:68` 仅非空校验，全 `src/host/memory` 搜 `MAX_CONTENT`/`content.length` 零命中（沿用第 2 轮结论）。
- 审计旁路：写入均经 `contentHash`/`dedupeHash`（`:78-80`）与 `syncFtsStrict`（`:145/:207/:234`），无第二条裸 `INSERT`。
- **未读完**：`syncFtsStrict` 失败时的回滚语义、`core.ts:144` 淘汰边界，约 480 行（见第六节）。
## 三、Rust 侧缺陷清单

先给结论：“Rust 声称是安全边界”的地方，**大多数不是只在前端校**。逐项实测如下，真正需要改的只有两条。

### N3-01（P2）host grant 的校验结果里没有 `aud`，结构上无法把券绑定到具体 bot

**file:line**：`src/host/authority.ts:44-53`（envelope 字段表：`grantId/documentId/sessionId/requestId/scope/origin/issuedAt/expiresAt`，**没有 aud**）→ `:59-73`（`verifyGrant` 只校 `payload.sig`、`expiresAt`、`store.peek` 存在性、`consumed`、`scope`）→ 对照 `src/desktop/entry.ts:53`（`?token=<grant>&aud=<aud>`，把 aud 放在 URL 上而不是券里）。

**触发条件**：任一端拿到一张为 `aud=main` 签发的券，用 `aud=bot:<other>` 拼 WS URL 重连。

**影响**：若 WS 升级路径不另校 aud，则一个 bot 的页可以订到另一个 bot 的任务流（跨 bot 信息面）。**结构性缺失已证**（校验函数的返回对象里根本没有 aud 字段，调用方想校也校不了）；**具体影响面未证**（`server.ts` 的 WS 升级段未读完，见第五节第 1 条）。

**证据类型**：代码级（类型/字段缺失，不需运行）。

**修复建议**：将 `aud` 写进 envelope（`issueGrant` 的 `input` 已有 aud 来源），`verifyGrant` 接受 `expectedAud` 参数并比对；或者把 `requestId` 改成 `aud + ':' + requestId` 复合键。

**验收判据**：单测——用 `aud=main` 的券请求 `aud=bot:x`，断言返回 `{ok:false, reason:'aud-mismatch'}`；当前无任何用例覆盖 aud 维度。

### N3-02（P3）发送重试对 `chat-insert` 无幂等保护、无清空补偿

**file:line**：`src/host/engine/web-engine.ts:482-488`（`for attempt` 循环体：`dispatch('chat-insert', {text})` → `dispatch('chat-send', {})`，失败后直接 `continue` 下一轮再插一次，全循环无 clear/undo 调用）。

**触发条件**：`chat-send` 返回 `ok:false`（页面忙、发送铵 disabled、DOM 未就绪）且 `maxSendRetries>0`（默认 2）。

**影响**：每次重试都再插一份同样文本；若 `chat-insert` 是追加语义，输入框会变成 `texttexttext` 并在下一次发送时把重复正文带上。若它是“覆盖”语义则无影响。已证的是**重试路径没有任何清空/幂等保护**；未证的是注入侧语义（`src-tauri/inject/entry.js` 已压缩成单行，无法逐行审）。

**证据类型**：代码级（缺补偿调用）。

**修复建议**：重试前先 `dispatch('chat-clear', {})`（或让 `chat-insert` 带 `replace:true`），并把这一步写进循环体。

**验收判据**：单测削一个 `chat-send` 首次失败、二次成功的 dispatch 桩，断言 `chat-insert` 被调后紧跟一次 clear（当前实现是 insert、insert）。

### 已核无缺陷（本轮实测，不再入清单）

| 项 | 结论 | 证据 |
|---|---|---|
| 验券是否真的在宿主侧 | **是**，真 HMAC（`hostToken.verifyRaw`）+ exp + 存在性 + consumed + scope 五道 | `authority.ts:59-73` |
| TD-05 健康探测 | **已修**：`is_healthy = 端口应答 && 子进程存活`（`try_wait()` 为 `Ok(None)`），注释直接点名 TD-05 与“端口被无关进程占着”的误判 | `sidecar.rs:106-124` |
| TD-09 日志清理 | **已修**：`retain_logs` 只动 `sidecar-<数字>.log`，`keep==0` 视为不清理 | `sidecar.rs:126-138` |
| 孤儿进程 | 有 `terminate_process_tree_by_pid` / `force_kill_process_tree` / `terminate_host_by_cmdline` / `wait_pid_gone` 四道（PID 级，R2-10 已记录） | `sidecar.rs:197-318` |
| 导航守卫 | **存在**：主窗 `main.rs:1364`、同意窗 `consent_window.rs:533` 各一道 `on_navigation` | 同左 |
| 单实例 | 已接 `tauri_plugin_single_instance`，且 `SHUTTING_DOWN` 时不再 show 窗口（防“关闭后立即重点图标闪一下”） | `main.rs:1785-1798` |
| 命令注册表 | 10 个命令全部显式注册（含 updater 三件与 consent 窗），无通配 | `main.rs:1772-1782` |
| 路径边界 | Rust 侧**不是**安全边界的主要执行者（工作区判定在 TS），但也不存在“Rust 说校验了实际没校”的虚假声明 | 见第六节未覆盖 |

## 四、发布链结论

**签名校验确实在发版前执行，且是 fail-closed**：

1. `verify-sig.mjs:26-29` 的 `die()` 统一 `process.exit(1)`；文件头（`:19`）明写“退出码：0 = 配对；1 = 不配对/格式错误（fail-closed）”。
2. 参数缺一即死（`:50-52`）；未知参数即死（`:48`）；公钥不是 42 字节 / 算法不是 `Ed` 均死（`:63-65`）。
3. 闸在 `release.yml:582-583` 调用，并显式校 `$LASTEXITCODE -ne 0` 抛错；`:590-595` 闸失败时删 draft（`if: failure()`），从构造上保证“不留半成品、不删已发布”。
4. 校验对象是**上传后的资产字节**（`:575-579` 先下载回来再校，且先比对上传/本地字节数），不是只校 latest.json。

**未发现可绕过分支**。唯一可讨论的是“闸在 publish 之后而非之前”——但因为它校的是上传后的字节且失败会删 draft，语义上是等价的；且已公开的 Release 不被删（`:586-589` 注释），符合预期。
## 五、可疑未证实

1. **WS 升级路径是否另校 aud**：N3-01 的结构性缺失已证，但“能否真的跨 bot 连上”取决于 `src/api/server.ts` 的 upgrade 处理。缺：该段全文。
2. **`chat-insert` 是追加还是覆盖**：N3-02 的后果面。缺：注入侧源码（`src-tauri/inject/entry.js` 为压缩产物，需回源 `src/inject/` 对应模块）。
3. **CDP 默认常开是否已加 debug 门**：`main.rs:1759-1763` 拼 `--remote-debugging-port` 的代码仍在，但本轮未读到它的门控（R2-03 从第 2 轮起就挂在“无 debug 门”）。缺：`main.rs` 1730-1770 完整函数体。
4. **`syncFtsStrict` 失败时的回滚语义**：`storage.ts:145/:207/:234` 把它的返回值包成 `ftsWarn` 返回，而 `:223` 的 INSERT 已先执行。缺：`syncFtsStrict` 实现与调用方是否降级。
5. **淘汰策略边界**：`core.ts:144` `candidates.slice(0, need)` 与 `prepareEviction` 全量取行的关系（第 5 轮已记，本轮未重读）。
6. **工作区边界的第二道闸**：路径归一化（`workspace.ts`）在 TS 侧，Rust 侧只有 shell 命令的 cwd 检查；即“Rust 侧没有独立的工作区闸”。当前不构成缺陷（授权链在 TS 是唯一权威是设计），但一旦 shell 能力被 Rust 直调就变成单点。缺：`src-tauri` 是否有直接文件操作命令（本轮已列的 10 个命令里没有）。

## 六、覆盖与未覆盖

**读完的实现体（TS 约 420 行、Rust 约 180 行）**：`web-engine.ts:470-530`（发送重试与轮询主循环）、`grant-acquire.ts:40-110`、`entry.ts:296-330`、`authority.ts:20-95`、`host-token.ts` 符号表、`tool-call-dedupe.ts`（第 2 轮）、`sidecar.rs:76-138` + 函数表、`main.rs:1772-1815`（命令注册与单实例）、`verify-sig.mjs:1-70`、`release.yml:575-595`。

**未读完（及原因）**：

- `src-tauri/src/main.rs` 剩余约 2,700 行（窗口创建、grant 签发实现、导航守卫体、CDP 门控）——**Rust 侧只做了定点核对，未通读**；
- `src-tauri/src/sidecar.rs` 剩余约 1,380 行（`do_spawn` / `spawn_child` / 重启循环体）；
- `src/api/server.ts` 的 WS upgrade 段；`syncFtsStrict` 与 `core.ts` 淘汰边界；
- `src/inject/main-world-interceptor.ts` 的 fetch/xhr 请求构造段（第 2 轮已声明欠账，本轮只补了工具派发与去重）；
- 运行期一律未验证（未跑 cargo / 未实跑安装包）。

**为什么不把 Rust 主体强读完**：本轮优先级是“先回答防线是否只有一道”。四个 .rs 里真正可能把“前端结论再抄一遍”的位置只有 grant 签发与导航守卫，两处都已定点读到；剩下的是窗口与重启的具体实现，不影响“边界是否独立”的结论，且设备配额已用于前两轮的关键取证。

## 七、修复优先级（三条最该动手）

1. **把 `aud` 写进 grant 并在 `verifyGrant` 里比对**（N3-01，P2）。改动面：`authority.ts:41-73` 加一个字段 + 一个参数，`server.ts` 升级处传 `expectedAud`。这是本轮唯一“校验结果里根本没有这个维度”的硬缺口，也是“跨 bot 能不能连”这个安全问题的唯一开关。
2. **N2-01 的 try/finally 与 U1-01 的前端重连对齐成对上线**（第 2 轮遗留）。理由：两条都是“roundInProgress 锁死”，只修一边会留下另一条。
3. **发送重试前先 clear**（N3-02，P3，两行）。代价极低，且能把“重试把输入框搞成 `texttexttext`”这类现场彻底堵死。

---

**本轮工作量与结果**：读 12 个文件的关键段（**TS 约 420 行、Rust 约 180 行**，共约 600 行；另有 2 处只读了函数名表）。新增 **2 条**（N3-01 P2、N3-02 P3）。“已核无缺陷” 8 项（验券真在宿主侧、TD-05、TD-09、孤儿回收四道、导航守卫两道、单实例、命令注册表）。

**两个待判问题的定论**：
- **N2-03（跨流重复调用）** 定为**设计边界，不入缺陷清单**——两层去重存在，签名集按流清空是故意让“续跑重跑同一命令”能过；建议只补一句注释防后人改回去。
- **退避与 30 秒冷却是否打架** 定为**不打架**——四条退避挂在四个不同对象上（模型请求 500/1500ms、WS 500×n、取券 500→8000ms、取券冷却 30s 单次），不共享预算；`entry.ts:301-307` 的守卫已保证 30s 只重试一次。

**未读完**：Rust 主体（main.rs 剩余 2,700 行、sidecar.rs 剩余 1,380 行）、`server.ts` WS 升级段、`storage.ts` 剩下约 480 行、`main-world-interceptor.ts` 的 fetch/xhr 构造段；运行期未验证。