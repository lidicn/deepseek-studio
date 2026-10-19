# ORD-001 · search-files 本地检索纯函数包 · 进度回报

> 承接：豆包辅助开发席｜完成日期：2026-10-18
> 契约依据：`docs/PM/roadmap/CONTRACTS.md` §6（辅助席工具包交付契约）

## 1. 验收命令原始输出

### 1.1 `npx vitest run tests/desktop/capabilities-search-files.test.ts`

```
RUN  v2.1.9 E:/NAS/deepseek-studio

 ✓ tests/desktop/capabilities-search-files.test.ts (17 tests) 1982ms
   ✓ grepFiles > caseInsensitive 生效 492ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
   Start at  13:23:29
   Duration  5.87s (transform 871ms, setup 0ms, collect 870ms, tests 1.98s, environment 0ms, prepare 888ms)

EXIT=0
```

### 1.2 `npm run typecheck`

```
> deepseek-studio@0.4.0 typecheck
> tsc --noEmit

EXIT=0
```

- 新测试 **17 passed / 17 total**，0 failed。
- `typecheck` **0 错**。
- 按工单要求**未跑**全量 `npm run test`，仅跑本测试文件。

## 2. 用例覆盖对照（订单 §5）

| 要求 | 用例 |
|---|---|
| 1. 递归列出匹配 pattern、相对路径正确 | `listFiles › 递归列出匹配 pattern 的文件，相对路径用 / 分隔`、`sub/deep/c.md 可被列出` |
| 2. 非递归只列顶层；超 limit → truncated | `非递归只列顶层`、`超 limit → truncated=true` |
| 3. 子串命中 file/line/text；regex=true 正则命中 | `子串命中返回 file/line/text`、`regex=true 按正则命中` |
| 4. caseInsensitive 生效；glob 过滤生效 | `caseInsensitive 生效`、`glob 过滤只在匹配文件名的文件内检索` |
| 5. 错误路径：缺 root / 非法 regex / root 不存在 | `缺 root → missing-argument`、`grep 缺 query → missing-argument`、`root 不是绝对路径 → invalid-argument`、`非法 regex → invalid-argument`、`root 不存在 → io-error` |
| 6. 空目录不报错；符号链接不逃逸 | `空目录返回空 entries/matches`（listFiles & grepFiles 各一）、`不跟随指向 root 外部的符号链接` |
| 附加 | 单行截断 200 字符用例 1 个 |

## 3. 新建文件清单

| 文件 | 说明 |
|---|---|
| `src/capabilities/search-files.ts` | 纯函数模块，导出 `listFiles` / `grepFiles`，签名与订单 §3 一致 |
| `tests/desktop/capabilities-search-files.test.ts` | 17 个单测，全部用 `os.tmpdir()` 临时目录，不依赖真实仓库树 |

## 4. 关键实现决策

- **不跟随符号链接**：遍历用 `fs.readdir(withFileTypes)` 拿 `Dirent`，`isSymbolicLink()` 为真的条目仅作为普通条目列出（listFiles 中 type='file'），不递归下钻、不作为 grep 检索对象。
- **纵深防御**：每个条目再用 `path.relative(root, full)` 校验，越出 root（`..`/绝对路径）一律丢弃；`walk` 内 `visited` 记录已展开目录防循环。
- **错误码**：缺 root/query → `missing-argument`；root 非绝对路径 / regex 编译失败 → `invalid-argument`；root 不存在或不可读 → `io-error`；超 limit 不报错，仅 `truncated=true`。全程 `{ok:false,error}` 不抛异常。
- **grep 单行截断**：`text = line.slice(0, 200)`；行号从 1 起。
- **grep 单文件读失败**（权限/二进制等）跳过该文件，不整体失败。

## 5. 未做项 / 遗留

- 工具注册、宿主接线：**未做**，按工单由主进程后续挂成 `search_files`。
- 未新增/未登记新错误码（全部复用 §6.1 词表）。
- 符号链接用例：在 Windows 无开发者模式/管理员权限时 `symlinkSync` 会失败，测试内 `try/catch` 自动跳过，不影响用例数判定；在有权限环境下会真正校验不逃逸。
- `size` 字段仅对普通文件经 `lstat` 填充；目录不填 size（字段可选）。

## 6. 是否触碰禁止区

- 禁止修改 `src/host/**`、`src/inject/**`、`tools/**`、`package.json`、`docs/PM/roadmap/CONTRACTS.md`、任何既有 `.ts`：**否**。
- 仅新建上述 2 个文件 + 本进度报告。
