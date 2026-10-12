# deepseek-studio 代码审计报告（第四轮 · UI 交互层）

- 日期：2026-10-11
- 触发症状（用户实测）：大量按钮点击无反应；MCP 设置保存不了；新建项目/工作任务失效
- 范围：src/ui/* 全部组件、page-runtime tool-call 入口、tool-contract 映射、desktop-host hostTools
- 结论：症状有单一主根因（F4-C1），非「事件没绑上」，而是请求发出后被宿主判为 unknown-tool

---

## 1. 主根因

### F4-C1 UI ↔ 宿主工具名契约断裂（Critical，High 置信）

链路：UI 按钮 → callHostTool(点号名) → host-client.sendToolCall → ws tool-call →
      page-runtime `mapUpstreamToolInvocation(invocationName)` → 查 UPSTREAM_TO_STUDIO 表。

- UI 传的是**点号内部 id**：mcp.save / mcp.test / project.create / folder.pick /
  workspace.set / policy.set / mcp.remove / memory.delete / skill.list / file.read / shell.exec
  （证据：studio-mcp-dialog.ts:275 `callHostTool(''mcp.save'', ...)` 等十余处）
- 映射表 UPSTREAM_TO_STUDIO 的**键全是下划线上游名**：
  shell_exec / local_file_read / local_file_write / local_file_stat /
  memory_save / python_exec / mcp_list / mcp_call / mcp_test / mcp_save
  （证据：tool-contract.ts:30-109）
- `mapUpstreamToolInvocation(name)` 用 `UPSTREAM_TO_STUDIO[name]` 查键。''mcp.save'' 不在表里 → 返回 null →
  page-runtime 回 `{ok:false,error:''unknown-tool''}`。

结论：**UI 的每一次 callHostTool 都返回 unknown-tool**。按钮的事件监听、globalEvents 都是好的，
是最后一步「调宿主」被命名空间不匹配全部拦下——用户看到的就是「点了没反应」。

这是「接缝缺陷」的又一实例：同一 tool-call 通道被两个调用方复用，
模型 XML 用上游下划线名、UI 用内部点号名，而中间只有一张按上游名索引的表。

修复（二选一）：
1. UI 侧改传上游名（mcp_save / shell_exec / local_file_read ...）；
2. page-runtime 先按 registry id 直查（''mcp.save'' 本就是 DEFAULT_TOOL_DEFINITIONS 里的 id），
   命中即直接用，未命中再回落 mapUpstreamToolInvocation。方案 2 更稳，且不牺牲模型通道语义。

---

## 2. 次要根因

### F4-C2 UI 依赖的宿主能力大多不存在（Critical，High 置信）
即便修好命名，UI 调用的下列能力在 hostTools 与 DEFAULT_TOOL_DEFINITIONS 中**均无实现**：
- project.create / project.list（studio-project-picker.ts:131,152）
- folder.pick（:127）
- workspace.set / policy.set / mcp.remove / memory.delete（studio-settings-panel.ts:124,153,189,264）
- hostTools 实际只有：skill.list / memory.save / python.exec / mcp.list / mcp.call / mcp.test / mcp.save
  （证据：desktop-host.ts:261-371）
→ 这批按钮即便命名修好仍是 unknown-capability。需补宿主实现，或改走 agent-channel
  （set-workspace / set-policy 已存在）。

### F4-H1 createShadowContainer 并未创建 Shadow DOM（High，注释-实现漂移）
- 注释：「创建带 Shadow DOM 的容器」；实现：`return { container, shadow: container }`——shadow 就是 container。
- 后果：injectStyles 全部把样式写进全局 <style id=studio-ui-component-styles>，
  `.studio-ui-root > *`、`.studio-btn` 等选择器作用于真实 DOM，与 deepseek 页面样式互相污染。

### F4-H2 pointer-events 依赖脆弱的类名白名单（High）
- 根容器固定 `pointer-events:none`，仅靠 `.studio-ui-root > *` 与
  `.studio-sidebar,.studio-right-sidebar,.studio-input-bar,.studio-modal-overlay,.studio-skills-overlay,.studio-right-toggle`
  白名单恢复 auto（studio-ui-core.ts:99,201-204）。
- 任何新组件若根类名不在名单内 → 整块不可点。属于「新组件必踩」的定时炸弹。
  （注：现有 modal-overlay 在名单内，故模态框本身可点；但这是巧合而非设计保障。）

### F4-H3 无宿主连接时静默无反馈（Medium）
- host 未连接时 sendToolCall 立即 resolve `{ok:false,error:''no-host''}`；多数 UI 不检查 result.error、
  不提示用户，表现为「点了没反应」。与前三轮「假成功」相对，这里是「失败无声」。

### F4-M1 死事件 ui:plugins（Medium）
- 有 `globalEvents.emit(''ui:plugins'')`，但全局无 `on(''ui:plugins'')` 监听 → 该按钮永远无效果。

### F4-M2 默认项目硬编码（Medium）
- studio-sidebar.ts / studio-project-picker.ts 均硬编码 `{id:''deepseek-studio'', path:''E:\\NAS\\deepseek-studio''}`，
  与真实工作区脱节；project.list 因 F4-C1/C2 拿不到数据，永远显示这条假数据。

---

## 3. 因果链（回应用户症状）

- 「按钮按不了」＝ 事件已触发，但 callHostTool 全被 unknown-tool 拦下（F4-C1）；
  少数无宿主时还被 no-host 静默吞掉（F4-H3）。
- 「MCP 设置保存不了」＝ saveConfig → callHostTool(''mcp.save'') → unknown-tool（F4-C1）。
- 「新建项目/工作任务失效」＝ project.create / project.list / folder.pick 既命名错（C1）又无实现（C2）；
  new-task 走 globalEvents 找 deepseek 页面「新对话」按钮，选择器高度依赖站点 DOM，易落空。

---

## 4. 方法论反思

1. 这轮再次验证记忆 #8：高价值缺陷集中在**层间接缝**。UI 与宿主各自都对，
   错在两者之间的命名约定没有单一真相源。建议：为 UI→宿主调用建立与 tool-contract 同源的 id 校验。
2. 症状「点了没反应」不等于「事件没绑」——先看**请求出口的返回值**，别只查 addEventListener。
   本轮若只读 UI 组件会误判「事件绑定缺失」，是跨到 page-runtime + tool-contract 才定位根因。
3. 注释-实现漂移再现（F4-H1 createShadowContainer）。与记忆 #11 同源，属高危信号。
4. 本轮工具自身失败 4 次（Substring 越界 ×2、here-string 被污染 ×1、python await 位置 ×1），
   全部为调用方参数问题，已修正重试，未影响结论。

---

## 5. 修复优先级

1. F4-C1 —— 一处判定逻辑即可让绝大多数按钮复活（page-runtime 先查 registry id）。
2. F4-C2 —— 补 project/folder/workspace/policy/mcp.remove/memory.delete 宿主能力，或改走 agent-channel。
3. F4-H1/H2 —— Shadow DOM 真正落地 + 去掉 pointer-events 类名白名单（改为根容器默认 auto）。
4. F4-H3/M1/M2 —— 错误可见化、清理死事件、项目列表接真实数据。

---

## 附录：证据索引
- UI 点号调用：studio-mcp-dialog.ts:257,275；studio-project-picker.ts:127,131,152；
  studio-settings-panel.ts:124,153,189,208,264；studio-skills-panel.ts:116,139,156
- 映射表键（下划线）：tool-contract.ts:30-109
- registry id（点号）：tool-definitions.ts（mcp.save/mcp.test/mcp.list/mcp.call 等）
- page-runtime 用 mapUpstreamToolInvocation 处理 tool-call（第一轮已核）
- hostTools 实有清单：desktop-host.ts:261-371
- pointer-events：studio-ui-core.ts:99,201-204
- createShadowContainer：studio-ui-core.ts:92-101
- 基线：tsc --noEmit 退出码 0；vitest 201 用例全绿（UI 层无测试覆盖）
