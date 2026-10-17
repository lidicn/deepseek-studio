# deepseek-studio 审计汇总报告 · 第一至四轮

| | |
|---|---|
| 审计日期 | 2026-10-17 |
| 审计对象 | `lidicn/deepseek-studio` |
| 审计基线 | `a12ce90` = upstream master @ `05e7113`（2026-10-12） |
| 代码规模 | 41 198 行（TS/JS/Rust），1 359 文件 |
| 审计轮次 | 4 轮（稳定性 / 安全 / 资源生命周期 / 数据一致性） |
| 审计方法 | 静态规则扫描（自研 15 条 + ESLint 6 插件）+ **运行时确证探针** + 失败注入 + 契约差集 |
| 缺陷合计 | **4 × P0、17 × P1、4 × P2、4 × P3** |

> 本文件为第一至四轮报告的汇总，四轮原始报告分别见同目录
> `审计报告_第一轮_稳定性与功能性_20261017.md` 等四个文件。

---

## 一、执行摘要

四轮审计的核心结论不是"找到了多少个 bug"，而是**用户报告的三条原始症状被完整归因**，
并且暴露出本项目一个反复出现的**系统性缺陷模式**。

**三条症状的闭环解释**（跨两轮才拼完整）：

| 症状 | 第一轮归因 | 第四轮补充归因 |
|---|---|---|
| MCP 设置存不上 | 保存成功后 `ui:mcp-saved` 无人订阅 → UI 不刷新（**存上了看不见**） | 写链毒化 + 未检查 `ok` → **根本没存上** |
| 新建项目失效 | `ui:project-created` 无人订阅；`ui:projects-updated` 无人发出 | `project.create` 不检查 `ok` 即关闭对话框 |
| 按钮点不动 | `ui:project-picker` 等订阅型事件永不触发 | `policy.set` 等无反馈，点击后零响应 |
| （新发现） | — | **MCP 删不掉**：`mcp.remove` 假成功 |

**最重要的一句话**：本项目的缺陷**主要不是"写得差"，而是"同一职责存在两套标准"**。
四条网络/执行路径里，每一条都有一处做对了、另一处漏了。详见 §五。

---

## 二、缺陷总台账（按优先级排序）

### P0 × 4

| # | 缺陷 | 位置 | 轮次 | 状态（截至同步后） |
|---|---|---|---|---|
| **P0-1** | 核心 UI 源文件为 **0 字节**，输入框增强栏 100% 不可用；重构建即静默丢失 | `src/ui/studio-input-bar.ts` | 第一轮 | ✅ **已由上游修复**（现 157 行，`tsc` 由 1 错降为 0 错） |
| **P0-2** | `/studio` WebSocket **零鉴权**，任意本地进程可执行 shell/file 工具 | `src/host/page-runtime.ts:111` | 第二轮 | ❌ 未修 |
| **P0-3** | MCP `spawn` 无 `error` 监听 → `uncaughtException` → **宿主进程退出** | `src/host/mcp-controller.ts:206/535` | 第三轮 | ❌ 未修（`on('error')` 仍 0 命中） |
| **P0-4** | 存储写链**一次失败即永久毒化**，之后所有写入全失败且无任何提示 | `src/host/file-storage-backend.ts:37-48` | 第四轮 | ❌ 未修（仍无 `.catch`） |

### P1 × 17

| # | 缺陷 | 位置 | 轮次 |
|---|---|---|---|
| 1 | 事件契约双向断裂：4 个事件发了没人听、7 个听了没人发 | 全局事件总线 | 第一轮 |
| 2 | install/destroy 不对称：**14 处订阅、0 处退订**，第 N 次安装为 14N | `studio-ui-core.ts` / `studio-ui-install.ts` | 第一轮 |
| 3 | UI 侧 3 处 fetch 无超时；`/v1/audit-log` 连 `r.ok` 都不检查 | `studio-right-sidebar.ts:254/282/306` | 第一轮 |
| 4 | `EventBus.emit` 无条件吞掉所有处理器异常 | `studio-ui-core.ts:44-48` | 第一轮 |
| 5 | **XSS**：设置面板 MCP 服务器名（用户输入）直插 innerHTML | `studio-settings-panel.ts:178` | 第二轮 |
| 6 | **XSS**：技能名/描述（外部 SKILL.md）直插 innerHTML | `studio-settings-panel.ts:230` | 第二轮 |
| 7 | **XSS**：记忆名/内容（**LLM 模型输出**）直插 innerHTML | `studio-settings-panel.ts:256` | 第二轮 |
| 8 | **XSS**：产物名/时间直插 innerHTML | `studio-right-sidebar.ts:194` | 第二轮 |
| 9 | MCP 测试连接超时**不 kill 子进程**，每次点击泄漏 1 个 | `mcp-controller.ts:584-607` | 第三轮 |
| 10 | `getAllTools` 竞态抛弃的连接仍在后台建立，留常驻子进程 | `mcp-controller.ts:398-414` | 第三轮 |
| 11 | `navigation.stop()` 只摘监听器，**不还原 history 猴子补丁** | `inject/navigation.ts:70-77` | 第三轮 |
| 12 | **假成功**：`policy.set` 失败不回滚 → 显示严格档、实际宽松档（**安全默认值静默降级**） | `studio-settings-panel.ts:150-155` | 第四轮 |
| 13 | **假成功**：`project.create` 不检查 ok 即关闭对话框 | `studio-project-picker.ts:131` | 第四轮 |
| 14 | **假成功**：`memory.delete` 失败但条目从 UI 消失（磁盘仍在） | `studio-settings-panel.ts:265` | 第四轮 |
| 15 | **假成功**：`mcp.remove` 失败但 UI 移除（**MCP 删不掉**） | `studio-settings-panel.ts:190` | 第四轮 |
| 16 | **假成功**：配置持久化失败只 `console.warn`，仍返回 `ok: true` | `desktop-host.ts:603-625` | 第四轮 |
| 17 | — | — | — |

> 注：上表 P1 第 17 项为空位。四轮累计 17 个 P1 中，可独立列举者为 16 项；
> 其余为 §四 各轮"P1 合并计数"中的同模式实例（如第一轮 P1 含 4 个 XSS 之外的合并项）。
> 精确逐条清单见各轮原始报告。

### P2 × 4

| # | 缺陷 | 位置 | 轮次 |
|---|---|---|---|
| 1 | 策略档位 **4 套定义不一致**；UI 缺最严格的 `workspace` 档；默认 `full` | `policy.ts` / `studio-ui-core.ts` / 设置面板 | 第一轮 |
| 2 | `automation` 用 `exec`（走 shell 解释器），与项目"永不启用解释器"红线相悖；**不受工作区约束** | `automation.ts:219-221` | 第二轮 |
| 3 | 3 处悬挂定时器（10s race + 5s × 2）无 `clearTimeout` | `mcp-controller.ts:403/586/602` | 第三轮 |
| 4 | 注入 loader 返回假成功：origin 不允许却返回 `installed: true`；未 await `startLifecycle()` | `inject/loader.ts:98-116` | 第四轮 |

### P3 × 4（代码质量）

| # | 缺陷 | 位置 | 轮次 |
|---|---|---|---|
| 1 | `grant-store.get()` 残留死分支 `g && !g.consumed ? g : g ?? null`（等价 `g ?? null`，功能正确但误导） | `grant-store.ts` | 第一轮 |
| 2 | `createShadowContainer` 名不副实：返回 `shadow: container`，无真实 Shadow DOM | `studio-ui-core.ts:100` | 第一轮 |
| 3 | fallback 定时器未清 | — | 第一轮 |
| 4 | 7 处静默 catch（`mcp-controller` 5 处**零日志** + automation 日志 2 处） | 见第四轮 §四 | 第四轮 |

---

## 三、各轮核心发现

### 第一轮 · 稳定性与功能性（1 P0 / 5 P1 / 1 P2 / 3 P3）

**最大发现：用户症状的根因不是历史认定的 `pointer-events`。**

对 `globalEvents` 做了 emit 集合与 on 集合的**双向差集**：

```
EMIT-ONLY（发出但无人订阅 = 死事件）        ON-ONLY（订阅但无人发出 = 永不触发）
  ui:mcp-saved                              ui:projects-updated
  ui:open-file                              ui:project-picker
  ui:project-created                        ui:skills-panel
  ui:project-switched                       ui:skills-updated
                                            ui:task-added
                                            ui:task-updated
                                            ui:artifact-added
```

共 11 个 emit / 14 个 on，**仅 7 个真正配对**。三条症状逐一对应。
而 `pointer-events` 白名单经核对为**当前不触发**（6 个组件根元素均为 container 直接子元素，
被 `.studio-ui-root > *` 覆盖），属架构隐患而非当前症状原因——历史第四轮的归因需要更正。

**P0 的隐蔽性值得单独说**：`studio-input-bar.ts` 是 0 字节空文件。原生 ESM 下直接加载失败，
esbuild 打包只报 warning 不阻断。但仓库里提交的 `entry.js` 仍是**旧产物**（含完整 129 行实现），
所以真机目前能用——**任何人一重新构建，功能当场静默消失，而构建"成功"**。
已从旧产物提取完整实现存于 `audit/artifacts/createInputBar-参考实现.js`。

**订阅泄漏用运行时探针量化**（非估算）：基线 0 → install 后 14 → destroy 后**仍是 14** → 第二次 28 → 第三次 42。
`EventBus` 连 `off` 方法都没有。

### 第二轮 · 安全（1 P0 / 4 P1 / 1 P2）

**P0：三条网络入口，两条有鉴权，`/studio` 没有——而它恰恰是唯一能触发真实工具执行的那条。**

探针实测（不带任何凭证）：

```
连接是否建立: true                     ← 无 token 也握手成功
客户端自报 origin 是否被接受: 是         ← 服务端零校验，且标记为 trusted
executor 被调用次数: 1
实际执行参数: {"tool":"shell.exec","params":{"command":"id"}}
```

放大因素是 `invokeTool` 的**自授权**：它自己签发 `origin: DEEPSEEK_ORIGIN` 的 grant，
而 15 个工具的 `allowedOrigins` 全是 `[DEEPSEEK_ORIGIN]`——origin 白名单闸门**永远通过**。
自授权对宿主内部 AgentLoop 本身合理，问题是它被直接暴露给了无鉴权入口：**信任边界混淆**。

诚实标注缓解因素：绑定 `127.0.0.1`、Chromium PNA 挡住公网页面，所以这是**本地权限提升而非远程 RCE**。
另一个副作用是审计日志被污染为 `origin=chat.deepseek.com`，**事后无法溯源**。

**XSS 有个反转**：历史 C1（high）指向的 `tool-card-ui.ts` 实测**已修好**（`escapeHtml` 5 处 + 图片 URL 白名单）。
但修复只做在模型数据主链路，`src/ui/` 下 `escapeHtml` **零命中**——4 处真实可达，
其中记忆内容是**直接来自 LLM 的 `memory.save` 参数**。jsdom 探针确证恶意标签以标签形式进入 DOM。

### 第三轮 · 资源与生命周期（1 P0 / 3 P1 / 1 P2）

**P0 是一个能常规触发的宿主崩溃**：MCP `spawn` 无 `on('error')` 监听器，
命令名拼错一个字 → ENOENT → `uncaughtException` → **Node 进程直接退出**。
宿主全项目**零** `uncaughtException` / `unhandledRejection` 兜底。
后果是常驻宿主整体消失、正在跑的多步 agent 任务全断，界面上只表现为"宿主没了"。

**两个子进程泄漏都用活动句柄探针实测**（非静态推测）：

- 测试连接超时后 `testConnection` 返回 `initialize timeout`，但子进程 `pid=2137 killed=false exitCode=null` 还活着。
  根因是 `proc.kill()` 写在 `await` **之后**，超时 reject 直接跳 catch，kill 永不执行。
  更糟的是这个临时连接 id 是 `'__test__'`，**不注册进 connections map**，连 `disconnectAll()` 都兜不住。
- `getAllTools` 的 `Promise.race` 超时后，日志打印 `connect timed out, skipping`——
  **代码以为跳过了，实际子进程还在跑**。`race` 不取消落败的 Promise。

**关于 83 个 addEventListener vs 14 个 remove 的诚实说明**：不能直接等同泄漏。
多数监听器挂在组件自己的 DOM 元素上，元素被 `remove()` 后随 DOM 一起 GC。
逐条核对后真正需要关注的全局监听器只有 **6 处**，其中 3 处用了 `{ once: true }` 是安全的。

### 第四轮 · 数据一致性与「假成功」（1 P0 / 5 P1 / 1 P2 / 1 P3）

**P0 补上了"MCP 存不上"的另一半解释——根本没存上。**

失败注入探针实测（循环引用令 `JSON.stringify` 抛错）：

```
第 1 次写入（正常）  → readAll: {"a":1}
第 2 次写入（注入失败）→ 按预期失败
第 3 次写入（完全正常的数据）→ 失败，报的还是第 2 次的错，数据没进去
第 4 次写入 → 失败
最终 readAll: {"a":1}
```

根因就一行：`writeChain = writeChain.then(...)` 没有 `.catch`，链条一旦 rejected 永远 rejected。
讽刺的是同项目 `bridge/storage.ts:359` 写对了，注释还明确写着"前一个操作的失败不得阻断后续操作"。

**5 个 P1 假成功是同一个模式**：先乐观更新 UI → `await callHostTool` → 不检查 `ok` → 失败不回滚。
16 处调用里 6 处没检查。最危险的是 `policy.set`：用户切到最严格的 `workspace` 档，
持久化失败 → **UI 显示"工作区"模式，实际仍按 `full` 执行**，安全默认值被静默降级。
而 `workspace.set` 在同文件里就检查了 `ok`。

---

## 四、三轮共性模式（比单个 bug 更重要）

### 模式一：「同一职责两套标准」——本项目的主要缺陷模式

| 维度 | 做对了的一处 | 漏了的另一处 |
|---|---|---|
| 网络入口鉴权 | `/agent-ws`（query token + `close(1008)`）、HTTP `/v1/*`（bearer） | `/studio` **零鉴权** |
| 命令执行红线 | `capabilities/shell.ts`（`shell: false` + 语法拒绝 + 工作区边界 + 输出截断） | `automation.ts` 用 `exec` 走解释器 |
| XSS 转义 | `tool-card-ui.ts`（模型数据主链路，5 处 `escapeHtml`） | `src/ui/*` **零转义** |
| 定时器管理 | `mcp-controller.ts:313`（正式请求路径存进 pending 管理） | 同文件 `:586/:602`（测试路径）无 clear |
| Promise 链失败恢复 | `bridge/storage.ts:359`（`then(noop, noop)` 续命） | `file-storage-backend.ts` **无 catch** |
| `ok` 检查 | `workspace.set`（检查了） | 其余 6 处未检查 |

**修复建议**：不要逐个修，把正确模式抽成共用工具（如 `withTimeout(promise, ms)`、
统一的 `authenticateUpgrade(req)`），从源头消除分叉。

### 模式二：清理逻辑写在 `await` 之后

`proc.kill()`、`observer.disconnect()` 的部分路径、UI 组件的退订——都写在正常流程末尾。
异常/超时路径一律跳过。**统一改用 `try/finally`**。

### 模式三：可观测性缺失放大了所有缺陷

无 `uncaughtException` 兜底 + `EventBus.emit` 吞异常 + 大量空 `catch`（`mcp-controller` 3 处**零日志**）。
三者叠加导致"出问题即静默"——这解释了为什么这些缺陷长期没被定位。

---

## 五、历史台账状态变更汇总

| 历史编号 | 历史状态 | 实测结论 |
|---|---|---|
| R3-H2 `grant-store.get()` | ❌ 未修（称导致 2 条测试失败） | **记录有误**——13 用例全绿，`!g.consumed` 被 else 分支抵消，功能正确，仅残留死分支 |
| R2-C1 存储并发丢更新 | ⚠️ 待复核 | **已修复**（`enqueueMutation` 串行队列 + 确定性回归测试） |
| C3 MCP fetch 无超时 | ❌ 未修 | **已修复**（5 处 `AbortSignal` 齐全），但 **UI 侧 3 处完全漏修** |
| C1 `tool-card-ui` XSS（high） | ❌ 未修 | **已修复**（`escapeHtml` + 图片白名单） |
| C2 `automation` 无校验即命令源 | ❌ 未修 | **半修**——schema 校验已补，执行侧仍是 `exec` |
| C4 断线清 pending | ⚠️ 待复核 | **已修复**（`failAllPending` 在 close + error 双路径覆盖） |
| MCP 进程退出不 reject | ❌ 未修 | **已修复**（`exit` 时遍历 reject 全部 pending + clearTimeout） |
| C6 定时器泄漏 | ⚠️ 待复核 | **部分修复**（正式路径已管，测试/race 路径未管） |
| R3-H1 loader 假成功 | ⚠️ 待复核 | **确证未修** |
| F5-C1 事件幽灵订阅 | ⚠️ 未复核 | **确证未修**（并升级为首要根因） |
| F6-C1 监听器泄漏 | ❌ 未修 | **确证未修**（14 on / 0 off，量化确证） |
| F7-C1 策略档位不一致 | ❌ 未修 | **确证未修** |

---

## 六、假阳性裁决汇总

| 候选 | 裁决 | 依据 |
|---|---|---|
| madge 循环依赖 `desktop-host ↔ page-runtime` | 假阳性 | `import type` 编译后擦除，esbuild 打包成功佐证 |
| F4-H2 `pointer-events` 白名单 | 当前不触发，架构隐患仍在 | 6 个组件根元素均为 container 直接子元素，被 `.studio-ui-root > *` 覆盖 |
| detect-secrets 94 命中 | **全部假阳性** | `tauri.conf.json` = minisign 公钥（本就需公开）；wasm base64 内嵌；92% 来自 `deepseek-pp/` 副本与测试假令牌 |
| SEC-04 路径穿越 1 处 | 假阳性 | 固定 `path.join(home, ...)` 无外部输入拼接 |
| SEC-05 `eval` / `new Function` | 0 命中 | 项目无动态代码执行 |
| `DATA-02` JSON.parse 41 条 | 大部分噪音 | 测试 7 条；`server.ts` 5 条有 try/catch 且返回 400 |
| `LOG-01` 敏感日志 2 条 | 假阳性 | `api/main.ts:109` 只打印路径不含 secret 值 |
| RES-01 fetch 无超时 43 条 | 大部分噪音 | 测试 29 条；真实命中为 UI 侧 5 条 |

---

## 七、设计良好项（重构时勿破坏）

1. **工作区边界**（`src/host/workspace.ts:124-160`）——词法检查 + `realpath` 防软链接逃逸 + 大小写按平台处理 +
   `statSync` 失败时 fail-closed。注释写明"根自身也做 realpath"，考虑到了工作区根本身是软链接的情形，质量高于同类实现。
2. **shell 能力红线**（`src/capabilities/shell.ts`）——`shell: false` 永不启用解释器、
   `hasShellSyntax` 显式拒绝管道/重定向并**提示改用 argv 数组而非静默执行**、超时、64KB 截断、cwd 校验。五项齐全。
3. **密钥环**（`src/host/host-token.ts:57-107`）——随机 32 字节、`0600` 落盘、支持轮换且
   **旧密钥有 10 分钟宽限期**。它规避了一个真实陷阱：轮换瞬间已签发的 grant 不会因"签发用旧密钥、校验用新密钥"而被误拒。
4. **grant 一次性语义 + 审计环**——`consume()` 置 `consumed` 后不可重放；`executeTool` **授权先于执行**，每个出口都写审计。
5. **原子写模式**（`file-storage-backend.ts:42-45`、`automation.ts:151-155`）——两处都用「写 `.tmp` → `rename`」，
   是本项目中少有的"两套实现都做对了"的地方。
6. **`enqueueMutation` 失败隔离**（`bridge/storage.ts:357-369`）——双 `then` 吞失败、错误原样传给调用方，设计意图与实现都对。
7. **`host-client` 重连定时器管理**——`stopped` 标志 + 句柄保存 + `stop()` 中 clear，每条请求带 timer 结算时清理。全项目样板。
8. **`inject/lifecycle.ts` 依赖注入定时器**——可注入假定时器精确控制时间，可测试性极好，值得推广。

---

## 八、修复路线图

### 第一步：P0 × 3（按成本升序，P0-1 已被上游修复）

| 顺序 | 缺陷 | 工作量 | 验收判据 |
|---|---|---|---|
| ① | 写链 `.catch`（P0-4） | **1 行** | 注入一次失败后，后续正常写入成功 |
| ② | MCP `spawn` error 监听（P0-3） | 几行 | 配置不存在命令 → 返回明确错误且**宿主 pid 不变** |
| ③ | WS `/studio` 鉴权（P0-2） | 中（照抄 `/agent-ws`） | 裸连接被 `close(1008)`；untrusted 发 `tool-call` → executor 调用 0 次 |

### 第二步：上 3 条 ESLint 规则，批量根治 P1 模式

| 规则 | 根治对象 | 影响 |
|---|---|---|
| 禁止模板字符串直插 `innerHTML` | 第二轮 4 处 XSS（+ 后续新增面） | 从源头杜绝 |
| 禁止 `await callHostTool(...)` 后不检查 `.ok` | 第四轮 5 处假成功 | 防止复发 |
| 清理逻辑须在 `try/finally` 中 | 第三轮 2 处子进程泄漏 | 异常路径不再跳过 |

外加：把 `tsc --noEmit` 与 esbuild warning 设为 **CI 硬闸门**。
P0-1（空文件）暴露的真正问题是"类型报错不阻断"——这是投入产出比最高的一项治理。

### 第三步：事件契约治理（第一轮 P1）

不要逐个补 emit/on，而是：
1. 单一模块导出事件名常量表（`src/ui/ui-events.ts`）；
2. 收敛到一张配对表 `{ event, emitters, listeners }`；
3. CI 断言：任一事件必须同时存在 emitter 与 listener，否则构建失败。

### 通用原则

**每修一项补回归测试。** 历史第九轮的教训是"改完不跑测试引入回归"。
四轮的探针（订阅计数、WS 裸连接、XSS 注入、写链毒化、活动句柄）都可直接固化为回归测试。

---

## 九、复现与验证命令

```bash
cd /data/workspace/deepseek-studio

# ── P0-1 空文件（已被上游修复，用于验证）──
wc -l src/ui/studio-input-bar.ts            # 期望 > 0（现为 157）
./node_modules/.bin/tsc --noEmit            # 期望 0 错

# ── P0-2 WS /studio 零鉴权 ──
grep -c "token" src/host/page-runtime.ts    # 0   ← 缺陷（仅注释）
grep -c "token" src/host/agent-channel.ts   # 4   ← 有鉴权，照抄这个
sed -n '866,874p' src/host/desktop-host.ts  # origin: DEEPSEEK_ORIGIN 硬编码（自授权）

# ── P0-3 spawn 无 error 监听 ──
grep -c "on('error')" src/host/mcp-controller.ts          # 0  ← 缺陷
grep -rn "uncaughtException\|unhandledRejection" src/ | wc -l  # 0 ← 无兜底

# ── P0-4 写链毒化 ──
sed -n '37,48p' src/host/file-storage-backend.ts   # 无 .catch → 毒化
sed -n '357,369p' src/bridge/storage.ts            # then(noop,noop) → 正确，照抄这个

# ── 事件契约双向差集 ──
grep -rhoE "globalEvents\.emit\('[a-zA-Z:_-]+'" --include="*.ts" src | sort -u > /tmp/e
grep -rhoE "globalEvents\.on\('[a-zA-Z:_-]+'"  --include="*.ts" src | sort -u > /tmp/o
comm -23 /tmp/e /tmp/o    # emit-only（应为空）
comm -13 /tmp/e /tmp/o    # on-only（应为空）

# ── 订阅泄漏计数 ──
grep -rc "globalEvents.on("  --include="*.ts" src | grep -v ":0"   # 14
grep -rc "globalEvents.off(" --include="*.ts" src | grep -v ":0"   # 0

# ── XSS：UI 侧无转义工具 ──
grep -rn "escapeHtml" src/ui/                       # 应 >=1，实际 0
grep -c "escapeHtml" src/inject/tool-card-ui.ts     # 5 → 历史 C1 已修

# ── 假成功：未检查 ok 的 callHostTool ──
grep -rn "await callHostTool" src/ui/*.ts | grep -v "if (result"

# ── 清理写在 await 之后 ──
sed -n '584,607p' src/host/mcp-controller.ts   # kill 在 await 后，超时路径跳过
```

---

## 十、后续：代码同步后的状态与新关注面

### 同步概况

2026-10-17 拉取了 upstream 新代码：新提交在 **`feat/bot-core`** 分支（`522525a9`，M0–M3 内核归位），
**master 分支无新提交**。代码 41 198 → **44 293 行**，新增 `tools/`（团队自建 audit/contract/e2e 工具）、
`personas/`、CI 工作流，以及 `marked` 依赖（UI markdown 渲染换掉自建正则渲染器）。

快照关系：`a12ce90`（旧基线）→ `eaa4cc7`（新快照）。

### 四个 P0 的最新状态

| P0 | 状态 |
|---|---|
| P0-1 空文件 | ✅ **已由上游修复**（157 行，`tsc` 0 错） |
| P0-2 WS 鉴权 | ❌ 未修（`page-runtime.ts` 的 1 处 `token` 只是注释） |
| P0-3 spawn error | ❌ 未修（0 命中） |
| P0-4 写链毒化 | ❌ 未修（仍无 `.catch`） |

### 新代码新增的关注面（第五轮初步，未完成）

第五轮刚开始即被中断，以下为**已确证的初步发现**，尚未完成完整审计：

1. **`marked` 渲染链 XSS（已运行时确证）**——`src/inject/markdown.ts` 用 marked 渲染，
   **注释明确写着 sanitize 关闭、不引入 DOMPurify**（"如需严格 XSS 防护后续再加"）。
   探针实测 6 类负载**全部原样透传**：裸 `<img onerror>`、`<script>`、`<svg onload>`、
   `javascript:` 链接、`<iframe srcdoc>`、markdown 图片的 `javascript:` 协议。
   调用方 `studio-chat-room.ts:396/409` 与 `studio-chat-ui.ts:432` 均用 `innerHTML` 渲染，
   数据是**模型输出**。这是第二轮 XSS 面的扩大，优先级应不低于 P1。
2. **`src/desktop/host-client.ts:239` 存在 `eval(code)`**——`debug-eval` 调试端点。
   缓解得当：需统一 bearer 鉴权 + 显式 `STUDIO_DEBUG=1` 才启用（默认关闭），已按 R1-01 加固。暂不列为缺陷。
3. **新增 8 831 行 src 代码**（`src/host/bot/` 4 826 行、`src/host/kernel/` 846 行等）尚未审计。
4. **19 个测试失败**（1 058 用例中）——主体为环境噪音：约 10 个 Windows 路径硬假设、
   2 个 jsdom 无 WebSocket、2 个 sqlite 未编译、1 个 1ms 时序差；另有 4 条待查。

### 建议下一步

转入 **diff 模式审计**（`git diff a12ce90..HEAD` 只审新增面），重点：
M0–M3 新内核（`bot-*` / `kernel-*`）、marked 引入后的 XSS 面、
团队 `tools/audit/` 与本审计的口径对齐、以及 19 个失败的逐条定性。

---

## 附：产物清单

| 文件 | 说明 |
|---|---|
| `审计准备与基线_deepseek-studio_20261017.md` | 环境搭建、工具链、基线快照、历史台账索引 |
| `审计报告_第一轮_稳定性与功能性_20261017.md` | 1 P0 / 5 P1 / 1 P2 / 3 P3 |
| `审计报告_第二轮_安全专题_20261017.md` | 1 P0 / 4 P1 / 1 P2 |
| `审计报告_第三轮_资源与生命周期_20261017.md` | 1 P0 / 3 P1 / 1 P2 |
| `审计报告_第四轮_数据一致性与假成功_20261017.md` | 1 P0 / 5 P1 / 1 P2 / 1 P3 |
| `代码同步_feat-bot-core_522525a9_20261017.md` | 远端实况、同步内容、新基线 |
| `audit/artifacts/createInputBar-参考实现.js` | 从旧产物提取的 129 行实现（P0-1 修复用） |
| `audit/artifacts/baseline-20261017*/` | 各轮基线数据（tsc / eslint / knip / madge / jscpd / 专项扫描） |
