# deepseek-studio 稳定性/功能性审计报告（2026-10-12）

- **审计平台**：ADM-auditkit（32 条规则 active / broken=0，selftest 21 分析器全绿）
- **审计对象**：`E:/NAS/deepseek-studio`（源码态；TS 840 + JS 58 + Rust 3）
- **轮次**：`round-003`（mode=full）
- **重点专题**（按委托）：**MCP 使用 / tools 执行层面**
- **原始产物**：`E:/NAS/ADM-auditkit/projects/deepseek-studio/round-003/`、`bugs.json`（8 条）、`triage.json`

---

## 〇、结论速览

| 类别 | 数量 | 说明 |
|---|---|---|
| 确证缺陷（进台账） | **6 条站点 / 5 个族** | 工具卡片 XSS（high）、automation 任务文件即命令源（medium-high）、MCP HTTP 无超时（medium）、定时器泄漏（medium）、MCP 退出不 reject（medium）、stdio shell+env 泄露（medium） |
| 机器候选未升级 | 5,268 条 | 其中 **82% 来自 deepseek-pp 嵌套副本**；studio 自身仅 922 条，且 94% 是 TS-03 噪音 |
| 假阳性裁决 | 2 族 | innerHTML 静态模板、测试假令牌 |
| 工具漏报 | 1 个方向 | **TS/JS 的 fetch 无超时完全无规则覆盖**（超时类规则全是 Python AST） |
| 设计良好项 | 6 项 | 见 §5 |

**一句话**：治理层（tool-registry 风险分级 / consent 阈值 / fail-closed origin）质量很高，问题集中在**两个接缝**：① 工具结果的渲染接缝（innerHTML 未转义）；② MCP 传输接缝（stdio 有超时、HTTP 没有；崩溃不 reject；定时器不清理）。

---

## 一、确证缺陷详述（按严重度）

### C1【high】工具卡片 innerHTML 未转义 —— 模型/第三方数据直插 DOM（XSS）

- 位置：`src/inject/tool-card-ui.ts:272-315`（`buildCardHtml`）、消费点 `:331` / `:362`
- 证据链（本次回读）：
  - `buildCardHtml` 把 `data.toolName`、`formatJson(data.params)`、`resultText`、image url **原样插值**进模板字符串（297/303/309/290 行）；
  - 全文件搜索 `escapeHtml|textContent` = **0 命中**（即无任何转义机制）；
  - `card.innerHTML = buildCardHtml(...)` 注入真实 DOM。
- 数据来源全部不可信：`toolName`/`params` 来自 LLM 模型输出（v0.6 页端拦截的 tool-call）；`resultText`/image 来自**第三方 MCP server 的 tools/call 返回**（`mcp-controller.ts:396-430` 明文透传）。
- 后果：`</pre><script>…` 或 `<img src=x onerror=…>` 在 chat.deepseek.com 注入页执行 → 可窃取该页面会话、调用页面侧能力（chat-read/insert/send）。MCP image 的 `src="${url}"` 还接受 `javascript:` 类 URL。
- 修复：工具名/参数/结果一律 `escapeHtml`（或改 `textContent` 构造节点）；image url 白名单校验（仅 `data:image/` 与 `https:`）。

### C2【medium-high】automation-tasks.json 无校验即成为命令执行源

- 位置：`src/host/automation.ts:102-113`（`loadTasks`）、`:181-188`（`executeTask`）
- 证据链：`loadTasks()` 仅 `JSON.parse` + `Array.isArray` 即 `tasks.set(t.id, t)`，**无 schema 校验、无签名**；`executeTask` 对 `type==='shell'` 直接 `exec(task.payload.command!, { timeout: 30000 })`；`enabled` 任务按 schedule 自动触发。
- 后果：该 JSON 被污染（误导入、同步软件冲突、其他组件误写）→ 任意命令按计划自动执行。磁盘文件 = 执行源，中间没有任何校验层。
- 修复：loadTasks 加 schema 校验（type/payload 白名单、command 非空且限长）；shell 任务执行前过 risk=privileged 的 consent 链（与 tool-registry 的 CONSENT_MIN_RISK 对齐）；写盘时原子写已有（`:115-125`）但读侧完全裸奔。

### C3【medium】MCP HTTP/SSE 传输 fetch 无超时

- 位置：`src/host/mcp-controller.ts:304`（sendHttpRequest）、`:340`（sendNotification fire-and-forget）、`:552/565/572`（testHttpConnection）
- 证据链：stdio 路径的 `sendRequest` 有 30s 超时（`:287-292`），**HTTP/SSE 路径的 `fetch` 没有任何 timeout/AbortSignal**。
- 后果：MCP server（或测试时用户填的 URL）挂起 → `callTool` 的 Promise 永久 pending → 上层 agent loop 卡死，且无任何日志。
- 修复：`fetch` 加 `AbortSignal.timeout(30000)`；通知失败不要全静默（至少 debug 日志）。

### C4【medium】三处 setTimeout 从不 clearTimeout（定时器泄漏）

- 位置：`mcp-controller.ts:287-292`（sendRequest 30s）、`:363-366`（getAllTools 的 Promise.race 10s）、`:519/535`（testConnection 5s）
- 后果：每次 MCP 请求泄漏一个持有 `conn`/闭包的定时器；调试会话里反复 testConnection + 高频工具调用会持续累积（Node 定时器阻止 GC）。
- 修复：`const t = setTimeout(...)` + 在 resolve/reject 路径 `clearTimeout(t)`；Promise.race 模式改 `AbortController`。

### C5【medium】MCP 进程退出不 reject 挂起请求

- 位置：`mcp-controller.ts:225-228`（`proc.on('exit')`）
- 证据链：exit 只 `console.warn` + `this.connections.delete`，**不遍历 `pendingRequests` 做 reject**，也不移除 stdout/stderr 监听器。
- 后果：server 崩溃时所有在途请求要干等 30s 超时才失败；监听器随 conn 泄漏。
- 修复：exit 时 `for (const [, p] of conn.pendingRequests.values()) p.reject(new Error('server exited'))` + `conn.pendingRequests.clear()` + `proc.stdout?.removeAllListeners()`。

### C6【medium】stdio spawn 用 `shell:true` 且全量泄露宿主环境变量

- 位置：`mcp-controller.ts:181-187`（`connectStdio`）、`:469-473`（`testConnection`）
- 证据链：`spawn(config.command, config.args, { shell: isWin, env: { ...process.env, ...(config.env ?? {}) } })` —— command/args/env 全部来自用户维护的 `mcp-servers.json`。
- 两个后果：① `shell:true` 使用户配置文件里的命令串经过 shell 解释（配置文件被污染或从网上抄来恶意配置 → 命令执行）；② `{...process.env}` 把宿主**全部**环境变量（含各服务 token）发给每一个第三方 MCP server。
- 修复：去掉 `shell:true`，Windows 上用 `shell:true` 仅对 `.cmd` 后缀做窄放行（或改用 `where` 解析）；env 改为白名单透传（只传 MCP 需要的键）。

### C7【low-medium】`loadMcpServers` 平铺兼容模式误把元数据当服务器

- 位置：`mcp-controller.ts:86-93`：除 `servers` 外的**任意**顶层对象键都被当作服务器配置。
- 后果：配置里出现 `{"meta": {...}}` 之类的说明性键 → connect 时 `spawn(undefined)` → 抛错（有 catch，不崩，但每次连接尝试都报一次错，噪音 + 误导排障）。
- 修复：平铺模式只接受含 `command` 或 `url` 的键。

### C8【low-medium】`testConnection` 在 Windows 上对 `.cmd` 命令必失败

- 位置：`mcp-controller.ts:469-473`：测试连接**没有** `shell: isWin`（`connectStdio` 有）。
- 后果：Windows 上测试 `npx`/`python` 类 MCP server 恒报 ENOENT（功能缺陷：用户以为配置错了）。同文件内两处 spawn 口径不一致。
- 修复：与 connectStdio 统一（或抽一个 `spawnMcpProcess(config)` 共用）。

### C9【medium】MCP 工具返回的图片 data URL 无大小限制

- 位置：`mcp-controller.ts:417-422`（`data:${mime};base64,${c.data}`）与 `:425-430`（inline_bytes）
- 后果：第三方 server 返回超大 base64 → 宿主内存暴涨，且原样塞进 LLM 多模态上下文（token 爆炸）。
- 修复：单张图片设字节上限（如 5MB），超限截断为文本占位。

---

## 二、机器命中分布（round-003）

| 规则 | 命中 | 判读 |
|---|---|---|
| `TS-03-unhandled-promise` | 4,973 | **94% 是噪音**（P4 缺陷的又一实证：裸调用行匹配；studio 自身 281 条 MCP/tools 链命中里它占 233） |
| `TS-01-innerhtml` | 116（studio 88） | 1 条确证（C1），其余多为静态模板/`=''` 清空 |
| `TS-04-any-abuse` | 84 | `any` 滥用，多发生在 MCP 响应对接口（mcp-controller:539/578） |
| `GEN-01-hardcoded-secret` | 39 | studio 自身 8 条**全在 tests/**（假令牌） |
| `GEN-03-eval-dynamic` | 34 | 2 条在 studio：automation.ts:184（C2）、page-runtime.ts:257（`void exec(...)` 已有 then/catch，误报） |
| `JS-01-innerhtml` | 28 | 全部在 `entry.js`（注入页引导脚本） |

**扫描污染（平台侧待修）**：5,268 条里 **4,346 条（82%）来自 `deepseek-pp/` 嵌套副本**——它是本仓库内的上游解包子目录，不在 skip_dirs 里。建议 `config/projects.yaml` 的 deepseek-studio 条目加项目级排除（不可把 `deepseek-pp` 写进引擎 `DEFAULT_SKIP_DIRS`——那是本项目私有目录名，违反判据可移植性）。

---

## 三、假阳性裁决（已落盘）

| 规则 | 位置 | 理由 |
|---|---|---|
| `TS-01-innerhtml` | `tool-card-ui.ts:245` | 静态模板字面量，无任何用户/模型数据 |
| `GEN-01-hardcoded-secret` | `tests/tool-registry.test.ts:81` | 测试假令牌；测试路径应默认折叠（经验包收敛建议 04） |

---

## 四、工具漏报（平台缺口，建议开规则提案）

**TS/JS 的「外部调用无超时」完全无覆盖**。C3 之所以漏报，是因为所有超时类规则（`py.outbound_call_no_timeout`、`py.http_timeout_disabled`、`py.requests_no_timeout`）都是 **Python AST 规则**；`generic_text` 正则层没有任何 fetch/XHR 超时模式。而本项目 MCP HTTP 路径、automation 的 http 任务（`automation.ts:190 fetch(task.payload.url)` 同样无超时）都中招。

建议新增 generic_text 模式：`TS-07-fetch-no-timeout` / `JS-06-fetch-no-timeout`——`fetch(`/`axios.` 调用行不含 `signal`/`timeout`/`AbortSignal` 即命中（NEEDS_REVIEW 定级，与 TS-03 同档信息级）。这是跨语言缺口，不是本项目特例。

---

## 五、设计良好项（已验证，避免下轮重复审）

| 项 | 证据 |
|---|---|
| tool-registry 风险分级用**阈值比较**而非判等（`riskRank(risk) >= riskRank(CONSENT_MIN_RISK)`），新增等级自动生效 | `tool-registry.ts:45-56` |
| origin 白名单 fail-closed（未注册/空 origin/不在白名单一律拒） | `tool-registry.ts:119-128` |
| 执行侧显式声明（`execution: 'host'` 强制宿主执行，防页端误派发） | `tool-registry.ts:58-75` |
| tool-loop 异常路径也走 after 钩子 + `terminate` 防自动续跑死循环 | `tool-loop.ts:88-113` |
| automation 任务写盘原子写（tmp + rename） | `automation.ts:115-125` |
| MCP server 连接失败即从 connections 删除（不留半初始化连接） | `mcp-controller.ts:170-174` |

---

## 六、修复优先级

| 优先级 | 项 | 工作量 |
|---|---|---|
| P0 | C1 工具卡片转义（XSS 在注入页，可直接窃会话） | 小（一个 escapeHtml + image url 白名单） |
| P1 | C2 automation 任务文件 schema 校验 + shell 任务过 consent | 中 |
| P1 | C3 MCP HTTP fetch 加 AbortSignal.timeout | 小 |
| P2 | C4/C5 定时器清理 + exit reject | 小 |
| P2 | C6 spawn 去 shell:true + env 白名单 | 中（需回归 Windows 启动） |
| P3 | C7/C8/C9 | 小 |
| 平台侧 | deepseek-pp 副本排除 + TS-07 fetch-no-timeout 规则 | 中 |

---

## 七、工作流验证结论

| 验证点 | 结果 |
|---|---|
| selftest / 规则加载 | 通过；32 条 broken=0 |
| 画像 | 正确识别 TS/JS/Rust 混合（generic_text 跨语言层是唯一覆盖手段） |
| R0→R1→triage 闭环 | 成立：9 项确证里 6 项有规则命中、3 项纯手工（C3/C4/C5/C6 中大部分射程外） |
| 最大平台缺口实证 | ① 82% 扫描污染（嵌套副本）；② TS 侧无超时规则；③ TS-03 一条规则占 94% 命中（P4 未修的代价） |

---

## 八、平台侧修复（2026-10-12 当日闭环）

本轮暴露的两个平台缺陷已修复并验证：

### 8.1 嵌套副本污染 —— N10 已落地（项目级 skip_dirs）

之前引擎**根本不消费** `config/projects.yaml` 的 `defaults.skip_dirs`——skip 用的是
`engine/profile.py` 与 `core/lang/generic_text.py` 里的**硬编码** `SKIP_DIRS`，且无项目级覆盖通道；
而把 `deepseek-pp` 写进全局会误伤同名独立登记项目（N10 判据）。

本次实现项目级 skip_dirs 支持（五处）：
- `engine/profile.py`：`ProjectProfile` 增 `skip_dirs` 字段，`from_dict` 读取
- `engine/static_ast_mode.py:iter_sources`：合并 `prof.skip_dirs` 到遍历排除
- `core/lang/generic_text.py:main`：接受 `--skip-dirs` 并合并到 walk 排除
- `engine/runner.py`：`run_round` / `run_generic_text` 透传
- `auditkit:cmd_round`：从**项目配置段**（非画像 JSON）取 `skip_dirs` 注入
  （根因坑：`cmd_round` 的 `profile` 是画像 JSON，不含项目配置键）

`config/projects.yaml`（及本地 `projects.local.yaml`）的 `deepseek-studio` 段加：
```yaml
skip_dirs: [deepseek-pp]
```
**效果**：重跑全量轮（round-006）——总命中 **5,268 → 557**，deepseek-pp 路径命中
**4,269 → 0**，独立项目 `deepseek-pp` 因 skip 走项目级而**不受影响**。

### 8.2 TS-03 过宽收敛 —— P18（P4 长期挂账的实质）

`TS-03-unhandled-promise` 正则只匹配"行尾直接结束的调用"，**无法判别返回值是不是 Promise**，
导致 `res.setHeader`/`res.end`/`buckets.set`/`process.exit`/`el.appendChild`/`emitter.emit`
等同步/非 Promise 调用全被误判。它是单条规则淹没真实信号的典型（round-003 占 94% 命中）。

本次两道白名单收敛：
- `TS03_OK_HINT`（行内含 `.catch(`/`await `/`void `/`console.`/`logger.`/`expect(` 或
  边界正则命中 `await|void|return|it|test|describe` 调用 → 已处理/常规忽略）
- 扩大 `TS03_SYNC_WHITELIST` 到 HTTP/Node/DOM 同步 API（`setHeader`/`writeHead`/`end`/
  `exit`/`Sync(`/`appendChild`/`addEventListener`/`removeEventListener`/`setAttribute`/
  `emit`/`delete`/`add`/`remove`/`replace`）

**效果**：studio 自身 TS-03 **837 → 455**（降噪 46%）；叠加 8.1 后全量 **5,268 → 557**（89%）。
剩余 455 条多为 `fetch`/全局函数/可能 Promise 的 `close`/`start`/`kill`，作为 info 级
（NEEDS_REVIEW）清单可接受。**根治需 AST 语义分析**（判别调用目标是否返回 Promise），
正则白名单是治标，故维持 info 级不据此写"此处无缺陷"结论。

---

## 九、局限性声明

1. 本轮为静态分析 + 代码回读，**未做运行时 PoC**（未在真实 chat.deepseek.com 页验证 XSS 触发链、未构造恶意 tasks.json）。C1/C2 的路径由数据流直接推证，标注【候选·已回读】。
2. Rust 侧（`src-tauri/`，3 文件）仅有 generic_text 正则覆盖，未做深度审计；已知候选（sidecar.rs Windows 孤儿进程）沿用 2026-10-12 前序报告结论，本轮未复核。
3. 嵌套副本（deepseek-pp/）的 4,346 条命中已在 8.1 中通过项目级 skip_dirs 排除——审副本等于审上游解包，不是本项目代码；独立项目 `deepseek-pp` 仍正常审计。

---

审计署名：ADM 审计 Agent（CodeBuddy 审计席）
轮次产物：`projects/deepseek-studio/round-003/`（findings 924 / report.md）、`round-006/`（收敛对比）
裁决落盘：`projects/deepseek-studio/triage.json`（accept 6 / reject 2，含历史 2 条）
平台修复：N10 项目级 skip_dirs + P18 TS-03 收敛（见第八节）
