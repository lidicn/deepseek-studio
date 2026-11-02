---
title: deepseek-studio 只读代码审计报告（TD · 第 2 轮 · 2026-11-02）
summary: 第 2 轮只读审计，基线 HEAD 12cfd55（工作区含 6 个已修改文件，其中 4 个有内容 diff）。集中看 src/inject 注入层、mcp 与 bot 授权路径、CDP 调试口可达性，共证实 10 条（P1×2、P2×6、P3×2），最严重为「页面脚本拿令牌自建 /studio 通道并自答同意」的完整提权链与 mcp.get 无审批返回 env/headers 凭据；另列 4 条可疑未证实、已核实无问题的 4 处，以及本轮未覆盖范围的量化说明。
---

# deepseek-studio 代码审计报告（TD · 第 2 轮）

审计性质：**只读**。未改源码、未 commit/checkout/stash、未装依赖、未启动 tauri dev、未跑 typecheck/vitest。

## 一、审计基线与方法

| 项 | 取值 | 依据 |
|---|---|---|
| 仓库根 | `E:\NAS\deepseek-studio` | 目录实测 |
| HEAD | `12cfd55afe141019169f54911819b450a0292236`（2026-11-02 12:07，docs(验收)） | `git rev-parse` |
| 分支 / 上游 | `master` → `origin/master` | `git rev-parse --abbrev-ref` |
| 与上游差异 | `git rev-list --left-right --count HEAD...@{u}` = 0/0 | 同左 |
| 工作区状态 | **脏**：`git status --porcelain` 6 个 `M` + 3 个 `??`；其中 `git diff --stat` 只有 4 个文件有内容改动（model-engine.ts 34 行、web-engine.ts 151 行、task-loop.ts 40 行、task-loop-reply.test.ts 25 行），`memory/candidates.ts`、`memory/core.ts` 仅行尾/mtime 差异 | `git status --porcelain` + `git diff --stat` |
| 与第 1 轮的关系 | 第 1 轮基线是 `630b076`；`git log 630b076..HEAD` 仅 1 个提交，`git diff --stat 630b076..HEAD` 只动 4 个 docs 文件 → **src/ 与 src-tauri/ 源码未变，第 1 轮针对这两个目录的 file:line 与结论在 12cfd55 上仍成立** | 两条 git 命令 |

**本轮取证时刻**：2026-11-02 12:40–13:05（+08:00）。期间 HEAD 未再变动；工作区又被其它会话改过（相比第 1 轮新增 `task-loop.ts` 与 `tests/desktop/task-loop-reply.test.ts` 两个 `M`）。本报告所有 `file:line` 对应上述 HEAD + 取证时刻工作区，且涉及的 10 条缺陷文件（src/inject、src/host/mcp-controller.ts、src/host/page-runtime.ts、src/host/tool-definitions.ts、src/host/desktop-host.ts、src-tauri/src/*、src/api/main.ts）**均不在脏文件清单内**（唯一例外：第 1 轮 TD-02 引用的 web-engine.ts 不在本轮取证链上）。

方法：继续用只读 shell 按跳取证（每跳带 `file:line`）；`src/inject` 按「先桥接/入口，后主拦截器关键段」的顺序读，避免了再去逐行读 159KB 的 `main-world-interceptor.ts` 全文。

## 二、结论摘要

- 已证实缺陷 **10 条**：P1×2、P2×6、P3×2。可疑未证实 4 条单列第四节。
- 最严重的是一条**完整提权链**（R2-01）：注入脚本跑在页面的 main world，把 host token 直接放在 `window.__studioHostToken`；它同时又是 `/studio` WS 的凭据。于是chat.deepseek.com 页面里任意一段能执行的脚本（站点 XSS、第三方脚本、用户贴进来的东西）都能拿到令牌、自建一条 `/studio` 连接、发 `hello` 自报合法 origin，然后自己发起 `tool-call`、**自己回 consent-decision 批准**——同意闸门的“人”和“被约束方”是同一个东西。
- 第二严重：`mcp.get` 以 `approvalClass: 'none'` / `risk: 'read'` 的身份，返回 MCP 服务器的完整配置（含 `env` 与 `headers`，而这两处正是 MCP 凭据存放位），无审批、无脉络。
- 第 1 轮存疑的 CDP 调试口：**维持 P2**，定性见 R2-03（绑定回环 + 无鉴权 + 浏览器侧受 Host/Origin 双重限制；风险面主要是本机进程而非网页）。
## 三、缺陷清单

### P1 高危

#### R2-01 页面脚本可自建 /studio 通道并自答同意（同意闸门自证）
- 位置链（一条链，逐跳）：
  1. `src-tauri/src/main.rs:1021-1028` 把 `load_host_token_script()` 拼进 `initialization_script`；该函数生成 `window.__studioHostToken = "<token>"`（同文件 `load_host_token_script` 内部）。
  2. `src/desktop/entry.ts:140-143` 读取该全局量，拼成 `${DEFAULT_HOST_URL}?token=...` 交给 host-client；说明令牌是 `/studio` 的准入凭据。
  3. `src/host/page-runtime.ts:204` upgrade 阶段只校验 `?token=`；`:212-214` 只在**带 Origin 时**才校验，注释明写「无 Origin 的非浏览器客户端（测试/本机脚本）放行」。
  4. `src/host/page-runtime.ts:305-313` hello 自报 origin 与握手 Origin 必须一致——但页面脚本从 chat.deepseek.com 发起时两者天然一致，这道闸门拦不住它。
  5. `src/host/page-runtime.ts:47-53` `REQUIRES_READY` 只要求 hello 完成，不要求「是那个被注入的脚本实例」；`:618-634` `requestConsent` 把 `consent-required` 发给**同一个连接**，`:472-479` 再从同一连接收下 `consent-decision`。
- 触发条件：chat.deepseek.com 页面内能执行任意 JS（站点 XSS / 第三方脚本 / 用户粘贴的脚本 / 调试口 Runtime.evaluate）。步骤：读 `window.__studioHostToken` → `new WebSocket('ws://127.0.0.1:8760/studio?token=...')` → 发 `hello`（origin 写页面自己的 origin）→ 发 `tool-call` → 等 `consent-required` → 用同一个 callId 回 `consent-decision: allow/always`。
- 实际影响：绕开第 1 轮 TD-02 “传导到攻击者的只是令牌”的间接性，**不需要宿主 UI、不需要人点同意**，可直接让宿主执行 `shell.exec`；选 `always` 时还会在`conversationApproved` 里留下「本次对话始终允许」的记录，后续同类调用完全静默。
- 证据类型：代码级证明（链上每一跳都已读取原文）；未做运行期复现，但不需要任何未证实的前提，只要页面能跑脚本。
- 修复建议（三选一或组合）：① 同意决定不能由请求方自答：`requestConsent` 必须发往**另一个信使**（Tauri 原生窗口，或一个经原生通道鉴权的 out-of-band 通道），页面只能拿到“待审”而不能回 decision；② 令牌不要去页面（见第 1 轮 TD-02），改为由 Rust 侧代理 WS 升级（页面只能连本机代理，代理持令牌且不暴露）；③ 在 `REQUIRES_READY` 基础上增加「连接实例与注入会话的 nonce 绑定」，宿主启动时生成，只注入给注入脚本。
- 验收判据：在页面控制台里手动按上述步骤自建 WS 并发起 `shell.exec`，必须得到 `consent` 无法自答（碻回 403/错误或 decision 被丢弃），且审计日志里出现一条「consent decision from non-owner channel」拒绝记录。

#### R2-02 `mcp.get` 无审批返回 MCP 服务器的 env/headers（凭据披露）
- 位置：`src/host/tool-definitions.ts:206-212`（`id:'mcp.get'`, `approvalClass:'none'`, `risk:'read'`）→ `src/host/desktop-host.ts:610-618`（`return { ok: true, data: { id: serverId, config: cfg } }`，`cfg` 为 `getMcpServer` 返回的完整配置对象）→ `src/host/mcp-controller.ts:25`（`env?: Record<string,string>`）、`:33`（`headers?: Record<string,string>`）为凭据存放位。
- 触发条件：任何已鉴权调用方（含 R2-01 里的页面脚本、`/v1/tools/execute`）只要知道 `serverId`，就能拿到全部 `env`/`headers`。`mcp.list` 同样为 `none`，可先枚举 serverId。
- 实际影响：MCP 配置的惯例就是把 API key 放在 `env`（stdio）或 `headers`（http/sse）里；而行内对比可知，同一个文件里 `mcp.save` 是 `always`、`mcp.call` 是 `always`，说明设计上就把配置当敏感物，**只有读配置的这条路无审批且不脱敏**。与 R2-01 组合后形成「页面脚本 → 无审批读走本机所有 MCP 凭据」。
- 证据类型：代码级证明。
- 修复建议：`mcp.get` 返回值对 `env`/`headers` 做掩码（只回前 4 尾 4 或布尔存在性），并把 `approvalClass` 改为 `always`；UI 编辑回填改走一条只返回非敏感字段的路径。
- 验收判据：`mcp.get` 返回体里 `env` 每个值都是 `****`（或 `hasValue: true`），且未经同意调用返回 `consent-denied`。

### P2 一般

#### R2-03 CDP 调试口默认常开：可达性定性与判据
- 位置：`src-tauri/src/main.rs:921-940`：未设 `STUDIO_DISABLE_CDP` 时默认写入 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`（9222 被占则用 9223）；全仓无 `--remote-allow-origins`（同文件 `grep remote-allow-origins` 0 命中）。
- 定性：
  - **绑定范围**：未传 `--remote-debugging-address`，Chromium/WebView2 的 DevTools 监听默认只绑 `127.0.0.1`（回环），不对外网开放。同文件 `:923` 的端口探活也是 `TcpListener::bind(("127.0.0.1", p))`，与此一致。
  - **鉴权**：DevTools HTTP/WS 端点**没有应用层鉴权**，任何本机进程可直接 `GET /json` 拿页面列表与 webSocketDebuggerUrl。
  - **网页侧能否接上**：两层屏障。① DevTools 的 HTTP 端点对 `Host` 头部做回环校验，且不回 `Access-Control-Allow-Origin`，普通页面 `fetch` 读不到、DNS rebinding 也会因 Host 不是 IP/localhost 被拒；② WebSocket 端点自 Chromium 111 起默认拒绝带非空 `Origin` 的连接，除非显式 `--remote-allow-origins`——本仓库未设，所以网页 `new WebSocket('ws://127.0.0.1:9222/...')` 会被拒。**因此“网页 JS 直接触达”没有代码或配置面的证据。**
  - **真正的风险面**：本机任意进程（含用户双击的任何小程序、沙箱外工具）可以不需任何凭据接管 WebView：`Runtime.evaluate` 读 `window.__studioHostToken`、直接点击同意按钮。对本机不同权限等级的进程无隔离价值。
- 维持**P2**是合理的（不是 P1：无远程面；也不是 P3：它把一个默认关闭、仅调试需要的危险入口在生产构建里长期打开，且只靠环境变量关）。
- 升级为 P1 的判据（任一成立）：① 出现 `--remote-allow-origins=*` 或任何纳入非回环 origin 的配置；② 打包配置里加了 `--remote-debugging-address=0.0.0.0`；③ 实测证实页面/扩展能在无该参数时连上 WS；④ 同意 UI 被简化为“默认允许”。
- 修复建议：release 构建默认不开（`cfg!(debug_assertions)` 或 `STUDIO_ENABLE_CDP=1` 显式开启），并在开启时把端口限制为 9222 且打印醒目告警。
- 验收判据：release 安装包启动后 `netstat` 看不到 9222/9223 在 LISTENING；设 `STUDIO_ENABLE_CDP=1` 后能连上。

#### R2-04 `testConnection` 无 finally：超时/异常路径泄漏活子进程
- 位置：`src/host/mcp-controller.ts:739-772`：`proc.kill()` 只在两处成功分支（`:752` initialize 无 result、`:767` tools/list 完成后）；`:748` 与 `:764` 的 `setTimeout(..., reject)` 在两个 await 上，一旦超时/抛错就走 `:770-772` 的 `catch` 直接 `return`，**没有 finally**（全文件 `grep finally` 0 命中）。
- 触发：新增一台命令能启动但不应答 initialize 的 MCP server（错版本、要交互登录、只想静默、或就是卡死），或在工具列表阶段卡住，然后点一次“测试连接”。
- 实际影响：每次超时留下一个活着的 MCP 子进程（stdio pipe 仍接在宿主上）；反复测试就是无上限的进程/句柄累积。与第 1 轮已修的“connect 失败不 kill”是同一类，但 `testConnection` 这条路径仍未覆盖。另：`:748`/`:764` 的 `setTimeout` 未 `clearTimeout`，超时后工作清空却仍持有计时器（轻）。
- 证据类型：代码级证明。
- 修复建议：整个 try 包 finally，finally 里对未接管的 proc 做 `kill()` + 清 `pendingRequests` + 清两个 timeout 句柄。
- 验收判据：用一个只 `pause` 不应答的假 MCP 服务器（如 `node -e "setInterval(()=>{},1000)"`）跑 `mcp.test`，结束后 `tasklist` 里不应残留该 node 进程。
#### R2-05 MCP 配置写非原子：进程死在中途则全部服务器消失
- 位置：`src/host/mcp-controller.ts:147`（`removeMcpServer` 直接 `fs.writeFileSync(p, ...)`）、`:161`（`ensureMcpConfig` 初建）、`:840`（`mcp.save` 落盘）。均为“同一路径覆盖写”，无 `tmp + rename`。
- 触发：写入瞬间进程被杀/断电/盘满；或两个窗口同时改 MCP 配置。
- 实际影响：`config.json` 级别的 MCP 配置文件变成截断的非法 JSON；读取侧只能回落到空/默认，表象是“界面上所有 MCP 服务器不见了”，而文件已坏——与历史 BUG-032 同类，**当前仍未修**（本轮直接在 `:147`/`:840` 看到裸 `writeFileSync`）。
- 证据类型：代码级证明。
- 修复建议：统一改为 `writeFileSync(tmp)` → `fsync` → `renameSync(tmp, configPath)`；并发写加一个进程内互斥。
- 验收判据：写入过程注入 abort（或在写入前 kill 进程）后重启，MCP 服务器列表仍完整；配置文件可被 `JSON.parse`。

#### R2-06 `project.create` 声明为只读（`risk:'read'` / `class:'none'`）却写盘 + 建目录
- 位置：`src/host/tool-definitions.ts:382-392`（`id:'project.create'`, `risk:'read'`, `approvalClass:'none'`）→ `src/host/desktop-host.ts:913-940`（`:920` `mkdirSync(path.dirname(configPath))`、`:928` 读入 projects.json、`:934-936` `projects.push`、随后 `writeFileSync`），实现注释自述“写入配置文件 + 创建目录”。
- 触发：模型或页面发 `project.create {name, path}`，完全不经审批。
- 实际影响：无审批的系统写入。`path` 来自调用方且**不经过 `workspace.resolveWithin`**（本工具根本没接 workspace），可把任意绝对路径注册进项目列表，后续以项目为上下文的读取就会把该路径当工作区使用。另：`id` 由 `name` 剔非字母数字生成（`:933`），中文名会被剔成空串 → 多个项目撞同一个 `''` id；`projects.find` 命中后静默不添加。
- 证据类型：代码级证明（写入行为）；路径后续用途为静态推断。
- 修复建议：`risk` 改 `privileged`、`approvalClass` 改 `always`；`path` 必须过 `resolveWithin` 或至少存在性+目录校验；`id` 对空串做回退（hash 或 uuid）。
- 验收判据：`project.create {name:"中文",path:"C:\\Windows"}` 返回同意请求（未批准则拒绝）；两个中文名项目不会共用同一个 id；非目录路径被拒。

#### R2-07 `memory.save` 无审批持久写入（长期提示注入的落点）
- 位置：`src/host/tool-definitions.ts:170-178`（`id:'memory.save'`, `risk:'read'`, `approvalClass:'none'`）→ `src/host/desktop-host.ts:533-540`（`store.save(normalizeMemorySaveParams(params))` 真写入，成功后 `broadcastMemories`）。
- 触发：任何已鉴权调用方（含 R2-01 的页面脚本）写一条带指令文本的记忆。
- 实际影响：记忆会进入后续上下文（`web-engine`/`agent-loop` 的记忆注入路径），而写入端**无审批、无来源标记、无长度/数量门槛**（仅 `normalizeMemorySaveParams` 归一）。这意味着“一次性的页面注入”可以升级为“持续生效的上下文污染”：后续每一轮对话都主动携带它。风险等级不应低于 `file.write`（后者是 `privileged/mode`）。
- 证据类型：代码级证明（写入链）；“写入的内容确实进入后续 prompt”这一环未逐行验证，见第四节第 3 条。
- 修复建议：`memory.save` 改 `approvalClass:'mode'`（至少 auto 档要问），并给每条记忆加 `source: 'model'|'user'|'page'` 与写入时会话标识，注入时按来源降权。
- 验收判据：workspace 档下 `memory.save` 首次调用会弹同意；审计里每条记忆都带来源标记。

#### R2-08 注入脚本里硬编码了某个开发者的绝对路径（代码块“运行”在其他机器上必失败）
- 位置：`src/inject/main-world-interceptor.ts:2739`：`const tmp = `C:/Users/lidicn/AppData/Local/Temp/studio-run-${Date.now()}.${ext}`;`，随后 `:2740` 用 `local_file_write` 写该路径、`:2745` 用 `shell_exec` 跑 `node`。
- 触发：在其他 Windows 用户/机器上点助手消息里 JS/TS 代码块的“运行”。
- 实际影响：`local_file_write` 走 `file.ts:45-50` 的 `resolveWithin`，`C:/Users/lidicn/...` 不属于当前工作区 → 返回 `outside-workspace` → 代码块运行恒失败（仅对用户名正好是 `lidicn` 且工作区就是它家目录的开发机不失败）。另外把用户代码写到固定的他人目录、且有 `Date.now()` 无清理。
- 证据类型：代码级证明（路径硬编码 + 边界校验）。“在其他机器上必失败”依赖“该路径不在工作区”这一项，对本仓库默认工作区（`E:\NAS\deepseek-studio`）成立。
- 修复建议：路径不写死，改为由宿主提供一个 `temp.dir` 能力（或让 `shell.exec` 直接接 stdin）、或让宿主侧派生临时目录；并事前清理。
- 验收判据：在非 `lidicn` 用户下点 JS 代码块的“运行”，能拿到执行结果而不是 `outside-workspace`。

### P3 轻微

#### R2-09 `shell.exec` 输出上限按 UTF-16 码元计，不是字节（第 1 轮存疑项结案）
- 位置：`src/capabilities/shell.ts:100-105`（`appendCapped` 用 `existing.length` / `chunk.length` / `chunk.slice(0, remaining)`），上限传入处为 `DEFAULT_MAX_OUTPUT_BYTES = 64*1024`。
- 实际后果（逐项判定）：
  1. **内存放大**：中文一字 1 码元但 UTF-8 3 字节 → 实际可缓存文本最大约 192KB 而非 64KB。单次调用可接受，并发调用时是隐性放大，但不构成崩溃风险。
  2. **可能切断代理对**：`chunk.slice(0, remaining)` 按码元切，可以切在 emoji 的高低位之间，产生孤立代理。后续 `JSON.stringify`（ES2019 well-formed）会将其转义为 `\udXXX`，下游拿到替换字符或编码报错——属显示层乱码，不影响安全。
  3. **`truncated` 标记正确**：`chunk.length <= remaining` 时 `keep=true`，边界恰好命中不会被误报为截断。
- 结论：存疑项**确认为真，但影响仅为轻微**，维持 P3（原先担心的“内存压力”未成立）。
- 修复：`Buffer.byteLength` 计数或干脆按 Buffer 拼接限长；切分时对齐代理对。
- 验收：输出 100K 个汉字时返回体字节长度 ≤ 约 64K；末尾不出现孤立代理。

#### R2-10 孤儿防护对 PID 复用盲；补偿路径的通配杀可能误伤（第 1 轮存疑项结案）
- 位置：`src/api/main.ts:35-42`（`getPpid() !== ppid0 || !alive(ppid0)`；Windows 下 `process.ppid` 不会变，只剩 `process.kill(pid,0)` 探活）→ 补偿：`src-tauri/src/sidecar.rs:195-217`（首轮 `restarts==0` 时按命令行匹配 `*tsx*dist*cli.mjs*` 且 `*api/main.ts*` 的 node.exe 全杀）。
- 实际情况：
  1. **PID 复用仍不可判**：guard 无法区分“父进程还活着”与“另一个进程刚巧占用了同一个 PID”，所以孤儿宿主可能一直活着（持 8760 与有效 token）。
  2. **补偿只在下一次启动生效**：只有用户重开应用才会被 `terminate_host_by_cmdline` 收掉；在此之前孤儿一直占端口、一直持有有效令牌。
  3. **通配杀可能误伤（本轮新发现）**：匹配条件是命令行含 `tsx`+`dist`+`cli.mjs` 且含 `api/main.ts`，**不限定项目路径**——同一台机器上另一个开发项目如果也是 `tsx dist/cli.mjs api/main.ts` 布局，启动本应用时会被一并 `taskkill /T /F`。
- 结论：存疑项**确认为真，且本轮找到一个新的副作用（误杀）**；整体维持 P3（需同时满足“主程序被强杀”+“PID 被复用”+“启动前未重启”，以及另一个同构项目存在）。
- 修复建议：guard 改用“父进程启动时间 + 可执行文件校验”（Windows 可用 `GetProcessTimes`/`CreationDate`）而非纯 PID；补偿杀加上 `ExecutablePath`/工作目录限定到本应用目录。
- 验收：`node -e "console.log(process.pid)"` 冒充父 PID 再杀真父进程，子进程应在 1s 内退出；同机另一个 `tsx ... api/main.ts` 项目不被杀。
## 四、可疑但未证实

1. **令牌进 URL query 后是否真落到日志**：`src/desktop/entry.ts:141-143` 把 token 拼进 `${DEFAULT_HOST_URL}?token=...`，`page-runtime.ts:204` 从 query 读。缺什么证据：本轮未在 page-runtime 找到把 upgrade URL 整串写日志/迹的代码，也未在 sidecar 日志样品里看到带 token 的 WS 行。需实测一次启动后 `logs/*.log` 是否出现 `token=`。若出现，应升为 P2（凭据落盘）。
2. **CDP 端口竞争窗口**：`main.rs:923` 用 `TcpListener::bind` 探活后**立即释放**，再到 WebView2 真正绑定之间存在窗口；若被其他进程抢走，DevTools 会绑定失败（功能降级）而不是把端口交给对方。缺什么证据：需在 9222/9223 上放一个插子服务再启动，观察行为。
3. **记忆写入是否进入后续 prompt**：R2-07 只证到“无审批写库”，未逐行读 `memory-store`/`web-engine` 的注入组装（本轮未覆盖 memory 域）。缺什么证据：需确认 `store.save` 的行会在下轮 prompt 里出现（包括截断/相似度筛选后的比例）。
4. **`settleStreamEnd` 的 `streamId === undefined` 分支**：`src/inject/main-world-interceptor.ts:1896` 只在 `streamId !== undefined` 时才做“非当前流不结算”判定，而全会文件只在 `:2715`/`:2717` 把该函数作为回调传入（实际调用在 hook 内部）。本轮未逐行跟完两条 hook 的调用点，所以“是否存一条不传 streamId 的路径（会跳过所有权检查）”未确认。缺什么证据：读 `installFetchHook`（`:1194`）与 `installXhrHooks`（`:1405`）全文。**第 1 轮“断流双所有者”的汇报因此降级为“本轮未发现双所有者证据，但未穷尽调用点”**。

## 五、已核实无问题的点（可供后人省时间）

1. **bot 域无授权绕过**：`src/host/bot/slot-runtime.ts:47-121` 全部工具执行都委托宿主的 `invokeTool`（`desktop-host.invokeTool`，含完整授权链 + 同意闸门），白名单只做“提前过滤”，注释也明确“命中白名单 ≠ 免授权”；同目录 `grep resolveAuthorization/evaluatePolicy/consent` 除类型引用外 0 命中。`offline-runner.ts` 同样经 `slotRuntime.run`。
2. **WS 升级三重闸门均存在**：`page-runtime.ts:204` token、`:212-214` Origin 白名单、`:47-53` + `:305-313` hello-ready 与自报 origin 一致性校验。本轮发现的问题不在这些闸门本身，而在“同意决定由被约束方自己回”（R2-01）。
3. **注入层 UI 无 HTML 注入面**：`src/inject` 共 12 处 `innerHTML`/`insertAdjacentHTML`，逐处核过——`tool-card-ui.ts:274-333`、`skill-popup.ts:303-325` 对外部字段全部过 `escapeHtml`（图片 URL 另走协议白名单）；`vis-card.ts:72` 与 `vis/render.ts:92` 先过 `DOMPurify.sanitize`；`tool-card-ui.redesign.ts` 统一委托 `src/ui/sanitizer`。
4. **同域直连桥的 session 校验生效**：`direct-port.ts:27-29` 对 `data.__session !== sessionId` 直接丢弃，`direct-target.ts:18-27` 的总线按 origin 分桶且对外不暴露。**但注意**：该桥的两端在桌面形态下同属 main world（无隔离世界），它抵御的是“页面脚本伪造消息”，抵御不了“页面脚本直接读 `window.__studioHostToken` 另开一条 WS”（即 R2-01）；不要在后续评审里把这座桥当成信任边界。

## 六、未覆盖范围（量化）

- **完整读完**：5 个文件（`src/inject/{origin-guard,bridge-install,direct-bridge,direct-target,direct-port}.ts`），合计 8,279 字节 / 317 行。
- **分段读完**：9 个文件的关键函数（`entry.ts:120-210`、`main-world-interceptor.ts:1887-1985` + 多处 grep、`loader.ts:1-120`、`tool-card-ui.ts:274-315`、`skill-popup.ts:300-330`、`page-runtime.ts:1-60` + 关键点、`mcp-controller.ts:120-175/694-772`、`desktop-host.ts:455-490/533-540/610-618/898-943`、`shell.ts:88-132`），另对 `tool-definitions.ts` 做了全量结构提取（36 个 tool 的 class/risk）。本轮新读约 1,100 行。
- **未读完**：`src/inject` 其余 33 个文件（含 159,949 字节的 `main-world-interceptor.ts` 主体、35KB 的 `pow-wasm.ts`、35KB 的 `tool-card-ui.redesign.ts`）；`src/host/memory/*` 全量（约 76KB）；`src/ui/*`（67 文件 / 670KB）；`src/host/engine/web-engine.ts` 与 `model-engine.ts`（本轮均为未提交改动文件，不纳入取证）。
- **原因**：只读通道单次输出上限约 8KB（超过即截断），本轮预算内优先把“能直接支撑或推翻 P1”的路径读完（授权、桥、WS、hook 结算、MCP 子进程），否则会把时间花在 UI 渲染细节上。
- **未执行**：typecheck / vitest / 构建 / tauri dev（机器内存约束 + 任务纪律）。所有 R2 结论均为静态代码级，没有运行期观测。

## 七、修复优先级与验收方式

1. **立即**：R2-01（同意自答）与 R2-02（mcp.get 凭据）。这两条一旦被利用，其余工具级防护全部作废；修法都在宿主侧，不动注入层结构即可落地。验收分别用“页面自建 WS 发 tool-call”与“mcp.get 返回体掩码”两个手工用例锁定。
2. **发布前**：R2-05（MCP 配置原子写）、R2-04（testConnection 泄漏进程）。两条都是“一次意外操作就让用户丢配置/漏进程”，改动小、可回归。
3. **下个迭代**：R2-06、R2-07（声明与副作用不符的两个工具，涉及治理语义，需同步改前端提示文案），以及 R2-08（硬编码路径，顺带把代码块运行器改为宿主侧提供临时目录能力）。
4. **随手**：R2-09（字节计数）、R2-10（孤儿防护与限定范围杀进程）。
5. 建议把 R2-01 的验收用例写成自动化集成测试（起一个真宿主 + 一个假“页面”WS 客户端，断言 consent 不能自答）——这是本轮唯一一条“修错了也没人发现”的结构性缺陷。

---

**本轮工作量与结果**：读源码约 1,100 行（完整 5 个文件 + 分段 9 个文件，覆盖 `src/inject` 9/42、以及 `page-runtime`/`mcp-controller`/`desktop-host`/`tool-definitions` 四个治理面文件）；证实缺陷 10 条（P1×2、P2×6、P3×2）；可疑未证实 4 条；已核实无问题 4 处；未覆盖子域：`src/inject` 其余 33 个文件（含主拦截器主体）、memory 域、`src/ui` 全量、两个未提交改动的 engine 文件。