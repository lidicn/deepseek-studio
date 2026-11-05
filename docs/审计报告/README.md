# deepseek-studio 工程审计汇总（2026-11-05）

deepseek-pp-audit 流水线三工具审计，目标仓库 `<repo-root>`（v0.14.6，master @ 410 commits）。
本报告目录承载阶段 3/4 产物；图谱与深潜工件另列如下，**互不混存**。

## 产物索引

### 1. 代码图谱（codegraph 1.6.2，阶段 1）
- 索引：`.codegraph/`（codegraph.db，75.78 MB；本次 **sync** 增量刷新——索引已存在，未重复 init）
- 状态：`[OK] Index is up to date` — 601 files / 10,442 nodes / 33,023 edges（本次同步 1,301 变更文件：+389 / ~107 / -805）
- 影响面查询：`codegraph callers <符号> -p <repo-root>`；区域理解：`codegraph explore "<关键词>" -p <repo-root>`
- 生成物，**勿提交 git**（.codegraph/.gitignore 已自罩）

### 2. 深潜工件（forensic-deepdive 0.10.0，阶段 2）
输出目录 `docs/codebase/`（对齐本仓既有 docs/ 结构），本次 extract 耗时 179.8s（782 files / 7,618 edges）：
- `docs/codebase/MAP.md` — 代码库地图
- `docs/codebase/HOTPATHS.md` — 热路径
- `docs/codebase/ARCHAEOLOGY.md` — 考古（历史形态）
- `docs/codebase/MENTAL_MODEL.md` — 心智模型
- `docs/codebase/AGENT_BRIEF.md` — agent 简报
- 附加：`docs/codebase/ARCHITECTURE.md`（跨边界视图）+ 5 个 codebase-* 技能 shim
- 局部刷新用 `forensic update`；提问用 `forensic query "<问题>"`
- 生成物，**勿提交 git**（doc/codebase 同口径；本仓 docs/ 是否入 git 由仓库政策定）

### 3. 工程审计（audit-software-project 1.0.1，阶段 3）
入口：`docs/审计报告/index.html`（行动面板：阻断项 / 状态计数 / 30 天 5 步清单，勾选状态按浏览器持久化）
- `docs/审计报告/audit-report.html` — 主报告：7 个特征面 × **47 控制点**（10 域，域 13 预留；全部控制点逐一落位，零漏项）
- `docs/审计报告/gap-register.html` — G1–G8 全量 Amber/Red 台账（含证据与建议动作）
- `docs/审计报告/criteria.html` — 47 控制点阈值快照（2026-11-05 判定基准）

**裁决（状态计数，非评分）：** 🔴 Red 2 · 🟠 Amber 6 · 🟢 Green 21 · ⚪ Not Verified 7 · N/A 11；**无即时阻断项**（无活体密钥、无真实 PII 提交）。
状态计数只看量级不作比较——一个 Red 的权重可以超过五个 Green。

### 4. 本汇总（阶段 4）
本文件。

## R1.5 代码级缺陷深潜（同日追加，11-05 23:00）
- 报告：[R1.5-代码级缺陷深潜-20261105.md](R1.5-代码级缺陷深潜-20261105.md) — 0 可利用缺陷（5 PASS · 1 缺口加固 · 3 观察）
- 缺口加固①（G5 强化）：entry.js 新鲜度无机械闸 → 可入库参考实现 [gate-check-entry-freshness.cjs](gate-check-entry-freshness.cjs)（IN-SYNC 实测字节级复现为证）
- CVE 暴露面确认：7 漏洞全部 dev/test 工具链（undici←jsdom、tinypool←vitest），运行时零暴露
- 后续轮次计划：[docs/Audit/后续审计计划-20261105.md](../Audit/后续审计计划-20261105.md)（R2 ~11-25 全量复审为质变点）
## Top 5 待办（= 30 天计划，与 index.html 勾选清单同序）
1. **依赖面（G1，Red 6.1）**：npm audit（官方 registry）命中 **2 critical + 2 high**（tinypool 原型污染→RCE gadget；undici 含 TLS 证书校验旁路/DoS/SRI 绕过；均 dev/test 工具链，运行时依赖未命中）。动作：vitest 升 5.x（breaking，核对 40 条 golden 断言）+ undici ≥7.31；复跑 audit 清零；加自动 SCA。
2. **质量闸（G3+G4，Amber 4.1/3.5）**：自研 SAST `tools/audit/security.ts` 现挂**信息级**（红灯不挡合并）→ 升阻塞级（或引入 ESLint）；.gitignore 补 `.env*`。
3. **文档入口（G2，Red 10.1）**：仓根**无 README.md**——setup 知识散落于 AGENTS.md（bot/PM 协作规则）与 docs/。写根 README（setup / gate / tauri dev / 发布 / LAN 配对）。
4. **数据卫生（G7，Amber 6.3）**：20261105 脱敏批删除 45 个本机痕迹文件后，痕迹仍存**可达历史**（公开仓语境、owner 自身身份、低敏）；net-memsel 事件后私钥/原文守卫（private-leak）仍信息级。动作：owner 拍板接受现状 vs filter-repo 重写（不可逆，走 DCD）+ 守卫升阻塞。
5. **GitHub 侧（NV 跟进 3.1/3.2/3.3）**：gh 未认证 → 分支保护/评审/CI-required 全部 Not Verified。恢复 `gh auth` 后核验 master 保护（PR + ≥1 评审 + gate required），并把结果回填报告问题区。

## 审计执行记录（可复核性）
- 只读审计：未修改被审仓库源码；本报告文件为唯一写入（docs/审计报告/ 新增 5 文件 + docs/codebase/ 生成物）
- 深读 8 个高风险函数：markdown 渲染（DOMPurify 白名单+anti-js: href 钩子）、API Bearer 鉴权（timingSafeEqual + fail-closed + 轮换宽限）、MCP 路由（parseConfigBody + 双闸）、agent-channel 清理、SSE 帧解码器（审计日在改文件）、PoW 拦截器、memory.purge（两态+事务审计+VACUUM/secure_delete）、工具定义（origin 白名单+风险分级同意）
- 全历史密钥/PII 扫描：410 commits 全量 -p 落盘后模式计数；唯一 AKIA 模式命中经提取确认为 entry.js wasm base64 巧合（值含小写，非合法 AWS 密钥形态）
- 依赖扫描：npmmirror advisories 端点未实现 → 改道官方 registry 成功
- 开放问题 6 条见 audit-report.html #questions（回滚/备份/保留策略/runbook/仓库可见性/gh 认证）

---
*生成：deepseek-pp-audit 流水线 · 2026-11-05 22:2x +08:00 · 审计基准 criteria.html（47 控制点快照）*
