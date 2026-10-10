---
name: deepseek-studio-v0.2-minimal-loop
overview: 实现 DeepSeek++ Studio 路线图 v0.2「可运行骨架」最小闭环：用 Node 原型宿主把 v0.1 已落地的内核（bridge/inject/host/api）接成「发一条消息→签一次 grant→跑一次工具」端到端可运行，并辅以环境搭建与构建验证（Node 测试全绿 + Node 宿主真实跑通 + Rust/Tauri 工具链就位并能构建出最小骨架，为后续 v0.7 原生外壳铺路）。本轮不实现 v0.7+ 原生外壳功能。
todos:
  - id: setup-tauri-env
    content: 安装 Rust/cargo + Tauri CLI，scaffold 最小 src-tauri 骨架并验证 cargo build 通过
    status: completed
  - id: build-host-side
    content: 实现 desktop-host.ts 组合 authority+api，增强 main.ts 配置加载与 token 自动生成，新增 echo capability
    status: completed
  - id: build-inject-side
    content: 新增 bridge/index.ts 的 installChromeShims、transport-webview.ts 信封传输与 desktop/entry.ts 注入入口装配
    status: completed
  - id: e2e-smoke-test
    content: 编写 tests/e2e/smoke.ts 闭环并补齐单元/集成测试，确保 vitest 全绿与 tsc 0 错误
    status: completed
    dependencies:
      - build-host-side
      - build-inject-side
  - id: verify-and-closeout
    content: Node 宿主启动 8756 验证 curl /healthz 与 /v1/chat/completions，更新路线图 v0.2 进度状态
    status: completed
    dependencies:
      - e2e-smoke-test
      - setup-tauri-env
---

## 用户需求
把 DeepSeek++ Studio 路线图 v0.2「可运行骨架」做成最小闭环：用 Node 原型宿主把 v0.1 已落地的内核（bridge / inject / host / api）接成「发一条消息 → 签一次 grant → 跑一次工具」端到端可运行，并辅以环境搭建与构建验证。

## 产品概述
本轮不实现 v0.3 之后的授权 UI、真实上游、Tauri 原生外壳功能，只打通骨架：让已就绪的纯 TS 内核真正能被宿主进程拉起、能被注入脚本连接、能跑通一次受 grant 保护的工具执行。同时把 Rust/cargo + Tauri CLI 工具链装好、最小 `src-tauri` 骨架能 `cargo build` 通过，作为后续 v0.7 原生外壳的底座。

## 核心功能
- 常驻宿主：组合 `createApiServer` + `createPlatformDesktop`，暴露 `start()/stop()`，监听 8756。
- 配置加载：`host/port/token/secret` 从 `DEEPSEEK_STUDIO_*` 环境变量或本地配置文件读取，缺失自动生成 token 并落盘。
- 最小 capability：`echo` 实现 `ContentCapabilityController`，host 侧经 grant 执行并返回。
- 注入入口：`src/desktop/entry.ts` 在 document_start 装配 `installChromeShims()` + `bootstrapInjection()` + `installDirectBridge()`，挂 `window.__deepseekStudio`。
- 信封传输：`src/bridge/transport-webview.ts` 基于 `window.postMessage` 的 `Transport`，host 侧用 Node ws 收信封。
- 端到端冒烟：host 签发 grant → injected 持 grant 调 `echo` → 执行回传；CLI 起 8756 后 `curl /healthz` 与 `/v1/chat/completions`（fake backend）通过。
- 环境就绪：安装 Rust/cargo + Tauri CLI，scaffold 最小 `src-tauri`（窗口 + init script 占位），`cargo build` 通过。


## 技术栈选择
- 宿主 / 注入侧：沿用现有 **TypeScript + Node**（项目已含 `package.json`/`tsconfig.json`/`vitest`），不引入新运行时。
- 运行 TS CLI：新增 `tsx` 开发依赖（或 `node --import tsx`），提供 `start` 脚本拉起 Node 原型宿主。
- 测试：沿用 **vitest**（现有 39 测试门禁）。
- 原生外壳底座：新增 **Rust + cargo + Tauri CLI**，本轮仅 scaffold 最小 `src-tauri` 并验证 `cargo build`，不实现 v0.7 功能。

## 实现思路
**策略**：组合而非重写。v0.1 内核已提供全部原子能力（`createApiServer` / `createToolAuthority` / `createPlatformDesktop` / `createRuntimeBridge` / `createChromeStorageShim` / `bootstrapInjection` / `installDirectBridge`），v0.2 只做「装配层」：一个 Node 宿主把 api+authority 组合起来常驻，一个注入入口把桥接层+装载器+直连桥按顺序装配，一条 `echo` capability 证明授权→执行链路，一条 ws 信封通道把注入侧与宿主侧连起来。

**关键决策**：
1. `desktop-host.ts` 用 `createPlatformDesktop`（而非裸 `createToolAuthority`）作授权门面，与路线图 2.1.1 一致；宿主侧工具执行统一经其 `issueGrant` 后再 rehydrate。
2. `installChromeShims` 为**新增**装配函数（当前 `src/bridge` 仅有 `createRuntimeBridge`/`createChromeStorageShim`，没有把 `window.chrome.*` 挂上去的入口），内部调这两个工厂把 `chrome.runtime.*` / `chrome.storage.local.*` 指到桥接层。
3. Node 原型用 **ws 服务**收 `window.postMessage` 信封：注入侧 `transport-webview.ts` 把信封 `postMessage` 给宿主页/Node 桥，宿主侧 ws 接收后路由到 `createRuntimeBridge` 的 dispatch。Tauri 阶段该 ws 接收端会替换为 `bridge_invoke` IPC（v0.7 再改）。
4. `echo` capability 走 `ContentCapabilityController` 接口（`src/inject/types.ts` 已定义），保持「先授权后执行、一次性 grant、stop 后 snapshot 归零」硬不变量。

**性能与可靠性**：ws 信封为点对点、单连接；grant 一次性消费 + 内存 Map 存储，无持久化开销；fail-closed 优先（origin 白名单 / 存储不可序列化 / grant 校验失败一律拒绝）。

## 实现注意事项
- 严守架构红线：上游 `deepseek-pp/src/core/**` 零修改；端口固定 8756，CORS 仅 localhost；`tsconfig` 已排除 `deepseek-pp`。
- `main.ts` 现有 `DEEPSEEK_STUDIO_API_*` 命名与路线图 `DEEPSEEK_STUDIO_*` 略有出入，统一为 `DEEPSEEK_STUDIO_HOST/PORT/TOKEN/SECRET` 并补齐「缺失自动生成 + 落盘」。
- `loader.ts` 实际导出为 `bootstrapInjection()`（全局幂等入口）与 `createInjector()`，`entry.ts` 直接调 `bootstrapInjection(options)`，不臆造 `loader.install`。
- 现有 39 测试门禁必须保持全绿；新增 v0.2 相关单测/集成测后 `vitest run` 仍全绿、`tsc --noEmit` 0 错误。
- `src-tauri` 仅 scaffold 窗口 + init script 占位，`cargo build` 通过即达标，不写 IPC/KV/崩溃恢复（属 v0.7）。

## 架构设计
v0.2 闭环数据流（Node 原型）：

```mermaid
flowchart LR
  subgraph Injected[注入侧 WebView document_start]
    E[entry.ts] -->|installChromeShims| SH[window.chrome.runtime/storage]
    E -->|bootstrapInjection| LD[loader + direct-bridge]
    LD -->|Transport postMessage| TW[transport-webview]
  end
  subgraph Host[Node 宿主 :8756]
    WS[ws 信封接收] --> RB[createRuntimeBridge dispatch]
    RB --> AUTH[createPlatformDesktop issueGrant]
    RB --> API[createApiServer /v1/*]
    AUTH --> CAP[echo capability 执行]
  end
  TW -.信封.-> WS
  API -->|fake backend| CHAT[/v1/chat/completions]
```

## 目录结构
```
E:\NAS\deepseek-studio\
├── src/
│   ├── host/
│   │   └── desktop-host.ts        # [NEW] createDesktopHost({config, secret}) 组合 createApiServer + createPlatformDesktop，暴露 start()/stop()/url
│   ├── capabilities/
│   │   └── echo.ts                # [NEW] 实现 ContentCapabilityController 的 echo 能力，host 侧经 grant 执行返回
│   ├── desktop/
│   │   └── entry.ts               # [NEW] initialization_script 入口：installChromeShims + bootstrapInjection + installDirectBridge，挂 window.__deepseekStudio
│   ├── bridge/
│   │   ├── index.ts               # [NEW] 新增 installChromeShims()，把 window.chrome.runtime.* / chrome.storage.local.* 指到桥接层（复用 createRuntimeBridge / createChromeStorageShim）
│   │   └── transport-webview.ts   # [NEW] 基于 window.postMessage 的 Transport（content↔host 信封），宿主侧配套 ws 接收
│   └── api/
│       └── main.ts                # [MODIFY] 增强配置加载：DEEPSEEK_STUDIO_HOST/PORT/TOKEN/SECRET 读取，缺失自动生成 token+secret 并落盘；导出自启动 start 脚本
├── tests/
│   └── e2e/
│       └── smoke.ts               # [NEW] 端到端冒烟：host 签发 grant → injected 持 grant 调 echo → 执行回传；CLI 起 8756 后 curl /healthz + /v1/chat/completions 通过
├── src-tauri/                     # [NEW] 最小 Tauri 骨架（环境就绪证明，不实现 v0.7 功能）
│   ├── Cargo.toml
│   ├── tauri.conf.json            # 窗口 + init script 占位，端口 8756 注释说明
│   ├── build.rs
│   └── src/
│       └── main.rs                # 窗口创建 + initialization_script 占位（仅 cargo build 通过）
└── package.json                   # [MODIFY] 增加 start(=tsx src/api/main.ts) 与 tauri 相关脚本；新增 tsx 开发依赖
```

## 关键代码结构
```ts
// src/host/desktop-host.ts
export interface DesktopHostOptions { config: ApiConfig; secret: string; tokenTtlMs?: number; grantTtlMs?: number; }
export interface DesktopHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  readonly authority: PlatformDesktop;   // issueGrant(...)
}
export function createDesktopHost(options: DesktopHostOptions): DesktopHost;

// src/bridge/index.ts
export function installChromeShims(options?: { origin?: string }): void; // 挂 window.chrome.runtime.* / chrome.storage.local.*

// src/capabilities/echo.ts
export interface EchoCapabilityOptions { message: string; }
export function createEchoCapability(): ContentCapabilityController; // start(ctx) / stop() / snapshot()

// src/bridge/transport-webview.ts
export function createWebviewPostMessageTransport(target: Window): Transport; // 注入侧 postMessage 信封
export function createNodeWsEnvelopeReceiver(port: number, onEnvelope: (e: RuntimeMessageEnvelope) => void): { close(): void };
```

