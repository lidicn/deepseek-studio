# tools/metrics — D1 取数工具

读取 harness-metrics 事件日志（JSONL），复用 `createHarnessMetrics()` 计算 nudgeRate，输出 D1 裁决报告。

## JSONL 格式

每行一个 JSON 对象，用 `kind` 字段区分两类事件：

### bus 事件（单次工具调用结局）

```json
{"kind":"bus","event":"after-call"}
```

`event` 取值：`before-call` / `after-call` / `call-error` / `call-skip`。
harness 只关心事件名（计数），其余字段不要求。

### loop 事件（AgentLoop 回合状态机）

```json
{"kind":"loop","type":"tool"}
{"kind":"loop","type":"status","text":"检测到未解析的工具调用，发送格式纠偏（第 1 次）…"}
{"kind":"loop","type":"assistant"}
```

`type` 取值：`tool` / `status` / `assistant` / `error` / `done` / `user`。
nudge 识别：`status` 事件的 `text` 含「纠偏」二字即计一次 nudge。

### 真实示例（一行）

```json
{"kind":"loop","type":"status","text":"检测到未解析的工具调用，发送格式纠偏（第 1 次）…"}
```

## 谁产出这份日志

当前为手工 / 离线样本（`samples/` 目录）。将来 web-engine 在真机运行时，
由 hub 执行工具调用后 append 一行到 JSONL（见交付卡阶段 B 分析）。

## 用法

```bash
npx tsx tools/metrics/report.ts <file.jsonl>
# 或
npm run metrics:report -- <file.jsonl>
```

退出码：`0`=PASS(nudgeRate<5%)  `1`=FAIL(nudgeRate>=5%)  `2`=文件错误
