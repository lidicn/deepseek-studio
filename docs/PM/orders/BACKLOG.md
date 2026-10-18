# 辅助工单排队队列（BACKLOG）

> 主进程维护｜2026-10-18｜配合 `组织模式-主进程制-20261018.md` 使用。
> 规则：标【可发】的包契约封死、独立文件，派给豆包辅助席一单一卡；标【自留】的由主进程写，不发。
> 顺序按依赖排；主进程合流上一单全绿后才发下一单，不并行堆单。

## 队列（可发辅助席）

| 单号 | 包 | 里程碑 | 依赖 | 核心验收 | 状态 |
|---|---|---|---|---|---|
| ORD-001 | `search-files`：listFiles + grepFiles 本地检索 | M5 编程 | 无 | 临时目录单测全绿、越界/超限/错误码齐全 | **已发** |
| ORD-002 | `web.fetch` 纯函数：URL 抓取正文抽取、超时/大小/重定向限额（mock 网络，不真连） | M6 检索 | ORD-001 合流 | 错误 URL/超时/超大/循环重定向 → isError 不崩；正文抽取可测 | 待发 |
| ORD-003 | `web.search` 纯函数：查询构造 + 结果解析（mock fixture，通道留接口） | M6 检索 | ORD-002 | 结果结构稳定；解析坏 fixture 不崩 | 待发 |
| ORD-004 | 上下文压缩纯函数：history 超预算压缩，保留最新 user/最近 assistant/未完成工具结果摘要 | M7 治理 | M4 历史结构稳定 | 超长 history 压缩后关键消息不丢；纯函数可测 | 待发 |
| ORD-005 | token 估算 + cost 累计纯函数（WebEngine 估算口径 / ApiEngine usage） | M7 治理 | ORD-004 | 累计可加可重置；边界空输入不崩 | 待发 |

## 主进程自留（不发）

| 项 | 里程碑 | 为什么自留 |
|---|---|---|
| M4 内核并入生产：TaskLoop 接管 `/v1/agent/send`、real-tool-executor 全量接 hostTools、consent 对齐、去续感、快照恢复 | M4 | 改主路径/授权链/共享文件，强耦合 |
| edit-engine / test-runner 接线进 hostTools | M5 | 碰 desktop-host 注册与授权 |
| D3 ApiEngine 真实 API key 注入、一行切 provider | M7 | 配置/密钥/接线 |
| E1 审批三级（safe/ask/deny + 白名单）、E2 git shadow 回滚、E3 Plan/Act | M8 | 安全核心，碰 policy/consent |
| F1 health 真校验、F3 SSE 直转 onDelta、F4 truncated 口径、F2 冷启动预热 | M9 | 碰 web-engine/interceptor 真机层 |
| 每单合流：跑 gate、挂工具、补接线测试 | 全程 | 共享文件单写者 |

## 发单节奏

1. M4 期间不发单（无独立包，主进程全自写）。
2. M5 发 ORD-001（当前）；M6 连发 ORD-002/003；M7 发 ORD-004/005。
3. 每单交付后主进程先合流全绿，再发下一单；辅助席同时只持 1 单（峰值 2 仅当两包零依赖）。
