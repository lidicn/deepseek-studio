# 席3 路线图 · Harness 工具链

> 建立 2026-10-17 11:26 | 制度 R1 | PM 维护，席位只改状态标记

## 长目标（一句话）

**把「系统是对的」这件事变成可执行的证据**：任何人跑一条命令，就能知道内核、引擎、工具协议是否还符合契约；任何一次改动，都能立刻看到有没有破坏既有能力。

**完成标志**：npm run gate 一条命令跑完 静态审计 + 契约守门 + eval + 指标 四类检查，全绿则系统可信。

---

## 阶段序列（串行，做完一个立刻做下一个）

### S1 · metrics CLI（D1 取数工具）[x]

- 落点：tools/metrics/report.ts + tools/metrics/README.md + tools/metrics/samples/ + tests/desktop/metrics-report.test.ts
- 内容：JSONL 日志格式、D1 PASS/FAIL 判定、退出码三态（0/1/2）、复用 createHarnessMetrics 不自己重算
- 验收：npx vitest run tests/desktop/metrics-report.test.ts 全绿
- 结果：已交付（report.ts 5009B / 167 行；测试 4206B / 118 行）

### S2 · 契约守门（contract guard）[x]

- 落点：tools/contract/check.ts、tests/desktop/tools-contract.test.ts、tools/contract/README.md
- 结果：11 用例（3 正例 + 8 反例），CLI exit 0

- 目标：把 ModelEngine / MessageHistory / TaskLoop 的接口契约固化为可执行断言。任何席位改坏契约，这一步立刻红。
- 落点：tools/contract/check.ts（新建）、tests/desktop/tools-contract.test.ts（新建）、tools/contract/README.md（新建）
- 要点：
  - ModelEngine 必须导出的成员清单：从 model-engine.ts 实际导出抓取，不要手抄
  - MessageHistory：snapshot 的 version 必须为 1；restore 版本不符必须抛错
  - EngineSendResult：toolCalls 必须仍是 number 类型（additive 扩展不能把它改成必填对象）
  - TaskLoop：stopReason 必须只有四个合法值
  - 实现方式：静态读源码做断言，不 import 运行（避免副作用与循环依赖）
- 验收：npx vitest run tests/desktop/tools-contract.test.ts，用例 >= 10
- 估时：1d

### S3 · eval fixtures 扩展（覆盖新内核）[x]

- 落点：tools/eval/fixtures/19-28（10 个）、tools/eval/run.ts（加 10 case + async）
- 结果：28/28 pass

- 目标：现有 18 个 fixtures 只覆盖 tool-contract / result-format / continuation / policy。内核三件（MessageHistory / ToolProtocol / TaskLoop）一个 fixture 都没有。
- 落点：tools/eval/fixtures/19 至 28 共 10 个新 JSON、tools/eval/run.ts（加对应 case）、tools/eval/README.md（更新清单）
- 要点：
  - 19 至 21：MessageHistory 的 snapshot / restore / 版本不符抛错
  - 22 至 24：ToolCallRecord 结构、toolCallRecords 可选性（undefined 时老路径不崩）
  - 25 至 27：TaskLoop stopReason 四态判定
  - 28：判停优先级 timeout 高于 completed 高于 empty-response 高于 no-tool-calls
  - 每个 fixture 必须能独立跑，不依赖其它 fixture 的状态
- 验收：npm run eval:golden，total >= 28 且 pass 等于 total
- 估时：1.5d

### S4 · 静态审计（boundary audit）[x]

- 落点：tools/audit/boundary.ts、tests/desktop/tools-audit.test.ts
- 结果：8 用例（4 反例 + 4 正例），四条规则

- 目标：把「谁能 import 谁」这条纪律变成可执行检查，防止边界腐化。这是防止三席并行把架构搞乱的唯一机械手段。
- 落点：tools/audit/boundary.ts（新建）、tests/desktop/tools-audit.test.ts（新建）
- 规则（四条，缺一不可）：
  - 规则1：src/host/kernel/** 不许 import web-engine（只能 import model-engine 的类型）
  - 规则2：src/host/engine/** 不许 import kernel/**
  - 规则3：src/shared/** 不许 import src/host/**（依赖方向只能向下）
  - 规则4：tools/** 只许 import src/shared/**，不许 import src/host/**
- 输出：违规文件清单 + 规则号；有违规则退出码非 0
- 验收：npx vitest run tests/desktop/tools-audit.test.ts，用例 >= 8，其中至少 4 个是反例断言（构造一个违规文件字符串，断言能被抓出来）
- 估时：1d

### S5 · 一键闸门（gate）[x]

- 落点：tools/gate/run.ts、package.json（+gate script）
- 结果：串行 typecheck→audit→contract→eval→metrics

### S6 · Harness 自证报告 [x]

- 落点：docs/架构文档/Harness自证报告-20261017.md

### S7 · M3 符号清零审计  [x]

- 落点：tools/audit/symbols.ts + tests/desktop/tools-symbols.test.ts
- 结果：6 用例

### S8 · 性能基准（benchmark）  [x]

- 落点：tools/bench/run.ts + tests/desktop/tools-bench.test.ts
- 结果：TaskLoop P50=0.012ms / snapshot P50=0.002ms / audit=0.5ms

### S9 · 测试覆盖率门禁  [ ]

- 目标：核心 kernel/engine 目录覆盖率不低于阈值，掉了就红
- 落点：`tools/coverage/check.ts`（新建）+ package.json（+1 line）
- 要点：
  - 不引 c8 / nyc，用 vitest 自带的 --coverage 输出 JSON 解析
  - 阈值：src/host/kernel/** >= 80%、src/host/engine/** >= 70%
  - 低于阈值 exit 非 0
- 验收：手动跑一次输出真实数字
- 估时：1d

### S10 · JSONL 持久化工具（offline replay）  [ ]

- 目标：让 CLI 不仅能吃 JSONL 出报告，还能把 JSONL 回放成 mock 引擎
- 落点：`tools/metrics/replay.ts`（新建）+ 测试追加
- 要点：
  - 输入一份 JSONL 日志，输出一个实现 ModelEngine 接口的 mock 引擎
  - mock 引擎按日志顺序返回 chat completions（content / toolCalls / completion）
  - 让 kernel 测试能用真实录制数据跑，不需要假引擎
- 验收：用例 >= 6
- 估时：1d

### S11 · Harness 终态报告  [ ]

- 目标：在所有阶段完成后，输出一份终态 harness 完整度报告
- 落点：`docs/架构文档/Harness终态报告-20261017.md`
- 要点：
  - 四类检查（审计 / 契约 / eval / 指标）各自覆盖了什么
  - 已知盲区清单
  - 跑一次 `npm run gate` 贴原始输出
  - benchmark 数字表
- 验收：文件存在
- 估时：0.5d

---

## 席位纪律

- 只写 tools/** 与 tests/desktop/tools-*.test.ts、tests/desktop/metrics-*.test.ts、package.json
- 绝不改 src 下任何 .ts（kernel 是席1 的、engine 是席2 的、shared 是冻结区）
- package.json 每次只加一行 script，改完贴 git diff package.json 自证
- 每阶段完成：落 docs/PM/progress/seat3-Sx-yyyymmdd-HHmm.md，然后回本文件把方括号改勾
- 改完立刻做下一阶段，不要停下来等 PM

## 跨域需求写这里（PM 会读）

（暂无）