# DeepSeek Studio UI 执行接力方案

> 版本：v1.0  
> 日期：2026-10-19  
> 适用：豆包长任务 → Codex / Claude Code 经 Magpie 接力  
> 前置：`Studio-UI-总体设计-v1.md` 与两份评审报告

---

## 0. 结论

### 0.1 推荐接力链

```text
豆包：先跑封闭的 P1 基础层
  ↓ 到达停点或额度耗尽
Codex 壳 + Magpie 强模型：接管 P2–P4
  ↓ 完成实现后
Claude Code 壳 + Magpie 强模型：独立评审与补漏
  ↓
Codex 壳 + Magpie 修复模型：收尾、跑门禁、提交
```

### 0.2 一句话选型

- **主接力壳：Codex**。它更适合仓库读写、终端、测试、连续修复。
- **评审壳：Claude Code**。它适合大上下文评审、边界条件、交互与可访问性复核。
- **主接力模型：`trae-cn/DeepSeek-V4-Pro-max`**。当前 Magpie 中最适合复杂代码实现与长上下文改造的强模型之一。
- **备选实现模型：`trae-cn/Doubao-Seed-2.1-Pro-max`**。同源豆包，风格连续，适合 UI 实现与中文交互。
- **规划/评审模型：`trae-cn/Kimi-K3-max` 或 `trae-cn/GLM-5.3-max`**。用于方案审查、边界条件、代码 review。
- **不要默认使用 `group/free-code` 做接力**。它当前路由到 `workbuddy-ai/deepseek-v4.1-flash`，是低成本免费组，不是强实现模型。

### 0.3 积分优先级

当前可优先消耗：

| 账号 | 可用额度 | 到期/重置 | 建议用途 |
|---|---:|---|---|
| Trae CN `用户41798167067` | 2350 credits | 2026-10-24 21:28 北京时间 | **优先消耗**，用于主实现与评审 |
| Trae CN `系统崩溃大师` | 2200 credits | 2026-10-31 23:59 北京时间 | 第二顺位，留给收尾与返工 |
| Trae Global `lidicn` | 1 美元额度，已用 0.08 | 2026-10-31 | 不作为主通道 |
| WorkBuddy AI `lidicn` | 约 380 中已用 1.71 | 未明确 | 只做轻量任务 |
| WorkBuddy `momo` | 约 4568 中已用 71.47 | 未明确 | 不作为长任务主力 |
| AutoClaw 国内 | 200 积分 | 每日签到 | 只做小任务 |
| MiniMax Code | 400 credits | 未明确 | 只做小任务 |
| 商汤小浣熊 | 6 / 6300 | 2026-10-25 | 额度很少，不排主任务 |

优先消耗 **10 月 24 日到期** 的 Trae CN 账号，避免额度浪费。

---

## 1. 为什么不是“让豆包一次跑完整重构”

### 1.1 豆包适合什么

- 范围明确、文件边界清楚的任务。
- 设计 token、基础组件、静态页面、CSS 收敛。
- 有明确验收命令的批量修改。
- 中文文案、注释、错误提示中文化。

### 1.2 豆包不适合什么

- 一次性跨十几个文件的重构。
- 需要同时改构建链、运行时、宿主适配和安全边界的任务。
- 没有中间验收点的长任务。
- 依赖“额度耗尽后仍会继续跑”的不确定行为。

### 1.3 正确用法

不要给豆包“完整前端重构”这种大目标。给它 **3–5 个封闭 checkpoint**，每个 checkpoint 都必须：

1. 有明确文件白名单。
2. 有可运行的验收命令。
3. 有可回滚点。
4. 完成后停下，交强模型 review。

---

## 2. 停点设计

### 2.1 豆包停点

建议豆包只做 **P1 基础层**，到以下任一条件停止：

- `npm run typecheck` 通过。
- `npx vitest run` 通过，或失败项有明确记录。
- 已完成 `design-tokens`、`ui-contract`、`app-shell` 骨架。
- 额度剩余低于 10%。
- 出现需要修改构建链、宿主适配或安全边界的问题。

**不要在以下状态交接**：

- 有未保存的半成品文件。
- `typecheck` 大面积报错。
- 组件契约还没定。
- 同一文件被多个执行者同时修改。

### 2.2 交接产物

豆包停止前必须留下：

```text
docs/前端开发计划/接力状态.md
```

内容至少包括：

- 已完成项。
- 未完成项。
- 修改过的文件列表。
- 当前 `typecheck` / `vitest` 结果。
- 已知风险。
- 下一步建议。

同时执行：

```powershell
git status --short
git diff --stat
npm run typecheck
npx vitest run
```

把结果写进接力状态，不要只留在聊天记录里。

---

## 3. Codex 接力方案

### 3.1 为什么选 Codex

- 原生支持仓库读写、终端命令、测试、diff、连续修复。
- 适合把“设计稿 → 代码 → 测试 → 修复”闭环跑完。
- 当前本机已经配置 `model_provider = "magpie"`，可直接走 Magpie。
- 对 Windows 路径、PowerShell、Tauri 项目更稳。

### 3.2 推荐模型

主实现：

```text
trae-cn/DeepSeek-V4-Pro-max
```

备选实现：

```text
trae-cn/Doubao-Seed-2.1-Pro-max
```

复杂评审：

```text
trae-cn/Kimi-K3-max
```

前端交互与中文文案：

```text
trae-cn/Doubao-Seed-2.1-Pro-max
```

### 3.3 启动命令

在 `E:\NAS\deepseek-studio` 下：

```powershell
codex -C E:\NAS\deepseek-studio `
  -c model_provider="magpie" `
  -m trae-cn/DeepSeek-V4-Pro-max
```

如果只想先做评审，不直接改代码：

```powershell
codex -C E:\NAS\deepseek-studio `
  -c model_provider="magpie" `
  -m trae-cn/Kimi-K3-max
```

### 3.4 Codex 的职责边界

Codex 接手后只做：

1. 读取 `接力状态.md`。
2. 先跑 `git status`、`typecheck`、`vitest`。
3. 修复豆包留下的红灯。
4. 完成 P2 宿主适配层。
5. 完成 P3 Focus 模式。
6. 完成 P4 Workbench 骨架。
7. 每完成一个 checkpoint，更新接力状态。

不要在第一轮就做：

- 全量 Monaco / xterm 接入。
- 完整多 Agent 编排。
- 白名单管理 UI。
- 远程控制。

---

## 4. Claude Code 接力方案

### 4.1 为什么还要 Claude Code

Claude Code 不适合作为第一实现壳，但适合：

- 独立 review。
- 发现边界条件和遗漏测试。
- 复核 UI 交互、可访问性、错误态。
- 审查设计稿与代码的一致性。

### 4.2 当前状态

本机 Claude Code 当前是 OAuth 登录态。若要让它走 Magpie，需要显式配置 Anthropic 兼容入口，不能假定它自动使用 Magpie。

### 4.3 推荐用法

先用 Codex 完成实现，再用 Claude Code 做只读评审：

```powershell
claude -p "只读评审 E:\NAS\deepseek-studio 当前改动。重点检查：宿主适配、权限词表、Plan/Act、diff 审批、Markdown sanitizer、生命周期泄漏。输出按严重级别排序，不要改文件。" --add-dir E:\NAS\deepseek-studio
```

如果 Claude Code 尚未接到 Magpie，不要为了接力临时改全局认证配置。先让 Codex 完成主路径，Claude Code 只在确认 provider 可用后做评审。

---

## 5. 模型选择规则

### 5.1 任务 → 模型

| 任务 | 首选 | 备选 |
|---|---|---|
| 架构与接口设计 | `trae-cn/Kimi-K3-max` | `trae-cn/GLM-5.3-max` |
| 跨文件重构 | `trae-cn/DeepSeek-V4-Pro-max` | `trae-cn/Doubao-Seed-2.1-Pro-max` |
| UI 组件与交互 | `trae-cn/Doubao-Seed-2.1-Pro-max` | `trae-cn/GLM-5.3-max` |
| CSS / 设计 token | `trae-cn/Doubao-Seed-2.1-Pro-max` | `trae-cn/DeepSeek-V4-Pro-max` |
| 测试修复 | `trae-cn/DeepSeek-V4-Pro-max` | `trae-cn/Kimi-K3-max` |
| 独立 review | `trae-cn/Kimi-K3-max` | `trae-cn/GLM-5.3-max` |
| 长上下文分析 | `trae-cn/DeepSeek-V4-Pro-max` | `trae-cn/Kimi-K3-max` |
| 轻量文案 / 重复修改 | `workbuddy-ai/deepseek-v4.1-flash` | `group/free-code` |

### 5.2 是否需要强模型

需要，但只在高杠杆节点用：

- 架构与契约：需要强模型。
- 跨文件重构：需要强模型。
- 独立 review：需要强模型。
- CSS 微调、文案、重复页面：不需要。

不要用强模型做：

- 批量重命名。
- 简单样式替换。
- 重复性文案修改。
- 已经明确到行级的机械改动。

---

## 6. 执行顺序

### 阶段 A：豆包

目标：完成 P1 基础层。

范围：

- `design-tokens`
- `ui-contract`
- `app-shell` 骨架
- 基础组件
- 真正的 Shadow DOM 根容器
- 统一 CSS 注入
- 统一 z-index token

验收：

```powershell
npm run typecheck
npx vitest run
```

### 阶段 B：Codex

目标：完成 P2–P4。

范围：

- `host-layout-adapter`
- Focus 模式
- Workbench 三栏骨架
- composer 状态 chip
- 状态条

验收：

- 登录页不遮挡。
- Focus 模式原生消息区可点可滚。
- Workbench 在 1280 / 1440 不溢出。
- `typecheck` 与 `vitest` 全绿。

### 阶段 C：Claude Code

目标：只读评审。

重点：

- 权限词表是否唯一。
- Approval 三按钮映射是否正确。
- Plan/Act 是否有真实调用方。
- diff 验收是否超出后端能力。
- Markdown 是否 sanitize。
- destroy 是否释放订阅与 DOM。

### 阶段 D：Codex 收尾

目标：修复评审问题并跑门禁。

验收：

```powershell
npm run typecheck
npx vitest run
npm run gate
```

---

## 7. 开工前必须补齐的 6 个阻断项

依据第二份评审报告：

1. 技术栈与打包链路：明确 React 引入后的 IIFE 体积上限；Monaco / xterm 是否本期保留。
2. 权限词表唯一化：固定 `workspace | auto | full`，同步三处 UI 口径。
3. Approval Card 三按钮映射：`allow-once / deny / allow-session`。
4. Plan/Act：明确它是新建控件，并给 `evaluatePlanGate` 接调用方。
5. diff 验收：本期改为整批接受/拒绝 + 按行展示，不做 hunk 级局部应用。
6. 验收标准：补 UI 层覆盖率、sanitizer、`npm run gate` 的地位。

这 6 项不补，不要让豆包或 Codex 直接大规模改 UI。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 豆包额度耗尽后任务中断 | 只做封闭 checkpoint，每步留接力状态 |
| 多执行者同时改同一文件 | 一次只允许一个主执行者 |
| Magpie 路由到弱模型 | 显式 `-m` 指定模型，不用默认 `group/free-code` |
| 强模型额度浪费在机械改动 | 强模型只做架构、重构、评审 |
| Claude Code 未接 Magpie | 先确认 provider，再用于评审；不临时改全局认证 |
| 注入包体积失控 | 首屏预算 ≤300KB gzip，重型依赖懒加载 |
| UI 重犯历史问题 | 开工前补齐 6 个阻断项，P0 门禁全绿 |

---

## 9. 最终建议

1. **不要让豆包一次跑完整重构。**
2. **让豆包只做 P1 基础层，做完就停。**
3. **Codex 作为主接力壳，显式指定 `trae-cn/DeepSeek-V4-Pro-max`。**
4. **Claude Code 只做独立评审，不抢主实现。**
5. **优先消耗 10 月 24 日到期的 Trae CN 额度。**
6. **强模型只用在架构、跨文件重构、评审和难 bug。**
7. **每个 checkpoint 都必须有 typecheck、vitest、接力状态。**

---

*文档结束。*
