# 墨鉴 R2 · desktop-host.ts 审计报告

- 审计对象：`E:/NAS/deepseek-studio/src/host/desktop-host.ts`
- 体量：2,194 行 / 89,813 字符
- 性质：只读静态审计，未改动源码
- 前置：R1.5（policy.ts + authorization.ts）、R1（墨鉴 35 条）

---

## 一、覆盖声明

逐行读完：1-2,194 全部。重点函数体：`createDesktopHost`(357-2,150)、`executeTool`(1,425-1,608)、`ensureConsent`(1,712-1,783)、`routeExecution`(1,785-1,858)、`start`(1,874-2,084)、`stop`(2,085-2,092)、KV 层(1,357-1,407)、`failPendingRunsOnDisconnect`(2,156-2,172)、`extractArtifactPaths`(2,179-2,184)。

未展开（跨文件，留给 R3/R4）：`platform-desktop` / `page-runtime` / `agent-channel` / `bot/*` / `engine/*` / `mcp-controller` 的具体实现。本文只对 desktop-host 的**编排逻辑**下结论，不对被编排模块的内部行为下结论。

---

## 二、对墨鉴既有结论的复核

| 墨鉴条目 | R2 判定 | 依据 |
|---|---|---|
| BUG-031 `testConnection` 无 finally 不 kill 子进程 | **成立，但根因在 mcp-controller** | desktop-host 1,322 行只 `automationManager.start()`，MCP 生命周期不归它管；BUG-031 的修复落点确实在 mcp-controller 自身 |
| BUG-036 initialize 失败泄漏活子进程 | **成立，且 R2 找到放大器** | 见 R2-1：host 的 `stop()` 连 automationManager 都不停，MCP 子进程更无从回收 |
| BUG-037 SSE `await res.text()` 永远 30s 超时 | **成立，与 desktop-host 无关** | 该路径不经 desktop-host 编排 |
| 「`routeExecution` 无页回退返回 ok:true 无 data」（studio C6） | **已修** | 1,844-1,849：`DOM_FREE_FALLBACK = new Set(['echo'])`，非 echo 返回 `no-page-for-dom-capability`。这是 R2-04 修复，代码注释也写明了动机「模型基于已发送继续推理，比报错更危险」 |

结论：墨鉴对 desktop-host 的**间接判断**没有误报，但也没有一条是直接读 desktop-host 得出的——它把 desktop-host 整块留在了「未覆盖区域」。R2 补齐后发现的问题，性质与墨鉴 35 条**不重叠**：墨鉴以「单函数内数据一致性」为主，R2 发现的以「生命周期与编排」为主。

---

## 三、新增发现

### R2-1（High）`stop()` 不停 `automationManager`，宿主无法优雅退出

**证据**：1,310-1,322 在 `createDesktopHost` 同步阶段就 `automationManager.start()`；2,085-2,092 的 `stop()` 只做四件事——`agentChannel.dispose()`、`conversationStore.bumpGeneration()`、`hub.dispose()`、`server.stop()`。**全文没有任何 `automationManager.stop()` / `.dispose()`**（已做全仓 grep 确认，只有 start 一处命中）。

**后果**：
1. 定时器不释放 → Node 事件循环被撑住，进程不会自然退出。
2. `onTaskTrigger` 到点仍会调 `agentSender`（1,311-1,319），此时 hub 已 dispose，异常被 1,316 的 catch 吞成一条 `console.warn`——用户看到的是「宿主已关闭但日志还在报 prompt task failed」。
3. 与 BUG-036 叠加：MCP 子进程泄漏 + automation 定时器泄漏，两者都让「关闭」变成「假关闭」。

**修法**：`AutomationManager` 补 `stop()`，`desktop-host.stop()` 里在 `hub.dispose()` 之前调用。

---

### R2-2（High）`kvFlushTimer` 未在 `stop()` 里 flush，100ms 窗口内写入静默丢失

**证据**：1,371-1,385 是 100ms 防抖批写，`pendingKvSet` / `pendingKvRemove` 在 timer 回调里才交给 `kvBackend.writeBatch`。`stop()`（2,085-2,092）没有 `if (kvFlushTimer) { clearTimeout(...); flushNow(); }`，也没有对 `pendingKvSet` 做最后一次同步落盘。

**后果**：`kvSet` 是 `STUDIO_EXECUTION_INDEX_KEY` 与 `STUDIO_EXECUTION_SESSION_PREFIX` 的唯一写通道（1,394-1,398 还顺手 emit 事件）。若关闭发生在写入后 100ms 内，这批执行索引/会话记录**永远不会进 storage.json**——不是丢一批日志，是丢「哪个会话跑了哪些工具」的取证数据。

**性质**：与墨鉴 BUG-012（save 四步无事务）、BUG-013（先 DELETE 再 recordLog）同族——**写链路缺少「关闭时兑现」的保证**。墨鉴从 memory 域查到两条，R2 在 KV 层查到第三条，说明这不是单点疏漏。

**修法**：`stop()` 开头 `if (kvFlushTimer) clearTimeout(kvFlushTimer)`，然后 `await kvBackend.writeBatch({ set: {...pendingKvSet}, remove: [...pendingKvRemove] })`，最后再 `server.stop()`。

---

### R2-3（High）`routeExecution` 抛异常时审计不留痕，违反自身承诺

**证据**：1,433-1,435 注释明确写「所有拒绝分支一律经由 finish() 出口，确保『没有一条调用走出未被留痕的路径』」。但 1,577 `const result = await routeExecution(...)` **没有 try/catch**，而 `routeExecution` 内部 1,808 `await tool.execute(...)` / 1,828 `await hub.dispatch(...)` 都可能 reject（能力实现抛错、WS 中途断开）。异常冒泡时，1,582 的 `audit.record` 不会执行。

**后果**：正是最需要审计的场景——工具执行炸了——反而没有审计记录。而 `finish()` 只覆盖了授权链路（consume 失败 / 未登记 / origin 拒绝 / hard-deny / consent 拒绝），执行链路的异常完全在保护之外。

**修法**：
```ts
let result: ToolExecutionResult
 try {
  result = await routeExecution(def, name, params, outsideApproved, botId)
} catch (err) {
  return finish('execution-failed', err instanceof Error ? err.message : 'execution-threw')
}
```

---

### R2-4（High）`kvGet` 首载竞态会覆盖已写入的新值

**证据**：1,362-1,368：
```ts
async function kvGet(key) {
  if (!kvLoaded) {
    Object.assign(kvCache, await kvBackend.readAll())   // ← await 期间 kvLoaded 仍为 false
    kvLoaded = true
  }
  return kvCache[key]
}
```
`kvLoaded` 在 `await` **之后**才置 true。两个并发 `kvSet` 各自 `await kvGet(key)` 时，会各自发起一次 `readAll()`；先返回的把旧盘数据写进 cache，后返回的再 `Object.assign` 一次，**把前一个 kvSet 已写入 kvCache 的新值覆盖回旧值**。

`kvSet` 在 1,388 显式 `await kvGet(key)` 才写 `kvCache[key]`，所以这个竞态是可达的：并发两次写入 → 第二次的 readAll 覆盖第一次。

**后果**：与 R2-2 不同——R2-2 是「关闭时丢」，R2-4 是「运行中丢」。丢的都是执行索引/会话，且不报错。

**修法**：加载提成单例 promise：
```ts
let kvLoadPromise: Promise<void> | null = null
function ensureKvLoaded() {
  return kvLoadPromise ??= kvBackend.readAll().then((all) => {
    Object.assign(kvCache, all)
  })
}
```

---

### R2-5（Medium）六个事件订阅 Set 在 `stop()` 时不 clear

**证据**：`agentListeners` / `chatRoomListeners` / `toolRunListeners` / `executionSessionListeners` / `executionIndexListeners` / `executionClearedListeners`（2,118-2,139 各自的 `on*` 返回 `() => set.delete(cb)`）。`stop()` 不 clear 任何一个。

**后果**：`stop()` 后 Set 仍持有回调闭包（通常捕获 UI 对象）。若同进程内重建 host（热重载 / 集成测试 / Rust 主进程托管下重启 Node 侧），旧回调会被新 host 的事件触发——幽灵订阅 + 闭包泄漏。与墨鉴 BUG-014（循环依赖）不冲突，但同属「注册了不回收」。

**修法**：`stop()` 里逐个 `.clear()`。

---

### R2-6（Medium）`debugEvalPending` 的 timer 在 `stop()` 时不清

**证据**：1,411 定义，正常路径在 2,071-2,072 清理（`clearTimeout(p.timer)`）。`stop()` 不清。

**后果**：关闭时若有 N 个 pending，每个拖住事件循环最多 5s，并在无人等待时 resolve。不崩，但与 R2-1 叠加会让「关闭」明显变慢。

**修法**：`stop()` 里遍历 `debugEvalPending`，`clearTimeout` 后 `.clear()`。

---

### R2-7（Medium）`mainBot` / `roomBots` 的 loop 不在 `stop()` 里停

**证据**：1,064 `stop: () => mainBot?.loop.stop()` 只是**暴露给外部**的一个函数；`stop()` 主体（2,085-2,092）没调它。是否泄漏取决于 `agentChannel.dispose()` 是否级联到 `bot.loop.stop()`——这在 agent-channel 内部，R2 未覆盖。

**判定**：**标记为待验证**，不直接列为缺陷。理由：若 `agentChannel.dispose()` 已级联，这条不成立；若没有，则是 High。这条需要 R3 读 `agent-channel.ts` 的 dispose 实现才能定论。我把它列出来是因为 `createDesktopHost` 的 stop 语义应当**自包含**，不应依赖下游模块的隐含行为。

---

### R2-8（Medium）`hardDenyPath` 的 `realpathSync` 在请求热路径上同步阻塞

**证据**：1,672-1,677 `fs.realpathSync(abs)`。调用点：1,496 `checkHardDeny(..., hardDenyPath(params))` 每次 executeTool 一次；1,701 `whitelistHit` 内部又调一次 → **单次工具调用最多两次 realpath**。

**后果**：UNC 路径 / 网络盘 / NAS 上 `realpathSync` 可能阻塞数百毫秒。这条链路是同步的，阻塞期间整个 Node 进程（含 HTTP server、WS、其他工具的审计）全部停摆。`E:/NAS/...` 正是这类路径。

**修法**：改 `fs.promises.realpath`，或对 `path.isAbsolute && 已在 workspace 内` 的常见情形跳过 realpath（只需防 symlink 逃逸时才做）。

---

### R2-9（Low）`routeExecution` 的 host 侧 `tool.execute` 无任何超时

**证据**：1,808 `await tool.execute(...)` 裸 await。

**后果**：墨鉴 BUG-018（rollback 逐条 AES 解密）、BUG-015（prepareEviction 全表扫）都在 `tool.execute` 内部，一旦慢，`executeTool` 整条链（含审计落盘）挂住且无 cancel。这与 dpp 侧 C8「Promise.race 只判不杀」同类，但 studio 侧连 race 都没有。

**判定**：Low 而非 High，因为宿主侧能力（shell/file/edit）本身有各自的超时；风险集中在 memory 域的同步 SQL/AES。建议给 `tool.execute` 包一层带 abort 的 race，与 R2-3 的 try/catch 一起改。

---

## 四、做得好的地方（R2 复核确认，不是客套）

1. **`executeTool` 的 fail-closed 骨架是对的**：1,439-1,442 的 `finish()` 统一出口 + 1,444-1,476 三层闸门（consume → 登记 → 能力存在 → origin）顺序正确，且 1,472-1,474 明确写了「不再因硬编码 origin 让闸门恒真」——说明历史缺陷（R2-05）已真修。
2. **`ensureConsent` 有世代号防护**（1,732-1,738）：等用户点同意期间若换档位/换工作区/断开，迟到的 allow 作废。这是全仓少见的、正确处理的 TOCTOU。
3. **`routeExecution` 的 host 优先顺序**（1,792-1,794 注释 + 1,795 实现）：宿主侧能力必须在「有页就派发」之前判定，否则 shell/file 会被劫持页驱动。注释把「更糟的情况」写明，是好的工程习惯。
4. **KV 写盘做了防抖批量化**（1,369-1,385）：注释点出 O(N²) 与崩溃半截损坏风险，方向正确——只是缺了 R2-2 的关闭兑现。

---

## 五、修复优先级

| 序 | 条目 | 理由 | 改动量 |
|---|---|---|---|
| 1 | **R2-3** 审计异常不留痕 | 违反自身 fail-closed 承诺；改动 5 行 | 小 |
| 2 | **R2-4** kvGet 首载竞态 | 运行中静默丢数据；改动 8 行 | 小 |
| 3 | **R2-2** stop 不 flush KV | 关闭时静默丢数据；改动 6 行 | 小 |
| 4 | **R2-1** stop 不停 automation | 宿主无法优雅退出；需给 AutomationManager 补 stop | 中 |
| 5 | R2-5 / R2-6 stop 清理 | 与 1-4 一起改，边际成本低 | 小 |
| 6 | R2-7 bot loop | **先验证** agent-channel.dispose 是否级联 | — |
| 7 | R2-8 realpathSync | 性能；NAS 场景收益大 | 中 |
| 8 | R2-9 execute 超时 | 与 R2-3 同批改 | 中 |

**1-5 可以一次提交**：全部集中在 `stop()` 与 `kvGet` 两个小区域，互不冲突，且都是「加清理/加保护」的加法改动，不改变既有控制流。

---

## 六、给 R3 的输入

1. **`agent-channel.dispose()` 是否级联到 `bot.loop.stop()`** —— 决定 R2-7 是 High 还是不存在。
2. **`platform-desktop` 的 grant 签发/消费是否与 `executeTool` 的 consume 共用同一个 store** —— 若共用，1,448 的 `authority.consume` 与 1,861 的 `requestToolExecution` 之间有窗口，需查是否可能自签自消。
3. **`AutomationManager` 的 start 是否可重入** —— R2-1 的修法依赖它，若 start 不可重入则需要先 dispose 再 start。
4. **`hub.dispatch` 的超时语义** —— R2-9 说 host 侧 execute 无超时，但页端 dispatch 可能自带超时；需确认两条路径是否对称。

---

## 七、本轮未做

- 未跑测试（R6 强制轮负责）。墨鉴提到基线 72 failed，R2 的所有结论都是静态推演，**未验证「改完是否让既有测试变红」**。
- R2-7 未定论，已标「待验证」。
- 只审 desktop-host 的**编排逻辑**，被编排模块（mcp-controller / page-runtime / agent-channel / bot/*）的内部缺陷不在本轮范围。
