# 统一契约文件 · 三席单一真相源

> 2026-10-17 13:00 | PM 维护
> **三席所有接口定义以本文件为准。改接口必须先改这里，再改代码。**
> `tools/contract/check.ts` 的白名单从这里生成。

---

## 1. ModelEngine 接口

**文件**：`src/host/engine/model-engine.ts`

```typescript
interface ModelEngine {
  name: 'web' | 'api';
  health(): Promise<{ ok: boolean; reason?: string }>;
  send(text: string): Promise<EngineSendResult>;
  waitForNextReply?(): Promise<EngineSendResult>;  // 可选
  destroy?(): void;  // 可选
}
```

### EngineSendResult

```typescript
interface EngineSendResult {
  content: string;           // 回复文本
  toolCalls: number;         // 工具调用次数（不是数组，是数字）
  toolCallRecords?: ToolCallRecord[];  // 可选，详细工具记录
  completion: CompletionStatus;        // 完成状态
  timedOut?: boolean;        // 可选
}
```

### CompletionStatus（合法值）

```
'complete' | 'truncated' | 'disconnected' | 'unknown'
```

**白名单**（contract check 硬编码）：`['complete', 'truncated', 'disconnected', 'unknown']`

### ToolCallRecord

```typescript
interface ToolCallRecord {
  tool: string;      // 工具名，如 'shell.exec'
  ok: boolean;       // 是否成功
  error?: string;    // 失败原因
}
```

---

## 2. TaskLoopStopReason（合法值）

**文件**：`src/host/kernel/task-loop.ts`

```
'completed' | 'no-tool-calls' | 'timeout' | 'max-rounds' | 'empty-response' | 'aborted'
```

**优先级**（判停顺序，从高到低）：

```
timeout > completed > empty-response > no-tool-calls > aborted
```

**白名单**（contract check 硬编码）：
```javascript
['completed', 'no-tool-calls', 'timeout', 'max-rounds', 'empty-response', 'aborted']
```

**⚠️ 加新值必须同时改**：
1. 本文件第 2 节
2. `tools/contract/check.ts` 白名单
3. `src/host/kernel/task-loop.ts` 类型定义
4. 对应测试用例

---

## 3. MessageHistorySnapshot

**文件**：`src/host/kernel/message-history.ts`

```typescript
interface MessageHistorySnapshot {
  version: 1;           // 必须是字面量 1，不能是 2
  messages: Message[];
}
```

**版本规则**：
- 版本号是字面量 `1`，不是 `number`
- 未来改格式必须升到版本 `2`，并在 load() 时对旧版本抛错
- 当前白名单：`version === 1`

---

## 4. 文件域铁律

| 席 | 只许写 | 绝不碰 |
|---|---|---|
| 席1 kernel | `src/host/kernel/**` | `src/host/engine/**`、`tools/**`、`src/inject/**` |
| 席2 engine | `src/host/engine/**` | `src/host/kernel/**`、`tools/**`、`src/inject/**` |
| 席3 harness | `tools/**` | `src/` 下任何 `.ts` |
| 席4 QA | 测试文件、类型标注 | 业务逻辑 |
| 席5 验收 | 不写代码 | 任何 src/ |

### R4 豁免规则（PM 13:00 批准）

- `tools/eval/**`、`tools/bench/**`、`tools/e2e/**`、`tools/metrics/**` 这四个目录**允许 import `src/host/**` 的类型**
- 原因：评测工具本来就需要驱动 kernel/engine 才有意义，R4 原规则"tools 只许 import shared"对这四个目录过严
- 其他 tools 子目录仍遵守 R4（只许 import shared）
- R3（harness-metrics → agent-loop 类型依赖）暂不处理，M3 删旧代码时自然消失

---

## 5. 改接口的流程

1. 先改本文件（`docs/PM/roadmap/CONTRACTS.md`）
2. 再改 `tools/contract/check.ts` 白名单
3. 再改代码
4. 再改测试
5. 跑 `npm run typecheck && npx vitest run` 确认全绿

**不允许只改代码不改白名单。** 上次 `empty-response` 就是因为没同步白名单导致 contract guard 红了一轮。
