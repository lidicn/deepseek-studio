# ORD-005 · token 估算 + cost 累计纯函数包 进度回报

## 1. 验收命令原始输出

### 1.1 `npx vitest run tests/desktop/capabilities-token-cost.test.ts`
```
 ✓ tests/desktop/capabilities-token-cost.test.ts (9 tests) 23ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### 1.2 `npm run typecheck`
```
> tsc --noEmit
TC_EXIT=0
```

## 2. 新建文件清单
- `src/capabilities/token-cost.ts`
- `tests/desktop/capabilities-token-cost.test.ts`

## 3. 边界声明
- 是否碰过禁止区：否
- 未做项：真实计价表由主进程按引擎配置注入；工具注册由主进程做

## 4. 设计要点
- 导出 `estimateTokens(text)`（CJK≈1/字，拉丁≈4 字符/token，供无 usage 回包时估算）、`zeroCost()`、`addUsage(state, usage, pricePer1k)`、`trackUsage(input)`。
- 累计可加、可 reset；cost 按 prompt/completion 分别计价（USD/1k tokens）。
- 空输入/非法输入不崩；`trackUsage(null)`→`invalid-argument`。

## 5. 遗留问题
无。
