# 墨鉴 R3 · agent-channel.ts + page-runtime.ts 审计报告

- 审计对象：`E:/NAS/deepseek-studio/src/host/agent-channel.ts`（368 行 / 13,351 字符）、`page-runtime.ts`（590 行 / 26,440 字符）
- 性质：只读静态审计，未改动源码
- 前置：R2（desktop-host.ts）遗留两条悬案，本轮负责闭合

---

## 一、覆盖声明

**agent-channel.ts**：逐行读完 1-368 全部。

**page-runtime.ts**：逐行读完 1-590 全部，重点段已完整取证：options 定义(63-131)、failAllPending(207-220)、safeSend(222-228)、pickClient(230-243)、connection 处理(245-310)、result/consent-decision 回执(311-322 / 415-424)、kv/runtime-envelope(354-414)、tool-call 执行链(427-480)、disconnect 路径(482-505)、dispatch/requestConsent(522-553)、dispose(566-587)。

未展开（跨文件）：`host-token.ts` 的 `verifyWsQueryToken`、`image-proxy.ts` 的 `fetchImageAsDataUrl`、`agent-loop.ts` 的 `BotHandle.stop` 实现。本文对这三处的判断均标注「需 R4 确认」，不当缺陷下结论。

---

## 二、对 R2 两条悬案的答复

### R2-7（bot loop 是否泄漏）→ 成立，升级为 High

**证据**：`agent-channel.dispose()`（339-358）只做六件事——6 个 unsubscribe、`removeListener('upgrade')`、`wss.close()`、遍历 `sockets` 调 `ws.close()`、`sockets.clear()`。**全文没有任何 `bot.stop()` / `bot.loop.stop()` 调用**。

desktop-host 侧 1,064 行 `stop: () => mainBot?.loop.stop()` 只是**暴露给外部**的函数，`stop()` 主体（2,085-2,092）没调它。

结论：bot loop 没有任何主动停止路径。链路是 `desktopHost.stop()` → `agentChannel.dispose()` → 只关 WS。若 bot 正在跑长任务，loop 不会因为 WS 关闭而停（它在宿主侧运行，与 WS 生命周期无关）。

**修法**：`desktop-host.stop()` 里在 `hub.dispose()` 之前显式遍历 `botRegistry` 调每个 bot 的 `loop.stop()`；或在 `agentChannel.dispose()` 里接收一个 `onDispose` 回调由 host 注入。前者更符合「stop 语义自包含」。

### R2-9（dispatch 超时语义）→ 确认不对称，且发现更严重的问题

**证据**：
- 页端 `dispatch`（522-537）有 `setTimeout(..., dispatchTimeoutMs)`，超时 resolve `{ ok:false, error:'page-timeout' }`。
- host 侧 `routeExecution` 的 `await tool.execute(...)`（desktop-host 1,808）**裸 await，无任何超时**。

两条路径的超时语义完全不同：页端能力 30s 后放弃，host 侧能力无限等。

**更严重的**：见 R3-6 —— dispatch 超时后**不通知页端取消**。

---

## 三、新增发现

### R3-6（High）`dispatch` 超时后不通知页端，对端 pending 永久悬挂

**证据**（522-537）：
```ts
const timer = setTimeout(() => {
  pendingDispatch.delete(callId);
  resolve({ ok: false, error: 'page-timeout' });
}, dispatchTimeoutMs);
```
超时分支只删本地表 + resolve，**没有向 `picked.ws` 发送任何 cancel 消息**。

**后果**：宿主已放弃，页端仍在等这个 `callId` 的结果。若页端自身没有超时（未在本次审计范围内，但页端 pending 表通常靠回执清理），该 pending 永久悬挂，且页端那边对应的实际执行（可能是 shell 命令）**仍在继续**。

这与 dpp 审计 C8「Promise.race 只判不杀」完全同族：宿主放弃了，对端还在跑。区别是这里跨了进程/连接边界，更难发现。

**修法**：超时分支里 `safeSend(picked.ws, { type: 'dispatch-cancel', callId })`；页端收到后 abort 本地执行并清 pending。

---

### R3-7（High）`requestConsent` 超时同样不通知，用户看到「还能点」但点了无效

**证据**（539-553）：同样只 `pendingConsent.delete(callId); resolve('deny')`，不发 cancel。

**后果**：宿主已经按 deny 处理（fail-closed，方向正确），但页端的同意弹窗**仍然显示**。用户点「允许」后，回执走到 415-424 的 `consent-decision` 分支：`const p = pendingConsent.get(msg.callId)` 拿到 undefined，静默忽略。用户视角是「点了没反应」。

这是安全语义上的用户误导：用户以为还能批准，实际宿主已经拒绝。与 R3-6 同族但更贴近用户感知。

**修法**：超时分支发 `{ type: 'consent-cancel', callId }`，页端关闭对应弹窗并提示「已超时」。

---

### R3-8（High）`tool-call` 的 exec 是孤儿：无超时、页端断开后结果无人接收、不在 failAllPending 管辖内

**证据**（454-479）：
```ts
void exec(mapped.id, mapped.params, callBotId, msg.conversationId)
  .then((r) => { ...; safeSend(ws, {...}); })
  .catch(...)
```

三个问题叠加：
1. **`exec` 无超时**：它走 desktop-host 的 `invokeTool` → `executeTool` → `routeExecution` → `await tool.execute`，全程无超时（R2-9 已确认）。一个 90s 的 shell 就让页端等 90s。
2. **不在 `pendingDispatch` 管辖内**：`failAllPending('page-disconnected', id)` 只清理 `pendingDispatch` / `pendingConsent`，**不碰这个 exec**。页端断开后 exec 继续跑完，副作用照常发生。
3. **结果发给已关闭的 ws**：`safeSend` 检查 `readyState === OPEN`，已关闭则静默丢弃。页端永远不知道结果，而执行已经发生了。

**后果**：页端断开 → 工具继续执行 → 结果丢失 → 页端重连后重试同一工具 → **重复执行**。这正是「成功有契约、失败没有」的另一面：执行有副作用，但结果投递无保证。

**修法**：把 exec 登记进一个 `pendingToolCalls` 表（带 ownerId + callId），`failAllPending` 一并处理；或给 exec 包一层 `Promise.race([exec, timeout])` 并在超时/断开时尝试取消（取决于 executor 是否支持 AbortSignal）。

---

### R3-10（High）入站消息只有 `result` 和 `consent-decision` 校验 `ready`，`kv-set` / `tool-call` 等未校验

**证据**：
- `result`（316）：`if (!rec.ready || rec.untrusted) return;`
- `consent-decision`（418）：同样
- **`kv-get`(354) / `kv-set`(363) / `kv-remove`(372) / `runtime-envelope`(381) / `debug-eval-result`(425) / `tool-call`(427)：全部没有 ready/untrusted 校验**

**后果**（按严重度）：
1. **`kv-set` 未握手即可写宿主 `storage.json`**。`kvStore.set` 落到 desktop-host 的 `kvSet`（1,387-1,399），进而写 `~/.config/deepseek-studio/storage.json`。一个拿得到 token、连上但从不发 hello 的进程就能写任意键。
2. **`tool-call` 绕过 `rec.botId` 身份**：450-452 行 `const callBotId = rec.botId ?? msg.botId;` —— 未握手时 `rec.botId` 为 undefined，直接采用报文里的 `msg.botId`，攻击者可自报任意 bot 身份进入授权链（虽然授权链本身会再校验，但 bot 级白名单/审计归属就错了）。
3. 这违反 R2-02 自己写下的设计意图：235-236 行注释「未完成 hello 握手（ready=false）的连接也必须跳过——已连接但从不发 hello 的本机进程会成为合法 dispatch 目标」。**出站修了，入站没修**。

**前提**：仍需通过 token 校验（245 之后的握手阶段，`verifyWsQueryToken` 在 connection 回调开头，本次未逐行读到该行号，但注释 67-70 明确说明 P0-2 已修 token 校验）。所以不是「任意网页」，而是「拿到 token 的本地进程」。token 在 config.json，本地可读。

**修法**：在 `ws.on('message')` 的 `JSON.parse` 之后、分支分派之前，统一加一道门：除 `hello` 外的所有消息类型，若 `!rec.ready || rec.untrusted` 一律 return（或回一个 `not-ready` 错误）。这是一处改动覆盖全部入站分支。

---

### R3-1（Medium）`handle()` 的 `send` 分支 ack 顺序错误：先 ack(true) 再 await

**证据**（277-286）：
```ts
const bot = options.host.bots.get(botId);
if (bot.running) { ack(false, undefined, 'agent-busy'); return; }
ack(true, { botId });          // ← 先回成功
await bot.sendMessage(text);   // ← 可能 reject
```
`sendMessage` reject 后走 333 的 catch，再 `ack(false, err.message)`。**同一个 reqId 收到两个 ack，先 true 后 false**。

`chatRoomRuntime` 分支（272-275）同样模式。

**后果**：面板若按 reqId 只认第一个 ack（常见实现），会把发送失败误判为成功，UI 显示「已发送」但实际没发出去。

**修法**：`await` 之后才 ack；或先 ack 一个 `accepted` 中间态，完成后再发 `done`。

---

### R3-2（Medium）`bot.running` 检查是 TOCTOU，并发 send 可绕过 agent-busy

**证据**（278-284）：
```ts
if (bot.running) { ack(false, 'agent-busy'); return; }
ack(true, { botId });
await bot.sendMessage(text);
```
`running` 要到 `sendMessage` 内部才置 true。两次并发 `send` 都能通过检查，两个消息同时进入同一 bot。

**后果**：注释暗示 agent-busy 是防重入，但检查-使用之间有窗口。面板连点两次发送即可触发双消息入队，可能导致同一 bot 并发跑两条 loop。

**修法**：宿主维护 `Set<string>` of in-flight botId，检查与置位在同一同步块内完成；或让 `sendMessage` 内部 reject busy 作为唯一真相源。

---

### R3-9（Medium）`tool-call` 无 in-flight 并发上限

**证据**：427-480 的 `void exec(...)` 不等待、不计数。页端可连发 N 个 tool-call，宿主并发执行 N 个工具。

**后果**：N 个 shell 并发是资源问题；且每个都可能触发同意弹窗，用户被弹窗轰炸。

**修法**：加一个 per-connection 的 in-flight 计数，超限回 `too-many-pending`。

---

### R3-3（Low）`default:` 分支静默 return，不发 ack

**证据**（330-331）：`default: return;`。

**后果**：面板版本不匹配（发来宿主不认识的消息类型）时会一直等 ack。

**修法**：`ack(false, undefined, 'unknown-message-type')`。

---

### R3-4（Low）鉴权失败与 Origin 拒绝静默，无日志

**证据**：219-222（token 不对）、226-233（Origin 不对）都只 `ws.close()`，不调 `options.onError`。对比 `integrity-alert`（323-326）会调 onError 留痕。

**后果**：攻击探测（暴力试 token / 试 Origin）在日志里零痕迹。

**修法**：两处都加 `options.onError?.('agent-ws auth rejected', { reason })`，注意不要记 token 原文。

---

### R3-11（Medium）`trace` 分支用 `appendFileSync` 同步阻塞

**证据**（344）：`appendFileSync(nodePath.join(dir, ...), ...)`。同文件其他 IO 都是 async。

**后果**：每轮一行 JSONL 量小，但若页端 trace 高频（流式 delta 期间可能每帧一条），sync IO 会阻塞事件循环，连带卡住 HTTP server / WS / 其他工具的审计落盘。

**修法**：改 `fs.promises.appendFile`（fire-and-forget + catch），或用一个串行写队列。

---

### R3-12（Low / 待验证）`image_fetch` 无超时、无本地 try/catch

**证据**（406-411）：`const fetched = await fetchImageAsDataUrl(url.url);` —— 外层 message handler 是 async，异常会变成 unhandled rejection（除非 fetchImageAsDataUrl 内部全包）。

**判定**：标 Low + 待验证。注释说 SSRF/大小/类型校验都在 image-proxy 内，若那里也做了超时和 catch，本条不成立。需 R4 读 image-proxy.ts 才能定论。

---

## 四、做得好的地方（本轮确认，不是客套）

1. **`failAllPending` 按 ownerId 精确失败**（207-220）：只结算属于该连接的 pending，不误伤其他 bot 的请求。这是多 bot 化的正确做法。
2. **`ownerId` 绑死 callId**（195-198 注释 + 317-322 实现）：注释把威胁模型写清了（「恶意连接猜中别人的 callId 也不能替可信页伪造工具结果」），实现也对——`p.ownerId === id` 才 resolve。这是全仓少见的、**注释与实现严格一致**的安全代码。
3. **`logPageGone` 在 `failAllPending` 之前取计数**（487-488）：注释明确写「之后 pending 已被清空恒为 0」，并提到 20261031 复验时 `logs/` 0 命中只能判「证据缺失」。这是真做过验证、并从失败中学到东西的痕迹。
4. **`hello` 的 origin 双向校验**（267-274）：自报 origin 必须与握手 Origin 一致，防止谎报绕过。
5. **账号指纹去重**（283-307）：同账号双窗口即 fail-closed + 推阻塞消息，防封号铁律落地。
6. **`dispose` 先 resolve pending 再 clear**（576-586）：避免调用方 `await` 永久悬挂。
7. **`agent-channel.dispose` 移除 upgrade listener**（346-348）：F-L1 已修，注释标明来源。
8. **`safeSend` 的 readyState 检查**（agent-channel 128-136 / page-runtime 222-228）：不向 CLOSED/CLOSING 发送，agent-channel 还额外利用了 ws 内部的 CONNECTING 队列化。

---

## 五、修复优先级

| 序 | 条目 | 理由 | 改动量 |
|---|---|---|---|
| 1 | **R3-10** 入站统一 ready 门 | 一处改动覆盖全部入站分支；kv-set 未鉴权写盘是安全边界问题 | 小 |
| 2 | **R3-8** tool-call 孤儿执行 | 页端断开后副作用继续 + 结果丢失 → 重试即重复执行 | 中 |
| 3 | **R3-6 / R3-7** 超时不通知对端 | 补两行 `safeSend(..., 'cancel')`；页端配套改 | 小（宿主侧） |
| 4 | **R2-7 闭合** bot loop 无主动停止 | 优雅退出 + 与 R2-1/R2-2 同批 | 中 |
| 5 | **R3-1 / R3-2** ack 顺序 + TOCTOU | 面板状态正确性 | 小 |
| 6 | R3-9 / R3-11 | 并发上限 + async trace | 中 |
| 7 | R3-3 / R3-4 | ack 兜底 + 鉴权留痕 | 小 |
| 8 | R3-12 | 先验证 image-proxy | — |

**1-3 建议同批提交**：都在 `ws.on('message')` 与 `dispatch`/`requestConsent` 三个函数内，互不冲突。

---

## 六、给 R4 的输入

1. **`BotHandle.stop()` 的真实实现**（agent-loop.ts）—— 决定 R2-7 修法是「调 loop.stop()」还是「另有停止信号」。
2. **`verifyWsQueryToken` 的实现** —— R3-10 的严重度取决于 token 校验是否在 connection 回调最开头、是否有常数时间比较。
3. **`fetchImageAsDataUrl` 的超时与 catch** —— 决定 R3-12 是否成立。
4. **页端（`inject/`）是否有 `dispatch-cancel` / `consent-cancel` 的接收逻辑** —— R3-6/R3-7 的修法需要页端配合，若页端已有对应 handler 则只改宿主侧。
5. **页端 `tool-call` 的本地 pending 是否有超时** —— 若页端自己会超时，R3-8 的「悬挂」部分缓解，但「孤儿执行」部分不变。

---

## 七、本轮未做

- **未跑测试**。R3 全部结论为静态推演，未验证改动对既有 72 failed 基线的影响（R6 负责）。
- **未读页端**（`inject/`）。R3-6/7/8 的完整修法依赖页端是否已有 cancel handler，本报告只给宿主侧建议。
- **R3-12 未定论**，标「待验证」。
- 未审计 `runtime-envelope` 的 `image_fetch` 以外的命令扩展空间（当前只有 ping/kv_*/image_fetch，若未来加命令需重新评估入站校验）。
