# 后续路线图 · M3 验收 → 删旧 → 产品化

> 2026-10-17 12:50 | PM 规划
> 当前状态：三席非阻塞工作全完，等真机验收

---

## 阶段总览

```
[当前] M3 真机验收（席5）
   ↓
[阶段2] 真机 bug 修复（三席按文件域分）
   ↓
[阶段3] M3 删纠偏收尾（三席配合删旧代码）
   ↓
[阶段4] 产品化（真实工具桥接 + UI 集成 + 多模型）
```

---

## 阶段 1：M3 真机验收（当前，席5）

| 阶段 | 负责人 | 内容 |
|---|---|---|
| V1 环境确认 | 席5 | Electron 启动 + 登录 + health check |
| V2 nudgeRate 取数 | 席5 | 50 轮真机跑，出 nudgeRate 数字 |
| V3 流式 delta 验证 | 席5 | 逐 token 接收验证 |
| V4 工具回合验证 | 席5 | 真实工具调用无 nudge 自驱 |
| V5 验收报告 | 席5 | 出 M3 验收结论 |

**三席状态**：待命。等 V5 出报告后按 bug 分域。

---

## 阶段 2：真机 bug 修复（V5 报告出来后开始）

按文件域分，不跨域：

| Bug 类型 | 分给 | 文件域 |
|---|---|---|
| kernel 层 bug（TaskLoop 行为不对、历史串、abort 不生效） | 席1 | `src/host/kernel/**` |
| engine 层 bug（WebEngine 连不上、completion 判错、断流不恢复） | 席2 | `src/host/engine/**` |
| harness 层 bug（gate 红、eval 失败、脚本跑不通） | 席3 | `tools/**` |
| 类型错/测试错 | 席4 | 任何测试文件 |

**PM 工作**：把 V5 报告里的 bug 按域分好，写进各席路线图，他们自己修。

---

## 阶段 3：M3 删纠偏收尾（bug 修完后）

这是真正的"删"阶段。删的是旧代码，不是新功能。

| 删除项 | 文件 | 谁删 |
|---|---|---|
| agent-loop.ts 里的 nudge / 续逼逻辑 | `src/host/agent-loop.ts` | 席2（engine 域）+ PM 协调 |
| interceptor 里的纠偏注入 | `src/inject/**` | 席2 |
| continuation-prompt 里的续逼提示词 | `src/shared/continuation-prompt.ts` | 席1（kernel 域）改引用 |
| MAX_NUDGES / RAW_TOOL_TAG_RE / stripRawToolTags | 全仓 grep | 席3 审计清零 |
| build:inject 流程 | `package.json` | 席3 |

**验收**：席3 S12 的 M3 符号清零审计全仓 0 命中。

---

## 阶段 4：产品化（删旧完成后）

| 方向 | 谁做 | 内容 |
|---|---|---|
| 真实工具执行 | 席1 | TaskLoop 接真实 tool-registry，危险工具走 consent |
| ApiEngine 多模型 | 席2 | DeepSeek/GPT/Claude/Ollama 一行切 |
| UI 集成 | 新席位 | 把 TaskLoop 接到现有 bot UI，看到流式输出 |
| 真机流式 delta | 席2 | WebEngine MutationObserver + postMessage |
| B 线 v0.32 人设热插拔 | 新席位 | 现有 persona 系统和新 kernel 对接 |

---

## 现在该做什么

1. **你启动 Electron + 登录 DeepSeek**
2. 把 `seat5-acceptance.md` 路线图发给席5
3. 三席待命，等 V5 报告
4. 席4 继续守门（typecheck/vitest 跑绿）
