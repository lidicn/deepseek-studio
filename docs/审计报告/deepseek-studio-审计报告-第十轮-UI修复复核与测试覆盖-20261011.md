# deepseek-studio 代码审计报告（第十轮 · UI 修复复核与测试覆盖）

- 日期：2026-10-11
- 范围：F4-C1/C2（UI 命名与宿主能力）修复核实；UI 侧其余 High 项复核；UI 契约测试覆盖
- 触发：用户「下一轮继续寻找界面相关 bug」
- 结论：**F4-C1/C2 修复已实质到位（正面）**；但 **UI 契约零测试覆盖**，
  且 **可点性的结构风险（F4-H1/H2、F6-C1）仍未修**

---

## 1. 正面核实：F4-C1 / F4-C2 已实质修复

### F4-C1（UI↔宿主命名）—— 已修复 ✅

tool-contract 现在共 28 个键，**完整覆盖 UI 直调的点号名**：
```
mcp.test  mcp.save  mcp.remove  memory.delete  workspace.set  policy.set
project.list  project.create  folder.pick  skill.list  memory.save  python.exec
mcp.list  mcp.call  shell.exec  file.read  file.write  file.stat
```
（对比第四轮：当时只有 10 个下划线键，无一个点号键 → 全部 unknown-tool）

### F4-C2（宿主能力缺失）—— 已修复 ✅

desktop-host hostTools 现注册 14 项：
```
skill.list  memory.save  python.exec  mcp.list  mcp.call  mcp.test  mcp.save
mcp.remove  memory.delete  workspace.set  policy.set
project.list  project.create  folder.pick
```
（对比第四轮：当时只有 7 项，缺 project/folder/workspace/policy/mcp.remove/memory.delete）

tool-definitions 同步注册 23 个 id。三者（契约映射 / hostTools / 注册表）**已对齐**。

**结论：用户「按钮点不动」的主根因（命名断裂 + 能力缺失）已在代码层闭环。**

---

## 2. 关键缺口：UI 契约零测试覆盖（Critical）

### 事实
```
grep -E "mcp\.save|mcp_save|project\.create|folder\.pick|workspace\.set|policy\.set" tests/**/*.ts
→ 零命中
```

即：**tool-contract 里这 16 个点号键，没有任何测试锁定它们可解析。**

### 为什么这是 Critical 而非 Info

1. **修复无回归保护**。F4-C1 的修复方式是在 tool-contract 里**逐项枚举**点号键。
   任何人后续新增 UI 调用（如 `memory.save` 之外的 `memory.list`）若忘记同步加键，
   **会再次静默回落到 unknown-tool** —— 且没有任何测试会失败。
2. **这正是第九轮教训在 UI 层的重演**。第九轮发现「修复未跑测试」导致回归存活；
   本轮发现「UI 契约修复也没有测试」。同一缺口，换了一层。
3. **三份名单需人工同步**。契约映射（28 键）、hostTools（14 项）、tool-definitions（23 id）
   是三张各自维护的表。目前恰好对齐，但**没有任何机制保证它们持续对齐**。

### 建议（可机械执行）

新增一条契约一致性测试：
```
对 UI 侧每个 callHostTool(name) 的 name：
  断言 mapUpstreamToolInvocation(name) !== null
  断言 registry.get(mapped.id) 存在
  断言 executionSide 对应的 hostTools/capabilities 中有该 id
```
这把「三张表是否对齐」变成 CI 可拦截的红线。

---

## 3. UI 可点性的结构风险：仍未修

用户症状「很多按钮按不了」除命名/能力外，还有两个结构层原因，本轮复核**均未修**：

### F4-H2 pointer-events 白名单（仍在）
```
studio-ui-core.ts:99   container.style.cssText = ''display:block;pointer-events:none;'';
studio-ui-core.ts:201  .studio-ui-root > * { pointer-events: auto; }
studio-ui-core.ts:204  .studio-sidebar, .studio-right-sidebar, .studio-input-bar,
                       .studio-modal-overlay, .studio-skills-overlay, .studio-right-toggle { pointer-events: auto; }
```
根容器固定 `none`，仅靠**类名白名单**恢复。任何新组件根类名不在名单内 → 整块不可点。
**这正是「按钮按不了」的潜在复发点**：新增面板若忘记加类名，就会重演症状。

### F4-H1 假 Shadow DOM（仍在）
```
studio-ui-core.ts:100  return { container, shadow: container };   // shadow 就是 container
```
注释称「创建带 Shadow DOM 的容器」，实则未创建。所有样式注入全局 `<style>`，
与 deepseek 站点样式互相污染 —— 可能造成按钮被站点样式覆盖。

### F6-C1 监听器泄漏（仍在）
```
grep removeEventListener|unsubs|unsubscribe  src/ui/*.ts
→ consent.ts:150,174（keydown）
→ studio-ui-install.ts:228（keydown）
→ 无任何 globalEvents 退订
```
15 处 `globalEvents.on(...)` 的返回值仍被丢弃；studio-input-bar 的 document click 仍无清理。
重装后旧处理器仍响应 → 重复弹窗 / 面板错乱。

---

## 4. 回归仍在（承接第八/九轮）

```
npx vitest run → 2 failed | 31 passed (33)；289 passed (291)
FAIL tool-authority.test.ts:22 / smoke.test.ts:49
AssertionError: expected ''not-found'' to be ''consumed''
```
R3-H2 的 `grant-store.get()` 回归未修（第九轮已给出精确补丁）。

---

## 5. 十轮全景：UI 症状的四层归因与当前状态

| 层 | 缺陷 | 状态 |
|----|------|------|
| 命名 | F4-C1 UI 点号 vs 宿主下划线 | ✅ 已修（但无测试） |
| 能力 | F4-C2 宿主缺 project/folder/workspace 等 | ✅ 已修（但无测试） |
| 结构 | F4-H1 假 Shadow DOM / F4-H2 pointer-events 白名单 | ❌ 未修 |
| 生命周期 | F6-C1 监听器泄漏（重装后幽灵响应） | ❌ 未修 |
| 事件 | F5-C1 幽灵订阅（6 emit-only + 5 on-only） | ⚠️ 未确认 |

即：**「按不动」的最直接原因修好了，但「按了会错乱」的结构与生命周期原因还在**，
且全部四层都没有测试保护。

---

## 6. 方法论反思

1. **修复复核要分「代码层」与「契约层」**。本轮 F4-C1/C2 在代码层确已修好，
   但契约层（三张表对齐）无测试 —— 修好 ≠ 不会退化。
2. **同一缺口会在不同层反复出现**。第九轮是「修复未跑测试」，
   本轮是「UI 契约未写测试」，本质都是**缺少把约定固化为断言的动作**。
3. **「已修复」的完整定义应包含三层**：代码改对 + 行为期测试通过 + 契约有断言保护。
   缺任何一层，都只能算「暂时生效」。
4. 本轮工具层面多次遇到 Substring 索引 -1（历史命令复用），
   已统一改用「IndexOf + 长度钳制」模式，所有关键证据均取得。

---

## 7. 建议的下一步（按投入产出）

1. **一行修复**：`grant-store.get()` 改回 `return g ?? null;` → vitest 回全绿（第九轮已给）。
2. **一条契约测试**：UI 调用名 → mapUpstream → registry → hostTools 全链断言。
   一次性锁住 F4-C1/C2，防止复发。
3. **结构修复**：pointer-events 改为根容器默认 auto、去掉白名单（F4-H2）；
   createShadowContainer 真正创建 Shadow DOM 或修正注释（F4-H1）。
4. **生命周期修复**：installStudioUI 的 destroy 统一退订（F6-C1）。

---

## 附录：证据索引
- 契约键（28 个，含 16 点号）：src/shared/tool-contract.ts
- hostTools（14 项）：src/host/desktop-host.ts
- 注册 id（23 个）：src/host/tool-definitions.ts
- UI 契约测试覆盖：tests/**/*.ts grep 零命中
- pointer-events：studio-ui-core.ts:99,201,204
- 假 Shadow DOM：studio-ui-core.ts:100
- 监听器无清理：src/ui/*.ts grep（仅 keydown）
- 复跑：2 failed | 289 passed (291)，expected ''consumed'' got ''not-found''
