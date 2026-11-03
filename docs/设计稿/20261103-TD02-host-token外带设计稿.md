# TD-02 设计稿：host token 不再注入外部页面（out-of-band 信使）

- 日期：2026-11-03
- 作者：Core
- 状态：**设计稿（不动代码，待 Studio-PM 审后拆施工卡）**
- 核实依据：`src-tauri/src/main.rs:491-519`（`load_host_token_script` → 注入 `window.__studioHostToken`）、`main.rs:835/1216`（主窗与 bot 窗都注入）、`src/desktop/entry.ts:137-143`（读它拼 `?token=`）、`src/host/page-runtime.ts:222` 与 `src/host/agent-channel.ts:219`（WS upgrade 校验 `?token=`）、`src/host/host-token.ts`（HMAC 令牌基座）、`src/host/authority.ts`（带 exp+一次性+scope 的 grant 体系）
- 现状结论：**未修**。`on_navigation` 在 `src/**` 命中 0；token 明文注入到**任何**加载 `entry.js` 的页面，包括 `chat.deepseek.com` 这类**外部站点**。

---

## 1. token 护着什么 / 危害链（先写实）

### 这个 token 是什么
`config.token`（`~/.config/deepseek-studio/config.json`），由 host 首启随机生成。它同时是：
- **页面连宿主 WS 的入场券**：`/studio`（page-runtime）与 `/agent-ws`（agent-channel）的 upgrade 校验 `?token=`（`page-runtime.ts:222` / `agent-channel.ts:219`，走 `verifyWsQueryToken` 常数时间比对）；
- 与 server.ts 的 Bearer（`server.ts:154` 注释：与 `__studioHostToken` **同一份**）同源。

### 页面拿到它能干什么（危害链）
外部站点（chat.deepseek.com 由第三方控制）的**任意脚本**都能读 `window.__studioHostToken`，于是它/它加载的第三方 SDK/被注入的内容/XSS 都能：

1. **裸连宿主 WS**：`ws://127.0.0.1:8760/studio?token=<偷到的>` → 通过 upgrade → 之后发 `tool-call` 报文就能**驱使宿主执行工具**（`page-runtime.ts:521+` `tool-call` 分支直接 `options.onToolCall` → executor）。
2. 工具执行需过 consent 闸门，但 **R2-01 未修时，它可以自己伪造 `consent-decision` 自答**（两缺陷叠加 = 外部站点可无人工确认地跑工具）。
3. 即便 R2-01 修好，它仍能**制造大量 consent 弹窗骚扰**、读取 `/agent` 页面、探测宿主存在性、用 `/v1/*` 需要 Bearer 的端点（同一 token → 直接 Bearer 通过 → `tools/execute`）。

**结论**：token = 宿主的全权凭据。把它注入外部站点页面，等于把后端钥匙交给第三方页面。**必须让 token 不出宿主进程。**

---

## 2. out-of-band 信使方案

### 核心原则
`config.token` **永不进入页面**。页面改用宿主签发的**短期、单次、限权**凭据（grant）向宿主取数据/连通道。

### 现有可复用基座（关键，改造面因此变小）
`src/host/host-token.ts` 的 `createHostTokenAuthority` 已支持：
- `sign(claims)` / `verify(token)`：HMAC-SHA256 + `exp` 过期校验（`:sign`/`:verify`）。
- `signRaw` / `verifyRaw`：对任意消息签名（两段式"数据+签名"）。
- `SecretRing`：密钥轮换 + 宽限期。

`src/host/authority.ts` 的 `createToolAuthority` 已支持：
- `issueGrant(input)` / `verifyGrant` / `consumeGrant`：**一次性消费** + `exp` + `scope` + `grantId`，`reason` 区分 `expired`/`consumed`/`scope-mismatch`。

→ **不需要发明新密码学，只需把这套 grant 接到"页面连 WS / 取数据"这一层，替代明文 token。**

### 协议（具体：怎么签、怎么传、怎么验、怎么过期）

1. **签发（宿主，页面不可见）**
   宿主在**建页面之前**（`main.rs` 注入脚本时）生成一个 **bootstrap grant**：
   ```
   grant = authority.issueGrant({
     scope: 'ws-connect',            // 限权：只能建 WS 连接，不含工具执行权
     audience: 'main'|'bot:<id>',    // 绑定具体窗口
     ttl: 60_000,                     // 短期：60s
     singleUse: true,                 // 一次性
   })
   ```
   host 侧需要把 `authority` 暴露给 tauri 侧签 grant（或 tauri 侧直接用同一 secret 签——需共享 secret，见 §4 触点）。

2. **怎么传（out-of-band 的最小可行）**
   **难点**：页面必须拿到"某个东西"才能连 WS，而"传进去"这一步天然可能被页面读到。
   本方案接受一个**受控的事实**：**传进去的是 grant（60s、一次性、仅 ws-connect 权），不是长期 token**。危害从"永久全权钥匙"降级为"一次连接权、60s 内、用完即废、且绑 audience（别的窗口偷去也用不了）"。
   - 传输：**沿用现有注入通道**（`window.__studioGrant = grant`），但内容不是 token。
   - **可选加固（若 PM 要求更强）**：不走 `window.*`，改由 tauri 用 **WebView2 的 `AddScriptToExecuteOnDocumentCreated` 之外的带外 IPC**——但 WebView2 页内 JS 与注入脚本同 origin，**任何注入方式页内都能读**。所以"完全不进页面内存"在 WebView2 模型下做不到，只能做**限权 + 短时效 + 一次性**。

3. **怎么验（宿主，WS upgrade 时）**
   `page-runtime.ts:222` / `agent-channel.ts:219` 的 `verifyWsQueryToken(url.searchParams.get('token'), ...)` **改为** `authority.verifyGrant(raw).ok && authority.consumeGrant(raw).ok`（一次性消费）：
   - 验签 + `exp` + `scope==='ws-connect'` + `audience` 与连接声明的 botId 匹配；
   - **消费后即废**：同一 grant 第二次 upgrade 拒绝（`reason:'consumed'`）。
   - 连接建立后，**WS 会话内存态**（服务端 socket 绑定），后续报文不依赖 token。
   - **工具执行权**单独用 `authority` 的 tool-grant（现有机制），**不在 WS 连接层**。

4. **怎么过期**
   - grant `ttl=60s`（页面必须在 60s 内连上，连不上就重新要——通常建窗即连，远小于 60s）；
   - 一次性：连上即 consume；
   - 密钥轮换：沿用 `SecretRing`，旧 grant 宽限期（默认 10min）内仍验得过。

**净收益**：外部站点即使偷到 `__studioGrant`，得到的也只是"一个 60s 内、只能建一次 WS 连接、绑该 audience 的券"，而**不是**能直接 Bearer 打 `/v1/*` 的 `config.token`。**工具执行仍需 R2-01 的用户手势**。两缺陷叠加的致命链被切断。

---

## 3. 可行性第一：`entry.ts:138-140` 读取后到底用在哪（全部消费点）

已核实**全仓 `__studioHostToken` 的消费点只有一处**：
- `src/desktop/entry.ts:140` 读 → `:141-143` 拼 `hostUrl = ${DEFAULT_HOST_URL}?token=<token>` → 传给 `createHostClient({ url: hostUrl, ... })`。
- 之后 token 只活在 **WS URL query** 里，服务端（`page-runtime.ts:222`）校验。

**没有第二处消费**（`src/ui/agent-panel.ts:178`、`src/ui/studio-chat-room.ts:190` 是**另一个 token**：`config.token` 用于本地 UI 连 agent-ws，**不是**注入到外部页的 `__studioHostToken`——需在施工时区分，别误改）。

→ **改造面很小**：注入内容从 `config.token` 换成 `bootstrap grant`；`entry.ts:140` 换个全局变量名读 grant；服务端校验改 `verifyGrant`。**真正的成本在"host 与 tauri 共享签发 secret"这一跨域桥。**

---

## 4. 跨域触点清单

### `src-tauri/**`（Core，但需与 UI 协作确认注入通道）
- `main.rs:load_host_token_script`：改为 `load_host_grant_script`——注入 **grant**（调用签发逻辑 / 或注入一个"向宿主本地 IPC 要 grant"的桥），不再注入 `config.token`。
- `main.rs:835/1216`：主窗与 bot 窗都改为注入 grant；bot 窗 audience 绑各自 botId。

### `src/host/**`（Core）
- `host-token.ts`：无需新密码学，直接用 `createHostTokenAuthority` + `authority` 的 grant store；新增 `issueBootstrapGrant(audience)`。
- `page-runtime.ts:222` / `agent-channel.ts:219`：`verifyWsQueryToken` → `verifyGrant`+`consumeGrant`（一次性、scope、audience）。
- 审计：连接层记录 `grantConsumed`（区分"新连接/重放被拒"）。

### `src/desktop/**` / `src/inject/**`（UI）
- `entry.ts:138-143`：读 `__studioGrant` 替代 `__studioHostToken`；`hostUrl` 拼 `?grant=`（或沿用 `?token=` 键名但值是 grant，减少服务端兼容改动）。
- 注入脚本安装的 `window.*` 全局改名。

### 共享
- **host(ts) 与 tauri(rust) 共享签发 secret**：这是唯一的技术难点。两条路：
  1. **ts host 签发**，tauri 通过本地 IPC/HTTP 向 host 要 grant 后注入（host 必须有"签发 bootstrap grant"的本地端点，仅 loopback）；
  2. **tauri 用同一 `config.secret` 自签**（对称 HMAC，两处都能签）——**要求 secret 也已交给 tauri**（目前 `load_host_token_script` 已能读 config.json，secret 也在里面 → 路 2 可行，改造最小）。
  - **推荐路 2**：`config.json` 里本就有 `secret`，tauri 侧用同一 secret 按 `host-token.ts` 的 `base64url(claims).hmac` 格式签 grant，host 侧 `verifyGrant` 验。**但 grant 的"一次性消费"状态在 host 侧内存 store——tauri 自签后 host 必须登记该 grantId 才能 consume**。→ 更稳的是**路 1**（host 签，天然有 store）。

### dev(tsx) 兼容
- 纯 Node host（无 tauri）：没有 `load_host_token_script`，页面怎么拿 grant？dev 下页由 tauri dev 起仍走同一注入路径（`cfg!(debug_assertions)` 分支在 `main.rs`），**grant 注入照常**；只有"无 tauri 的纯 web 调试"才需要别的取 token 方式——**现状 dev 也允许无 token 起宿主**（`entry.ts:142` 读不到就裸 URL），此回退保留：**dev 无 grant 时允许裸连（仅 loopback、仅开发），生产强制 grant**。

---

## 5. 测试与负控

### 必测负控
1. **偷 token 打 /v1 不再成立**：因为页面里没有 `config.token` 了——测试断言"注入脚本内容不含 `config.token` 原值"（grep 注入字串）。
2. **grant 一次性**：同一 grant 两次 WS upgrade → 第二次 `reason:'consumed'` 拒。
3. **grant 过期**：把 ttl 设为极小（或注入 now），过期后 upgrade 拒 `expired`。
4. **scope 限权**：用 ws-connect grant 直接打需要工具权的路径 → 拒。
5. **audience 绑定**：bot A 的 grant 拿去连 bot B → 拒。
6. **主负控（本卡核心）**：把修法撤掉（回到注入 `config.token`、`verifyWsQueryToken` 验原文）→ 用例 1（注入内容含 token）必红。

### 测试落点
- grant 的签/验/consume/exp/scope/audience → `src/host/**` 纯单测（`authority` 已有 store 可注入时钟）。
- "注入脚本不含 token 原值" → 可直接测 `load_host_grant_script()` 的输出串（rust 单测或读注入脚本的 ts 单测）。
- 真机 end-to-end（页面能否正常连 WS）→ 归 Verify。

---

## 6. 默认取值 + 回退口径

| 项 | 默认 | 回退 |
|---|---|---|
| grant TTL | 60s | 可配；生产上限建议 120s |
| 一次性 | 是（consume on upgrade） | 若遇重连抖动，允许"每连接一条新 grant"而非复用 |
| 签发方 | **host(ts) 签发**（路 1，有 store 支持 consume） | 路 2（tauri 自签）只在 host store 可登记时用 |
| dev 无 tauri | 允许裸连（loopback，仅 debug） | 生产**强制** grant，无 grant 即拒 |
| 密钥轮换 | `SecretRing` 默认 10min 宽限 | 同现网口径 |
| 失败 | 任何验不过 → **拒连**（fail-closed），绝不放行裸连（生产） | — |

---

## 7. 给 PM 的裁决点

1. **签发方路线**：推荐**路 1（ts host 签发 + 本地端点/IPC 交给 tauri 注入）**，因为 grant 的"一次性消费"状态必须在 host 内存 store，ts host 签最顺。若你要求 tauri 自签（路 2），要额外解决"host 登记 grantId"的同步。
2. **"注入面无法做到零读取"**：WebView2 模型下，注入的任何值页内 JS 都读得到。本方案把危害从"永久 token"降到"60s 一次性 ws-connect 券"。**若你要求"页面完全拿不到任何凭据"**，那需要换架构（页面不直连 WS，全部经 host 注入的受信桥代发）——工作量大得多，需另评估。
3. **是否同时收紧 `/v1/*` 的 Bearer**：目前 Bearer 与 `config.token` 同源；token 不进页面后，Bearer 也应改用 grant 类凭据（但 `/v1/*` 是 loopback 本机调用，风险面小于注入外部页，可作 P3 另议）。
