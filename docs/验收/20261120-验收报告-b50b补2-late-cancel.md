<!-- 历史快照：内引路径/行号为当时状态，不作活锚 -->
<!-- 批次：卡 ㊿-b-补2（late-cancel 语义：完成表短 TTL＋cancelled-late 追加回执）delta 复验 -->
<!-- 验收席：Verify（独立验收；实现者自测结论未采信，全部自复现） -->
<!-- 基线：HEAD c92caa4；dirty 2＝page-runtime.ts（56,035 B／c553e06e254c57d3）＋search-files-budget-cancel.test.ts（15,174 B／2a745467239d7329） -->
<!-- 现场：dev 窗 pid 24452（2026-11-20 13:41:11 起，吃 PM 重建 main.mjs 826,848 B／freshness 7F69848E0E91C62E）；装版窗 24392 只读 -->

# 卡 ㊿-b-补2 late-cancel delta 复验报告（2026-11-20）

## 0. 判语

**通过**。三态全可判、零静默、原回执不被追改——四条格真机全绿；非护栏回归（正常 ok:true 回执）未受影响；既有三枚码（`duplicate-tool-signature:`／`concurrent-mutation-blocked`／`tool-call-timeout`）未动（窄面 93 枚含其锁全绿）。无新发现问题。

## 1. 前提：锚与产物

- 两枚源件独立现算全等 Core 交卷值：`page-runtime.ts` 56,035 B／blob16 `c553e06e254c57d3`、测试件 15,174 B／`2a745467239d7329`；dirty 恰 2 枚。
- 真宿主 bundle＝PM 闸前重建件 main.mjs 826,848 B（host-freshness `7F69848E0E91C62E`），起窗时现读同值。

## 2. 真机四格（dev 宿主 8761，WS `/studio?token=` 直接驱动；取证件 `logs/verify-b50bp2-cancel.json`）

| 格 | 驱动 | 期望（PM 核准口径） | 实测 |
| --- | --- | --- | --- |
| ① 在途 cancel | `E:/NAS` 全树 list（15s 软预算在跑），1s 时发 `tool-cancel` | 恰 1 枚 `{ok:false, error:'cancelled'}` | ✓（1 枚，无第二枚） |
| ② 完成后 late cancel | 小目录 list（~14ms 收口），3s 后（ok:true 已发）再撤 | 先 `ok:true` 原回执、**再追加** `cancelled-late` 一枚且带「已执行完成」正文；原回执不被改写 | ✓（两枚同 callId，序 ok:true→cancelled-late；late 枚正文含「已执行完成」） |
| ③ 未知 callId 同连接 cancel | 从未发过 tool-call 的 callId 直接撤 | 裸 `cancelled-late`（非静默、页端 pending 不悬挂） | ✓（恰 1 枚 cancelled-late，无「已跑完」正文） |
| ④ 跨连接撤销 | 第二枚 WS 连接撤第一连接拥有的 callId | 静默忽略（不得给对方发回执） | ✓（撤后两连接 0 枚新回执） |

## 3. 独立窄面与负控

- `npx tsc --noEmit` EXIT=0；`npx vitest run search-files-budget-cancel page-runtime tool-bridge turn-serial-guard turn-guard-audit turn-serial-dispatch host-client` ⇒ **13 files／93 passed，EXIT=0**（我独立重跑，非引用 Core 数）。
- 负控（**我自行**起副本树 `E:\NAS\negctl-b50b2c-verify`，完整 src/tests/tools＋node_modules junction；相对导入 `./page-runtime`（desktop-host L31）保证变异件必在测试路径上——Core 首轮伪负控的坑我用完整树绕开）：
  - 变异：完成表登记行（`completedToolCalls.set(msg.callId, …)`，全树恰 1 枚）前加 `if (false)`（副本 56,046 B）⇒ `search-files-budget-cancel` **1 failed／13 passed**，红在格②「完成后 cancel ⇒ 追加 cancelled-late 带正文」——登记摘除即正文丢失，靶心正中。
  - 两道证：真树 `page-runtime.ts` SHA 审计前后＝交卷 blob（56,035 B／`c553e06e254c57d3`）；退出码与输出同读（EXIT=1＋1 failed 原文）。

## 4. 收工四项（2026-11-20 13:5x 现算）

① exe 进程数＝1（装版 24392；dev 24452 已退）；② 命令行含 `host\main.mjs` 宿主 node＝1（装版 11924；dev 7364 随孤儿防护自退）；③ 8761＝False、9222＝False、8760＝True（装版在跑）；④ sidecar 根 mtime：dev＝13:41:20（收窗后零新写）／装版＝10:38:57（未动）。

## 5. 验收席自认（本批）

1. 驱动脚本结尾漏关第二连接 ws2 ⇒ node 进程不退出、后台 job 挂满 150s 被 kill（**执行与证据本身完整**，JSON 已落 11,581 B；判定不受影响，纯属脚本收口漏笔）；
2. 首轮 WS 探针先证 hello-ack 正常（`?token=` 真宿主可连、config token 仍在接受环内），排除了「挂死＝鉴权问题」的误判方向。
