# MemoryStore 巨石重构 —— 验收报告

- 日期：2026-11-01
- 席位：Core（内核/宿主，唯一实现者）
- 设计稿：`docs/设计稿/MemoryStore-巨石文件重构-20261101.md`（Lever-Hub2 产出，gate pass）
- PM 裁决口径：冻结六符号**文本逐字不变**、行号允许前移事后重锚；helper 与类型直接搬走不留占位；`StoreContext` 不导出；每步不绿即回退
- 结论：**重构完成，专项 140/140，`tsc` EXIT=0，未提交**（PM 独立 gate 复核后落批次）

---

## 一、结论速览

| 验收项 | 判据 | 读数 | 结果 |
|---|---|---|---|
| 行为 | 现有 memory 测试原样全绿 | **140/140 passed**（136 原有 + 4 新增守卫），0 failed / 0 pending | ✅ |
| 类型 | `npx tsc --noEmit` | **EXIT=0** | ✅ |
| 结构 | 门面 + 6 模块 | `memory-store.ts` **1659 → 361 行（-78%）** | ✅ |
| 导出面 | 17 符号一个不少 | 值 **9/9** + 类型 **8/8**，`StoreContext` 未外泄 | ✅ |
| 契约方法 | 对外方法一个不少 | **23/23** | ✅ |
| 冻结区 | L1-L471 六符号逐字不变 | **8/8 identical**，字节数完全相同 | ✅ |
| **归一化哈希** | R3：`this.→ctx.` 是唯一改动 | **41/41 identical，differing=0** | ✅ |
| SQL 语义 | 字面量多重集 diff 为空 | **57/57** | ✅ |
| 加密 | `enc1:` 计数不变 | **0 → 0** | ✅ |

---

## 二、结构：门面 + 6 个域模块

| 文件 | 行数 | 字节 | 内容 |
|---|---|---|---|
| `src/host/memory-store.ts`（门面） | **361** | 16 313 | 全部既有导出 + 类壳 + 一行委托 + 尾部两函数 |
| `src/host/memory/types.ts` | 136 | 5 020 | 9 个类型/常量 + `StoreContext`（**内部，不导出**） |
| `src/host/memory/core.ts` | 440 | 17 837 | 19 个 helper + 7 个内核方法 |
| `src/host/memory/storage.ts` | 474 | 24 752 | 11 个方法 |
| `src/host/memory/retrieval.ts` | 145 | 6 219 | 11 个方法（只读域） |
| `src/host/memory/audit.ts` | 138 | 5 683 | 4 个方法 |
| `src/host/memory/candidates.ts` | 134 | 5 245 | 7 个方法 |

**方法账**（AST 权威）：原类 `MemoryStore` **42 个 MethodDeclaration**（不含 ctor）→ 搬进域模块 **41 个** + 留门面 `getWorkspaceId` **1 个** = 42，**一一对应，无合并、无改名、无删**。

**依赖方向（无环）**：

```
memory-store.ts（门面）
  ├─→ memory/core / storage / retrieval / audit / candidates
memory/core        → types            （不 import 任何域模块）
memory/storage     → types, core, memory-store（mergeUpdateGovernance，D3 受限引用）
memory/retrieval   → types, core
memory/audit       → types, core
memory/candidates  → types, core
```

唯一环是设计稿 D3 明确接受的 `storage → 门面 → storage`，靠「只 import 提升的 function 声明、模块初始化期不求值」消解 TDZ。

---

## 三、导出面：17 个符号

**值导出 9**：`DEFAULT_WORKSPACE_ID` `MAX_MEMORIES` `MemoryStore` `closeMemoryStores` `getMemoryStore` `listWorkspaceIds` `mergeUpdateGovernance` `workspaceSlug` `workspaceStorePath`

**类型导出 8**：`ExistingGovernanceFields` `MemoryCandidate` `MemoryLogEntry` `MemoryRow` `MemorySaveWarning` `MemoryType` `SaveMemoryParams` `SaveMemoryResult`

**`StoreContext` 不在导出面**（门面按具名 re-export 转出 8 个类型，`StoreContext` 只在 `memory/types.ts` 内部）。

**新增守卫测试** `tests/desktop/memory-store-export-guard.test.ts`（4 例，不新增任何行为断言）：

1. 值导出 9 个符号名全在；
2. 类型导出 8 个的**编译期**守卫（`_CompileGuard` 类型引用）；
3. 对外契约方法 23 个全在；
4. `StoreContext` 不得出现在门面导出面。

---

## 四、L1-L471 冻结区：6 个符号逐字不变

PM 判据：6 个冻结符号 + `getMemoryStore`/`closeMemoryStores` **文本逐字不变**（行号允许前移、事后重锚）。

`logs/verify-exit/memory-refactor-frozen-diff.mjs` → **EXIT=0**：

| 符号 | 重构前 | 重构后 | 位移 | 字节（前→后） | 逐字相同 |
|---|---|---|---|---|---|
| `workspaceSlug` | `:76` | `:75` | −1 | 269 → 269 | ✅ |
| `workspaceStorePath` | `:86` | `:85` | −1 | 364 → 364 | ✅ |
| `workspaceIndexPath` | `:95` | `:94` | −1 | 235 → 235 | ✅ |
| `listWorkspaceIds` | `:125` | `:124` | −1 | 604 → 604 | ✅ |
| `defaultStorePath` | `:186` | `:146` | −40 | 201 → 201 | ✅ |
| `mergeUpdateGovernance` | `:263` | `:167` | −96 | 378 → 378 | ✅ |
| `getMemoryStore` | `:1637` | `:339` | −1298 | 439 → 439 | ✅ |
| `closeMemoryStores` | `:1654` | `:356` | −1298 | 178 → 178 | ✅ |

**类壳**：类头 `export class MemoryStore implements MemoryStoreV2` 逐字不变；原有 7 个属性逐字不变且顺序不变；仅新增 1 个内部字段 `private readonly ctx: StoreContext;`（门面装配域上下文，设计稿允许的新增）。

---

## 五、`this. → ctx.` 归一化哈希自证（R3）

**这是本卡最硬的一条证据**：把每个搬运体的方法体里的 `ctx.` **还原回 `this.`**、把同域直接调用 `foo(ctx, …)` **还原回 `this.foo(…)`**，然后与重构前原文**逐字节比对**。

工具：`logs/verify-exit/memory-refactor-body-hash.mjs`

```
{ "totalMoved": 41, "identical": 41, "differing": 0, "allIdentical": true }
BODY_HASH_EXIT=0
```

**41 个搬运体全部逐字节相等，零差异** —— 证明方法体内除 `this.`→`ctx.` 与同域调用改写这两类变换外，**没有任何其它改动**（SQL 字面量、注释、字符串、分支结构全部原样）。

> 这条我在重构过程中**声称过但此前没真正验证**，本次按 PM 要求补上了真证据。

---

## 六、SQL 语义与加密前缀

| 项 | 基线 | 现状 | 判据 |
|---|---|---|---|
| SQL 字符串字面量 | **57** | **57** | 多重集逐条相等，diff 为空 |
| `enc1:` 出现次数 | **0** | **0** | 相等（`enc1:` 不在本文件，守恒即 0→0） |

工具：`logs/verify-exit/memory-refactor-scan.mjs`（AST 提取，重构前后各跑一次做 diff）。

**表结构、索引、`enc1:` 前缀、SQL 语义一律未动。**

---

## 七、专项测试读数

**命令**（串行，避免并发资源竞争）：

```
npx vitest run --no-file-parallelism --maxWorkers=1 <13 个 memory 测试文件>
```

**结果**：`numTotalTests=140 passed=140 failed=0 pending=0`，`numTotalTestSuites=41 passed=41`，EXIT=0，耗时 87.7 s。

| 文件 | 例数 | 状态 |
|---|---|---|
| `memory-archive-lifecycle.test.ts` | 6 | passed |
| `memory-audit-encryption.test.ts` | 2 | passed |
| `memory-candidates.test.ts` | 7 | passed |
| `memory-delete-consent.test.ts` | 2 | passed |
| `memory-governance.test.ts` | 57 | passed |
| `memory-log.test.ts` | 7 | passed |
| `memory-panel.test.ts` | 3 | passed |
| `memory-select-regression.test.ts` | 8 | passed |
| `memory-store-export-guard.test.ts` | 4 | passed |
| `memory-store-v2.test.ts` | 18 | passed |
| `memory-tool-boundary.test.ts` | 7 | passed |
| `memory-workspace.test.ts` | 6 | passed |
| `untrusted-memory.test.ts` | 13 | passed |
| **合计** | **140** | **全绿** |

**与重构前一致性**：重构前基线 **136 例**（12 文件，全绿），重构后 **140 例** = 136 原有（用例名清单不变、无一被删或改名）+ 4 条新增导出面守卫。逐条用例名清单见 `logs/verify-exit/memory-final-json.json`（JSON reporter 全量记录）。

> 一条如实记录：第 7 步首次闸门**并行**跑 12 个文件时出现 1 例失败（`memory-governance` 的 30 s 容量测试），逐文件单跑全过、串行跑全绿 → 判为**并行执行的资源竞争**，非重构缺陷。此后闸门一律串行。

### 7.1 两条链路的专项取证（PM 点名：确认无递归、无半更新）

外部探针 `logs/verify-exit/memory-chain-probe.ts`（tsx 运行，**不改产品代码**，独立临时库，结束即删）：对 `MemoryStore.prototype` 每个方法打桩计数以检测递归。

**链路 A —— `save → applyEviction → recordLog → snapshotById`**：

| 项 | 读数 |
|---|---|
| 调用次数 | `save=501`、**`validRows=501`**、**`recordLog=501`**、`snapshotById=1` |
| 容量守恒 | `total=501 valid=500`（`valid ≤ 500` 成立） |
| 快照 | `found=true`、`name=chain-A-marker`、`contentLen=5` |
| 审计 | `listLog` 20 条，含 `op=save` |

三者**严格一一对应**（都是 501 = 500 次填充 + 1 次触发）：多一次即 `applyEviction` 回调 `save` 成环，少一次即链路断裂。**实测无递归。**

**链路 B —— `rollback → 恢复`**：

| 项 | 读数 |
|---|---|
| `rollback(501)` | **`{ok:true}`** |
| `deleteMemoryRow` 调用次数 | **1**（无重复删） |
| 回滚后计数 | `total 501→500`、`valid 500→499`，`valid ≤ total` 自洽 |

> `rowGoneAfterRollback=false` 是**正确**的：那条日志 `op=save` 而非 `remove/purge`，语义是「撤销那次保存」不是「删除这行」。

---

## 八、`tsc` 读数

```
npx tsc --noEmit
TSC_EXIT=0
```

（`noUnusedLocals` / `noUnusedParameters` 全开，故每个域模块的 import 列表与 ctx 形参都是逐项核过的——未用 ctx 的方法用 `_ctx` 前缀，位置与顺序不变。）

---

## 九、三处「设计稿未覆盖、按实际代码定」的口径（PM 已认可）

1. **11 个 private 域内实现不生成门面委托**（`migrateDedupeHash` 等 4 个 + `deleteCandidateRow` + `allRows`/`sortRows`/`applyPersonaFilter` + `prepareEviction`/`applyEviction`/`syncFts`）——只被同域方法调用（同域已改域内直调），门面留委托既无人调又触发 `noUnusedLocals`；**全部 private，外部不可见，公开契约面不变**。
2. **19 个 helper 统一住 `core.ts` 并具名导出**——它们被多域共用，域模块自带会与 import 同名冲突（TS2440）；也正合设计稿「域模块只 import core/types」。
3. **`StoreContext` 数据字段用 get/set 访问器**代理到实例——`open()` 的降级分支要写回 `this.db`/`this.audit`/`this.fallback`，纯 getter 不够；`storePath`/`workspaceId` 保持只读。

---

## 十、改动文件清单（全部 Core 域内）

**新增 7**：`src/host/memory/{types,core,storage,retrieval,audit,candidates}.ts`、`tests/desktop/memory-store-export-guard.test.ts`

**修改 2**：`src/host/memory-store.ts`（1659 → 361 行的门面）、`docs/设计稿/MemoryStore-巨石文件重构-20261101.md`（**仅行号重锚**，38+/31−，正文语义一字未动，doc-drift 0 fail）

**报告 3**：`docs/验收报告/20261101-Core-MemoryStore巨石重构-完成报告.md`、`…-基线与卡点.md`、本文件

**工具**（`logs/verify-exit/`，我域）：`memory-refactor-{scan,graph,apply,frozen-diff,proto-diff,body-hash}.mjs`、`memory-chain-probe.ts`、`reanchor-memory-design-doc.mjs`，基线快照 `memory-baseline.json` / `memory-graph.json` / `memory-store.orig.ts`。

**未触碰**：`src-tauri/inject/entry.js`、`src/inject/**`、`src/ui/**`、`personas/**`、`docs/验收/**`、其它域文件。

---

## 十一、纪律

未 commit / 未 push；未起真机实例（纯宿主侧重构，不占窗口）；SQL 语义、表结构、索引、加密前缀、导出名、公开方法签名全部未变；每步跑全量 memory 测试、不绿即回退（实际未触发回退）。
