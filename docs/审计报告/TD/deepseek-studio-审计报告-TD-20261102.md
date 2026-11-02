---
title: deepseek-studio 只读代码审计报告（TD · 2026-11-02）
summary: 只读审计对象为 E:\NAS\deepseek-studio master@630b076（工作区含未提交改动，审计以工作区树为准）。共证实 14 条缺陷（P1×4、P2×7、P3×3），最严重三条为 search_files 绕过工作区边界与硬拒绝地板、注入脚本把本地 API 令牌交给任意导航后的外部页面、shell.exec 的 argv 形态可绕过硬拒绝地板；另列 4 条可疑未证实项、9 条历史缺陷复核结论与明确未覆盖范围。
---

# deepseek-studio 代码审计报告（TD）

审计性质：**只读**。全程未修改源码、未 commit/checkout、未装依赖、未启动 tauri dev 或任何长驻进程、未执行 typecheck/test（本机内存敏感，按任务纪律不跑重活）。

## 一、审计基线与方法

| 项 | 取值 | 依据 |
|---|---|---|
| 仓库根 | `E:\NAS\deepseek-studio` | 目录实测 |
| HEAD | `630b07691cb4e4375ecd153d21b205be34285cd6` | `git rev-parse HEAD` |
| 分支 / 上游 | `master` → `origin/master` | `git rev-parse --abbrev-ref` |
| 与上游差异 | `git rev-list --left-right --count HEAD...@{u}` 输出为空行（0/0） | 同左 |
| 工作区状态 | **脏**：`M src/host/engine/model-engine.ts`、`M src/host/engine/web-engine.ts`，另有 4 个未跟踪 docs 文件 | `git status --porcelain`（8 行） |
| 最近提交 | `630b076` 2026-11-02 09:27 feat(inject+ui): R4 注入层守卫…；`d46c938` 09:25 墨鉴第三批；`dbd7a43` 08:28 墨鉴第一/第二批 | `git log -3` |
| 版本号 | package.json 0.4.0；tauri.conf.json 0.13.0 | 文件实测 |
| 构建产物 | 存在 `dist/`（2026-10-12 12:28），早于 HEAD，不构成 HEAD 的运行产物证据 | 目录时间戳 |

**风险提示（必须读）**：① 本轮审计的树 = HEAD `630b076` + 两处未提交的工作区改动（`model-engine.ts`、`web-engine.ts`），凡涉及这两个文件的结论仅对工作区当前内容成立；② 本检出跟踪 `origin/master`，但工作区脏意味着「已发布代码」与「被审代码」可能不同；③ 本轮**未**执行 `tsc --noEmit` 与 `vitest`，所有结论均为静态代码级证明或静态推断，不含运行期复现。

方法：以只读 shell 遍历源码（每跳带 `file:line`），与 `docs/审计报告/归档/墨鉴/` 下 16 份历史报告逐条对照（BUG-001~039），给出「当前是否仍存在」的复核结论；未做全文通读的模块在第五节明确列出。

## 二、结论摘要

- 已证实缺陷 **14 条**：P1×4、P2×7、P3×3。可疑未证实 4 条单列第四节。
- 最严重三条：
  1. **`search_files` 完全绕过授权与工作区边界**（P1）——`approvalClass: 'none'` 且未纳入 `FILE_TOOLS`，宿主把调用方传入的 `root` 原样交给检索器，可列出/检索工作区外任意目录（含 `%USERPROFILE%\.ssh`）。
  2. **主窗口把本地 API 令牌注入外部页面，且没有任何导航/新窗口守卫**（P1）——`window.__studioHostToken = "<token>"` 随 `initialization_script` 在每次导航重放，该 token 可直接调 `/v1/tools/execute` 执行 shell。
  3. **硬拒绝地板在 `argv` 调用形态下失效**（P1）——`checkHardDeny` 只读 `params.command`，`argv:["diskpart"]`、`["cmd","/c","shutdown","/s"]` 在 full 档直接放行，违反 `policy.ts:30-31` 的明示承诺。
- 历史 35 条中本轮复核 9 条：4 条已修（BUG-004/005/008/009）、2 条仍在（BUG-007/025）、1 条部分（BUG-021/022）、2 条另计（BUG-024 见第五节、BUG-006 见第四节第 4 条）。**问题没有「已清零」**。
## 三、缺陷清单

### P1 高危

#### TD-01 `search_files` 绕过统一授权与工作区边界
- 位置链：`src/host/tool-definitions.ts:140-146`（`id:'search_files'`, `approvalClass:'none'`）→ `src/host/desktop-host.ts:467-489`（宿主能力表注册，`:471` `const root = typeof params.root === 'string' ? params.root : mutableWorkspace.root`）→ `src/host/policy.ts:100`（`FILE_TOOLS` 不含 `search_files`，故 `desktop-host.ts:1557` 的 `governed=false`，`evaluatePolicy` 根本不跑）→ `src/host/authorization.ts:311-313`（`cls==='none'` 直接 `allow`）→ `src/capabilities/search-files.ts:82-87`（只校验 `root` 是非空绝对路径，无工作区校验）。
- 触发条件：任意已鉴权调用方执行 `search_files {operation:"grep", root:"C:\\Users\\<用户>\\.ssh"}`（或 `list`）。
- 实际影响：workspace 档「文件读写限于工作区内、越界硬拒绝」的承诺被绕过；`checkHardDeny` 的敏感路径正则 `~\/\.ssh\/`（`consent-router.ts:111`）匹配不到 Windows 实际路径写法，因此地板也兜不住；可枚举/检索凭据目录、浏览器配置、`%APPDATA%` 全盘可读范围。对比 `src/capabilities/file.ts:45-50`、`src/capabilities/edit-engine.ts:202-210` 均走 `workspace.resolveWithin`，仅本工具漏掉。
- 证据类型：代码级证明（静态，无需运行）。
- 修复建议：把 `search_files` 加入 `FILE_TOOLS`（或新增只读文件类集合），在 `desktop-host.ts:471` 改用 `mutableWorkspace.current?.resolveWithin(root)`，为 null 时返回 `outside-workspace`；`approvalClass` 至少改 `mode`。
- 验收判据：workspace 档下 `search_files {root:"C:\\Users\\<u>\\.ssh"}` 返回 `{ok:false, error:'outside-workspace'}` 且审计记录 outcome=policy-denied；同一调用在 `root` 缺省时仍按工作区根工作。

#### TD-02 本地 API 令牌注入外部页面，且无导航/新窗口守卫
- 位置链：`src-tauri/src/main.rs:1004-1028`（主窗口 `WebviewUrl::External(chat.deepseek.com)`，`:1021-1028` 把 `load_host_token_script()` 拼进 `initialization_script`）→ `main.rs` 的 `load_host_token_script`（读 `~/.config/deepseek-studio/config.json` 的 `token`，生成 `window.__studioHostToken = "<token>"`）→ `src/api/server.ts:364`（`/v1/*` 只校验 `Authorization: Bearer`）。
- 关键缺口：全仓 `grep 'navigation|on_page_load|new_window'` 在 `main.rs` **0 命中**，即没有 `on_navigation` / `on_new_window` 限制；`initialization_script` 会在该 webview 的**每一次**导航重新执行。
- 触发条件：用户在页面内点外链/页面脚本 `window.open` 或被诱导跳转到任意 origin；或 chat.deepseek.com 自身出现 XSS。
- 实际影响：令牌落到第三方 origin 的 JS 上下文，持令牌即可调 `/v1/tools/execute` → `shell.exec` → 以桌面用户身份执行命令。令牌长期有效（`api/auth.ts` 无过期机制，`host-token.ts` 的 TTL 只作用于内部 claims），除非手工轮换。
- 证据类型：代码级证明（注入与缺守卫均静态可查）；「外部页面实际拿到 token」这一步未做运行期验证。
- 修复建议：① `main.rs:1004` 加 `on_navigation` 白名单（仅 `https://chat.deepseek.com/**`），并用 `on_new_window` 拦截外部链接改走系统浏览器；② 注入脚本按 `location.origin` 自检，非白名单 origin 不赋值；③ 令牌改为短期、可轮换、按 origin 绑定的形式。
- 验收判据：在主窗口执行 `location.href='https://example.com'` 后，该页 `window.__studioHostToken` 为 `undefined`；且外部跳转被拦截或在系统浏览器打开。

#### TD-03 硬拒绝地板对 `argv` 形态失效（full 档可直接关机/分区）
- 位置链：`src/host/consent-router.ts:85-100`（`checkHardDeny` 只取 `params.command` 字符串，且正则全部 `^` 锚定）→ `src/capabilities/shell.ts:199-217`（`argv` 优先于 `command`，`argv` 形态不经过 `hasShellSyntax`）→ `src/host/authorization.ts:234-236`（`hardRule` 即上述结果）→ `src/host/policy.ts:306-311`（full 档放行）。
- 触发条件：`shell.exec {argv:["diskpart"]}`、`{argv:["shutdown","/s","/t","0"]}`、`{argv:["cmd","/c","shutdown","/s"]}`；或 command 形态写 `cmd /c shutdown /s`（不匹配 `^shutdown`）。
- 实际影响：`policy.ts:30-31` 与 `consent-router.ts:82` 明确写「hard-deny（磁盘格式化/关机）即便 full 档也直接拒绝」，实现与承诺不一致；full 档下模型可无审批触发关机或分区工具。auto 档仍会因风险正则命中而要求审批，故实际危险面集中在 full 档与「用户点了本次对话始终允许」后的连发。
- 证据类型：代码级证明。
- 修复建议：`checkHardDeny` 改用与 `policy.ts:194 commandText()` 同源的取文本逻辑（含 `argv` 拼接与 `params.config` 嵌套），并对 `cmd /c` 前缀做剥壳后再匹配；正则去掉 `^` 锚定改为词边界。
- 验收判据：full 档下上述三种调用均返回 `{ok:false, reason:'hard-deny'}` 且审计 `hardRule` 非空；`shell.exec {argv:["echo","hi"]}` 仍正常执行。

#### TD-04 发布（bundle）形态无法启动宿主进程
- 位置链：`src-tauri/src/main.rs:974-983`（`project_root` = 可执行文件上溯 3 级，兜底硬编码 `E:/NAS/deepseek-studio`）→ `src-tauri/src/sidecar.rs:291-299`（`Command::new("node")` + `./node_modules/tsx/dist/cli.mjs src/api/main.ts`）→ `package.json` 中 `tsx` 属 **devDependencies**；`tauri.conf.json` `bundle.active=true`、`targets:"all"`。
- 触发条件：以安装版（如 `C:\Program Files\...\deepseek-studio.exe`）启动。
- 实际影响：`project_root` 指向 `C:\Program Files`，`node_modules/tsx` 不存在；即使存在，也要求目标机 PATH 上有 `node`。结果 `spawn failed` → `FatalStartup`，宿主永久缺席（`sidecar.rs:493-500`）。开发树（`src-tauri/target/debug/*.exe` 上溯 3 级正好是仓库根）掩盖了该问题。
- 证据类型：静态推断（未在安装版实测）。
- 修复建议：把宿主打成单文件 bundle（esbuild 产物 +打包进 `resources`），用 `app.path().resource_dir()` 定位，并内置 node 运行时或改用 Tauri externalBin；删除硬编码兜底路径。
- 验收判据：干净机器安装后启动，`[studio] project_root:` 指向安装目录且 sidecar 进入 Running；验收记录里补一条安装版首启日志。
### P2 一般

#### TD-05 健康探测只看端口、不认进程，也不监测子进程提前退出
- 位置：`src-tauri/src/sidecar.rs:451-463`（循环体内只调 `probe_health()`，不 `try_wait()`）、`:76-108`（探测即 `GET /healthz`，无身份字段）、`:504-547`（仅在 Running 态才 `try_wait`）。
- 触发：子进程立即退出（如 EADDRINUSE → `exit(2)`，见 `src/api/main.ts` 端口冲突分支），或 8760 已被其它进程占用且对 `/healthz` 回 200。
- 影响：确定性失败也要白等 `STARTUP_HEALTH_TIMEOUT=60s`（`sidecar.rs:25`）；若端口被他人占用并应答，会被判为 Running，随后 `do_monitor` 才发现 child 已死，用户看到的是「起来了又崩」而不是「端口被占」。
- 证据：代码级证明。修复：循环内 `child.try_wait()` 命中即按 `SIDECAR_EXIT_PORT_CONFLICT` 分支处理；`/healthz` 增加一次性 nonce 或 pid 回传，探测校验身份。
- 验收：用一个假 HTTP 服务占住 8760 并对 `/healthz` 回 200，启动应在 <=3s 内报「端口被占用」而非进入 Running。

#### TD-06 端口可配置，但 sidecar 硬编码 8760（该配置项实际不可用）
- 位置：`src/api/config-loader.ts:112`（`port` 来自 env/`config.json`）vs `src-tauri/src/sidecar.rs:21`（`HEALTH_PORT: u16 = 8760`）、`:165`（`terminate_listener_on_port(HEALTH_PORT)`）、`:525`（报错文案还建议「change port in config.json」）。
- 影响：用户照报错建议改端口 → 健康检查永远探测 8760 → 60s 超时 → 5 轮重启 → `GaveUp`，宿主彻底起不来。文案与应用行为互相矛盾。
- 证据：代码级证明。修复：sidecar 读同一份 `config.json` 的 `port`（或由 Rust 侧解析后传给 sidecar），`HEALTH_PORT` 改为实例字段。
- 验收：`config.json` 设 `port: 8761` 后应用仍进入 Running，`/healthz` 在 8761 上可访问。

#### TD-07 端口未做数值校验（历史 BUG-007 仍在）
- 位置：`src/api/config-loader.ts:112` `Number(process.env.DEEPSEEK_STUDIO_PORT ?? stored.port ?? 8760)` 无范围/NaN 校验 → `src/api/server.ts:753` `server.listen(options.config.port, ...)`。
- 影响：`port` 写成 `"abc"` / `70000` 时 `listen` 抛错或分配到非预期端口，sidecar 探测必然失败，表现为「启动即崩」。历史上已报，当前仍在。
- 证据：代码级证明。修复：`Number.isInteger(p) && p>0 && p<65536` 才采用，否则回落 8760 并 warn。
- 验收：`DEEPSEEK_STUDIO_PORT=abc` 启动后日志有回落告警且服务在 8760。

#### TD-08 工作区外「新建文件」只做词法校验，符号链接父目录可越界
- 位置：`src/host/workspace.ts:173-188`：`statSync(abs)===undefined` 时直接 `return true`（仅词法 `lexicallyInside`），只有**已存在**的目标才 `realpath` 二次校验。
- 触发：工作区内存在指向外部的 junction/符号链接（Windows `mklink /J` 无需管理员），随后 `file.write ws\link\x.txt`（`x.txt` 尚不存在）。
- 影响：写入真实落到工作区外，绕过 `file.ts:45-50` 的边界。需要 workspace 里先存在此类链接（解压/clone/用户手工建的都可能）。
- 证据：静态推断（未实测构造链接）。修复：对不存在的目标逐级向上 `realpath` 最近的已存在祖先再比对。
- 验收：`ws\link -> D:\outside` 存在时，`file.write ws\link\x.txt` 返回 `outside-workspace`，且 `D:\outside\x.txt` 不被创建。

#### TD-09 每次重启新建 sidecar 日志文件，无清理/轮转
- 位置：`src-tauri/src/sidecar.rs:309-336`（`log_dir.join(format!("sidecar-{}.log", chrono_now_ms()))`，`create+append`）。
- 影响：崩溃-重启循环（最多 5 轮）每次都留一个文件；长期使用后 `%APPDATA%\deepseek-studio\logs` 只增不减，属「日志无限增长」方向的实际落点。
- 证据：代码级证明。修复：按大小/天数轮转，保留 N 份。
- 验收：连续 10 次启动后日志目录文件数 <= N，且最旧文件被回收。

#### TD-10 `/v1/tools/execute` 的 `params` 零校验（历史 BUG-023 仍在）
- 位置：`src/api/server.ts:432-451`（只校验 `tool` 为非空字符串、`botId/conversationId` 类型，`params` 用 `body.params ?? {}` 直接透传）；下游如 `desktop-host.ts:1554` 强转 `as Record<string, unknown>`。
- 影响：`params` 传数组/字符串时各工具按 `Record` 取值全部落空，异常路径与「参数缺失」不可区分；部分实现（如 `search_files` 的 `root`）会把畸形值当有效输入。
- 证据：代码级证明。修复：`params` 必须为普通对象（非数组），否则 400。
- 验收：`{"tool":"file.read","params":"x"}` 返回 400 `bad_request`。

#### TD-11 M5 编程工具链未接线（声明与注册不一致）
- 位置：`src/host/tool-definitions.ts`（36 个 `id` 中只有 `file.edit`，**无** `edit`/`test.run`/`debug`）vs `src/host/desktop-host.ts:460-490`（`hostTools` 无对应 key）vs 现存实现 `src/host/kernel/edit-engine.ts`、`src/host/kernel/test-runner.ts`、`src/host/kernel/task-loop.ts`。
- 影响：模型/外部调用方无法使用 M5 工具（`registry.get` 命中不了 → `unknown-capability`），相关模块是未被引用的实现；历史上「edit-engine 未接线（死代码）」的结论**当前仍成立**，只是范围扩到 test.run/debug。
- 证据：代码级证明。修复：要么在 `tool-definitions.ts` + `hostTools` 注册并补验收，要么从路线图中删除以免误导。
- 验收：`GET /v1/tools/catalog` 出现 `test.run`、`debug`，且 `POST /v1/tools/execute {tool:"test.run"}` 不再返回 `unknown-capability`。

### P3 轻微

#### TD-12 限流桶只增不删，键取 Authorization 原文
- 位置：`src/api/server.ts:190-211`（`buckets` Map 无回收）、`:611` `const tokenKey = req.headers['authorization'] ?? 'anonymous'`。
- 说明（与历史 BUG-022 的差异，需如实）：鉴权在 `:364` 先于限流，能走到 `:611` 的请求必然携带合法 token，因此「换头即换桶」在正常路径上不可利用——历史结论应从「限流形同虚设」下调为「桶键不具身份语义」。但 Map 无回收仍成立：令牌轮换期新旧 token 各一桶，长期多次轮换会累积。
- 修复/验收：桶键改用 token 的 sha1 前缀，并按 LRU/空闲 TTL 回收；压测 1 万次带不同 Bearer 的请求后 `buckets.size` 不无界增长。

#### TD-13 审计接口 `limit=` 空串被 clamp 到 1（历史 BUG-025 仍在）
- 位置：`src/api/server.ts:397-399`（`Number('') === 0` → `Math.max(1, ...)`）。
- 影响：`GET /v1/tools/audit?limit=` 只返回 1 条，与缺省 50 的语义不符，排障时误以为审计只有一条。
- 修复/验收：空串按缺省 50 处理；`?limit=` 与不带参数返回条数一致。

#### TD-14 局域网配对码非常量时间比较
- 位置：`src/api/agent-lan-access.ts:74` `if (providedCode !== expected) return …`。
- 影响：`/agent` 页面的配对码校验存在时序差异（同文件其余部分与 `auth.ts:26-31` 都刻意做了常量时间比较，此处不一致）。远程可利用性低（8 位码 + 网络抖动），但属明确不一致。
- 修复/验收：复用 `auth.ts` 的 `timingSafeEqual`；单测覆盖长度不等与等长错码。
## 四、可疑但未证实

1. **CDP 调试口默认常开**（`src-tauri/src/main.rs:921-940`）：未设 `STUDIO_DISABLE_CDP` 时默认给 WebView2 加 `--remote-debugging-port=9222/9223`。缺什么证据：需确认该端口是否接受来自非本机进程/网页（DNS rebinding）的连接、以及 DevTools 协议能否直接读取注入的 `window.__studioHostToken`。若两者任一成立，应升为 P1（等于绕过 TD-02 的导航守卫）。本轮未做运行期验证。
2. **`shell.exec` 输出上限以字符计而非字节**（`src/capabilities/shell.ts:100-105` `existing.length`/`limit`，常量名 `DEFAULT_MAX_OUTPUT_BYTES=64*1024`）：中文输出实际内存占用可达 ~3 倍。缺什么证据：实测一个 64K 字符的中文输出是否造成可观测的内存压力；未跑。
3. **流式断流结算是否仍有「双所有者」**：`src/inject/main-world-interceptor.ts:1372/1638/1953-1960` 有多处 `stream-incomplete` 与「W1 清理」注释，`src/host/engine/web-engine.ts` 为未提交改动文件。缺什么证据：逐行核对该结算路径里「谁拥有最终回答」的谓词是否唯一；本轮未读透，不下结论。
4. **孤儿防护的 PID 复用**（`src/api/main.ts:38-42`）：Windows 下 `process.ppid` 不变化，仅靠 `process.kill(ppid0,0)` 探活；PID 被系统复用时 guard 不会触发，可能留下占用 8760 的孤儿宿主。缺什么证据：需要一次「父进程被杀 + PID 复用」的实测或读取进程启动时间比对；未验证。（历史 BUG-006 的同类，代码层面仍未闭环。）

## 五、未覆盖范围与原因

- **未逐行覆盖**：`src/inject/`（42 文件 / 447KB）、`src/ui/`（67 文件 / 670KB）、`src/host/bot/`（24 文件）、`src/host/mcp-controller.ts`（34KB）、`src/host/memory/*`（约 76KB）、`src/host/engine/web-engine.ts`（38KB，且为未提交改动文件）、`src-tauri/src/main.rs` 的 bot 窗口/托盘/工作台部分（仅读了窗口创建、注入与 sidecar 装配段）。
- 原因：只读通道单次输出上限约 8KB（超出即截断），逐行通读 2.2MB 源码在本轮预算内不可行；缺陷密度高的授权链、shell 执行、sidecar、workspace 边界已优先覆盖。
- **未执行**：`npm run typecheck`、`vitest run`、任何构建、`tauri dev`。原因是任务纪律与这台机器的内存约束（近期已因提交内存耗尽黑屏），任何类型错误/测试失败都不在本报告结论内。
- 历史报告 `docs/审计报告/归档/墨鉴/` 的 BUG-001~039 中，本轮只复核了下列 9 条，其余未逐条复核（其修复状态以对应提交的验收文档为准，本报告不代为断言）：BUG-004 已修（`config-loader.ts:146-178` 读-改-写合并）、BUG-005 已修（`:82-107` `.bad` 备份且本次不写盘）、BUG-008 已修（`shell.ts:324-330` 保留 `-Command` 尾参）、BUG-009 已修（`shell.ts:283-302` 显式 `cmd /c` 也查元字符）、BUG-007 仍在（见 TD-07）、BUG-025 仍在（见 TD-13）、BUG-021/022 部分（见 TD-12）、BUG-006 未闭环（见第四节第 4 条）、BUG-024 未复核（`server.ts:769-808` 超限分支仍未 `destroy`，未细读不改判）。

## 六、修复优先级建议与验收方式

1. **立即（本周）**：TD-01、TD-02、TD-03。三条都是「安全承诺与实现不一致」，改动局部、可用单测锁定：`search_files` 越界返回 `outside-workspace`；导航到外部 origin 后 `window.__studioHostToken === undefined`；full 档 `argv:["diskpart"]` 返回 `hard-deny`。
2. **发布前必须**：TD-04、TD-06。否则安装版宿主起不来，或用户按报错文案改端口反而更起不来。验收靠一次干净机安装 + 首启日志。
3. **下个迭代**：TD-05、TD-08、TD-10、TD-11。其中 TD-11 要在「注册」与「从路线图删除」之间做决断，避免继续以未接线模块承接需求。
4. **随手修**：TD-07、TD-09、TD-12、TD-13、TD-14。
5. 建议把本报告的三条 P1 各自补一条单测/集成测试（分别落在 `tests/desktop/` 的授权链、注入层、shell 能力用例中），作为「不再回退」的判据——本轮所有 P1 都是纯函数级可测的。

---
本报告所有 `file:line` 对应 `master@630b076` 加两处未提交改动；若该校验树变化，行号需重新锚定。
**基线快照时效提醒（审计结束时实测）**：审计开始时为 `M model-engine.ts / M web-engine.ts` + 4 个未跟踪 docs 文件；写入本报告时同一仓库已变为 6 个 `M`（新增 `src/host/kernel/task-loop.ts`、`src/host/memory/candidates.ts`、`src/host/memory/core.ts`、`tests/desktop/task-loop-reply.test.ts`）+ 8 个未跟踪文件，HEAD 仍为 `630b076`。说明工作区在本次审计期间被其它会话持续修改：涉及上述文件的结论属于「取证时刻的快照」，不得直接当作当前工作区状态；复核时请先重跑第一节的基线命令，并确认 `git diff` 是否已覆盖对应行。