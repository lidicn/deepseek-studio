# 00 · 终态词典（term-state）— 草案

- 状态：**草案**（Studio-PM 定稿；行号核对于 2026-11-02，M0）
- 测量脚本：`tools/metrics/term-state.ts`（只读日志，不改变行为）
- 首份离线分布：`logs/baseline/20261102-offline-term-state.md`（数据源 trace 254 条 turn.end / CDP 抓包 24 组 / verify-exit 提及计数）
- M1 之后将新增 `interrupted`（用户中断）；脚本对未知值自动单列为 `unknown(未收录:…)`，不崩、不吞。
  **20261102 状态**：`interrupted` 宿主侧就绪（`da31756`），但页端发送端未实现 → **当前生产不可达**，页端（M1-D 卡）上线前不得声称该终态已生效——见 `docs/验收报告/20261102-TD-修复台账.md` R3-03。

## 七终态表

| 终态 | 定义 | 唯一判定点（file:line） | 谁消费 | 误判后果 |
|---|---|---|---|---|
| `complete` | 本轮模型正常输出完毕 | `src/host/engine/model-engine.ts:20`（`CompletionStatus` 四值类型契约）；引擎生产点在 web-engine 完成检测（行号未核，定稿补）；页端等价物 `turn.end stopReason:'completed'`（trace 落盘） | task-loop 判停、`tools/metrics/live-nudge-rate.ts:79-82` 分桶、AgentLoop 面板 | 假 complete：半截回复被当完整结果交给用户/注入下一轮，任务带病继续 |
| `truncated` | 看门狗超时截断（`timedOut` 的语义化别名；页端 `continuation-truncated`/`truncated-tool-tag` 映射到此） | `src/host/engine/model-engine.ts:20` + `model-engine.ts:27-28`（`timedOut` 字段注释）；页端 trace `stopReason` | live-nudge-rate、AgentLoop 提示 | 假 truncated：真完成被标记失败 → 无谓重发整轮，烧双倍 token/时长 |
| `disconnected` | 页端不可达 / dispatch 失败 | `src/host/engine/model-engine.ts:20`（类型）；引擎生产点在 web-engine 重连路径（行号未核，定稿补） | task-loop（引擎抛错上抛）、live-nudge-rate:81 | 假 disconnected：把「页还活着但读不到」也归进来 → 用户被误导去重开页面 |
| `unknown` | 兜底（用户主动 stop 等）；脚本另把**未收录的新 stopReason** 单列为 `unknown(未收录:…)` | `src/host/engine/model-engine.ts:20`；`tools/metrics/live-nudge-rate.ts:65`（`r.completion ?? 'unknown'` 兜底读取） | live-nudge-rate、面板 | 兜底被滥用=吞掉真实原因，度量失真；未收录值混进兜底=新终态永远统计不出来 |
| `no-tool-calls` | 本轮 0 工具调用且未触发判停信号 | `src/host/kernel/task-loop.ts:33-46`（`TaskLoopStopReason` 类型）；判停优先级 `task-loop.ts:195-204`（computeStop JSDoc） | requireTaskLoopReply（`task-loop.ts:73-86`）决定其不可伪装成功 | 假 no-tool-calls：模型实际想调工具但标签解析失败 → 任务静默半途而废 |
| `empty-response` | 页端消失/传输断（走重连路径）后的空回复 | `src/host/kernel/task-loop.ts:33-46`（类型）；判停 `task-loop.ts:195-204`；失败清单 `task-loop.ts:73-86` | `/v1/agent/send` 返回体文案（F1 修复后与 read-no-data 可区分） | 与 read-no-data 混淆 → 「该重开页面」与「该再等等」给不出正确指引（F6 立项原因） |
| `max-rounds` | 跑满轮数上限 | `src/host/kernel/task-loop.ts:33-46`（类型）；判停 `task-loop.ts:195-204`；页端等价物 `max-loop` 映射到此 | requireTaskLoopReply、评测脚本 | 上限设错或提前触发 → 长任务永远到不了 complete，且被误读为模型能力问题 |

## 表外已存在的终态值（七终态视图的补充，不并入）

| 值 | 定义 | 判定点 | 备注 |
|---|---|---|---|
| `read-no-data` | 页还活着、引擎连续读不到数据（`state='empty'` 耗尽 `maxEmptyReads`，F6 语义） | `src/host/kernel/task-loop.ts:42`（union 成员）；默认 9 拍 `src/host/engine/web-engine.ts:147`（`maxEmptyReads ?? 9`，Studio-PM 核） | F6 新增；`logs/baseline` 实测引擎日志出现 `read-no-data after 9 empty reads` |
| `timeout` / `aborted` | 单轮超时 / 用户中止 | `src/host/kernel/task-loop.ts:33-46` | computeStop 优先级里 timeout 最高 |

## 误判防线（写死在测量口径里）

1. 三类证据（页端 trace / CDP 抓包布尔探测 / 引擎日志提及）**分开计数，绝不跨类合并**。
2. 未收录 stopReason **单列点名**，不许静默落进 unknown 兜底。
3. 「长流无哨兵」计数 >0 时必须附「**未观测 ≠ 不存在**」声明；首份基线实测：CDP 抓包 24 组中 1 组 23.6KB 长流无任何完成信号（FINISHED/task_complete 均无），12 组带 `quasi_status:FINISHED`。
4. 抓包扫描只输出布尔与字节数，**绝不输出响应体内容**（用户会话原文不入仓库，见 `tools/audit/private-leak.ts` 守卫）。

## 消费关系（M1 接线时用）

- 判停优先级（写死，`task-loop.ts:195-204`）：`timeout > completed > read-no-data/empty-response > no-tool-calls`。
- 引擎 `EngineSendResult.completion`（`model-engine.ts:47`）是四值自证；task-loop 的五值+ 判停是任务层语义，两层靠 `computeStop` 的 `engineReason` 第四参衔接（F6 引入）。
- `interrupted`（M1）落点预留在 `TERM_MAP`（`tools/metrics/term-state.ts`），加一行映射 + 一行测试即可。
