# 终态分布（离线测量，只读不改）

- 生成：2026-11-02T11:50:09.719Z　脚本：tools/metrics/term-state.ts
- 输入：E:\NAS\deepseek-studio\logs\trace , E:\NAS\deepseek-studio\logs\cdp-chat-capture , E:\NAS\deepseek-studio\logs\verify-exit（扫描 540 个文件）
- 退出码语义：0=≥1 条终态证据被分桶；1=输入存在但 0 条终态证据；2=输入路径全部不可读

## A. 页端 trace turn.end 七终态视图（映射表见 TERM_MAP）

turn.end 事件总数：307

| 七终态（映射后） | 条数 | 占比 |
|---|---|---|
| complete | 247 | 80.5% |
| truncated | 26 | 8.5% |
| max-rounds | 19 | 6.2% |
| unknown | 12 | 3.9% |
| unknown(未收录:user-aborted) | 2 | 0.7% |
| unknown(未收录:(缺 stopReason)) | 1 | 0.3% |

原始值明细：
- `completed` × 247 → complete
- `max-loop` × 19 → max-rounds
- `continuation-truncated` × 14 → truncated
- `protocol-repair-failed` × 12 → unknown
- `truncated-tool-tag` × 12 → truncated
- `user-aborted` × 2 → **未收录→unknown 单列**
- `(缺 stopReason)` × 1 → **未收录→unknown 单列**

## C. CDP 抓包信号（按请求分组，只探测布尔与字节数，不外泄内容）

| 分类 | 请求数 |
|---|---|
| finished-signal | 12 |
| long-stream-no-sentinel | 1 |
| short-body-no-sentinel | 11 |

明细：
- 25964.121：status=200 body=2217B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 25964.127：status=200 body=406B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 25964.128：status=200 body=2541B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 31296.121：status=200 body=1114B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 34312.120：status=200 body=1410B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 34312.126：status=200 body=406B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 34312.127：status=200 body=3141B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 34312.128：status=200 body=406B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 34312.129：status=200 body=3977B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 34432.1116：status=200 body=406B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 34432.1123：status=200 body=1068B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 34432.1127：status=200 body=406B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 34432.1134：status=200 body=407B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 34740.122：status=200 body=2554B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 34740.128：status=200 body=406B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 34740.129：status=200 body=2065B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 34740.130：status=200 body=23611B agent=N task_complete=N FINISHED=N [DONE]=N → long-stream-no-sentinel
- 34740.133：status=200 body=406B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 34860.377：status=200 body=1040B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 704.1349：status=200 body=2572B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 704.1356：status=422 body=27B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 704.1610：status=200 body=407B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel
- 704.1611：status=200 body=2490B agent=Y task_complete=N FINISHED=Y [DONE]=N → finished-signal
- 704.1623：status=422 body=27B agent=N task_complete=N FINISHED=N [DONE]=N → short-body-no-sentinel

## D. 引擎日志终态提及（verify-exit 等，模式各自计数、不做跨模式去重）

| 模式 | 命中次数 |
|---|---|
| engine.completion= | 132 |
| log.reason= | 6 |
| API返回体(empty-response) | 1 |

## E. 频率口径（M3：每任务请求表面积；轮数 = turn.end 数 ≈ 请求数下界）

### E1. 每任务请求数分布（分组键 turnId = 一次用户消息触发的全部请求）

| 指标 | 值 |
|---|---|
| 任务数（distinct turnId） | 265 |
| turn.end 事件总数 | 307（无 turnId 单列 4，不计任务） |
| 请求数 P50 / P90 / max | 1 / 2 / 6 |
| 请求数 >10 的任务 | 0（占比 0.0%） |

### E2. 同任务相邻请求间隔（ms）

| 指标 | 值 |
|---|---|
| 会话内间隔样本数（≤30min） | 38 |
| 跨时段间隔对（>30min，剔出连发统计） | 0 |
| 异常对（缺 ts / 倒挂，单列） | 0 |
| 会话内 P50 / P90 (ms) | 47459 / 102692 |
| 会话内最小 / 最大 (ms) | 3 / 143996 |
| ≤5000ms 的「快速重发对」（占会话内间隔） | 9（23.7%） |

### E3. 重试占比（可测口径：截断重发）

| 指标 | 值 |
|---|---|
| 含截断重发的任务数 | 10 / 265 |
| 截断重发轮数 / 有归属轮总数 | 12 / 303（4.0%） |
| retryable HTTP 重试占比 | **数据源缺失**（interceptor 内无 trace 打点，缺报不编数） |

### 判读口径（字节类与频率类分开，不互相推论）

- **字节类只回答成本**：Σ bodyBytes（见 C 表）回答"花了多少流量"，与请求次数无关。
- **频率类只回答请求表面积**：E1/E2/E3 回答"发了多少请求、多密、多少是重发"，与字节量无关。
- 本脚本不产出「所以被限流」类合成结论：成本高≠频率高，频率高≠成本高，两件事互相独立。

## 局限

- 三类证据分开计数，不做跨类合并；同一轮在 trace 与抓包里各计一次是口径而非错误。
- 未知 stopReason 进 `unknown(未收录:…)` 单列，不崩、不吞；映射表补录后再复跑即可归位。
- CDP 抓包为布尔/字节探测，绝不输出响应体内容本身。
