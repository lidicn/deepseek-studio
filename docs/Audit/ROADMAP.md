# deepseek-studio 审计路线图

> 生成于 2026-10-17（R1 完成后）・流水线 deepseek-pp-audit v2
> 基线 commit：fe3508b（分支 feat/bot-core，工作区 41 项未提交）

---

## 一、当前覆盖率

| 项 | 数值 |
|---|---|
| src 总规模 | 126 个 .ts / 23,692 行（排除内嵌 deepseek-pp 副本） |
| R0 已覆盖 | ≈ 2,161 行（main-world-interceptor 1137、sse-text-extractor 229、streaming-tool-parser 165、pow 122、continuation-prompt 302、tool-result-format 206） |
| R1 已覆盖 | ≈ 2,072 行（server 599、main 192、file 152、shell 250、mcp-controller 641、workspace 238） |
| 累计已审 | ≈ 4,233 行 / 17.9% |
| 未审 | ≈ 19,459 行 / 82.1% |

### 各模块覆盖率

| 模块 | 总行数 | 已审行数 | 覆盖率 |
|---|---|---|---|
| api | 1,000 | 791 | 79.1% |
| capabilities | 726 | 402 | 55.4% |
| inject | 3,593 | 1,653 | 46.0% |
| shared | 1,551 | 508 | 32.8% |
| host | 10,274 | 879 | 8.6% |
| ui | 4,746 | 0 | 0% |
| bridge | 793 | 0 | 0% |
| desktop | 736 | 0 | 0% |
| lever-hub | 241 | 0 | 0% |
| types | 32 | 0 | 0% |

### 三个最大缺口

1. src/host/desktop-host.ts：1,292 行，全仓最大文件，60 日改动 18 次，无任何测试文件，承载工具路由/授权判断/并发控制。
2. src/host/bot/*：25 文件 4,335 行，当前开发主线 v0.26-v0.30，改动最频繁；有 25 个配套测试文件，风险低于纯无测试区。
3. src/ui/*：15 文件 4,746 行，studio-chat-room.ts 887 行为主交互入口，77.1% 无测试。

---

## 二、轮次规划

| 轮次 | 主题 | 范围 | 源行数 | 权重 | 关注点 | 状态 |
|---|---|---|---|---|---|---|
| R0 | 对话开始服务器暂时不可用（专项） | inject 拦截器 / PoW / SSE / 续跑 prompt | 2,161 | 高 | 重试正反馈环、头复用、PoW 过期 | 已完成 |
| R1 | API 安全边界与资源生命周期 | api / capabilities / mcp-controller / workspace | 2,072 | 高 | 鉴权豁免、进程树终止、流式断开 | 已完成 |
| R2 | 宿主核心与连接状态机 | desktop-host.ts 1292、page-runtime.ts 440、agent-channel.ts 240、agent-loop.ts 177 | 2,149 | 极高 | 工具路由授权、并发闸门、断线重连、循环终止 | 待启动 |
| R3 | Bot 编排层 | host/bot/* 25 文件 | 4,335 | 中高 | 状态机迁移、并发轮次、mention 路由、报告合并 | 待启动 |
| R4 | 记忆/自动化/授权/审计 | memory-store 533、automation 345、policy 217、tool-definitions 210、audit 168、host-token 161、sandbox-executor 137、tool-registry 118、skill-store 117、authority 98、protocol 90、grant-store 85 | 2,279 | 高 | 权限 fail-closed、沙箱逃逸、token 生命周期、审计防篡改 | 待启动 |
| R5 | 注入 UI 与共享工具链 | inject 剩余 1,940、shared 剩余 1,043 | 2,983 | 高 | 流式渲染竞态、事件总线丢事件、DOM 注入 | 待启动 |
| R6 | 桥接/桌面客户端/能力剩余/lever-hub | bridge 793、desktop 736、capabilities 324、lever-hub 241 | 2,094 | 中 | 信封完整性、WebView 传输、完整性校验 | 待启动 |
| R7 | UI 层（可延后） | ui/* 15 文件 | 4,746 | 中低 | 渲染层为主；studio-chat-room 887 优先 | 可选 |
| R8 | 收口轮 | 无新增范围 | — | — | 修复回归验证 + 收敛终判 | 必须 |

### 口径说明

- 收敛口径（满足 v2 三条判据）：还需 5 轮，R2-R6。
- 全覆盖口径（含渲染层）：还需 7 轮，R2-R8。
- 不建议逐文件读完全部 19,459 行：低风险区收益趋零，稀释主产出。

---

## 三、收敛判据（三条同时满足才算完）

| # | 判据 | R1 结束时状态 |
|---|---|---|
| 1 | 风险排序表中前 80% 权重模块均已审过至少一轮 | 未满足：desktop-host、page-runtime、entry、host-client 未审 |
| 2 | 连续 2 轮无新增 P1，且新增 P2 ≤ 1 | 未满足：仅 1 轮分级审计，P1=2、P2=3 |
| 3 | 覆盖率地图中无测试保护的高风险模块已被针对性审过 | 未满足：desktop-host.ts 1,292 行未审 |

预计最早在 R4 之后可能首次满足判据 2；R6 之后三条有希望齐备。

---

## 四、执行前置约束

### 约束 1：先修 R1-01 再开 R2

/v1/debug/eval 的鉴权豁免（server.ts:267-272）是本机任意代码执行入口，修复约 5 行。
若不修，R2 将在同一批代码上继续引用这个有问题的代码，跨轮现状描述会失真。

建议顺序：修 R1-01 → 修 R1-03（进程树终止）→ 开 R2。

### 约束 2：固定审计基线

当前 41 项未提交改动，分支 feat/bot-core 活跃开发。codegraph 索引是快照，代码变动会使行号引用失效。

做法：每轮报告头部记录 git rev-parse HEAD；跨轮去重时先判断发现是否已被修复。

### 约束 3：每轮必做四件事（v2 阶段 5）

1. 静态读（源码 + codegraph callers 追引用）
2. 动态验证：npx tsc --noEmit（必须 exit 0）+ vitest（记录 76/76 文件、801/801 用例基线）
3. 跨轮去重：对照 README.md 缺陷态势，同根因合并编号，不新开编号
4. 落盘报告：docs/Audit/YYYYMMDD-Rn-标题.md，每条发现齐备「证据 / 后果 / 建议 / 状态」

---

## 五、已知口径陷阱（避免重复踩）

| 陷阱 | 正确做法 |
|---|---|
| find-untested.ps1 硬编码 src/tests | studio 测试在仓库根 tests/；用 basename 双向匹配或给脚本加 -TestsDir |
| vitest 全量约 185s 超 MCP 单次 120s | 重定向到文件后读取，不在管道内等待 |
| shell_exec timeout 上限 600000 | 不要写 900000，会校验失败 |
| 仓库内嵌 deepseek-pp 副本 | 统计与检索一律排除 deepseek-pp/、node_modules/、dist/ |
| 历史记忆里的测试规模 | 以实际运行为准（当前 76 文件 / 801 用例），不以旧的 72/765 为准 |

---

*路线图维护于 2026-10-17 · 每轮完成后更新状态列 · 报告目录 E:/NAS/deepseek-studio/docs/Audit*