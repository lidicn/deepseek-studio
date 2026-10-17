# 席4 路线图 · QA / 守门

> 建立 2026-10-17 12:20 | 制度 R1 | PM 维护
> 定位：专门跑测试、修类型错、定位失败用例。不写业务逻辑，只修编译/测试层面的错。

## ⚡⚡⚡ 你现在立刻做这个（13:10）⚡⚡⚡

**先做 R4 豁免，再守门。**

1. 打开 `tools/audit/boundary.ts`
2. 找到 R4 规则（tools 只许 import shared）
3. 加豁免：`tools/eval/**`、`tools/bench/**`、`tools/e2e/**`、`tools/metrics/**` 这四个目录允许 import `src/host/**` 的类型
4. 跑 `npx tsx tools/audit/boundary.ts` 确认 EXIT=0
5. 跑 `npm run gate` 确认全绿
6. 落 progress 文件

**做完再开始 Q5 守门。不要等。**

---

## 阶段序列

### Q1 · 当前 typecheck 错清零  [x]

- 结果：EXIT=0

### Q2 · vitest 全量跑绿  [x]

- 结果：96 文件 / 1027 用例全过

### Q3 · contract guard 更新  [x]

- 结果：白名单已补 'aborted'，通过

### Q4 · gate 跑通  [x]

- 结果：4/5 绿，boundary-audit 14 条为历史债（见下）

### Q4 裁决 · boundary-audit 豁免（PM 13:05）

> **14 条 boundary 违规是历史债，不是本轮引入的。不阻塞当前开发。**
>
> 裁决：
> 1. R3（1 条 harness-metrics → agent-loop 类型依赖）：暂不处理，M3 删旧代码时自然消失
> 2. R4（13 条 tools → src/host 评测工具依赖）：这是合理的——评测工具本来就需要驱动 kernel。**修改 R4 规则：tools/eval|bench|e2e|metrics 豁免 import src/host 的类型**
> 3. 席4 现在改 `tools/audit/boundary.ts`，把 tools/eval|bench|e2e|metrics 加入豁免列表
> 4. 改完跑 gate 确认全绿

### Q5 · 持续守门  [ ]

- 目标：三席每落一个 progress 文件，跑一轮 typecheck + vitest 确认绿
- 做法：
  1. 每 30 分钟扫 progress/ 目录
  2. 有新文件就跑 typecheck + vitest
  3. 红了就修（类型/测试层），绿了就写 progress
- 验收：持续滚动

---

## 席位纪律

- 只修类型错、测试错、import 错、mock 错
- **不改业务逻辑**：不改 kernel/engine 的运行时行为，不改 stopReason 语义，不改接口设计
- 改了业务逻辑就是越界，写 progress 报告给 PM 决定
- 每阶段完成：落 `docs/PM/progress/seat4-Qx-yyyymmdd-HHmm.md`
- 修完立刻做下一阶段，不要停
