# tools/contract — 契约守门（S2）

静态读源码做断言，不 import 运行。任何席位改坏以下契约，本工具立刻红。

## 守门对象

| 模块 | 契约 |
|---|---|
| ModelEngine | 导出齐全；`toolCalls` 必须是 `number`；`toolCallRecords` 必须可选 |
| MessageHistory | `MESSAGE_HISTORY_VERSION = 1`；snapshot.version 字面量 1；restore 版本不符抛错 |
| TaskLoop | `TaskLoopStopReason` 恰好四个值：completed / no-tool-calls / timeout / max-rounds |

## 用法

```bash
npx tsx tools/contract/check.ts
```

退出码：0=全过  1=有违规
