---
title: Studio-UI 总体设计 v1 评审报告
summary: 对 E:\NAS\deepseek-studio\docs\前端开发计划\Studio-UI-总体设计-v1.md 的只读评审，基线为当前工作树（HEAD 4afea0f、150 提交、3 条脏改动）。设计稿的现状诊断（手写 DOM、全局 style、无 Shadow DOM、白底 overlay、几何测量、Markdown 无 sanitizer、紫色 Bot 标识）与代码一致，方向可采；但技术栈与单文件 IIFE 注入链路不匹配、权限词表存在三套且 UIState 类型装不下「仅工作区」档、对 consent/白名单/grant/门禁完全沉默、Plan-Act 与逐块 diff 验收缺后端支撑。结论：方向可采，不能直接开工，列出 6 项阻断。
---

# Studio-UI 总体设计 v1 评审报告

## 1. 评审对象、基线与方法

评审对象：`E:\NAS\deepseek-studio\docs\前端开发计划\Studio-UI-总体设计-v1.md`（653 行 / 20,817 字节）。该文件在 git 中属未跟踪状态（见下方 status 第 2 条），即设计稿尚未入库。

基线读数（本轮现读，2026-10-19）：

- `git rev-parse HEAD` = `4afea0f3c25f9f25d9ba6b0dde940f0f01a06c63`
- `git rev-list --count HEAD` = `150`
- `git status --porcelain` = 3 条：` M src-tauri/inject/entry.js`、`?? docs/前端开发计划/`、`?? docs/设计稿/app-icon-v1.png`

与上一轮的基线（380e18f / 141 commits / 89 条脏）相比，HEAD 前移 9 个提交，工作树从 89 条脏降到 3 条。这意味着上一轮报告中标注为「未提交改动未纳入测量」的那部分风险已大幅收敛，但本报告引用的行号以本轮 HEAD 为准，与更早报告的行号不能直接互引。

方法：全程只读。所有判断来自本轮在设备上打印的设计稿原文与源码行；未运行 build / typecheck / vitest / `npm run gate`，未安装依赖，未启动应用或浏览器，未做 git 写操作，未读取任何凭据值。因此本报告不对「当前测试是否全绿」「基线是否通过门禁」下任何结论，凡涉及运行结果的均在文末测量限制中标注。

## 2. 结论速览

方向层面本稿可采。「三层边界（渲染层 / 宿主适配层 / 设计系统）+ 一层外壳两种模式 + 产品 UI 自研」这个判断与仓库现状的问题结构吻合，第 3 节列出的 7 条现状诊断全部在代码里得到验证，没有一条是凭空的。

但作为一份可以直接开工的设计，它有三类硬缺口：

1. 技术选型与打包链路不匹配：它推荐 React 18 + Vite + Monaco + xterm.js + Shiki + KaTeX，而本仓库没有 Vite，也没有其中任何一个依赖，注入产物是单文件 IIFE（现 401,573 字节）并以单个字符串作为 `initialization_script` 注入真实 DeepSeek 页面。
2. 对授权与同意层完全沉默：设计稿全文检索 `consent`、`同意`、`policy`、`白名单/whitelist`、`grant`、`M8`、`gate/coverage/contract`、`search_files`、`E1/E2/E3`、`快照` 均为 0 命中，而它要求 UI 承担「我是否允许」这类任务（设计稿 :67）并规定 diff 审批、权限档位可见（:626、:627）。
3. 若干写进验收的界面没有后端或没有调用方：逐块接受/拒绝的 diff、Plan/Act 状态机、Terminal、Preview、Audit、回滚入口（详见第 5 节）。

判定：本稿属于「方向可采、不能直接开工」，开工前必须补齐第 7 节 A 组的 6 个阻断项。

## 3. 设计稿说对了的部分（逐条给证据）

设计稿 §0「最重要的架构判断」五条 + §0 现状问题，逐条与代码核对，全部命中：

- 手写 DOM、无组件化：`src` 下 `createElement` 命中 94 处、分布在 10 个文件；`src/ui` 目录 18 个文件全部是 `.ts` / `.css` / `.html`，没有任何 `.tsx`。仓库内 `*.tsx` / `*.jsx` 共 44 个，全部位于 vendored 的 `deepseek-pp/src`（见第 4 节 C9），`deepseek-studio` 自有代码零个。
- 样式是全局 `<style>`、不是真正的 Shadow DOM：全 `src` 检索 `attachShadow` 为 0 命中；7 处各自 `document.createElement('style')` + `document.head.appendChild(...)`，分别是 `src/inject/step-flow-ui.ts:25` 与 `:81`、`src/inject/tool-card-dom.ts:15` 与 `:28`、`src/inject/tool-card-ui.ts:211` 与 `:213`、`src/ui/consent.ts:97` 与 `:100`、`src/ui/studio-chat-ui.ts:43` 与 `:50`、`src/ui/studio-ui-core.ts:104-107` 与 `:113-120`、`src/ui/account-block.ts:44` 与 `:47`。
- 聊天 overlay 默认用不透明白底覆盖原生消息区：`src/ui/studio-chat-css.ts:15-29`，`position: fixed`、`bottom: 280px`（默认值）、`background: #ffffff`、`z-index: 2147483000`；:20 注释写明「默认值，measureComposerTop 会动态覆盖为精确值」。
- 输入栏与侧栏依赖几何扫描与 MutationObserver：`src/ui/studio-chat-ui.ts:82-126`（`measureComposerTop`，用 textarea / contenteditable 作种子再上溯卡片根）、`:128-140`（`measureSidebarRight`，遍历 body 找贴左、高、窄的元素）；`MutationObserver` 在 `src` 下 6 个文件 14 处命中（如 `src/inject/main-world-interceptor.ts:1090`、`src/inject/tool-card-dom.ts:161`）。
- 安全边界不完整、Markdown 直接 `innerHTML` 无 sanitizer：`src/inject/markdown.ts:9-11` 原文写明「marked 的 sanitize 默认关闭……已在 chat UI 内通过 innerHTML 渲染……不引入 DOMPurify 以减依赖」，`renderMarkdown` 在 `:19-26` 直接 `marked.parse` 返回；全 `src` `innerHTML` 命中 27 处、10 个文件。
- 子 Bot 紫色 `#8b5cf6`：`src/ui/studio-chat-css.ts:99`（`.ds-sc-msg-sub-bot .ds-sc-avatar { background: #8b5cf6; }`）、`:100`（`border-left: 3px solid #8b5cf6`）、`src/ui/studio-chat-room.ts:42`（`'audit-expert': { bg: '#8b5cf6', border: '#8b5cf6' }`）。设计稿 §5.2 把它列入禁止清单是对的，且这是清理项而非新设计。
- 硬编码 z-index：`src/ui/consent.ts:40` 与 `src/ui/account-block.ts:16` 都是 `z-index: 2147483647`；`src/ui/studio-chat-css.ts:10-14` 用注释记录了一套分层（2147483647 consent / 2147483644-3646 StudioUI 面板 / 2147483000 chat overlay），`:21` 取 2147483000。

需要修正的一处措辞（不影响结论）：设计稿 §0 第 4 条说「输入栏和侧栏依赖几何扫描、混淆 class 和 MutationObserver」。几何扫描与 MutationObserver 成立；但当前实现是**刻意回避**混淆 class 的——`src/ui/studio-chat-ui.ts:78` 注释明说「不用混淆 class 选择器（随版本变化），输入框元素是稳定锚点」，`src/inject` 与 `src/ui` 下也没有 `[class*=...]` 形式的混淆选择器。真正因混淆而退回几何遍历的是侧栏，见 `:132-135` 的注释（举了 `dc04ec1d` 这类混淆名）。建议把这条改成「输入框用稳定锚点 + 几何测量，侧栏因 class 混淆改用几何遍历」，避免实施时误以为可以靠改选择器解决。

## 4. 设计稿说的 vs 代码实际的

### C1（阻断）技术栈与打包链路不匹配

设计稿 §6.1 推荐：React 18 + Vite + TypeScript、CSS Modules、Radix UI 或 React Aria、Monaco Editor、xterm.js、marked/markdown-it + DOMPurify、KaTeX、Shiki。设计稿 §10 P1 要把首批文件做成 `app-shell.tsx` 这类 `.tsx`。

代码实际：

- `package.json` 全文（本轮完整读取）依赖只有 `marked@^18`、`node-cron`；devDependencies 只有 `@earendil-works/pi-agent-core`、`@tauri-apps/cli`、`@types/node`、`@types/ws`、`esbuild`、`jsdom`、`tsx`、`typescript`、`vitest`、`ws`。没有 react、vite、monaco、xterm、shiki、katex、dompurify、radix。
- 构建只有一条链：`npm run build:inject` → `node esbuild.inject.mjs`；`esbuild.inject.mjs:11-19` 把 `src/desktop/entry.ts` 打成 `format: 'iife'`、`platform: 'browser'`、`target: 'es2020'`、`outfile: 'src-tauri/inject/entry.js'`；`:29-36` 再把 `src/ui/agent-panel.ts` 打成 `dist/agent-panel.js`。没有代码分割、没有 dev server、没有资源路径机制。
- 注入方式是单个字符串：`src-tauri/src/main.rs:450-451` 把 `chat_config_script + host_token_script + load_init_script()` 拼成一个串传给 `initialization_script(&init_script)`；`main.rs:15-31` 是在**运行时**从若干候选路径读取 `inject/entry.js`。
- 当前产物体积：`src-tauri/inject/entry.js` = 401,573 字节，作为字符串进 WebView。
- 宿主侧 CSP 在 `src-tauri/tauri.conf.json` 的 `app.security.csp`：`script-src 'self' https: 'unsafe-inline' 'unsafe-eval'`、`style-src 'self' https: 'unsafe-inline'`，允许内联样式与内联脚本，但 Monaco 需要的 web worker 与 xterm 的字体/样式资产不在同一份 IIFE 里。

处理建议：设计稿必须补一节「注入产物的打包与体积预算」，明确三件事——(a) React 是否引入，引入后 IIFE 体积上限是多少；(b) Monaco 是否放弃（它按需加载 worker 与多语言包，与单文件 IIFE + `initialization_script` 注入方式天然冲突），若保留，worker 从哪个 origin 加载、由谁托管；(c) xterm 的 CSS 与字体如何进包。若这三件说不清，§6.1 的选型表就不能作为实施基线。

### C2（阻断）权限词表有三套，且 UIState 类型装不下「仅工作区」档

设计稿 §2.2、§2.3 的 composer 与状态条都要求「权限 chip / 权限档位」，§11 验收（:627）要求「权限档位在 composer 和状态条都可见」，但全文没有给出档位名称与取值。

代码实际存在三套互不一致的词表：

- 引擎口径：`src/host/policy.ts:32` `PolicyMode = 'workspace' | 'ask' | 'auto' | 'full'`；`:34` 全集；`:36-37` `PANEL_POLICY_MODES = ['workspace','auto','full']`（注释明说 ask 是旧档、不在 UI 出现）；`:42-47` 展示名 `workspace:'仅工作区' / ask:'询问审批' / auto:'风险审批' / full:'完全放开'`。
- `/agent` 面板页口径（与引擎一致）：`src/ui/agent.html:26-30` 三个按钮 `仅工作区 / 风险审批 / 完全放开`。
- 注入式页内 UI 口径（过期）：`src/ui/studio-input-bar.ts:96` `modeLabels = { full: '全部允许', auto: '自动审批', ask: '每次询问' }`；`src/ui/studio-settings-panel.ts:7` 注释「策略：full/auto/ask 三选一」，`:142-146` `policyDefs` 三个标题同样是 `全部允许 / 自动审批 / 每次询问`，并在 `:154` 用 `callHostTool('policy.set', …)` 落盘。
- 更硬的一处：`src/ui/studio-ui-core.ts:22-30` 的 `UIState.policyMode` 类型是 `'full' | 'auto' | 'ask'`（`:25`）——这个类型**在编译期就无法表示 `workspace` 档**。任何按设计稿实现的权限 chip 只要复用 `globalState`，就必然漏掉「仅工作区」。

处理建议：设计稿必须写死一句话——权限档位的唯一权威取值是 `policy.ts:36-37` 的 `workspace | auto | full`，展示名取 `policy.ts:42-47`；并明确 `studio-ui-core.ts:25`、`studio-input-bar.ts:96`、`studio-settings-panel.ts:142-146` 三处在 UI 层重写时同步收敛。这一条不定，权限界面每改一次都会再引入一套词表。

### C3（阻断）Approval Card 的「始终允许」对应不到一个明确的后端对象

设计稿 §4.3：「Approval Card 显示风险、影响范围、允许/拒绝/始终允许」。

代码实际有两个不同的「记住」对象，语义与寿命都不同：

- 会话级放行：`src/host/protocol.ts:15` `ConsentDecision = 'allow-once' | 'deny' | 'allow-session'`；页端 `src/ui/consent.ts:4-6` 明写三个动作是「允许一次 / 拒绝 / 本次会话允许」，`:136-138` 是三个按钮的真实文案；`:167` 60 秒超时、`:155` Esc、`:163` 点遮罩一律按 deny（fail-closed）。`allow-session` 绑「工具 + 参数指纹」+ 默认 10 分钟 TTL（`src/host/desktop-host.ts:296`、`src/host/registry.ts:38`），并且档位切换（`desktop-host.ts:983`）与工作区变更（`:994`）会作废旧授权。
- 持久白名单：`src/host/consent-whitelist-store.ts:4` 落盘 `~/.config/deepseek-studio/consent-whitelist.json`；`:20` 的 `add()` 需要 `toolId + action + pathPattern + workspaceHash`；`:71-73` 只接受相对 pattern，绝对路径、盘符、`..` 一律拒；`:27` 上限 200 条；`:103-106` 按 `workspaceHash` 过滤；命中逻辑在 `src/host/consent-router.ts:135`（越界永不命中）、`:138-143`（需 `workspaceHash`、`toolId`、`action` 全等，且 pattern 要 glob 命中相对路径）。宿主侧接线在 `desktop-host.ts:1171-1195`（whitelist 命中即跳过人工 consent）。

也就是说，设计稿的「始终允许」如果落到 `allow-session`，它只活 10 分钟；如果落到白名单，它必须带 workspaceHash 与相对路径 pattern，且越界永不免问。设计稿一个字都没写这层映射。

处理建议：Approval Card 的三个按钮必须显式映射为 `allow-once / deny / allow-session`（现有协议三个值，`protocol.ts:15`），并把「改为长期免问」做成一个独立入口，指向白名单对象及其四个必填维度 + 越界不免问的约束；不要用「始终允许」这个既有会话含义又有持久含义的模糊词。另外，若本期不做白名单管理 UI，就必须在稿子里写明「本期只提供会话级放行，持久白名单只能手改文件」，否则实现者会顺手造第四条授权通道。

### C4（阻断）Plan/Act 在代码里只是文本前缀，状态机没有调用方

设计稿 §2.3 composer 有「Plan / Act」，§3.1 中栏有 Plan Card，§4.3 把 Plan 描述为独立工作流，§9 把「Plan / Act」列为从 Codex / Claude Code 借鉴的交互模型。

代码实际：

- `src/host/plan-gate.ts:2` 是 M8-E3 的「Plan/Act 分离闸门」；`:35-49` 有一个三态状态机（`plan-no-tools` / `plan-to-act-confirmation` / `act-normal`）；`:55-56` 的 `detectPlanRequest` 只认 `/^\s*\/plan\b/i`。
- 但接线只有一半：`src/host/kernel/task-loop.ts:29` 只 import 了 `detectPlanRequest`，用在 `:167-169`（plan 模式只跑一轮）与 `:220-221`（plan 模式不落 tool 记录）；状态机函数 `evaluatePlanGate` 全 `src` 只有 `plan-gate.ts:35` 一处定义、零调用方。
- 页端没有任何 plan 标记输入控件：`src/ui/studio-input-bar.ts` 的四个功能是本地电脑开关、项目选择、权限模式、技能按钮（`:4-8`），没有 plan 开关；也就是说今天触发 plan 模式的唯一方式是用户在输入框里手打 `/plan`。

处理建议：设计稿要区分「已有能力」与「要新建的能力」。composer 的 Plan/Act 是新建控件，且它要真正生效必须先给 `evaluatePlanGate` 接上调用方（写在 task-loop 或 agent-loop 哪个位置）。同时必须写清一条：plan 阶段只阻断工具调用（`task-loop.ts:167-169`），批准计划**不等于**授权——M8 定稿第 8 条要求每步仍重走 grant 签发/消费与同意闸门，因此 UI 上不能出现「一次确认批准整份计划」的按钮。这一条不在设计稿里，属必须补的安全约束。

### C5（阻断）「逐块接受/拒绝」的 diff 没有后端

设计稿 §4.3「Diff Review 显示文件、增删行、逐块接受/拒绝」，§11 验收（:626）「diff 审批能显示文件、增删行、允许/拒绝」。

代码实际：两条写入路径都是「唯一匹配的整批替换」，没有 hunk 级模型与局部应用 API。

- `src/capabilities/edit-engine.ts:6-19` 的契约是 `edit({ path, edits[], expectedSha256?, dryRun? })`，边界写明「唯一匹配硬约束：oldString 必须恰好命中 1 次，否则整批拒绝」「原子性：同目录临时文件 + rename 单点替换」。
- `src/host/kernel/edit-engine.ts:2-7` 是另一份实现（unified diff 应用 + 多文件原子回滚），但 `:13-20` 的 `EditInstruction` 仍是 `{ path, oldText, newText }`，粒度是「整文件替换」。
- UI 侧没有任何 diff 视图：全 `src` 检索 `diff` 只命中 `src/api/auth.ts:28-30` 与两处 edit-engine 的后端逻辑，`src/ui`、`src/inject` 下零命中；`iframe`、`preview` 也各为 0 命中。

处理建议：把验收降到「整批接受/拒绝 + 按行展示 diff」（这一档现有后端支持：`dryRun` 可先出 diff 再决定），或者明确把「按 hunk 局部应用」列为新增后端工作并给出改动面。不要保留一个后端不支持的验收项。

### C6（阻断）设计稿的工程验收弱于现有门禁

设计稿 §11 工程验收只写两条：`npm run typecheck` 通过、`npx vitest run` 全绿或红灯有明确登记。

代码实际的门禁比这严，且覆盖面不同：

- `package.json` 的 `gate` = `tsx tools/gate/run.ts`。`tools/gate/run.ts:7-12` 写明门禁分两级；`:28-35` 阻塞级依次是 `npx tsc --noEmit`、`npx vitest run`、`tools/audit/boundary.ts`、`tools/contract/check.ts`、`tools/coverage/check.ts`、`tools/audit/empty-files.ts`，任一步失败 `process.exit(1)`（`:57`）；`:38-41` 信息级是 `symbols` / `m3-clean` / `security`，红了不阻塞、只追加到 `logs/gate-info.log`。
- 覆盖率门禁只扫两个目录：`tools/coverage/check.ts:4-7` 与 `:62-63` 只检 `src/host/kernel/**` 与 `src/host/engine/**`，阈值 80% / 70%。新建的 UI 层（不论放 `src/ui` 还是新目录）**不在任何覆盖率门禁范围内**。
- `innerHTML` 属于信息级：`tools/audit/security.ts:4-8` 扫 `eval()` / `new Function()` / `innerHTML` / `outerHTML` / 硬编码密钥，但它在 `tools/gate/run.ts:41` 的信息级列表里，红了不阻塞。
- 边界审计只覆盖依赖方向：`tools/audit/boundary.ts:5-9` 四条规则约束 `src/host/kernel/**`、`src/host/engine/**`、`src/shared/**`、`tools/**` 的 import 方向，UI 层不在规则内。

处理建议：设计稿 §11 换成「UI 层新增什么门禁」而不是重复既有两条。至少要有：(a) UI 层（含注入产物）纳入覆盖率门禁或另设一条等价的 import 覆盖检查，否则新写的大批组件零门禁；(b) 把「Markdown 必须过 sanitizer」（设计稿 §11 :636、§10 P6）落成可跑判据——今天没有 DOMPurify（`package.json` 无该依赖，`src/inject/markdown.ts:11` 明确不引入），要么加依赖并给它写检查、要么明确接受信息级；(c) 明确 `npm run gate` 是否是收尾必须绿的判据（按 `tools/gate/run.ts:57` 的语义，vitest 红就意味着门禁红，设计稿「红灯有明确登记即可」的说法与门禁语义冲突）。

### C7（顺手修）「真正的 Shadow DOM」要先拆掉现有假 Shadow

设计稿 §10 P1 要求「真正的 Shadow DOM 根容器」，§0 说现在不是真正的 Shadow DOM。

代码实际确实不是，而且现在有一处**名义上是 Shadow、实际不是**的代码会误导后续实现：

- `src/ui/studio-ui-core.ts:4-5` 文件头声称「提供……Shadow DOM 挂载……所有 UI 组件使用同一套工具，确保样式隔离和一致性」。
- 但 `:90-100` 的 `createShadowContainer(id)` 最后返回 `{ container, shadow: container }` —— `shadow` 就是 `container` 本身；`:99` 还把容器设成 `display:block;pointer-events:none`。
- `:113-120` 的 `injectStyles(_shadow, css)` 直接忽略 `_shadow` 参数（下划线即弃用），把 CSS 追加到全局 `#studio-ui-component-styles`；`:120` 用 `styleEl.textContent += '\n' + css` 累加，重复调用会持续增长。

处理建议：把「引入真 Shadow DOM」与「修掉这处假 Shadow 命名」写成同一件事，并给 `injectStyles` 定去重策略（按 id 覆盖而非累加）。设计稿 §11 里「重复挂载不重复注入 CSS」这条验收，正好对应 `:120` 这个累加点——现在的实现通不过它。

### C8（需拍板）/agent 面板页与 Workbench 模式的关系未定义

设计稿描述了 Top Bar / Left Rail / Center / Right Inspector / Composer / Status Bar 的完整工作台，但全文没有出现 `agent.html`、`agent-panel`、`/agent`（均 0 命中）。

代码实际已经有一个独立的、形态接近的工作台页面：`src/ui/agent.html:13-31` 已有顶栏（工作区 / 权限档位三按钮 / 连接状态），`src/ui/agent-panel.ts`（8,319 字节）是其应用，`src/ui/agent.css` 提供样式；它由本地宿主以 `/agent`、`/agent.js`、`/agent.css` 三个路由提供（`src/api/server.ts:13-14`、`:247-264`），且这三个路由免鉴权（`server.ts:91-92` 说明 HTML 内嵌令牌）。

处理建议：§2.3 的 Workbench 必须说明它是「替换 `/agent` 面板页」「与 `/agent` 并存」还是「先做注入式、后续再合并」。定了之后还要顺带定义谁持有令牌——`/agent` 页是把令牌内嵌进 HTML 的（`agent.html:9`），若 Workbench 改成注入式页面，令牌下发路径会完全不同。

### C9（需拍板）仓库里已有一份 React/TSX 实现，设计稿未提及

设计稿 §6.1 选 React，§6.2 说不推荐「直接迁移成 Harness 式完整插件系统」，但没有提仓库里已经躺着的一份 React UI。

代码实际：`deepseek-studio/deepseek-pp/src` 是一个完整 vendored 快照（1,135 个文件），其中 `*.tsx` 共 44 个，例如 `src/entrypoints/sidepanel/components/ChatMessage.tsx`、`.../settings/AppearanceSubPage.tsx`、`.../AtFilePanel.tsx`、`.../GitHubSkillImportPanel.tsx`。此外 `src/ui/agent.html:20` 用的是 `📁` emoji 图标。

处理建议：设计稿要给出对这份快照的明确处置——「只作参考、不引用接口」「复用其中的 CSS token / 组件约定」还是「排除在本次改造范围外」。它同时关系到 §6.1 的 React 版本约定与许可（该子树按既有约定 `core/**` 零修改，动 UI 部分需要单独判断，属需拍板项）。

### C10（顺手修）颜色 token 与既有值冲突

设计稿 §5.2 给出主色 `#4D6BFE`、成功 `#2E9E6B`、错误 `#D64545`。

代码实际：`#4D6BFE` 已存在且用得一致（`src/ui/consent.ts:89` 的 allow-once 按钮、`src/ui/studio-input-bar.ts:63` 的选中态、`src/ui/studio-chat-css.ts:316` 的引用块边框），这一条是「沿用」而非「新建」。但成功/错误色与现状不同：`src/ui/consent.ts:88-90` 用的是 `#D4380D`（deny）与 `#2BA471`（allow-session），`src/inject/tool-card-ui.ts:128-130` 用的是 `#991b1b / #1e40af / #92400e` 一组 badge 色，`src/ui/studio-chat-css.ts:58` 用 `#d0d0d8`。

处理建议：token 表里对每个语义色标注「沿用 `file:line` 现值 / 新增并替换哪些位置」，否则落地时同一状态会同时出现两种绿、两种红。

### C11（阻断或至少 P0）已实现的安全模块在 UI 设计里没有任何入口

前两轮定下的 M8 安全模块大部分已经落在代码里，但设计稿是零提及（`E1/E2/E3`、`白名单`、`快照` 均 0 命中）：

- E1 白名单：`consent-whitelist-store.ts`（全量实现）+ `desktop-host.ts:1171-1195` 接线完成。但没有任何 UI 能查看/撤销条目——`whitelistStore.list/remove/invalidateWorkspace`（`consent-whitelist-store.ts:23-24`）在 `src/ui`、`src/inject` 下零调用方，用户只能手改 `~/.config/deepseek-studio/consent-whitelist.json`。
- E2 写前快照：`src/host/shadow-store.ts:5` 落盘 `~/.config/deepseek-studio/shadow/<hash>.bin`，`:43` / `:139` 有 `rollback(id)`；宿主在 `desktop-host.ts:338` 创建、`:1264-1265` 对 `file.edit` / `file.write` 建立快照。但 `consent-router.ts:76` 只把 `'shadow.rollback'` 列进动作分类表，全仓**没有任何工具注册或命令实现**它——用户在 UI 上没有任何撤销入口。
- E3 plan 闸门：见 C4，半接线。

处理建议：把「权限与安全面板」从设计稿 §4.3 的一个 Approval Card 扩成三个明确入口——当前生效的白名单条目（可撤销）、本次任务的可回滚快照（可回滚）、plan 阶段指示。它们的后端一半已存在、另一半（白名单 UI、`shadow.rollback` 命令）需要本设计明确是否在本期范围内。

### C12（顺手修）版本与注释漂移

- 版本号三处不一致：`package.json` `"version": "0.4.0"`，`src-tauri/tauri.conf.json` `"version": "0.13.0"`（产品名 `DeepSeek++ Studio`）；设计稿 §0 也没写目标版本。UI 改造如果走版本门禁（`latest.json` 更新端点已在 `tauri.conf.json` 配置、`updater.active` 为 false），版本号需要先统一。
- `esbuild.inject.mjs:2` 注释写「产物供 main.rs include_str! 注入」，但 `main.rs:15-31` 实际是运行时从候选路径读文件（`inject/entry.js`、`src-tauri/inject/entry.js`、可执行文件旁的 `inject/entry.js` 等），并在 `:39` 找不到时打印 WARN 后继续。设计稿 §10 P0 写「确认 `src-tauri/inject/entry.js` 和未跟踪设计稿不被覆盖」，前提要按这个实际加载逻辑修正（`esbuild.inject.mjs:22-26` 还会把它同步到 `src-tauri/target/debug/inject/`）。

### C13 第三方事实的核验情况

设计稿 §7 称 cuckoo-code 为 GPL-3.0-only、Electron、原生 DOM，§8 称 DeepSeek Harness 为 MIT。

- cuckoo-code 的许可：公开仓库 `github.com/wangyongpeng90/cuckoo-code` 的提交历史显示 LICENSE 于 2026-08-08 由 MIT 切换为 GPL-3.0（提交信息「chore: 切换协议从 MIT 到 GPL-3.0」）。这与设计稿「不搬运代码」的结论方向一致；「GPL-3.0-only」与「GPL-3.0」的精确差别本轮未逐字核对 LICENSE 正文。
- Harness 与 cuckoo-code 的其余技术栈描述（Electron 壳、WebContentsView、`--dsw-*` token 等）本轮未核实，属设计稿的输入假设。
- 影响面：这些属 §7–§9 的策略论证，与第 4 节的代码级冲突无关。即使某条外部描述有误，「不搬运代码、只借鉴信息架构」的结论不受影响。

## 5. 缺实现路径的界面

设计稿把这几项写进了信息架构或验收，但代码里没有对应的界面、通道或后端：

- Right Inspector 的 Terminal：设计稿 §2.3 右栏列 Terminal；全 `src` 检索 `xterm` = 0 命中。没有任何终端实现，也没有承载它的通道（`protocol.ts` 里没有终端相关的消息类型，见 `protocol.ts:34-96` 的消息全集）。
- Right Inspector 的 Preview：`iframe`、`preview` 均 0 命中，没有预览容器。
- Right Inspector 的 Audit / Logs：后端有 `GET /v1/tools/audit`（`src/api/server.ts:304`，另有 `/v1/tools/catalog` `:317`），但 `src/ui`、`src/inject`、`src/desktop` 下零调用方——有数据源、无客户端。这一条是「有实现路径」，设计稿只需明确接哪个端点。
- Diff Review：见 C5。
- 测试卡片：设计稿 §4.2 的工具卡片分类里有「测试」类型。后端能力存在（`src/capabilities/test-runner.ts:21` 的 `TEST_RUN_TOOL_ID = 'test.run'`），但 `src/ui`、`src/inject` 下没有测试结果卡片。
- 回滚入口：见 C11。
- 工具卡片类型系统：设计稿 §4.2 要求按工具类型（读取/修改/Shell/搜索/Web/MCP/测试）分卡片并统一状态 `pending → running → success/error/denied/cancelled`。现状是三套并行渲染层：`src/inject/tool-card-dom.ts:1-8`（把 `<tool_name>`、`【工具执行结果】`、`<mcp_call>` 文本替换成折叠卡片）、`src/inject/tool-card-ui.ts`（14,385 字节的工具卡片，含 `err/running/terminated` 三种 badge，见 `:128-130`）、`src/inject/step-flow-ui.ts:1-9`（步骤流：状态栏 + 折叠推理 + 步骤叙述 + 工具分组）。没有与工具名到类型的映射表，也没有 `denied` / `cancelled` 这两个态。

## 6. 安全与授权层：设计稿的沉默

对设计稿全文做的术语检索结果：`consent` 0、`同意` 0、`policy` 0、`白名单` 0、`whitelist` 0、`M8` 0、`search_files` 0、`gate` 0、`coverage` 0、`contract` 0、`grant` 0、`E1/E2/E3` 0、`快照` 0。`档位` 出现 3 次（设计稿 :67、:117、:627），但三次都只写「权限档位」而不给取值。

同时，它要求 UI 直接承担这项任务——设计稿 :67「我是否允许 → 权限档位、审批请求、风险说明、拒绝后的回填」，:626「diff 审批能显示文件、增删行、允许/拒绝」，:627「权限档位在 composer 和状态条都可见」。也就是说，这份设计把一个它完全没有描述其规则的层写成了 UI 职责。

下面把前两轮定下的约束与本轮现读的落地证据逐条列出，并说明设计稿需要补什么：

1. 档位取值四选一，面板只暴露三档：`policy.ts:32`、`:34`、`:36-37`。设计稿：需要按 C2 写死词表。
2. full 档是完全不问：`policy.ts:215`（越界直接 `allow`）、`:259-264`（进程类无条件 `allow`，只记录命中的风险到 `riskFlags`）。设计稿 §5.2 只把颜色当禁忌，没有提「完全放开」在 UI 上必须有显著风险标识——这是权限 chip 的必要设计内容。
3. 区内文件读写直接放行、不弹同意：`policy.ts:203`（`inside-workspace` → `allow`）。
4. 受治理工具的同意判定以策略结论为准，覆盖原有的风险阈值：`desktop-host.ts:1141` 先按定义算 `requiresHumanConsent`，`:1145-1157` 对文件类/进程类工具用 `evaluatePolicy` 的结论**整体覆盖**它（`:1157`）。设计稿的 Approval Card 必须能显示「本次为什么需要同意」的 reason，而不是只显示工具名；`:1164-1169` 已经把 reason 翻译成 `riskLabel` / `modeLabel` / `outside` / `riskFlagLabels` 下发（`protocol.ts:22-31`、`consent.ts:22-27`），UI 直接用即可。
5. search_files 是治理缺口，且不在任何治理集合里：`policy.ts:94`（FILE_TOOLS）、`:96`（PROCESS_TOOLS）、`:102`（EXECUTION_TOOLS）都没有它 → 落到 `:274` 的 `not-governed` → `allow`；它在 `src/host/tool-definitions.ts:113-116` 注册且 `risk: 'read'`；执行体在 `desktop-host.ts:357-358` 起，`root` 缺省取当前工作区但**允许从 params 传入**（`:362`：`typeof params.root === 'string' ? params.root : mutableWorkspace.root`）。设计稿若把它当作「只读、安全」的一类卡片（§4.2 的「搜索」类型）而不加任何边界提示，等于把治理缺口写进 UI 语义。建议在 UI 上把「检索根目录」显式展示出来。
6. 硬拒绝地板确实存在，且优先于用户同意：`consent-router.ts:81-114` 的 `checkHardDeny`（危险磁盘操作、电源控制、盘根递归删除、敏感路径写入），`:157-161` 在 `policy === 'allow'` 时仍然执行并返回 `hard-deny`。但规则是窄的：`:90` 只匹配以 `format|mkfs|diskpart` 开头的命令，`:93-95` 注释自承「简化：只拦明确的盘根目标」，`:102-110` 只覆盖 `c:\windows\`、`c:\program files\`、`/etc/`、`/usr/`、`/bin/`、`/sbin/`、`~/.ssh/`、`~/.aws/` 几个前缀。设计稿若用「用户同意也不能覆盖」做 UI 文案，必须与这套窄规则对齐，否则会承诺一个比实现更强的保证。
7. 白名单只能绑工作区、只接受相对 pattern、越界永不命中、上限 200：`consent-whitelist-store.ts:20`、`:27`、`:71-73`、`:103-106`；`consent-router.ts:135`、`:138-143`。本轮未发现任何模型可调工具能写白名单（`desktop-host.ts:1190` 只读；写入口是面板命令路径）。设计稿：见 C3。
8. 计划确认不等于授权：`task-loop.ts:167-169` 只把 plan 变成「跑一轮、禁工具」，`plan-gate.ts:35-49` 的状态机无人调用；宿主 `desktop-host.ts:1104-1136` 的 grant 消费与 origin 闸门对每个工具调用独立执行，与 plan 与否无关。设计稿：见 C4。
9. 快照目录已按既定位置落地：`shadow-store.ts:5` 是 `~/.config/deepseek-studio/shadow/<hash>.bin`（不是仓库内），符合前一轮定的默认位置。设计稿 0 提及，见 C11。

## 7. 优先级结论

A. 开工前必须解决（阻断项，共 6 条）

1. C1 技术栈与打包链路：给出注入产物的打包方案与体积上限，并对 Monaco / xterm 是否保留给出明确取舍。
2. C2 权限词表唯一化：写死 `workspace | auto | full` 与展示名，并列出 `studio-ui-core.ts:25`、`studio-input-bar.ts:96`、`studio-settings-panel.ts:142-146` 三处收敛点。
3. C3 Approval Card 三按钮映射：落到 `allow-once / deny / allow-session`，长期免问指向白名单四要素 + 越界不免问。
4. C4 Plan/Act：明确它是新建控件、需要给 `evaluatePlanGate` 接调用方，并写入「计划批准不等于授权」。
5. C5 diff 验收降级或补后端：改成整批接受/拒绝，或把 hunk 级局部应用列为新增后端工作。
6. C6 验收标准重写：补 UI 层覆盖率与 sanitizer 的可跑判据，明确 `npm run gate` 的地位。

C11 可以与 2 / 3 合并处理，若本期不做白名单 UI 与回滚入口，必须在稿子里写明是显式不做、而非遗漏。

B. 实现中顺手修（不阻断开工，但同一批改动里做掉成本最低）

- C7 假 Shadow 命名与 `injectStyles` 累加。
- C8 `/agent` 面板页与 Workbench 的关系（也可提到 A 组拍板）。
- C10 颜色 token 标注沿用/替换位置。
- C12 版本号统一与 `esbuild.inject.mjs:2` 注释订正、§10 P0 前提订正。
- 第 3 节末的措辞订正（混淆 class 只适用于侧栏）。
- `src/inject/step-flow-ui.ts:14-21` 把 SVG 图标内联成 `data:image/svg+xml` 的 `background-image`，与设计稿 §6.1「内联 SVG 线条图标」不完全一致；迁移到组件层时顺带统一为 `el()` + `icon()` 路径（`studio-ui-core.ts:150`、`:167` 已有 `icon()` 与 `Icons`）。

C. 只是风格取舍（不必较真）

- §5.3 字体表、§5.4 尺寸数值、§5.5 动效清单、§5.2 的具体色值，都是可调参数。
- §7–§9 的「向谁借鉴」分工（除 C13 已核的许可结论外）属策略判断，无法用本仓代码证伪。
- §5.6 深色模式「首版只实现浅色、token 预留」是合理降级，不必强求首版两套皮肤。注意现状里明暗跟随已经存在于 `src/ui/consent.ts:7`（「明暗跟随系统」）与 `studio-chat-css.ts` 的多处硬编码亮色，迁移时以 token 为准即可。

## 8. 无法从静态代码判定、或需要人拍板的事项

需要人拍板：

1. React 是否引入；若引入，是否复用 `deepseek-studio/deepseek-pp/src` 的 44 个 `.tsx`（C9）。这决定整个 P1/P5 的工作量与许可边界。
2. Monaco / xterm 是否在本期范围（C1）。若保留，需要决定 worker 与静态资产的托管 origin。
3. Plan/Act 是控件还是保持 `/plan` 文本前缀（C4）。
4. 「始终允许」的产品语义：会话级（10 分钟 TTL，`desktop-host.ts:296`）还是持久白名单（`consent-whitelist-store.ts`）（C3）。
5. 本期是否提供白名单管理 UI 与 `shadow.rollback` 撤销入口（C11）——两端都只有「有存储、没入口」。
6. Workbench 与现有 `/agent` 面板页是替换还是并存（C8）。
7. 设计稿 §2.4 的模式切换默认规则是否接受（打开文件夹→Workbench 等），这属产品判断，代码里没有任何模式状态可依。

需要跑起来或人工确认（不能由静态阅读判定）：

1. 当前 `npx tsc --noEmit`、`npx vitest run`、`npm run gate` 是否绿。本轮未执行（`tests` 下共 118 个测试文件：`tests/desktop` 117 个 + `tests/e2e` 1 个；其中 12 个文件 import 了 `src/ui` 或 `src/inject`）。设计稿 §10 P0 要求「修复或登记现有红灯测试」，这条要靠实跑来定，不能靠阅读。
2. 注入产物引入 React 后的实际体积与首屏注入耗时。当前 `src-tauri/inject/entry.js` = 401,573 字节，且是 `main.rs:450-451` 拼进 `initialization_script` 的单串；增量只有实跑才知道。
3. 宿主页面改版时的降级行为（设计稿 §11 要求「UI 降级而不是白屏」）——现状是靠 `studio-chat-ui.ts:46-68` 的多级兜底与测量失败返回 `null`，真实退化程度需在页面上验证。
4. Shadow DOM 引入后是否真的消除样式互相污染。`src/ui/studio-chat-css.ts` 与 `src/inject/tool-card-ui.ts` 目前是同一 `document` 下的全局样式，冲突只有跑起来才看得见。
5. 硬拒绝地板在 `policy === 'allow'` 路径上是否真的每次都被调用（`consent-router.ts:157-161` 是静态阅读结论），以及 `desktop-host.ts:1193` 只认 `verdict === 'safe' && reason === 'whitelist-hit'` 这一条窄路径之外的调用是否也会经过地板。
6. `window.__STUDIO_TOKEN__` / 宿主令牌在注入式 Workbench 下的下发方式（`agent.html:9` 现在是页面内嵌；`main.rs:192` 另有 `load_host_token_script`），需要确认新的页面形态是否会改变威胁模型。

## 9. 设计稿逐节速览

- §0 结论先行：五条选型结论可采；现状诊断 5 条经核对全部成立（第 3 节），仅第 4 条措辞需修正。
- §1 产品定位与 UI 目标：属产品判断，无代码可核；§1.4「美观的定义」中的「可信」一条与第 6 节的授权可见性要求同向，建议在那里显式引用。
- §2 一层外壳两种模式：Focus 模式的「不遮挡原生页面」与现状 overlay 的成因一致（`studio-chat-css.ts:15-29`）；Workbench 需要先解决 C8。
- §3 信息架构：左栏与现状基本对得上（`studio-sidebar.ts:1-9` 的浮动按钮 + overlay 面板、`studio-project-picker.ts`、`studio-skills-panel.ts`、`studio-mcp-dialog.ts`、`studio-settings-panel.ts` 都在）；右栏 8 个 tab 里只有「对话产物 / 后台任务 / 任务规划 / 技能列表 / 最近文件」有对应实现（`studio-right-sidebar.ts:1-11`），Changes / Preview / Terminal / Audit 四个缺实现路径（第 5 节）。
- §4 组件模型：分层清单是合理的；「Host Adapters」四个适配器实际对应 `studio-chat-ui.ts:82`、`:128` 两个测量函数，可以照此收编，不需要新建四套。
- §5 视觉系统：见 C10；`font-variant-numeric: tabular-nums`、4px 基线、8/12/16 圆角都是增量，无冲突。
- §6 技术选型：见 C1、C9。
- §7–§9 借鉴取舍：见 C13 与第 7 节 C 组。
- §10 迁移路线：P0 的截图/冻结基线是合理动作，但前提描述需按 C12 修正；P1 的 Shadow DOM 需按 C7 落地；P6 的安全项需按 C6 落成可跑判据。整条路线缺一段「UI 层门禁与体积预算」。
- §11 验收标准：UI 验收 7 条中，第 1 条（登录页/二维码不被遮挡）、第 2 条（原生消息区可见可点）与现状的 `pointer-events:none` 兜底（`studio-chat-css.ts:41-44`）方向一致；第 4 条工具卡片分类、第 5 条 diff 按钮、第 6 条权限档位可见分别受第 5 节、C5、C2 制约。工程验收 2 条需按 C6 重写。
- §12 最终建议 7 条：与代码现状无直接冲突，第 7 条「先做 Focus，再做 Workbench」与 C1 的体积问题相互印证——先做 Focus 恰好避开了重资产。

## 10. 测量限制

- 全程只读，未运行 build / typecheck / vitest / `npm run gate`，未安装依赖，未启动应用，未做 git 写操作。凡「是否绿」「是否生效」「体积多少」类结论均未实测，已在第 8 节单列。
- 所有 file:line 均取自本轮在该设备上打印的当前工作树内容（HEAD `4afea0f3c25f9f25d9ba6b0dde940f0f01a06c63`，150 个提交）。该仓 HEAD 近期持续漂移（上一轮为 `380e18f`、141 个提交），行号会随之变化；引用时请以同一 HEAD 为准。
- 设计稿的行号引用（:34、:67、:117、:123、:242、:252、:255、:429、:515、:537、:567、:608、:626、:627、:636）取自同一份 653 行文件；§6.1 选型表、§10 迁移路线、§11 验收标准按小节引用而未逐行标号。
- 本轮未通读 `src/host/desktop-host.ts`（74,021 字节）全文，同意闸门相关结论来自 `:1090-1200`、`:1264-1265`、`:296`、`:332`、`:354-372`、`:983-994` 等窗口的现读打印；未通读 `src/inject/main-world-interceptor.ts`（60,723 字节）。
- 第三方产品事实（cuckoo-code 许可已按公开仓库提交历史核对；Harness 的许可与技术栈、cuckoo-code 的其余技术栈）未核实，见 C13。
- 设计稿引用的三份关联文档（`docs/前端开发计划/前端开发计划-v1.md`、`docs/设计稿/设计稿_智能体面板_20261010.md`、`docs/项目总路线图.md`）本轮未展开核对；`docs/前端开发计划/` 下除本设计稿外还有 `前端开发计划-v1.md`（7,257 字节）。本报告只对设计稿本身与代码现状之间的关系负责。