# deepseek-studio 审计收敛结论（第 1-10 轮汇总）

- 日期：2026-10-11
- 说明：本文件是第 1-10 轮的**收敛结论**，不再新增轮次报告。
  十份轮次报告已完整覆盖各层，继续产出增量报告边际收益递减。

---

## 一、用户症状 → 四层归因 → 当前状态

原始症状：**大量按钮点不动 / MCP 设置存不上 / 新建项目与工作任务失效**

| 层 | 缺陷 | 定位轮次 | 当前状态 |
|----|------|----------|----------|
| 命名 | UI 用点号 id（mcp.save），宿主映射表只有下划线（mcp_save）→ 全部 unknown-tool | 第四轮 | ✅ 已修（contract 28 键覆盖 16 点号名） |
| 能力 | project.create / folder.pick / workspace.set / policy.set / mcp.remove / memory.delete 宿主无实现 | 第四轮 | ✅ 已修（hostTools 7→14 项） |
| 结构 | pointer-events 白名单（新组件根类名不在名单即整块不可点）；假 Shadow DOM | 第四轮 | ❌ **未修** |
| 生命周期 | 15 处 globalEvents.on 无退订；document click 无清理 → 重装后幽灵响应 | 第六轮 | ❌ **未修** |
| 事件 | 6 处 emit-only（含 ui:policy-changed 策略切换无效、ui:project-created 列表不刷新）+ 5 处 on-only（右侧栏四区永不更新） | 第五轮 | ⚠️ 未复核 |

---

## 二、全量缺陷台账（按状态）

### ✅ 已修复（代码层，行为期未全验）
- C1 契约续读映射（start/max_chars → offset/limit）
- C2 原始工具标签正则（[^<]* → [\\s\\S]*?）
- C3 PowerShell 运算符优先级
- C4 断线清 pending（failAllPending）
- H1 契约映射补全（file.list/skill.list）
- R2-H3 PoW 调试日志（删 2 处 console.log）
- R3-C1 kv/envelope 待决请求 30s 超时
- F4-C1 UI↔宿主命名（contract 28 键）
- F4-C2 8 个宿主能力补全（hostTools 14 项 / 注册 23 id）
- 端口冲突 8756→8760；MCP HTTP 传输支持；memory-store remove 方法

### ❌ 明确未修（需处理）
- **R3-H2 回归**：`grant-store.get()` 被改成 `g && !g.consumed ? g : null`，
  导致 verifyGrant 的 `if (grant.consumed) ''consumed''` 不可达 →
  `npx vitest run` 2 failed（tool-authority:22 / smoke:49，expected ''consumed'' got ''not-found''）。
  **精确补丁**：改回 `return g ?? null;`（第九轮已给，一行）
- **F4-H2**：pointer-events 类名白名单（studio-ui-core.ts:99/201/204）——「按钮按不了」的复发点
- **F4-H1**：createShadowContainer 注释称 Shadow DOM 实为 container（:100）
- **F6-C1**：监听器泄漏（15 处 on 无退订）
- **F5-C1**：事件幽灵订阅（若仍在）

### ⚠️ 待复核 / 待迭代
- C5 双自动循环（架构决策，暂保留）
- C6 无页回退假成功
- H2 工具提示注入面过宽
- H3/H4 续跑覆盖 prompt / pending 竞态
- R2-C1 存储并发丢更新（需 mutex）
- R2-C2 / R2-H1 chat-send 假成功 / 按钮点错
- R2-H2 SSE 魔法字符串
- R3-H1 loader 假成功；R3-H3 lifecycle 硬编码
- F4-H3 静默失败；F4-M1 死事件；F4-M2 硬编码
- F7-C1 PolicyMode 五处定义不一致；F7-H1 MCP 编辑即清空；F7-H2 设置面板静默失败

---

## 三、三条治理结论（比单个 bug 更重要）

### 1. 跨模块契约缺单一真相源（贯穿 4 类）
| 契约 | 断裂形式 | 轮次 |
|------|----------|------|
| 工具名 | 点号 vs 下划线 | 四 |
| 事件名 | emit / on / 退订 三缺一 | 五、六 |
| 枚举值 | PolicyMode 五处定义互不相同 | 七 |
| 表单字段 | open 不回填、失败无声 | 七 |
**统一治理**：每类契约建唯一导出 + CI 期配对断言。

### 2. 注册了资源却不回收
断线不清 pending（二）、监听器不退订（六）、存储并发丢更新（二）——同构。

### 3. 「已修复」的三层定义
代码改对 + 行为期测试通过 + 契约有断言保护。**缺任一层都只是「暂时生效」**。
- 第九轮：修复未跑测试 → 回归存活
- 第十轮：UI 契约无测试 → 修复无回归保护

---

## 四、下一步（按投入产出，全部可机械验证）

| 优先级 | 动作 | 验收判据 |
|--------|------|----------|
| 1 | `grant-store.get()` 改回 `return g ?? null;` | `npx vitest run` 从 2 failed 回全绿 |
| 2 | 新增 UI 契约测试：callHostTool(name) → mapUpstream → registry → hostTools 全链断言 | 新增测试通过；删任一契约键则测试失败 |
| 3 | pointer-events 改根容器默认 auto、去白名单 | 新建一个根类名不在白名单的组件，其按钮可点 |
| 4 | installStudioUI 的 destroy 统一退订 globalEvents | install→destroy→处理器数回基线 |
| 5 | 修复流程把 `npx vitest run` 列为强制关卡 | 任一测试失败即不得标「✅ 已修复」 |

---

## 五、方法论沉淀（本项目 10 轮的可复用检查项）

1. **接缝优先**：缺陷富集在跨模块边界（契约映射、断线清理、事件总线、枚举定义）。
2. **矩阵化扫描**：emit/on 双向差集、枚举定义点计数、创建/销毁对称性——一次扫全，别逐文件读。
3. **真跑不可省**：静态读码七轮未见回归，一次 `vitest run` 即抓到；且抓到的是**自己建议引入的**回归。
4. **建议与缺陷同等严格**：给修复方向前必须读调用链对方的函数体（第八轮教训）。
5. **测试即契约**：改实现前先读测试；两个测试锁 ''consumed'' 就是设计意图。
6. **识别收敛时机**：当一轮产出是「确认旧缺陷仍在」而非新缺陷时，停止开新轮，转合并台账。
