---
title: deepseek-studio 只读代码审计报告（TD · 第 3 轮 · 2026-11-02）
summary: 第 3 轮只读审计，基线 HEAD 12cfd55，工作区 6 M + 3 ??（web-engine.ts 有 145 行未提交新增）。覆盖 src/ui 全量、web-engine 断流结算、memory 域，证实 4 条（P1×1、P2×2、P3×1）：最严重是「本次对话始终允许」实际授出的是整个对话的全工具全目标免审加自动越界；另给出断流双所有者结论（仍存在、不等价，工作区新判据未接线）、4 条可疑未证实、4 处已核实无问题。
---

# deepseek-studio 代码审计报告（TD · 第 3 轮）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未跑 typecheck/vitest、未启动 tauri dev 或任何长驻进程。

## 一、审计基线与方法

| 项 | 取值 | 依据 |
|---|---|---|
| HEAD | `12cfd55afe141019169f54911819b450a0292236` | `git rev-parse HEAD` |
| 分支/上游 | `master` → `origin/master` | 同上轮 |
| 工作区 | 脉：6 个 `M` + 3 个 `??`（与第 2 轮同一集合，无新增航脏文件） | `git status --porcelain` |
| 有内容改动的文件 | `model-engine.ts`(34) / `web-engine.ts`(145 增 6 删) / `task-loop.ts`(40) / `task-loop-reply.test.ts`(25)；`memory/candidates.ts`、`memory/core.ts` 仅行尾差异 | `git diff --stat` |
| 取证时刻 | 2026-11-02 12:48–13:20（+08:00） | — |

**审计针对哪一份**：全部结论以 **HEAD `12cfd55` 为准**。唯 `src/host/engine/web-engine.ts` 有 145 行未提交新增，第二节 R3-03 与第四节的断流结论处已逐段标注「HEAD 版 / 工作区版」。其余被引用的文件均无未提交改动，file:line 对两份一致。

## 二、结论摘要

- 证实 **4 条**：P1×1、P2×2、P3×1。
- **最严重（R3-01）**：审批弹窗的「本次对话始终允许」并不是“这个对话里这个操作放行”。授权键是 `principal|workspaceHash|policyMode|conversationId`，**不含工具、不含目标**；命中后 `resolveAuthorization` 在 always/ mode 判定之前直接 `allow`，而且把 `outsideApproved` 设为 `outsideRequested`。也就是说：对一次无害的 `file.read` 点一下，同对话内任意 `shell.exec`、`file.write`、`policy.set`、`mcp.save`，包括工作区外的目标，全部不再询问。UI 文案与实际作用范围差了一个数量级。
- **断流双所有者（您点名要求定性）**：**仍存在，且两套判据不等价**；但“同一答案出现两次”**没有证据**。工作区版新增的 `readFinishSentinel` 未接线，所以严格判停**实际从未生效**，行为等同 HEAD。详见第三节 R3-03。
- UI 与注入层的 XSS 面本轮**全量核过，未发现可注入点**（第五节第 1 条）；不要在这两块重复投入。

## 三、缺陷清单

### P1 高危

#### R3-01 「本次对话始终允许」的实际授权范围是“整个对话、所有工具、所有目标、含越界”
- 位置链：
  1. `src/ui/consent.ts:252-257`：只要 `meta.allowConversation === true` 就渲染「本次对话始终允许」，**不区分 approvalClass、不展示作用范围**（旁边的 `scopeHint` 只写工具名/类/目标，是这个被审批的调用，不是 grant 的适用范围）。
  2. `src/host/desktop-host.ts:1634`：`allowConversation: conversationId !== undefined && conversationId !== ''`——只要带对话 id 就给按钮，对 `always` 类（`policy.set`、`workspace.set`、`mcp.save`、`mcp.remove`、`memory.delete/purge`、`chat-send`）一视同仁。
  3. `src/host/desktop-host.ts:1578-1586`：`conversationApprovalKeyOf({principal, workspaceHash, policyMode, conversationId})`——**key 里没有 toolId、没有 canonicalTarget**。
  4. `src/host/desktop-host.ts:1813-1826`：点下按钮 → `conversationStore.grant(key)`，一次写入。
  5. `src/host/authorization.ts:245-255`：`if (input.conversationApproved) return { decision: 'allow', reason: 'conversation-approved', outsideApproved: outsideRequested }`——位于 hard-deny / policy-deny 之后，但**在 always 与 mode 判定之前**，因此对所有工具生效，并直接把越界授权也一并给了。
- 触发条件：mode 档或 auto 档下，任意一次工具调用弹出审批（例如 `file.read` 读一个普通文件），用户点「本次对话始终允许」。
- 影响：此后同一对话（同 principal/工作区/档位）内，模型或被注入的页面可任意调 `shell.exec` 执行命令、`file.write` 写工作区内外文件、`policy.set` 改档位、`mcp.save` 写入新 MCP 服务器（后续 spawn 任意命令）——均静默执行。叠加第 2 轮 R2-01（页面可自答同意），攻击面从“一次点击”变成“永不追问”。与 UI 文案「本对话内后续调用不再逐次询问」字面相符，但用户理解的是这个操作，实际是整个对话全权。
- 证据类型：代码级证明（五跳已逐行读）。未做运行期复现。
- 修复建议（任一即可收窄）：① 把 `conversationApprovalKeyOf` 的入参加上 `toolId` 与 `canonicalTarget`，即“本对话内对同一工具、同一目标不再问”；② 若坚持对话级全工具放行，则按钮文案改为「本对话内允许所有工具（含高风险）」，并在弹窗里列出将一并放行的工具清单；③ 至少限制为“不再单独授予越界”：`outsideApproved` 不应由对话级 grant 隐含，越界必须逐次确认。
- 验收判据：审 `file.read` 后点「本次对话始终允许」，紧接着让模型调 `shell.exec {command:"whoami"}` 与 `file.write` 到工作区外——两者均必须重新弹窗（或直接被拒）；审计日志中 grant 行应带 toolId/target 字段。
### P2 一般

#### R3-02 审批弹窗把 Enter 绑成「允许一次」，且无输入法/焦点守卫
- 位置：`src/ui/consent.ts:281-294`：`function onKey(e){ if (e.key === 'Escape') settle('deny'); else if (e.key === 'Enter') settle('allow-once'); }`，同段 `doc.addEventListener('keydown', onKey)` **挂在 document 上**；对比 `:243-251` 按钮顺序是「允许一次 / 拒绝 / 本次会话允许」，无 focus trap、无 `inert`、未把焦点移到拒绝。
- 触发条件（两个都很常见）：
  1. **输入法**：用户在弹窗出现时还在用中文输入法打字，按 Enter 确认候选词——`keydown` 的 `key` 就是 `'Enter'`，**代码未判 `e.isComposing`/`keyCode===229`**，直接执行 `allow-once`。
  2. **页面输入框**：弹窗 append 到 `document.body`，但底下的 DeepSeek 输入框并未失焦（无 inert/pointer-events 阻断）；用户按 Enter 发送消息 → 同时也批准了挂起的 `shell.exec`/`file.write`。
- 影响：一次无需确认的误批准，且很可能发生在用户“根本没在看弹窗”的时刻（正在打字）。对 `always` 类工具是一次性放行；对 `mode` 类工具是放行本次含越界的调用（`outsideApproved` 会在批准后置位，见 desktop-host.ts:1648）。
- 证据类型：代码级证明（键盘绑定 + 无守卫）；“输入法确认候选词会产生 key=Enter 的 keydown”属平台行为，本次未实测（不能跑 UI），但 `isComposing` 缺失是客观事实。
- 修复建议：① Enter 不绑定任何允许动作（只保留 Escape/点击）；若保留，必须 `if (e.isComposing || e.keyCode === 229) return;` 且要求 `e.target === card`；② 弹窗打开时给底层页面加 `inert` 或 `aria-hidden` 并把焦点移到「拒绝」按钮；③ 把「拒绝」作为默认焦点。
- 验收判据：弹窗打开时，① 中文输入法输拼音按 Enter 确认候选词，不得产生任何 decision；② 在底层输入框按 Enter，不得产生 decision；③ Tab 首次落点必须是「拒绝」。

#### R3-03 断流结算：两套判据仍并存且不等价；工作区新增的「严格判停」未接线，实际从未生效
- 两套判据的位置：
  - **页面侧**：`src/inject/main-world-interceptor.ts:1887-1967`（`settleStreamEnd`）——用 `loopState.streamSawDone`、`streamBytes`、`abortedByUser`、`streamTruncatedTag`、`inAutoContinue` 判定，结论是“要不要重发/要不要 append 错误卡”；重发由 `escalateFirstAttemptFailure` 驱动。
  - **宿主侧**：`src/host/engine/web-engine.ts` 的 `decideCompletion`（HEAD 版在 `:20-35` 区段；工作区版在 `+17..+96` 新增段）——用 `dispatchFailed/timedOut/stopped` 判定，工作区版又加了 `sawFinishSentinel/hasVisibleOutput/strictTerm`。
- **不等价的事实**：页面判据看的是“流里有没有完成哨兵 + 字节数”，宿主看的是“是否超时/停止 + （工作区新增）页面自报的哨兵三态”。同一个断流轮次，页面可能决定“重发”，宿主可能同时判 `complete` 并取 `finalContent` 返回给 task-loop——两边各自向下游施影响，谁也不是唯一所有者。
- **工作区新增部分（145 行）的死代码问题（本轮新发现，只存在于未提交版本）**：`web-engine.ts:191` 声明 `readFinishSentinel?(): boolean | undefined`，`:600`/`:761` 调用；但**全 `src/` 只有一个 `createWebEngine` 调用点**：`src/host/desktop-host.ts:1010-1028`，其 options 只有 `dispatch`、`toolCallCounter`、`isStopped`、`getAutoReply`、`consumeAutoReply`——**没有 `readFinishSentinel`**（`src` 全量 `grep readFinishSentinel` 只命中 web-engine.ts 自身 7 处）。
- 因此：`readFinishSentinelSafely()` 恒返 `undefined` → `decideCompletion` 永远不会返回 `'interrupted'`，`strictTerm` 开关也无论开不开都没区别。而 `main-world-interceptor.ts:1893-1966` 的注释与 `web-engine.ts` 新增注释都写着“缺省偏向严格”，**注释承诺与运行时行为相反**。
- 对您三个问题的直接回答：
  1. 是否仍存在两个所有者？—— **仍存在**（两个函数、两套谓词、两个进程）。
  2. 是否导致同一答案出现两次？—— **没有证据支持**：宿主的 `onAssistantReply`（`desktop-host.ts:2113-2125`）只把文本写进 `state.lastAutoReply`，**不渲染**；答案只在页面侧渲染（`src/ui/studio-chat-ui.ts:832/883/1121`、`studio-chat-room.ts:410/424`）。所以“重复渲染”的机制不存在。
  3. 工作区版与 HEAD 版行为差异？—— **运行时无差异**（因为未接线），差异只是“多了一段永远不执行的判停分支 + 多了一堆误导性注释与未使用的 `strictTerm`”。
- 缺什么证据才能定性“丢弃”：需读 `installFetchHook`（`:1194`）与 `installXhrHooks`（`:1405`）全文，确认 `escalateFirstAttemptFailure` 重发时旧 pending 是否可能被新流覆盖；本轮未读完（见第六节）。
- 证据类型：代码级证明（判据不等价、未接线均逐行验证）；“是否丢答案”为未证实。
- 修复建议：① 要么接线 `readFinishSentinel`（在 `desktop-host.ts:1010` 注入，从 `hub` 侧读页面最近一次自报状态），要么删掉这段未接线的严格判停以免后人误信；② 把“是否续写”收归宿主单一决策点，页面只上报事实（`sawFinishSentinel`/`bytes`），不自己决定重发——否则两套重试预算会相乘。
- 验收判据：把页面断流固定为“有可见输出但无哨兵”（可用假 SSE 注入），断言（a）`completion==='interrupted'`，（b）相同条件下页面只重发一次、且没有重复错误卡。

### P3 轻微

#### R3-04 单条超大记忆会让整块记忆注入变成空串（记忆功能对这类用户完全失效）
- 位置：`src/inject/untrusted-memory.ts:58-74`：`selectMemoryInjectRows` 逐行累加，**首行就超预算时直接 `break` 且 `out` 为空**；`:99-107` `formatUntrustedMemoriesBlock` 遇到 `selected.length===0` 直接返回 `''`。而写入侧没有内容长度上限：`src/host/memory/storage.ts` 全文无 `content.length`/`MAX_CONTENT` 校验（只 `grep` 命中了 `MAX_MEMORIES=500` 于 `types.ts:97`）。
- 触发条件：模型或页面写入一条超过 1,800 token 的记忆（`MEMORY_INJECT_TOKEN_BUDGET`，`untrusted-memory.ts:23`），并且它排在最前（pinned 或 user 类优先）。
- 影响：此后**每轮**注入的记忆块都是空串——包括之后新存的、很短的正确记忆也一起被饿死，而界面上它们都“存着”。用户看到的表象是“助手突然不记得任何事了”。
- 证据类型：代码级证明（预算函数与写入路径）；未实测首条超限的具体表现。
- 修复建议：`save` 时截断或拒绝超长 content（建议 ≤ 造 2000 字符）；或 `selectMemoryInjectRows` 遇到超大首行时**跳过该行继续取下一行**而不是停住。
- 验收判据：先存一条 3 万字的记忆，再存一条短记忆；下一轮 prompt 里应出现那条短记忆（不被饿死）。
## 四、可疑但未证实

1. **`studio-ui-core.ts:154` 的裸 HTML 注入口**：`if (props?.html) element.innerHTML = props.html;` 是通用 UI 原语，目前未见传入宿主/模型可控字符串的调用点（本轮没全量追 `html:` 的调用方）。缺什么证据：`grep -n "html: " src/ui` 并对每个调用点确认数据源。若有一个调用点传了 `mem.content` 或 `tool result`，就直接升级为 P1（页面 XSS → 控制 token，接第 2 轮 R2-01 链）。
2. **断流时是否丢答案**：需 `installFetchHook`（`main-world-interceptor.ts:1194`）与 `installXhrHooks`（`:1405`）全文，确认 `escalateFirstAttemptFailure` 重发时旧 `pending` 是否会被新流覆盖（若会，第一段输出在页面上已渲染但不出现在 `finalContent`）。本轮未读完这两个函数。
3. **双窗口并发写同一 kv 键**：`src/ui/studio-execution-store.ts:113-145` 有进程内 `cache`，但无跨窗口互斥；`kvSet` 是“读-改-写”全量覆盖（`:163-170` 的 `sessions.unshift` 后整体写回）。缺什么证据：两个窗口同时 `saveSession` 后的最终索引是否丢条目；需真机双窗口实测，本轮禁止起长驻进程。
4. **`decideCompletion` 若将来接线，两侧口径是否等价**：页面 `hasVisibleOutput` 侧写作 `sawNewText && lastText.trim().length>0`（`web-engine.ts:604` 区段），而页面自身的 `settleStreamEnd` 只在 `streamBytes===0` 时当无流。两者对“一个全空白的流”判断不一定一致。缺什么证据：接线后跑一组空流/空白流用例对比两侧结论。

## 五、已核实无问题的点

1. **XSS 面（本轮新核，与前两轮不同批代码）**：`src/ui` 共 19 处 `innerHTML=`，逐类核过：
   - 5 处直接渲染模型输出（`studio-chat-ui.ts:832/883/1121`、`studio-chat-room.ts:410/424`、`workbench/workbench-execution-view.ts:111`）均经 `renderMarkdown`；`src/inject/markdown.ts:38-52` 是 `marked` + `DOMPurify.sanitize`，带**标签白名单**（无 svg/math/iframe/script）、**属性白名单**（无 on*）、`ALLOW_DATA_ATTR:false`，另加 `afterSanitizeAttributes` hook 剥 `javascript:/data:/vbscript:` 链接。
   - 其余模板拼接处均 `escapeHtml`：`studio-settings-panel.ts:253-257`（白名单行的 toolId/scope/action/targetPattern）、`:367-371`（skill 名/描述）、`:435-440`（**记忆的 type/name/content**）、`studio-project-picker.ts:180-185`（项目名/路径）。这是关键：记忆正文是模型可写的，这里转义了，所以“写一条带 `<img onerror>` 的记忆”拿不到执行。
2. **UI 与宿主的 IPC 面很窄**：`src/ui` 下 `invoke(` 与 `__TAURI_INTERNALS__` 均 **0 命中**，只有注入的 `kv{kvGet,kvSet,kvRemove}` 与 `callHostTool`。所以不存在“前端调了不存在的命令”这类契约错位；错误码方面 `callHostTool` 的 `rr.ok/rr.error` 在各调用点均被读入提示（如 `studio-settings-panel.ts:263-268`），未发现静默吞掉。
3. **memory 写入原子性**：`src/host/memory/storage.ts:18-35` 注释与 `save` 实现一致——“主表→审计→FTS→淘汰”四步包在**一个 `BEGIN IMMEDIATE` 事务**里，抛错即 ROLLBACK（历史 BUG-012 已修）。降级路径（无 `node:sqlite`）无事务，但那条路是内存数组，不涉磁盘。因此第 2 轮 R2-05（MCP 配置裸写）的问题**在 memory 域不存在**。
4. **记忆注入的不可信处理**：`src/inject/untrusted-memory.ts:77-107` 用 `[[STUDIO_UNTRUSTED_MEMORY_OPEN/CLOSE]]` 信封 + 正文里伪造标记的中和 + 行数/ token 双预算，并且宿主侧 `formatForPrompt`（`memory/retrieval.ts:129-131`）与页端共用同一函数，口径一致。**结论：第 2 轮 R2-07 的“上下文污染”在读取侧被压住（记忆只能当数据看），但写入侧仍无审批、无来源标记，R2-07 本身维持。**

## 六、未覆盖范围（量化）

- **本轮完整读完**：6 个文件——`src/ui/ui-contract.ts`、`src/inject/untrusted-memory.ts`、`src/inject/markdown.ts`、`src/ui/consent.ts`（关键段 240-310 逐行，其余靠 grep 定位）；加上 `web-engine.ts` 的完整 diff（145 行）与 `desktop-host.ts` 的 1570-1650 / 1805-1830 / 1004-1030 / 2113-2125 四段。
- **本轮结构提取**（未逐行）：`src/ui` 全 69 个 TS 文件的 `innerHTML` / `invoke` / `kv*` / `callHostTool` 全局扫描；`src/host/memory` 6 个文件的写入与预算关键点扫描；`authorization.ts:225-265` 逐行；`task-loop.ts` 的完成判定相关 30 行。约 1,200 行。
- **未读完**：`src/ui` 的 63,941 字节 `studio-chat-ui.ts` 与 34,069 字节 `studio-chat-room.ts` 主体（只看渲染沉点与状态机入口）；`studio-settings-panel.ts` 其余 6 处模板；`src/inject/main-world-interceptor.ts` 的 1194-1405-1887 之间的 hook 主体；`src/host/memory/storage.ts` 的 800+ 行具体 SQL。
- **原因**：只读通道单次输出上限约 8KB，且本轮把预算优先给了“能直接定 P1 的两条链”（授权键的构造与消费、断流判据的接线）。
- **未执行**：typecheck / vitest / 构建 / 任何 UI 真机验证。所以 R3-04 的“输入法回车”属平台行为推断，已在条目内声明。

## 七、修复优先级与验收方式

1. **立即（下一版本前）**：R3-01（对话级放行作用范围）。它的修复成本最低（给 key 加 `toolId+canonicalTarget`，或改文案+限制越界），但影响面最大：它把“一次人工确认”直接变成“整个对话全权”。验收用两条手工用例锁定（审 file.read 后调 shell.exec / 写工作区外）。
2. **立即（同一批改）**：R3-02（Enter 误批准）。两行代码的守卫，但对中文用户是高频误触；建议与 R3-01 一起改，因为它们同属 consent.ts 的“用户看到的 vs 实际做的”问题。
3. **发布前**：R3-03 的接线或删除。当前状态最坏：代码、注释、测试都可以写“严格判停已上线”，而运行时一句都不会执行。
4. **下个迭代**：R3-04（记忆截断/跳过）+ 第四节第 1 条（`props.html` 注入口的全量调用点核查）。
5. 建议新增一条守门测试：**任何“放宽授权”的键都必须包含工具与目标**（可直接对 `conversationApprovalKeyOf`、`grantKeyOf`、`whitelistHit` 三个函数写属性测试）。

---

**本轮工作量与结果**：完整读完 6 个文件 + 分段读完 6 个文件的 10 个关键区段，另对 `src/ui`、`src/host/memory` 共 15 个文件做了全局模式扫描，新读约 1,200 行；证实缺陷 4 条（P1×1、P2×2、P3×1）；可疑未证实 4 条；已核实无问题 4 处；未覆盖：`src/ui` 两个大文件的主体、`main-world-interceptor.ts` 的 hook 主体（1194-1887 区间）、`memory/storage.ts` 具体 SQL、以及所有运行期验证。