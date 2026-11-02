---
title: deepseek-studio 只读代码审计总报告（TD · 四轮合并 · 2026-11-02）
summary: 四轮只读审计的收尾总报告，基线 HEAD 12cfd55，工作区 6 个已修改文件（web-engine 另有 145 行未提交新增）。合并去重后共 34 条已证实缺陷：P1×8、P2×18、P3×8，每条标注首次出现轮次；复核历史 35 条（已修 10、已消解 1、仍存在 17、部分 1、无法判定 6）；定性断流双所有者（仍存在、不等价、工作区新判据未接线）与 props.html 原语（无任何调用方）；另列 7 条可疑未证实、未覆盖范围与按风险乘成本的修复顺序。
---

# deepseek-studio 代码审计总报告（TD · 四轮合并）

审计性质：**只读**。四轮均未改源码、未 commit/checkout/stash、未装依赖、未跑 typecheck/vitest/tauri dev、未启动长驻进程。

## 一、审计基线与方法

| 轮次 | HEAD | 工作区 | 取证时刻 | 产出 |
|---|---|---|---|---|
| 第 1 轮 | `630b076` | 2 M + 4 ?? | 2026-11-02 11:20–11:59 | 14 条 |
| 第 2 轮 | `12cfd55` | 6 M + 3 ?? | 12:40–13:05 | 10 条 |
| 第 3 轮 | `12cfd55` | 6 M + 3 ?? | 12:48–13:20 | 4 条 |
| 第 4 轮（本报告） | `12cfd55` | 6 M + 3 ?? | 13:20–14:05 | 复核 + 6 条新确认 |

`git log 630b076..12cfd55` 仅 1 个提交（纯 docs），`diff --stat` 只动 4 个 docs 文件 → **第 1 轮针对 src/ 与 src-tauri/ 的 file:line 在 12cfd55 上仍成立**，本轮已重验。

有未提交内容改动的文件：`model-engine.ts`(34) / `web-engine.ts`(145 增 6 删) / `task-loop.ts`(40) / `task-loop-reply.test.ts`(25)；`memory/candidates.ts`、`memory/core.ts` 仅行尾差异。**除 web-engine.ts 外，本报告所有 file:line 以 HEAD 为准且工作区无改动**；R3-03 涉及工作区版，已单独标注。

## 二、缺陷总览

共 **34 条**已证实缺陷：**P1×8、P2×18、P3×8**（P0 无）。首次出现：历史归档 8 条、第 1 轮 14 条、第 2 轮 6 条、第 3 轮 4 条，剩余 2 条为历史条目的本轮新确认。

**最该先修的 6 条**：TD-01（search_files 全绕过）、R3-01（对话级放行范围虚报）、R2-01（同意自答）、TD-02（令牌注入外部页）、R2-02（mcp.get 凭据）、BUG-037（SSE 传输不可用）。

**同根因可一次改完**：子进程生命周期无 finally（R2-04 / BUG-036 / BUG-027）；落盘无 tmp+rename（R2-05 / R3-04 写入侧）；路径不过 resolveWithin（TD-08 / R2-06 / R2-08）；risk 与 approvalClass 误标（R2-06 / R2-07）。
## 三、缺陷清单（合并去重，按级别）

### P1（8 条）

**TD-01（首见第 1 轮）`search_files` 完全绕过策略与授权链**
- `tool-definitions.ts:140-146`（无 `approvalClass`）→ `desktop-host.ts:471` → `policy.ts:100` → `authorization.ts:311-313` → `capabilities/search-files.ts:82-87`。
- 触发：任意调用方发 `search_files {pattern, path}`。影响：不经验审、不受工作区约束地递归搜索磁盘。证据：代码级。修：注册 `approvalClass:'mode'` + 接 `resolveWithin`。验收：工作区外路径返 `outside-workspace`。

**R3-01（首见第 3 轮）对话级放行实际作用范围远大于 UI 承诺**
- `ui/consent.ts:252-257` → `desktop-host.ts:1634`、`:1578-1586`（key 无 toolId/target）、`:1813-1826` → `authorization.ts:245-255`（`allow` + `outsideApproved=outsideRequested`）。
- 触发：对任意一次 `file.read` 点「本次对话始终允许」。影响：同对话内 `shell.exec`/`file.write`（含工作区外）/`policy.set`/`mcp.save` 全部静默放行。证据：代码级。修：key 加入 toolId+canonicalTarget，或删除越界隐含授权。验收：审 `file.read` 后 `shell.exec` 仍弹窗。

**R2-01（首见第 2 轮）同意闸门由被约束方自答**
- `main.rs:1021-1028`（token 进 `window.__studioHostToken`）→ `entry.ts:140-143`（拼进 WS URL）→ `page-runtime.ts:204`、`:212-214`、`:305-313`、`:47-53` → `:618-634` 发 `consent-required`，`:472-479` 收 `consent-decision`（同一连接）。
- 触发：页面内任意可执行 JS。影响：不需 UI、不需人点，即可执行 `shell.exec`；选 always 会落 conversationApproved。证据：代码级。修：decision 必须走 out-of-band 信使 / token 不下发页面 / 加会话 nonce 绑定。验收：页面自建 WS 发 tool-call 后无法自答 consent。

**TD-02（首见第 1 轮）host token 注入外部页面且无导航守卫**
- `main.rs:1007`、`:1021-1028`；`on_navigation` 全仓 0 命中。触发：页面跳转/子帧加载。影响：令牌落入第三方 origin。证据：代码级。修：加 `on_navigation` 白名单 + 令牌只给受信 origin。验收：导航到非白名单域后注入不生效。

**R2-02（首见第 2 轮）`mcp.get` 无审批返回 env/headers**
- `tool-definitions.ts:206-212`（`none`/`read`）→ `desktop-host.ts:610-618`（原样返回 config）→ `mcp-controller.ts:25`/`:33`（`env`/`headers`）。触发：知道 serverId 即可。影响：本机全部 MCP 凭据外泄。证据：代码级。修：返回值掩码 + `approvalClass:'always'`。验收：`env` 值全为 `****`。

**TD-03（首见第 1 轮）argv 绕过命令硬拒绝**
- `consent-router.ts:85-100` 只检查 command 字符串 vs `shell.ts:199-203` 执行实际 argv。触发：`command:"node", args:["-e","<任意>"]`。影响：硬拒名单失效。证据：代码级。修：基于 argv[0] 与展开后参数判定。验收：`node -e` 被硬拒。

**TD-04（首见第 1 轮）安装版无法启动宿主**
- `main.rs:974-983` + `sidecar.rs:291-299` 依赖 `tsx`（`devDependencies`）。触发：安装包（非 dev）启动。影响：产品不可用。证据：代码级（依赖清单）。修：打包期 bundle 宿主或把 tsx 转为运行时依赖。验收：安装包冷启能看到宿主健康。

**BUG-037（历史归档；本轮确认仍存在）MCP 的 SSE 传输不可用**
- `mcp-controller.ts:484-491`：SSE 分支 `await res.text()` 等整个响应流关闭。SSE 是长连接不主动关 → 必然拖到 30s 超时。证据：代码级。修：按行增量解析 `res.body` 的 `ReadableStream`。验收：接一个真 SSE MCP 服务器能在 2s 内拿到 tools/list。
### P2（18 条）

| 编号 | 首见 | file:line | 问题与影响 | 修法 / 验收 |
|---|---|---|---|---|
| TD-05 | R1 | `sidecar.rs:451-463` | 健康探测只看 HTTP，不 try_wait 进程；进程死后仍能短期报健康 | 兼查进程；杀死宿主 ≤1s 报 unhealthy |
| TD-06 | R1 | `config-loader.ts:112` vs `sidecar.rs:21/165/525` | 端口可配但硬编码 8760；改配置后探测与注入全失效 | 统一读配置；配 8790 全生效 |
| TD-07 | R1 | `config-loader.ts:112` → `server.ts:753` | 端口无范围/类型校验，非法值直接 bind 失败 | 校验 1024–65535；非法即报错回退 |
| TD-08 | R1 | `workspace.ts:173-188` | 不存在的目标只做词法 resolveWithin，不查存在性 | 加 lstat；不存在目标被拒 |
| TD-09 | R1 | `sidecar.rs:309-336` | 每次重启新建日志文件，旧日志无上限 | 单文件滚动；重启 10 次仍一个活跃文件 |
| TD-10 | R1 | `server.ts:432-451` | /v1/tools/execute 的 params 零校验（与 BUG-023 同条） | 按 schema 校验；非对象 params 返 400 |
| TD-11 | R1 | `tool-definitions.ts` / `desktop-host.ts:460-490` | M5 的 edit / test.run / debug 未注册，模型发出即 unknown | 注册或从提示词移除；不再出现 unknown-capability |
| R2-03 | R2 | `main.rs:921-940` | CDP 默认常开（回环、无鉴权、无 remote-allow-origins）；本机任意进程可接管 WebView 读 token | release 默认关；安装包 netstat 无 9222 |
| R2-04 | R2 | `mcp-controller.ts:739-772` | testConnection 无 finally，超时/异常路径不 kill，子进程泄漏 | 包 finally 统一 kill；假服务器不留进程 |
| BUG-036 | 历史 | `mcp-controller.ts:290-292` | connect 的 catch 只 delete 连接、不 kill；initialize 超时同路径 | 同上，一处 finally 同时收口 R2-04/036/027 |
| BUG-027 | 历史 | `mcp-controller.ts:278` | 只复用 initialized===true 的连接，并发 connect 会 spawn 两份 | 加 connecting 去重；并发 2 次只 spawn 1 个 |
| R2-05 | R2 | `mcp-controller.ts:147/161/840` | MCP 配置裸 writeFileSync，无 tmp+rename；写坏即服务器全消失 | tmp+fsync+rename；写入中 kill 仍可 parse |
| BUG-024 | 历史 | `server.ts:772-806` | readBody 超限/超时只 reject，不 destroy/drain；慢速上传白占 30s | reject 前 req.destroy()；超限即关连接 |
| R2-06 | R2 | `tool-definitions.ts:382-392` / `desktop-host.ts:913-940` | project.create 声明 read/none 却 mkdir+写文件，path 不过 resolveWithin | 改 always+校验；中文名不撞 id，非目录被拒 |
| R2-07 | R2 | `tool-definitions.ts:170-178` / `desktop-host.ts:533-540` | memory.save 无审批持久写入；迭加 R2-01 即持续上下文污染 | 改 mode 档+source 标记；首调弹窗 |
| R2-08 | R2 | `main-world-interceptor.ts:2739-2745` | 硬编码 C:/Users/lidicn/... 临时路径，换用户后代码块运行必失败 | 宿主提供 temp dir；非 lidicn 可运行 |
| R3-02 | R3 | `ui/consent.ts:281-294` | Enter 绑成允许一次，keydown 挂 document、无 isComposing/focus trap；中文 IME 回车即批准 | 加 isComposing 守卫，Enter 改绑拒绝 |
| R3-03 | R3 | `web-engine.ts:191/600/761` vs `desktop-host.ts:1010-1028` | M1-C 严格判停未接线（工作区版）：readFinishSentinel 无注入方 → 永不判 interrupted | 接线或标注未启用；断流真机得到 interrupted |
### P3（8 条）

| 编号 | 首见 | file:line | 问题 | 修法 / 验收 |
|---|---|---|---|---|
| TD-12 | R1 | `server.ts:190-211`、`:611` | 限流桶只增不删，无 TTL/上限（=BUG-021） | 加 LRU/TTL；内存不随伪造 token 增长 |
| TD-13 | R1 | `server.ts:397-399` | audit ?limit= 空串被 clamp 到 1（应为默认 50，=BUG-025） | 空串走默认；?limit= 返 50 条 |
| TD-14 | R1 | `agent-lan-access.ts:74` | 配对码非常量时间比较 | 改 timingSafeEqual |
| R2-09 | R2 | `capabilities/shell.ts:100-105` | 输出上限按 UTF-16 码元计（名义 64KB，CJK 下可达 ~192KB），切分可断代理对 | 按字节计；12 万汉字返回 ≤ 约 64K 字节 |
| R2-10 | R2 | `api/main.ts:35-42` / `sidecar.rs:195-217` | 孤儿防护对 PID 复用盲；补偿用通配命令行杀，可能误杀同构项目 | 用启动时间+可执行文件校验，杀进程限定目录 |
| R3-04 | R3 | `untrusted-memory.ts:58-74` + `memory/storage.ts` | 首条记忆超 token 预算就 break，整块注入变空串；写入侧无 content 长度上限 | 超预算改截断；单条内容上限 |
| BUG-034 | 历史 | `mcp-controller.ts:537-554` | getAllTools 串行 await，N 台最坏 N×10s | 并发 + 总超时 |
| BUG-039 | 历史 | `mcp-controller.ts:803-811` | testHttpConnection 的 tools/list 不查 res.ok 直接 json() | 先判 res.ok |

## 四、可疑未证实（合并；每条写明缺什么）

1. **重发会不会导致工具重复执行**：已证实 `beginStream/settleStreamEnd` 有 stale 守卫（`main-world-interceptor.ts:571-588`、`:1936-1937`），重发时主动清空 pending（`:2420`、`:2449`、`:2482`）——**旧 pending 不会覆盖新流**。但逐字节重发（`inFirstAttemptResend`）意味着上一轮已执行工具的**结果被丢弃且副作用已发生**，模型可能再发一次同样的工具调用。缺：接第 1 轮的“工具调用去重”是否存在（需读 `forward`/`invokeTool` 链上的 call 指纹逻辑），以及真机断流复现。
2. **`streamId === undefined` 分支**：`settleStreamEnd` 只在 `streamId !== undefined` 时跑 stale 守卫（`:1936`），而两个 hook 都在请求开始时 `beginStream`（`:1286`、`:1566`），所以实践中恒有值；本轮未找到不传的调用点 → **降为“未见可触发路径”**，不列为缺陷。
3. **令牌是否落日志**：`entry.ts:141-143` 拼 `?token=`；未在 page-runtime 找到写 upgrade URL 整串的代码，也未在日志样品中看到。缺：实测启动后查 `logs/*.log` 是否出现 `token=`。
4. **CDP 端口竞争窗口**：`main.rs:923` 探活后立即释放，再到 WebView2 绑定之间有窗口。缺：在 9222 上放插子服务再启动观察。
5. **记忆写入→注入的实际链路**：`memory.save` 写库已证；读取侧有信封+预算（第五节）。缺：`store.save` 的行是否一定被下轮 `formatForPrompt` 选中（受 40 行/1800 token 预算筛选）。
6. **双窗口 kv 并发**：`studio-execution-store.ts:113-145` 有进程内 cache 与旧键迁移，无跨窗口互斥。缺：开两个窗口同时写同一 session（需真机）。
7. **重复提交**：`setBusy` 只改状态点（`studio-chat-ui.ts:927-929`），不禁用输入/发送键。缺：`task-loop` 是否有单飞锁（本轮未读完 `task-loop.ts` 全文）——若没有，连点两次发送会并发两轮。
## 五、历史 35 条复核

**复核 35 条：已修复 10、已消解 1（018）、仍存在 17（含 015/016 性能类）、部分修复 1（033）、无法判定 6（006/010/013/014/019/020）。** 前两轮已复核的 9 条（结论沿用，本轮未重做）：BUG-004/005/008/009 已修、BUG-007/025 仍在、BUG-021/022 部分降级、BUG-006 未闭环。

### 已修复（10）

| # | 依据 |
|---|---|
| 001 / 002 / 003（码元 vs 码点截断） | `shared/studio-execution.ts:219-283` 已改为字节语义 `truncateUtf8ByBytes`，含 UTF-8 尾字节对齐与代理对处理；`:298-321` 的判定也从 `serialized.length` 改为 `byteLength` |
| 004 / 005（配置被覆盖、白名单字段丢） | 第 1 轮已验（`api/main.ts` 读-改-写 + 损坏时备份） |
| 008 / 009（shell 参数引用与 cmd 元字符） | 第 1 轮已验 |
| 011（FTS 命中就跳 LIKE） | `memory/retrieval.ts:31-42`：已改为并集去重，上限 limit*8 |
| 012（save 四步无事务） | `memory/storage.ts:18-35` 注释与实现：`BEGIN IMMEDIATE` 事务包裹主表→审计→FTS→淘汰 |
| 017（密钥损坏时覆盖旧钥） | `audit-crypto.ts:66-92`：先 `renameSync` 备份，备份失败则**拒绝覆写** |

### 部分修复 / 无法判定 / 已消解（8 行 / 10 条）

| # | 状态 |
|---|---|
| 033（parseMcpServers 不校验形状） | 大部分已修：`mcp-controller.ts:100-107` 现在要求 `command` 或 `url` 为 string；残留：`env`/`headers` 值类型仍未校验 |
| 006（=第 1 轮遗留，未闭环） | 仍存在，维持原结论（见第 1 轮报告） |
| 010（registerWorkspace） | 无法判定：`memory-store.ts:102-212` 仍在该路径，缺“注册失败是否静默”的完整分支阅读 |
| 013（先 DELETE 再 recordLog） | 无法判定：`memory/storage.ts:357-358`、`:453-454` 仍为 FTS→主表顺序删除；缺：`remove()` 是否包在同一事务内的完整阅读 |
| 014（循环依赖） | 无法判定（结构类，需跑构建依赖图才能定性；本轮不跑构建） |
| 015 / 016（prepareEviction 全表扫 / 时钟依赖） | 仍存在（性能类）：`storage.ts:494-500` 仍先取全量 valid 行再 `pickEviction`，未见 SQL 侧 LIMIT |
| 018（rollback 逐条 AES 解密） | 已不适用：审计记录已改内存环形缓冲（`audit.ts:181-188`），未见逐条解密路径 |
| 019 / 020（candidates 原子性 / 无上限） | 无法判定：`memory/candidates.ts:79-91` promote 经 `ctx.recordLog`；缺：candidates 表写入是否在同一事务 |
### 仍存在（17）

| # | file:line | 当前状态 |
|---|---|---|
| 007 | `policy.ts` / 工具表 | 第 1 轮已确认仍在（与 TD-05 同域） |
| 015 | `memory/storage.ts:494-500` | 仍先取全量 valid 行再 pickEviction（性能类） |
| 016 | `memory/core.ts:115` `pickEviction` | 仍依赖 `Date.now`，无注入时钟（性能/可测性） |
| 021 | `server.ts:190-211` | 限流桶无回收（=TD-12） |
| 022 | `server.ts:190-211` | 限流键取 Bearer 原文（与 021 同处） |
| 023 | `server.ts:432-451` | params 零校验（=TD-10） |
| 024 | `server.ts:772-806` | readBody 不 destroy/drain（本轮新确认，见 P2 表） |
| 025 | `server.ts:397-399` | limit 空串 clamp（=TD-13） |
| 026 | `server.ts:153-158` | `LOCAL_HOSTS.has(u.hostname) || u.hostname === "127.0.0.1"` 冗余死代码仍在（P3 无实际影响，未入缺陷清单） |
| 027 | `mcp-controller.ts:278` | 无连接中去重（见 P2 表） |
| 031 | `mcp-controller.ts:739-772` | testConnection 无 finally（=R2-04） |
| 032 | `mcp-controller.ts:147/161/840` | 配置非原子写（=R2-05） |
| 034 | `mcp-controller.ts:537-554` | getAllTools 串行（P3 表） |
| 036 | `mcp-controller.ts:290-292` | connect 失败不 kill（P2 表；本轮新确认仍未修） |
| 037 | `mcp-controller.ts:484-491` | SSE `await res.text()` 仍在（P1 表；历史 P1 仍未修） |
| 038 | `mcp-controller.ts:739-765` | 两个 5000ms 超时无 clearTimeout（随 R2-04 一并修） |
| 039 | `mcp-controller.ts:803-811` | testHttp 不查 res.ok（P3 表） |


## 六、覆盖范围与未覆盖部分

**四轮累计覆盖**：读源码约 4,600 行（不计结构化检索命中的行）；完整读完 12 个文件，分段读完 25 个。

- 已覆盖：`src-tauri/src/{main,sidecar}.rs`（关键段）、`src/api/{server,auth,agent-lan-access,config-loader,main}.ts`、`src/host/{policy,authorization,consent-router,workspace,tool-registry,tool-definitions,desktop-host,page-runtime,audit,audit-crypto,memory-store,mcp-controller,engine/web-engine}.ts`、`src/capabilities/{shell,file,edit-engine,search-files}.ts`、`src/ui/*`（全量模式扫描 + 关键渲染/审批/存储路径）、`src/inject/{origin-guard,bridge-install,direct-*,loader,lifecycle,untrusted-memory,markdown,skill-popup,tool-card-ui*,settleStreamEnd,installFetchHook}`。
- **未覆盖**（及原因）：① `main-world-interceptor.ts` 仍是选择性阅读（159KB，本轮补了 :1194-1268 与 hook 所有权链，但工具解析/注入提示词主体未逐行读）；② `src/ui/studio-chat-ui.ts`（64KB）与 `studio-chat-room.ts`（34KB）只做了状态机关键词与关键函数阅读，未逐行读渲染分支；③ `bot` 域、`src/host/kernel/task-loop.ts` 全文、`model-engine.ts`（后两者为未提交改动文件，本轮不纳入取证）；④ 所有运行期验证（typecheck / vitest / 构建 / tauri dev）均未执行，原因：内存约束与任务纪律。

## 七、修复优先级与验收方式

**第一梯队（本周内，高风险×低成本）**
1. **R3-01 + R3-02**（同一文件、同一主题）：给对话级 grant key 加 toolId+canonicalTarget、去掉隐含越界，加上 `isComposing`/focus 守卫。约十几行。验收：审 file.read 后 shell.exec 仍弹窗；IME 回车不批准。
2. **R2-02**：`mcp.get` 掩码 + 改 `always`。约五行。
3. **TD-01**：`search_files` 接上 policy/authorization。半天。

**第二梯队（高风险×中成本）**
4. **R2-01 + TD-02**：同意决定改走 out-of-band、令牌不下发页面、加导航守卫。要改 Rust 侧与 page-runtime 的协议，但不动注入层结构。验收：页面自建 WS 无法自答同意。
5. **BUG-037**：SSE 改增量流解析。独立改动，不碰其它路径。
6. **TD-03 / TD-04**：argv 硬拒判定与打包依赖。发版前必须做（TD-04 直接决定安装版能不能用）。

**第三梯队（一致性与健壮性，建议一次改一类）**
7. MCP 子进程生命周期：R2-04 + BUG-036 + BUG-027 + BUG-038 一处在 `mcp-controller` 收口（finally + connecting 集）。
8. 落盘与路径：R2-05 + R3-04（tmp+rename、上限）、TD-08 + R2-06 + R2-08（路径校验与 temp dir）。
9. **R3-03**：接线 `readFinishSentinel` 或在注释/测试里标注“未启用”——当前注释声称“缺省严格”，与实际相反，属误导性文档。

**第四梯队**：R2-03（CDP 默认关）、R2-10、R2-09、TD-12、TD-13、BUG-034、BUG-039。

---

**本轮工作量与结果**：新读约 1,300 行（含 `installFetchHook` 解析段、`settleStreamEnd`/`beginStream` 所有权链、`mcp-controller` 六处判断点、`server.ts` readBody/isLocalOrigin、`memory` 四条链路、`src/ui` 全量 `html:`/`innerHTML`/状态词扫描）；历史 35 条复核结果：已修复 10、已消解 1、仍存在 17、部分修复 1、无法判定 6；总报告合并后 34 条（P1×8、P2×18、P3×8）；可疑未证实 7 条。未覆盖：主拦截器主体、`studio-chat-ui`/`studio-chat-room` 渲染分支全文、`task-loop` 与 `model-engine`（未提交改动）、所有运行期验证。

> **基线变更提示（14:05 复核）**：取证结束时重新检查工作区，发现另一个会话在取证期间修改了 `src/inject/main-world-interceptor.ts`，并新增 `src/inject/catalog-selection.ts`、`tests/desktop/catalog-budget.test.ts`（HEAD 仍为 12cfd55）。因此本报告引用 `main-world-interceptor.ts:1194-1268`、`:1927-1937`、`:2739-2745` 的行号对应**修改前**的版本；其余文件的 file:line 不受影响。
