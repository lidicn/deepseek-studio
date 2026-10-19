# DeepSeek Studio UI 豆包施工计划 v1

> 版本：v1.1（并入 2026-10-19 施工评审 H1-H8 / M1-M16）  
> 日期：2026-10-19  
> 仓库：`E:\NAS\deepseek-studio`  
> 分支基线：`feat/bot-core` / `4afea0f`  
> 执行对象：豆包长任务主执行者  
> 交接对象：Codex / Claude Code / 后续模型  
> 计划性质：文件级施工单，不是方向建议

> 本版处理原则：评审提出的问题先在当前 HEAD 实测；与实测冲突的结论不照抄，但风险原则保留并升级成门禁。C0 未通过，不得开始 C1。

---

## 0. 豆包开工提示词

把下面整段复制给豆包。豆包必须按 C0 → C8 顺序执行，不得跳步。

```text
你接手 E:\NAS\deepseek-studio 的前端重构施工任务。先完整阅读：

1. docs/前端开发计划/Studio-UI-豆包施工计划-v1.md
2. docs/前端开发计划/Studio-UI-总体设计-v1.md
3. docs/审计报告/Studio-UI-总体设计-v1-补充评审-20261019.md
4. docs/审计报告/设计评审_Studio-UI-总体设计-v1_20261019.md
5. docs/审计报告/Studio-UI-总体设计-v1-评审-20261019.md

你的任务不是继续讨论方案，而是按施工计划逐项改代码、补测试、跑命令、更新接力状态。

硬规则：

- 一次只做一个 checkpoint，做完就停，更新 docs/前端开发计划/接力状态.md。
- 不引入 React、Vite、Monaco、xterm、Shiki、KaTeX、PWA。
- 不搬运 cuckoo-code 代码，不 fork DeepSeek Harness。
- 不修改 plugin-auth.json，不读取或输出 token、refresh token、cookie。
- 不覆盖 src-tauri/inject/entry.js 的现有未提交修改。C0 必须先做实体备份、临时 outfile 重建比对；C0-1 门禁未通过，禁止执行任何会覆盖 entry.js 的 build。
- 不使用 git reset --hard、git checkout --、git restore。
- 不把后端没有的能力做成假按钮：不伪造 Workbench 审批、Plan 模式、逐块 diff、终端、预览、会话列表。
- 除 account-block 的账号身份锁覆盖层外，登录页、二维码、原生消息区不得被 Studio 遮挡。
- 权限词表只允许 workspace | ask | auto | full；面板只暴露 workspace | auto | full。
- 审批词只允许 allow-once | deny | allow-session；不允许出现“始终允许”。
- 所有新增 UI 组件必须可点击；根容器 pointer-events:none，直接子节点默认 pointer-events:auto，不允许再维护点击白名单。
- 所有订阅、定时器、MutationObserver、ResizeObserver、事件监听必须返回 disposer，destroy() 必须幂等。
- 未知工具、未知错误码、缺失字段必须有兜底 UI，不允许白屏或静默吞异常。
- 发现需求与代码事实冲突时，以本计划第 2 节“已确认事实”与第 3 节“硬约束”为准；不要自行扩大范围。

每个 checkpoint 结束必须运行：

git status --short
npm run typecheck
npx vitest run
git diff --check

涉及注入或 Workbench bundle 时再加：

npm run build:inject

涉及 Rust（C5）时再加：

cd src-tauri
cargo check
cd ..

涉及契约、边界、覆盖率、空文件时再加：

npx tsx tools/audit/boundary.ts
npx tsx tools/contract/check.ts
npx tsx tools/coverage/check.ts
npx tsx tools/audit/empty-files.ts

当前测试基线不是全绿：118 个测试文件、1197 个测试，1194 通过、3 失败。三条既有失败是：

- tests/desktop/desktop-entry.test.ts（location.pathname stub 缺失）
- tests/desktop/tool-authority.test.ts（已消费 grant 期望 consumed，实际 not-found）
- tests/e2e/smoke.test.ts（同一 grant 重放语义）

不允许新增失败。不要顺手修这三条；如确需修，必须单独提交并说明语义。

现在从 C0 开始。完成 C0 后只汇报：修改文件、命令结果、新增失败数、C0 六道前置门禁结果、下一 checkpoint 入口条件。
```

---

## 1. 交付目标

本期交付一个可实际使用、可验收、可接力的 UI 重构：

1. 注入层只保留轻量 Focus 模式，不再默认挂载全屏聊天 overlay。
2. 独立页升级为真正的 Workbench，包含三栏骨架、任务流、Inspector、composer、状态条。
3. 建立共享设计 token、权限契约、审批契约、生命周期契约和真正的新 Shadow DOM 根 API；旧 `createShadowContainer()` 在迁移期保持兼容，最终 C7 前收口。
4. 新增结构化工具运行事件，使工具卡片有真实数据源。
5. 扩展现有 Tauri `main-tray` 托盘/命令入口，使 Workbench 真正可打开。
6. 增加 Markdown sanitizer、可访问性、错误兜底和自动化验收。
7. 用已确认素材替换并接入应用图标。

本期不交付：

- 手机 PWA、远程控制、移动端配对、设备撤销。
- React / Vite / Monaco / xterm / Shiki / KaTeX。
- Workbench 内审批决策通道。
- Workbench Plan 模式。
- 逐块接受/拒绝 diff。
- 完整终端、预览、会话持久化、会话列表。
- 多 Agent 可视化编排。
- 持久白名单管理 UI。

---

## 2. 已确认事实

施工前必须承认以下事实，不能按旧文档的假设写代码：

### 2.1 技术栈与构建

- 当前注入层是 TypeScript + 原生 DOM + esbuild 单文件 IIFE。
- `package.json` 没有 React、Vite、Monaco、xterm、Shiki、KaTeX。
- `npm run build:inject` 同时构建：
  - `src/desktop/entry.ts` → `src-tauri/inject/entry.js`
  - `src/ui/agent-panel.ts` → `dist/agent-panel.js`
- Tauri 运行时读取 `entry.js`，不是编译时 `include_str!` 嵌入。

### 2.2 现有 Workbench 只是骨架

- `src/ui/agent.html` 只有顶栏、线性消息流、权限三档、textarea、发送/停止。
- `/agent`、`/agent.js`、`/agent.css` 由 `src/api/server.ts` 提供。
- `/agent-ws` 由 `src/host/agent-channel.ts` 提供。
- Tauri 当前只创建 `main` 和 bot 窗口，没有创建加载 `/agent` 的窗口。

### 2.3 工具事件不足

- `AgentLoopEvent` 只有 `user | assistant | tool | status | error | done`。
- `tool` 事件只有计数，不带工具名、callId、阶段、错误码、耗时。
- `page-runtime` 已有 `onToolCall` / `onToolResult` 回调，但 `desktop-host` 只接了 `onToolCall` 做计数。
- `web-engine.recordToolCall()` 当前没有实际调用方，不能作为 UI 数据源。

### 2.4 权限词表冲突

- 宿主权威：`src/host/policy.ts` 的 `workspace | ask | auto | full`。
- 面板暴露：`workspace | auto | full`。
- 现有 UI：`src/ui/studio-ui-core.ts`、`studio-input-bar.ts`、`studio-settings-panel.ts` 仍是 `full | auto | ask`。
- `policy.set` host 工具直接改 `policyMode`，不调用共享 `setPolicyMode()`，不会清空 session allowlist，也不走持久化路径。

### 2.5 审批与 Plan

- 协议只有 `allow-once | deny | allow-session`。
- `allow-session` 是工具 + 参数指纹 + 10 分钟 TTL，不是永久白名单。
- `/agent-ws` 没有审批请求/决策通道；Workbench 本期不能做真实审批按钮。
- `evaluatePlanGate()` 没有实际调用方；本期不做 Workbench Plan 开关。

### 2.6 安全例外

`src/ui/account-block.ts` 的全屏红底覆盖层是刻意 fail-closed，不是 UI 缺陷。禁止给它加 Esc、点外关闭、降低 z-index 或改成可绕过。

### 2.7 当前工作树

当前 `git status --short` 至少包含：

```text
 M src-tauri/inject/entry.js
?? docs/前端开发计划/
?? docs/审计报告/Studio-UI-总体设计-v1-评审-20261019.md
?? docs/审计报告/Studio-UI-总体设计-v1-评审报告.md
?? docs/审计报告/设计评审_Studio-UI-总体设计-v1_20261019.md
?? docs/审计报告/Studio-UI-总体设计-v1-补充评审-20261019.md
?? docs/设计稿/app-icon-v1.png
?? logs/
```

`src-tauri/inject/entry.js` 的未提交修改为 +10/-4，内容与当前源码语义一致：

- `src/desktop/entry.ts:149` 的 `onStreamDelta` 接线。
- `src/inject/main-world-interceptor.ts` 的 XHR 流式 delta 转发。
- `src/desktop/entry.ts:128` 的登录页不挂载 chat overlay。

因此不能照抄评审中“源码里没有 streamDelta、必须人工反推”的旧结论；当前 HEAD 已包含这些源码。但 `entry.js` 仍是用户未提交文件，必须按 C0-1 做实体备份和重建比对。不得覆盖或回滚。

### 2.8 评审事实校正

以下结论已在本仓库 `4afea0f` 上核验，施工时以这里为准：

- H1：`streamDelta`、XHR delta 转发、登录页判断均已在源码中；风险门禁保留，旧“反推源码”动作取消。
- H2：`vitest.config.ts` 默认 `environment: 'node'`；DOM 测试必须首行写 `// @vitest-environment jsdom`。jsdom 对 `adoptedStyleSheets` 的支持必须先探针实测。
- H3：`src/ui/studio-ui-core.ts` 的 `EventBus` 只有 `on/emit`，没有 `handlerCount()`；C1 必须显式新增计数/清理能力。
- H4：`createShadowContainer()` 当前返回 `{ container, shadow: HTMLElement }`，`shadow` 就是 host 容器；12 处直接调用 `shadow.appendChild`。C1 不得改它的返回类型，必须新增独立 `mountShadowRoot()`。
- H5：评审要求 checkpoint commit 的意图正确，但不能用 `git add -A`，会误提交用户已有 `entry.js`、docs、logs。只允许文件级暂存；未获用户明确要求时不自动 commit。
- H6：C5 修改 Rust 必须执行 `cargo check`。
- H7：`src/host/mutable-workspace.ts` 不存在，但测试从 `src/host/workspace.ts` 导入有效符号，不是孤儿测试；不得删除，C0 记录文件名历史问题。
- H8：当前 `4afea0f` 基线仍为 118 文件 / 1197 测试 / 1194 通过 / 3 失败；评审的 115/20 属于旧副本。C0 仍需逐项记录安全红线用例状态。

---

## 3. 全局硬约束

### 3.1 文件与命令

- 使用 PowerShell。
- 不读取、不输出 `plugin-auth.json` 中的 token、refresh token、cookie。
- 不修改 `src/api/server.ts` 的 token 注入方式，除非 C5 明确要求。
- 不新增任何依赖，C7 的 `dompurify` 除外。
- 不删除用户未跟踪的 `docs/`、`logs/`、设计稿。
- 每次构建前后都检查 `git diff --stat` 与 `git diff -- src-tauri/inject/entry.js`。

### 3.2 设计语言

视觉方向固定为：

> 精密、克制、可信，像工作台，不像营销页。

颜色：

```text
主蓝 fill       #4D6BFE
蓝 hover        #3B5BDB
蓝文本/图标     #2F4FD8
蓝柔光          rgba(77,107,254,0.08)
主文字          #16181D
次文字          #5B6170
弱文字          #6B7280
页面背景        #F7F8FA
面板            #FFFFFF
次级背景        #F5F6F8
边框            rgba(16,24,40,0.08)
成功文字        #1F7A52
警告文字        #8A5A00
错误文字        #C43A3A
```

字体：

```text
中文：MiSans / PingFang SC / Microsoft YaHei / Noto Sans SC
代码：Cascadia Code / JetBrains Mono
数字：font-variant-numeric: tabular-nums
```

尺寸：

```text
顶部栏        44–48px
左侧 rail     52–56px
左侧面板      260–280px
右侧 Inspector 320–420px
状态条        28px
内容最大宽度  760–860px
间距基线      4px
圆角          8 / 12 / 16px
正文          13–14px
代码          12–13px
```

禁止：

- 子 Bot 紫色 `#8b5cf6`。
- 大面积渐变、玻璃拟态、营销式背景。
- 常规 UI 的全屏纯白 overlay。
- 巨型圆角卡片、无意义悬浮缩放。
- 用彩色聊天气泡区分 Agent。

主题优先级固定为：

```text
宿主显式主题 > 系统 prefers-color-scheme > 默认浅色
```

token 必须从一开始就分 light / dark，不能只写死浅色。

### 3.3 响应式

Workbench 固定断点：

```text
>= 1440px：三栏展开；右栏 360–420px
1200–1439px：右栏收窄到 320px；左栏可折叠
< 1200px：右栏变抽屉；左栏折叠为 rail
< 900px：显示“请使用桌面主窗口 Focus 模式”，不强行做手机布局
```

中栏最小可用宽度 520px。1024 / 1280 / 1440 三档不得横向溢出。

### 3.4 生命周期

新增接口统一使用：

```ts
export type Disposer = () => void;

export interface StudioDisposable {
  dispose(): void;
}
```

规则：

1. 任何 `addEventListener`、`MutationObserver`、`ResizeObserver`、`requestAnimationFrame`、`setTimeout`、`setInterval`、EventBus 订阅都必须登记 disposer。
2. `destroy()` 必须幂等；第二次调用不得抛错。
3. 不允许模块级 import 即订阅。
4. 连续 mount → destroy → mount 3 次后，DOM 与订阅数回到基线。

---

## 4. Checkpoint 总表

| Checkpoint | 交付 | 主要文件 | 停止条件 |
|---|---|---|---|
| C0 | 基线冻结、六道前置门禁、接力状态 | `docs/前端开发计划/接力状态.md`、`logs/ui-refactor-baseline/*` | C0-0 至 C0-6 全部有结论，源码零改动 |
| C1 | token、契约、真 Shadow DOM、基础 primitives | `src/ui/design-tokens.ts`、`ui-contract.ts`、`shadow-root.ts`、`src/shared/policy-contract.ts` | 单测通过，typecheck 通过 |
| C2 | 宿主布局/主题适配层 | `src/ui/host-layout-adapter.ts`、`host-theme-adapter.ts` | L0/L1/L2 测试通过 |
| C3 | 结构化工具运行事件 | `src/shared/tool-run-event.ts`、`agent-channel.ts`、`desktop-host.ts` | started/succeeded/failed/denied/unknown 测试通过 |
| C4 | Focus 模式替换全屏 overlay | `src/desktop/entry.ts`、`src/ui/focus/*` | 登录页/二维码/原生区不被遮挡 |
| C5 | Workbench 壳与 Tauri 入口 | `src/ui/agent.html`、`agent-panel.ts`、`src/ui/workbench/*`、`src-tauri/src/main.rs` | 托盘可打开 `/agent`，三栏响应式通过，`cargo check` 通过 |
| C6 | 任务组件与真实数据兜底 | `src/ui/workbench/components/*` | 未知工具/空数据/长文本测试通过 |
| C7 | sanitizer、安全、可访问性、旧面板迁移收口 | `src/inject/markdown.ts`、`src/ui/primitives/dialog.ts`、旧 `src/ui/*` 面板 | XSS、focus、Esc、reduced motion 测试通过，旧面板迁移清单清零 |
| C8 | 图标替换、打包、最终验收 | `src-tauri/tauri.conf.json`、`src-tauri/icons/*` | 图标一致，最终门禁记录完成 |

---

## 5. C0：基线冻结

### 5.1 目标

在不改业务源码的前提下，固定基线、保存用户修改、建立接力状态，并完成 C0-0 至 C0-6 六道前置门禁。任何一道没有结论，C1 不得开工。

### 5.2 允许修改

- `docs/前端开发计划/接力状态.md`（新建）
- `docs/前端开发计划/C0-baseline.txt`（新建，可选）
- `logs/ui-refactor-baseline/entry.js.bak`（新建，实体备份）
- `logs/ui-refactor-baseline/entry.rebuild.js`（新建，临时 outfile）
- `logs/ui-refactor-baseline/*.txt` / `*.diff`（新建，命令输出与差异证据）

### 5.3 禁止修改

- `src/**`
- `src-tauri/**`
- `package.json`
- `package-lock.json`
- `plugin-auth.json`
- 禁止在本 checkpoint 执行 `npm run build:inject`；C0-1 只能构建到临时 outfile。

### 5.4 步骤

#### C0-0 同步远端状态，不做 merge / rebase

执行并记录：

```powershell
git fetch
git branch --show-current
git rev-parse --short HEAD
git log -1 --oneline
git status --short
git diff --stat
git rev-list --left-right --count HEAD...@{u}
```

要求：

- 若没有 upstream，记录 `no-upstream`，不自行设置远端。
- 记录本地与 upstream 的 ahead/behind 数字。
- 本 checkpoint 及后续每个 checkpoint 开工前都执行 `git fetch`，只记录，不 rebase、不 merge。
- 若 `git fetch` 因网络失败，记录失败原因；不得把失败写成“已同步”。

#### C0-1 entry.js 实体备份与可重建证明（C4 前置硬门禁）

1. 建立备份目录并保存实体文件、hash、diff：

```powershell
New-Item -ItemType Directory -Force logs/ui-refactor-baseline | Out-Null
Copy-Item -LiteralPath src-tauri/inject/entry.js -Destination logs/ui-refactor-baseline/entry.js.bak -Force
Get-FileHash src-tauri/inject/entry.js -Algorithm SHA256 | Format-List | Out-File -Encoding utf8 logs/ui-refactor-baseline/entry.sha256.txt
git diff -- src-tauri/inject/entry.js | Out-File -Encoding utf8 logs/ui-refactor-baseline/entry.diff
```

2. 用临时 outfile 重建，不覆盖生产产物：

```powershell
npx esbuild src/desktop/entry.ts --bundle --format=iife --platform=browser --target=es2020 --outfile=logs/ui-refactor-baseline/entry.rebuild.js
```

3. 比对“源码重建产物”和“当前产物”：

```powershell
git diff --no-index --stat -- logs/ui-refactor-baseline/entry.rebuild.js src-tauri/inject/entry.js
git diff --no-index -- logs/ui-refactor-baseline/entry.rebuild.js src-tauri/inject/entry.js | Out-File -Encoding utf8 logs/ui-refactor-baseline/entry.rebuild-vs-current.diff
```

4. 判定规则：

- 若 diff 为空：源码可重建当前产物，记录 `PASS`。
- 若 diff 非空：先判断是否只是构建时间、换行、esbuild 版本或非语义格式差异；必须逐段说明。
- 若存在语义差异：停止，不得进入 C1。把差异写入接力状态，交用户确认；禁止手工改产物“凑一致”。

5. C4 开工前再次确认：

```powershell
Get-FileHash logs/ui-refactor-baseline/entry.js.bak -Algorithm SHA256
Get-FileHash src-tauri/inject/entry.js -Algorithm SHA256
```

只有 C0-1 判定 `PASS`，C4 才允许执行 `npm run build:inject`。C4 覆盖后必须用 `entry.js.bak` 做语义对照，不能只用 diff 当备份。

#### C0-2 安全红线用例状态清单

运行并保存完整输出：

```powershell
npx vitest run tests/desktop/capabilities-shell.test.ts tests/desktop/policy.test.ts tests/desktop/capabilities-search-files.test.ts tests/desktop/host-side-tools.test.ts tests/desktop/mutable-workspace.test.ts | Tee-Object -FilePath logs/ui-refactor-baseline/security-baseline.txt
```

在接力状态逐项记录以下用例的 `passed / failed / skipped`，不得只记总数：

- 命令注入防护：`capabilities-shell.test.ts` 中 shell 元字符、引号包裹、argv 注入相关用例。
- 路径逃逸：`capabilities-search-files.test.ts` 符号链接越狱用例。
- 策略矩阵：`policy.test.ts` 中 workspace / ask / auto / full 判定。
- 宿主侧边界：`host-side-tools.test.ts` 中 shell 不经过页面、未配置工作区 fail-closed。
- 工作区热切换：`mutable-workspace.test.ts` 中 `lexicallyInside` 与 `persistConfigPatch`。

若上述文件出现任何 `skipped`，必须写原因和是否为本期安全网缺口。不得把“文件通过”写成“所有安全红线已生效”。

#### C0-3 mutable-workspace.test.ts 处置

当前事实：

- `src/host/mutable-workspace.ts` 不存在。
- `tests/desktop/mutable-workspace.test.ts` 从 `src/host/workspace.ts` 导入 `createMutableWorkspace` 等有效符号。

处置：

- 保留测试，不得删除。
- 在接力状态注明“历史文件名，不表示孤儿源码”。
- 可选：把文件改名为 `workspace.test.ts`；改名必须单独记录，且不改变测试内容。

#### C0-4 jsdom Shadow DOM / adoptedStyleSheets 探针

新建临时探针文件（可放 `logs/ui-refactor-baseline/`，不得留在 `tests/`）：

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

describe('jsdom probe', () => {
  it('reports shadow DOM and adoptedStyleSheets support', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(':host{display:block}');
    const supportsAdopted = 'adoptedStyleSheets' in root;
    if (supportsAdopted) root.adoptedStyleSheets = [sheet];
    console.log(JSON.stringify({
      attachShadow: true,
      adoptedStyleSheets: supportsAdopted,
      sheetApplied: supportsAdopted && root.adoptedStyleSheets.length === 1,
    }));
    expect(root).toBeInstanceOf(ShadowRoot);
  });
});
```

运行：

```powershell
npx vitest run logs/ui-refactor-baseline/jsdom-probe.test.ts | Tee-Object -FilePath logs/ui-refactor-baseline/jsdom-probe.txt
```

判定：

- 支持 `adoptedStyleSheets`：C1 可用其作为首选路径，但仍必须保留 `<style>` 降级。
- 不支持或行为异常：C1 主路径直接使用 `<style>`，不得把测试写成假通过。

#### C0-5 注入体积与产物时效基线

记录：

```powershell
Get-Item src-tauri/inject/entry.js, dist/agent-panel.js | Select-Object FullName,Length,LastWriteTime | Format-List | Out-File -Encoding utf8 logs/ui-refactor-baseline/bundle-baseline.txt
```

预算：

- `src-tauri/inject/entry.js` 当前 401,573 B，硬上限 450,000 B。
- `dist/agent-panel.js` 当前 24,365 B，硬上限 120,000 B。
- 每个涉及 bundle 的 checkpoint 都必须记录实际大小；超限停止，不得用“功能需要”当理由直接放行。

产物时效规则：

- 若 `src/**` 中有文件新于 `dist/agent-panel.js`，C5 开工前必须重建。
- 若 `src-tauri/inject/entry.js` 新于 `logs/ui-refactor-baseline/entry.js.bak`，记录原因。

#### C0-6 Rust 工具链检查

执行：

```powershell
Set-Location src-tauri
cargo --version
cargo check
Set-Location ..
```

要求：

- 保存完整输出到 `logs/ui-refactor-baseline/cargo-baseline.txt`。
- 首次 `cargo check` 可能需要数分钟；等待完成，不以超时当通过。
- 若工具链缺失或失败，C5 不得开工，先记录阻塞原因。

#### C0-7 常规基线

1. 执行并记录：

```powershell
git status --short
git diff --stat
```

2. 运行基线：

```powershell
npm run typecheck
npx vitest run
git diff --check
```

3. 记录测试总数与三条既有失败。不要把三条失败写成“全绿”。

4. 核实 Logo：

```powershell
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('E:\NAS\deepseek-studio\docs\设计稿\app-icon-v1.png')
$img.Width
$img.Height
$img.PixelFormat
$img.Dispose()
```

期望：2048 × 2048，24bpp RGB，白色圆角方块 + 蓝色鲸鱼 + 对话气泡。

5. 新建 `docs/前端开发计划/接力状态.md`，使用第 16 节模板，并额外写入 C0-0 至 C0-6 的结论。

### 5.5 验收

- C0-0 至 C0-6 均有 `PASS / FAIL / 待用户确认` 结论，不允许空白。
- `git status --short` 与开工前一致，只多出 C0 文档和 `logs/ui-refactor-baseline/`。
- `entry.js` 的未提交修改仍在，且 `entry.js.bak` 与当前文件 hash 一致。
- C0-1 未通过时，明确写“禁止进入 C4”。
- 测试记录明确写出 1194 通过 / 3 失败。
- 安全红线用例逐项有状态，不只写总数。
- 明确记录“本期不引入 React/Vite”。

---

## 6. C1：设计系统、契约、真 Shadow DOM

### 6.1 目标

建立单一真相源，消除假 Shadow DOM、权限词表分裂和生命周期失控。

### 6.2 新建文件

```text
src/ui/design-tokens.ts
src/ui/ui-contract.ts
src/ui/disposer.ts
src/ui/shadow-root.ts
src/ui/primitives/button.ts
src/ui/primitives/badge.ts
src/ui/primitives/status-dot.ts
src/ui/primitives/dialog.ts
src/ui/primitives/empty-state.ts
src/shared/policy-contract.ts
src/shared/consent-contract.ts
```

### 6.3 修改文件

```text
src/host/policy.ts
src/host/protocol.ts
src/ui/consent.ts
src/ui/studio-ui-core.ts
```

修改 `studio-ui-core.ts` 只允许：

- 给 `EventBus` 增加 `handlerCount(event?)` 与 `clear(event?)`。
- 保持 `createShadowContainer()` 的签名和返回类型完全不变。
- `UIState.policyMode` 改为 `PolicyMode`，默认值改为 `auto`。

禁止在 C1 改 `createShadowContainer()` 为返回 `ShadowRoot`。

### 6.4 `src/shared/policy-contract.ts`

C1 只做“搬迁 + re-export”，不是重新发明契约。施工顺序必须是：

1. 把 `src/host/policy.ts` 中已有的 `PolicyMode`、`POLICY_MODES`、`PANEL_POLICY_MODES`、`DEFAULT_POLICY_MODE`、`POLICY_MODE_LABELS`、`isPolicyMode` 原样搬到 `src/shared/policy-contract.ts`。
2. `src/host/policy.ts` 从新文件 import，并 re-export 同名符号，保证既有 import 路径不变。
3. 新文件之外不得再出现这些常量或函数的字面量定义。
4. 若必须调整类型写法，只允许 `readonly` 修饰和等价类型收窄，不得改变值集合。

允许的内容形状如下，但施工者必须优先搬运现有定义，不得复制出第二套：

```ts
export const POLICY_MODES = ['workspace', 'ask', 'auto', 'full'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const PANEL_POLICY_MODES = ['workspace', 'auto', 'full'] as const;

export const POLICY_MODE_LABELS: Readonly<Record<PolicyMode, string>> = {
  workspace: '仅工作区',
  ask: '询问审批',
  auto: '风险审批',
  full: '完全放开',
};

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value);
}
```

要求：

- `src/host/policy.ts` 删除重复定义，改为 import + re-export，保持既有 import 路径可用。
- `UIState.policyMode` 改为 `PolicyMode`，默认值改为 `auto`。
- `studio-input-bar.ts` 与 `studio-settings-panel.ts` 的 `full | auto | ask` 全部改为 `PolicyMode`。
- 面板只渲染 `PANEL_POLICY_MODES`，永远不下发 `ask`。
- 收到旧配置 `ask` 时不崩溃，但显示为只读兼容提示。
- 用 `rg -n "POLICY_MODES|PANEL_POLICY_MODES|DEFAULT_POLICY_MODE|POLICY_MODE_LABELS|isPolicyMode" src` 验证只有定义点在新契约文件，其余均为 import/re-export。

### 6.5 `src/shared/consent-contract.ts`

```ts
export type ConsentDecision = 'allow-once' | 'deny' | 'allow-session';

export const CONSENT_DECISIONS = ['allow-once', 'deny', 'allow-session'] as const;

export const CONSENT_BUTTON_LABELS: Readonly<Record<ConsentDecision, string>> = {
  'allow-once': '允许一次',
  deny: '拒绝',
  'allow-session': '本次会话允许（10 分钟）',
};
```

要求：

- `src/host/protocol.ts` 与 `src/ui/consent.ts` 改为引用该文件。
- 禁止新增“始终允许”。
- `allow-session` 的语义注释必须写明“工具 + 参数指纹 + 10 分钟 TTL”。
- 中文按钮文案只在本文件集中定义；本期不做 i18n，但组件不得散落复制审批词。

### 6.6 `src/ui/ui-contract.ts`

至少定义：

```ts
export const UI_MODE = { focus: 'focus', workbench: 'workbench' } as const;
export type UiMode = (typeof UI_MODE)[keyof typeof UI_MODE];

export const TOOL_RUN_PHASES = [
  'started',
  'succeeded',
  'failed',
  'denied',
  'cancelled',
] as const;
export type ToolRunPhase = (typeof TOOL_RUN_PHASES)[number];

export const WORKBENCH_BREAKPOINTS = {
  wide: 1440,
  medium: 1200,
  compact: 900,
} as const;
```

`TOOL_RUN_PHASES` 在 C1 只作为 UI 契约占位；C3 的 `src/shared/tool-run-event.ts` 必须从该文件 import 或 re-export，不得再定义第二套阶段常量。

### 6.7 `src/ui/design-tokens.ts`

导出 `light`、`dark`、`space`、`radius`、`font`、`zLayer`。颜色必须使用第 3.2 节的 fill/text 双 token 结构。示例：

```ts
export const color = {
  light: {
    bgPage: '#F7F8FA',
    bgPanel: '#FFFFFF',
    bgSubtle: '#F5F6F8',
    textPrimary: '#16181D',
    textSecondary: '#5B6170',
    textWeak: '#6B7280',
    border: 'rgba(16,24,40,0.08)',
    primaryFill: '#4D6BFE',
    primaryHover: '#3B5BDB',
    primaryText: '#2F4FD8',
    successText: '#1F7A52',
    warningText: '#8A5A00',
    dangerText: '#C43A3A',
  },
  dark: {
    bgPage: '#111318',
    bgPanel: '#181B21',
    bgSubtle: '#1E222B',
    textPrimary: '#E6E8EC',
    textSecondary: '#A7ADB8',
    textWeak: '#858B96',
    border: 'rgba(255,255,255,0.10)',
    primaryFill: '#6E8BFF',
    primaryHover: '#8DA3FF',
    primaryText: '#9BB0FF',
    successText: '#55C995',
    warningText: '#E8B45A',
    dangerText: '#FF7A7A',
  },
} as const;

export const zLayer = {
  rail: 10,
  panel: 20,
  overlay: 30,
  dialog: 40,
  toast: 50,
  tooltip: 60,
} as const;
```

禁止在组件里硬编码这些颜色；组件只能引用 CSS 变量或 token 生成的变量。

### 6.8 `src/ui/disposer.ts`

实现：

```ts
export type Disposer = () => void;

export interface DisposerBag extends Disposer {
  add(fn: Disposer): void;
  readonly disposed: boolean;
}

export function createDisposerBag(): DisposerBag;
```

要求：

- `dispose()` 幂等。
- 逆序执行。
- 单个 disposer 抛错不影响其余 disposer。

### 6.9 `src/ui/shadow-root.ts`

必须使用真正的：

```ts
host.attachShadow({ mode: 'open' })
```

接口：

```ts
export interface MountedShadowRoot {
  host: HTMLElement;
  root: ShadowRoot;
  mountStyle(css: string, id: string): Disposer;
  dispose(): void;
}

export function mountShadowRoot(id: string, options?: { zIndex?: number }): MountedShadowRoot;
```

要求：

- host 设置 `pointer-events: none`。
- Shadow 内 `:host` 不继承宿主排版；`:host > *` 默认 `pointer-events: auto`。
- 样式优先 `adoptedStyleSheets`；不支持时用 `style` 元素，并按 id 去重。
- 不向 `document.head` 追加组件样式。
- `dispose()` 移除 host，幂等。

C1 的硬边界：

- `createShadowContainer()` 保留原签名 `{ container: HTMLElement; shadow: HTMLElement }`，行为不变。
- 新代码使用 `mountShadowRoot()`，不得混用。
- 旧面板的 12 处 `shadow.appendChild` 在 C4/C5 按模块迁移，不在 C1 一次性改。
- C7 设置迁移收口门禁：所有仍调用 `createShadowContainer()` 的旧面板必须完成迁移或明确列入“本期废弃且不可达”，否则 C7 不通过。

`EventBus` 必须新增：

```ts
handlerCount(event?: string): number;
clear(event?: string): void;
```

要求：

- 不传 `event` 时统计/清理全部事件。
- `on()` 返回的 disposer 幂等；重复调用不抛错。
- 测试使用 `clear()` 恢复全局单例，避免跨测试污染。

### 6.10 测试

新建：

```text
tests/desktop/ui-tokens.test.ts
tests/desktop/ui-contract.test.ts
tests/desktop/ui-shadow-root.test.ts
tests/desktop/studio-ui-lifecycle.test.ts
```

必须断言：

- `PANEL_POLICY_MODES` 永远不包含 `ask`。
- `PolicyMode` 能表示 `workspace`。
- 旧 `createShadowContainer` 仍返回 host 容器，现有调用点行为不变。
- 新 `mountShadowRoot` 返回真实 `ShadowRoot`。
- `shadow.host === container`。
- host 的 `pointer-events` 为 `none`，直接子节点为 `auto`。
- 样式只存在于 shadow root 内。
- 连续 mount/destroy 3 次，`globalEvents.handlerCount()` 回到基线；测试后调用 `clear()`。
- `dispose()` 第二次调用不抛错。

所有涉及 DOM、`attachShadow`、`ShadowRoot`、`adoptedStyleSheets` 的新测试，首行必须写：

```ts
// @vitest-environment jsdom
```

若 C0-4 探针表明 jsdom 不支持 `adoptedStyleSheets`，`mountShadowRoot` 的主路径改为 `<style>`，测试只断言样式在 Shadow 内，不断言 API 一定可用。

---

## 7. C2：宿主布局与主题适配层

### 7.1 目标

把 composer 定位、侧栏测量、主题判断从 UI 组件中移出，宿主改版时只降级，不整体白屏。

### 7.2 新建

```text
src/ui/host-layout-adapter.ts
src/ui/host-theme-adapter.ts
```

### 7.3 `host-layout-adapter.ts`

必须提供：

```ts
export type LayoutDegradeLevel = 'L0' | 'L1' | 'L2';

export interface HostLayoutSnapshot {
  level: LayoutDegradeLevel;
  degradeReason: string | null;
  viewport: { width: number; height: number };
  composerRect: DOMRect | null;
  composerTop: number | null;
  sidebarRight: number;
  railLeft: number;
}

export interface HostLayoutAdapter extends StudioDisposable {
  getSnapshot(): HostLayoutSnapshot;
  getComposerMountPoint(): HTMLElement | null;
  observe(callback: (snapshot: HostLayoutSnapshot) => void): Disposer;
}
```

定位规则：

1. composer 优先找可见的 `textarea`、`[contenteditable="true"]`、`[role="textbox"]`。
2. 只在视口底部 45% 区域内选择面积最大的候选。
3. 从 composer 向上最多 4 层，找包含至少 1 个按钮的 toolbar。
4. 找不到 toolbar 时，在 composer 上方创建独立锚点；不得覆盖 composer。
5. 侧栏测量沿用现有几何规则，但必须限制扫描数量（最多 2000 个节点）。
6. `railLeft`：能测到宿主侧栏则 `sidebarRight + 8`，否则 `12`。

降级：

```text
L0：composer + sidebar 都可用
L1：composer 可用，sidebar 未知；rail 放左侧 12px
L2：composer 不可用；隐藏 composer 动作条，只保留 rail/status
```

降级可观测性（M12）：

- 每次进入 L1/L2 必须调用一次结构化日志：`console.warn('[studio][layout] degraded', { level, reason, at })`。
- `HostLayoutSnapshot` 增加 `degradeReason: string | null`。
- 状态 chip 必须显示“布局降级 L1/L2”，鼠标悬停或 `aria-label` 给出原因。
- 同一原因不得每帧重复刷日志；用 `lastLoggedLevel + lastLoggedReason` 去重，恢复 L0 时记录一次 `recovered`。
- 测试必须断言：进入 L2 有日志、状态 chip 有降级文本、重复快照不重复刷日志。

要求：

- 组件不得散落 `document.querySelector` 定位宿主元素。
- `observe()` 使用 MutationObserver + resize + rAF 防抖，返回 disposer。
- 连续销毁后不得残留 observer 或 timer。

### 7.4 `host-theme-adapter.ts`

```ts
export type StudioTheme = 'light' | 'dark';

export interface HostThemeAdapter extends StudioDisposable {
  getTheme(): StudioTheme;
  observe(callback: (theme: StudioTheme) => void): Disposer;
}
```

优先级：

1. 宿主显式 `html[data-theme]`、`body[data-theme]`、`class` 中的 light/dark。
2. 宿主 `getComputedStyle` 背景亮度。
3. `prefers-color-scheme`。
4. 默认 light。

主题降级：

- `getComputedStyle` 抛错或读到透明背景时，继续走 `prefers-color-scheme`，不得抛到组件层。
- 主题变化必须通过 disposer 退订 `matchMedia` 监听。

### 7.5 测试

新建 `tests/desktop/host-layout-adapter.test.ts`：

- L0：composer + sidebar 都能测到。
- L1：只有 composer，railLeft 回退 12。
- L2：composer 消失，返回 L2，不抛错。
- `dispose()` 后 MutationObserver 不再触发回调。
- 扫描节点上限生效。

---

## 8. C3：结构化工具运行事件

### 8.1 目标

给 Workbench 提供真实工具阶段数据，同时不把完整参数、stdout/stderr 广播到 UI。

本 checkpoint 不替换 `AgentLoopEvent`，也不替换 `tool-event-bus`。它是面向 Workbench 的增量事件通道，旧计数事件和 metrics 消费方保持可用。

### 8.2 新建

```text
src/shared/tool-run-event.ts
tests/desktop/tool-run-event.test.ts
tests/desktop/agent-channel-tool-run.test.ts
```

### 8.3 事件契约

```ts
import type { ToolRunPhase } from '../ui/ui-contract';

export interface ToolRunEvent {
  type: 'tool-run';
  runId: string;
  tool: string;
  phase: ToolRunPhase;
  step?: number;
  summary?: string;
  durationMs?: number;
  exitCode?: number | null;
  errorCode?: string;
  artifactPaths?: string[];
  details?: {
    path?: string;
    replacements?: number;
    bytesBefore?: number;
    bytesAfter?: number;
    sha256Before?: string;
    sha256After?: string;
  };
  botId?: string;
  roomId?: string;
}
```

与既有文件的关系（M1，必须写进代码注释）：

- `src/shared/agent-loop-event.ts`：agent 对话/步数/计数事件，保持原契约，不改 `AgentEventType`。
- `src/shared/tool-event-bus.ts`：进程内工具生命周期事件总线，供 metrics/harness 消费；`ToolRunEvent` 不替换它。
- `src/shared/tool-record.ts`：完整调用/结果记录，含参数和 detail，适合审计；`ToolRunEvent` 是脱敏 UI 投影，不广播完整记录。
- `src/ui/ui-contract.ts`：`ToolRunPhase` 的唯一词表来源；`tool-run-event.ts` 只 import/re-export，不重复定义。

禁止：

- 不得把 `AgentLoopEvent.type` 改成 `tool-run`。
- 不得让 `ToolRunEvent` 携带 `ToolResult.detail` 或完整 `params`。
- 不得新建第二套 `ToolRunPhase` 字面量。

硬规则：

- `runId` 使用 `callId`。
- 不广播完整 params。
- 不广播 stdout/stderr。
- `details` 只允许白名单字段。
- 未知工具照常发事件，UI 用 UnknownToolCard。
- 没有真实 `artifactPaths` 时不发该字段。

### 8.4 接线

修改：

```text
src/host/page-runtime.ts
src/host/desktop-host.ts
src/host/agent-channel.ts
```

`page-runtime`：

- `onToolResult` 增加可选 `details?: Record<string, unknown>` 与 `durationMs?: number`。
- 成功与失败分支都传 `r.details`。
- 页断开导致 pending 失败时，保留 callId，供 desktop-host 发 `failed`。

`desktop-host`：

- 新增 `toolRunListeners` 与 `onToolRun(cb): Disposer`。
- `onToolCall`：
  - 累加原有 toolCallCounter。
  - 记录 `callId → { tool, startedAt, botId }`。
  - 发 `phase:'started'`。
- `onToolResult`：
  - 计算 `durationMs`。
  - `ok:true` → `succeeded`。
  - `error` 命中 `consent-denied | policy-denied | denied` → `denied`。
  - `error` 命中 `cancel | abort | stopped` → `cancelled`。
  - 其它失败 → `failed`。
  - 从 `details` 提取 `exitCode` 和白名单字段。
- 页断开时，为未完成 runId 发 `failed`，`errorCode:'page-disconnected'`。

`agent-channel`：

- `AgentChannelHost` 增加可选 `onToolRunEvent?: (cb) => Disposer`。
- 订阅后广播：

```json
{ "type": "tool-run", "event": { "type": "tool-run", "runId": "...", "tool": "...", "phase": "started" } }
```

- `dispose()` 必须退订。

### 8.5 事件时序与去重

- 每个 `runId` 只允许一条 `started`。
- `started` 之后最多一条终态：`succeeded / failed / denied / cancelled`。
- 迟到或重复终态必须丢弃并 `console.warn('[studio][tool-run] duplicate terminal', { runId, phase })`。
- 找不到 `started` 的终态不得伪造开始时间；发 `failed`，`errorCode:'missing-start'`。
- 页断开时，只对仍在 pending 的 runId 发 `failed`，不得把所有历史 run 重发一遍。

### 8.6 测试

必须覆盖：

1. started → succeeded。
2. started → failed，带 errorCode。
3. started → denied，`consent-denied` 映射为 denied。
4. started → cancelled。
5. 未知工具 `foo.unknown` 不抛错。
6. WS 客户端收到 `{type:'tool-run'}`。
7. 不出现完整 params 或 stdout。
8. 重复终态被丢弃。
9. 没有 `started` 的终态标为 `missing-start`。
10. `agent-channel.dispose()` 后不再广播。

---

## 9. C4：Focus 模式

### 9.1 目标

停止默认挂载全屏 chat overlay，把注入层改成轻量增强；登录页、二维码、原生消息区保持可见。

### 9.2 新建

```text
src/ui/focus/focus-mode.ts
src/ui/focus/focus-rail.ts
src/ui/focus/focus-composer-actions.ts
src/ui/focus/focus-status-chip.ts
src/ui/focus/focus-panel-host.ts
```

### 9.3 修改

```text
src/desktop/entry.ts
src/ui/studio-ui-install.ts
src/ui/studio-settings-panel.ts
src/ui/studio-project-picker.ts
src/ui/studio-skills-panel.ts
src/ui/studio-mcp-dialog.ts
```

### 9.4 `src/inject/` 保留 / 迁移 / 废弃清单（M6）

C4 只改 `entry.ts` 与新增 `src/ui/focus/*`，不得误删以下注入层依赖：

| 文件/组 | 处置 | 原因 |
|---|---|---|
| `src/inject/main-world-interceptor.ts` | 保留 | SSE/XHR 解析、工具调用回注、streamDelta 主路径 |
| `src/inject/markdown.ts` | 保留，C7 加 sanitizer | 现有渲染入口 |
| `src/inject/tool-card-ui.ts`、`tool-card-dom.ts` | 保留 | 页面内工具卡片，与 Workbench 卡片是不同宿主 |
| `src/inject/step-flow-ui.ts`、`step-control.ts` | 保留 | 页面执行步骤 UI |
| `src/inject/render-code-runner.ts` | 保留 | 代码块运行按钮 |
| `src/inject/streaming-tool-parser.ts`、`sse-text-extractor.ts`、`deepseek-sse-frame-decoder.ts` | 保留 | 流式解析主链路 |
| `src/inject/direct-bridge.ts`、`direct-port.ts`、`direct-target.ts`、`bridge-install.ts` | 保留 | 同域桥接 |
| `src/inject/lifecycle.ts`、`navigation.ts`、`origin-guard.ts` | 保留 | 生命周期与安全边界 |
| `src/inject/pow.ts`、`pow-wasm.ts` | 保留 | 现有页面能力，不在本期删除 |
| `src/inject/trace-store.ts`、`response-classifier.ts` | 保留 | 追踪与错误分类 |
| `src/inject/execution-policy.ts`、`message-anchor.ts` | 保留 | 页面侧执行策略与锚点 |
| `src/ui/studio-chat-ui.ts` | C4 起不再默认挂载；保留到 C7 收口 | 全屏 overlay 退役，避免一次删光导致回滚困难 |
| `src/ui/studio-ui-install.ts` | C4 标记 deprecated；C7 收口 | 旧面板统一入口 |

禁止在 C4 删除任何 `src/inject/*` 文件。若确需删除，必须单独 checkpoint 并给调用图证据。

### 9.5 `entry.ts` 改法

1. 删除 `createStudioChatUI` import 与默认挂载块。
2. 保留登录页判断：

```ts
const isLoginPage =
  location.pathname.includes('/login') ||
  location.pathname.includes('/signin');
```

3. 只在主窗口、非登录页挂载：

```ts
installFocusMode({
  host: { sendToolCall: (req) => host.sendToolCall(req), log: (t) => host.log(t) },
});
```

4. `installMainWorldInterceptor` 继续接收 `chatUI: undefined`；不得因为缺少 overlay 破坏 SSE 工具解析。保留现有 `onStreamDelta: (text) => host.streamDelta(text)`。
5. bot 窗口不挂 Focus。
6. `installStudioUI` 不再作为默认入口；保留文件但标记 deprecated，后续可删。

### 9.6 Focus 组成

只允许三个挂载点：

1. 左侧 52px rail：
   - 打开工作台
   - 当前工作区
   - 设置（只读）
   - 技能（只读）
   - MCP（只读）
2. composer 动作条：
   - 工作区 chip
   - 权限 chip（只读）
   - 引擎状态
   - “在工作台修改”
3. 状态 chip：
   - 已连接 / 执行中 / 审批在宿主窗口完成 / 降级

禁止：

- 全屏白色聊天 overlay。
- 覆盖原生 composer。
- 覆盖原生消息区。
- 覆盖登录页、二维码。
- 给 account-block 加关闭入口。

### 9.7 懒挂载

`focus-panel-host.ts` 负责：

```ts
openSettings(): void
openProjects(): void
openSkills(): void
openMcp(): void
dispose(): void
```

规则：

- 第一次点击才创建对应面板。
- 面板关闭后保留实例，`dispose()` 时统一销毁。
- Focus 内设置/项目/MCP 只读；不允许调用 `policy.set` 或 `workspace.set`。
- 需要修改时显示“打开工作台修改”。
- “打开工作台”调用：

```ts
window.__studioOpenWorkbench?.();
```

若不可用，提示“请从系统托盘打开工作台”，不得假装已打开。

### 9.8 测试

新建 `tests/desktop/studio-ui-lifecycle.test.ts`（若 C1 已建则扩展）：

- 登录页不挂载 rail。
- bot 窗口不挂载 rail。
- 主窗口挂载 1 个 rail、1 个 composer 动作条、1 个状态 chip。
- 连续 mount/destroy 3 次，订阅数回到基线。
- `account-block` 覆盖层仍然存在且不可关闭。
- 原生消息区不被覆盖：断言 Focus 根节点没有全屏 fixed 白底。
- 登录页、bot 窗口不创建 Shadow host。
- Focus 内“设置/项目/技能/MCP”只读，不调用 `policy.set` / `workspace.set`。
- 关闭懒挂载面板后不遗留全局事件订阅。

### 9.9 C4 构建门禁

C4 第一次执行 `npm run build:inject` 前，必须同时满足：

1. C0-1 已判定 `PASS`。
2. `logs/ui-refactor-baseline/entry.js.bak` 存在且 hash 已记录。
3. 当前 `src/desktop/entry.ts` 的 `onStreamDelta` 与登录页判断仍在。
4. 构建前记录 `Get-Item src-tauri/inject/entry.js` 的 size/hash。

构建后必须：

```powershell
Get-FileHash src-tauri/inject/entry.js -Algorithm SHA256
git diff --stat -- src-tauri/inject/entry.js
Get-Item src-tauri/inject/entry.js | Select-Object Length
```

若体积超过 450,000 B，停止并回到 C4 缩小范围，不得继续 C5。

---

## 10. C5：Workbench 壳与入口

### 10.1 目标

把 `src/ui/agent.html` 从 MVP 骨架升级为三栏 Workbench，并补真实 Tauri 入口。

### 10.2 新建

```text
src/ui/workbench/workbench-types.ts
src/ui/workbench/workbench-state.ts
src/ui/workbench/workbench-ws.ts
src/ui/workbench/workbench-app.ts
src/ui/workbench/workbench-shell.ts
src/ui/workbench/workbench-left-panel.ts
src/ui/workbench/workbench-center.ts
src/ui/workbench/workbench-inspector.ts
src/ui/workbench/workbench-composer.ts
src/ui/workbench/workbench-statusbar.ts
```

### 10.3 修改

```text
src/ui/agent.html
src/ui/agent.css
src/ui/agent-panel.ts
src/api/server.ts（仅当静态资源路径需要调整）
src/host/agent-channel.ts
src-tauri/src/main.rs
src-tauri/capabilities/default.json
```

### 10.4 CSS 交付路径（M7）

本期固定两条路径，不得混用：

1. **Workbench（`/agent`）**：独立页面，继续使用 `src/ui/agent.css`。`design-tokens.ts` 生成 CSS 变量，通过 `agent.css` 的 `:root` 或页面初始化脚本写入；Workbench 不进入 Shadow DOM。
2. **Focus 注入组件**：进入真实 Shadow DOM，样式由 `mountShadowRoot().mountStyle()` 注入，不依赖全局 `agent.css`。

禁止：

- 把 Workbench 整体塞进 Shadow DOM。
- 在 Shadow DOM 内引用 `/agent.css`。
- 同时在全局和 Shadow 内维护两套按钮/卡片样式而不说明来源。

落地方式：

- 新建 `src/ui/workbench/workbench-theme.ts`，把 `light/dark` token 转成 `--studio-*` CSS 变量并写到 `document.documentElement.style`。
- `agent.css` 只消费 `var(--studio-*)`，不得再硬编码第 3.2 节色值。
- Focus 的 `mountShadowRoot()` 接收同一 token 生成的 CSS 文本。

### 10.5 构建产物时效（M9）

C5 开工前执行：

```powershell
$srcNewest = Get-ChildItem src -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$panel = Get-Item dist/agent-panel.js
if ($srcNewest.LastWriteTime -gt $panel.LastWriteTime) { npm run build:inject }
```

要求：

- 若 `dist/agent-panel.js` 落后源码，先重建，再跑 Workbench 测试。
- 记录重建前后 `dist/agent-panel.js` 的 size 与 LastWriteTime。
- 不得用旧 bundle 截图当验收证据。

### 10.6 `agent.html` 结构

必须包含：

```text
app
├── topbar
│   ├── brand
│   ├── workspace
│   ├── connection
│   └── open-focus
├── main.workbench-layout
│   ├── left-rail
│   ├── left-panel
│   ├── center-canvas
│   ├── right-inspector
│   └── inspector-drawer（窄屏）
├── composer
└── statusbar
```

要求：

- 不新增 `/workbench` 路由；升级 `/agent`。
- 不把 token 写进日志。
- `__STUDIO_TOKEN__` 占位符保留，由 `src/api/server.ts` 注入。
- 所有静态文案用中文。

### 10.7 Workbench 布局

```text
顶部栏        48px
左侧 rail     56px
左侧面板      272px
右侧 Inspector 360px（>=1440）
右侧 Inspector 320px（1200–1439）
状态条        28px
中栏最小宽度  520px
```

响应式：

- `>=1440`：三栏展开。
- `1200–1439`：右栏 320px。
- `<1200`：右栏为抽屉，左栏折叠成 rail。
- `<900`：显示桌面提示，隐藏工作台主体。

### 10.8 Workbench 状态模型

`workbench-state.ts` 只允许以下状态：

```ts
export interface WorkbenchState {
  connection: 'connecting' | 'connected' | 'disconnected' | 'auth-failed';
  running: boolean;
  workspaceRoot: string | null;
  policyMode: PolicyMode;
  bots: Array<{ botId: string; running: boolean }>;
  events: AgentLoopEvent[];
  toolRuns: ToolRunEvent[];
  lastError: string | null;
}
```

规则：

- `connection` 只由 WS 事件驱动。
- `running` 只由 state/done/error 驱动，不由 UI 自行猜。
- 断线后禁用发送/停止，显示“连接断开，重试中”。
- 1008 鉴权失败显示“鉴权失败，请重启应用”，不自动重连。

### 10.9 WS 协议

`workbench-ws.ts` 处理：

- `{type:'state'}` → 更新 workspace/policy/bots/running。
- `{type:'event', event}` → 追加消息/工具计数。
- `{type:'tool-run', event}` → 追加工具卡片。
- `{type:'chat-room-event', event}` → 本期只忽略或记录，不渲染假聊天室。
- `{type:'ack'}` → 处理 `set-policy` / `set-workspace` / `pick-folder` 结果。

请求：

```text
send / stop / set-policy / set-workspace / pick-folder / get-state
```

权限切换必须走 `/agent-ws` 的 `set-policy`，不得调用 `callHostTool('policy.set')`。

### 10.10 Tauri Workbench 入口

在 `src-tauri/src/main.rs` 扩展现有入口，不新建第二个托盘：

1. `workbench_url()`：读取 `~/.config/deepseek-studio/config.json` 的 host/port，默认 `127.0.0.1:8760`，返回 `http://host:port/agent`。
2. `#[tauri::command] fn open_workbench(app: AppHandle) -> Result<(), String>`：
   - 已有 `workbench` 窗口则 `show` + `unminimize` + `set_focus`。
   - 否则创建 `WebviewWindowBuilder::new(&app, "workbench", WebviewUrl::External(url))`。
   - 标题 `DeepSeek++ Studio · 工作台`。
   - 尺寸 1440×900，最小 1024×720。
3. `#[tauri::command] fn focus_main_window(app: AppHandle) -> Result<(), String>`。
4. `invoke_handler(tauri::generate_handler![open_workbench, focus_main_window])`。
5. 扩展现有 `main-tray`（`src-tauri/src/main.rs:531`）菜单，增加：

```text
打开工作台
显示主窗口
隐藏主窗口
退出
```

6. 使用 `MenuItemBuilder::with_id("open-workbench", "打开工作台").build(app)` 与 `MenuBuilder` 构建菜单，再传给现有 `TrayIconBuilder.menu(&menu)`；禁止再创建 `TrayIconBuilder::with_id("workbench-tray")` 之类的第二托盘。
7. 主窗口初始化脚本增加：

```js
window.__studioOpenWorkbench = () => window.__TAURI_INTERNALS__?.invoke('open_workbench');
window.__studioFocusMain = () => window.__TAURI_INTERNALS__?.invoke('focus_main_window');
```

如果 `__TAURI_INTERNALS__` 不可用，Focus 按钮必须降级为提示，不得抛异常。

8. `src-tauri/capabilities/default.json`：

```json
{
  "windows": ["main", "workbench"],
  "permissions": ["core:default"]
}
```

9. Rust 验收必须执行：

```powershell
Set-Location src-tauri
cargo check
Set-Location ..
```

`cargo check` 未通过，C5 不得停止为“完成”。

### 10.11 测试

新建：

```text
tests/desktop/workbench-state.test.ts
tests/desktop/workbench-shell.test.ts
```

必须覆盖：

- state 更新后 connection/running/policy 正确。
- 断线后 running 变 false，发送禁用。
- 1008 不自动重连。
- 三栏节点存在。
- `<900` 显示桌面提示。
- 右栏抽屉开关不改变中栏最小宽度。
- Workbench 不进 Shadow DOM，样式来自 `agent.css` 与 `--studio-*` 变量。
- 托盘仍是 `main-tray`，不存在第二个 tray id。
- `open_workbench` 已存在时只 show/unminimize/focus，不重复创建窗口。

---

## 11. C6：任务组件

### 11.1 目标

只渲染有真实数据源的组件；没有数据就显示空态，不制造假能力。

### 11.2 组件 → 数据源映射表（M8）

施工前必须按此表接线；表中没有的数据源，一律显示空态，不得造 mock：

| 组件 | 唯一数据源 | 取数方式 | 空态/兜底 |
|---|---|---|---|
| Message（user/assistant） | `AgentLoopEvent` | `/agent-ws` 的 `{type:'event'}` | 无事件显示欢迎空态 |
| Reasoning | 当前无 | 无 | 不渲染；不得猜测 |
| ToolCallCard | `ToolRunEvent` | `{type:'tool-run'}` | 未知工具 → UnknownToolCard |
| DiffReview | `ToolRunEvent.details` 白名单字段 | 同上 | 无行级 before/after 显示只读摘要 |
| ApprovalCard | 无 Workbench 审批通道 | 无 | 只显示“到宿主窗口处理” |
| ArtifactCard | `ToolRunEvent.artifactPaths` | 同上 | 空数组不渲染 |
| ErrorCard | `AgentLoopEvent.error` + `ui-error-codes.ts` | event / tool-run | 未知 code 显示原 code |
| PermissionCard | `state.policyMode` / `set-policy` ack | WS state + ack | 修改中显示 pending，不本地假成功 |
| ConnectionChip | `state.connection` | WS 生命周期 | 断线显示重试/鉴权失败 |
| WorkspaceChip | `state.workspaceRoot` | WS state / set-workspace ack | 未配置显示“未选择工作区” |
| BotList | `state.bots` | WS state | 空数组显示“无运行中 Bot” |
| StatusBar | connection/running/lastError | WS state/event | 不得自行推断 running |

硬规则：

- 组件文件里出现 `mock`、`sample`、`placeholder data` 视为失败。
- 组件不得直接 `fetch`；统一由 `workbench-ws.ts` 提供状态。
- 任何“按钮”必须有真实请求与 ack/state 回传；没有通道就禁用或改成说明文本。

### 11.3 新建

```text
src/ui/workbench/components/message.ts
src/ui/workbench/components/reasoning.ts
src/ui/workbench/components/tool-call-card.ts
src/ui/workbench/components/diff-review.ts
src/ui/workbench/components/approval-card.ts
src/ui/workbench/components/artifact-card.ts
src/ui/workbench/components/error-card.ts
src/ui/workbench/components/permission-card.ts
src/ui/workbench/components/unknown-tool-card.ts
src/ui/workbench/components/empty-state.ts
```

### 11.4 组件规则

#### Message

- 用户消息与助手消息用行式布局，不用彩色气泡区分 Agent。
- Markdown 必须经过 sanitizer。
- 代码块支持语言标签与复制。
- 长文本可换行，不横向撑破中栏。

#### Reasoning

- 当前没有 reasoning 数据源时不渲染。
- 未来有真实字段时默认折叠。
- 不根据普通 assistant 文本猜测“思考过程”。

#### ToolCallCard

输入 `ToolRunEvent`：

- `started`：运行中，显示工具名、摘要、耗时占位。
- `succeeded`：成功，显示耗时、退出码（如有）。
- `failed`：错误，显示错误码中文映射。
- `denied`：显示“被拒绝”与原因。
- `cancelled`：显示“已取消”。

未知工具交给 `UnknownToolCard`，不得 switch 崩溃。

#### DiffReview

本期只做只读变更摘要：

- 有 `details.path`：显示路径。
- 有 `replacements / bytesBefore / bytesAfter / sha256Before / sha256After`：显示摘要。
- 没有真实 before/after 文本时，显示“当前后端未提供行级 diff”，不显示逐块接受/拒绝按钮。
- 不允许伪造“全部接受/全部拒绝”操作。

#### ApprovalCard

本期只读：

```text
审批仍在宿主窗口完成
[打开宿主窗口] 或 [请到主窗口处理]
```

- 不显示三个假按钮。
- 不显示“始终允许”。
- 不把 Plan 批准当成工具授权。

#### ArtifactCard

- 只展示 `ToolRunEvent.artifactPaths` 中真实存在的路径。
- 没有路径时不渲染，或显示空态。
- 不根据工具名猜测产物。

#### ErrorCard

- 使用 `src/shared/ui-error-codes.ts` 的中文映射。
- 未知错误码显示原始 code + 通用说明，不白屏。

#### PermissionCard

- 显示当前 policy。
- Focus 只读。
- Workbench composer 通过 `set-policy` 修改。
- 修改后等待 state 回传，不能本地先假装成功。

### 11.5 测试

新建：

```text
tests/desktop/workbench-components.test.ts
tests/desktop/ui-error-codes.test.ts
```

必须覆盖：

- 未知工具不崩溃。
- 缺失 `details` 不崩溃。
- 空 `artifactPaths` 不渲染。
- 超长文本不横向溢出。
- denied / failed / cancelled 文案正确。
- ApprovalCard 没有“始终允许”。
- DiffReview 没有假的逐块按钮。
- 组件层没有 mock/sample 数据。
- 每个组件至少有一条“空数据 → 空态”测试。
- PermissionCard 在 ack 前不显示成功。

---

## 12. C7：安全与可访问性

### 12.1 目标

把 Markdown、动态 HTML、焦点、Esc、动效和错误处理补齐。

### 12.2 依赖

只允许新增：

```powershell
npm install dompurify@3.4.17
```

要求（M15）：

- `package.json` 必须精确锁定 `"dompurify": "3.4.17"`，不使用 `^` / `~`。
- 先检查 `3.4.17` 是否自带类型；只有确实缺类型时才安装匹配的 `@types/dompurify`，并在接力状态记录原因。
- 构建后记录 `entry.js` 体积增量；总上限仍是 450,000 B。
- 不引入其它 sanitizer 或 Markdown 框架。
- DOMPurify 只在 Markdown 渲染出口使用；不得在组件里零散调用。

### 12.3 `src/inject/markdown.ts`

改为：

```ts
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(text: string): string {
  const html = marked.parse(String(text ?? ''), { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
  });
}
```

要求：

- 失败时回退到 HTML 转义纯文本。
- `img onerror`、`javascript:` 链接、`<script>`、`onclick` 必须被拦截。
- 不关闭 sanitizer 换性能。
- `marked` 的输出必须先完整生成 HTML，再一次性交给 `DOMPurify.sanitize`；不得在 marked 的 renderer 里跳过 sanitize。
- `renderMarkdown` 返回 `string` 的契约保持不变，避免调用方大改。

### 12.4 动态 HTML 审计

处理以下文件的业务数据拼接：

```text
src/ui/studio-chat-ui.ts
src/ui/studio-chat-room.ts
src/ui/studio-project-picker.ts
src/ui/studio-right-sidebar.ts
src/ui/studio-skills-panel.ts
src/ui/studio-settings-panel.ts
src/ui/studio-ui-core.ts
src/inject/tool-card-ui.ts
```

规则：

- 业务数据用 `textContent` / `replaceChildren` / DOM 构造。
- 静态模板可以保留 `innerHTML`，但不得插入变量。
- `el({ html })` 只允许静态模板；新增调用必须注释来源。
- 对必须保留的 HTML，先 sanitize。

### 12.5 可访问性

`src/ui/primitives/dialog.ts` 必须：

- `role="dialog"` / `aria-modal="true"`。
- 打开时保存 activeElement，关闭时恢复焦点。
- Tab / Shift+Tab 焦点陷阱。
- Esc 关闭（account-block 除外）。
- 点击遮罩关闭只用于普通对话框；审批/身份锁按各自规则。

全局：

- 所有图标按钮有 `aria-label`。
- 状态点有文本等价物。
- `prefers-reduced-motion: reduce` 时关闭非必要动画。
- 错误不静默吞：至少 `console.warn` 带上下文。

Workbench 三栏可访问性（M11）：

- `main.workbench-layout` 使用语义化 `nav` / `main` / `aside`，并给可折叠区域加 `aria-expanded`。
- 左 rail 的每个图标按钮有 `aria-label`，当前项有 `aria-current="page"`。
- Inspector 抽屉打开时：保存 `activeElement`、焦点移入抽屉、Tab 循环、Esc 关闭、关闭后恢复焦点。
- 断线、降级、pending 状态通过 `aria-live="polite"` 播报。
- 所有动画包在 `@media (prefers-reduced-motion: no-preference)` 或提供 reduce 覆盖。
- `<900px` 的桌面提示本身可被读屏读到，不是纯装饰 div。

### 12.6 旧面板迁移收口（M14）

C7 必须产出迁移清单，至少覆盖：

```text
studio-chat-room.ts
studio-input-bar.ts
studio-mcp-dialog.ts
studio-project-picker.ts
studio-right-sidebar.ts
studio-settings-panel.ts
studio-sidebar.ts
studio-skills-panel.ts
```

每个文件只能处于以下一种状态：

- `migrated`：改用 `mountShadowRoot()`，`createShadowContainer()` 调用为 0。
- `deprecated-unreachable`：不再被任何入口 import，且有 `rg` 证据。
- `retained-with-reason`：必须写明为什么本期不能迁移，并给出下一期 checkpoint。

验收命令：

```powershell
rg -n "createShadowContainer\\(" src/ui
rg -n "injectStyles\\(" src/ui
```

若仍有两套 Shadow API 同时服务可达 UI，C7 不得通过。

### 12.7 测试

新建：

```text
tests/desktop/markdown-sanitize.test.ts
tests/desktop/ui-dialog.test.ts
tests/desktop/ui-error-codes.test.ts
```

必须覆盖：

- `<img src=x onerror=alert(1)>` 不保留 onerror。
- `[x](javascript:alert(1))` 不生成可执行链接。
- `<script>alert(1)</script>` 被移除。
- Dialog Tab 循环、Esc、焦点恢复。
- account-block 仍然没有 Esc/点外关闭。
- Inspector 抽屉焦点陷阱与恢复。
- `prefers-reduced-motion: reduce` 下无关键帧动画。
- 旧面板迁移清单与 `rg` 结果一致。

---

## 13. C8：Logo、打包、最终验收

### 13.1 Logo

唯一素材：

```text
E:\NAS\deepseek-studio\docs\设计稿\app-icon-v1.png
```

这是“替换现有图标”，不是首次生成（M4）。当前 `src-tauri/icons/` 已有 19 个文件，`tauri.conf.json` 只引用 `icons/icon.png`。

执行：

```powershell
npm run tauri -- icon docs/设计稿/app-icon-v1.png
```

要求：

- 保留原图，不覆盖。
- 不手工逐个缩放。
- 检查 `src-tauri/icons` 生成结果。
- 生成前后分别记录 `src-tauri/icons` 文件清单与 hash，避免把旧图标误当新图标。
- 必须明确列出本次替换的尺寸：`32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico`、`icon.png`。
- `src-tauri/tauri.conf.json` 的 `bundle.icon` 至少包含：

```json
[
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.icns",
  "icons/icon.ico"
]
```

- 验收任务栏、窗口、安装包三处图标一致。
- 若 `tauri icon` 生成额外文件，记录但不删除；不得手工伪造 `.icns` / `.ico`。

### 13.2 构建

```powershell
npm run build:inject
npm run typecheck
npx vitest run
git diff --check
```

注意：`build:inject` 会重写 `src-tauri/inject/entry.js`。构建后必须：

```powershell
Get-Item src-tauri/inject/entry.js, dist/agent-panel.js | Select-Object FullName,Length,LastWriteTime
git diff --stat -- src-tauri/inject/entry.js
```

只允许出现预期变化；不得用 git 还原用户修改。体积超预算即停止。

### 13.3 最终人工验收

1. 启动应用，主窗口登录页：无 Studio rail、无 overlay、二维码可点。
2. 登录后主窗口：Focus rail 可见，原生消息区可滚动、可点击。
3. Focus composer 动作条不覆盖原生 composer。
4. 托盘“打开工作台”能创建或聚焦 Workbench。
5. Workbench 三栏在 1440 展开，在 1280 右栏收窄，在 1024 右栏抽屉。
6. `<900` 显示桌面提示，不强行挤三栏。
7. 发送任务后，工具卡片按 started → succeeded/failed 更新。
8. 未知工具显示 UnknownToolCard，不崩溃。
9. Workbench 不显示假审批、假 Plan、假终端、假逐块 diff。
10. account-block 仍为全屏不可关闭红底。
11. 断网/关闭 sidecar 后，Workbench 显示断线，发送禁用。
12. 任务栏/窗口/安装包图标一致。

---

## 14. 自动化验收命令

每个 checkpoint：

```powershell
git fetch
git status --short
npm run typecheck
npx vitest run
git diff --check
```

涉及注入或 Workbench bundle：

```powershell
npm run build:inject
```

涉及契约、边界、覆盖率、空文件（C1/C3/C5/C7 至少各一次，最终 C8 必跑）：

```powershell
npx tsx tools/audit/boundary.ts
npx tsx tools/contract/check.ts
npx tsx tools/coverage/check.ts
npx tsx tools/audit/empty-files.ts
```

涉及 Rust（C5）：

```powershell
Set-Location src-tauri
cargo check
Set-Location ..
```

涉及 bundle 的每个 checkpoint 都记录：

```powershell
Get-Item src-tauri/inject/entry.js, dist/agent-panel.js | Select-Object FullName,Length,LastWriteTime
```

最终：

```powershell
npm run gate
```

注意：当前 `npm run gate` 会因既有 3 条 vitest 失败而停在 vitest 步骤。不要写“gate 全绿”；应写“gate 在既有基线处停止，新增失败 0”。

若 vitest 基线未变化但 gate 被既有红灯挡住，必须单独运行并记录后四个阻塞检查：

```powershell
npx tsx tools/audit/boundary.ts
npx tsx tools/contract/check.ts
npx tsx tools/coverage/check.ts
npx tsx tools/audit/empty-files.ts
```

不得只写“gate 没跑完”而不跑这四项。

建议新增测试文件：

```text
tests/desktop/ui-tokens.test.ts
tests/desktop/ui-contract.test.ts
tests/desktop/ui-shadow-root.test.ts
tests/desktop/studio-ui-lifecycle.test.ts
tests/desktop/host-layout-adapter.test.ts
tests/desktop/tool-run-event.test.ts
tests/desktop/agent-channel-tool-run.test.ts
tests/desktop/workbench-state.test.ts
tests/desktop/workbench-components.test.ts
tests/desktop/markdown-sanitize.test.ts
tests/desktop/ui-dialog.test.ts
tests/desktop/ui-error-codes.test.ts
```

---

## 15. 失败、回滚与接力

### 15.1 单个 checkpoint 失败

必须停止，不得继续下一个 checkpoint。记录：

- 失败命令。
- 完整错误摘要。
- 已修改文件。
- 是否新增失败。
- 是否触碰 `entry.js`。
- 回滚点。

### 15.2 回滚规则

禁止：

```text
git reset --hard
git checkout --
git restore
```

checkpoint 提交/回退策略（H5）：

- 默认不自动 commit；只有用户明确要求提交时才提交。
- 用户要求提交时，只允许文件级暂存本 checkpoint 明确修改的文件。
- 禁止 `git add -A`、`git add .`、`git commit -a`，因为会误提交用户已有 `src-tauri/inject/entry.js`、docs、logs、设计稿。
- `entry.js` 只有在 C0-1 PASS 且属于当前 checkpoint 预期变化时才允许单独 `git add -- src-tauri/inject/entry.js`。
- 每个通过 checkpoint 在接力状态记录一个逻辑回滚点：`C{n}-pass` + 文件清单 + hash。

只允许回滚自己刚做的修改：

1. 先确认路径。
2. 保存当前 diff。
3. 使用编辑器撤销或 `git diff -- <files>` 生成补丁后反向应用。
4. 不碰用户已有的 `entry.js`、docs、logs、设计稿。

回滚前必须核对：

```powershell
git status --short
git diff -- <本 checkpoint 文件清单>
```

如果无法区分“自己改的”与“用户已有改动”，停止并询问用户，不得猜。

### 15.3 豆包额度耗尽

额度耗尽前必须：

1. 停止在 checkpoint 边界，不留下半成品。
2. 更新 `docs/前端开发计划/接力状态.md`。
3. 记录最后通过的命令。
4. 记录未完成项与下一步入口。
5. 不提交、不推送，除非用户明确要求。
6. 记录最后一个通过 checkpoint 的文件 hash、bundle size、测试数字。
7. 明确 C0-1 是否 PASS；若未 PASS，下一执行者不得进入 C4。

下一个执行者只从最后一个通过 checkpoint 继续，不重跑已完成的重构。

---

## 16. 接力状态模板

路径：

```text
docs/前端开发计划/接力状态.md
```

模板：

```markdown
# Studio UI 接力状态

- 更新时间：
- 当前分支：
- 当前 HEAD：
- 当前 checkpoint：
- 主执行者：

## C0 前置门禁

- C0-0 git fetch / upstream：
- C0-1 entry.js 实体备份 + 临时 outfile 重建：
- C0-2 安全红线用例状态：
- C0-3 mutable-workspace.test.ts 处置：
- C0-4 jsdom Shadow / adoptedStyleSheets：
- C0-5 bundle 体积基线：
- C0-6 cargo 工具链：
- C4 是否允许开工：是 / 否

## 已完成

- 

## 未完成

- 

## 修改文件

- 

## 命令结果

### git status --short

```text

```

### npm run typecheck

```text

```

### npx vitest run

```text
文件数：
测试数：
通过：
失败：
新增失败：
```

### npm run build:inject

```text

```

### cargo check

```text

```

### 契约 / 边界 / 覆盖率 / 空文件

```text
boundary:
contract:
coverage:
empty-files:
```

## Bundle 记录

- entry.js：
- dist/agent-panel.js：
- 是否超预算：

## 旧 Shadow API 迁移

- migrated：
- deprecated-unreachable：
- retained-with-reason：

## 基线红灯

- tests/desktop/desktop-entry.test.ts
- tests/desktop/tool-authority.test.ts
- tests/e2e/smoke.test.ts

## 已知风险

- 

## 回滚点

- C__-pass：
- 文件清单：
- hash：

## 下一步

- 从 C__ 开始。
- 入口条件：
```

---

## 17. 交接给下一个壳的提示词

```text
你接手 E:\NAS\deepseek-studio 的 Studio UI 重构接力。

先读：
1. docs/前端开发计划/Studio-UI-豆包施工计划-v1.md
2. docs/前端开发计划/接力状态.md

只从接力状态中的“下一步”开始。先运行：
git fetch
git status --short
npm run typecheck
npx vitest run
git diff --check

先确认接力状态里的 C0-1 是否为 PASS；不是 PASS 时，不得进入 C4，不得执行覆盖 entry.js 的 build。

不要修改用户已有的 src-tauri/inject/entry.js 修改；不要使用 git reset/checkout/restore；不要引入 React/Vite/Monaco/xterm；不要伪造后端没有的能力。

完成后更新接力状态，并报告：
- 修改文件
- typecheck 结果
- vitest 文件数/测试数/通过/失败/新增失败
- C0 门禁是否仍成立
- bundle size
- 契约/边界/覆盖率/空文件结果
- 下一 checkpoint 入口条件
```

---

## 18. 最终完成定义

只有同时满足以下条件，才能说本期完成：

- Focus 模式不遮挡登录页、二维码、原生消息区。
- 全屏白色 chat overlay 不再是默认路径。
- Workbench 有真实 Tauri 入口，三栏响应式可用。
- 权限词表只有一套，面板不下发 `ask`。
- 审批三按钮映射正确，且 Workbench 不伪造审批。
- 工具卡片由 `ToolRunEvent` 驱动，未知工具不崩溃。
- Markdown 经过 sanitizer。
- 重复 mount/destroy 不泄漏。
- 旧 `createShadowContainer()` 已迁移收口，不存在两套 Shadow API 同时服务可达 UI。
- L1/L2 降级有日志和可见状态，不是静默失败。
- Workbench 三栏有焦点管理、ARIA、reduced motion。
- `cargo check` 通过。
- `entry.js` ≤ 450,000 B，`dist/agent-panel.js` ≤ 120,000 B。
- 安全红线用例逐项状态已记录，没有未知 skipped。
- 账号身份锁仍然 fail-closed。
- Logo 已替换并接入。
- 新增测试通过，且没有新增失败。
- `npm run gate` 的失败位置仍是既有 3 条基线，不是新问题。
- 边界 / 契约 / 覆盖率 / 空文件四项阻塞检查已单独运行并记录。

---

## 19. 评审修订记录

本版已并入 2026-10-19 施工评审的 H1-H8 与 M1-M16。处理结果：

- H1：保留风险门禁，删除错误的“源码缺失”前提；改为实体备份 + 临时 outfile 重建证明。
- H2：所有 DOM 测试强制 `@vitest-environment jsdom`；C0-4 探针决定 `adoptedStyleSheets` 主/降级路径。
- H3：C1 明确新增 `EventBus.handlerCount()` / `clear()`。
- H4：旧 `createShadowContainer()` 签名不变，新增 `mountShadowRoot()`；C7 迁移收口。
- H5：增加文件级提交/回退策略；禁止 `git add -A`，默认不自动 commit。
- H6：C5 增加 `cargo check`。
- H7：保留 `mutable-workspace.test.ts`，记录历史文件名，不删除有效测试。
- H8：保留当前 3 失败基线；C0-2 逐项记录安全用例状态。
- M1：C3 明确与 `agent-loop-event.ts` / `tool-event-bus.ts` / `tool-record.ts` 的关系。
- M2：`policy-contract.ts` 只搬迁 + re-export，禁止第二套定义。
- M3：扩展现有 `main-tray`，不新建托盘。
- M4：C8 是替换图标，列出具体尺寸与 hash 记录。
- M5：`entry.js` 401,573 B 基线，450,000 B 硬上限；`dist/agent-panel.js` 120,000 B 上限。
- M6：C4 增加 `src/inject/` 保留/迁移/废弃清单。
- M7：Workbench 走 `agent.css` + CSS 变量；Focus 走 Shadow DOM，禁止混用。
- M8：C6 增加组件 → 数据源映射表，禁止 mock。
- M9：C5 增加产物时效校验与强制重建。
- M10：本期不做 i18n，中文集中定义，不散落复制。
- M11：Workbench 焦点、ARIA、reduced motion 补全。
- M12：L1/L2 降级必须日志 + 状态 chip 可见。
- M13：每个 checkpoint 前 `git fetch`，只记录，不 rebase/merge。
- M14：C7 旧面板迁移收口，不允许两套 Shadow API 长期并存。
- M15：DOMPurify 精确锁 `3.4.17`，记录体积与 sanitize 方式。
- M16：增加四项阻塞检查单独命令；`npm run gate` 不能因既有红灯而跳过它们。

---

*计划结束。执行时以本文件为准；设计稿与评审报告只作为解释材料。*
