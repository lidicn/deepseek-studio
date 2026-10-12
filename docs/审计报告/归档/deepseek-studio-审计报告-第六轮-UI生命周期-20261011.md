# deepseek-studio 代码审计报告（第六轮 · UI 生命周期与监听器泄漏）

- 日期：2026-10-11
- 范围：installStudioUI / destroy 生命周期；globalEvents 订阅清理；全局 DOM 监听器
- 触发：用户「下一轮继续寻找界面相关 bug」
- 结论：发现【监听器永不退订 + 重装累积】缺陷类——第五轮幽灵订阅的姊妹问题

---

## 1. 新根因：监听器泄漏（Critical / High）

### F6-C1 destroy() 不清理 globalEvents 订阅（Critical）

事件总线 EventBus.on 明确定义了退订能力：
```ts
// studio-ui-core.ts:40
on(event, handler) {
  ...
  return () => this.handlers.get(event)?.delete(handler);   // 返回退订函数
}
```
但**全仓无任何调用点**——grep `unsubscribe` / `off(` 在 src/ui/*.ts 零命中。
所有 15 处 `globalEvents.on(...)` 的返回值都被丢弃。

而 installStudioUI 的 destroy() 只做三件事：
```ts
destroy: () => {
  destroyed = true;
  document.removeEventListener(''keydown'', handleKeydown);
  for (const c of containers) c.remove();      // 只删 DOM
  adjustMainContentMargin(0);
}
```
→ **15 个 globalEvents 处理器全部残留在单例 EventBus 上**，闭包仍持有已销毁组件的内部状态。

### F6-C2 document 级 click 监听永不移除（High）
```ts
// studio-input-bar.ts:127
document.addEventListener(''click'', () => { modeDropdown.style.display = ''none''; });
```
挂在 document 上、无命名函数、无移除。每次输入栏重建就多一个常驻监听器。

---

## 2. 后果链

1. **重装累积**：inject 生命周期在文档卸载 / 路由重载时会 destroy 再重建 UI。
   每次重建 → 新增 15 个 globalEvents 处理器 + 1 个 document 监听；旧的永不释放。
   典型场景：deepseek 页面内多次切换会话/路由后，处理器数量线性增长。

2. **幽灵响应（用户可见）**：old 组件的处理器仍在监听。当 `ui:settings`、`ui:mcp-add`
   等事件触发时，**旧面板与新面板会同时响应**：
   - 旧 settings-panel 的 `isOpen ? close() : open()` 会操作已从 DOM 移除的 overlay
   - 可能出现重复弹窗、或新面板被旧处理器「抢先 close」
   - 对已销毁节点 setStyle / classList，轻则无效果，重则抛错中断其它处理器

3. **内存泄漏**：每个残留闭包持有整个面板的 DOM 子树引用，无法被 GC。
   长会话页面上，泄漏随重装次数线性增长。

4. **mcp-dialog 重入放大**：`ui:mcp-edit` 会带 payload 调 open(serverId)，
   旧实例同样响应 → 可能打开一个指向已移除 DOM 的编辑态。

---

## 3. 验证通过项（避免误伤）

- installStudioUI 在 main-world-interceptor.ts 中**只调用一次**（line 678，grep 计数 = 1），
  单次装配本身没有双装问题；问题在于「重复装配周期」与「destroy 不对称」。
- destroy 对 keydown 的移除是正确的（removeEventListener 命中），
  说明作者有清理意识，只是漏了事件总线与 click 两处。

---

## 4. 与前五轮的关系

第五轮报「emit 无人监听」（幽灵订阅）；本轮报「监听器永不退订」（幽灵监听累积）。
二者合起来才是完整的事件总线问题：

| 方向 | 缺陷 | 轮次 |
|------|------|------|
| 发了没人听 | 6 处 emit-only | 第五轮 F5-C1 |
| 听了没人发 | 5 处 on-only | 第五轮 F5-C1 |
| 听了不退订 | 15 处 on 无清理 | 本轮 F6-C1 |

根因同一：EventBus 是自由字符串 + 无生命周期契约。

---

## 5. 方法论反思

1. **对称性检查是发现此类缺陷的钥匙**：install 有 destroy，就要逐项对照「谁订阅、谁退订」。
   本轮把 15 处 on 与 0 处退订并列，缺陷立刻显形。审计 UI 组件时，「创建/销毁是否对称」
   应作为固定检查项。
2. **「有 API 无人用」是强信号**：EventBus 精心返回了退订函数却零调用点，
   说明订阅方普遍缺乏生命周期意识。类似信号：定义了的错误码从未被检查、
   声明了的字段从未被读。
3. **单例 + 闭包 = 泄漏温床**：globalEvents 是模块级单例，组件闭包捕获 DOM，
   二者相遇且不退订，必然泄漏。这与记忆 #8「断线不清 pending」同构——
   都是「注册了资源却不回收」。
4. 本轮一次工具失败（Substring 索引 -1，字符串空白不匹配），已改用 IndexOf 定位后重试成功。

---

## 6. 修复建议

1. 各组件持有 `const unsubs = []`，`unsubs.push(globalEvents.on(...))`；
   组件返回 dispose，由 installStudioUI 汇入 containers 一同在 destroy 时调用。
2. 把 document click 监听改为命名函数并保存引用，destroy 时 removeEventListener。
3. 给 EventBus 增加 `clear()` 或按 owner 分组，destroy 时整组清理。
4. 加一条测试：install → destroy → 断言 globalEvents 处理器数回到基线。

---

## 7. 六轮汇总

| 轮次 | 范围 | Critical | High | Medium |
|------|------|----------|------|--------|
| 一 | 工具调用链路 | 6 | 4 | 5 |
| 二 | 执行层 | 3 | 3 | 4 |
| 三 | 授权与生命周期 | 1 | 3 | 2 |
| 四 | UI 命名空间 | 2 | 2 | 3 |
| 五 | UI 事件总线（幽灵订阅） | 2 | 3 | 1 |
| 六 | UI 生命周期（监听器泄漏） | 1 | 1 | 0 |
| 合计 | | 15 | 16 | 15 |

---

## 附录：证据索引
- EventBus.on 退订函数：studio-ui-core.ts:40
- 无退订调用：grep unsubscribe/off( 在 src/ui/*.ts 零命中
- 15 处 globalEvents.on：studio-input-bar:151 / mcp-dialog:314-315 / project-picker:209-210 /
  right-sidebar:258-264 / settings-panel:303 / sidebar:249 / skills-panel:239-240 /
  ui-install:171,200
- destroy 实现：studio-ui-install.ts（只 removeEventListener(keydown) + 容器 remove）
- document click：studio-input-bar.ts:127
- installStudioUI 调用次数：main-world-interceptor.ts:678（1 次）
- 基线：tsc --noEmit 退出码 0；vitest 201 用例全绿（无生命周期对称性测试）
