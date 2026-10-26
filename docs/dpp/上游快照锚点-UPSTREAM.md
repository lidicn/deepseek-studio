# 上游 dpp 参考锚点（原 deepseek-pp/ 快照目录已删除）

> 本文件位于 studio 仓库 `docs/dpp/`，2026-10-27 前名为 `deepseek-pp/UPSTREAM.md`。
> 内嵌快照目录已整体移除，理由见 §3。

## 1. 上游仓库

| 项 | 值 |
|----|----|
| 上游路径 | `E:\\NAS\\deepseek-pp\\src`（**git 根即 src 目录本身**） |
| 形态 | MV3 浏览器扩展，WXT + React + TS |
| 快照锚点 commit | `187f6227e1fed07405c0802374b69c16e29eb6e2`（2026-10-08） |
| 锚点时上游版本 | `package.json` → 1.16.0 |
| 当前漂移（实测 2026-10-27） | 锚点之后上游又走 **260 提交**，改动 **374 文件** |

## 2. 正确用法（替代原来的内嵌拷贝）

1. **读上游直接读 `E:\\NAS\\deepseek-pp\\src`**，它是 git 仓库，可以 `git log` / `git diff 187f6227..HEAD -- <path>` 精确定位变更；快照做不到这件事——这才是删掉它的核心收益。
2. **禁止把上游代码拷进本仓库**。需要复用就写适配层（`src/inject/`、`src/shared/`），并在文件头登记锚点：

```ts
 * @upstream-commit 187f6227 @upstream-path src/core/inline-agent/step-control.ts
```

3. 现有 7 个移植文件已带锚点，由 `scripts/check-upstream-drift.mjs` 检测；该脚本读的是真实上游，**不依赖**被删除的目录。
4. 上游 `AGENTS.md` 的架构不变量（prompt bytes、storage key、runtime message 名、工具授权路径）对 studio 同样生效。

## 3. 为什么删（四条实测）

| 判据 | 结果 |
|---|---|
| tsconfig `paths` 别名 `deepseek-pp/*` → `./deepseek-pp/src/*` | 与说明符 `deepseek-pp/src/core/deepseek/official-api` 拼接后得 `deepseek-pp/src/src/...`，**该路径不存在** |
| `createUpstreamOfficialBackend` 调用者 | **零**；运行时实际用 `createFakeOfficialBackend` |
| `tsconfig` `exclude` | 含 `deepseek-pp` → typecheck 不检查其 1041 个文件 |
| `vitest` `include` | 仅 `tests/desktop`、`tests/e2e` → 快照自带 273 个测试从不执行 |

结论：它既不参与编译也不参与运行，是 M1 时期「零修改复用上游 core」尝试失败后的残留（失败原因写在 `src/inject/streaming-tool-parser.ts` 头注释：上游 core 依赖 WXT/chrome 类型，无法在 studio 严格 tsconfig 下编译）。

保留它的代价已经落地两次：把 dpp 的活错当成 studio 的活（记忆索引评审）；审 dpp 缺陷时必须双读快照与上游才能确认版本一致（DST 工单）。

## 4. 若需恢复快照

原始 robocopy 命令（覆盖式；不建议，见 §2 第 1 条）：

```
robocopy E:\\NAS\\deepseek-pp\\src E:\\NAS\\deepseek-studio\\deepseek-pp\\src /E /XD node_modules dist .git videos .github .wxt
```

历史上曾排除：`node_modules/`(263MB) `dist/`(111MB) `.git/`(41MB) `videos/`(35MB) `.github/` `.wxt/`；拷贝规模 1133 文件 / 12.96MB。

*（文件结束）*
