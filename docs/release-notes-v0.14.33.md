# v0.14.33 发版说明

发布日期：2026-11-25（tag `v0.14.33`；本版修复**模型轮首抢跑 memory_save——无论用户问什么都先调一次记忆保存，占位内容被记忆闸拒绝后才继续干活**）

## 这版修了什么

### 1. memory_save 轮首抢跑（`94f7eb3`）

**现象**：用户问「当前可用的 skill 和 mcp 有哪些」⇒ 模型轮首第一枚调用是 `memory_save`，内容是占位串 `{"type":"user","name":"测试","content":"测试","tags":["test"]}` ⇒ 被记忆闸拒绝（`memory-save-needs-explicit-instruction`）⇒ 之后才用 `mcp_list` 与 `python_exec` 完成回答。每轮白耗一枚调用；若某轮模型单独只发 `memory_save`，终止信号会让该轮直接收场、用户什么都得不到。

**根因**：提示词常量自身在教模型抢跑（`src/inject/main-world-interceptor.ts`）——

- `## 工具调用` 示例段给了一枚 `memory_save` 的「标准示范」，示范内容恰是记忆闸要拦的「推断出来的偏好」，模型照着模仿；
- `## 扩展能力` 段写长期记忆「你可以主动使用……无需先询问」，与 `## 记忆保存规则` 的「只有明确要求才调用」互相矛盾；
- 两份工具目录行的 `memory_save` 均无任何「仅限明确要求」限定语。

**修复**（四处，全在提示词常量，零执行逻辑改动）：

1. 示例段的 `memory_save` 示范换成中性 `<search_files>{"operation":"list","root":"E:/Users/name","limit":10}</search_files>`（合法 JSON、合法标签；`<memory_save>` 示范标签在源码与产物双双清零）；
2. 扩展能力第三条收紧：「仅当用户明确说『记住 / 记一下 / 别忘了』时才调用 memory_save；其余情况一律不调用，不要用占位或测试内容试探」——消除与记忆规则的矛盾；
3. 记忆保存规则段首加硬规则：「禁止轮首主动调用 memory_save 试探或保存占位/测试内容；没有明确记忆指令时，本轮任何位置都不得调用 memory_save」；
4. 两份目录行的 `memory_save` 描述加同款限定语「保存长期记忆（仅限用户明确要求时调用）」（两处逐字一致，`toolCatalogNames` 名字集合不变、memory_save 仍在目录里）。

上版记忆闸与止损（v0.14.31 的 terminate 透传）行为未动——被拒工具不再空转、单发即停的语义保持。

## 验证

- 全量闸 **exit=0**（GATE#128，1689.8s），vitest **340 files／3772 passed／1 skipped**；entry-freshness PASS `E67C3663`（重建 entry.js 483,982 B）
- CI run **45458828250**（head `94f7eb3`）：success
- 新测试件 `tests/desktop/memory-firstshot-prompt.test.ts` 三格：示例段无 `<memory_save>`＋中性示例在位／扩展能力第三条带限定且旧宽松句不复活／两份目录行带限定且逐字一致＋`toolCatalogNames` 名字集合 10 枚不变
- 独立窄面 7 件 **65/65**＋tsc EXIT=0；受波及 5 件测试（m15 三件／tool-contract／memory-tool-boundary）零断言改动原样通过
- 仓外负控：扩展能力第三条改回旧宽松措辞 ⇒ 「限定在位」格红（靶心命中）；还原复绿、真树 SHA256 全程未动
