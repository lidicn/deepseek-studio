# deepseek-studio 代码审计报告

- 日期：2026-10-11
- 审计对象：`E:\NAS\deepseek-studio`（版本 0.4.0，源码树含 v0.9 增量）
- 审计范围：工具调用链路（页端拦截 → 宿主授权 → 能力执行 → 结果回注）、宿主稳定性、策略/工作区边界
- 方法：源码逐函数通读 + 静态类型检查（`tsc --noEmit`）+ 全量测试（`vitest run`）+ 关键路径交叉验证
- 基线证据：`tsc --noEmit` 退出码 0；`vitest run` 24 文件 / 201 用例全绿（94.74s）

> 说明：测试全绿并不代表无 bug。本次发现的高价值缺陷全部位于「测试未覆盖的接缝处」——契约字段映射、运算符优先级、断线清理、双循环协调。这与以往对 memory-agent 的教训一致：静态指纹与绿色测试都只能当线索。

---

## 1. 执行摘要

| 严重度 | 数量 | 类别 |
|--------|------|------|
| Critical | 6 | 工具调用失败 / 稳定性 |
| High | 4 | 功能性 / 资源泄漏 |
| Medium | 5 | 健壮性 / 可维护性 |
| Info | 3 | 一致性 / 文档 |

总体健康度：**Needs Work（可用但存在可复现的工具调用失败面）**。授权链、工作区边界、宿主/页端隔离这三块治理设计扎实且有测试背书；缺陷集中在**契约映射层与跨进程接缝**，正是当前测试覆盖最薄弱的地方。

---

## 2. 最关键的 6 个缺陷

### C1 — 续读参数在契约层被整体丢弃（工具调用失败，High 置信）

- 位置：`src/shared/tool-contract.ts:36-39`
- 代码：
```ts
local_file_read: {
  id: 'file.read',
  adapt: (p) => ({ path: typeof p.path === 'string' ? p.path : '' }),
},
```
- 上游 `local_file_read` 的公开参数是 `path` / `start` / `max_chars`（见本次会话可用工具定义），而 Studio 能力 `src/capabilities/file.ts` 期望 `offset` / `limit`。
- 三重错配：① 字段名不同（start↔offset、max_chars↔limit）；② `adapt` 只保留 `path`，其余键一律丢弃；③ 能力侧默认 `offset=0`。
- 后果：任何「续读/分页读取」请求都退化为「每次从第 0 字节重读前 512KB」。对大于 512KB 的文件，模型会不断拿到相同开头，陷入重复读取或错误总结。工具「成功返回」但语义错误——属于隐蔽的功能性失败。
- 建议：`adapt` 显式映射 `start→offset`、`max_chars→limit`，并在契约层补一条「映射后参数必须被能力识别」的表驱动测试。

### C2 — 原始工具标签泄漏检测正则过窄（工具调用失败，High 置信）

- 位置：`src/host/agent-loop.ts:33`
- 代码：
```ts
const RAW_TOOL_TAG_RE = /<local_file_(?:read|write|stat)>\s*[^<]*<\/local_file_(?:read|write|stat)>|<shell_exec>\s*[^<]*<\/shell_exec>/;
```
- `[^<]*` 要求标签体内不得出现 `<`。但 `local_file_write` 的 `content` 常含 `<`（写 HTML/XML/Markdown）或 `shell_exec` 的 `command` 含重定向 `<`。
- 后果：JSON 解析失败的原始标签一旦含 `<`，`RAW_TOOL_TAG_RE` 不匹配 → 不发纠偏 → 原始 XML 标签直接暴露给用户，且模型不会被告知格式错误。
- 建议：改用非贪婪 `[\s\S]*?`，并配合解析器已产出的 `__invalid_json` 标记作为主判据（该标记更可靠），正则仅作兜底。

### C3 — PowerShell 检测的运算符优先级错误（工具调用失败，High 置信）

- 位置：`src/capabilities/shell.ts`
- 代码：
```ts
if (process.platform === 'win32' && /^powershell(\.exe)?$/i.test(argv[0]) || /^pwsh(\.exe)?$/i.test(argv[0] || '')) {
```
- JS 中 `&&` 优先级高于 `||`，实际语义为 `(win32 && powershell) || pwsh`。
- 后果：① 非 Windows 平台只要 `argv[0]` 是 `pwsh` 就会错误走 `-EncodedCommand` 分支；② 原意「Windows 上兼容 powershell 与 pwsh」被写成了依赖短路巧合，任何后续调整（新增 shell 名）都可能静默失效。
- 建议：补括号 `win32 && (/^powershell(\.exe)?$/i.test(argv[0]) || /^pwsh(\.exe)?$/i.test(argv[0] || ''))`。

### C4 — 页端断线不清 pending：工具调用挂起到超时（稳定性，High 置信）

- 位置：`src/host/page-runtime.ts`（`ws.on('close')` / `ws.on('error')` 仅 `clients.delete(id)`）
- 相关：`src/desktop/host-client.ts`（`socket.onclose` 仅 `ws=null` + `scheduleReconnect()`）
- 后果：
  - 宿主侧 `pendingDispatch` / `pendingConsent` 中的 promise 只有在 30s / 60s 定时器到期后才 reject/deny；页面重连期间的工具调用白白等待并占用内存。
  - 页端 `pendingToolCalls` 同样只在 30s 超时后 resolve，重连后旧请求已无法关联（callId 已废弃）。
  - 反复重连会在两侧持续累积「僵尸 pending」条目，是长期运行下的稳定性与内存隐患。
- 建议：在 close/error 处理里遍历对应 pending map，立即以 `{ok:false,error:'disconnected'}` / `'deny'` 结算并清空；宿主侧同理。

### C5 — 双自动循环并存，工具可能被重复执行（稳定性 / 功能性，Medium-High 置信）

- 位置：`src/inject/main-world-interceptor.ts`（`autoContinueWithPow`，`MAX_LOOP = 8`）与 `src/host/agent-loop.ts`（`maxSteps = 15`）
- 两者都在「检测到工具调用 → 请求模型继续」，彼此不感知。
- 后果：同一轮对话可能被两条循环同时推进，导致工具重复执行、上下文错乱，或达到不同上限后行为不一致（页面侧 8 次、宿主侧 15 次）。
- 建议：确立单一编排者（推荐宿主 AgentLoop），页面拦截器只做「解析 + 投递 + 结果回填」，移除自带的自动续跑；若必须保留，需以显式互斥标志协调。

### C6 — 无页回退返回「假成功」快照（功能性，Medium 置信）

- 位置：`src/host/desktop-host.ts` `routeExecution` 回退分支：`return { ok: true, snapshot };`
- 该分支对 `chat-read` 之类的页端能力执行 `start/stop` 后返回 `ok:true`，但**没有 `data`**。
- 后果：`src/host/engine/web-engine.ts` 的 `readLastMessage` 拿到 `r.ok===true` 但 `data.messages` 为空 → 返回空文本；完成检测永远命中不了「稳定快照」，只能靠 120s 看门狗兜底，表现为「回复极慢 / 面板长时间转圈」。
- 建议：回退分支对需要 `data` 的能力返回 `ok:false, reason:'no-page-runtime'`，让上层快速失败而不是假装成功。

---

## 3. 其余缺陷

### High

- **H1 契约映射不完整**（`src/shared/tool-contract.ts`）：`UPSTREAM_TO_STUDIO` 只有 4 项，且 `shell_exec` 丢弃 `argv`；`file.list`、`skill.list` 无上游入口；宿主已登记但模型无法通过 XML 触达，能力存在却不可用。
- **H2 工具提示注入面过宽**（`main-world-interceptor.ts` `hasToolIntent`）：正则含「读/写/看/打开/文件/命令/运行」等高频中文词，普通闲聊极易命中 → 每轮对话都被塞入系统级工具说明，污染上下文并抬高被诱导发起工具调用的概率。
- **H3 续跑请求丢弃原始提问**（`autoContinueWithPow`）：`parsed.prompt = continuationPrompt` 直接覆盖原 prompt，仅靠 `parent_message_id` 关联历史。一旦服务端不按该字段回放上下文，续跑即失去问题语义。
- **H4 `pending.length = 0` 与注入路径竞态**（同文件）：清空 pending 后若同轮 XHR 注入路径再次读取，可能产生「结果既被续跑携带、又被注入一份」或「两者都丢」的非确定行为；注释承认是 F8 权宜修复。

### Medium

- **M1 审计出口丢弃 `data`**（`desktop-host.ts` `finish`）：拒绝路径只留 `reason`，成功路径 `audit.record` 也不含结果摘要，事后无法从审计复原「返回了什么」。
- **M2 `file.read` 分块缓冲固定 4096 字节**（`capabilities/file.ts`）：大 `limit` 下循环次数偏多，且未按 `limit` 调整缓冲，属性能次优。
- **M3 `file.stat` 对目录返回 `createdAt/…` 语义混用**：目录场景字段名沿用文件语义，消费方易误读。
- **M4 `web-engine` 单次读取失败即 `continue`**：`readLastMessage` 返回 null 时静默跳过，读失败与「无新内容」不可区分，排障困难。
- **M5 `agent-loop` 空内容判定**：循环因 `stopFlag` 提前 break 时 `result` 可能仍是首轮结果，`!result.content` 分支的错误文案（「页面未连接或回复为空」）与实际原因（用户主动停止）不符。

### Info

- **I1** `DEFAULT_EXECUTION = 'page'` 作为缺省是危险默认值；虽已在 `createToolRegistry` 归一化，但新增工具忘记写 `execution` 仍会落到页端派发。建议缺省改为显式必填或 `'host'` 侧告警。
- **I2** `.diag*.txt` / `.tail*.txt` / `tmp-*.mjs` 等 ~40 个调试产物散落在仓库根，未纳入 `.gitignore`，审计与打包噪音大。
- **I3** `docs/` 下 `architecture.md` 与 `architecture-review.md` 并存，且未覆盖 v0.6–v0.9 的契约层与工作区三档，文档与实现已脱节。

---

## 4. 设计上值得肯定的部分（避免误伤）

- 授权先于执行：`executeTool` 先 `consume` 一次性 grant，全拒绝分支统一走 `finish()` 留痕。
- 宿主/页端隔离：`routeExecution` 把 `executionSide==='host'` 判定放在「有页就派发」之前，且有专门测试（「页端若声称能执行 shell.exec，宿主也不会把命令交给它」）背书。
- 工作区边界：`contains` 对已存在目标做 realpath 二次校验，堵住符号链接越狱；未配置工作区时文件能力整体 fail-closed。
- shell 红线：`shell:false` + 引号切分 + 显式拒绝管道/重定向，`full` 档也不开解释器。
- 契约层与 SSE 提取器的注释质量高，历史修复（F3/F4/F8）都有明确记录，便于回溯。

---

## 5. 方法论反思

1. **绿色测试 ≠ 正确性。** 201 个用例全绿，但 C1/C2/C3 全部落在「单元测试直接调用能力、绕过契约映射」的盲区。建议引入**契约一致性测试**：以「上游工具定义」为输入，断言「映射后的参数键集 ⊆ 能力识别键集」，让字段错配在 CI 阶段就暴露。
2. **静态扫描只能当线索。** 本次 C3 的运算符优先级，靠肉眼通读才发现；单纯 grep `'pwsh'` 只会得到一行「看起来正常」的代码。需要的是「可疑构造清单」（无括号的 `&&`/`||` 混用、`[^<]` 类否定字符类、`pending` 集合的 close 清理）而非关键词匹配。
3. **跨进程接缝是缺陷富集区。** 6 个 Critical 全部位于「宿主↔页端↔模型」的边界。建议为每条接缝建立「断线/超时/重连」的故障注入用例，而不是只测 happy path。
4. **假成功比报错更贵。** C6 的 `{ok:true}` 无数据、C1 的「成功返回错误内容」，都会让上层陷入沉默的退化。应把「成功必须携带可判定的数据」写成不变式并在能力层断言。
5. **可复用的审计资产沉淀方向**：契约一致性测试、接缝故障注入矩阵、pending 集合生命周期检查、注释与实现漂移扫描（对比 F 编号修复声称与当前代码）。

---

## 6. 建议的修复顺序

1. C1（契约续读映射）— 影响面最广、修复成本最低。
2. C4（断线清 pending）— 稳定性根因，防止长跑退化。
3. C2 / C3（正则与优先级）— 各一行级修复。
4. C5（双循环收敛）— 需设计决策，建议先禁用页面侧自动续跑。
5. C6 / H1–H4 — 契约补全与注入面收敛。
6. M / I 级 — 随迭代清理。

---

## 附录：核查证据索引

- 契约：`src/shared/tool-contract.ts:36-39`（`local_file_read` adapt 仅保留 path）
- 能力：`src/capabilities/file.ts`（`offset`/`limit` 语义与默认值）
- 纠偏：`src/host/agent-loop.ts:33,102`（`RAW_TOOL_TAG_RE` 与 `toolCalls===0` 判定）
- shell：`src/capabilities/shell.ts`（CMD_BUILTINS 注入、PowerShell 判定、`shell:false`、`clampTimeout`）
- 接缝：`src/host/page-runtime.ts`（`tool-call` 映射执行、`ws.on('close')` 仅删 clients）
- 传输：`src/desktop/host-client.ts`（`sendToolCall` 30s 超时、`onclose` 仅重连）
- 编排：`src/inject/main-world-interceptor.ts`（`MAX_LOOP=8`、`pending.length=0`、prompt 覆盖）
- 回退：`src/host/desktop-host.ts` `routeExecution`（`{ok:true, snapshot}` 无 data）
- 引擎：`src/host/engine/web-engine.ts`（完成检测依赖 data.messages）
- 基线：`npx tsc --noEmit` → 退出码 0；`npx vitest run` → 24 文件 / 201 用例通过
