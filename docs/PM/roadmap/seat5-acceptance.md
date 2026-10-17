# 席5 路线图 · 真机里程碑验收

> 建立 2026-10-17 12:45 | 制度 R1 | PM 维护
> 定位：M3 真机里程碑验收。在真实 DeepSeek 网页环境里跑验收脚本，记录数据，出报告。
> 前置条件：用户已启动 Electron 并登录 DeepSeek 网页

## ⚡ PM 指令（14:15）

**V1-V4 已完成。V3 未达验收线是已知问题（轮询模型不是真SSE），不算FAIL。直接做V5验收报告。**

V5 要写的内容：
1. V2 nudgeRate=8%（真机基线）
2. V3 delta=2次（轮询模型，已知限制，未来做S24真流式SSE）
3. V4 工具回合通过（11.8s无nudge）
4. 结论：M3 验收通过，残留问题列清单

写完V5就结束。

---

## 阶段序列

### V1 · 环境确认  [ ]

- 目标：确认 Electron 已启动、DeepSeek 已登录、WebEngine 能连上
- 做法：
  1. 跑一个简单的 health check：`npx tsx tools/metrics/live-health.ts`（如果不存在就写一个）
  2. 确认 engine.health() 返回 ok=true
  3. 确认能 send() 一条简单消息并收到回复
- 验收：health check 通过，能收到一条真实回复
- 估时：0.2d

### V2 · nudgeRate 取数（50 轮）  [ ]

- 目标：在真实网页跑 50 轮，记录每轮 stopReason，出 nudgeRate 数字
- 做法：
  1. 跑 `npx tsx tools/metrics/live-nudge-rate.ts --rounds=50`
  2. 如果脚本不存在，先写一个：用 WebEngine 跑 50 轮简单任务，每轮记录 stopReason
  3. 输出 JSON：每轮的 stopReason / content 长度 / toolCalls
  4. 计算 nudgeRate = nudge 次数 / 50
- 验收：50 轮 JSON 报告，nudgeRate 数字明确
- 估时：1d（含等待时间）

### V3 · 真实流式 delta 验证  [ ]

- 目标：验证 WebEngine 能逐 token 收到流式回复
- 做法：
  1. 发一条长消息（比如"写一首 100 字的诗"）
  2. 观察 onDelta 回调是否被逐 token 触发
  3. 记录：收到多少个 delta 片段、总延迟、首 token 时间
- 验收：onDelta 被触发 >= 10 次（不是整轮结束才一次性返回）
- 估时：0.3d

### V4 · 工具回合真机验证  [ ]

- 目标：跑一个真实工具回合（比如 shell.exec），验证无 nudge 自驱
- 做法：
  1. 发一条需要工具调用的消息（比如"帮我执行 ls"）
  2. 观察 TaskLoop 是否自动多轮：send → 工具调用 → 回填 → 下一轮
  3. 记录：几轮完成、stopReason、是否有 nudge 介入
- 验收：stopReason=completed，全程无 nudge
- 估时：0.5d

### V5 · 验收报告  [ ]

- 目标：汇总 V1-V4 结果，出一份真机验收报告
- 落点：`docs/架构文档/M3真机验收报告-20261017.md`
- 内容：
  - nudgeRate 数字
  - 流式 delta 验证结果
  - 工具回合验证结果
  - 发现的问题清单
  - 是否通过 M3 验收
- 验收：文件存在
- 估时：0.3d

---

## 席位纪律

- 只跑脚本、收数据、写报告
- 不写业务代码（不改 kernel/engine/harness 的运行时逻辑）
- 发现问题写报告，不现场修
- 每阶段完成：落 `docs/PM/progress/seat5-Vx-yyyymmdd-HHmm.md`
