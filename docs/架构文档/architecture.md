# DeepSeek++ Studio 架构设计文档

> 版本：v0.1（2026-10-07）
> 产品：DeepSeek++ Studio（浏览器化桌面应用）
> 基于：deepseek-pp（MV3 浏览器扩展）+ MiMo 架构设计 + 混合架构增强

---

## 1. 项目概述

### 1.1 产品定位

DeepSeek++ Studio 是 deepseek++ 浏览器扩展的桌面化形态，基于 **Tauri + WebView + 注入脚本** 混合方案构建。目标是在保留 deepseek++ 核心体验的同时，摆脱 MV3 浏览器扩展的沙箱和 Service Worker 回收限制，解锁后台常驻、外部 agent 调用、本地工具执行等能力。

### 1.2 核心目标

| 目标 | 说明 |
|------|------|
| 核心业务逻辑零修改复用 | `src/core/**` 与 `src/entrypoints/content.ts` 不修改，复用率 ≥70% |
| 消除 MV3 限制 | SW 回收、消息延迟、沙箱限制、存储配额 |
| 外部 agent 可调用 | 本地 HTTP API 服务器，workbuddy 等外部 agent 可调用 |
| 后台常驻运行 | 7x24 小时 agent 任务、文件监听、定时任务 |
| 开发成本可控 | 从 2 个月降到 2 周（10 个工作日） |

### 1.3 非目标

- 不做通用浏览器（地址栏、书签、历史、多站点）
- 不做扩展商店/扩展安装系统
- 不修改 deepseek-pp 的 `src/core/**` 核心业务逻辑
- 不新增 npm 依赖（Tauri 官方包除外）

---

## 2. 总体架构

### 2.1 进程模型

```
┌────────────────────────────── Tauri 主进程（Rust，常驻） ──────────────────────────────┐
│  窗口管理 / WebView 创建（含 initialization_script）                                    │
│  IPC 命令：bridge_invoke（信封路由）、kv_*（chrome.storage 后端）、nav_is_allowed        │
│  本地 HTTP API 服务器：localhost:8765（外部 agent 调用）                                │
│  平台服务：MCP stdio 子进程宿主、shell 宿主、资源读取、剪贴板、通知、系统托盘            │
│  独立模式：DeepSeek 私有接口客户端（PoW 求解、请求构造、SSE 解析）                      │
└───────────────▲───────────────────────────────────────────────────▲──────────────────┘
                │ tauri invoke / event（0.5~3ms RTT）                │
┌───────────────┴────────────────────── WebView（JS 域）─────────────┴──────────────────┐
│  ① initialization_script（document_start）                                             │
│     installChromeShims() → installRequestHooks() → loader.install()                    │
│  ② 页面脚本（DeepSeek 自身） —— 其 fetch hook 在 ① 之后安装                            │
│  ③ content.js（document_idle 注入，与 MV3 content script 同语义）                       │
│  ④ inline-agent pi loop（同域运行，调用 DeepSeekTurnSubmitter）                         │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 进程模型对位（MV3 → 桌面）

| 维度 | MV3 现状 | 桌面方案 | 变化点 |
|------|---------|---------|--------|
| 进程模型 | SW（30s 回收） | Tauri 主进程常驻 + WebView JS 域常驻 | 消除冷启动 |
| 页面注入 | 浏览器自动注入 | initialization_script（document_start）+ document_idle 注入 content.js | 注入时机可控 |
| 消息传递 | `chrome.runtime.sendMessage` | 同名 API 桥接（同域 0 IPC / 跨域 IPC 0.5~3ms） | 语义保持，延迟降低 |
| 持久化 | `chrome.storage.local`（10MB 配额） | Rust KV（原子写 JSON 文件，接口面向 SQLite 平滑升级） | 无配额限制 |
| 工具执行 | SW / offscreen | JS 域调度 + Rust 受控宿主 | 权限更大，需 allowlist |
| 登录态 | 共享浏览器 cookie | WebView profile 目录持久化 | 独立管理 |
| 外部调用 | 不可能（扩展不能监听端口） | 本地 HTTP API（localhost:8765） | 解锁外部 agent 调用 |
| 代码复用率 | 100% | **73.6% 零修改** / 86% 含适配 | 见 §6 |

---

## 3. 核心模块设计

### 3.1 注入脚本加载器（`src/inject/loader.ts`）

#### 3.1.1 注入时机

使用 WebView 的 **initialization script**（等价 `document_start`）：
- Windows：WebView2 `AddScriptToExecuteOnDocumentCreated`
- macOS：`WKUserScript atDocumentStart`
- Linux：WebKitGTK `WebKitUserScript` at document start

initialization script 是文档创建后、解析器执行任何 `<script>` 之前**同步执行**的第一段脚本，时序上不存在「页面脚本先跑」的窗口。

#### 3.1.2 精确时序图

```
   t0            t1                  t2                    t3                t4
 导航开始 ──► 文档创建 ───────────► 初始化脚本执行 ───────► 页面 <script> ───► DOMContentLoaded
   │             │        （同步，早于解析器）               （DeepSeek）         │
   │             │             │                              │                  │
   │             │   installChromeShims()                     │   其 fetch hook   │
   │             │   installRequestHooks() ★ 装 fetch/XHR hook│   在 ★ 之后安装   │
   │             │   history patch + 导航监听                 │                  │
   │             │   loader.install() → state='armed'         │                  │
   │             │                                            │        loader.ensureInjected()
   │             │                                            │        → 执行 content.js
   │             │                                            │        （document_idle 语义）
   │             │                                            │                  │
   └─────────────┴────────────────────────────────────────────┴──── t5 load / SPA 导航
                                                                               handleNavigation()
                                                                               → generation+1，按需重注入
```

#### 3.1.3 关键特性

- **幂等**：`Symbol.for('deepseek-studio.injection-loader')` 全局标记 + 代数（generation）计数，重复 `install()` 不会二次注入
- **SPA 导航**：patch `history.pushState/replaceState` + `popstate`/`hashchange` → `handleNavigation()`；`reinjectOnSpaNavigation` 默认 false，开启时受 `maxSpaReinjections`（默认 8）限流
- **整页导航**：全局对象被销毁，initialization script 由 WebView 自然重跑，形成新一代 loader
- **失败路径**：origin 不在白名单 → `state='skipped'`（fail-closed，不注入）；内容脚本抛异常 → `state='failed'`
- **运行时断言**：`verifyInstallOrder()` 检查 `readyStateAtInstall === 'loading'`，异常时 fail-open 告警

### 3.2 MV3 API 桥接层（`src/bridge/runtime.ts`）

#### 3.2.1 API 清单

共 **38 个叶子 API**，骨架实现 27 个（≈1,330 行），全部 shim 完成约 **3,700 行**。

| # | API | 难度 | 估算行数 | 状态 |
|---|-----|------|---------|------|
| 1 | `chrome.runtime.sendMessage` | 中 | 220 | ✅ 已实现 |
| 2 | `chrome.runtime.onMessage` | 中 | 180 | ✅ 已实现 |
| 3 | `chrome.runtime.id` / `getURL` | 易 | 40 | ✅ 已实现 |
| 4 | `chrome.runtime.getManifest` | 易 | 20 | ✅ 已实现 |
| 5 | `chrome.storage.local.get/set/remove/clear` | 中 | 260 | ✅ 已实现 |
| 6 | `chrome.storage.local.getBytesInUse` | 易 | 40 | ✅ 已实现 |
| 7 | `chrome.storage.local.onChanged` | 易 | 40 | ✅ 已实现 |
| 8 | `chrome.storage.onChanged` | 易 | 30 | ✅ 已实现 |
| 9 | `chrome.tabs.query/get` | 中 | 120 | ✅ 已实现 |
| 10 | `chrome.tabs.sendMessage` | 中 | 80 | ✅ 已实现 |
| 11 | `chrome.tabs.create/update` | 中 | 60 | ✅ 已实现 |
| 12 | `chrome.tabs.onUpdated/onRemoved` | 易 | 80 | ✅ 已实现 |
| 13 | `chrome.i18n.getMessage/getUILanguage` | 易 | 90 | ✅ 已实现 |
| 14 | `chrome.contextMenus.create/update/remove/removeAll` | 中 | 160 | ✅ 已实现 |
| 15 | `chrome.contextMenus.onClicked` | 易 | 30 | ✅ 已实现 |
| 16 | `chrome.runtime.onConnect` + `Port` | 难 | 320 | 需适配 |
| 17 | `chrome.runtime.onInstalled/onStartup` | 易 | 40 | 需适配 |
| 18 | `chrome.scripting.executeScript/insertCSS` | 中 | 180 | 需适配 |
| 19 | `chrome.action.*` | 易 | 90 | 需适配 |
| 20 | `chrome.commands.onCommand` | 易 | 50 | 需适配 |
| 21 | `chrome.notifications.create` | 易 | 100 | 需适配 |
| 22 | `chrome.webNavigation.*` | 难 | 300 | 需适配 |
| 23 | `chrome.alarms` | 难 | 200 | 需适配 |
| 24 | `chrome.cookies.*` | 难 | 500 | 不做（WebView cookie jar 直管） |
| 25 | `chrome.storage.sync` | 难 | 400 | 不做（复用 core 的 WebDAV/GDrive/OneDrive 同步） |
| 26 | `chrome.offscreen.*` | 难 | 450 | 不做（PoW WASM 直接在页面或 Rust 执行） |
| 27 | `chrome.storage.managed` | 难 | 120 | 不做（桌面无企业策略面） |
| 28-38 | `chrome.debugger/downloads/history/...` | — | 0 | 不做（非 DeepSeek 容器所需） |

#### 3.2.2 桥接层设计原则

- **位于 `chrome.*` 之下，core 之上**：core 看到的仍是 `chrome.runtime.*` / `chrome.storage.local.*`
- **禁止 import `src/core/**` 的实现**：只在测试中做类型对齐，避免反向依赖
- **双模语义**：Promise / 回调双模，`lastError` 语义与 MV3 一致
- **fail-closed / fail-open 矩阵**：见 §3.6

### 3.3 agent loop 进程归属

#### 3.3.1 决策：WebView JS 域

agent loop（inline-agent）跑在 **WebView JS 域**（与现有 `src/core` 同域），特权工具（shell/MCP 子进程、文件、剪贴板）经 IPC 交 Rust 宿主。

#### 3.3.2 方案对比

| 维度 | 方案 A：WebView JS 域 | 方案 B：Tauri 主进程（Rust） |
|------|----------------------|------------------------------|
| 单次消息延迟 | **<0.01ms**（同域函数调用） | invoke RTT 0.5~3ms；一轮 loop 平均 8~20 次工具往返 → 每轮多 10~60ms |
| 代码复用率 | **86%**（`src/core` 零修改） | ≈40%（pi loop、SSE 解析、prompt 序列化、XML 工具解析全部要移植） |
| prompt-bytes 不变量 | **保持**（直接调用 `DeepSeekPromptSerializer`） | 需在 Rust 重写序列化器 → 极易漂移，**致命** |
| 权限 | 受 WebView 域限制，特权操作走 IPC | 原生权限大（需自行收权） |
| 风险 | 页面可篡改同域对象；WebView 崩溃即 loop 崩溃 | 双实现长期漂移；2 周不可达 |

**决策理由**（按权重）：
1. 零修改约束（`src/core` 是 TS）
2. prompt-bytes 不变量只有同域能无损保持
3. 延迟更低
4. 2 周排期成立

B 作为「工具执行宿主」部分保留（Rust 只做受控执行，不做 loop）。

### 3.4 登录态管理

#### 3.4.1 方案：WebView 原生 cookie jar + 固定 profile 目录

依靠 WebView 原生 cookie jar + 固定 profile 目录 + 显式失效恢复流程。不做 cookie 导入导出（`chrome.cookies` 不实现）。

#### 3.4.2 存储路径

- Windows：`%APPDATA%/deepseek-studio/webview-profile/`（WebView2 `EBWebView/`）
- macOS：`~/Library/Application Support/deepseek-studio/webview-profile/`（WKWebView `WebsiteData`）
- Linux：`~/.local/share/deepseek-studio/webview-profile/`（WebKitGTK `WebsiteDataManager`）

#### 3.4.3 跨会话保持

- profile 目录不清空（固定路径）
- 会话心跳校验：启动时探活登录态，失效则显式重登流程
- macOS 注意：WKWebView 默认非持久 store，需显式指定 data store（风险 R1）

### 3.5 网络拦截

#### 3.5.1 决策：保留页面内 fetch hook 为主

**保留页面内 fetch hook 为主**（零修改复用、语义与扩展一致、prompt bytes 不变），WebView 级 `WebResourceRequested` 仅做：
- 安全兜底（origin 白名单 fail-closed）
- 观测（fail-open，记录请求日志）

#### 3.5.2 方案对比

| 维度 | 页面内 fetch hook | WebView 级请求拦截 |
|------|------------------|-------------------|
| 代码复用 | 零修改复用现有 hook | 需重新实现 |
| prompt-bytes 不变量 | 保持（与扩展完全一致） | 可能漂移 |
| 语义保真度 | 高（与页面行为一致） | 中（平台差异大） |
| 实现复杂度 | 低 | 高（Windows/macOS/Linux 行为不同） |
| 安全性 | 页面可篡改 hook | 更安全（页面无法篡改） |

### 3.6 失败 / 降级语义（fail-open / fail-closed 矩阵）

| 场景 | 语义 | 理由 |
|------|------|------|
| 注入 origin 不在白名单 | **fail-closed**：不注入 | 防止在非 DeepSeek 页面执行特权脚本 |
| 导航/请求到非白名单 origin | **fail-closed**：拦截 | 同上 |
| `sendMessage` 无监听者 | **fail-closed**：`MESSAGE_PORT_CLOSED` | 与 MV3 一致，避免静默丢消息 |
| 存储值不可序列化 | **fail-closed**：`DATA_CLONE`，不写入 | 防止静默丢字段 |
| 存储超配额 | **fail-closed**：`QUOTA_*`，全量不写 | 与 MV3 配额语义一致 |
| KV 持久化失败 | **fail-closed**：内存不更新，返回错误 | 保证内存与磁盘一致 |
| `parentMessageId === null` | **fail-closed**：拒绝工具调用 | 防止对话链分叉 |
| 注入顺序断言失败 | **fail-open**：告警 + 继续注入 | 保证可用性，问题可观测 |
| SPA 重注入超限 | **fail-open**：跳过 + 告警 | 防止无限注入 |
| token speed / 用量统计 | **fail-open**：丢弃本条 | 非关键路径 |
| `onChanged` 监听器抛异常 | **fail-open**：隔离，其余监听器继续 | 与 Chrome 一致 |

---

## 4. 混合架构（页面模式 + 独立模式）

### 4.1 设计动机

借鉴 [dsh-deepseek-web-login](https://github.com/cv-superding/dsh-deepseek-web-login) 的思路，在页面模式之外增加独立模式，用于：
- 后台任务（不依赖页面，无人值守）
- 外部 API 调用（本地 HTTP API 的后端）
- 页面崩溃时的降级方案

### 4.2 两种模式

#### 4.2.1 页面模式（默认）

```
Tauri 主进程 → WebView 加载 chat.deepseek.com → 注入脚本 → hook 页面 fetch
                                                          ↑
                                                    依赖页面，与 deepseek++ 扩展一致
```

- 用于：用户交互、页面内体验、UI 增强
- 优点：与 DeepSeek 网页完全融合，接口变化影响小，不违反服务条款
- 缺点：依赖 WebView，页面崩溃则功能失效

#### 4.2.2 独立模式（可选）

```
Tauri 主进程 → 独立客户端模块 → 自己构造 HTTP 请求 → 直接调用 chat.deepseek.com 私有 API
                      ↑
                完全不加载页面，自己就是客户端
```

- 用于：后台任务、外部 API 调用、页面降级
- 优点：不依赖页面，可后台无人值守，可作为标准化 LLM provider
- 缺点：依赖 DeepSeek 私有接口（接口变了要改），有风控风险，工具调用需提示词协议模拟

#### 4.2.3 独立模式核心组件

| 组件 | 说明 | 借鉴来源 |
|------|------|---------|
| 登录态捕获 | Electron/Tauri 窗口登录一次，捕获 Authorization、cookie、反爬头 | dsh-deepseek-web-login |
| PoW 求解 | `create_pow_challenge` + SHA3 WASM `wasm_solve` | dsh-deepseek-web-login |
| 请求构造 | 自己拼 `POST /api/v0/chat/completion` | dsh-deepseek-web-login |
| SSE 解析 | 解 `response/fragments`，分思考与正文通道 | dsh-deepseek-web-login + deepseek-pp 现有解析器 |
| 工具调用 | 提示词 JSON 协议 + 流式过滤器 | dsh-deepseek-web-login |
| 网络栈指纹 | Tauri `reqwest` + rustls 配置，TLS/HTTP2 指纹与浏览器一致 | dsh-deepseek-web-login（Electron net.fetch） |
| 请求节流 | 串行 + 随机间隔（2000~4000ms），防并发 | dsh-deepseek-web-login |
| 会话卫生 | 临时会话 + 攒批清理，防机器行为特征 | dsh-deepseek-web-login |

### 4.3 模式切换

- **默认**：页面模式（用户交互场景）
- **后台任务**：自动切换独立模式（用户无感知）
- **外部 API**：独立模式（本地 HTTP API 的后端）
- **页面崩溃降级**：自动切换独立模式（fail-over）

---

## 5. 本地 HTTP API 服务器

### 5.1 设计目标

让外部 agent（如 workbuddy）可以通过标准 HTTP 接口调用 DeepSeek++ Studio 的能力，包括：
- 运行 agent 任务（工具调用、多轮推理）
- 单次聊天补全
- 流式输出（SSE）
- 会话管理

### 5.2 服务器配置

- 监听地址：`http://localhost:8765`
- 鉴权：本地 token（首次启动生成，存于配置文件）
- 并发：默认串行（防 DeepSeek 风控），可配置
- CORS：仅允许 `localhost` / `127.0.0.1`

### 5.3 API 端点（初步设计）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/chat/completions` | POST | 单次聊天补全（兼容 OpenAI 格式） |
| `/api/v1/agent/run` | POST | 运行 agent 任务（含工具调用） |
| `/api/v1/agent/stream` | POST | 运行 agent 任务（SSE 流式输出） |
| `/api/v1/sessions` | GET | 列出会话 |
| `/api/v1/sessions/:id` | GET | 获取会话详情 |
| `/api/v1/sessions/:id` | DELETE | 删除会话 |
| `/api/v1/tools` | GET | 列出可用工具 |
| `/api/v1/status` | GET | 服务状态（登录态、模型、队列） |
| `/api/v1/models` | GET | 可用模型列表 |

### 5.4 请求/响应格式（示例）

#### 运行 agent 任务

```json
POST /api/v1/agent/run
{
  "task": "分析这段代码的性能问题",
  "context": "function foo() { ... }",
  "tools": ["shell", "file_read", "web_search"],
  "model": "deepseek-chat",
  "stream": false
}

Response:
{
  "id": "task_abc123",
  "status": "completed",
  "result": "这段代码存在以下性能问题...",
  "tool_calls": [
    {"name": "shell", "args": {"command": "node --prof"}, "result": "..."}
  ],
  "tokens": {"input": 1200, "output": 800},
  "duration_ms": 15300
}
```

#### 流式输出（SSE）

```
POST /api/v1/agent/stream
Accept: text/event-stream

data: {"type": "status", "status": "thinking"}
data: {"type": "text", "delta": "这段代码"}
data: {"type": "text", "delta": "存在性能问题"}
data: {"type": "tool_call", "name": "shell", "args": {...}}
data: {"type": "tool_result", "name": "shell", "result": "..."}
data: {"type": "done", "result": "完整结果..."}
```

---

## 6. 代码复用率分析

### 6.1 总体复用率

91,000 行中：
- **零修改复用：67,000 行（73.6%）** ≥ 70% 达标
- 适配：14,000 行（15.4%）
- 重写：10,000 行（11.0%）
- `src/core/**` 零修改率：**100%**（由约束保证）

### 6.2 按模块复用矩阵

| 模块 | 现有行数 | 复用方式 | 桌面动作 |
|------|---------|---------|---------|
| `src/core/deepseek`（SSE/流解析/prompt 序列化） | 9,800 | **零修改** | 无 |
| `src/core/inline-agent`（pi loop 适配层） | 6,400 | **零修改** | 无 |
| `src/core/tool` + `src/core/mcp` | 11,200 | 零修改（逻辑） | 传输层换桥；MCP stdio 宿主迁 Rust |
| `src/core/skill\|memory\|project\|saved-items` | 9,600 | **零修改** | 存储后端换桥 |
| `src/core/chat\|usage\|voice\|multimodal\|sandbox\|artifact` | 8,900 | **零修改** | sandbox 执行换 IPC |
| `src/core` 其他（types/i18n/platform/prompt） | 6,500 | **零修改** | 无 |
| `src/entrypoints/content.ts` | 3,100 | **零修改** | 注入方式变（document_start → document_idle） |
| `src/entrypoints/background` | 5,800 | 适配 4,200 / 重写 1,600 | SW 生命周期 → Tauri 事件 |
| `src/entrypoints/popup\|options\|sidepanel` | 7,400 | 适配 5,000 / 重写 2,400 | 窗口入口替换 |
| `src/components` + 样式 | 13,300 | 适配 8,000 / 重写 2,000 | 打包为侧栏窗口 |
| `src/lib` + utils | 5,000 | 零修改 3,500 / 适配 1,500 | `chrome.*` 调用点走桥 |
| 构建/脚本/测试基建 | 4,000 | **重写** | WXT → Vite + tauri CLI |
| **合计** | **91,000** | **零修改 67,000（73.6%）** | |

### 6.3 桌面新增代码（约 9,600 行）

| 模块 | 行数 | 说明 |
|------|------|------|
| bridge（MV3 API 桥接层） | 3,700 | 27 个骨架已实现 1,330，补齐 2,370 |
| inject/loader.ts（注入加载器） | 700 | document_start 注入、幂等、导航重注入 |
| Rust 主进程（main.rs + 模块） | 2,200 | 窗口、IPC、KV、HTTP API、独立模式 |
| 构建/窗口/入口 | 1,000 | Tauri 配置、Vite 配置、窗口管理 |
| 测试 | 2,000 | 桥接层测试、loader 测试、契约测试 |
| **合计** | **约 9,600** | 这就是「2 周」要写的东西 |

---

## 7. 项目目录结构

```
E:\NAS\deepseek-studio\
├── src-tauri\                    # Rust 主进程
│   ├── src\
│   │   ├── main.rs              # 入口：窗口创建、initialization_script、IPC 注册
│   │   ├── bridge.rs            # IPC 命令：bridge_invoke（信封路由）
│   │   ├── kv_store.rs          # chrome.storage 后端：BTreeMap + 原子写 JSON
│   │   ├── http_api.rs          # 本地 HTTP API 服务器（localhost:8765）
│   │   ├── independent_client.rs # 独立模式：DeepSeek 私有接口客户端
│   │   │   ├── pow.rs           # PoW 求解（SHA3 WASM）
│   │   │   ├── request.rs       # 请求构造
│   │   │   ├── sse.rs           # SSE 流解析
│   │   │   └── throttle.rs      # 请求节流 + 会话卫生
│   │   ├── tool_host.rs         # 工具执行宿主：shell、文件、MCP stdio
│   │   └── nav.rs               # 导航白名单 + WebResourceRequested 兜底
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src\                          # WebView JS 域
│   ├── inject\
│   │   └── loader.ts            # 注入加载器：document_start、幂等、SPA 导航
│   ├── bridge\
│   │   ├── runtime.ts           # chrome.runtime 桥接（sendMessage/onMessage/...）
│   │   ├── storage.ts           # chrome.storage 桥接（local.get/set/...）
│   │   ├── tabs.ts              # chrome.tabs 桥接
│   │   ├── i18n.ts              # chrome.i18n 桥接
│   │   ├── context_menus.ts     # chrome.contextMenus 桥接
│   │   └── index.ts             # 统一 installChromeShims()
│   ├── independent\             # 独立模式 JS 侧（可选，用于页面内调用独立客户端）
│   │   └── client.ts
│   └── content.js               # 从 deepseek-pp 构建产物同步（零修改）
├── deepseek-pp\                 # 原 deepseek-pp 仓库（作为 submodule 或拷贝）
│   └── src\                     # 核心业务逻辑（零修改复用）
│       ├── core\                # inline-agent、tool、deepseek、...
│       └── entrypoints\
│           └── content.ts       # 构建后同步到 src/content.js
├── docs\
│   └── architecture.md          # 本文档
├── tests\
│   ├── desktop\
│   │   ├── runtime-bridge.test.ts
│   │   ├── loader.test.ts
│   │   ├── api-inventory.test.ts
│   │   └── desktop-contracts.test.ts
│   └── http-api\
│       └── endpoints.test.ts
├── package.json
├── vite.config.ts
└── README.md
```

---

## 8. 开发排期

### 8.1 目标：2 周（10 个工作日）

前提是 §8.3 的 6 条假设全部成立；任一不成立回落 3~5 周。

### 8.2 周 1（D1–D5）：地基 + 注入链路

| 日 | 交付物 | 风险点 |
|----|--------|--------|
| D1 | 仓库骨架（`src-desktop/`）、`tauri.conf.json`、构建管线（Vite 打包 `inject.js`/`content.js`） | WXT 产物改造（假设 A5） |
| D2 | `bridge/runtime.ts`：runtime + storage 五个核心 API，双模语义 + 测试 | `lastError` 语义对齐 |
| D3 | `inject/loader.ts`：document_start 注入、幂等、导航重注入 + 测试 | 注入竞态 |
| D4 | `main.rs`：窗口、initialization_script、`bridge_invoke`、`kv_*`、`nav_is_allowed` | 三平台 WebView data dir（假设 A2） |
| D5 | 登录态打通（三平台 profile 持久化 + 心跳） | WKWebView 非持久 store（R1） |

### 8.3 周 2（D6–D10）：业务回灌 + 收口

| 日 | 交付物 | 风险点 |
|----|--------|--------|
| D6 | `content.ts` 在桌面跑通首条消息（fetch hook + SSE 流） | 平台网络差异 |
| D7 | inline-agent loop 跑通（含 `DeepSeekTurnSubmitter`） | prompt-bytes 不变量回归 |
| D8 | 工具执行：shell/MCP 宿主迁 Rust，`ToolExecutionRecord` 回填 | 权限与 allowlist |
| D9 | UI 窗口化（sidepanel/popup/options → Tauri 窗口）、i18n、主题 | 组件层适配量（A4） |
| D10 | 三平台回归、打包、崩溃恢复、文档 | 公证/签名（若需要，属 A6） |

### 8.4 达成 2 周的 6 条假设

1. **A1**：`src/entrypoints/content.ts` 对 `chrome.*` 的依赖只覆盖已实现的 27 个叶子 API（或缺项≤3 个易级 API）
2. **A2**：目标三平台的 WebView cookie 持久化可由 data directory 直接控制（macOS 需确认 wry 的 data store 参数）
3. **A3**：PoW WASM 可在页面域直接跑（`powWasmUrl` 已具备），不需要 offscreen
4. **A4**：`src/components` 只需换窗口容器，不改交互（估算适配 8,000 行以内）
5. **A5**：构建管线可在 1 天内从 WXT 切到 Vite + tauri CLI，且 core 产物字节一致（prompt-bytes 校验通过）
6. **A6**：不需要代码签名/公证/自动更新（否则 +3~5 天）

### 8.5 后续迭代（二期）

| 功能 | 估算 | 说明 |
|------|------|------|
| 本地 HTTP API 服务器 | 1 周 | 外部 agent 调用接口 |
| 独立模式（DeepSeek 私有接口客户端） | 2 周 | 后台任务、页面降级 |
| 多标签支持 | 2~3 周 | 多 WebView 窗口管理 |
| MCP 服务器 | 1 周 | 接入 MCP 生态 |
| 系统托盘 + 全局快捷键 | 0.5 周 | 系统级集成 |
| 自动更新 + 代码签名 | 1 周 | 发布工程 |

---

## 9. 风险清单

| ID | 风险 | 等级 | 影响 | 缓解 |
|----|------|------|------|------|
| R1 | macOS WKWebView 默认非持久 store，登录态跨会话丢失 | 高 | 每次启动重登 | D5 显式指定 data store；心跳校验；把「登录态保持」列为发布门槛 |
| R2 | 无隔离域：页面脚本可读写我们的 `chrome` 桩与 fetch hook | 中 | 页面可绕过拦截 | initialization script 抢先 + `Object.defineProperty` 冻结关键属性 + 运行时完整性探测 |
| R3 | WebView2 cookie DB 用 DPAPI，不可迁移 | 中 | 换机需重登 | 文档明示；不做 cookie 抽取 |
| R4 | 后台节流：最小化时定时器/SSE 可能被暂停 | 中 | agent loop 卡顿 | 关闭 backgroundThrottling；工具执行挪 Rust 侧 |
| R5 | 三平台 WebView 行为差异（注入时机、cookie、导航事件） | 高 | 隐性回归 | 每平台最小冒烟矩阵（D10）；`verifyInstallOrder()` 运行时自检 |
| R6 | `src/core` 内残留 `chrome.*` 调用超出 Q2 清单（假设 A1 不成立） | 高 | 运行时缺 API | D2 之前先做静态扫描（grep `chrome.`）核对清单；缺口走「需适配」项 |
| R7 | prompt-bytes 因打包/压缩链路漂移 | 高 | 输出行为改变（AGENTS.md 不变量） | 构建后做字节级校验测试（`desktop-contracts.test.ts`） |
| R8 | 单 WebView 崩溃即整个应用失效 | 中 | 用户感知差 | Rust 侧监听 webview crash 事件 → 自动重建窗口 + 恢复会话状态 |
| R9 | 独立模式风控：DeepSeek 检测到非官方客户端行为 | 中 | 账号被临时封禁 | 请求节流（串行+随机间隔）、会话卫生（攒批清理）、指纹伪装（Chromium 网络栈） |
| R10 | 独立模式接口变化：DeepSeek 私有接口改版 | 中 | 独立模式失效 | 接口抽象层，变化时只需改请求构造；页面模式不受影响 |

---

## 10. 未决事项

1. **U1**：`src/entrypoints/content.ts` 实际使用了哪些 `chrome.*` → 需 D2 前 grep 核对
2. **U2**：与原 `deepseek-pp` 仓库的关系 → submodule / fork / 拷贝？代码如何同步更新？
3. **U3**：Tauri 版本与目标平台优先级 → 按 Tauri 2.x + Windows 优先
4. **U4**：独立模式的实现优先级 → 一期只做页面模式，二期加独立模式？
5. **U5**：本地 HTTP API 的具体接口规范 → 需进一步设计（端点、请求/响应格式、错误码）
6. **U6**：产品 UI 设计 → 窗口布局、侧边栏、设置页、托盘菜单
7. **U7**：是否需要代码签名/公证/自动更新 → 影响排期（A6）
8. **U8**：多标签支持是否纳入一期 → 当前列为二期（省 2~3 周）

---

## 11. 参考资料

- MiMo 架构设计回收件：`E:\NAS\Lever-Hub\out-alt\4346b6d66b6339d70953f05d9bf159b4.md`（382,843 字符）
- dsh-deepseek-web-login（独立模式参考）：https://github.com/cv-superding/dsh-deepseek-web-login
- 原 deepseek-pp 仓库：`E:\NAS\deepseek-pp`
- Tauri 官方文档：https://tauri.app/

---

*文档结束。如有问题或修改意见，请标注章节号反馈。*
