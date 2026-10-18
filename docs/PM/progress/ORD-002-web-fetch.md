# ORD-002 · web.fetch 纯函数包 进度回报

## 1. 验收命令原始输出

### 1.1 `npx vitest run tests/desktop/capabilities-web-fetch.test.ts`
```
 ✓ tests/desktop/capabilities-web-fetch.test.ts (8 tests) 43ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```
（4 文件合并跑：4 passed / 29 passed；本文件 8 passed）

### 1.2 `npm run typecheck`
```
> tsc --noEmit
TC_EXIT=0
```

## 2. 新建文件清单
- `src/capabilities/web-fetch.ts`
- `tests/desktop/capabilities-web-fetch.test.ts`

## 3. 边界声明
- 是否碰过禁止区：否
- 未做项：不真连网络（transport 由主进程注入）；工具注册由主进程做

## 4. 设计要点（规格未封死，自定，待主进程接线时校准）
- 输入：`{ url, transport?, timeoutMs?, maxBytes?, maxRedirects? }`；`transport` 为注入取页函数，缺省 fail-closed 返回 `io-error`。
- 错误码：缺 url→`missing-argument`；非 http(s)/坏 Location→`invalid-argument`；无 transport/超时/传输失败→`io-error`；正文超 maxBytes / 重定向超 maxRedirects→`limit-exceeded`。
- 正文抽取：去 script/style/noscript/注释，去标签，解基础实体，压缩空白，抽 `<title>`，正文截 20k 字符。

## 5. 遗留问题
无。
