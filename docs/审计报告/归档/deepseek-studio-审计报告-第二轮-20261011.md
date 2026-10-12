# deepseek-studio 代码审计报告（第二轮 · 执行层）

- 日期：2026-10-11
- 范围：chat-* 能力、DOM 辅助、PoW、SSE 提取器、本地 HTTP API、桥接存储
- 方法：函数体逐行通读 + 并发时序仿真（python_exec 复现）+ 静态类型/测试基线
- 基线：tsc --noEmit 退出码 0；vitest 24 文件 / 201 用例全绿
- 本轮新增：3 Critical / 3 High / 4 Medium / 2 Info

---

## 1. 本轮最严重：存储层并发丢更新（已仿真复现）

### R2-C1 桥接存储并发写丢更新（Critical，High 置信，已复现）

- 位置：`src/bridge/storage.ts` `setOperation` / `removeOperation` / `clearOperation`
- 代码路径：
```ts
async function setOperation(entries) {
  await ensureLoaded();
  ...
  const next = new Map(items);          // (A) 读取『当前』快照
  ...
  await commit(next, changes, {...});   // (B) 内部 await backend.writeBatch（磁盘 IO）
}
async function commit(next, changes, batch) {
  ...
  await deps.backend.writeBatch(batch); // 期间可被另一调用打断
  items.clear();                        // (C) 全量替换，覆盖对方的写入
  for (const [k,v] of next) items.set(k,v);
}
```
- 复现（python_exec 精确模拟 A/B/C 时序，两个并发 set 各写一个 key）：
```
并发两个 set 后 items = {k2: 2}
期望 {k1: 1, k2: 2}；若只剩一个 => lost update 成立
```
- 机理：`commit` 不是原子的。两个 `setOperation` 各自基于 `new Map(items)` 计算 `next`，在 `await writeBatch` 的 IO 窗口内交错，后完成者的 `items.clear()` + 全量回填会把先完成者的 key 抹掉。
- 影响：`chrome.storage` shim 是页端持久化真相源（工具授权态、会话状态）。任何并发写（多监听器、多 key 先后 set、set 与 remove 交错）都可能静默丢失一条。属于「成功返回但数据丢了」的隐蔽型 Critical。
- 建议：把「读快照 → 写后端 → 更新内存」串行化（每个 area 一条 promise 队列 / mutex），或改为按 key 增量更新而非全量 `clear()+replace`。
- 注：这是本轮唯一通过可执行仿真坐实的并发缺陷，非静态猜测。

---

## 2. chat 能力层缺陷

### R2-C2 chat-send 未经验证即宣告成功（Critical，Medium-High 置信）

- 位置：`src/capabilities/chat-send.ts` `execute()`
- 代码：
```ts
// 策略 4：对输入框合成 Enter
if (input) {
  pressEnter(input);
  return { ok: true, data: { sent: true, via: 'enter-key' } };  // 无条件成功
}
```
- `pressEnter` 返回 `void`，仅 dispatch 三个合成事件；execute 不检查输入框是否清空、是否产生新消息。合成 Enter 在 React 受控输入上常被忽略（尤其 IME 组合态），此时消息根本没发出，但工具回报 `ok:true, sent:true`。
- 叠加缺陷：策略 3 `const legacy = input ? null : queryFirst(...)` —— 只要 `input` 非空（几乎总是），传统候选按钮**永远不会被尝试**，回退链实际少一环。
- 后果：AgentLoop 收到「工具成功」，继续请求模型续跑；而聊天页实际没有新消息，完成检测只能靠 120s 看门狗。表现与上一轮 C6 同源：假成功驱动的静默退化。
- 建议：Enter 回退后做一次可判定性检查（输入框已清空 / 消息数增加），无法确认则返回 `{ok:false, error:'send-unconfirmed'}`。

### R2-H1 chat-send 全局圆形按钮可能点错控件（High，Medium 置信）

- 位置：`src/capabilities/chat-send.ts` `findGlobalSendButton`
- 选择器 `div.ds-button--circle` / `.ds-button--circle` 是通用圆形按钮类，页面上可能存在多个（附件、语音、停止生成等）。全局回退取第一个命中即点击，可能误触「停止生成」等按钮。
- 建议：全局回退需附加语义约束（aria-label 含「发送/send」、或位于 composer 容器内），或干脆取消全局回退，仅保留「输入框邻近 + Enter」。

### R2-H2 SSE 提取器 THINK 过滤依赖脆弱字符串匹配（High，Medium 置信）

- 位置：`src/inject/sse-text-extractor.ts` `extractLine`
- 代码：
```ts
if (typeof obj.v === 'string') {
  const p = String(obj.p ?? '');
  if (p && p !== 'response/fragments/-1/content') return '';   // 白名单式放行
  return this.activeFragmentType === 'THINK' ? '' : obj.v;
}
```
- 单字符增量只在 `p` 恰为 `'response/fragments/-1/content'`（或空）时放行。上游一旦调整该路径（如 `-2`、改名），所有单字符增量被静默丢弃 → 可见流空。属「靠魔法字符串维持」的脆弱契约。
- 另：下方 BATCH 数组分支未参考 `activeFragmentType`，THINK 段的数组增量不会被过滤（与单字符分支口径不一致）。
- 建议：抽出常量并加一条契约测试固定该路径；数组分支与单字符分支共用同一 THINK 过滤口径。

---

## 3. API / 可观测性层

### R2-H3 PoW 模块残留调试日志泄漏到页面控制台（High，High 置信）

- 位置：`src/inject/pow.ts`（`console.log` 命中数 = 2）
- 代码：
```ts
console.log('[pow] challenge headers:', Object.keys(headers), 'target:', targetPath);
console.log('[pow] challenge status:', resp.status, 'body:', respText.slice(0, 500));
```
- 这是注入到 chat.deepseek.com 主世界运行的代码。`Object.keys(headers)` 暴露携带的鉴权头键名，`respText.slice(0,500)` 打印 challenge 响应体。调试残留进入生产注入产物，既污染站点控制台，也把内部协议细节暴露给页面环境。
- 建议：删除或降级为受开关控制的诊断通道（与 interceptor 的 `diag` 一致，默认关闭）。

### R2-M1 令牌桶无上界回收（Medium，Medium 置信）

- 位置：`src/api/server.ts` `createRateLimiter`
- `buckets: Map<string, {tokens,last}>` 按 Bearer 值建桶，条目永不删除。令牌轮换 / 多客户端场景下 Map 持续增长。
- 建议：加空闲桶回收（如超过 N 分钟未访问则删除）。

### R2-M2 CORS 与 PNA 放行口径不一致（Medium，Low-Medium 置信）

- `applyCors` 用 `isLocalOrigin`（仅回环）；PNA 预检额外放行 `DEEPSEEK_ORIGIN`。两处白名单语义不同，后续维护易改错其中一处。
- 建议：抽出统一 origin 判定函数并注明「WS 通道额外允许 DeepSeek 页」的理由。

---

## 4. 其他

### R2-M3 chat-read 角色推断启发式脆弱（Medium）
- `USER_HINT` 含「你/我发」、`ASSISTANT_HINT` 含「思考/reasoning」等中文词，对 `textContent` 前 48 字符做匹配。回答正文以「你」开头就会被误判为 user。仅影响标签，不阻塞读取，故 Medium。

### R2-M4 dom.setInputValue 未派发 React change 事件（Medium）
- 只 dispatch `input` 事件。若目标组件监听 `change` 或依赖 `beforeinput` 组合态，值可能不进入 React 状态（发送按钮恒灰）。建议补 `change` 事件并覆盖 IME 场景。

### R2-I1 pow.ts `console.log` 与文件头「参考 deepseek++」注释均为迁移残留（Info）

### R2-I2 bridge/storage `commit` 中 `bytesInUseOf` 每次全量 JSON.stringify（Info，性能）

---

## 5. 本轮方法论反思

1. **并发缺陷必须靠时序仿真，不能靠读代码「感觉」。** R2-C1 我第一遍读只觉得「全量 clear 有点重」，是写出 A/B/C 交错时序并跑出来（输出只剩 k2）才升级为 Critical。这与「静态扫描只能当线索」一脉相承——读代码产生假设，可执行仿真给出判决。
2. **「返回 ok:true 但未验证」是本项目反复出现的模式。** 上一轮 C6（无页回退假成功）、本轮 R2-C2（chat-send 未验证发送），根因相同：把「调用没抛错」当成「事情做成了」。建议把「成功必须携带可判定证据」写成能力层不变式。
3. **注入产物的调试残留是独立审计项。** PoW 的 console.log 在源码里人畜无害，但它是注入到第三方站点主世界的代码，泄漏面完全不同。建议对 `src/inject/**` 单独加「生产构建禁止 console.*」的构建期检查。
4. **魔法字符串契约（R2-H2）应转为可测常量。** `response/fragments/-1/content` 这类路径散落在条件判断里，上游一改就静默失效，且无测试固定。
5. **工具自身参数错误也要如实记录。** 本轮两次工具失败均为我的参数问题（await 位置、Substring 越界），已修正重试；审计日志里应保留这类自纠记录，避免把「我的调用姿势错」误记成「被测代码有 bug」。

---

## 6. 两轮汇总与修复优先级

| 轮次 | Critical | High | Medium | Info |
|------|----------|------|--------|------|
| 第一轮（工具调用链路） | 6 | 4 | 5 | 3 |
| 第二轮（执行层） | 3 | 3 | 4 | 2 |

合并去重后建议顺序：
1. 第一轮 C1（契约续读映射）、C4（断线清 pending）— 影响面最广。
2. 本轮 R2-C1（存储丢更新）— 已复现，数据完整性风险。
3. 本轮 R2-C2（chat-send 假成功）— 与第一轮 C6 同源，一起治理「假成功」模式。
4. 第一轮 C2/C3、本轮 R2-H2/H3 — 多为一行级或常量级修复。
5. 其余 M/I 级随迭代清理。

---

## 附录：本轮核查证据索引

- 存储并发：`src/bridge/storage.ts` `setOperation`/`commit`；仿真输出 `{k2:2}`
- chat-send：`src/capabilities/chat-send.ts:1854+` `execute()` 全函数体
- PoW 日志：`src/inject/pow.ts`，`console.log` 命中数 = 2（含 headers 键名与 challenge body）
- SSE：`src/inject/sse-text-extractor.ts` `extractLine` 单字符/数组分支
- 限流桶：`src/api/server.ts` `createRateLimiter`
- 基线：`npx tsc --noEmit` 退出码 0；`npx vitest run` 24 文件 / 201 用例通过
