# v0.14.34 发版说明

发布日期：2026-11-25（tag `v0.14.34`；本版修复**模型照抄提示词里的中文占位调 mcp_call，连发十多枚 invalid-tool-json 才摸到正确形态**）

## 这版修了什么

### 1. mcp_call 占位参数被照抄（`1ddc3c6`）

**现象**：真机会话里模型连发 **12 枚 `mcp_call` 全部 `invalid-tool-json`**——目录行写的是占位式参数说明「serverId、tool、args（参数对象）」、调用方式示例写的是中文占位 `{"serverId":"服务器名","tool":"工具名",…}`，模型把中文占位**原样当 JSON 参数发出**，靠反复试错才摸到正确形态。与上版 memory_save 抢跑同族：提示词自身在教模型照抄。

**修复**（全在提示词常量，零执行逻辑改动）：

1. 两份目录行（首段＋续跑）的 `mcp_call` 参数说明改**可执行形态**：参数名、类型、来源（`serverId`＝设置里已启用的服务器 id、`tool`＝`mcp_list` 返回的该服务器工具名、`args`＝该工具入参 JSON 对象）＋最小合法示例 `{"serverId":"example","tool":"example","args":{}}`（两份逐字一致）；
2. `formatMcpToolsBlock` 的「调用方式」示例（现场 12 枚报错的直接照抄源）：中文占位 `服务器名/工具名` → 中性 `example/example`；
3. 同族排查：目录 10 枚行中占位式仅 mcp_call 一处；源码内 `服务器名` 清零（余「工具名」均为注释/散文说明，非 JSON 模板）。

**断言变动（经 PM 批准）**：`catalog-budget.test.ts` 的本地镜像与验收断言串随源改（`服务器名/工具名`→`example/example`），属断言跟随源码事实，非放宽判据。

上版修复（memory_save 轮首抢跑、可用技能清单块）行为未动。

## 验证

- 全量闸 **exit=0**（GATE#130，1623.7s），vitest **341 files／3776 passed／1 skipped**；entry-freshness PASS `6169B85F`（重建 entry.js 484,610 B）
- CI run **45483093375**（head `1ddc3c6`）：success
- 新测试件 `tests/desktop/mcp-call-catalog.test.ts` 四格：mcp_call 行带形态示例（合法 JSON 可解析）＋来源／两份目录行逐字一致／`toolCatalogNames` 集合 10 枚不变／「调用方式」示例不再含中文占位（现场根子 guard）
- 独立窄面 9 件 **82/82**＋tsc EXIT=0
- 仓外负控：撤形态示例＋调用方式改回中文占位 ⇒ ①②④ 格红（靶心命中；变异后副本 SHA 恰＝上版入库态，精确证明撤的就是本版那枚增量）；还原复绿、真树 SHA 全程未动
