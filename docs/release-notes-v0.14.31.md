# v0.14.31 发版说明

发布日期：2026-11-24（tag `v0.14.31`；本版修复**反复调用记忆存储，最终都没能查询成功**——注入层的 `terminate` 停止信号被丢掉、熔断判定面用错，导致被拒工具空转）

## 这版修了什么

### 1. 反复调用记忆存储，最终都没能查询成功（`f9cfeab`）

**现象**：用户反复让 agent 处理记忆，`memory_save` 连续被拒（`memory-save-needs-explicit-instruction`），**一次都没有停下来**，而真正要去做的查询工具（`mcp_list`）一次都没被调用，最终以系统错误收场。现场取证：`memory_save` ×10 全拒（每枚都带停止信号）、`local_file_stat` ×3、`mcp_list` ×0。

**根因**（两处都在**注入层接线**，纯函数判定面本身经测试验证正确，缺陷不在判定）：

- **`terminate` 透传断链**：构造 `PendingResult` 时没有把宿主返回的 `terminate` 带进去，而续跑闸门读的正是这个字段——字段在类型里声明了、UI 卡片用到了、落盘记录里也有，唯独**闸门没吃到**，恒判「不跳过续跑」⇒ 被拒工具照常续跑、空转。
- **熔断判定面用错**：熔断器吃的是**每轮清空**的 `pending`，模型一轮通常只发一枚被拒工具，桶计数恒为 1，阈值（3）永不达；而文档写明的熔断寿命是**一个 user turn**，应吃跨循环累积、仅在新用户消息时清空的 `collectedExecutions`。

**修复**：

- `terminate` **三处构造点逐个判过**：终局回执带、折叠回执（同轮重复投递）带、传输层抛错**不带**（可重试，语义上不该停）；
- 续跑闸门改读透传后的 `p.terminate`（原路径读宿主 payload，恒为 undefined，正是断点）；
- 熔断判定面切到**按当前会话过滤的 `collectedExecutions`**，口径与续跑提示完全一致，没有另写一套。

**效果**：被拒工具不再空转——同一轮内终局拒绝带 `terminate` 时当轮即停止续跑；同一 `(工具, 终局码)` 跨续跑轮累积到阈值即熔断，并给出可见交代；`mcp_list` 这类正常工具不被熔断误伤。

## 验证

- 全量闸 **exit=0**，1645.1s，18 步阻塞＋6 步信息，vitest **338 files／3765 passed／1 skipped**（比上版多 3 枚＝本轮新三格）；双产物 freshness PASS（entry `85571894`／host `D1A05CEF`）
- CI run **45343275224**（head `f9cfeab`）：gate／doc-drift-upstream-negative／cargo-check 三 job 全 success
- 独立窄面 4 件 **63/63**；新测试件 `tests/desktop/terminal-fuse-wiring.test.ts` 新增三格（单轮终局带 terminate ⇒ 闸门收掉／跨续跑轮累积 3 枚 ⇒ 熔断／未达阈值且无 terminate ⇒ 不误杀、照常续跑）
- 仓外负控：摘 `terminate` 透传 ⇒ 闸门格红；判定面改回 `pending` ⇒ 跨轮累积格红；两处各自还原后复绿、真树 SHA 前后逐字未动
