# deepseek-studio 代码审计报告（第三轮 · 授权与生命周期层）

- 日期：2026-10-11
- 范围：grant-store、host-token/SecretRing、loader/lifecycle、integrity 探测、host-client 待决请求
- 基线：tsc --noEmit 退出码 0；vitest 24 文件 / 201 用例全绿
- 本轮新增：1 Critical / 3 High / 2 Medium

---

## 1. 关键缺陷

### R3-C1 host-client 的 kv / envelope 待决请求无超时，断线即永久挂起（Critical）

- 位置：src/desktop/host-client.ts
- 对比：sendToolCall 有 30s 定时器兜底；kvGet / sendEnvelope 只 pendingKv.set(requestId, {resolve}) 后 send(...)，没有任何超时。
- 后果：请求发出后若 ws 断开，kv-result 永远不回，Promise 永不 settle；pendingKv / pendingEnvelope 永不清理，反复重连持续累积。
  bridge/storage 的 remoteKv.writeBatch 会 await host.kvSet(...)，一旦挂起则整个持久化路径卡死。
  叠加第一轮 C4：宿主侧 pendingDispatch 至少 30s 结算，页端 kv 则无限挂起。
- 建议：与 sendToolCall 对齐加超时；并在 onclose 里遍历结算为 error。

### R3-H1 loader install() 在 lifecycle 真正启动前就报 running（High）

- 位置：src/inject/loader.ts install()
- installed=true; generation+=1; status='running'; void startLifecycle(); return {status:'running'}
- factory 抛错时 startLifecycle 会把 status 改 failed 并回调，但 install() 早已返回 running。
  调用方拿到「已成功运行」，实际能力可能一个都没启动。属「假成功」家族第三次出现。

### R3-H2 grant-store get() 三元表达式含死条件（High）

- 位置：src/host/grant-store.ts get()
- return g && !g.consumed ? g : g ?? null;
  展开：条件真→g；条件假→g??null。两种都返回 g（只要 g 存在），!g.consumed 是死条件，
  已消费的 grant 也会被 get() 返回。现状被 authority.verifyGrant 的二次 consumed 检查掩盖。
- 建议修正为：return g && !g.consumed ? g : null;

### R3-H3 lifecycle snapshot 硬编码，「资源归零」不变量是测试假阳性（High）

- 位置：src/inject/lifecycle.ts
- kernel.snapshot 硬编码 state:'running' 且 resources.total:0；noopScope 不做资源登记。
  loader.ts 声称「stop 后 snapshot 归零，验收跑 inject-loader.test.ts」——测试断言 0、实现恒 0，同义反复。

---

## 2. 其他

### R3-M1 integrity initial 边界会误报 replaced 致永久降级（Medium）
- startIntegrityProbe 快照 initial=read()；若此刻 __deepseekStudio 未赋值（undefined），
  之后对象出现判为 replaced → 宿主永久降级。现状赋值先于探测故不触发，顺序一改即误报。

### R3-M2 SecretRing 仅保留一个 previous，连续轮换丢首个旧密钥（Medium）

---

## 3. 方法论反思

1. 不变量可能被测试假阳性掩盖：断言 snapshot 为 0、实现也恒 0，用例通过只代表「常数等于常数」。
   建议反向验证——注入真资源，断言数字随之变化。
2. 假成功第三次出现（C6 / R2-C2 / R3-H1），跨三层复发，属团队级习惯，建议做全仓专项。
3. 超时兜底应统一：同文件三种待决请求，两种漏了定时器，建议抽公共 pending-request 助手。
4. 死条件要靠展开三元/布尔表达式发现，应列入可疑构造清单。

---

## 4. 三轮汇总

| 轮次 | 范围 | Critical | High | Medium | Info |
|------|------|----------|------|--------|------|
| 第一轮 | 工具调用链路 | 6 | 4 | 5 | 3 |
| 第二轮 | 执行层 | 3 | 3 | 4 | 2 |
| 第三轮 | 授权与生命周期 | 1 | 3 | 2 | 0 |
| 合计 | | 10 | 10 | 11 | 5 |

跨轮次反复出现的模式（优先治理）：
- 假成功：C6 / R2-C2 / R3-H1
- 断线不清理待决请求：C4 / R3-C1
- 测试假阳性：R3-H3

建议修复顺序：C1 -> C4 -> R2-C1 -> R3-C1 -> R2-C2/R3-H1（合并为「假成功」专项）-> 其余。

---

## 附录：本轮证据索引
- grant-store get()：src/host/grant-store.ts
- host-client 无超时：src/desktop/host-client.ts kvGet / sendEnvelope（对比 sendToolCall 有 30s）
- loader 假成功：src/inject/loader.ts install()
- lifecycle 硬编码：src/inject/lifecycle.ts kernel.snapshot
- integrity 边界：src/desktop/integrity.ts startIntegrityProbe
- SecretRing：src/host/host-token.ts rotate / accepted
- 基线：tsc --noEmit 退出码 0；vitest 201 用例通过
