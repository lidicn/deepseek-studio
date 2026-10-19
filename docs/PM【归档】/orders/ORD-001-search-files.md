# ORD-001 · search-files 本地检索纯函数包

> 派单：主进程（豆包工作）｜日期：2026-10-18｜承接：豆包辅助开发席（1 个对话）
> 类型：独立纯函数包（不注册工具、不接线）｜预计：0.5–1d
> 契约依据：`docs/PM/roadmap/CONTRACTS.md` 第 6 节（辅助席工具包交付契约）。

## 1. 目标

交付两个**本地、纯函数、离线**的文件检索能力，供主进程后续挂成 `search_files` 工具：
- `listFiles`：在注入 root 内按文件名通配列出文件（递归可选）。
- `grepFiles`：在注入 root 内按内容（子串或正则）检索，返回命中行。

**你只写模块和单测，不做工具注册、不碰宿主、不发起网络、不 spawn。**

## 2. 落点（只许新建这两个文件）

| 文件 | 内容 |
|---|---|
| `src/capabilities/search-files.ts` | 纯函数模块 |
| `tests/desktop/capabilities-search-files.test.ts` | 单测（临时目录/fs mock，不依赖真实仓库树） |

**禁止修改**：`src/host/**`、`src/inject/**`、`tools/**`、`package.json`、`docs/PM/roadmap/CONTRACTS.md`、任何既有 `.ts`。
**允许 import**：仅 `node:fs/promises`、`node:path`、本包内文件；不得 import `src/host/**` 或既有能力。

## 3. 导出签名（照此实现，不改形状）

```typescript
import type { ExecuteResult } from './types';

export interface ListFilesInput {
  root: string;                 // 调用方注入的工作区根（绝对路径）
  pattern?: string;              // 文件名通配：* = 任意串，? = 单字符；缺省 = 全部
  recursive?: boolean;           // 默认 true
  limit?: number;                // 默认 500，超出截断并标 truncated
}

export interface GrepFilesInput {
  root: string;
  query: string;                 // 默认按子串；regex=true 时按正则
  regex?: boolean;
  caseInsensitive?: boolean;
  glob?: string;                 // 可选：只在匹配该文件名通配的文件内检索
  limit?: number;                // 默认 200 条命中，超出截断
}

export async function listFiles(input: ListFilesInput): Promise<ExecuteResult>;
export async function grepFiles(input: GrepFilesInput): Promise<ExecuteResult>;
```

### 成功 data 形状
- `listFiles` → `data: { root, entries: Array<{ path: string; type: 'file'|'dir'; size?: number }>, total: number, truncated: boolean }`（`path` 相对 root，用 `/` 分隔）。
- `grepFiles` → `data: { root, matches: Array<{ file: string; line: number; text: string }>, truncated: boolean }`（`file` 相对 root；`line` 从 1 起；`text` 去掉首尾换行，单行截断到 200 字符）。

### 失败错误码（用 §6.1 词表，不许抛异常）
- 缺 `root`/`query` → `missing-argument`
- `root` 不是绝对路径 / `regex` 非法 → `invalid-argument`
- root 不存在或不可读 → `io-error`
- 命中/条目超 limit → 不报错，`truncated=true`
- 遍历中遇到符号链接：**不跟随**，跳过并计入普通条目即可，不得沿链接逃逸出 root。

## 4. 安全边界（fail-closed）

- 只在注入 `root` 之内遍历；任何解析后越出 root 的条目丢弃（纵深防御，不靠调用方）。
- 不读环境变量密钥；不访问网络；不执行文件内容。
- 目录遍历加防循环保护（记录已访问 inode/realpath，避免环链）。

## 5. 单测要求（至少覆盖）

1. listFiles：递归列出匹配 pattern 的文件，相对路径正确。
2. listFiles：非递归只列顶层；超 limit → truncated=true。
3. grepFiles：子串命中返回 file/line/text；regex=true 用正则命中。
4. grepFiles：caseInsensitive 生效；glob 过滤生效。
5. 错误路径：缺 root → `missing-argument`；非法 regex → `invalid-argument`；root 不存在 → `io-error`。
6. 边界：空目录返回空 entries/matches，不报错；符号链接不逃逸。

## 6. 验收命令（在仓库根 `E:\NAS\deepseek-studio` 跑）

```powershell
npx vitest run tests/desktop/capabilities-search-files.test.ts
npm run typecheck
```

- 新测试全绿；`typecheck` 0 错。
- **不要**跑全量 `npm run test`（并行期避免污染）；只跑本文件。

## 7. 交付

- 把两条命令的**原始输出**（含 passed/failed/用例数实数）落到 `docs/PM/progress/ORD-001-search-files.md`。
- 在该文件末尾列：新建文件清单、未做项/遗留、是否触碰过禁止区（应为"否"）。
- 完成后回报主进程合流；工具注册由主进程做，你不要接。
