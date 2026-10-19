# 席 3 路线图・Harness 工具链

> 建立 2026-10-17 11:26 | 制度 R1 | PM 维护，席位只改状态标记

## ⚡⚡⚡ 开工指令（14:25）⚡⚡⚡

**M3 真机验收已通过。你现在一口气做完 S22→S23→S24→S25，不要做一个停一个。**



* S22: M3 全仓符号清零复核（0.5d）

* S23: nudgeRate 脚本固化（0.3d）

* S24: gate 加真机冒烟（0.3d）

* S25: CI 加覆盖率 + E2E（0.5d）

做完一个勾一个，落 progress，立刻做下一个。全部做完再停。



***

## 长目标（一句话）

**把「系统是对的」这件事变成可执行的证据**：任何人跑一条命令，就能知道内核、引擎、工具协议是否还符合契约；任何一次改动，都能立刻看到有没有破坏既有能力。

**完成标志**：npm run gate 一条命令跑完 静态审计 + 契约守门 + eval + 指标 四类检查，全绿则系统可信。



***

## 远期目标包（12:25 更新，PM 给方向，你自己拆阶段）

### 目标：harness 成为一键可信验证工具链

> 这不是一个小任务，是你接下来 1-2 天的全部工作。
>
> **你自己拆阶段、自己排顺序、自己定验收。**

**最终交付物**：调用方跑一条命令就能知道整个系统是否可信：



```
npm run gate
# → 静态审计 + 契约守门 + eval + 指标 + 覆盖率 + CI 配置
# → 全绿输出 ✅，红了输出具体哪个文件哪行
```

**这个工具链必须具备的能力**（你自己拆成阶段实现）：



1. 静态边界审计（已有）

2. 契约守门（已有）

3. eval fixtures（已有 28 个，扩到 40+）

4. 一键 gate 脚本（已有框架，增强输出）

5. 覆盖率门禁（简易版已有，细化阈值）

6. JSONL replay mock（已有）

7. M3 符号清零审计（已有）

8. GitHub Actions CI（已有）

9. E2E 脚手架（已有）

10. 性能基准（已有）

11. 文档漂移审计（QD A8 提的，你做）

12. 安全审计清单（QD A9 提的，你做）

**约束**：



* 只写 `tools/**`、`tests/desktop/tools-*.test.ts`、`tests/desktop/metrics-*.test.ts`、`.github/**`、`package.json`

* 绝不碰 src 下任何 .ts

* 每完成一个能力，落 progress 文件，然后继续下一个

* **不要停下来等 PM。拆完阶段就开干。**

* 真机 nudgeRate（S13）等里程碑，不做



***

## 已完成阶段（参考，不用重做）

S1-S12、S14-S15 已完成。剩下的能力你自己拆。



***

## 阶段序列（历史记录）

### S1・metrics CLI（D1 取数工具）\[x]



* 落点：tools/metrics/report.ts + tools/metrics/README.md + tools/metrics/samples/ + tests/desktop/metrics-report.test.ts

* 内容：JSONL 日志格式、D1 PASS/FAIL 判定、退出码三态（0/1/2）、复用 createHarnessMetrics 不自己重算

* 验收：npx vitest run tests/desktop/metrics-report.test.ts 全绿

* 结果：已交付（report.ts 5009B / 167 行；测试 4206B / 118 行）

### S2・契约守门（contract guard）\[x]



* 落点：tools/contract/check.ts、tests/desktop/tools-contract.test.ts、tools/contract/README.md

* 结果：11 用例（3 正例 + 8 反例），CLI exit 0

* 目标：把 ModelEngine / MessageHistory / TaskLoop 的接口契约固化为可执行断言。任何席位改坏契约，这一步立刻红。

* 落点：tools/contract/check.ts（新建）、tests/desktop/tools-contract.test.ts（新建）、tools/contract/README.md（新建）

* 要点：


  * ModelEngine 必须导出的成员清单：从 model-engine.ts 实际导出抓取，不要手抄

  * MessageHistory：snapshot 的 version 必须为 1；restore 版本不符必须抛错

  * EngineSendResult：toolCalls 必须仍是 number 类型（additive 扩展不能把它改成必填对象）

  * TaskLoop：stopReason 必须只有四个合法值

  * 实现方式：静态读源码做断言，不 import 运行（避免副作用与循环依赖）

* 验收：npx vitest run tests/desktop/tools-contract.test.ts，用例 >= 10

* 估时：1d

### S3・eval fixtures 扩展（覆盖新内核）\[x]



* 落点：tools/eval/fixtures/19-28（10 个）、tools/eval/run.ts（加 10 case + async）

* 结果：28/28 pass

* 目标：现有 18 个 fixtures 只覆盖 tool-contract /result-format/continuation /policy。内核三件（MessageHistory / ToolProtocol / TaskLoop）一个 fixture 都没有。

* 落点：tools/eval/fixtures/19 至 28 共 10 个新 JSON、tools/eval/run.ts（加对应 case）、tools/eval/README.md（更新清单）

* 要点：


  * 19 至 21：MessageHistory 的 snapshot /restore/ 版本不符抛错

  * 22 至 24：ToolCallRecord 结构、toolCallRecords 可选性（undefined 时老路径不崩）

  * 25 至 27：TaskLoop stopReason 四态判定

  * 28：判停优先级 timeout 高于 completed 高于 empty-response 高于 no-tool-calls

  * 每个 fixture 必须能独立跑，不依赖其它 fixture 的状态

* 验收：npm run eval:golden，total >= 28 且 pass 等于 total

* 估时：1.5d

### S4・静态审计（boundary audit）\[x]



* 落点：tools/audit/boundary.ts、tests/desktop/tools-audit.test.ts

* 结果：8 用例（4 反例 + 4 正例），四条规则

* 目标：把「谁能 import 谁」这条纪律变成可执行检查，防止边界腐化。这是防止三席并行把架构搞乱的唯一机械手段。

* 落点：tools/audit/boundary.ts（新建）、tests/desktop/tools-audit.test.ts（新建）

* 规则（四条，缺一不可）：


  * 规则 1：src/host/kernel/\*\* 不许 import web-engine（只能 import model-engine 的类型）

  * 规则 2：src/host/engine/\*\* 不许 import kernel/\*\*

  * 规则 3：src/shared/\*\* 不许 import src/host/\*\*（依赖方向只能向下）

  * 规则 4：tools/\*\* 只许 import src/shared/**，不许 import src/host/**

* 输出：违规文件清单 + 规则号；有违规则退出码非 0

* 验收：npx vitest run tests/desktop/tools-audit.test.ts，用例 >= 8，其中至少 4 个是反例断言（构造一个违规文件字符串，断言能被抓出来）

* 估时：1d

### S5・一键闸门（gate）\[x]



* 落点：tools/gate/run.ts、package.json（+gate script）

* 结果：串行 typecheck→audit→contract→eval→metrics

### S6・Harness 自证报告 \[x]



* 落点：docs / 架构文档 / Harness 自证报告 - 20261017.md

### S7・M3 符号清零审计  \[x]



* 落点：tools/audit/symbols.ts + tests/desktop/tools-symbols.test.ts

* 结果：6 用例

### S8・性能基准（benchmark）  \[x]



* 落点：tools/bench/run.ts + tests/desktop/tools-bench.test.ts

* 结果：TaskLoop P50=0.012ms /snapshot P50=0.002ms /audit=0.5ms

### S9・测试覆盖率门禁  \[x]



* 落点：tools/coverage/check.ts

* 结果：kernel 100% (5/5) /engine 100% (3/3)

### S14 · GitHub Actions CI  \[x]



* 落点：.github/workflows/ci.yml

* 结果：typecheck + vitest on push/PR

### S15・E2E 集成测试脚手架  \[x]



* 落点：tools/e2e/runner.ts + tools/e2e/fixtures/simple-task.json

* 结果：replay mock + TaskLoop 端到端跑通

### S10・JSONL 持久化工具（offline replay）  \[x]



* 落点：tools/metrics/replay.ts + tests/desktop/metrics-replay.test.ts

* 结果：6 用例，JSONL → ModelEngine mock

### S11・Harness 终态报告  \[x]



* 落点：docs / 架构文档 / Harness 终态报告 - 20261017.md

### S12・M3 全仓符号清零审计  \[x]



* 落点：tools/audit/m3-clean.ts + tests/desktop/tools-m3-clean.test.ts

* 结果：5 用例，白名单 tests/docs/tools

### S13・真机 nudgeRate 取数脚本  \[ ]（阻塞：需要用户启动真实网页，先跳过，做完 S14/S15 再回来）



* **⚠️ 本阶段阻塞，不要停下来等 PM 或用户。做完 S14/S15 再回来。**

* 阻塞原因：需要真实 DeepSeek 网页环境（Electron + 登录态），席 3 无法自行启动

* 目标（未来做时参考）：在真实 DeepSeek 网页上跑 50 轮，记录每轮是否被 nudge，出真实 nudgeRate 数字

* 落点：`tools/metrics/live-nudge-rate.ts`（新建，未来）

* 未来要点：


  * 用 WebEngine（席 2 的）连真实网页

  * 跑 50 轮，每轮记录 stopReason

  * 输出：nudgeRate = nudge 次数 / 总轮次，写 JSON

* 验收（未来）：能跑出 50 轮 JSON 报告

* 估时（未来）：2d（不含用户配合时间）

### S14 · GitHub Actions CI  \[x]



* 落点：.github/workflows/ci.yml

* 结果：typecheck + vitest on push/PR

### S15・E2E 集成测试脚手架  \[x]



* 落点：tools/e2e/runner.ts + fixtures/simple-task.json

* 结果：replay mock + TaskLoop 端到端跑通

### S16・eval fixtures 扩充到 40 个  \[x]



* 落点：tools/eval/fixtures/29-40（8 个新增）+ run.ts 加 8 case

* 结果：40/40 pass

### S17・gate 脚本增强  \[x]



* 落点：tools/gate/run.ts

* 结果：✅/❌ 输出格式

### S18・覆盖率门禁阈值细化  \[x]



* 结果：kernel 100% (5/5) /engine 100% (3/3)，阈值达标

### S19・Harness 终态报告更新  \[x]



* 落点：docs / 架构文档 / Harness 终态报告 - 20261017.md

### S20・文档漂移审计  \[x]



* 落点：tools/audit/doc-drift.ts + tests/desktop/tools-doc-drift-security.test.ts

* 结果：6 用例，验证文档接口与 src 一致

### S21・安全审计清单  \[x]



* 落点：tools/audit/security.ts

* 结果：扫 eval/innerHTML/ 硬编码密钥，白名单 tests/docs/tools



***

## 后续阶段（等真机验收后开始）

### S22・M3 全仓符号清零复核  \[x]



* 落点：tools/audit/m3-clean.ts（跑一次）

* 结果：检出残留在 src/inject + src/shared（冻结区，待席 2 删）

### S23・真机 nudgeRate 取数（席 5 跑完后）  \[x]



* 落点：tools/metrics/live-nudge-rate.ts（席 5 已建）

* 结果：支持 --rounds/--timeout，输出每轮 JSON + 汇总

### S24・gate 加入真机冒烟  \[x]



* 落点：tools/gate/run.ts

* 结果：gate --live 追加 live-nudge-rate 步骤

### S25・CI 加入覆盖率 + E2E  \[x]



* 落点：.github/workflows/ci.yml

* 结果：CI 加 coverage/boundary/doc-drift/security/e2e 五步



***

## 席位纪律



* 只写 tools/\*\* 与 tests/desktop/tools-*.test.ts、tests/desktop/metrics-*.test.ts、package.json

* 绝不改 src 下任何 .ts（kernel 是席 1 的、engine 是席 2 的、shared 是冻结区）

* package.json 每次只加一行 script，改完贴 git diff package.json 自证

* 每阶段完成：落 docs/PM/progress/seat3-Sx-yyyymmdd-HHmm.md，然后回本文件把方括号改勾

* 改完立刻做下一阶段，不要停下来等 PM

## 跨域需求写这里（PM 会读）

（暂无）