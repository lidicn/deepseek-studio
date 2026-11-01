# MemoryStore 巨石重构：第 1 步基线 + 三处待裁决点（Core）

- 日期：2026-11-01
- 卡：PM 派的「memory-store.ts 巨石重构」主线，唯一实现者
- 设计稿：`docs/设计稿/MemoryStore-巨石文件重构-20261101.md`（Lever-Hub2 产出，gate pass）
- 状态：**第 1 步（冻结基线）完成**；第 2 步入口遇到设计稿内部冲突，需 PM 裁决后继续

---

## 一、第 1 步：基线冻结（已完成）

### 1.1 行为基线

全量 memory 测试（12 个文件）：**136 例全绿**，用时 140.5 s。

```
tests/desktop/memory-archive-lifecycle.test.ts
tests/desktop/memory-audit-encryption.test.ts
tests/desktop/memory-candidates.test.ts
tests/desktop/memory-delete-consent.test.ts
tests/desktop/memory-governance.test.ts
tests/desktop/memory-log.test.ts
tests/desktop/memory-panel.test.ts
tests/desktop/memory-select-regression.test.ts
tests/desktop/memory-store-v2.test.ts
tests/desktop/memory-tool-boundary.test.ts
tests/desktop/memory-workspace.test.ts
tests/desktop/untrusted-memory.test.ts
```

设计稿说「约 140 条」，实际 **136 条**（`memory-select-regression` 8 条 + `memory-panel` 3 条等）。基线以实数为准。

原始输出：`logs/verify-exit/memory-baseline-run.log`

### 1.2 导出面（设计稿 §3.3 的 VALUE_EXPORTS 9 个 + 类型 8 个，**完全吻合**）

值导出 9：`DEFAULT_WORKSPACE_ID` `MAX_MEMORIES` `MemoryStore` `closeMemoryStores` `getMemoryStore` `listWorkspaceIds` `mergeUpdateGovernance` `workspaceSlug` `workspaceStorePath`

类型导出 8：`ExistingGovernanceFields` `MemoryCandidate` `MemoryLogEntry` `MemoryRow` `MemorySaveWarning` `MemoryType` `SaveMemoryParams` `SaveMemoryResult`

合计 **17 个**，与设计稿 A5「17 个符号名全部保留」一致。

### 1.3 其他基线

| 项 | 值 |
|---|---|
| SQL 字符串字面量 | **57 条**（`memory-refactor-scan.mjs` 的 SQL 正则口径） |
| `enc1:` 出现次数 | **0** —— `enc1:` 不在 `memory-store.ts`（在 `audit-crypto.ts`），故本单「`enc1:` 计数不变」自动成立（守恒即 0→0） |
| `MemoryStore` 类成员 | **49** 个（7 个属性 + 42 个方法 + ctor） |
| 类体范围 | L472–L1626；`getMemoryStore` L1637、`closeMemoryStores` L1654 |

基线快照：`logs/verify-exit/memory-baseline.json`（AST 导出面 + SQL 多重集 + `enc1:` 计数 + 类成员行范围）

### 1.4 工具（都在 `logs/verify-exit/`，属我域）

| 文件 | 用途 |
|---|---|
| `memory-refactor-scan.mjs` | AST 提取导出面 / SQL 多重集 / `enc1:` 计数 / 类成员行范围。重构前后各跑一次做 diff |
| `memory-refactor-graph.mjs` | 提取每个方法的 `this.<x>` 引用图与签名，作为归属与 ctx 设计依据 |
| `memory-baseline.json` | 重构前基线快照 |
| `memory-graph.json` | 方法调用图快照 |

---

## 二、方法归属表（43 个方法，设计稿只点名 22 个，其余按设计稿 §设计 2 的域职责 + R7 推定）

设计稿 §设计 2 给出的域职责是：`storage`=save/remove/compact/invalidate/restore/迁移；`retrieval`=search/list/get/formatForPrompt/listInvalidated；`audit`=recordLog/listLog/rollback/forgetAudit；`candidates`=addCandidate/listCandidates/promoteCandidate/rejectCandidate；`core`=打开/PRAGMA/建表与迁移/enc1 加解密/行映射/事务。

未点名的 21 个方法按「域职责描述 + R7（私有 helper 默认留门面，只服务单一域才下沉）」归位：

| 域 | 方法（行号） |
|---|---|
| core | open(498) getDb(544) isInMemoryFallback(549) migrateDedupeHash(557) migrateAuditEncryption(580) migrateLegacyJson(627) loadLegacyJsonIntoFallback(666) close(1390) |
| storage | save(697) remove(964) compact(1035) invalidate(1114) restore(1135) snapshotById(1405) deleteMemoryRow(1487) writeSnapshotRow(1502) prepareEviction(1551) applyEviction(1564) syncFts(1598) |
| retrieval | list(1047) search(1052) listByPersona(1156) formatForPrompt(1163) get(1172) listInvalidated(1184) stats(1373) allRows(1534) validRows(1543) sortRows(1612) applyPersonaFilter(1622) |
| audit | recordLog(1417) listLog(1297) rollback(1343) forgetAudit(1007) |
| candidates | addCandidate(1195) listCandidates(1237) getCandidate(1250) promoteCandidate(1262) rejectCandidate(1279) deleteCandidateRow(1459) insertCandidateRow(1469) |
| 门面（类壳） | ctor(486) getWorkspaceId(1385) + 7 个属性（db/fallback/fallbackCandidates/fallbackLog/storePath/workspaceId/audit） |

合计 8+11+11+4+7+2 = **43** ✓（与 AST 统计一致）

---

## 三、待 PM 裁决的三点

### 决策点 1（**必须裁决**）：「L1-L471 整段冻结」与「core.ts 搬运行映射」冲突

设计稿 D1 写「L1-L471 一行不改」，§文件 2 的 core.ts 搬运区 B 又要求搬「enc1 加解密调用 / **行映射 MemoryRow** / 事务」。

实测：**行映射等 helper 就在 L1-L471 内**——`SCHEMA_SQL`(L289)、`rowToMemory`(L343)、`snapshotOf`(L375)、`rowToCandidate`(L384)、`parseSnapshot`(L399)、`parseSnapshotObject`(L412)、`parseCandidate`(L443)、`parseJsonArray`(L364)、`sha256Hex`(L432)、`snapshotFingerprint`(L437)、`toFtsQuery`(L277)、`likePattern`(L284)、`contentHash`(L206)、`dedupeHash`(L212)、`sameStringArray`(L217)、`isValidMemoryType`(L201)、`genId`(L197)、`legacyJsonPath`(L193)、`pickEviction`(L233)。

同理，types.ts 要搬的 9 个类型定义也都在冻结区内（`MemoryType` L31、`MemoryCandidate` L39、`MemoryLogEntry` L57、`MemoryRow` L145、`SaveMemoryParams` L153、`SaveMemoryResult` L167、`MemorySaveWarning` L179、`MAX_MEMORIES` L225、`ExistingGovernanceFields` L251）。

**我的推荐（A 案）**：**等行占位法**——把这 9 个类型 + 上列 helper 剪切到 `types.ts` / `core.ts`，**在原位置写等行数的占位**（re-export + 注释补齐行数）。这样：

- §1 引用清单里的 14 个行号（76/86/95/125/186/263/472/489/740/801/870/911/1637/1654）**全部保持不变**；
- 那 6 个带 `range_sha` 的已读符号（`workspaceSlug` `workspaceStorePath` `workspaceIndexPath` `listWorkspaceIds` `defaultStorePath` `mergeUpdateGovernance`）**文本与行位一字不动**；
- 被搬走的类型与 helper **文本逐字不变**（只改 `this.`→`ctx.`）。

**B 案（最保守）**：L1-L471 **一个字节都不动**，helper 留在门面，由门面装配时注入 ctx（如 `ctx.rowToMemory = rowToMemory`）。代价：core.ts 变成「只搬类体方法」，`core` 域的职责描述名不副实，且 ctx 字段会显著变多。

**请 PM 确认**：设计稿里 `range_sha` 覆盖的是「那 6 个符号各自的文本范围 + 行号锚」，还是「整个 L1-L471 区间的字节」？
- 若是前者 → 走 A 案；
- 若是后者 → 只能走 B 案，且 ctx 需要承载更多 helper 引用。

### 决策点 2（我按设计稿推定，PM 可否决）：ctx 的字段范围

设计稿 D7 说「StoreContext 只放 3 个注入槽（save/remove/recordLog），够打破环即可，不做成万能 service locator」；但 R3 又规定「方法体唯一允许的文本改动是 `this.` → `ctx.`」，且要求用**归一化哈希自证**。

实测跨域方法调用有 4 处（否则 `this.`→`ctx.` 后无处可去）：

| 调用方 | 被调方 | 所属域 |
|---|---|---|
| `remove` | `forgetAudit` | audit |
| `promoteCandidate` | `snapshotById` | storage |
| `rollback` | `deleteMemoryRow` / `writeSnapshotRow` / `insertCandidateRow` | storage / candidates |
| `prepareEviction` | `validRows` | retrieval |

另外 `this.<属性>` 的访问面也很广：`db` `fallback` `fallbackCandidates` `fallbackLog` `storePath` `audit` `workspaceId`（设计稿 ctx 只列了 `db`/`workspaceId`/`basePath`）。

**我拟定的 ctx 字段（16 个，全部显式、无 index signature，不是万能 locator）**：

- 数据：`db` `workspaceId` `storePath` `fallback` `fallbackCandidates` `fallbackLog` `audit`
- 注入槽（设计稿 D7 的 3 个）：`save` `remove` `recordLog`
- 跨域委托（由门面装配，域模块之间**不互相 import**，无环）：`forgetAudit` `snapshotById` `deleteMemoryRow` `writeSnapshotRow` `insertCandidateRow` `validRows`

这样 R3 的归一化哈希成立（`this.`→`ctx.` 后哈希相等），且满足设计稿「域模块只 import core/types」的无环要求。

### 决策点 3（我按设计稿推定，PM 可否决）：`mergeUpdateGovernance` 的循环 import

设计稿 D3 接受「域模块 → 门面」的受限引用（storage.ts 直接 `import { mergeUpdateGovernance } from '../memory-store'`），靠「只 import 提升的 function 声明、模块初始化期不求值」消解 TDZ/环风险。

4 处名字级调用点（L740/801/870/911）在 `save` 方法体内，**没有 `this.` 前缀**，所以 R3 不允许改成 `ctx.mergeUpdateGovernance`。→ 只能走 import，与 D3 一致。**此项无冲突，照设计稿执行。**

---

## 四、剩余 7 步的落地计划（裁决后照此执行，每步跑一次 136 条）

| 步 | 动作 | 产出 |
|---|---|---|
| 1 | 冻结基线 | ✅ 本文件 §1 |
| 2 | 抽 `types.ts` | 9 个类型 + `StoreContext`；门面原位等行占位 |
| 3 | 抽 `core.ts` | 类体 core 方法 + 冻结区行映射 helper；门面原位等行占位 |
| 4 | 抽 `candidates.ts` | 7 个方法 |
| 5 | 抽 `audit.ts` | 4 个方法 |
| 6 | 抽 `retrieval.ts` | 11 个方法 |
| 7 | 抽 `storage.ts` | 11 个方法（`save` 最大、`mergeUpdateGovernance` 调用最多，放最后） |
| 8 | 类壳收敛 + R6 复核 | 门面方法收敛为一行委托；SQL 多重集 diff 为空；`enc1:` 计数相等；导出面 17 个；原型方法名快照一致；新增导出面守卫测试 |

新增守卫测试（设计稿 §3.3 第 4 条，唯一新增测试文件）：值导出 9 个全在 + `MemoryStore` 原型方法名集合与基线快照一致（不新增任何行为断言）。

---

## 五、纪律确认

- 不碰 `src-tauri/inject/entry.js`、`src/inject/**`；
- 不改 SQL 语义 / 表结构 / 索引 / `enc1:` 前缀；
- 不改导出名、不加依赖、不移出 `src`；
- 每步跑一次全量 memory 测试（136 条），不绿即回退该步；
- **不提交**，由 PM 跑全量 gate 后统一落批次；
- 窗口不占（纯宿主侧重构）。
