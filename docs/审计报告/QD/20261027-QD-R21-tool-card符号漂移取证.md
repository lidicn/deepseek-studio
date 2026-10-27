# QD-R21 · `tool-card-ui.redesign.test.ts` 7 条 typecheck 错取证

> 取证日期：2026-10-27
> 取证范围：`feat/bot-core` 分支 HEAD `66abb43`
> 取证对象：`src/inject/tool-card-ui.redesign.ts` vs `tests/desktop/tool-card-ui.redesign.test.ts`

---

## 0. 基线（与 PM 交接班卡 T6 一致）

```
tests/desktop/tool-card-ui.redesign.test.ts(11,29): error TS2305: no exported member 'ToolCardResult'
tests/desktop/tool-card-ui.redesign.test.ts(15,3):  error TS2305: no exported member 'formatResultText'
tests/desktop/tool-card-ui.redesign.test.ts(16,3):  error TS2305: no exported member 'resolveToolStatus'
tests/desktop/tool-card-ui.redesign.test.ts(17,3):  error TS2305: no exported member 'summarizeParams'
tests/desktop/tool-card-ui.redesign.test.ts(18,3):  error TS2305: no exported member 'summarizeResultText'
tests/desktop/tool-card-ui.redesign.test.ts(371,5): error TS2554: Expected 4-5 arguments, but got 3
tests/desktop/tool-card-ui.redesign.test.ts(515,18):error TS2554: Expected 4-5 arguments, but got 2
```

全部 7 条 typecheck 错，集中在同一测试文件。

---

## 1. Git 历史追踪

### 1.1 src 文件历史

```
git log --all --oneline --follow -- src/inject/tool-card-ui.redesign.ts
eb3955e chore: 收口历史未提交改动并重建 inject 产物
7d6e0e7 feat(studio-ui): add redesigned tool card renderer
```

### 1.2 test 文件历史

```
git log --all --oneline --follow -- tests/desktop/tool-card-ui.redesign.test.ts
7d6e0e7 feat(studio-ui): add redesigned tool card renderer
```

**关键发现**：
- 测试文件**只在 `7d6e0e7` 创建一次**，之后**再也没被修改过**
- src 文件在 `7d6e0e7` 创建后，被 `eb3955e` 大幅改写
- 两个 `git diff 7d6e0e7 HEAD -- <test file>` → **空输出**

### 1.3 两 commit 导出对比

**`7d6e0e7`（原始设计 · 卡片渲染器 v1.0）**：

```ts
export interface ToolCardResult       // ← 独立结果类型
export interface ToolCardData
export interface RedesignedToolCardUpdate extends ToolCardData
export type ToolStatus               // ← 状态枚举
export interface ParamSummaryItem
export function formatDurationMs(ms: number): string
export function resolveToolStatus(result?: ToolCardResult): ToolStatus
export function formatResultText(result: ToolCardResult): string
export function summarizeResultText(text: string): string
export function summarizeParams(...): ParamSummaryItem[]
export function createRedesignedToolCard(...)
export function updateRedesignedToolCardByCallId(...)  // 3 种重载
```

**`eb3955e`（重写设计 · 过程流渲染器 v2.0）**：

```ts
export interface ToolCardData        // result 内联，不再有 ToolCardResult
export type ToolCallStatus           // ← 重命名自 ToolStatus
export function formatDurationMs(ms: number | undefined): string
export function buildParamBrief(params: unknown, maxLength): string  // ← 重命名自 summarizeParams + 签名彻底改
export function deriveToolStatus(result?: ToolCardData['result']): ToolCallStatus  // ← 重命名自 resolveToolStatus
export function createRedesignedToolCard(...)
export function updateRedesignedToolCardByCallId(...)  // 签名收窄（原来的 3 种重载砍成 2 种）
export const createToolCard = createRedesignedToolCard
export const updateToolCardByCallId = updateRedesignedToolCardByCallId
```

### 1.4 符号漂移映射

| 7d6e0e7 符号 | eb3955e 去向 | 漂移类型 | 测试仍引用 | typecheck 报错 |
|---|---|---|---|---|
| `ToolCardResult` (interface) | **删除** · 内联为 `ToolCardData.result` | 结构合并 | ✅ line 11 | TS2305 |
| `formatResultText(result: ToolCardResult): string` | **删除** · 改用 `import { formatToolResultText } from '../shared/tool-result-format'` | 委托 shared 模块 | ✅ line 15 | TS2305 |
| `resolveToolStatus(result?: ToolCardResult): ToolStatus` | → `deriveToolStatus(result?: ToolCardData['result']): ToolCallStatus` | 重命名 + 参数类型收窄 | ✅ line 16 | TS2305 |
| `summarizeParams(...): ParamSummaryItem[]` | → `buildParamBrief(params: unknown, maxLength: number = 96): string` | 重命名 + 签名彻底改（返回 item[] → 返回 string 摘要） | ✅ line 17 | TS2305 |
| `summarizeResultText(text: string): string` | **删除** | （过程流渲染器不再需要独立摘要函数） | ✅ line 18 | TS2305 |
| `ToolStatus` | → `ToolCallStatus` | 重命名 | ❌ 测试未直接引用 | — |
| `RedesignedToolCardUpdate` | **删除** | 内联数据形态 | ❌ 测试未引用 | — |
| `ParamSummaryItem` | **删除** | 随 summarizeParams 删除 | ❌ 测试未引用 | — |
| `formatDurationMs(ms: number)` | `formatDurationMs(ms: number \| undefined): string` | 签名扩展 | ✅ 通过（参数更宽） | — |
| `updateRedesignedToolCardByCallId` 三重载 | 收窄为两重载（砍了对象参数形态） | 签名收窄 | ✅ line 371/515 | TS2554 参数个数不匹配 |

---

## 2. `eb3955e` commit 分析

```
commit eb3955e2002f40708de5301fb17e14454dd12902
Author: lidicn
Date:   Sat Oct 24 07:57:25 2026 +0800

    chore: 收口历史未提交改动并重建 inject 产物
    
    这些改动来自此前会话（tool-card 重写、聊天 CSS、agent 面板、workbench 执行视图、
    pow/response-classifier/sse-frame-decoder、studio-trace/context-budget/execution 等
    5 个新增模块、Cargo 托盘 feature 进 default），一直留在工作树里未入库，
    导致 src-tauri/inject/entry.js 这个已入库产物与源码长期不一致。
    
    本次一并收口：
    - 22 个修改/删除 + 5 个新增源文件
    - 按当前源码重建 src-tauri/inject/entry.js（370,042 B）
    
    验证：npm run typecheck EXIT 0；npx vitest run 179 文件 / 1742 用例全绿；
    npm run gate 阻塞级全过。产物与源码同树同刻，不再漂移。
```

**文件改动统计**：`tool-card-ui.redesign.ts` 从 1132 行砍到 789 行（-343 行），commit message 里说"tool-card 重写"是这批改动的一部分。

---

## 3. 根因判定

### 3.1 不是 A（src 从未有过这些符号）

**证伪**：`git show 7d6e0e7:src/inject/tool-card-ui.redesign.ts` 明确导出了全部 5 个符号，且与测试 import 完美对齐。

### 3.2 不是 B（src 被有意回退）

**证伪**：`eb3955e` 不是"回退"到旧版本，而是**向前重构**（卡片渲染器 v1.0 → 过程流渲染器 v2.0）。commit message 明确说"tool-card 重写"，注释也全改了（从"卡片盒"改为"叙事流"）。这是一次产品设计升级，不是回退。

### 3.3 是 C（src 被有意重写，但测试被遗漏同步）

**证据**：
1. src 在 `eb3955e` 被**有意重写**：设计意图从"独立工具卡片盒"改为"内嵌过程流行"，为此删除/重命名了配套的纯函数工具
2. 测试文件**在同一 commit 里被完全忘记同步**——`git diff 7d6e0e7 HEAD -- <test>` 空输出
3. `eb3955e` commit message 里的验证声称 `npm run typecheck EXIT 0`——但事实是这个 commit **没有 typecheck 通过**（至少今天 HEAD 上跑出来 7 条错）

### 3.4 旁证：为什么 commit message 声称 typecheck 过了？

两种可能：
- (a) commit 当时 typecheck 确实过了，但之后某个依赖/tsconfig 变动把测试重新纳入了 typecheck 范围（不太可能，因为测试文件一直在 `tests/` 下）
- (b) commit message 是事后写的，实际没有跑 typecheck，或者只跑了部分文件

更可能是 (b)——这批是"收口工作树脏文件"的大杂烩 commit，commit message 声称的验证项可能没有逐项执行。

---

## 4. 修复路径

这是**产品语义决策**，PM 需二选一：

### 路径 ① · 改测试适配新 src（推荐）

重写 `tool-card-ui.redesign.test.ts` 的 import 和调用：
- `ToolCardResult` → 用 `ToolCardData['result']` 或内联 `{ ok, data?, error?, content?, ... }`
- `resolveToolStatus(...)` → `deriveToolStatus(...)`（参数类型兼容）
- `formatResultText(...)` → `formatToolResultText(...)`（从 `src/shared/tool-result-format` 导入）
- `summarizeParams(...)` → `buildParamBrief(...)`（注意返回类型从 `ParamSummaryItem[]` 变 `string`，测试断言需调整）
- `summarizeResultText(...)` → 该函数已删（过程流渲染器不再需要独立摘要），测试里用到它的用例要么删掉要么内联实现
- `updateRedesignedToolCardByCallId` 3 重载 → 2 重载，测试 line 371/515 传参形态需对齐新签名

**工作量评估**：测试文件约 250~500 行有需调整的 import 和调用点。

### 路径 ② · src 加兼容层（保守）

在 src 里加 re-export/shim，让旧符号指向新实现：
```ts
// 兼容层：让测试继续引用旧符号名
export type ToolCardResult = ToolCardData['result'];
export function resolveToolStatus(r?: ToolCardResult): ToolCallStatus { return deriveToolStatus(r); }
export function summarizeResultText(text: string): string { return text.length > 160 ? text.slice(0, 160) + '…' : text; }
// summarizeParams → 需要包装 buildParamBrief 返回值为 ParamSummaryItem[]
```

**风险**：兼容层让 src 继续背负"卡片渲染器"的 API 包袱，与"过程流渲染器 v2.0"的设计方向不一致。后续新代码若误用这些兼容 API，会加剧混乱。

### 路径 ③ · 重写 src 也提供旧 API（折中）

把被删的 5 个符号全部补回来，同时提供新 API。**不推荐**——两套 API 并存会让调用方困惑。

---

## 5. NEEDS-PM-DECISION

- **判定**：`eb3955e` 大重构 src（有意），但忘记同步测试（遗漏），**不属于"改测试必 NEEDS-PM-DECISION"的红线范围**（那是"改断言"的规则）
- 但"改哪个文件、怎么改"属产品决策——路径 ① 改测试 vs 路径 ② 加兼容层，PM 定
- 建议：路径 ① 改测试适配新设计。理由：过程流渲染器是产品方向，测试应跟随
- 顺便复盘：`eb3955e` 这类"收口脏文件"大杂烩 commit，不应声称"typecheck EXIT 0"——验证应贴原始输出，否则容易掩盖遗漏

---

## 6. 原始证据

```powershell
# typecheck 基线
npx tsc --noEmit 2>&1 | Select-String 'tool-card-ui.redesign'
# → 7 条 TS2305 / TS2554 错误

# git log（测试文件仅创建一次）
git log --all --oneline --follow -- tests/desktop/tool-card-ui.redesign.test.ts
# → 7d6e0e7 feat(studio-ui): add redesigned tool card renderer

# 测试文件自创建以来未修改
git diff 7d6e0e7 HEAD -- tests/desktop/tool-card-ui.redesign.test.ts
# → 空输出（NO DIFF）

# src 文件被大幅改写
git diff 7d6e0e7 eb3955e -- src/inject/tool-card-ui.redesign.ts
# → 1132 行 → 789 行，全部纯函数重写

# eb3955e commit message
git show eb3955e --format=fuller --stat | Select-Object -First 30
```
