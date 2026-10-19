# innerHTML 审计表（2026-10-20 · W4）

> 口径：扫 `src/**/*.ts` 的 `.innerHTML =` 赋值。分类只允许三种：
> **静态模板**（无变量插值，保留并注明来源）、**已消毒**（经 DOMPurify/renderMarkdown）、
> **已转义**（插值经 `escapeHtml` 或改 `textContent`）。
> 基线（HEAD `8007da2`）共 26 处；本次把 4 处不可信变量插值移出 innerHTML（改 textContent），
> 其余含插值点改用 `escapeHtml`。工作区现存 22 处，逐条分类如下，无未分类残留。

## 一、现存 22 处分类表

| # | 文件:行 | 分类 | 插值内容 / 来源 | 动作 |
|---|---|---|---|---|
| 1 | src/ui/account-block.ts:80 | 静态模板 | 风控提示固定文案（`<strong>` 为静态标签） | 保留（本文件为 fail-closed 铁律，W4 禁改） |
| 2 | src/inject/tool-card-ui.ts:268 | 静态模板 | 工具容器外壳骨架，无插值 | 保留，注释来源 |
| 3 | src/inject/tool-card-ui.ts:356 | 已转义 | `buildCardHtml()` 内部 toolName/params/result/imageUrl 全部 `escapeHtml` | 保留 |
| 4 | src/inject/tool-card-ui.ts:387 | 已转义 | 同上（更新分支重建卡片） | 保留 |
| 5 | src/ui/studio-chat-ui.ts:289 | 静态模板 | 欢迎标题固定文案 | 保留，注释来源 |
| 6 | src/ui/studio-chat-ui.ts:434 | 已消毒 | `renderMarkdown(currentRawText)`（DOMPurify）+ 静态光标 span | 保留 |
| 7 | src/ui/studio-chat-ui.ts:477 | 已消毒 | `html = renderMarkdown(currentRawText)` | 保留 |
| 8 | src/ui/studio-chat-room.ts:403 | 已消毒 | `renderMarkdown(text)` | 保留 |
| 9 | src/ui/studio-chat-room.ts:416 | 已消毒 | `renderMarkdown(text)` | 保留 |
| 10 | src/ui/studio-project-picker.ts:176 | 已转义 | `p.name` / `p.path` → `escapeHtml(...)` | W4 改造 |
| 11 | src/ui/studio-right-sidebar.ts:119 | 静态模板 | 「对话产物」标题 + 计数占位 | 保留 |
| 12 | src/ui/studio-right-sidebar.ts:128 | 静态模板 | 「后台任务」标题 + 计数占位 | 保留 |
| 13 | src/ui/studio-right-sidebar.ts:137 | 静态模板 | 「已启用技能」标题 | 保留 |
| 14 | src/ui/studio-right-sidebar.ts:146 | 静态模板 | 「元宝审计」标题 + 状态徽章占位 | 保留 |
| 15 | src/ui/studio-right-sidebar.ts:149 | 静态模板 | 审计面板骨架（轮次/日志占位 id + 静态按钮） | 保留 |
| 16 | src/ui/studio-settings-panel.ts:111 | 静态模板 | 通用信息（版本/路径/端口）固定文案 | 保留 |
| 17 | src/ui/studio-settings-panel.ts:150 | 已转义 | `pDef.title` / `pDef.desc` → `escapeHtml(...)` | W4 改造 |
| 18 | src/ui/studio-settings-panel.ts:180 | 已转义 | `serverId` → `escapeHtml(...)` | W4 改造 |
| 19 | src/ui/studio-settings-panel.ts:233 | 已转义 | `skill.name` / `skill.description` → `escapeHtml(...)` | W4 改造 |
| 20 | src/ui/studio-settings-panel.ts:260 | 已转义 | `mem.type` / `mem.name` / `mem.content` → `escapeHtml(...)` | W4 改造 |
| 21 | src/ui/studio-settings-panel.ts:283 | 静态模板 | Lever-Hub 服务地址/状态骨架 | 保留 |
| 22 | src/ui/studio-ui-core.ts:148 | 通用通道 | `props.html`：仅接受静态模板或已 DOMPurify 消毒 HTML，不可信文本用 `props.text` | 加来源注释，不改行为 |

## 二、本次移出 innerHTML 的 4 处（改 textContent，已不出现）

| 原位置 | 原插值 | W4 动作 |
|---|---|---|
| studio-chat-room.ts:134 | `config.roomName` | 标题/副标题改 `textContent` 构建 |
| studio-right-sidebar.ts:194 | `item.name` / `item.modified` | 改子元素 `textContent` |
| studio-settings-panel.ts:297 | `app.name` / 体积 | 改子元素 `textContent` |
| studio-skills-panel.ts:184 | `skill.name` / `skill.description` | 改子元素 `textContent` |

## 三、安全说明

- `renderMarkdown`（src/inject/markdown.ts）经 DOMPurify.sanitize；W4 追加 `afterSanitizeAttributes`
  hook，剥离 `javascript:` / `data:` / `vbscript:` 链接的 href；`<script>` 与 `on*` 属性由 DOMPurify 默认移除。
- `props.html` 是通用构造器通道，调用方责任：只传静态模板或已消毒 HTML；不可信文本一律走 `props.text`。
- `tools/audit/security.ts` 对 innerHTML 一律计数 exit(1)，不区分分类，故其非零不代表存在未消毒注入；
  本表即其「剩余项逐条分类」的依据。
