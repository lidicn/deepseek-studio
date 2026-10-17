# QD 路线图 · 审计 + 回归守门

> 建立 2026-10-17 11:45 | 制度 R1 | PM 维护
> 定位：纯静态审计 + 回归守门，不写业务代码（D-009）
> 关键约束：QD 慢，绝不阻塞三席决策（T-4）。三席在跑时只读代码，不跑全量测试

## 长目标（一句话）

**当三席并行把架构边界踩穿时，机械地把它抓出来**：谁越界 import、谁改坏契约、谁删了不该删的符号——不靠人盯，靠静态审计脚本和定期回归贴红绿。

**完成标志**：三席每阶段交付后，QD 5 分钟内给出「边界合规 / 符号清零 / 回归红绿」三张票，没有遗漏。

---

## 阶段序列（串行，做完一个立刻做下一个）

### A1 · M3 波及面静态审计  [x]

- 落点：`docs/架构文档/M3-真实波及面-20261017.md`
- 结果：356 行。发现 8 个纠偏符号、M3 实际 5 个任务、构建产物面需 build:inject

### A2 · 三席路线图边界审计（静态）  [x]（首轮 pass 11:49，滚动继续）

- 目标：三席按路线图跑，QD 只读代码核边界，不跑测试
- 做法：
  - 每隔 30 分钟扫一次 `progress/` 目录，看新进度文件
  - 对每阶段交付的文件域做 grep：席1 有没有碰 engine/tools、席2 有没有碰 kernel/tools、席3 有没有碰 src/**
  - 核 `model-engine.ts` 是否只被席2 加了可选字段、老字段语义没改
- 输出：`progress/qd-a2-<HHmm>.md`，列「合规 / 违规 + 文件:行号」
- 估时：0.5d（持续滚动）
- 结果：`docs/PM/progress/qd-a2-20261017-1149.md`（含 11:53 第二轮 pass §八，**首轮对"契约守门为何红"的归因已在 §8.1 订正**）。三席各自域内**均合规**（`model-engine.ts` diff 纯 additive、0 删除行，`toolCalls` 仍 number；席1 S4/S5/S6 亦止于 `task-loop.ts` + `kernel-*` 测试）。两条机械守门**实测贴红**：`tools/audit/boundary.ts` EXIT=1（R3×1 + R4×7 = 8 条越界 import）、`tools/contract/check.ts` EXIT=1（席1 S4 于 11:48 新增第 5 值 `empty-response`，席3 守门白名单仍按 4 值硬编码 → 跨席同步漏，红属实但**席3 当时未虚报**）。
  ⚠️ 最关键一条：`tests/desktop/tools-audit.test.ts` 8 用例**全为合成字符串，无一条扫真实仓库**（同席的 tools-contract.test.ts 反倒有 3 条真读源文件）→ 那 8 条越界对 `npm test` 不可见，只在 `npm run gate` 才露出。

### A3 · M3 删完后符号清零复核  [ ]（前置未成立，暂不可做）

- 前置状态（11:52 实测）：计划 §4 的 M3-1/M3-2/M3-3 三行状态列仍全 `TODO`，`git diff --name-only` 里 `src/inject/**`、`src/host/agent-loop.ts`、`src/shared/continuation-prompt.ts` **零改动** → 纠偏一个符号都还没删，本项无可复核对象。触发条件 = M3 任一行落 DONE。
- 目标：M3 所有纠偏符号删完后，全仓 grep 确认清零
- 做法：
  - grep `MAX_NUDGES`、`RAW_TOOL_TAG_RE`（区分有无 GLOBAL）、`stripRawToolTags`、`shouldNudge`、`MAX_LOOP`（原写 `MAX_LOOPS` 系本路线图笔误：真实符号无复数 S，见 A1 §1 符号 7）、`loopDepth`
  - 产出对照表：符号 → 定义位置 → 使用位置 → 是否已删
  - 例外：`shouldNudge` 函数定义保留但调用删光，也算 DONE
- 输出：`docs/架构文档/M3-符号清零复核-20261017.md`
- 估时：1d
- 复核面提醒（承 A1 §0 口径 2）：清零要分**三面**核 —— TS 源面（`src/**`）、产物面（`src-tauri/inject/entry.js`，须 `npm run build:inject` 重生成后才是真清零）、外部参照面（`deepseek-pp/**` 属移植来源，**不计入清零**，它留着是对的）。只扫源面会得出"已清零"的假绿。

### A4 · 计划文档状态列审计  [x]

- 目标：D-012 列的 7 处失真（M0-2/M0-3/M1-1/M1-3/M2-1/M2-2/D2 行数）是否已被 A 线主开发回填
- 做法：对比 `内核归位开发计划-20261017.md` §4 状态列 vs 实际代码
- 输出：列「已回填 / 仍失真」清单，不直接改计划文件
- 估时：0.5d
- 结果：`docs/PM/progress/qd-a4-20261017-1150.md`（含 11:53 追记 §六，**首轮"唯一准确状态格是 M2-3"的判定已订正**）。**已回填 0 处 / 仍失真 7 处（0/7）**；逐格重数实为 **15 格**（状态 **7**（含 M2-3，席1 S6 于 11:50 覆盖其验收文案）+ 落点 2 + 验收 1 + 行数 5；旧值 177 散落 3 处 L63/L139/L198、1137 散落 2 处 L48/L64）。附带：M1-3 验收点名的 `kernel-turn.test.ts` **不存在**；B4/B5 标了「已核实/DONE」却仍是旧行数 → 「已核实」标记本身不可作免检依据。

### A5 · 回归守门（三席阶段交付后）  [ ]（等 PM 放行，T-3）

- 目标：三席全量测试由 PM 跑后，QD 独立跑一遍贴红绿做交叉验证
- 做法：
  - `npm run typecheck` 贴原始输出
  - `npx vitest run` 贴原始输出
  - `npm run eval:golden` 贴原始输出
  - 不判断、不分析、不建议，只贴数字
- 触发：PM 说「可以跑了」才跑（并行期不跑，T-3）
- 估时：每次 5 分钟
- 放行前的预期（承 A2，省一轮往返）：`npm run gate` 现会在第 2 步 `boundary-audit` 就 EXIT=1（8 条越界 import），第 3 步 `contract-guard` 亦 EXIT=1（`empty-response` 非法值）。故建议 A5 首轮**先跑三项裸命令**（typecheck / vitest / eval:golden）贴数，把 gate 的红另列为 A2 后续项；否则数字会被 gate 早退遮掉。另 `§2 B2` 基线「764/765，唯一红=desktop-entry」预计已过期（tools-contract 用例 3 疑为第 2 枚红），首轮请一并贴出实际总数。

---

## QD 纪律

- 不写任何业务代码
- 不改任何 src/ 文件
- 并行期不跑全量测试（T-3）
- 不阻塞三席（T-4）：发现问题写进 progress，不喊停
- 每阶段完成：落 `progress/qd-Ax-<HHmm>.md`，然后回本文件把 [ ] 改 [x]

## 跨域需求写这里（PM 会读）

> QD 不裁决、不喊停（T-4），只把"必须有人定"的口径冲突提上来。三条，均可从 progress 复跑取证。

1. **R4 规则与席3 自身任务互斥 —— 请 PM/主开发二选一**（取法：`node_modules/.bin/tsx tools/audit/boundary.ts` → EXIT=1）
   `seat3-harness.md` S4 定的 R4 = 「`tools/**` 只许 import `src/shared/**`」，但同席 S3 的 fixture 19–28 要覆盖 `MessageHistory` / `TaskLoop`（都在 `src/host/kernel/`），S1 的 metrics 报告要复用 `AgentLoopEvent`（在 `src/host/`）→ **规则与任务不能同时成立**。两条出路请点一条：
   - (a) R4 开豁免：`import type` 豁免 + `tools/eval|metrics` 目录豁免（改动小，规则弱化）；
   - (b) 把内核契约类型下沉到 `src/shared/`（改动大，方向干净）。
   QD 倾向 (a) 先解红、(b) 随 M2-2 后续再谈，但不代三席定。
2. **跨席同步漏：`TaskLoopStopReason` 加值未同步契约白名单**（取法：`tsx tools/contract/check.ts` → EXIT=1；`sed -n '32,37p;88,101p' src/host/kernel/task-loop.ts`）
   席1 S4（11:48）新增第 5 值 `empty-response`，实现与函数注释都对（`:99` 判停、`:88` 优先级已写死）；席3 守门 `tools/contract/check.ts:137` 白名单仍硬编码 4 值 → **现贴红**。首轮 A2 票曾把这误判为"席3 虚报 exit 0"，已在 `qd-a2-…1149.md` §8.1 订正：席3 11:37 跑绿时源码确为 4 值，**无人虚报，是同步漏**。
   请派三件小活：① 席3 白名单加 `'empty-response'` + `:122` 注释"四个"改"五个"；② 席1 把 `task-loop.ts:17-21` **文件头 docstring** 的优先级补上 `empty-response`（现在仍写 `timeout > completed > no-tool-calls`，与 `:88` 自相矛盾，读头注释会得到错答案）；③ PM 立纪：**改枚举成员必须同批改契约白名单**（本次唯一真漏）。
3. **`src/shared/harness-metrics.ts` 作者认领 + `src/host/kernel/` 独占口径修正**
   该文件在席2 纪律的"冻结区"里，却是 untracked 新增、无人 progress 认领（判为 A 线 M0-2 产物）；`src/host/kernel/` 内 `message-history.ts`(10:44)、`pi-transport-probe.ts`(10:47) mtime 均早于席1 路线图建立(11:22) → **"kernel 目录属席1 独占"这条边界不成立**，QD 下轮无法据纪律做归属判定。请主开发在 progress 里认领，或把路线图纪律改成"目录混面 + 文件级归属"。
