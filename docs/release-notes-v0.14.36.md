# v0.14.36 发版说明

发布日期：2026-11-26（tag `v0.14.36`；本版修复**登录态失效（token 40003）被误判——boot-check 只看 cookie 数量就报「用户存在」，实际 token 已失效；且会话失效时没有任何明确提示，烧完重试后只给一句含糊的「服务器暂时无法访问」**）

## 这版修了什么

### 1. 登录态失效误判＋无明确提示（`40fbb73`）

**现象**：安装版启动自检（boot-check）只看 cookie 数量就报「user=存在」，但服务端 `users/current` 实际返 `40003 invalid token`——登录态已失效却被报成「存在」；用户继续发消息时，会话收到 40003 体后被判成「可重试」，烧掉首轮重试预算后误报「服务器暂时无法访问」，用户不知道该重登、也看不到任何行动路径。

**修复**（判定层＋抓取层＋收口层三处接线，零执行逻辑改动）：

1. **`response-classifier.ts`**：`ResponseVerdict` 新增 `'auth-invalid'`（不可重试终局——重发同一失效 token 必再撞）；新增纯函数 `parseAuthInvalidFromText`（命中＝body `code===40003` 或 msg 含 invalid token／Authorization Failed，与额度墙／挑战同口径）＋`composeAuthInvalidMessage`（明示「登录态已失效（服务端返回 invalid token），请重新登录；若重登要求验证码，请按页面提示完成 MFA 验证」）；`classifyResponse` 200 分支判定序＝**额度墙→challenge（40303 优先级不变）→auth-invalid（40003）→parseBodyError**——失效体不再被兜底判成可重试；
2. **`main-world-interceptor.ts` boot-check 判据纠正**：`users/current` 的 XHR `loadend` 抓 body，`code===40003` ⇒ 记 `[auth] token-invalid code=40003`（码透传供诊断，纠正「user=存在」误报）＋`authInvalidAnnounced` 一次安装期只提示一次（幂等，对齐 fuseStoppedTurns 写法）。boot-check 本体（cookie 正则）未动——正常登录态行为一字不变；
3. **流收口接终端（四处，与补⑩同族）**：first-attempt XHR 收口／settleStreamEnd／auto-continue 首轮重发／auto-continue budgetExhausted 四处终端消费点全部接住 `auth-invalid`——记 trace、`appendError('auth-invalid', 文案)`、不烧重试。

**选型**（经 PM 批准）：新 verdict `auth-invalid` 而非并入 fatal——40003 是可行动终局（重登＋MFA 可解），与 generic fatal 语义不同，独立 verdict 才挂得住专属 MFA 文案；既有 fatal 路径不变、40303 挑战优先级不变、`TERMINAL_FAILURE_CODES`（工具熔断轴）未动。

## 验证

- 全量闸 **exit=0**（GATE#134，1838.1s），vitest **342 files／3791 passed／1 skipped**；entry-freshness PASS `8DD7F127`（重建 entry.js 489,222 B）
- CI run **45843293874**（head `40fbb73`）：success
- 测试：`response-classifier.test.ts` 加 auth-invalid 5 格（40003⇒auth-invalid／code:0 仍 ok／challenge(40303)>auth-invalid(40003)＞额度墙最前／命中两形态／文案含「重新登录」＋MFA、不含「服务器暂时无法访问」）；`challenge-required-closeout.test.ts` 加 3 格（users/current 40003⇒diag token-invalid 带码＋appendError auth-invalid 含 MFA／code:0 不误报／两枚 40003 提示只出一条幂等）
- 独立窄面 8 件 **99/99**＋tsc EXIT=0
- 仓外负控：摘 auth loadend 40003 识别分支 ⇒ ①③ 格同红（靶心命中）；还原复绿、真树 SHA 全程未动

真机「失效提示」格依赖 token 真失效（上游控制、不可按需逼出）——机制层由单测＋负控＋产物面定论，真机文案格由出资人下轮实测兜底。
