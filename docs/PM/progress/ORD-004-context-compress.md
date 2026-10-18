# ORD-004 · 上下文压缩纯函数包 进度回报

## 1. 验收命令原始输出

### 1.1 `npx vitest run tests/desktop/capabilities-context-compress.test.ts`
```
 ✓ tests/desktop/capabilities-context-compress.test.ts (4 tests) 15ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

### 1.2 `npm run typecheck`
```
> tsc --noEmit
TC_EXIT=0
```

## 2. 新建文件清单
- `src/capabilities/context-compress.ts`
- `tests/desktop/capabilities-context-compress.test.ts`

## 3. 边界声明
- 是否碰过禁止区：否
- 未做项：不调模型做语义摘要（纯规则折叠）；工具注册由主进程做

## 4. 设计要点
- 输入：`{ history: {role,content}[], budget?, recentWindow? }`。
- 策略：system 消息恒保留；末尾 recentWindow（默认 4）条原文保留（含最新 user）；更早消息折叠成一条 `[历史摘要]`；仍超预算则从尾部非 user 消息截断。
- 非数组 history→`invalid-argument`；空数组不崩。

## 5. 遗留问题
无。
