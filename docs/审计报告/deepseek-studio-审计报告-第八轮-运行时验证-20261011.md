# deepseek-studio 代码审计报告（第八轮 · 运行时验证与自我纠正）

- 日期：2026-10-11
- 范围：真跑测试基线；grant 消费链路（grant-store / authority）；tool-contract 命名别名
- 触发：用户「下一轮继续寻找界面相关 bug」
- 结论：**首次运行时验证**——测试基线不再全绿（33 文件 / 291 用例，2 失败）；
  失败根因是我第三轮 R3-H2 的修复建议被采纳后引入的回归；特此自我纠正

---

## 0. 基线变化（重要）

| 时点 | 文件 | 用例 | 结果 |
|------|------|------|------|
| 第一~七轮 | 24 | 201 | 全绿 |
| 本轮（第八轮） | 33 | 291 | **2 失败** |

项目在轮次间已有演进（新增 9 个测试文件、90 个用例）。基线不再全绿，必须查明。

---

## 1. 失败事实

```
FAIL tests/desktop/tool-authority.test.ts:22
FAIL tests/e2e/smoke.test.ts:49
  AssertionError: expected ''not-found'' to be ''consumed''
  Expected: "consumed"
  Received: "not-found"
```

两个测试都在验「一次性 grant 被消费后，重放必须报 consumed」。实际报 not-found。

---

## 2. 根因（已读全函数体确认）

### 当前 grant-store.get()（第 92 行附近）
```ts
get(requestId) {
  purgeExpired();
  const g = grants.get(requestId);
  return g && !g.consumed ? g : null;      // ← 已消费 → null
}
```

### 当前 authority.verifyGrant()
```ts
const grant = store.get(env.requestId);
if (!grant) return { ok: false, reason: ''not-found'' };        // ← 已消费在此被拦
if (grant.consumed) return { ok: false, reason: ''consumed'' };  // ← 不可达死代码
```

### 因果链
1. 第一次 consume：get() 返回 grant（未消费）→ consumed 检查过 → store.consume 置 consumed=true → ok。
2. 第二次 consume（重放）：verifyGrant → get() 因 `!g.consumed` 为假 **返回 null** →
   命中 `if (!grant) return ''not-found''` → 永远走不到 `if (grant.consumed)`。
3. 测试期望 ''consumed''，得到 ''not-found'' → 失败。

---

## 3. 自我纠正：第三轮 R3-H2 的建议方向是错的

第三轮我报「grant-store get() 三元表达式含死条件」并建议：
```
修正为：return g && !g.consumed ? g : null;
```
该建议已被采纳，**但它引入本次回归**。

现在回读原始写法：
```ts
return g && !g.consumed ? g : g ?? null;
```
- g 不存在 → null
- g 未消费 → g
- g 已消费 → 条件假 → `g ?? null` → **g**（原样返回）

即该表达式**三态都返回 g（只要存在）**，`!g.consumed` 确是死条件——但它两个分支等价这一事实，
说明 `get()` 的**真实契约是「原样取出记录（raw fetch）」**，消费态的判定归 `verifyGrant`。

我当时的错误：把「死条件」直接判为缺陷并改了方向，却**没有先确认调用方对 get() 契约的依赖**。
改后 get() 从「raw fetch」变成「fetch-if-valid」，砍断了 verifyGrant 里 `if (grant.consumed)` 分支，
使重放检测的专属原因码 ''consumed'' 不可达。

**正确修法（二选一，必须与调用方协同）**：
- A. 保持 raw-fetch 契约：`return g ?? null;`（或直接 `return g`），保留 verifyGrant 的 consumed 分支——
  这样死条件被消除、语义不变、测试通过。
- B. 若坚持 get() 过滤 consumed，则 verifyGrant 必须改用「能区分不存在 vs 已消费」的查询
  （如 store.getRaw / store.stateOf），否则 ''consumed'' 永远不可达。

**倾向 A**：改动最小、语义最清晰，且恢复第三轮前的正确行为。

---

## 4. 这是真 bug 还是仅测试期望不符？

两者都算，但**产品影响是次要的、可观测性层面的**：

- **安全面无漏洞**：重放仍被拒（ok:false）。`desktop-host.executeTool` 见 `!verification.ok` 即
  `finish(''denied'', verification.reason)` 拒绝执行。攻击者拿不到第二次执行。
- **可观测性退化**：审计里重放从 ''consumed''（重放检测）退化为 ''not-found''（未知令牌），
  二者在取证上含义完全不同——**系统不再能区分「重放攻击」与「伪造/过期令牌」**。
  对一个把「授权先于执行 + 全链路留痕」当核心不变量的项目，这是真实损失。
- **测试即契约**：两个独立测试都锁定 ''consumed''，说明这是**有意设计的原因码**，不是随手写的断言。

---

## 5. 附带发现：F4-C1 已被部分修复（非通用）

tool-contract.ts 现在同时存在下划线与点号两套键：
```
mcp_save: { id: ''mcp.save'', adapt: ... },
''mcp.save'': { id: ''mcp.save'', adapt: ... },   // ← 新增点号别名
mcp_test / ''mcp.test'' 同理
```
即第四轮 F4-C1 的「UI 点号名 → unknown-tool」被**逐项加别名**缓解（mcp.* 系列）。
但这是**枚举式补丁而非通用归一化**：`project.create` / `workspace.set` / `folder.pick` /
`policy.set` / `mcp.remove` / `memory.delete` / `skill.list` 等点号名是否都有别名，需逐项核对。
建议仍按第四轮方案做通用处理（page-runtime 先查 registry id 再回落映射），避免遗漏。

---

## 6. 方法论反思（本轮价值最高）

1. **这是八轮里第一次真跑验证，且它立刻抓到了静态推理的错。** 前七轮基线全绿，我据此说
   「缺陷都在测试盲区」；本轮真跑发现基线早已不是全绿——**静态读代码永远替代不了跑一次**。
   这正是既有记忆「留一轮真跑」的价值实证。
2. **我的修复建议本身成了缺陷来源。** 第三轮我只读 `get()` 内部就判「死条件 = 缺陷」并给方向，
   没核查调用方 `verifyGrant` 对该函数契约的依赖。**审计给修复建议时，必须与给缺陷结论同等严格：
   先确认调用链，再定方向。** 这与记忆 #2「审计下结论前必须读函数体」是同一条教训的延伸——
   读了自己的函数体还不够，还要读**调用它的人的函数体**。
3. **「死条件」未必是 bug，可能是「契约错位」的信号。** `!g.consumed` 在 get() 里是死的，
   因为 get() 不该管消费态。正确动作是「消除歧义、保持契约」，不是「顺手改语义」。
   改死条件前先问：这个条件的**意图**属于这一层吗？
4. **测试即契约。** 两个测试锁 ''consumed''，就是设计意图的书面记录；改实现前应先读测试。

---

## 7. 八轮汇总

| 轮次 | 范围 | Critical | High | Medium |
|------|------|----------|------|--------|
| 一 | 工具调用链路 | 6 | 4 | 5 |
| 二 | 执行层 | 3 | 3 | 4 |
| 三 | 授权与生命周期 | 1 | 3 | 2 |
| 四 | UI 命名空间 | 2 | 2 | 3 |
| 五 | UI 事件总线 | 2 | 3 | 1 |
| 六 | UI 生命周期 | 1 | 1 | 0 |
| 七 | UI 契约与表单 | 1 | 2 | 2 |
| 八 | 运行时验证（含自纠） | 1 | 1 | 0 |
| 合计 | | 17 | 19 | 17 |

---

## 附录：证据索引
- 失败输出：vitest — tool-authority.test.ts:22 / smoke.test.ts:49，expected ''consumed'' got ''not-found''
- grant-store.get()：`return g && !g.consumed ? g : null;`（src/host/grant-store.ts）
- authority.verifyGrant()：`if (!grant) …''not-found''` / `if (grant.consumed) …''consumed''`（不可达）
- 测试契约：tests/desktop/tool-authority.test.ts（`expect(c2.reason).toBe(''consumed'')`）
- tool-contract 点号别名：mcp_save 与 ''mcp.save'' 并存
- 基线：33 文件 / 291 用例，2 失败
