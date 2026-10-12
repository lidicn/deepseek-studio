# deepseek-studio 代码审计报告（第五轮 · UI 事件总线）

- 日期：2026-10-11
- 范围：src/ui/* 全部组件的事件收发配对；agent-panel 与 agent.html 的 id 一致性
- 触发：用户「下一轮继续寻找界面相关 bug」
- 结论：发现【幽灵订阅】缺陷类——自由字符串事件总线，emit/on 无配对校验，
  系统性存在 6 处 emit 无监听、5 处监听无 emit

---

## 1. 新根因：事件总线幽灵订阅（Critical / High）

globalEvents 是 EventBus（Map<string, Set<handler>>），事件名是裸字符串，
没有任何常量表、类型约束或启动期配对断言。组件各自 emit 自己关心的、on 自己关心的，
中间全靠约定。系统性扫描结果：

### emit 但无任何监听（按钮点了「有事件、无反应」）

| 事件名 | 发起方 | 用户可见后果 | 严重度 |
|--------|--------|--------------|--------|
| ui:policy-changed | studio-input-bar | 输入栏切换权限模式（全部允许/自动审批/每次询问）后**策略根本不生效** | Critical |
| ui:project-created | studio-project-picker | 通过本地文件夹创建项目后，**项目列表不刷新**，用户以为没建成 | Critical |
| ui:mcp-saved | studio-mcp-dialog | MCP 保存成功后，设置面板的服务器列表不刷新（仅靠自身 push globalState 部分自洽） | High |
| ui:open-file | studio-right-sidebar | 右侧栏点击「对话产物/最近文件」条目**无任何反应** | High |
| ui:local-tools-toggled | studio-input-bar | 「本地电脑」开关点击后只翻转内部状态，**无人响应** | High |
| ui:plugins | studio-input-bar | 「插件」按钮永远无效果（第四轮 F4-M1 单例，本轮确认为类） | Medium |

### 有监听但永不触发（订阅了没人发的事件，功能形同虚设）

| 事件名 | 监听方 | 后果 |
|--------|--------|------|
| ui:artifact-added | studio-right-sidebar | 右侧栏「对话产物」列表**永不更新** |
| ui:task-added | studio-right-sidebar | 右侧栏「后台任务」列表**永不更新** |
| ui:task-updated | studio-right-sidebar | 任务状态**永不刷新** |
| ui:skills-updated | studio-right-sidebar | 右侧栏技能标签**永不更新** |
| ui:projects-updated | studio-sidebar | 左侧栏项目列表**永不刷新** |

即：右侧边栏（studio-right-sidebar）整个「工作台」面板的四个数据区全部是死订阅，
渲染函数写了、监听挂了，但没有任何代码 emit 这些事件 → 该面板永远显示空态。

---

## 2. 验证通过项（避免误伤）

### agent-panel.ts ↔ agent.html 的 id 完全一致 ✅
- html 提供：app / workspace-box / ws-path / btn-open-folder / policy-switch / conn /
  conn-dot / conn-text / stream / input / hint / btn-stop / btn-send
- panel 查询：stream / input / btn-send / btn-stop / btn-open-folder / ws-path / conn-dot / conn-text / hint
- 9 个查询 id 全部命中，agent-panel 的按钮绑定与状态机是健康的。
  （说明「按钮失效」不是全局现象，而是特指注入到 deepseek 页面的 studio-* 组件）

---

## 3. 因果链补充（叠加第四轮）

用户可见的「按钮按不了」是**两层原因叠加**：

1. **F4-C1（第四轮）**：凡是需要调宿主的按钮 → callHostTool(点号名) → unknown-tool
   （MCP 保存、项目创建、工作区、策略…）
2. **F5-C1（本轮）**：凡是不调宿主、纯前端联动的按钮 → emit 了无人监听的事件 → 无反应
   （权限模式切换、本地电脑开关、打开文件、右侧栏全部数据区）

两层覆盖了几乎所有 UI 交互路径，所以用户观感是「大部分 UI 都有问题」。

---

## 4. 方法论反思

1. **缺陷类 > 单例**：第四轮把 ui:plugins 当单例报，本轮做 emit/on 双向配对矩阵扫描，
   才发现是 6+5 的系统性问题。审计时应主动做「收发配对」这类矩阵化检查，
   而不是逐个读组件。这与记忆 #8「接缝缺陷」同源——事件总线也是一条接缝。
2. **自由字符串作为跨模块契约 = 高危**：与 tool-contract 的点号/下划线断裂（F4-C1）同类，
   都是「靠约定、无单一真相源」。事件名应有常量表 + 启动期配对断言。
3. **反向扫描不可省**：只查「按钮点击是否有 handler」会漏掉「handler emit 了没人听」。
   必须同时统计 emit 集合与 on 集合的差集（双向）。
4. 本轮零工具失败；agent-panel 的 id 一致性验证是「负面发现也要记录」的实践。

---

## 5. 修复建议（按投入产出排序）

1. **为事件名建立常量表 + 启动期配对断言**：定义 UI_EVENTS 常量对象，
   开发模式下校验「每个 emit 的名字在注册表内、且至少有一个 on」。可一次性杜绝此类。
2. 补齐 6 个死 emit 的监听方：
   - ui:policy-changed → desktop-host 的 setPolicyMode（需先修 F4-C1 命名）
   - ui:project-created → studio-sidebar / project-picker 刷新列表（需先补 F4-C2 能力）
   - ui:open-file → 注入侧打开文件或调宿主 file 能力
   - ui:local-tools-toggled → 联到 policy 或 localTools 开关
3. 右侧栏四个死订阅：要么补 emit 源（由 AgentLoop 的 tool 事件驱动 task-added），
   要么移除该面板避免误导。

---

## 6. 五轮汇总

| 轮次 | 范围 | Critical | High | Medium |
|------|------|----------|------|--------|
| 一 | 工具调用链路 | 6 | 4 | 5 |
| 二 | 执行层 | 3 | 3 | 4 |
| 三 | 授权与生命周期 | 1 | 3 | 2 |
| 四 | UI 交互层（命名空间） | 2 | 2 | 3 |
| 五 | UI 事件总线 | 2 | 3 | 1 |
| 合计 | | 14 | 15 | 15 |

**贯穿五轮的元模式**：跨模块契约靠「约定」而非「单一真相源」——
工具名（点号 vs 下划线）、事件名（自由字符串）、字段名（adapt 丢键）、
生命周期状态（snapshot 硬编码）。这是本项目最值得系统性治理的一点。

---

## 附录：证据索引
- emit 全集：studio-input-bar / studio-mcp-dialog / studio-project-picker /
  studio-right-sidebar / studio-settings-panel / studio-sidebar / studio-ui-install
- on 全集：studio-input-bar / studio-mcp-dialog / studio-project-picker /
  studio-right-sidebar / studio-settings-panel / studio-sidebar / studio-skills-panel / studio-ui-install
- EventBus 定义：studio-ui-core.ts（Map<string, Set<EventHandler>>，无校验）
- agent-panel id 比对：agent.html 13 个 id 覆盖 panel 的 9 个查询
- 基线：tsc --noEmit 退出码 0；vitest 201 用例全绿（UI 事件总线无测试覆盖）
