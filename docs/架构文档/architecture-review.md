# 架构评审：设计缺口清单

> 评审对象：`docs/architecture.md` v0.1（2026-10-07）
> 评审依据：`deepseek-pp/src` 上游快照 `187f6227`（2026-10-08）源码实测
> 评审日期：2026-10-09

## 0. 结论

架构方向正确（core 跑 WebView JS 域、Rust 只做宿主、页面内 hook 为主）。但有 **3 个 P0 缺口会导致 D1~D3 返工**、**5 个 P1 缺口会让假设 A1/A3 失效**、**4 项数据/环境需校准**。文档 §10 的 U1 可立即结案（见 §3.1）。

---

## 1. P0：D1 之前必须定死

### 1.1 双 world 内容脚本模型在文档中完全缺失（§2.1 / §3.1 / §7）

**事实**：上游不是一个 content script，而是**两个**，跑在**不同 world**：

| 入口 | world | runAt | 职责 |
|------|-------|-------|------|
| `entrypoints/main-world.content.ts` | `MAIN` | `document_start` | 装 fetch/XHR hook（`core/interceptor/fetch-hook.ts`）、导航监听、桥控制器 |
| `entrypoints/content.ts` | isolated（默认 `document_idle`） | — | `chrome.*` 访问、DOM 适配、工具会话绑定、pet/floating-chat |

二者经 `window.postMessage` 通信，桥层是 `entrypoints/content/controllers/main-world-bridge-controller.ts` + `core/messaging/**`（3,352 行，含 `runtime-boundary.ts` 与 5 套 `*-runtime-request-codec.ts`）。真正的注入入口是 `core/entrypoints/content/lifecycle.ts` 的 `replaceContentDocumentLifecycle({ capabilities: [...] })`，不是单文件 `main()`。

桌面 WebView **只有一个 JS 域**，没有 isolated world。文档 §2.1 时序图只画了「① initialization_script → ③ content.js」，§7 目录里也只有 `src/content.js`，**main-world 那份和整个 MAIN↔isolated 桥都没有出现**。

**需决策**（三选一，建议 b）：

| 方案 | 做法 | 复用率 | 风险 |
|------|------|--------|------|
| a | 原样保留双 bundle + postMessage 桥 | 最高（core 零改） | 同域下 `window.postMessage` 可被页面伪造/监听，R2 加剧；消息序从微任务变宏任务，时序敏感路径（工具调用授权、RESTORE_TOOL_CALLS）可能变 |
| **b（推荐）** | 双 bundle 照常注入，仅把 `core/messaging/runtime-boundary.ts` 的传输实现换成同域直连 | 高（只改 1 个传输点） | 需保证 start/stop 生命周期仍隔离 |
| c | 合成单一 bundle | 低 | 破坏 capability 生命周期隔离，AGENTS.md「Content capabilities own explicit start/stop lifecycles」不变量受损 |

---

### 1.2 background 移植到哪一侧未定，且文档自相矛盾（§2.1 vs §3.3）

- §2.1 的 IPC 命令只列 `bridge_invoke` / `kv_*` / `nav_is_allowed` → 暗示 background 逻辑进 Rust。
- §3.3 又让 inline-agent loop 跑 JS 域并「调用 `DeepSeekTurnSubmitter`」，且 `chrome.runtime.sendMessage` 的接收端正是 background。

`entrypoints/background.ts` 有 42 处 `chrome.*`，`core/messaging` 有 5 套 runtime 编解码器；若进 Rust，这些全部要用 Rust 重写一遍（消息名/载荷/授权语义必须逐字一致），与「2 周」和「零修改」直接冲突。

**建议定值**：background 5,800 行**整体迁到 WebView 常驻 JS 域**（与 agent loop 同域，同域内 sendMessage 变成函数调用），Rust 只做它擅长的宿主：窗口、KV 落盘、HTTP API、shell/MCP stdio 宿主、导航白名单。这条不定，D2（桥接）和 D4（main.rs）会各做各的。

---

### 1.3 工具执行授权的 authority 没有归属（AGENTS.md 硬不变量）

AGENTS.md：*Every production tool execution must pass through the runtime authorization path before payload rehydration or provider execution. Page/model calls require a **background-owned grant** that binds the receiver-owned document/session, descriptor security snapshot, provider/mode/risk, request identity, and one-time call reservation.*

落地在 `core/tool/authorization-types.ts`（且授权态存 **`chrome.storage.session`**，不是 local —— 见 §3.2）。桌面没有 background SW，grant 由谁签发、谁校验、requestId 与 document 绑定怎么来，文档通篇未提。这是安全红线，不能拖到 D8。

**建议**：grant 签发者随 §1.2 走常驻 JS 后台；Rust 宿主**只校验 grant、不签发**，特权执行前做一次性 reservation 核销。

---

## 2. P1：会让假设 A1/A3 失效

### 2.1 `A3`（PoW WASM 页面域可直跑）**不成立**

`entrypoints/content.ts:4901`：`powWasmUrl: chrome.runtime.getURL(DEEPSEEK_POW_WASM_PATH)`。WASM 在 `public/deepseek/sha3_wasm_bg.wasm`，靠 manifest `web_accessible_resources`（限定 `*://chat.deepseek.com/*`）分发。桌面没有 `chrome-extension://` URL，也没有 WAR 授权机制。

**需设计**：改本地文件 / Tauri asset protocol / Rust 侧求解三选一；`chrome.runtime.getURL` 的返回值语义也要重新定义（见 §2.5）。

### 2.2 API 清单漏了 6 项真实依赖（§3.2.1）

实测 `core/**` + `entrypoints/**` 共引用 **24 个叶子 API**。文档 38 项清单**缺**：

| 缺失 API | 使用点 | 影响 |
|----------|--------|------|
| `chrome.storage.session.get/set` | `core/tool/authorization-types.ts:260,269` | 工具授权态；不是 local，桥要单独一轨 |
| `chrome.runtime.connectNative` + `Port` | `core/mcp/transports/native.ts:52,58` | MCP native 宿主；长连接 Port，不是普通 IPC |
| `chrome.permissions.contains/request` | `core/mcp/transports/transport-endpoint.ts:27,35` | MCP 连接前的 host 权限判定 |
| `chrome.identity.launchWebAuthFlow` | `core/sync/**`（GDrive/OneDrive OAuth） | 云同步，文档未提 |
| `chrome.sidePanel.open` | sidepanel 入口 | 桌面改为独立窗口，语义要重定义 |
| `chrome.debugger` | `core/browser-control/cdp.ts`（模块 1,914 行） | 文档标「不做」，但它是真实功能；桌面 WebView **无法 attach 用户 Chrome** → browser-control 需显式降级决策 |

另：`chrome.offscreen.createDocument/hasDocument` 被 `entrypoints/sandbox-offscreen/main.ts` 使用，文档标「不做」——需确认是「桌面不需要 offscreen」（成立）还是「功能砍掉」（不成立）。

### 2.3 IndexedDB 与 Rust KV 的分工未定义（§2.2 / §3.2）

`core/persistence/indexeddb.ts`（121 处）+ `core/artifact/store.ts`、`core/memory/store.ts`、`core/interceptor/history-idb-interceptor.ts` 走 IndexedDB；`core/sync` 有 6 个 payload + 恢复日志（`apply-journal.ts`）。文档只讲 `chrome.storage.local → Rust KV`。

**需定**：IndexedDB **留在 WebView**（随 profile 目录持久化，与 §3.4 / R1 同一风险面），只把 `chrome.storage.local`（+`session`）走桥到 Rust KV。否则 D5 会踩「一半数据在 Rust、一半在 IndexedDB」的迁移与一致性坑。

### 2.4 sandbox / pyodide 的 CSP 风险未列（新增风险 R11）

`sandbox-runner.html` 依赖 MV3 manifest 的 `sandbox` CSP：`script-src 'unsafe-eval' 'wasm-unsafe-eval'`、`worker-src blob:`（见 `wxt.config.ts:24-41`），pyodide 资产由 `wxt.config.ts` 的 `copyPyodideAssets` 注入。桌面把这些注入到 **chat.deepseek.com 自己的页面域**，页面 CSP 可能禁 `eval`/`wasm-unsafe-eval`/`worker-src blob:` → pyodide 与 sandbox 直接起不来。

**建议**：sandbox 承载到**独立 WebView 窗口**（自有 CSP），而不是注入页面域。这条会影响 D8 排期。

### 2.5 `chrome.runtime.getURL` 返回值语义需重定义

`content.ts` 用它取 3 类资源：PoW WASM、pet sprite（`PET_SPRITE_PATH`）、sidepanel.html（`chat-launcher.ts:52`，floating-chat 要 iframe 它）。桌面没有扩展包，返回值必须改成可加载的 URL（本地 HTTP / asset protocol / 独立窗口）。清单里标了 ✅，但**语义变了**，属「适配」而非「已实现」。

---

## 3. P2：数据与环境校准

### 3.1 U1 可结案：content 侧只用 6 个叶子 API

实测 `entrypoints/content.ts` + `entrypoints/content/**`：

```
chrome.runtime.sendMessage / onMessage / id / getURL
chrome.storage.local.get / set / remove
chrome.storage.onChanged.addListener / removeListener
```

全部在文档 ✅ 清单内 → **假设 A1 成立**，`content.ts「零修改」可行（除 getURL 语义，见 §2.5）`。

### 3.2 §6.2 行数与真实代码偏差较大，复用率 73.6% 需重算

| 模块 | 文档 | 实测（.ts/.tsx 行数） |
|------|------|----------------------|
| `core/deepseek` | 9,800 | 2,663 |
| `core/inline-agent` | 6,400 | 4,849 |
| `core/tool` + `core/mcp` | 11,200 | 4,287 + 5,205 = 9,492 |
| `core/interceptor` | **未列** | 4,587 |
| `core/messaging` | **未列** | 3,352 |
| `entrypoints` 合计 | 16,300 | **32,375** |
| src 总计 | 91,000 | ≈81,000（core 49k + entrypoints 32k） |

`core/interceptor` + `core/messaging`（7,939 行）是桌面化冲击最大的两块，却没进复用矩阵 —— 这是复用率估算最可能的失分点。

### 3.3 端口 8765 已被本机 DeskPilot 占用

建议改为 `8756`（或首次启动探测可用端口后写进配置）。

### 3.4 §4 独立模式应拆两级，降低 R9/R10

项目**已有** `core/deepseek/official-api.ts` + `core/inline-agent/pi/official-api-provider.ts`（OpenAI 兼容官方 API 后端）。

| 级别 | 后端 | 风险 | 排期 |
|------|------|------|------|
| 4.2.2a | 复用 official-api provider | 无风控、无接口漂移 | 一期可做（≈2 天） |
| 4.2.2b | 自建私有接口客户端（PoW/SSE/指纹/节流） | R9 风控 + R10 接口漂移 | 二期，且应默认关 |

§5 的 `/api/v1/agent/run` 一期应接 4.2.2a，而不是 4.2.2b。

### 3.5 U2 建议定值：拷贝快照 + 单向同步

已按此执行，见 `deepseek-pp/UPSTREAM.md`（commit `187f6227`，约定 `core/**` 在本仓库零修改）。

---

## 4. 新增风险项（建议并入 §9）

| ID | 风险 | 等级 | 缓解 |
|----|------|------|------|
| R11 | 页面 CSP 禁 eval/wasm → pyodide/sandbox 不可用 | 中 | sandbox 承载到独立 WebView 窗口（§2.4） |
| R12 | 单 JS 域下 MAIN↔content 桥可被页面伪造（`postMessage`） | 中 | 采用 §1.1 方案 b，桥走同域直连不走 postMessage |
| R13 | `chrome.storage.session` 语义（会话级、重启清空）在 Rust KV 里无对应 | 中 | 授权态单独一轨：进程内 + 不落盘 |
| R14 | browser-control（`chrome.debugger`）在桌面无 attach 目标 | 低 | 一期显式禁用并在 UI 标注，不做静默失败 |

---

## 5. D1 之前建议插入的 0.5 天

1. 定 §1.1（桥方案）、§1.2（background 侧）、§1.3（grant 签发者）—— 三条一起定，互相耦合。
2. 用本文 §3.1/§2.2 的实测清单替换文档 §3.2.1 的估算表（24 个叶子 API，6 项缺失）。
3. 更新 §6.2 复用矩阵（补 `core/interceptor`、`core/messaging`，校正行数）。
4. 把 R11~R14 并入 §9，把 §10 的 U1 标为已结案、U2 标记为已定。
