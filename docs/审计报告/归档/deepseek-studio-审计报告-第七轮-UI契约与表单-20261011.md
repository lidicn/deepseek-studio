# deepseek-studio 代码审计报告（第七轮 · UI 契约与表单）

- 日期：2026-10-11
- 范围：PolicyMode 类型契约；MCP 编辑表单；设置面板各保存按钮的失败处理
- 触发：用户「下一轮继续寻找界面相关 bug」
- 结论：发现策略档位三方定义不一致；MCP 编辑不加载已有配置（编辑即清空）；设置面板多处静默失败

---

## 1. 关键缺陷

### F7-C1 PolicyMode 三方定义不一致（Critical）

同一枚举在三个地方定义，取值集合互不相同：

| 位置 | 取值 | 问题 |
|------|------|------|
| host/policy.ts `PolicyMode` | workspace / ask / auto / full | 完整（4 项） |
| host/policy.ts `PANEL_POLICY_MODES` | workspace / auto / full | 面板暴露 3 档（无 ask） |
| ui/studio-ui-core.ts:25 | full / auto / ask | **缺 workspace** |
| ui/studio-input-bar.ts modeLabels | full / auto / ask | **缺 workspace** |
| ui/studio-settings-panel.ts policyDefs | full / auto / ask | **缺 workspace** |
| ui/agent-panel.ts:17 | workspace / ask / auto / full | 完整 |

后果：
1. **注入面板（sidebar/input-bar/settings）无法选择「仅工作区」档**——用户在 StudioUI
   里根本看不到这个选项，而 agent-panel 与宿主都支持。同一产品两个面板档位不同。
2. **settings-panel 反而多出 ask**：其 policyDefs 含 ask，调 `policy.set` 传 ask；
   而宿主 setPolicyMode 校验的是 PANEL_POLICY_MODES（不含 ask），会被拒绝——
   用户点了「每次询问」实际不生效（且是静默失败，见 F7-H1）。
3. globalState.policyMode 类型 `''full''|''auto''|''ask''`，即便想设 workspace 也类型不符，
   TS 会在编译期挡住——所以这不是手滑漏写，是**契约未收敛**。

修复：单一真相源——从 host/policy.ts 导出 PolicyMode，UI 侧 import 复用，
禁止各处重定义。

### F7-H1 MCP 编辑不加载已有配置，保存即清空（High）

studio-mcp-dialog 的 open(serverId)：
```ts
function open(serverId?: string): void {
  editingServerId = serverId ?? null;
  ...
  (nameInput).value = serverId ?? '';    // 只回填 name
  (cmdInput).value = '';                 // 其余全清空
  (urlInput).value = '';
  argsList.innerHTML = '';
  envList.innerHTML = '';
  headersList.innerHTML = '';
  transportType = ''stdio'';              // 且强制回 stdio
  (transportSelect).value = ''stdio'';
```
用户点 MCP 列表的「编辑」，看到的是一张**空白表单**（只有名字），原有 command/args/url/env
全部不可见。若直接点保存 → `mcp.save({serverId, config})` 用空配置覆盖原配置。
「编辑」实际退化为「删除重填」。且 http 类型服务器被强制重置为 stdio，
updateTransportFields 会把 url 字段藏起来。

修复：open(serverId) 应从已加载的 MCP 配置里读取该 server 的完整定义并回填各字段
（含 transport/command/args/url/env/headers），再 updateTransportFields。

### F7-H2 设置面板多处静默失败（High）

settings-panel 的保存类按钮普遍只 `await callHostTool(...)` 而不检查 result：
```ts
// workspace 保存
const result = await callHostTool(''workspace.set'', {...});
if (result.ok) { ...提示已保存... }        // 失败分支完全缺失 → 静默

// policy 选择
await callHostTool(''policy.set'', { mode: pDef.id });   // 无检查

// MCP 删除
await callHostTool(''mcp.remove'', { serverId });        // 无检查
```
叠加第四轮 F4-C1（这些点号名全被判 unknown-tool）与 F4-C2（workspace.set /
policy.set / mcp.remove 宿主端本就无实现）：用户点「保存工作区」「切换策略」
「删除 MCP」，界面既不成功也不报错，按钮文字还停在「保存」——完全无反馈。

这与前几轮「假成功」相对，是「失败无声」。修复：所有 callHostTool 调用统一
检查 result.ok，失败走与 mcp-dialog 相同的 testResult 错误提示。

### F7-M1 MCP 列表硬编码传输类型（Medium）

renderMcpServers 渲染每行时 `<div class="studio-mcp-server-cmd">stdio</div>` 是常量，
不读实际 transport/command。所有服务器都显示 "stdio"，无法从列表区分类型。

### F7-M2 工作区输入框默认值硬编码（Medium）

`attrs: { value: globalState.workspaceRoot ?? ''E:\\'' }` —— globalState.workspaceRoot
初始为 null，故输入框默认显示 E:\，与真实工作区无关，误导用户以为已配置。

---

## 2. 与前几轮的关系

本轮是第四轮（命名空间）与第五轮（事件总线）在**表单/契约层**的延续：

| 层 | 断裂点 | 轮次 |
|----|--------|------|
| 工具名 | 点号 vs 下划线 | 第四轮 F4-C1 |
| 事件名 | emit vs on 不配对 | 第五轮 F5-C1 |
| 枚举值 | PolicyMode 三方不同 | 本轮 F7-C1 |
| 表单数据 | open 不回填配置 | 本轮 F7-H1 |

四者同源：跨模块契约缺单一真相源。

---

## 3. 方法论反思

1. **枚举也要查「几处定义」**：PolicyMode 这类小枚举最容易被各模块重复声明，
   差异静默累积。审计时应 grep 类型名，统计定义点数量——超过 1 就是风险。
2. **「编辑」表单必查「是否加载现值」**：open(editing) 只填 name 不填其余，
   是典型的「看起来能编辑、实则清空」缺陷。对照检查：新增与编辑两条路径是否
   都完整初始化/回填。
3. **「if (result.ok)」后面有没有 else**：本轮 3 处只有成功分支。
   审计 UI 调用点时应检查「失败分支是否存在、是否有用户可见反馈」。
   与前几轮「假成功」互为镜像——这里是「失败无声」。
4. 第七轮工具层面又复现一次 Substring 索引 -1（历史命令复用），
   已通过 IndexOf 定位法绕过；关键证据均取得，不影响结论。

---

## 4. 七轮汇总

| 轮次 | 范围 | Critical | High | Medium |
|------|------|----------|------|--------|
| 一 | 工具调用链路 | 6 | 4 | 5 |
| 二 | 执行层 | 3 | 3 | 4 |
| 三 | 授权与生命周期 | 1 | 3 | 2 |
| 四 | UI 命名空间 | 2 | 2 | 3 |
| 五 | UI 事件总线 | 2 | 3 | 1 |
| 六 | UI 生命周期 | 1 | 1 | 0 |
| 七 | UI 契约与表单 | 1 | 2 | 2 |
| 合计 | | 16 | 18 | 17 |

**贯穿七轮的元模式（已高度收敛）**：
跨模块契约缺单一真相源 —— 工具名、事件名、枚举值、表单字段，四类同病。
统一治理手段：每类契约建常量表/唯一导出 + 启动期或 CI 期配对断言。

---

## 附录：证据索引
- PolicyMode 三方：host/policy.ts（PolicyMode + PANEL_POLICY_MODES）、
  ui/studio-ui-core.ts:25、ui/studio-input-bar.ts:99-110、
  ui/studio-settings-panel.ts:140-152、ui/agent-panel.ts:17
- MCP 编辑不回填：studio-mcp-dialog.ts open()（nameInput=serverId，其余=''''）
- 静默失败：studio-settings-panel.ts workspaceSaveBtn / policy option / delBtn
- 硬编码传输类型：studio-settings-panel.ts renderMcpServers
- 工作区默认值：studio-settings-panel.ts workspaceInput attrs.value
- 基线：tsc --noEmit 退出码 0；vitest 201 用例全绿（无契约一致性测试）
