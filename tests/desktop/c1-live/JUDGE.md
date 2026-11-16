<!-- 历史快照：内引路径/行号为 2026-11-16 当时状态，不作活锚 -->
# 卡㉘ 三项真机取证：口径与探针操作（UI 落地稿，判据照抄未改）

本件只做**取证操作化**（探针＋判读命令），三项判据全部照抄既有出处，未改任何验收口径：
- C1 判据＝路线图 `docs/项目总路线图.md` L366 现引清单（full 档文案／always＋hard-deny 弹窗／memory 面板四操作／msel 复验）＋ `docs/C1-真机人工清单-20261028.md` 的阶段 1–5 结构（其中「4.1 reload」一步已过时：C1-F1 起 flag 是动态 getter，**无需 reload**）。
- msel 预算 120ms＝注入层 `src/inject/main-world-interceptor.ts` L307 `MEM_SELECT_WAIT_BUDGET_MS`（注释「不许调大」照抄）。
- 熔断阈值＝`src/shared/continuation-prompt.ts` `TERMINAL_FUSE_THRESHOLD=3`（终局轴）／`NON_TERMINAL_FUSE_THRESHOLD=5`（通用轴，两轴不许合并成一个 N，注释口径照抄）。

## §0 红线（本轮与实跑期）
- 本轮（落地轮）：不建实例、不动装版、不跑全量闸。装版 PID 30676（18:22:59 起，非本席位所起）让位。
- 实跑期：0.14.24 装版＋30 分钟合并窗，需出资人点头；起实例前报 tag+exe、起来补 appPid、收工报「进程 0／8760 free／webview 归零」。
- 证据面纪律：截图（`shot`）只作辅助；主证据＝CDP DOM/innerText 片段＋trace jsonl 行原文＋sidecar log 行原文；每条文件面读数带**根＋mtime＋行数**。

## §1 证据通道分型（关键：两件半不依赖 CDP）
| 通道 | 依赖 | 覆盖 |
|---|---|---|
| CDP 页端（`cdp.mjs`） | 实例调试端口（dev 9222 缺省开；装版 release 可能不开，先 `targets` 探） | flag 置位、发消息、审批弹窗 DOM/文案、console 抓取 |
| 文件面（`trace-read.mjs`） | 无 CDP 依赖 | msel 耗时行、fuse 行、turn 闭合、全量导出 |
| sidecar log grep | 无 CDP 依赖 | `auto-continue fuse <axis> tool= code= count=` 行（trace 行只有 axis+count，tool/code 全在此行） |
| storage.json 事件流 | 无 CDP 依赖 | 拒绝枚数与 `terminate:true` 字段（字段名 `toolName`／事件型 `tool-start`／`tool-result`，按 `name`/`tool` 滤＝无效取证，本仓栽过） |

装版 CDP 不可达时：第 2、3 件仍可在文件面取证；flag 置位需出资人 devtools 手贴一行（报 PM 决策点），`send` 改手动点击，窗口时间戳由 PM 记录代锚。

## §2 第 1 件 C1（M8 唯一剩项）
步骤→探针映射（窗口内顺序执行）：
1. **full 档文案/弹窗**：`dom "<审批弹窗容器选择器>"` 取按钮 innerText（预期「允许本次/允许本会话/拒绝」自然语言）＋ `grep-dom "<弹窗选择器> /chat-send|policy\.set/"` 预期 0 命中（协议名不进 UI，C1 清单 1.3/1.4 口径）。
2. **always/hard-deny 观察**（清单 1.5/1.6）：切档后各触发一次；取证＝`trace-read turns`（hard-deny 轮的 trace 行含 hard-deny）＋sidecar log grep `hard-deny`；预期 hard-deny **直接拒无弹窗**（弹窗 DOM 应取不到）。
3. **记忆面板 delete/archive/unarchive/purge**（清单 2.1–2.4）：`dom` 取列表条目数前后差＋操作后列表 diff；DB 旁证＝副本法读 `memories.db`（报根＋mtime＋行数）。
4. **msel 复验**＝第 2 件（共用同窗）。
5. **多轮闭合**（清单 5.1/5.2）：`trace-read turns --since <窗口起>`，判读＝全部 `turn.end` 终态∈已知集合（completed/terminate/fuse-*/user-aborted），无 stream-error 等异常终态。

## §3 第 2 件 msel in-turn 耗时（M10 唯一剩项）
1. `node cdp.mjs flag-on`（动态 getter，无需 reload；跑完 `flag-off` 复原，C1 清单登记口径「页面 flag 已复原」照做）。
2. `node cdp.mjs send "<带上下文的长消息>"`（记 `sent-at` 时刻）。
3. `node trace-read.mjs msel --root <宿主cwd根> --since <sent-at-5min>`：逐行 `durationMs` vs 120ms。
   - **PASS**＝行存在且 `durationMs < 120` 且 `ok=true`；判据＝路线图 L694「in-turn < 120ms 或明确结论」。
   - **FAIL（超预算）**＝报实测值＋「本轮回落上一帧记忆」影响面，根因归 Core 另卡，本席位不查因。
   - 预热行（打字停顿触发）与发送点行按 `at` 距 `sent-at` 近远区分，逐行判读不混。
   - 历史读数对照（C1-F2）：修复前 554/1203ms、F1 修复后 20/9ms——本次是关账读数。

## §4 第 3 件 连拒 ≥3 熔断（终局轴实机验收）
触发配方（同 user turn 内同一 `(tool, 终局码)` ≥3 枚，模型行为不完全可控，按 R1→R2 顺序试）：
- **R1 记忆硬闸**：发**不含**记忆指令词（`记住/记一下/别忘了/存一下…`，词表见 `src/shared/memory-write-gate.ts` L27-46）的任务型消息，诱导模型自行存任务快照 ⇒ 预期拒绝码 `memory-save-task-snapshot`（无条件拒）或 `memory-save-needs-explicit-instruction`。
- **R2 hard-deny**：诱导 agent 执行策略 hard-deny 类命令 ⇒ 预期 `hard-deny`（终局码表 L153）。
三重证据（全齐才算 FUSE-FIRED）：
1. trace：`continuation.decision reason=fuse-terminal count≥3` ＋ 同 turnId `turn.end stopReason=fuse-terminal`（`trace-read fuse` 一次给全，含 consistent 判读）；
2. sidecar log：`auto-continue fuse terminal tool=<t> code=<c> count=<n>`（tool/code 唯一出处）；
3. storage.json 事件流：同 turn ≥3 枚该 tool 的 `tool-result` 拒，`terminate:true` 同级字段在（AGENTS 拒绝即止损条）。
边界与负读数：
- **不可合成注入**：宿主回执有 QD-R2-03 owner 绑定（callId 只认宿主自己那条连接），伪造拒绝枚数会被丢弃——只能真触发，不造假。
- **NO-FUSE-IN-WINDOW 是有效读数**（模型没重试到 3 枚＝场景未命中）：换 R2 再试一次，仍无＝报「场景未触发」而非熔断缺陷，不许把场景缺失判成行为缺陷。
- **预算保护**：观察 `MAX_LOOP=25` 逼近即中止场景（135 枚刷屏是历史事故形态，熔断在正就是防它；熔断不响时不硬看它烧满）。

## §5 探针速查
```
node tests/desktop/c1-live/cdp.mjs targets [--port 9222]
node tests/desktop/c1-live/cdp.mjs flag-on|flag-off|send "<text>"|dom "<sel>"|grep-dom "<sel> /re/"|console-tap "<pat>" [--secs N]|shot <out.png>
node tests/desktop/c1-live/trace-read.mjs locate|msel|fuse|turns|export [--root <dir>|--auto] [--since X] [--until Y]
```
离线自检（无实例可跑，CI 常绿）：`npx vitest run tests/desktop/c1-live/c1-live.test.ts`。

## §6 交卷形态（实跑后）
三项各一节：判读原文行（trace/sidecar/事件流逐行）＋CDP DOM 片段＋`sent-at`/窗口锚＋flag 已复原登记＋无法执行项按 C1 清单约定写 `# 项号：无法执行 —— 原因`。指纹按总行/非空行双口径＋断形态 hex。
