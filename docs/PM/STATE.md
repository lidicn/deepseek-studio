# studio 项目状态（唯一真相）

> 最后更新：2026-10-17 11:45
> 更新人：PM（豆包侧）
> 读法：只读这一页就能知道项目在哪。来龙去脉见 DECISIONS.md，刚才发生什么见 log/。

---

## 0. 一句话

**路线图制度 R1 已落地（用户自建）。三席持续跑、不停等审核。当前：席1 已完成 S2（18 tests）正在 S3，席2 S1 已完成正在 S2，席3 S1+S2 已完成正在 S3。基线 79/829 全绿。**

---

## 1. 里程碑状态

### 轨 A · 内核归位

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M0 | **DONE** | 基线 + 埋点 + eval:golden |
| M1 | **DONE** | M1-1 / M1-2 / M1-3（CUT 接 pi） |
| M2 | **DONE** | M2-1 / M2-2 / M2-3 |
| M3 | **WIP** | 路线图驱动，不在传统里程碑节点卡 |

### 轨 B · Bot 平台

| 版本 | 状态 |
|---|---|
| v0.31 / v0.31.1 | 已真机验证 |
| v0.32 | 未开始（Claude 线） |

---

## 2. 在飞（路线图 R1 模式）

**制度**：`roadmap/README.md`（R1）。三席读自己那份路线图，找第一个 `[ ]` 阶段开工，做完落 `progress/seatN-Sx-*.md`，回路线图把 `[ ]` 改 `[x]`，立刻开始下一个。不等 PM 审核。

| 席位 | 路线图 | 当前阶段 | 已完成 |
|---|---|---|---|
| 席1（内核） | `roadmap/seat1-kernel.md` | S4 判停信号强化（后续 S5-S12 已排队） | S1-S3 |
| 席2（引擎） | `roadmap/seat2-engine.md` | S4 断流恢复（后续 S5-S11 已排队） | S1-S3 |
| 席3（harness） | `roadmap/seat3-harness.md` | S7 M3 符号清零审计（S1-S6 全完成，S7-S11 已排队） | S1-S6 |
| QD（审计） | `roadmap/qd.md` | A2 边界审计滚动 | A1 |

### 文件域（R1 铁律）

| 席位 | 独占域 | 绝不触碰 |
|---|---|---|
| 席1 | `src/host/kernel/**`、`tests/desktop/kernel-*.test.ts` | engine、tools、package.json |
| 席2 | `src/host/engine/**`、`tests/desktop/web-engine-*.test.ts`、`engine-*.test.ts` | kernel、tools、agent-loop.ts、package.json |
| 席3 | `tools/**`、`tests/desktop/tools-*.test.ts`、`metrics-*.test.ts`、`package.json`（仅加 script） | src 下任何 .ts |
| QD | 只读，不落代码 | 写任何文件 |

---

## 3. 阻塞 / 待决

| # | 事项 | 状态 |
|---|---|---|
| B-1 | D1 真机 nudgeRate | 等席2 S2（completion 自证）+ S3（metrics 接线）完成 |
| B-3 | 计划 §4 状态列失真 | QD A4 阶段审计，不改计划文件 |
| B-5 | 16:00 硬停 | 15:30-16:00 写交接卡 |

---

## 4. PM 动作

1. 每 30 分钟扫一次 `progress/` 目录
2. 三席跑过 2-3 个阶段后跑一次全量闸门（typecheck + vitest + eval:golden）
3. 发现边界违规 → 更新路线图「跨域需求」段，不喊停
4. 15:30 硬停时汇总进度写交接

---

## 5. 硬证据

| 项 | 值 | 测于 |
|---|---|---|
| typecheck | 0 错 EXIT=0 | 11:28 |
| 全量测试 | 79 files / 829 tests 全绿，149s | 11:28 |
| eval:golden | 18/18 PASS | 11:29 |
| 席1 S2 | 18 tests 绿 | 11:38（progress/seat1-S2） |
| 分支 | feat/bot-core @ fe3508b（未 commit） | — |

---

## 6. 时间线

| 时刻 | 事件 |
|---|---|
| 11:08-11:20 | 第三轮三席交付（M2-3 / M1-2 / D1 CLI） |
| 11:28 | 闸门 #3 通过：79/829 + eval 18/18 |
| 11:20-11:26 | 用户建路线图制度 R1（README + 三份路线图） |
| 11:38 | 席1 交付 S2 进度（18 tests） |
| 11:45 | QD 路线图建好，并入 R1 模式 |
| **15:30-16:00** | **硬停写交接卡** |
