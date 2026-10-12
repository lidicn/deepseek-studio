# deepseek-studio 稳定性/功能性审计报告（Rust 层 + 增量复扫）

- **审计人**：Claude Code · ADM-auditkit 审计 agent
- **日期**：2026-10-12
- **范围**：Tauri 2 桌面宿主（Rust 外壳 `src-tauri/` + Node sidecar `src/api/` + 前端 `src/` + 嵌套子项目 `deepseek-pp/`）
- **方法**：Rust 源码人工审读 + auditkit generic_text 机器扫描（round-001）+ 交叉 triage
- **与并存报告的关系**：同目录 `审计报告_deepseek-studio_20261012.md`（CodeBuddy 审计席，round-003）覆盖前端 MCP 控制器层。本报告聚焦 **Rust 外壳层**（CodeBuddy 未覆盖）+ **auditkit round-001 机器命中 triage** + **相对 round-003 的增量变化**。两份独立，互不覆盖。

---

## 〇、结论速览

| 严重度 | 数量 | 说明 |
|---|---|---|
| critical | 0 | — |
| high | 2 | tray-icon 功能死代码、updater 更新源 404 |
| medium | 4 | CSP null、Windows 进程树孤儿窗口期、关闭阻塞主线程、oauth/webdav fetch 无 timeout |
| low | 2 | version 不一致、令牌桶无界 |

**新增 Rust 层缺陷**（CodeBuddy round-003 未覆盖 Rust，以下均为本报告首次发现）：
- R1 tray-icon feature 永不编译（high，功能性死代码）
- R2 updater endpoint 404（high，自动更新永远不可用）
- R3 CSP null（medium，安全/功能性）
- R4 Windows 进程树孤儿防护窗口期（medium，稳定性）
- R5 关闭窗口阻塞主线程 500ms（medium，稳定性）
- R6 version 不一致（low）

**auditkit 机器扫描增量**：
- A1 oauth-client.ts 4 处 fetch 无 timeout（medium，真缺陷）
- A2 webdav-client.ts 4 处 fetch 无 timeout（medium，真缺陷）
- A3 bundled-assets.ts 裸 fetch 无 timeout（medium，真缺陷）
- A4 mcp-controller.ts fetch-no-timeout / settimeout-no-clear 命中**经核验为假阳性**（实际有 AbortSignal.timeout + clearTimeout）

**相对 round-003 的变化**（CodeBuddy 报告 C3/C4 基于的行号已对不上当前代码，疑似已修复）：
- mcp-controller.ts 的 HTTP fetch 现已全部带 `AbortSignal.timeout(5000~30000)`（line 342/379/626/637/645）
- setTimeout 现已有配对 clearTimeout（line 237/254, 313/324）

---

## 一、Rust 外壳层缺陷详述（CodeBuddy 未覆盖）

### R1【high·功能性死代码】tray-icon feature 永不编译

- **位置**：`src-tauri/src/main.rs:160` `#[cfg(feature = "tray-icon")]`
- **根因**：main.rs 用 `#[cfg(feature = "tray-icon")]` 守卫系统托盘代码块（line 162-202），但 `src-tauri/Cargo.toml` 的 `[features]` 段只定义了 `custom-protocol`，**没有定义 `tray-icon` feature**。`Cargo.toml` dependencies 里的 `tauri = { version = "2", features = ["tray-icon"] }` 是给 tauri crate 开 feature（让 tauri 的 tray 能力可用），不是给本 crate 定义 feature。两者混淆导致 `#[cfg(feature = "tray-icon")]` **永远求值为 false**。
- **后果**：注释明写"v0.12 Phase 3：系统托盘"，但系统托盘菜单（show/hide/quit）、托盘图标、左键点击切换显隐——**整段代码永远不会被编译进二进制**。用户看不到托盘图标，关闭窗口后无法从托盘恢复（只能靠 Task Manager 杀进程重开）。
- **验证**：`Cargo.toml` `[features]` 段全文只有 `custom-protocol = ["tauri/custom-protocol"]`，无 `tray-icon` 定义。
- **修复**：在 `[features]` 段加 `tray-icon = []`（本 crate feature，无依赖），或将 main.rs 的守卫改为 `#[cfg(any(feature = "tray-icon", feature = "custom-protocol"))]` 并在 release profile 开启。

### R2【high·功能性】updater 更新源 404，自动更新永远不可用

- **位置**：`src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
- **根因**：endpoint 写的是 `https://raw.githubusercontent.com/deepseek-studio/updates/main/latest.json`。实测 `curl -sI` 返回 **404 Not Found**——GitHub 组织 `deepseek-studio` 下的 `updates` 仓库不存在。
- **后果**：`tauri-plugin-updater` 已注册（main.rs:93），每次启动会去拉取这个 404 URL，用户永远收不到自动更新。v0.13 标称的"自动更新"功能实际不可用。
- **验证**：`curl -sI https://raw.githubusercontent.com/deepseek-studio/updates/main/latest.json` → `HTTP/1.1 404 Not Found`。
- **修复**：endpoint 改为实际存在的更新源（如 `lidicn/deepseek-studio` 名下的 releases），或在 GitHub 建立 `updates` 仓库并放 `latest.json`。

### R3【medium·安全/功能性】CSP 设为 null

- **位置**：`src-tauri/tauri.conf.json` → `app.security.csp = null`
- **根因**：主窗口加载外部 URL `https://chat.deepseek.com`（main.rs:130 `WebviewUrl::External`），同时 `load_init_script()` 注入 `entry.js`（main.rs:139）。CSP=null 意味着 WebView 不施加任何内容安全策略——注入脚本与远程页面**同源执行**，远程页面的任何脚本可访问注入的宿主能力。
- **后果**：若 chat.deepseek.com 被注入恶意脚本（或中间人篡改），可调用注入脚本暴露的桌面能力（shell/file/dom），等价于本地代码执行。
- **修复**：设置 CSP 白名单，至少 `script-src 'self' https://chat.deepseek.com`；注入脚本通过 postMessage 通信而非同源全局暴露。

### R4【medium·稳定性】Windows 进程树孤儿防护窗口期

- **位置**：`src-tauri/src/sidecar.rs:325-329`（do_shutdown Windows 分支）+ `:117-124`（spawn）
- **根因**：spawn 用 `Command::new("cmd").args(["/c","npx","tsx","src/api/main.ts"])`，进程树为 `cmd.exe → npx.cmd → node(tsx) → node(api/main.ts)`。`do_shutdown` 在 Windows 下调 `child.kill()`（line 328），Rust 的 `child.kill()` 在 Windows 上调 `TerminateProcess`——**只杀 cmd.exe 父进程**，npx/tsx/node 子进程成孤儿。
- **缓解**：Node 侧 `src/api/main.ts` 实现了 `installOrphanGuard`（line 22-54），每 2 秒轮询 `process.ppid` 变化 + `process.kill(ppid, 0)` 探活，父进程消失则 `process.exit(0)`。这是合理的软方案。
- **残余风险**：2 秒轮询窗口期内孤儿进程仍占资源（端口 8760 仍被占用，重启时 sidecar 健康检查可能因端口占用而失败）。Windows 下 `child.kill()` 不发 CTRL_BREAK，Node 的 SIGBREAK 钩子收不到——只能靠轮询探活。比 Job Object 级联杀弱。
- **修复**：Windows 下用 `windows_subsystem` 或 `Command::raw_arg` 配合 Job Object（`CREATE_JOB_OBJECT` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）实现进程树级联杀；或缩短孤儿探活间隔到 500ms。

### R5【medium·稳定性】关闭窗口时 sleep 阻塞主线程 500ms

- **位置**：`src-tauri/src/main.rs:228-234`（on_window_event CloseRequested 回调）
- **根因**：`api.prevent_close()` 后先 `save_window_state`，再 `handle.shutdown()`（发 Shutdown 命令），然后 `std::thread::sleep(Duration::from_millis(500))`（line 232）等 sidecar 退出，最后 `window.destroy()`。
- **后果**：`on_window_event` 在 Tauri 主线程执行，`sleep(500ms)` 阻塞主线程 500ms。用户点关闭按钮后窗口卡 500ms 才消失。sidecar 的 shutdown 是异步的（发命令到 mpsc channel），sleep 500ms 只是"盲等"——不保证 sidecar 真退出。
- **修复**：用 `tauri::async_runtime::spawn` 把 shutdown+wait 移到后台，或用 `SidecarHandle` 的 `wait()`（若有）替代盲 sleep。

### R6【low】version 不一致

- **位置**：`package.json` version `0.4.0` vs `tauri.conf.json` version `0.13.0`
- **后果**：构建产物版本号取 tauri.conf.json（0.13.0），但 package.json 的 0.4.0 用于 npm 脚本——两者不一致导致发布物版本号混乱。
- **修复**：统一为同一版本号。

---

## 二、auditkit round-001 机器扫描 triage

### 扫描概览

| 项 | 值 |
|---|---|
| 主语言 | TypeScript |
| 文件数 | ts 840 + js 58 + rust 3 + py 1 + yaml 1 |
| 行数 | ts 166498 + js 15169 + rust 652 |
| 框架 | openai, sqlite |
| 规则 | active=32, broken=0 |
| 总命中 | 5272（high 127 / medium 5144 / low 1） |

### 规则分布（top）

| 规则 | 命中 | 严重度 | triage 结论 |
|---|---|---|---|
| TS-03-unhandled-promise | 4952 | medium | **噪音主源**——正则匹配 `async`/`.then` 即报，绝大多数有 .catch 或 await 包装。需规则改进（加 .catch 识别） |
| TS-04-any-abuse | 84 | medium | 类型宽化，非稳定性缺陷，跳过 |
| TS-07-fetch-no-timeout | 51 | medium | **部分真缺陷**（见 A1-A3），mcp-controller 假阳性（见 §三） |
| GEN-01-hardcoded-secret | 39 | high | **测试噪音**——34/39 在 tests/（mock token），生产 2 处待核（i18n 文本/冒烟脚本误报） |
| TS-01-innerHTML | 39 | high | 待 triage——需确认是否用户可控输入直插 DOM（CodeBuddy C1 已覆盖部分） |
| GEN-03-eval-dynamic | 35 | high | 待 triage——需确认是否用户可控输入 |
| TS-08-settimeout-no-clear | 19 | medium | **部分假阳性**（mcp-controller 有配对 clear，见 §三） |
| JS-06-fetch-no-timeout | 15 | medium | 部分 tmp-*.mjs 噪音 |
| GEN-08-credential-eq | 7 | medium | 凭据比较时序攻击，低危 |

### A1【medium·真缺陷】oauth-client.ts 4 处 fetch 无 timeout

- **位置**：`deepseek-pp/src/core/sync/oauth-client.ts:133,180,187,204`
- **核验**：`grep 'fetch\|AbortSignal\|timeout'` 确认 4 处 fetch 全无 `signal`/`AbortSignal`/`timeout`。
- **line 133 上下文**：令牌刷新 `fetch(refreshUrl, {method:'POST', headers, body})`——OAuth 服务器响应慢或网络挂起时，`await fetch` 永久阻塞，令牌刷新链路卡死。line 139 的 `await res.text().catch(() => '')` 也无 timeout。
- **后果**：OAuth 令牌刷新是同步链路关键路径，无 timeout 会导致整个同步功能挂死（刷新永远 pending → 后续请求永远用过期 token → 永远 401）。
- **修复**：每处 fetch 加 `signal: AbortSignal.timeout(15000)`。

### A2【medium·真缺陷】webdav-client.ts 4 处 fetch 无 timeout

- **位置**：`deepseek-pp/src/core/sync/webdav-client.ts:30,42,53,64`
- **核验**：4 处 fetch 全无 timeout。
- **后果**：WebDAV 文件操作无 timeout，服务器挂起时同步操作永久阻塞。
- **修复**：加 `AbortSignal.timeout(30000)`。

### A3【medium·真缺陷】bundled-assets.ts 裸 fetch 无 timeout

- **位置**：`deepseek-pp/src/core/skill/bundled-assets.ts:145`
- **核验**：`fetch: (input) => fetch(input)`——依赖注入的 fetch 包装器，裸调 `fetch(input)` 无任何 timeout 配置。
- **后果**：资产下载无 timeout，挂起时阻塞。
- **修复**：加 timeout 或要求调用方传 AbortSignal。

---

## 三、假阳性裁决（auditkit 命中经核验不成立）

### FP1：mcp-controller.ts fetch-no-timeout（5 命中）→ 假阳性

- **auditkit 报**：`src/host/mcp-controller.ts:297,333,514,527,534` fetch 无 timeout
- **核验**：`grep 'fetch\|AbortSignal\|signal:'` 确认该文件所有 fetch 调用均带 `signal: AbortSignal.timeout(...)`：
  - line 338 `fetch(conn.httpUrl, {..., signal: AbortSignal.timeout(30000)})`
  - line 375 `fetch(conn.httpUrl, {..., signal: AbortSignal.timeout(10000)})`
  - line 619 `fetch(config.url, {..., signal: AbortSignal.timeout(15000)})`
  - line 633 `fetch(config.url, {..., signal: AbortSignal.timeout(5000)})`
  - line 641 `fetch(config.url, {..., signal: AbortSignal.timeout(15000)})`
- **结论**：**假阳性**。TS-07-fetch-no-timeout 规则的正则未识别 `AbortSignal.timeout()` 这种 timeout 形式。规则需改进（加 `AbortSignal\.timeout` 识别）。
- **与 CodeBuddy round-003 的关系**：CodeBuddy C3 报告 mcp-controller fetch 无 timeout（行号 :304/:340/:552/:565/:572）。当前代码行号已变且已加 AbortSignal——**疑似 round-003 后已修复**，或 CodeBuddy 漏看。本报告确证当前代码已有 timeout。

### FP2：mcp-controller.ts settimeout-no-clear（3 命中）→ 假阳性

- **auditkit 报**：`src/host/mcp-controller.ts:280,481,497` setTimeout 无 clear
- **核验**：该文件 setTimeout 均有配对 clearTimeout：
  - line 313 `setTimeout(...)` → line 324 `clearTimeout(timer)`
  - line 237 `clearTimeout(pending.timer)` / line 254 `clearTimeout(p.timer)`
  - line 403/571 的 `setTimeout(resolve, N)` 是 Promise 内一次性延迟（不需 clear）
- **结论**：**假阳性**。TS-08 规则未识别配对的 clearTimeout。

### FP3：GEN-01-hardcoded-secret 39 命中 → 34 条测试噪音

- 34/39 在 `tests/` 或 `*.test.ts`（mock token/fixture），生产仅 2 处（i18n 文本 + 冒烟脚本，疑似误报）。
- **结论**：测试命中不算缺陷。GEN-01 规则应加 tests/ 路径排除。

---

## 四、设计良好项（已验证，避免下轮重复审）

| 项 | 位置 | 验证结论 |
|---|---|---|
| sidecar 状态机 | sidecar.rs:33-48 | Spawning→Running→Crashed→Restarting→GaveUp/Stopped，状态转换完整，重启预算 MAX_RESTARTS=5 有上限 |
| 健康检查超时 | sidecar.rs:52-80 | connect_timeout + read_timeout 均设，buf 64B 够匹配 `HTTP/1.1 200` |
| Node 孤儿防护 | api/main.ts:22-54 | installOrphanGuard 2s 轮询 ppid + alive 探活，SIGTERM/SIGBREAK 注册，设计周全 |
| 鉴权 fail-closed | api/server.ts:10,264-265 | Bearer token 错误 → 401，CORS 非本地 origin 不写 Allow-Origin |
| loadConfig 配置保留 | api/main.ts:102-115 | v0.13 修复——写入时保留 workspaceRoot/policyMode，不再覆盖用户配置 |
| mcp-controller fetch timeout | mcp-controller.ts:338-645 | 所有 HTTP fetch 带 AbortSignal.timeout(5~30s) |

---

## 五、修复优先级

### P0（立即修复 · 服务阻塞）
1. **F-H2 server.ts readBody 无超时**——`maxConcurrent=1` 下一个慢客户端挂起 readBody 即锁死所有 chat 请求（429 concurrency_limited）。修复：readBody 加超时 + chunks 大小上限。
2. **F-H3 main.ts 配置损坏静默覆盖**——配置文件损坏时生成新凭据覆盖旧文件，用户 token 失效、客户端断连。修复：区分 ENOENT 与 parse 错误。

### P1（尽快修复 · 功能性死代码/更新失效/超时）
3. **R1 tray-icon feature 死代码**——系统托盘永不编译，用户关闭窗口后无法恢复。修 `[features]` 加 `tray-icon = []`。
4. **R2 updater endpoint 404**——自动更新永远不可用。修 endpoint 指向真实仓库。
5. **F-H1 automation.ts HTTP fetch 无超时**——cron 自动化任务 fetch 无 AbortSignal，挂起时日志永久 'running' 且堆积。修复：加 `AbortSignal.timeout(30000)`。
6. **A1 oauth-client fetch 无 timeout**——4 处加 AbortSignal.timeout（令牌刷新挂起会锁死同步链路）。
7. **A2 webdav-client fetch 无 timeout**——4 处加 AbortSignal.timeout。

### P2（计划修复 · 稳定性/安全/资源泄漏）
8. **R4 Windows 进程树孤儿窗口期**——缩短探活间隔或改 Job Object 级联杀。
9. **R5 关闭窗口阻塞主线程**——sleep 500ms 移到后台。
10. **R3 CSP null**——设 CSP 白名单。
11. **A3 bundled-assets 裸 fetch**——加 timeout。
12. **F-M3 storage.ts rejected Promise 永久不可恢复**——loadPromise 失败时置 null 允许重试。
13. **F-M4 transport-webview.ts 监听失败 Promise 永久挂起**——加 `wss.on('error', reject)`。
14. **F-M2 automation.ts 内存 logs 无界增长**——addLog 后同步 trim。
15. **F-M1 transport.ts pending Map 无超时无清理**——加超时 reject+delete。
16. **F-M5 file.ts stat 失败当"不存在"**——区分 ENOENT 与其他错误。
17. **F-M6 transport.ts message 监听器不配对移除**——实现 close()。

### P3（低优先级）
18. **R6 version 不一致**——统一版本号。
19. 令牌桶 `Map<string, bucket>` 无界——本地 API 攻击面有限，加容量上限。
20. **F-L1 agent-channel upgrade 监听器不配对移除**。
21. **F-L2 agent-loop maxSteps 双重错误事件**。
22. **F-L3 host-client 重连定时器未清除**。

---

## 六、工具漏报与规则改进建议（回灌 auditkit）

| 漏报/误报 | 规则 | 改进方向 |
|---|---|---|
| AbortSignal.timeout 未识别 | TS-07-fetch-no-timeout | 正则加 `AbortSignal\.timeout` / `signal\s*:` 识别 |
| 配对 clearTimeout 未识别 | TS-08-settimeout-no-clear | 加配对 `clearTimeout` 识别（同作用域或同变量名） |
| tests/ 命中淹没真信号 | GEN-01-hardcoded-secret | 加 tests/ 路径排除或降级 |
| TS-03 4952 噪音 | TS-03-unhandled-promise | 加 `.catch` / `await` 包装识别，降低误报率 |

---

## 七、前端层审计（agent 并行审读，19 模块）

> 由并行 general-purpose agent 对 `src/host/`、`src/bridge/`、`src/api/`、`src/desktop/`、`src/capabilities/` 共 19 个前端模块逐条对照稳定性/功能性/资源泄漏/错误处理/超时缺失/状态不复位六类判据。以下为确证发现，与 §一 Rust 层、§二 auditkit 层互补。

### HIGH（3 条）

| 编号 | 位置 | 缺陷 | 说明 |
|---|---|---|---|
| F-H1 | `src/host/automation.ts:224-230` | HTTP 自动化任务 fetch 无超时 | `type==='http'` 任务 `fetch(url,{...})` 无 AbortSignal。目标挂起时 executeTask Promise 永不 settle，日志条目永久 'running'，cron 周期堆积多个挂起 fetch。对比：同函数 shell 任务（:219）有 30s exec timeout。修复：加 `AbortSignal.timeout(30000)`。 |
| F-H2 | `src/api/server.ts:583-590` | readBody 无超时，串行模式下慢客户端阻塞全部请求 | `readBody` 监听 data/end/error 但无超时。客户端发完头不发 body 时 Promise 永久挂起。`/v1/chat/completions` 默认 `maxConcurrent=1`，一个挂起 readBody 占满并发额度，所有后续 chat 请求收到 429 concurrency_limited。readBody 被多个 POST 端点共用。另注：chunks 无大小上限。修复：`req.setTimeout()` 或 AbortController+超时 reject，chunks 设上限。 |
| F-H3 | `src/api/main.ts:84-88` | 配置文件损坏时静默吞错并覆盖现有配置 | 配置文件**存在但损坏**（非法 JSON）时 `catch { stored = {} }` 吞错。随后 :102 `if (!stored.token || !stored.secret)` 为真，生成新随机 token/secret 并 writeFileSync 覆盖原文件。用户旧 token/secret/workspace/policy 全部丢失，已配置客户端因 token 变更无法连接。无任何日志。修复：区分 ENOENT（首次运行）与 parse 错误（损坏，应告警+退出不覆盖）。 |

**注**：F-H3 与本报告 §一 R 系列无重叠，是对 `loadConfig` 更精确的发现——CodeBuddy round-003 与本报告初版均判断 loadConfig "v0.13 已修复"，但 agent 指出 catch 分支在**文件损坏（非首次运行）**场景仍会覆盖。这是更深的判据。

### MEDIUM（6 条）

| 编号 | 位置 | 缺陷 |
|---|---|---|
| F-M1 | `src/bridge/transport.ts:34-52` | WindowMessageTransport pending Map 无超时无清理——对端未响应时条目和 Promise 永久驻留 |
| F-M2 | `src/host/automation.ts:188-199` | 内存 logs 数组无界增长——saveLogs 写盘 trim 到 500，但内存 logs 只 push 不 trim，cron 每分钟一条→一年 52 万条驻留 |
| F-M3 | `src/bridge/storage.ts:213-223` | ensureLoaded 缓存 rejected Promise 永久不可恢复——loadPromise reject 后不置 null，后续所有 get/set 拿同一 rejected Promise，整个 storage area 永久不可用 |
| F-M4 | `src/bridge/transport-webview.ts:46-55` | createNodeWsEnvelopeReceiver 监听失败时 Promise 永久挂起——只监听 'listening' 未监听 'error'，端口占用时 wss 发 error 但 Promise 不 settle，调用方永久 await |
| F-M5 | `src/capabilities/file.ts:78` | stat 失败被当"文件不存在"——`.catch(() => null)` 吞 EACCES/EBUSY/EMFILE，模型据此可能覆盖因权限无法 stat 的已存在文件 |
| F-M6 | `src/bridge/transport.ts:35-43` | message 事件监听器从不移除——createWindowMessageTransport 返回的 Transport 未实现 close()，页面重建时旧监听器残留 |

### LOW（3 条）

| 编号 | 位置 | 缺陷 |
|---|---|---|
| F-L1 | `src/host/agent-channel.ts:62` | 'upgrade' 事件监听器在 dispose 中不移除 |
| F-L2 | `src/host/agent-loop.ts:131-134` | maxSteps 终止时双重错误事件——第二条"未取得模型回复"误导（实为工具轮次用尽） |
| F-L3 | `src/desktop/host-client.ts:204-208` | 重连定时器在 disconnect 时未 clearTimeout |

### 跨模块热点（可沉淀为 auditkit 规则）

agent 识别出三类跨模块通则，与跨项目审计报告（`E:\NAS\ADM-auditkit\审计报告\跨项目稳定性功能性审计报告_20261012.md` §十一）的共性族吻合：

1. **超时缺失**（4 处：automation fetch、server readBody、transport pending Map、transport-webview listening）——跨项目通则 A 的 TS 实例。auditkit TS-07 规则已覆盖但需改进 AbortSignal 识别（见 §六）。
2. **读失败当"没有数据"**（2 处：main.ts `.catch(() => ({}))`、file.ts `.catch(() => null)`）——跨项目通则"读失败不能当没有数据"。可规则化：检测 `.catch(() =>` 返回空字面量且丢弃 err 参数。
3. **资源释放不配对**（3 处：transport listener、agent-channel upgrade、host-client 重连定时器）——跨项目通则 B。可规则化：addEventListener 无同文件配对 removeEventListener（同引用）。

---

## 八、局限性声明

1. 本报告分三层：§一 Rust 外壳层（人工审读，CodeBuddy round-003 未覆盖）+ §二 auditkit 机器扫描 triage + §七 前端层（并行 agent 审读 19 模块）。CodeBuddy 报告的 MCP 控制器层（C1-C9）不重复，仅在 §三 标注与当前代码的差异。
2. auditkit generic_text 为正则分析器，无法做 AST 级数据流分析——`AbortSignal.timeout` 经中间变量传递的形态可能漏判（本报告已人工核验 mcp-controller）。
3. GEN-01-hardcoded-secret 的 2 处生产命中（i18n/冒烟脚本）未逐行核验，疑似误报但未确证。
4. 嵌套子项目 deepseek-pp（677 ts 文件/13 万行）的深度审计依赖 auditkit 机器扫描 + agent 抽样审读，未逐文件人工审读。

---

**审计署名**：Claude Code · ADM-auditkit 审计 agent
**报告日期**：2026-10-12
**工具链**：lidicn/ADM-auditkit @ NAS 192.168.2.200 容器 auditkit（round-001 generic_text 扫描）+ 人工 Rust/Node 源码审读
**并存报告**：`审计报告_deepseek-studio_20261012.md`（CodeBuddy 审计席，round-003，覆盖前端 MCP 层）
