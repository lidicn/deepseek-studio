# ORD-003 · web.search 纯函数包 进度回报

## 1. 验收命令原始输出

### 1.1 `npx vitest run tests/desktop/capabilities-web-search.test.ts`
```
 ✓ tests/desktop/capabilities-web-search.test.ts (8 tests) 21ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

### 1.2 `npm run typecheck`
```
> tsc --noEmit
TC_EXIT=0
```

## 2. 新建文件清单
- `src/capabilities/web-search.ts`
- `tests/desktop/capabilities-web-search.test.ts`

## 3. 边界声明
- 是否碰过禁止区：否
- 未做项：真实搜索通道由主进程注入（fixtures 注入）；工具注册由主进程做

## 4. 设计要点
- 导出 `buildSearchQuery(query)`（归一+编码）与 `webSearch(input)`。
- 输入：`{ query, fixtures?, limit? }`；缺 query→`missing-argument`；无 fixtures→`workspace-unconfigured`。
- 解析容错：容忍 `{results}`/`{items}`/`{data:{results}}`/直接数组；每条容忍 title/name/headline、url/link/href、snippet/description/summary；坏 fixture 返回空 items 不崩。

## 5. 遗留问题
无。
