# v0.14.35 发版说明

发布日期：2026-11-26（tag `v0.14.35`；本版修复**上游人机验证挑战（40303 CHALLENGE_REQUIRED）被误判成「服务器暂时无法访问」——烧光重试预算后给用户错误交代**）

## 这版修了什么

### 1. 人机验证挑战被冒充成服务器故障（`be9028d`）

**现象**：真机会话撞上游人机验证挑战时，上游返回 200 外壳＋外层 `code:40303`／`msg:"CHALLENGE_REQUIRED"` 的确定性挑战体。旧分类器只看 `code/error/message`，把 `code:40303` 兜底判成「可重试」，烧掉首轮重试预算后误报「服务器暂时无法访问」——既不真实（服务没有故障，是需要过人机验证）、也不可行动（用户不知道该做什么）。

**根因**：`classifyResponse` 的 200 分支只识别额度墙（200 外壳套 `biz_code:29`），没有「200 外壳套挑战」这一格；流收口（settleStreamEnd 等）也没有挑战支，任何到达路径都会把挑战体当可重试错误继续烧重试。

**修复**（零执行逻辑改动，判定与收口两处接线）：

1. **`response-classifier.ts`**：`ResponseVerdict` 新增 `'challenge-required'`（不可重试终局）；新增 `detectChallengeRequired`（命中＝外层 `code===40303`／`msg==='CHALLENGE_REQUIRED'`／任一层有 `challenge_id`，读取层逐层下探 data→biz_data→顶层，与 `detectQuotaWall` 同口径）＋`parseChallengeFromText`（纯 JSON 体边界，与额度墙同）＋`composeChallengeMessage`（文案明示「需要完成人机验证才能继续」＋可行动路径：浏览器手动过验证后回 Studio 重发；expectedMode 缺省省略括号段）；`classifyResponse` 200 分支**额度墙之后、parseBodyError 之前**插挑战判定——额度墙优先级不变、挑战第二、两者都先于兜底错误分类；
2. **`main-world-interceptor.ts`**：四处不可重试终局消费点全部加 challenge 支（首轮 XHR 收口／settleStreamEnd／auto-continue 首轮重发／auto-continue 预算耗尽）——命中即记 `stopReason:'challenge-required'`、收尾文案含「人机验证」、不 escalate、不烧重试（经 PM 批准的同族扩格：卡面只点名 settleStreamEnd 一处，但终局语义须在任一到达路径接住，漏一处即烧重试或误报）。

上游 40303 由上游控制、真机不可按需逼出——机制层由单测＋仓外负控＋装版产物面定论，真机「文案变了没有」由出资人下轮实测兜底。

## 验证

- 全量闸 **exit=0**（GATE#132，1697.5s），vitest **342 files／3783 passed／1 skipped**；entry-freshness PASS `5C4C44A7`（重建 entry.js 487,062 B）
- CI run **45653929645**（head `be9028d`）：success
- 测试：`response-classifier.test.ts` 加 challenge 块 5 格（200+40303⇒challenge-required＋三字段逐层读出／额度墙体不被抢／既有 verdict 全回归／命中三条件与缺省形态）；新 `challenge-required-closeout.test.ts`（镜像 qd-r5 harness：不烧首轮重试＋文案含「人机验证」不含「服务器暂时无法访问」＋setBusy(false)）
- 独立窄面 8 件 **91/91**＋tsc EXIT=0（含 qd-r5／qd-r7 流收口回归 16/16）
- 仓外负控：摘 `classifyResponse` 200 分支挑战调用点 ⇒ 分类格与收口格同红（靶心命中）；还原复绿、真树双 SHA 全程未动
