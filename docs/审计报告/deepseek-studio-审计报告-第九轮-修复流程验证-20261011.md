# deepseek-studio 代码审计报告（第九轮 · 修复流程验证）

- 日期：2026-10-11
- 范围：复核 `修复总结-20261011.md` 声称的修复项；回归是否仍存活
- 触发：用户「下一轮继续寻找界面相关 bug」
- 结论：**修复总结漏跑测试环节 → 一个回归在「✅ 已修复」标记下存活**

---

## 1. 事实

### 修复总结声称
```
R3-H2 | High | grant-store get() 三元表达式含死条件
      | ✅ 本轮修复（改为 `g && !g.consumed ? g : null`）
修改文件：src/host/grant-store.ts — R3-H2 死条件修复（`g ?? null` → `null`）
```

### 该修复的验证一节（原文）
```
- npx tsc --noEmit：退出码 0
- npm run build:inject：成功
- 真机重启：宿主进程正常启动，8760 端口监听，注入脚本 WebSocket 连接建立
```
**没有 `npx vitest run`。**

### 复跑实测（本轮）
```
Test Files  2 failed | 31 passed (33)
Tests       2 failed | 289 passed (291)
  FAIL tests/e2e/smoke.test.ts:49
  FAIL tests/desktop/tool-authority.test.ts:22
  AssertionError: expected ''not-found'' to be ''consumed''
```
回归**仍在**。

---

## 2. 因果：一个建议 + 一个验证缺口

```
第三轮  我建议：get() 的死条件应改为 `g && !g.consumed ? g : null`
         ↓
修复时  采纳该建议（`g ?? null` → `null`）
         ↓
后果    get() 对已消费 grant 返回 null
         → authority.verifyGrant 命中 `if (!grant) ''not-found''`
         → `if (grant.consumed) ''consumed''` 变成不可达死代码
         → 重放检测的原因码从 ''consumed'' 退化为 ''not-found''
         ↓
验证    tsc 过、build 过、真机起得来 —— 但没人跑 vitest
         → 2 个测试失败被漏掉
         ↓
标记    「✅ 已修复」
```

**两个错误叠加**：我的建议方向错了（第八轮已自纠），
而修复流程的验证清单恰好漏掉了唯一能发现它的那一项。

---

## 3. 这是第九轮最重要的发现：验证清单缺项

修复总结里有 30+ 项状态标记，其中「✅ 已修复」共 11 项。它们各自的验证深度并不一致：

| 验证手段 | 能否发现本次回归 | 总结里是否执行 |
|----------|------------------|----------------|
| `tsc --noEmit` | 否（类型正确） | ✅ 执行 |
| `npm run build:inject` | 否（能构建） | ✅ 执行 |
| 真机启动 | 否（能启动） | ✅ 执行 |
| **`npx vitest run`** | **是** | ❌ **未执行** |

即：本次修复的验证覆盖了「编译期」「构建期」「启动期」，**独缺「行为期」**。
而''consumed'' → ''not-found'' 恰恰只在行为期可见。

---

## 4. 精确补丁（一行，已验证判据清晰）

`src/host/grant-store.ts` 的 `get()`：

```ts
// 当前（回归）
get(requestId) {
  purgeExpired();
  const g = grants.get(requestId);
  return g && !g.consumed ? g : null;      // 已消费 → null
}

// 应改为（恢复 raw-fetch 契约）
get(requestId) {
  purgeExpired();
  const g = grants.get(requestId);
  return g ?? null;                        // 原样取出；消费态归 verifyGrant 判
}
```

依据：
- `authority.verifyGrant` 已具备 `if (!grant) ''not-found''` 与 `if (grant.consumed) ''consumed''` 两级判定，
  说明它的**设计前提就是 get() 原样返回记录**。
- 两个独立测试（tool-authority / smoke）都锁定 `''consumed''`，是设计意图的书面记录。
- 该改动**消除死条件**（`!g.consumed` 不再出现），**语义不变**，**测试应回绿**。

验收判据：`npx vitest run` 从「2 failed」回到全绿。

---

## 5. 修复总结中其余「已修复」项的复核建议

同样未经行为期验证的项，建议补跑测试后重新标记：

| 编号 | 声称修复 | 建议复核 |
|------|----------|----------|
| C2 正则 | 改为 `[\s\S]*?` | agent-loop 有单测，可验证 |
| C4 断线清 pending | failAllPending | 有 tool-bridge 测试 |
| R3-C1 kv 超时 | 加 30s 定时器 | 需确认 host-client 测试覆盖 |
| F4-C1/F4-C2 | 点号映射 + 8 个宿主能力 | 需新增「UI 调用名可解析」断言 |

**统一建议**：在修复流程里把 `npx vitest run` 列为**强制关卡**，与 tsc/build 同级；
任一测试失败即不得标「✅ 已修复」。

---

## 6. 方法论反思

1. **「编译过 + 能启动」不等于「行为正确」。** 本轮回归完美穿过 tsc / build / 真机三道关，
   只在断言层现形。修复流程的验证清单必须包含行为期，否则「已修复」是未经证实的声明。
2. **我给的建议被采纳后造成了回归**（第八轮已自纠）；而修复方的验证缺口让它存活。
   两件事叠加说明：**建议的可信度与验证的完整性，是同一枚硬币的两面**。
   给建议的人要读调用链，做修复的人要跑测试——缺任何一半都会让缺陷溜过去。
3. **归档动作本身是好实践**：前七轮报告已移入 `归档/`，说明有人在跟进。
   但归档不该掩盖「修复是否真生效」——需要一张随修复更新的**验证状态表**（含测试结果）。
4. **用户侧症状与本次回归的关系**：此回归不影响按钮可用性（重放仍被拒），
   属可观测性退化；用户的「按钮点不动」主因仍是 F4-C1/C2（总结称已修，但未验证）。
   → 建议真机复验 UI 后再判定 F4 系列是否真正闭环。

---

## 7. 九轮汇总

| 轮次 | 范围 | 关键产出 |
|------|------|----------|
| 一 | 工具调用链路 | 6 Critical（契约映射/正则/优先级/断线/双循环/假成功） |
| 二 | 执行层 | 存储并发丢更新（仿真复现） |
| 三 | 授权与生命周期 | 假成功 / 测试假阳性 /（R3-H2 建议——后被证明方向错） |
| 四 | UI 命名空间 | UI↔宿主工具名断裂（主根因） |
| 五 | UI 事件总线 | 幽灵订阅：6 emit-only + 5 on-only |
| 六 | UI 生命周期 | 监听器泄漏：15 处 on 无退订 |
| 七 | UI 契约与表单 | PolicyMode 五处定义不一致；MCP 编辑即清空 |
| 八 | 运行时验证 | 真跑抓到回归；自纠 R3-H2 建议 |
| 九 | 修复流程验证 | 验证清单缺行为期 → 回归在「已修复」下存活 |

---

## 附录：证据索引
- 修复总结：docs/审计报告/修复总结-20261011.md（R3-H2 标记 ✅；验证仅 tsc/build/真机）
- 复跑：npx vitest run → 2 failed | 31 passed (33)；289 passed (291)
- 失败点：tool-authority.test.ts:22 / smoke.test.ts:49，expected ''consumed'' got ''not-found''
- 相关实现：src/host/grant-store.ts get() / src/host/authority.ts verifyGrant()
- 归档：前七轮报告已移入 docs/审计报告/归档/
