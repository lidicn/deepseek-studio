# M8 安全核心 · MiMo 需求稿

> 项目：deepseek-studio（Tauri 桌面 agent，拦 DeepSeek 网页当 LLM 后端）
> 目标：把现有 consent 闸门从"一刀切 ask"升级为三级审批 + 可回滚 + Plan/Act 分离
> 要求：纯函数包 + 宿主接线，不碰网页侧 DOM

---

## 一、背景与现状

当前 consent 闸门是"要么 auto 放行、要么 ask 用户点同意"，没有：
- 按工具风险分级（shell.exec 每次都问，file.read 也每次都问）
- 白名单（同一工具同一参数不该每次都问）
- 操作回滚（edit 写错了只能手动改回来）
- 计划与执行分离（模型边想边做，做错了才发现）

---

## 二、要新增的三个模块

### E1 · 审批三级（safe / ask / deny）

**目标**：按工具 + 路径 + 操作粒度，自动决定要不要问用户。

**输入**：
- toolId（如 `shell.exec` / `file.edit`）
- params（如 `{ path: "src/a.ts", edits: [...] }`）
- 当前 policyMode（auto / ask / full）

**输出**：
- `safe` → 自动放行，不打扰用户
- `ask` → 弹同意框，等用户点
- `deny` → 直接拒绝，不执行

**规则要求**：
- 白名单存储在 `~/.config/deepseek-studio/consent-whitelist.json`
- 白名单条目：`{ toolId, pathPattern, action, ttl? }`
- 匹配方式：glob 匹配路径，精确匹配 action
- safe 档：file.read / search_files / web.fetch（只读类）
- ask 档：file.edit / file.write / shell.exec（写类 / 执行类）
- deny 档：`rm -rf` / `format` / 系统敏感路径（`C:\Windows\System32` 等）
- policyMode=full 时全部 ask；policyMode=auto 时按上表；policyMode=safe 时只读类 safe、写类 ask

**验收**：
- file.read 自动放行（safe）
- file.edit 弹同意框（ask）
- `shell.exec` 跑 `rm -rf /` 直接拒绝（deny）
- 白名单加过一次后，同一 toolId + pathPattern 不再问

---

### E2 · git shadow 回滚

**目标**：每次 file.edit / file.write 前自动快照，出错了能一键回滚。

**输入**：
- 操作前文件内容（或路径）
- 操作类型（edit / write）

**输出**：
- 快照 ID（可回滚句柄）
- 回滚函数：传快照 ID，恢复文件

**要求**：
- 快照存在 `<workspace>/.shadow/` 目录
- 快照命名：`<file-path>.<timestamp>.shadow`
- 每次写操作前自动快照，不需要用户触发
- 保留最近 10 次快照，老的自动删
- 提供 `rollback(shadowId)` 工具，模型可以主动调

**验收**：
- edit 一个文件后，`.shadow/` 下出现快照
- 调 `rollback` 后文件恢复到 edit 前
- 连续 11 次写操作后，最早的快照被删

---

### E3 · Plan/Act 分离

**目标**：模型先输出计划，用户确认后再执行，而不是边想边做。

**输入**：
- 用户任务描述

**输出**：
- Plan 阶段：模型输出 `{ steps: [{ toolId, params, reason }] }`
- Act 阶段：按 steps 顺序执行，每步过 consent 闸门

**要求**：
- Plan 阶段不执行任何工具，只输出计划
- 用户确认后进入 Act 阶段
- Act 阶段按 steps 顺序执行，每步失败就停，不继续
- 计划格式：JSON，字段 `{ steps: [{ tool: string, params: object, reason: string }] }`
- 提供 `plan_act` 工具：输入 `{ task: string }`，先调模型出计划，再执行

**验收**：
- 发一个多步任务（如"改 a.ts 然后跑测试"），先看到计划，确认后才执行
- 计划里第二步失败，第三步不执行

---

## 三、硬约束

1. **错误码复用 CONTRACTS §6.1**：missing-argument / invalid-argument / workspace-unconfigured / outside-workspace / not-found / io-error / limit-exceeded
2. **纯函数包不 import src/host/**（除了 workspace context）
3. **工作区边界唯一入口**：workspace.resolveWithin，fail-closed
4. **不碰网页侧 DOM**，只改宿主侧
5. **Windows PowerShell 唯一 shell**

---

## 四、接口面（需要对齐的现有契约）

- `src/host/policy.ts` — 现有 policyMode / FILE_TOOLS / PROCESS_TOOLS
- `src/host/desktop-host.ts` — createDesktopHost + consent 闸门位置
- `src/host/workspace.ts` — workspace context + resolveWithin
- `src/capabilities/edit-engine.ts` — file.edit 实现
- `src/shared/tool-error-envelope.ts` — 错误信封

---

## 五、验收清单

| # | 验收点 | 命令 / 操作 | 预期 |
|---|---|---|---|
| 1 | tsc 0 错 | `npx tsc --noEmit` | EXIT=0 |
| 2 | 单测全绿 | `npx vitest run` | 0 failed |
| 3 | file.read 自动放行 | 调 file.read | 不弹同意框 |
| 4 | file.edit 弹同意框 | 调 file.edit | 弹框 |
| 5 | rm -rf 被拒绝 | shell.exec 跑 rm -rf | 直接 deny |
| 6 | 白记忆 | 同一 toolId + path 第二次不问 | safe |
| 7 | edit 前自动快照 | 调 file.edit 后看 .shadow/ | 有快照 |
| 8 | rollback 生效 | 调 rollback | 文件恢复 |
| 9 | Plan/Act 分步 | 发多步任务 | 先出计划再执行 |

---

## 六、交付物

1. `src/host/consent-router.ts` — E1 审批三级纯函数
2. `src/host/shadow-store.ts` — E2 git shadow 回滚
3. `src/capabilities/plan-act.ts` — E3 Plan/Act 工具
4. 单测 各模块 ≥ 8 例
5. 接线进 desktop-host

---

*需求稿结束。*
