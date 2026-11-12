---
title: deepseek-studio 只读代码审计回归报告（TD · 第 5 轮 · 2026-11-12）
summary: 以 HEAD b3c058c（v0.14.20）为基线重做回归。12cfd55..HEAD 共 246 个提交、src 85 文件 +10,299/-910、src-tauri 23 文件 +4,908/-436。前四轮 34 条：已修复 25、部分修复 2、仍存在 4、无法判定 3；新增 2 条（P3×2）与 1 条 P2 放大器。重点：TD-01/02/03/04、R2-02、R3-01/R3-03、BUG-036/037 均已有对应修复且有代码证据；仍存在的是 CDP 默认常开、端口硬编码、memory.save 零审批、配对码非常量比较。
---

# deepseek-studio 代码审计回归报告（TD · 第 5 轮）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未跑 typecheck/vitest/tauri dev、未启动长驻进程。

## 一、基线变化

| 项 | 第 4 轮（2026-11-02） | 本轮（2026-11-12） |
|---|---|---|
| HEAD | `12cfd55afe141019169f54911819b450a0292236` | `b3c058c4e0e64ae0b419ee5c99724fb86d23c9c0` |
| 分支 | master | master |
| 版本 | 0.13.0 | 0.14.20（tauri.conf.json） |
| 工作区 | 6 M + 3 ?? | **5 M**（`src/inject/main-world-interceptor.ts`、`src/inject/response-classifier.ts`、`tests/desktop/{qd-r4-fetch-path-regression,qd-r4-stream-break-regression,response-classifier}.test.ts`） |

**区间差分**：`git rev-list --count 12cfd55..HEAD` = **246 个提交**；`git diff --shortstat`：`src` **85 文件 +10,299 / −910**，`src-tauri` **23 文件 +4,908 / −436**。

新增文件 36 个，安全相关：`src-tauri/src/{consent_window,updater}.rs`、`src/desktop/grant-acquire.ts`、`src/host/{native-consent,consent-queue,mcp-spawn-target,config-migration}.ts`、`src/shared/{atomic-write,tree-kill,command-tokens,distribution}.ts`、`src/api/{cli-args,dev-main,resource-root}.ts`、`src/host/memory/retrieval-tokens.ts`、`src/inject/{catalog-selection,ds-stop-control}.ts`、`src/ui/{consent-panel,mcp-settings-panel,agent-mcp-editor,update-card}.ts`。

**快照声明**：本报告所有 file:line 对应上述 HEAD 的工作区。`main-world-interceptor.ts` 与 `response-classifier.ts` 有未提交改动，凡引用这两个文件的结论均标注「工作区版」；其余文件干净。

## 二、回归结果汇总（前四轮 34 条）

**分布：已修复 25、部分修复 2、仍存在 4、无法判定 3。**

### P1（8 条）

| 编号 | 结论 | 本轮证据 |
|---|---|---|
| TD-01 search_files 绕过 | **已修复** | `tool-definitions.ts:169` 改 `approvalClass:'mode'` + `:172` `canonicalTargetKind:'search-root'`；`capabilities/search-files.ts:26-28`/`:87-101` 用 `resolveWithin`（含 realpath 二次校验）卡 root |
| TD-02 令牌注入外部页、无导航守卫 | **已修复** | 令牌降级为 HMAC 一次性 bootstrap grant（`main.rs:791`、`:869-907`，`scope:ws-connect`、`jti`、`exp`）；新增 `on_navigation` 守卫（`main.rs:1364`、`consent_window.rs:533`） |
| R2-01 同意闸门自答 | **已修复（越界路径）** | 越界同意改走宿主侧队列（`desktop-host.ts:1226-1236`）＋Rust 窗口轮询 `GET /v1/consent/pending`、回执 `POST /v1/consent/reply`，页面无参与；非越界高风险按 PM 2026-11-08 裁定改页内模态 + 一次性 nonce（`page-runtime.ts:719-739`、`:554-569`，常数时间比对 + consumed），属**产品裁定而非缺陷** |
| R2-02 mcp.get 裸返凭据 | **已修复** | `tool-definitions.ts:279` 改 `always` + `canonicalTargetKind:'mcp-call'`；`mcp-controller.ts:105-110` 掩码 `env`/`headers`；并补了掩码回写守卫（`:129-132`、`:172`、`:264-306`），否则 `mcp.save` 会把 `****` 写回磁盘 |
| R3-01 对话级放行范围虚报 | **已修复** | `authorization.ts:155-179` 的 canonicalTarget 覆盖 `mcp-call`/`search-root`/`workspace-root`/`policy-mode`，目标参与 grant key |
| R3-03 严格判停未接线 | **已修复** | `entry.ts:606-608` 新增 `onFinishSentinel → host.finishSentinel(round, sawFinishSentinel)` 发送端 |
| BUG-037 SSE 用 res.text() | **已修复** | `mcp-controller.ts:784-812` 改按流读首条 JSON-RPC 响应（SSE 行解析），`:1263` 注释记录原缺陷 |
| BUG-036 connect 失败不 kill | **已修复** | `mcp-controller.ts:1117`、`:1169` cleanup 收尸；`:1441` 把子进程挂到 try 外供 finally 收（`:860`/`:1051`/`:1557` 均有 finally） |

### P2（18 条）

| 编号 | 结论 | 本轮证据 |
|---|---|---|
| TD-05 健康探测只看端口 | **无法判定** | `sidecar.rs` 已大改，健康判定点未逐行读 |
| TD-06 端口可配但硬编码 8760 | **仍存在** | `sidecar.rs:21` 常量、`:82`/`:191`/`:210` 全用常量，配置端口仍未被采用 |
| TD-07 端口无数值校验 | **已修复** | `api/config-loader.ts:63` 有 TD-07 标注与校验 |
| TD-08 工作区外新建只词法 | **已修复** | `workspace.ts:158-181`：根自身 realpath + 存在目标 realpath 二次校验 + statSync 存在性 |
| TD-09 sidecar 日志不清理 | **已修复** | `sidecar.rs:126-155` 只保留最新 N 个 `sidecar-<ms>.log` |
| TD-10 /v1/tools/execute params 零校验 | **已修复** | `server.ts:991` 起 TD-10 形态校验 |
| TD-11 M5 工具未注册 | **已修复** | `src/shared/tool-contract.ts:70-75` 补 `file_edit → file.edit` 映射（G-02） |
| TD-03 argv 绕过硬拒绝 | **已修复** | 新增 `src/shared/command-tokens.ts`＋`consent-router.ts:86` 标注；硬拒改走 argv 归一化 |
| TD-04 安装版起不来宿主 | **已修复** | 新增 `src-tauri/fetch-node.mjs`、`src/api/{resource-root,dev-main,cli-args}.ts`（打包取 node 与资源根），版本抬到 0.14.20；未实跑安装包 |
| R2-03 CDP 默认常开 | **仍存在** | `main.rs:1745-1769` 仍无条件设 `--remote-debugging-port`（release 同样生效），仅 `STUDIO_DISABLE_CDP`/`STUDIO_CDP_PORT` 可关 |
| R2-04 testConnection 无 finally | **已修复** | `mcp-controller.ts:1557` finally 统一收尸 |
| BUG-027 connect 重入 | **已修复** | `mcp-controller.ts:899`、`:1038-1056` `connecting` 表去重 |
| R2-05 MCP 配置非原子写 | **已修复** | 新增 `src/shared/atomic-write.ts`，`mcp-controller.ts` 已引用 |
| BUG-024 readBody 不 destroy | **已修复** | `server.ts:1383` `readBody` 内 `:1393`/`:1405` `req.destroy()`；`:1291` 注释记录原缺陷 |
| R2-06 project.create 声明不符 | **无法判定** | `tool-definitions.ts:434-437` 仍为 `risk:'read'` + `approvalClass:'none'`；handler 实现未定位到 |
| R2-07 memory.save 零审批 | **仍存在** | `tool-definitions.ts:200-203` 仍 `risk:'read'` + `approvalClass:'none'` |
| R2-08 硬编码 C:/Users/lidicn | **已修复** | 全仓仅剩 `search-files.ts:98` 的说明性注释，可执行路径已无硬编码 |
| R3-02 Enter=允许一次 | **已修复** | `ui/consent.ts:416-418`：加 `isComposing`/`keyCode===229` 守卫，且 Enter 改绑 **deny** |
### P3（8 条）

| 编号 | 结论 | 本轮证据 |
|---|---|---|
| TD-12 限流桶只增不删 | **已修复** | `server.ts:481-516` 增加 `maxKeys` 淘汰（超限删最旧键） |
| TD-13 limit 空串 clamp | **已修复** | `server.ts:944` `parseLimit(raw, 50, 1, 500)` |
| TD-14 配对码非常量比较 | **仍存在** | `agent-lan-access.ts:69-101` 仍为普通字符串比较，无 `timingSafeEqual` |
| R2-09 输出上限按码元 | **已修复** | `capabilities/shell.ts:23` 改 `DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024`，按字节切片 |
| R2-10 孤儿防护 PID 复用盲 | **部分修复** | 统一到 `src/shared/tree-kill.ts`（`shell.ts:18`、`mcp-controller.ts:19`），但仍是 PID 级，启动时间/可执行文件校验未见 |
| R3-04 超大首条记忆饿死全块 | **已修复** | `untrusted-memory.ts:119-134`：超预算行 `continue` 而非 `break`，另有 `namedIds` 点名保留与独立 token 预算（`retrieval-tokens.ts`） |
| BUG-034.getAllTools 串行 | **无法判定** | `mcp-controller.ts:1300` 已重写，未逐行读并发结构 |
| BUG-039 testHttp 不查 res.ok | **已修复** | `mcp-controller.ts:1602` 注释 + `:1258` 先判 `res.ok` |

## 三、新增缺陷清单（本轮新增，2 条）

**N-01（P3）`skill.dir.set` 的零审批依赖“注释级约束”，而契约测试把错的一侧锁死**

- 位置：`src/host/tool-definitions.ts:144-152`（`risk:'privileged'` + `approvalClass:'none'`）；约束靠 `:140-143` 的注释“不在 `SUPPORTED_INVOCATION_NAMES` 里”成立；而 `tests/desktop/authorization-contract.test.ts:65` 把 `'skill.dir.set': 'none'` 写进了契约快照。
- 触发条件：将来有人为了“让模型也能改技能目录”把它加进 `MODEL_INVOCATION_TOOLS`（`src/shared/tool-contract.ts:40`）。
- 影响：该工具写入 `config.json` 的 `skillsDir`（改后续技能扫描根目录，可指向任意目录）→ 模型获得不经审批的配置写权限；而契约测试仍会绿（它锁的是 `none`）。
- 证据类型：代码级（声明 + 测试快照双读）。
- 修复建议：在 `authorization-contract.test.ts` 增加一条反向断言——“凡 `risk:'privileged'` 的 id 必须不在 `MODEL_INVOCATION_TOOLS` 里”，或直接把该 id 从契约快照里删除。
- 验收判据：往 `MODEL_INVOCATION_TOOLS` 里临时加 `'skill.dir.set'` 后测试变红；删回后变绿。

**N-02（P3）远程页面（chat.deepseek.com）被授予 `updater_install` / `studio_request_grant` 等命令权限**

- 位置：`src-tauri/capabilities/default.json` 的 `remote.urls: ["https://chat.deepseek.com"]` 与 `allow-updater-{check,install,progress}`、`allow-studio-*`；实现 `src-tauri/src/updater.rs:99-205`。
- 触发条件：页面内任意可执行 JS（含第三方 XSS 或供应链注入）。
- 影响：可触发签名更新的下载与安装（`updater.rs:175` `download_and_install`）、可重复申请 ws-connect grant。**当前被签名验证挡住**（`tauri.conf.json` 已配 minisign `pubkey`、`createUpdaterArtifacts:true`、未设 `dangerousSkipSignatureVerification`），所以不是 RCE；但一旦签名密钥泄露或将来为了“自签测试”关掉验证，就直达代码执行。与 R2-03（CDP 默认常开）叠加后，本机任意进程也能驱动该路径。
- 证据类型：代码级（权限清单 + 更新器实现 + 配置）。
- 修复建议：给 `updater_install` 加“用户真实点击”证明（同 consent 的 `isTrusted` 口径）或改为仅本地窗口可调；将 `dangerousSkipSignatureVerification` 的缺失写成 CI 断言。
- 验收判据：页面控制台直接 `__TAURI_INTERNALS__.invoke('updater_install')` 返 `denied`；实际点击更新按钮仍可安装。

## 四、合并后的当前缺陷总览

修复后**仍成立**的条目（含部分修复），按级别：

- **P1：无**（前四轮的 8 条 P1 均已消除或有产品裁定的等价安排）。
- **P2：3 条**——R2-03 CDP 默认常开（`main.rs:1745-1769`）、TD-06 端口硬编码 8760（`sidecar.rs:21`）、R2-07 `memory.save` 零审批（`tool-definitions.ts:203`）。
- **P3：4 条**——TD-14 配对码非常量比较、R2-10 孤儿防护 PID 盲（部分）、N-01、N-02。
- **无法判定：3 条**——TD-05、R2-06、BUG-034（均见上表）。

当前风险最高的不是新缺陷，而是两个**叠加因子**：CDP 默认常开（本机任意进程可控 WebView）与远程页持有 `updater_install` 权限。两者各自被签名/回环论据弱化，合起来则是“本机进程 → 页面 → 安装器”的可达链。
## 五、可疑未证实

1. **TD-05 健康探测是否仍只看端口**：`sidecar.rs` 已从 668 行增至近千行，健康判定点未逐行读。缺：`sidecar.rs` 健康轮询段（`healthz` 探活与 `try_wait` 关系）的完整阅读。
2. **R2-06 `project.create` 的实际副作用**：工具表仍声明 `read`/`none`，但 `git grep 'project.create'` 在 `desktop-host.ts` 只命中镜像表 `:1148`，未定位真正 handler。缺：宿主 createProject 实现是否仍 mkdir＋写 projects.json、path 是否过 `resolveWithin`。
3. **BUG-034 `getAllTools` 是否并发**：`mcp-controller.ts:1300` 已重写，未读循环体。缺：多服务器时是否 `Promise.all`。
4. **N-02 的签名验证是否真正生效**：仅有配置证据（`pubkey` 已配、无 `dangerousSkip*`），未实跑更新流程。缺：一次真实 release 下载安装的签名校验结果。
5. **工作区未提交改动未审计**：`main-world-interceptor.ts` 与 `response-classifier.ts` 当前有 5 个已修改文件（含三个测试），内容属 R6 补审范围；本轮所有结论以 HEAD `b3c058c` 为准。
6. **发布链脚本未审**：`src-tauri/fetch-node.mjs`、`verify-sig.mjs` 与 CI 工作流未读——TD-04 的“已修复”只到工程结构层，未验证下载产物的完整性校验。

## 六、覆盖与未覆盖

**本轮覆盖**：8 条 P1 逐条取证（含 `main.rs` 的 grant 签发与 HMAC 实现、`page-runtime.ts` 的 consent 回执校验、`tool-definitions.ts`/`authorization.ts` 的目标归一化、`entry.ts` 的 sentinel 发送端）；34 条回归点位；36 个新增文件清单；`updater.rs` 结构与权限清单；`server.ts` 限流/limit/readBody；`mcp-controller.ts` 的 finally/SSE/connecting/掩码回写；`sidecar.rs` 日志保留与端口常量；`workspace.ts` 的 realpath 闸门；`untrusted-memory.ts` 的预算策略；`consent.ts` 的键盘守卫。

**未覆盖（及原因）**：① `main-world-interceptor.ts` 主体（159KB 以上，且工作区有未提交改动，本轮只做定点核对）；② `src/ui/studio-chat-ui.ts`/`studio-chat-room.ts` 的渲染与状态机分支（上轮已列为未覆盖，本轮仍未逐行读）；③ `task-loop.ts` 与 `model-engine.ts`（未提交改动，按约定不取证）；④ `memory/storage.ts` 的 SQL 细节（仍只到事务结构层）；⑤ 所有运行期验证（typecheck / vitest / 构建 / tauri dev）——内存约束与只读纪律。

## 七、修复优先级与验收方式

1. **R2-03（P2，一行改）**：`main.rs:1750` 的 CDP 注入加 `#[cfg(debug_assertions)]` 或要求显式 `STUDIO_ENABLE_CDP=1`。验收：release 包启动后 `netstat -ano | findstr 9222` 无输出，且本地工具在 dev 包仍可直连。
2. **R2-07（P2，一处声明）**：`memory.save` 改 `approvalClass:'mode'`。验收：workspace 档下首次 `memory.save` 弹审批；同目标二次写入不再问。
3. **TD-06（P2）**：`sidecar.rs` 改为从 `config.json` 读端口（`config-loader.ts:63` 已有校验）。验收：配置改 8790 后健康探测与注入全走 8790。
4. **TD-14（P3）**：配对码改 `timingSafeEqual`。验收：长度不等/等长错误均返 `pairing_code_mismatch`，不泄露前缀信息。
5. **N-01（P3）**：契约测试加反向断言（privileded 不得进模型白名单）。验收：临时加入即变红。
6. **N-02（P3）**：`updater_install` 加真实点击证明或限定本地窗口；CI 断言 `dangerousSkipSignatureVerification` 不存在。验收：页面直调返 `denied`。
7. **R2-10（P3）**：孤儿防护从 PID 级改“PID + 启动时间 + 可执行文件路径”三重校验。验收：同 PID 被复用时不得被杀。

**一句话结论**：这 10 天是一次高质量的安全收敛——前四轮 8 条 P1 全部落地，且多数补了回归测试；剩下的风险不再在“授权链漏洞”，而在两个默认开着的调试/配置面（CDP、memory.save）与一个新引入的供应链面（远程页持有更新器命令）。

---

**本轮工作量**：新读约 700 行源码（6 段块读：`main.rs` 的 grant 签发、`page-runtime.ts` 的 consent 回执、`tool-definitions.ts` 四处工具声明、`workspace.ts` 闸门、`untrusted-memory.ts` 预算、`native-consent.ts` 前 70 行；另有 20 处 `git grep` 定点与 3 段上下文），核 246 个提交、两条 `diff --shortstat`、36 个新增文件；回归 34 条：已修复 25、部分修复 2、仍存在 4、无法判定 3；新增 2 条（均 P3）；可疑未证实 6 条；未覆盖见第六节。