# QD-R22：真机 mcp tools load unknown-tool + 设置面板打不开 —— 陈旧构建诊断

> 席位：PM（Codex）。只读源码/历史取证 + 独立 worktree 验证，未改业务代码。
> 某基线：HEAD `4fb55da`（取证时）。主仓当前 HEAD 由 Trae 推进，不受影响。
> 触发：用户真机日志——
> ```
> [interceptor] loaded 9 skills for prompt injection (attempt 10)
> [interceptor] mcp tools load attempt 10 failed: ok=false error=unknown-tool tools=0
> [interceptor] mcp tools load failed after 10 attempts, agent will not see MCP tools in prompt
> ```
> 以及「studio 设置界面出问题了，出不来」。

## 1. 结论先说

都不是代码缺陷，是运行中的 app 没按当前 HEAD 重建。

- MCP 全失败：宿主进程停在 `1329088`（E1）之前 → `mapUpstreamToolInvocation('mcp.list')` 查不到点号键 → 回 `unknown-tool`。
- 设置面板打不开：页端 `entry.js` 旧于 R-1（`ccaf320` 修 style 对象形式）→ jsdom/proxy 崩溃。

HEAD 源码侧正确，`tests/desktop/ui-tool-wiring.test.ts` 在干净 worktree（`4fb55da`）4/4 通过。

## 2. 证据链（可复核）

### 2.1 unknown-tool 的产生点与数据流
- 页端 `main-world-interceptor.ts:2254` 发 `sender({ invocationName: 'mcp.list' })`（点号）。
- `skill.list`（`:2276`）同通道、同结构却成功（日志 `loaded 9 skills`）。
- 宿主 `page-runtime.ts:424` 收 `tool-call` → `mapUpstreamToolInvocation(msg.invocationName)`；查不到即 `:430` 回 `unknown-tool`。
- `mapUpstreamToolInvocation`（`tool-contract.ts:238-246`）= 查 `UPSTREAM_TO_STUDIO[name]`，无则 null。
- `UPSTREAM_TO_STUDIO`（`:199-203`）= `MODEL_INVOCATION_TOOLS` + `UI_ONLY_TOOLS` 合并。

### 2.2 只有 mcp.list 失败、skill.list 成功的根因（键名形态差异）
- `skill.list`：自 `b8fdc20` 就是点号键在表里 → 一直能映射。
- `mcp.list`：`9d093dc` 时表里只有下划线键 `mcp_list: { id:'mcp.list' }`（`git show 9d093dc:src/shared/tool-contract.ts` 实测点号键 0 处）；`1329088`（E1，2026-10-26 22:23）才补点号键 `'mcp.list': {...}`（实测点号键 1 处）。
- ⇒ 宿主构建落在 `9d093dc..1329088` 之间，就会：`skill.list` 点号键命中、`mcp.list` 点号键缺失 → 技能加载成功、MCP 全 unknown-tool。与真机日志逐字吻合。

### 2.3 为什么改了源码还不行——build:inject 不重建宿主
- `package.json`：`build:inject = node esbuild.inject.mjs`（只重建页端 entry.js）。
- 宿主：dev = `tsx src/api/main.ts`（读源码，重启即生效）；打包 = `tauri:build`（构建时把宿主打进产物）。
- `mapUpstreamToolInvocation` 跑在宿主（`page-runtime.ts`，由 `desktop-host` → `api/main.ts` 装配），不在 entry.js 里。
- ⇒ 只跑 `build:inject` 永远修不好宿主侧映射；必须重启/重建宿主。

## 3. 独立 worktree 验证（不碰主仓）

```
git worktree add E:\NAS\_wt_wiring 4fb55da --detach
# node_modules 用 junction 指向主仓，避免重装
npx vitest run tests/desktop/ui-tool-wiring.test.ts
 ✓ tests/desktop/ui-tool-wiring.test.ts (4 tests) 26ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

守卫（`ui-tool-wiring.test.ts`）已把「每个页端直调名必须能 `mapUpstreamToolInvocation` 映射、否则 unknown-tool」钉成断言（`:98-104`），并专锁 `mcp.list/shell.exec/file.read` 必被扫到（`:93-95`）。HEAD 绿 = 源码正确。

## 4. 给用户的可操作修复（非代码）

1. 重建页端：`npm run build:inject`（更新 entry.js，含 R-1/E1 页端部分）。
2. 重建/重启宿主（关键）：
   - dev：结束旧 `npm start` / `npm run tauri:dev` 进程 → 重开（tsx 读源码，自动含 E1）。
   - 打包版：`npm run tauri:build` 出包 → 用新包覆盖安装后启动。
3. 启动后看日志应出现 `loaded N MCP tools for prompt injection (attempt 1)`；设置面板可正常打开。

## 5. 残余风险 / 后续

- 若重建宿主 + 全新 entry.js 后仍报 unknown-tool，则不是陈旧构建，需按 `page-runtime.ts:424` 断点复查实际 `msg.invocationName`——此时另立卡。
- 「单靠 build:inject 会漏宿主」是部署流程陷阱，建议在发布/验收清单里显式区分「页端产物 vs 宿主产物」两条重建路径（登记为流程改进，不改代码）。

## 6. 附：真机记忆治理三缺陷（T1）同属陈旧构建，非活代码 bug

2026-10-26 真机验收（HEAD `af4989a`）报：同名再存清空 tags/pinned、`pinned:true` 首存落库仍 0、`confidence` 落库 NULL。经核对提交时序与现码：

- `af4989a`（真机验收时 HEAD）= **10-26 00:18**；D-5 修复（`f985766`「记忆工具边界不再把未传当成显式清空」）= **10-26 07:11**（晚 7h）+；E1（`1329088`）= 10-26 22:23。
- 现码 `src/host/memory-tool-params.ts` 的 `normalizeMemorySaveParams` = 「有则转、无则不传」，缺省字段不固化成 `[]/false`；`memory-store` 的 `mergeUpdateGovernance` 据此 `params.tags ?? existing.tags` 保留原值。
- `confidence` 无写入方，宿主按设计不落值 → NULL 属预期（`normalizeMemorySaveParams` 根本不转 confidence）。

⇒ **T1 的三条「缺陷」= 真机跑的 `af4989a`（D-5 前）的旧 bug，现码已修**。Trae 的 T1（`3013c5c`）只加测试、零生产码改动是**正确**的：它把现码已正确的语义（未传保留 / 显式覆盖 / confidence NULL 允许）锁成回归。与 mcp.list 完全同根：**运行中的 app 停在旧提交**。

**由此，真机遗留的全部异常（mcp unknown-tool、设置面板崩溃、pinned/tags 异常）指向同一动作：按当前 HEAD 重建页端 + 重启/重建宿主，再跑真机复验（T8 人工部分）。** 在旧构建上复测无意义。
