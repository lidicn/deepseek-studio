# deepseek-studio 审计报告索引

> 审计流水线：deepseek-pp-audit v2（阶段 0 环境校验 → 1 建图 → 2 覆盖率 → 3 风险排序 → 4 深潜 → 5 逐轮审计 → 6 汇总）
> 工程根：E:/NAS/deepseek-studio ・ 图谱索引：E:/NAS/deepseek-studio/.codegraph

---

## 一、逐轮索引表

| 轮次 | 日期 | 报告 | 范围 | P1 | P2 | P3 | 结论 |
|---|---|---|---|---|---|---|---|
| R0 | 2026-10-17 | [对话开始服务器暂时不可用-根因审计](20261017-对话开始服务器暂时不可用-根因审计.md) | src/inject 页端拦截器、PoW、SSE 提取；src/shared 续跑 prompt | - | - | - | 根因 5 项 R1-R5，主因 25×8 重试正反馈环 |
| R1 | 2026-10-17 | [API 安全边界与资源生命周期](20261017-R1-API安全边界与资源生命周期审计.md) | src/api、src/capabilities、mcp-controller、workspace | 2 | 3 | 3 | 未收敛 |
| R2 | 2026-10-17 | [宿主核心与连接状态机](20261017-R2-宿主核心与连接状态机审计.md) | desktop-host、page-runtime、agent-channel、agent-loop | 3 | 3 | 2 | 未收敛，P1 趋势恶化 |

**累计：P1 = 5，P2 = 6，P3 = 5**（R0 为根因分析轮，不计入缺陷分级统计）

---

## 二、缺陷态势（按主题归并）

### 主题 A · 错误识别与重试（R0）

| 编号 | 级别 | 内容 | 状态 |
|---|---|---|---|
| R0-R2 | 根因 | 只识别 429，其余错误被当空回复 → 25 轮 auto-continue + 8 次 nudge = 33 次连发 | 待修复 |
| R0-R3 | 根因 | auto-continue 复用一次性头（x-hif-leim / x-hif-dliq）与旧 body | 待修复 |
| R0-R5 | 根因 | 无错误分类、无 SSE 错误帧解析、无遥测 | 待修复 |

### 主题 B · 信任边界误判（R1 + R2，跨层同源）

| 编号 | 级别 | 内容 | 状态 |
|---|---|---|---|
| R1-01 | P1 | /v1/debug/eval 完全跳过鉴权，本机任意进程可注入任意 JS | 未修（R2 复查确认） |
| R2-03 | P1 | ws upgrade 不校验 Origin，任意网页可连本机工具通道 | 待修复 |
| R2-02 | P1 | pickClient 不校验 hello 状态，未握手连接可截获工具参数 | 待修复 |
| R2-05 | P2 | invokeTool 硬编码 origin=DEEPSEEK_ORIGIN，origin 闸门恒真 | 待修复 |

> 三项 P1 是同一认知偏差的三处实例：把「本机回环」等同于「可信」。建议做全仓回环判断点专项排查。

### 主题 C · 进程与连接生命周期（R1 + R2）

| 编号 | 级别 | 内容 | 状态 |
|---|---|---|---|
| R1-03 | P1 | shell 超时只 kill 直接子进程，孤儿进程累积 | 未修（R2 复查确认） |
| R2-01 | P1 | agent-loop watchdog 提前置 active=false 并重置 stopFlag | 待修复 |
| R2-06 | P2 | agent-loop finally 无条件重置 stopFlag，抹掉 stop 意图 | 待修复 |
| R1-04 | P2 | 流式 SSE 未处理客户端断开，并发位被占死 | 待修复 |
| R1-05 | P2 | MCP stdio 进程缺失时空转 30s | 待修复 |
| R2-08 | P3 | watchdog 与 finally 双重 active=false | 待修复 |

### 主题 D · 静默错误（返回成功但未执行）

| 编号 | 级别 | 内容 | 状态 |
|---|---|---|---|
| R2-04 | P2 | routeExecution Node 回退假成功：ok:true 但未真正执行 | 待修复 |

### 主题 E · 路径与语义一致性

| 编号 | 级别 | 内容 | 状态 |
|---|---|---|---|
| R1-02 | P2 | 工作区相对路径以进程 cwd 为基准 | 待修复 |
| R1-08 | P3 | finish 与 close 竞态导致 exitCode 语义不稳 | 待修复 |

### 主题 F · 可观测性与文档

| 编号 | 级别 | 内容 | 状态 |
|---|---|---|---|
| R1-06 | P3 | queued 计数永不增长，排队指标恒为 0 | 待修复 |
| R1-07 | P3 | 文件头注释与免鉴权端点清单不一致 | 待修复 |
| R2-07 | P3 | agent-loop 头注释称 max_steps 默认 15，实际 25 | 待修复 |

---

## 三、Top 5 待办（按修复收益重排，R2 后）

| # | 项 | 来源 | 改动量 | 收益 |
|---|---|---|---|---|
| 1 | ws upgrade 校验 Origin + pickClient 校验 hello/ready | R2-03 + R2-02 | 约 13 行 | 关闭「任意网页/进程 → 截获工具参数」链路 |
| 2 | 删除 /v1/debug/eval 鉴权豁免 | R1-01 | 约 5 行 | 关闭本机任意代码执行面 |
| 3 | 新增 response-classifier + 拆分重试预算 | R0-R2 | 约 80 行 | 故障放大倍数 33 → 3 |
| 4 | agent-loop watchdog 不释放 active + stopFlag 回合私有化 | R2-01 + R2-06 | 约 18 行 | 消除并发回合与 stop 失效 |
| 5 | shell 超时改进程树终止 + close 驱动 resolve | R1-03 | 约 15 行 | 消除孤儿进程与假超时 |

---

## 四、覆盖率基线

studio 的测试在**仓库根 tests/**（76 个 .ts 文件），不在 src/tests/。src 共 126 个 .ts、约 23,692 行。

| 轮次 | 覆盖模块 | 行数 | 累计覆盖率 |
|---|---|---|---|
| R0 | inject 拦截器/PoW/SSE + shared 续跑 | 2,161 | 9.1% |
| R1 | api + capabilities + mcp-controller + workspace | 2,072 | 17.9% |
| R2 | desktop-host + page-runtime + agent-channel + agent-loop | 2,149 | **27.0%** |

### 各模块覆盖进度

| 模块 | 总行数 | 已审 | 覆盖率 |
|---|---|---|---|
| api | 1,000 | 791 | 79.1% |
| capabilities | 726 | 402 | 55.4% |
| inject | 3,593 | 1,653 | 46.0% |
| shared | 1,551 | 508 | 32.8% |
| host | 10,274 | 3,028 | 29.5% |
| ui | 4,746 | 0 | 0% |
| bridge | 793 | 0 | 0% |
| desktop | 736 | 0 | 0% |
| lever-hub | 241 | 0 | 0% |
| types | 32 | 0 | 0% |

**剩余未审约 17,310 行（73.0%）**。最大缺口：src/host/bot/*（25 文件 4,335 行）、src/ui/*（15 文件 4,746 行）。

---

## 五、收敛判定

| 判据 | 现状 | 满足 |
|---|---|---|
| 1 前 80% 权重模块均已审过至少一轮 | main-world-interceptor、api、mcp-controller、file、shell、desktop-host、page-runtime、agent-loop 已审；agent-channel、entry、host-client、bot/* 未审 | 接近 |
| 2 连续 2 轮无新增 P1 且新增 P2 ≤ 1 | R1：P1=2、P2=3；R2：P1=3、P2=3 → 趋势恶化 | 否 |
| 3 高风险无测试模块已针对性审过 | desktop-host.ts（1,292 行）已审 | 是 |

**当前状态：未收敛。** 判据 1 与 3 已接近/满足，判据 2 是唯一卡点且方向不利——R2 的 P1 数量高于 R1，说明 host 层风险比 api 层更集中。

判据 2 要求「连续 2 轮无新增 P1」，而 R1、R2 各有新增 P1。按此趋势，至少需要 R3、R4 两轮都不再出现新 P1，才可能首次满足。

---

## 六、统计口径与环境修正

| 问题 | 现象 | 修正 |
|---|---|---|
| find-untested.ps1 路径硬编码 | 脚本第 12-14 行固定拼 srcDir/tests，studio 测试在仓库根 tests/，直接调用 exit 1 | 改用 basename 双向模糊匹配；建议脚本增加 TestsDir 参数或自动探测 repo/tests |
| 全量测试超工具时限 | vitest 全量约 185s，超过 MCP 单次 120s 上限 | 重定向到文件后读取，不在 shell 管道内等待 |
| shell_exec timeout 上限 | 600000 ms | 不要写 900000，会校验失败 |
| 内嵌副本排除 | 仓库内嵌 deepseek-pp/ 完整副本 | 统计与检索一律排除 deepseek-pp/、node_modules/、dist/ |
| 测试规模口径 | 磁盘 76 个 .ts；最近全量运行 76/76 文件、801/801 用例全绿 | 以实际运行为准，不以历史 72/765 为准 |

---

## 七、环境快照

| 项 | 值 |
|---|---|
| git HEAD | fe3508b（2026-10-17 00:21:05 +0800）docs: 归档交接/审计/架构文档 + 方案A版本号登记 |
| 分支 | feat/bot-core |
| 未提交项 | 45（R1 时 41，R2 时 45） |
| codegraph | 1.6.2，索引 1,017 文件 / 19,829 节点 / 61,579 边（R1 建，R2 沿用） |
| forensic-deepdive | 0.10.0（未启用） |
| Node | v24.14.0 |
| 平台 | Windows 11 IoT Enterprise LTSC 2024（10.0.26300） |

---

*索引维护于 2026-10-17 · 每轮审计后更新本表 · 报告目录 E:/NAS/deepseek-studio/docs/Audit*