# DeepSeek Studio UI 总体设计

> 版本：v1.0  
> 日期：2026-10-19  
> 状态：方向决策稿  
> 关联：`docs/前端开发计划/前端开发计划-v1.md`、`docs/设计稿/设计稿_智能体面板_20261010.md`、`docs/项目总路线图.md`

---

## 0. 结论先行

### 一句话定位

**DeepSeek Studio 是 DeepSeek-native agent workbench，不是聊天页面皮肤，也不是 cuckoo-code / DeepSeek Harness 的克隆。**

### 五个选型结论

| 问题 | 结论 |
|---|---|
| 全自研，还是用开源框架？ | **产品 UI 自研，渲染层使用 React + Vite + TypeScript + CSS Modules** |
| 是否搬运 cuckoo-code？ | **不搬运代码**。只借鉴其宿主适配、纯净聊天模式和设计 token 原则 |
| 是否模仿 DeepSeek Harness？ | **不整体模仿，也不 fork**。借鉴三栏工作台、右侧 Inspector、工具卡片和 Plan / Approval 信息架构 |
| 自研模仿哪个 Agent？ | **不照抄单一 Agent 的视觉**。交互模型主要参考 Codex / Claude Code，产物面板参考豆包工作 / WorkBuddy，品牌语言跟随 DeepSeek |
| 最终 UI 形态 | **一层外壳，两种模式：Focus 模式 + Workbench 模式** |

### 最重要的架构判断

当前实现的核心问题不是“配色不好看”，而是：

1. 所有 UI 都是注入脚本手写 DOM，组件之间没有统一状态和渲染边界。
2. 样式是全局 `<style>`，不是真正的 Shadow DOM，容易和 DeepSeek 页面互相污染。
3. 聊天 overlay 默认用不透明白底覆盖原生消息区，属于“替换页面”而不是“增强页面”。
4. 输入栏和侧栏依赖几何扫描、混淆 class 和 MutationObserver，宿主一改版就整体退化。
5. 安全边界不完整：Markdown 直接 `innerHTML`，没有 sanitizer。

因此，下一步不是继续给现有 overlay 加 CSS，而是先建立**渲染层 + 宿主适配层 + 设计系统**三层边界。

---

## 1. 产品定位与 UI 目标

### 1.1 产品不是什么

- 不是通用 AI 聊天 SaaS。
- 不是 DeepSeek 官网的换色版。
- 不是“左侧文件树 + 中间聊天 + 右侧预览”的模板化 IDE。
- 不是多 Agent 彩色气泡聊天室。

### 1.2 产品是什么

用户打开一个文件夹后，Studio 应该让用户感觉：

> “我在指挥一个能读代码、改代码、跑测试、解释风险的工程搭档。”

而不是：

> “我在一个聊天框里问问题，旁边有几个装饰性按钮。”

### 1.3 UI 必须满足的五个任务

| 任务 | UI 必须回答的问题 |
|---|---|
| 我现在在哪 | 当前项目、当前会话、当前工作区是什么 |
| 我要它做什么 | 输入目标，而不是输入命令 |
| 它正在做什么 | 当前步骤、工具调用、计划、进度、阻塞点 |
| 它改了什么 | diff、文件、产物、测试结果 |
| 我是否允许 | 权限档位、审批请求、风险说明、拒绝后的回填 |

### 1.4 美观的定义

本项目的“美观”不是营销页式的视觉冲击，而是：

- **精密**：信息层级清楚，数字和状态可扫读。
- **克制**：主色只用于操作和状态，不用大面积渐变。
- **可信**：审批、diff、错误、审计都可见，不假装一切顺利。
- **呼吸感**：少边框、多留白，用底色和阴影分层。
- **一致**：所有面板共享同一套 token、圆角、间距和动效。

---

## 2. 推荐 UI 形态：一层外壳，两种模式

### 2.1 为什么需要两种模式

当前只有一个“全屏聊天 overlay”模式，导致两个目标互相冲突：

- 普通聊天时，用户希望看到 DeepSeek 原生页面，登录、历史、推荐问题都保持原样。
- 项目开发时，用户需要一个不被原生页面限制的完整工作台。

用同一个全屏 overlay 同时满足两者，必然出现“遮挡登录框”“盖住消息区”“输入栏错位”等问题。

### 2.2 Focus 模式

**适用场景**：普通问答、轻量任务、首次登录、查看历史会话。

**原则**：原生页面优先，Studio 只做增强。

界面组成：

```text
┌────────────────────────────────────────────────────┐
│ DeepSeek 原生页面                                  │
│                                                    │
│  [Studio rail]  原生消息区                          │
│                                                    │
│                 ┌──────────────────────────────┐   │
│                 │ 原生 composer                │   │
│                 │ [工作区] [权限] [模型] [发送] │   │
│                 └──────────────────────────────┘   │
└────────────────────────────────────────────────────┘
```

Focus 模式只提供：

- 左侧 52–56px 窄 rail。
- composer 上方的轻量动作条。
- 当前工作区、权限档位、引擎状态 chip。
- 工具执行时的临时卡片。
- 不遮挡 DeepSeek 登录页、二维码、原生消息区。

### 2.3 Workbench 模式

**适用场景**：打开项目、多步 Agent 任务、工具调用、diff 审批、测试运行。

**原则**：Studio 接管任务画布，原生页面退居后台。

界面组成：

```text
┌──────────────────────────────────────────────────────────────┐
│ Top Bar  模式切换 | 项目 | 任务标题 | 命令 | 连接状态          │
├──────────┬───────────────────────────────────┬───────────────┤
│ Left     │ Center Task Canvas                │ Right         │
│ Rail     │                                   │ Inspector     │
│ + Panel  │ 任务头                            │ Changes       │
│          │ 对话 / 过程 / 工具卡片             │ Plan          │
│ 项目      │ Plan / Diff / Approval            │ Tasks         │
│ 会话      │ 最终回答 / 产物                    │ Files         │
│ Agent    │                                   │ Preview       │
│ Skills   │                                   │ Terminal      │
│ MCP      │                                   │ Audit         │
├──────────┴───────────────────────────────────┴───────────────┤
│ Composer  输入 | 工作区 | 权限 | 模型 | Plan/Act | 发送/停止  │
├──────────────────────────────────────────────────────────────┤
│ Status Bar  连接 | 权限 | token/cost | 运行状态 | 分支/工作区 │
└──────────────────────────────────────────────────────────────┘
```

### 2.4 模式切换规则

| 事件 | 默认模式 |
|---|---|
| 启动、登录页 | Focus |
| 普通对话 | Focus |
| 打开文件夹 / 项目 | Workbench |
| 出现工具调用或 diff | Workbench |
| 用户手动切换 | 保持用户选择，直到下一次明确事件 |

**必须遵守**：模式切换要有明确视觉反馈，不能让用户不知道当前看到的是 DeepSeek 原生页还是 Studio 工作台。

---

## 3. 信息架构

### 3.1 顶层结构

```text
Studio Shell
├── Top Bar
│   ├── Focus / Workbench 模式切换
│   ├── 项目切换器
│   ├── 当前任务标题
│   ├── 全局命令入口
│   └── 连接 / 运行状态
│
├── Left Rail + Panel
│   ├── 新建任务
│   ├── 项目 / Workspace
│   ├── 会话列表
│   ├── Agent / Bot
│   ├── Skills
│   ├── MCP
│   └── Settings
│
├── Center Task Canvas
│   ├── Task Header
│   ├── Conversation Transcript
│   ├── Reasoning / Process
│   ├── Tool Call Cards
│   ├── Plan Card
│   ├── Diff Review
│   ├── Approval
│   └── Final Answer / Deliverables
│
├── Right Inspector
│   ├── Changes
│   ├── Plan
│   ├── Tasks
│   ├── Artifacts
│   ├── Files
│   ├── Preview
│   ├── Terminal
│   └── Audit / Logs
│
├── Composer
│   ├── 输入框
│   ├── 工作区 chip
│   ├── 权限 chip
│   ├── 模型 / 引擎 chip
│   ├── Plan / Act
│   ├── 附件
│   └── 发送 / 停止
│
└── Status Bar
    ├── 连接状态
    ├── 当前权限
    ├── token / cost
    ├── 运行状态
    └── 当前分支 / 工作区
```

### 3.2 左栏职责

左栏回答“去哪里”：

- 当前项目。
- 历史会话。
- 正在运行的任务。
- Agent / Bot 编排。
- Skills、MCP、设置。

左栏不应该承担“展示当前任务细节”的职责。

### 3.3 中栏职责

中栏回答“任务进行到哪一步”：

- 用户目标。
- 助手最终回答。
- 思考过程（默认折叠）。
- 工具调用（按类型显示）。
- 计划、diff、审批。
- 错误和恢复建议。

中栏不是“卡片仪表盘”，对话和任务流仍是主界面。

### 3.4 右栏职责

右栏回答“现在发生了什么、产出了什么”：

- 本次改动。
- 计划步骤。
- 后台任务。
- 文件、预览、终端。
- 审计日志。

右栏是 Inspector，不是第二个聊天窗口。

---

## 4. 核心组件模型

### 4.1 组件分层

```text
App Shell
├── Layout
│   ├── TopBar
│   ├── LeftRail
│   ├── LeftPanel
│   ├── CenterCanvas
│   ├── RightInspector
│   ├── Composer
│   └── StatusBar
├── Task
│   ├── TaskHeader
│   ├── Conversation
│   ├── Message
│   ├── Reasoning
│   ├── ToolCallCard
│   ├── PlanCard
│   ├── DiffReview
│   ├── ApprovalCard
│   ├── ArtifactCard
│   └── ErrorCard
├── Primitives
│   ├── Button
│   ├── Input
│   ├── Dialog
│   ├── Menu
│   ├── Tooltip
│   ├── Tabs
│   ├── Badge
│   └── StatusDot
└── Host Adapters
    ├── HostLayoutAdapter
    ├── HostComposerAdapter
    ├── HostThemeAdapter
    └── HostNavigationAdapter
```

### 4.2 工具调用卡片

工具调用不能混成普通消息气泡。每种工具应有明确的生命周期和视觉语义：

| 工具类型 | 卡片内容 |
|---|---|
| 文件读取 | 路径、行数、摘要、展开原文 |
| 文件修改 | 路径、增删行数、diff 入口 |
| Shell | 命令、cwd、退出码、耗时、stdout/stderr |
| 搜索 | 查询、命中数、结果列表 |
| Web | URL、状态、摘要、引用 |
| MCP | server、tool、参数、结果 |
| 测试 | 命令、通过/失败、失败用例 |

统一状态：`pending` → `running` → `success` / `error` / `denied` / `cancelled`。

### 4.3 Plan / Approval

Plan 和 Approval 是独立工作流，不是普通消息：

- Plan Card 显示步骤、当前步骤、阻塞点。
- Approval Card 显示风险、影响范围、允许/拒绝/始终允许。
- Diff Review 显示文件、增删行、逐块接受/拒绝。

### 4.4 多 Bot / 多 Agent

不要用不同颜色的聊天气泡区分 Agent。

推荐：

- 顶部显示参与者 strip。
- 消息头显示角色、名称、状态。
- 子 Agent 默认折叠成任务分支。
- 用中性色 + 角色标签 + 状态点区分。
- 取消现有紫色 `#8b5cf6`，改用品牌蓝、青绿或中性色。

---

## 5. 视觉系统

### 5.1 视觉关键词

> 精密、克制、可信、像工作台，不像营销页。

### 5.2 色彩

| 角色 | 色值 | 用途 |
|---|---|---|
| 主色 | `#4D6BFE` | 主按钮、激活态、关键状态 |
| 主色悬停 | `#3B5BDB` | 按钮悬停 |
| 主色柔光 | `rgba(77,107,254,0.08)` | 选中底色、弱高亮 |
| 主文字 | `#16181D` | 正文 |
| 次文字 | `#5B6170` | 辅助说明 |
| 弱文字 | `#8A8F9B` | 标签、占位 |
| 页面背景 | `#F7F8FA` | 工作台背景 |
| 面板背景 | `#FFFFFF` | 卡片、面板 |
| 次级背景 | `#F5F6F8` | 输入框、列表项 |
| 边框 | `rgba(16,24,40,0.08)` | 发丝边框 |
| 成功 | `#2E9E6B` | 成功状态 |
| 警告 | `#B7791F` | 警告状态 |
| 错误 | `#D64545` | 错误状态 |
| 深色背景 | `#111318` | 深色模式基础 |

禁止：

- 子 Bot 紫色 `#8b5cf6`。
- 到处渐变。
- 大量玻璃拟态。
- 大量全屏纯白 overlay。
- 巨型圆角卡片。
- 无意义的悬浮缩放。

### 5.3 字体

| 用途 | 字体 |
|---|---|
| 中文 | MiSans / PingFang SC / Microsoft YaHei / Noto Sans SC |
| 代码 | Cascadia Code / JetBrains Mono |
| 数字 | 使用 `font-variant-numeric: tabular-nums` |

首版不要引入大型字体包，先使用系统字体，再考虑品牌字体。

### 5.4 尺寸

| 元素 | 尺寸 |
|---|---|
| 顶部栏 | 44–48px |
| 左侧 rail | 52–56px |
| 左侧面板 | 260–280px |
| 右侧 Inspector | 320–420px |
| 状态条 | 28px |
| 内容宽度 | 760–860px |
| 间距基线 | 4px |
| 圆角 | 8 / 12 / 16px |
| 正文 | 13–14px |
| 代码 | 12–13px |

### 5.5 动效

只保留有意义的：

- 侧栏滑入。
- 任务开始状态。
- 流式光标。
- 工具卡片进入。
- 运行中状态脉冲。
- 面板展开/收起。

不要给每个按钮加缩放和弹跳动画。

### 5.6 深浅色

建议跟随系统，使用 CSS 变量维护两套 token。首版可以只实现浅色，但 token 结构必须预留深色，避免后续重写。

---

## 6. 技术选型

### 6.1 推荐栈

| 层 | 选型 | 理由 |
|---|---|---|
| 渲染 | React 18 + Vite + TypeScript | 生态成熟，适合复杂状态和多面板 |
| 样式 | CSS Modules + CSS Variables | 隔离样式，保留设计自由度 |
| 无障碍原语 | Radix UI 或 React Aria | 只做无样式 primitives，不引入整套视觉 |
| 代码/diff | Monaco Editor | 成熟，适合代码预览和 diff |
| 终端 | xterm.js | 事实标准 |
| Markdown | marked / markdown-it + DOMPurify | 必须 sanitize |
| 公式 | KaTeX | 数学内容 |
| 高亮 | Shiki | 代码高亮质量好 |
| 图标 | 内联 SVG 线条图标 | 不依赖 emoji 或图标字体 |

### 6.2 不推荐

- 继续堆手写 DOM。
- 全局 `<style>` + 大量硬编码 z-index。
- Ant Design / MUI / Element 这类整套视觉框架。
- 直接迁移成 Harness 式完整插件系统。
- 一开始就做全功能多 Agent 工作台。

### 6.3 “自研”的边界

“自研”指：

- 产品信息架构。
- 布局。
- 组件组合方式。
- 设计 token。
- Agent 任务交互模型。

不等于：

- 所有基础控件都从零手写。
- 不用开源渲染框架。
- 不用无障碍 primitives。

---

## 7. 对 cuckoo-code 的取舍

### 7.1 事实

- Electron。
- TypeScript。
- 原生 DOM / HTML / CSS 为主。
- GPL-3.0-only。
- 壳窗口 + WebContentsView 承载 AI 网页。
- 另有独立 `harness.html` 纯净聊天模式。

### 7.2 可借鉴

- 宿主适配经验。
- Focus / 纯净聊天模式。
- 会话、文件、技能、MCP 的页面组织。
- 设计 token 原则：少边框、多留白、主色克制、跟随系统深浅色。
- 4px 细滚动条、12px 卡片圆角、14–16px 面板内边距。

### 7.3 不可直接搬运

- GPL-3.0 会带来许可证耦合。
- Electron 架构与当前 Tauri 注入架构不同。
- 功能面很宽，代码结构偏原生 DOM。
- “壳窗口 + WebContentsView”不适合直接复制到当前项目。

### 7.4 结论

> cuckoo-code 可作为交互和视觉原则参考，不应作为代码基座搬运。

---

## 8. 对 DeepSeek Harness 的取舍

### 8.1 事实

- MIT。
- Electron 壳。
- 内部加载完整 dsh Web 应用。
- React 18 + Vite。
- CSS Modules。
- `--dsw-*` 设计 token。
- 插件化 UI package。
- 独立工作台，不是向 DeepSeek 页面注入 overlay。

### 8.2 可借鉴

- 三栏 AppFrame。
- 左侧栏 264–420px，折叠后保留 56px rail。
- 右侧 Inspector 可展开，初始约 45%，最大 70%。
- 中间至少保留 400px。
- Conversation Node / Message / Tool Call Tree / Reasoning / Turn Process。
- Plan、Goal、Deliverables、Approval、Token Usage、Stats Pills。
- 工具调用有明确生命周期和类型。
- 复杂过程默认折叠，最终答案优先。
- Markdown sanitize 边界。
- 键盘焦点、Escape、focus trap、reduced motion。

### 8.3 不可整体模仿

- 它是完整独立 Electron 工作台。
- 当前 Studio 是 Tauri + 注入式宿主页面。
- UI 包体系、Cordis slot、Host/Client 协议非常庞大。
- 直接 fork 会引入远超当前项目承载力的复杂度。

### 8.4 结论

> 借鉴 Harness 的信息架构、组件边界和交互模型，不复制它的代码，也不照搬它的独立 Electron 壳。

---

## 9. 应该向谁借鉴

不是“模仿某一个 Agent”，而是分工借鉴：

| 来源 | 借鉴内容 |
|---|---|
| Codex / Claude Code | 任务执行、工具调用折叠、Plan / Act、diff 审批、权限状态 |
| DeepSeek Harness | 三栏工作台、右侧 Inspector、Conversation Node、工具卡片分类、Plan / Approval |
| cuckoo-code | 注入宿主适配、纯净聊天模式、会话/文件/技能/MCP 页面组织、设计 token 原则 |
| 豆包工作 / WorkBuddy | 右侧产物/任务面板、项目工作流、文件预览 |
| DeepSeek 官方 | 主色、字体气质、composer 交互、页面留白 |

不要：

- 照抄 Codex 的视觉。
- 照抄 Claude 的视觉。
- 照抄豆包或 WorkBuddy 的卡片布局。
- 直接复制 cuckoo 代码。
- 直接 fork Harness。

---

## 10. 迁移路线

### P0：冻结基线

- 修复或登记现有红灯测试。
- 记录真实测试数。
- 截图当前登录页、聊天页、侧栏、设置、MCP、授权弹窗。
- 确认 `src-tauri/inject/entry.js` 和未跟踪设计稿不被覆盖。

### P1：UI 基础层

- `design-tokens.ts`。
- `app-shell.tsx`。
- `button/input/dialog/menu/tooltip/tabs/badge`。
- 真正的 Shadow DOM 根容器。
- 统一 CSS 注入，避免重复追加。
- 统一 z-index token。

### P2：宿主适配层

- `host-layout-adapter.ts`。
- 封装 composer 测量、侧栏测量。
- 提供 fallback。
- 宿主 DOM 变化时不整体崩溃。

### P3：Focus 模式

- 原生 DeepSeek 保持可见。
- 窄 rail。
- composer 动作条。
- 权限 / 工作区 / 模型状态。

### P4：Workbench 模式

- 左项目 / 会话。
- 中任务对话。
- 右 Inspector。
- 底部 composer。
- 状态条。

### P5：任务组件

- Message。
- Reasoning。
- Tool Call。
- Diff。
- Plan。
- Approval。
- Artifact。
- Terminal。
- Error。
- Permission。

### P6：安全与可访问性

- Markdown sanitizer。
- Focus trap。
- Esc 关闭。
- aria-label。
- reduced motion。
- 错误码中文映射。
- 不静默吞异常。

---

## 11. 验收标准

### UI 验收

- 登录页和二维码不被 Studio 遮挡。
- Focus 模式下原生消息区可见、可滚动、可点击。
- Workbench 模式下三栏不互相挤压，中间至少 400px。
- 工具调用卡片能区分读取、修改、Shell、搜索、Web、MCP、测试。
- diff 审批能显示文件、增删行、允许/拒绝。
- 权限档位在 composer 和状态条都可见。
- 多 Bot 不靠彩色气泡区分。

### 工程验收

- `npm run typecheck` 通过。
- `npx vitest run` 全绿，或红灯有明确登记。
- 样式不泄漏到 DeepSeek 原生页面。
- 重复挂载不重复注入 CSS。
- Markdown 渲染经过 sanitizer。
- 宿主 DOM 改版时，UI 降级而不是白屏。

---

## 12. 最终建议

1. **不要搬运 cuckoo-code。**
2. **不要整体模仿 Harness。**
3. **学习 Harness 的信息架构，学习 cuckoo 的宿主适配。**
4. **产品 UI 自研，渲染层使用 React + Vite + CSS Modules。**
5. **最终形态是“一层外壳、两种模式”。**
6. **交互模型优先借鉴 Codex / Claude Code，不照抄视觉。**
7. **先做 Focus，再做 Workbench；先做基础层，再做任务组件。**

---

*文档结束。*
