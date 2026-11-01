# 上游 dpp 参考锚点（原 deepseek-pp/ 快照目录已删除）

> 本文件位于 studio 仓库 `docs/dpp/`，2026-10-27 前名为 `deepseek-pp/UPSTREAM.md`。
> 内嵌快照目录已整体移除，理由见 §3。

## 1. 上游仓库

| 项 | 值 |
|----|----|
| 上游路径 | `E:\NAS\deepseek-pp\src`（**git 根即 src 目录本身**） |
| 形态 | MV3 浏览器扩展，WXT + React + TS |
| 快照锚点 commit | `187f6227e1fed07405c0802374b69c16e29eb6e2`（2026-10-08） |
| 锚点时上游版本 | `package.json` → 1.16.0 |
| 当前漂移（实测 2026-11-01） | 锚点之后上游又走 **415 提交**，改动 **544 文件**（至冻结 tag `v1.16.0-frozen` / commit `2d54f06`）。此前 2026-10-31 实测为 414 提交 / 543 文件（当时 HEAD `660feda`）—— 差的那 1 提交即冻结声明 `2d54f06` |
| 上游状态（2026-11-01） | **已冻结**，不再前进，详见 §1.1；冻结期内最后一个提交为 `f24d2c5` |

### 1.1 冻结基线（tag `v1.16.0-frozen`，2026-11-01）

| 项 | 值 |
|----|----|
| 冻结 tag | `v1.16.0-frozen`（**annotated**，tag 对象 `a3342f6`）→ commit **`2d54f06`** |
| tag 指向的 HEAD | `2d54f06` `docs(readme): 冻结声明 —— dpp 收口基线 v1.16.0-frozen`（2026-11-01 12:16:54 +0800） |
| **代码基线** | **`660feda`**（2026-10-31 11:52:47 +0800）—— tag message 所指的 HEAD，`dist` 由它构建 |
| 冻结后提交（4 个） | `8c0d27f` → `43364ce` → `f24d2c5` → `33c5738`，见 §1.2 |
| 当前 HEAD（实测 2026-11-01 18:25） | `33c5738`；分支 `main`；工作树**干净**（`git status --porcelain` 0 项）；`main` = `origin/main` = `33c5738`（ahead/behind `0/0`，已 push） |
| **产物树哈希** | `4bcd83003e507603765b11ef2715a1ea66db804c8829b9a0ed47e12d478b8a6c` —— = `E:\NAS\deepseek-pp\doc\交接班\20261101-dpp-产物SHA256SUMS.txt` **文件字节的 SHA256**（清单 100 行 = 100 个产物文件） |
| 产物版本 | `dist/chrome-mv3`，**100** 个文件；`build-stamp.txt` = `1793525684315-5jgij0`；扩展 id `jjjhcjjegfplcfncohmfhbdhcalmijnc`（详见上游封存单 §1） |
| ⚠ 产物口径 | 树哈希对应 **10-31 11:40** 那版构建（`content.js` `737451ba…` / 890,986 B）；封存时 `dist` 是 **11-01 17:35:30** 重建（`content.js` `84105AF7…` / 891,120 B）。两者差 **2 个文件**（`build-stamp.txt`、`content-scripts/content.js`），其余 98 个逐字节一致。引用树哈希须写明「10-31 11:40 版」，引用真机读数须写明「17:35:30 版」——对账见上游封存单 §1.2 |
| 版本号 | `package.json` → `1.16.0`（`deepseek-plus-plus`） |
| 提交总数 | 956（`git rev-list --count HEAD`） |

### 1.2 冻结后提交（4 个，全部在冻结声明之后）

| commit | 说明 |
|----|----|
| `8c0d27f` | `feat(prompt): 首轮记忆注入策略（决策单元 + 用例）—— **接线未生效，待下一轮定位**` |
| `43364ce` | `feat(chat): 首轮不注入（DCD 裁定乙）—— 首轮 43B，第二轮恢复注入` |
| `f24d2c5` | `fix(chat): 删 3 处 TS2353 入参（复核 D2）—— 保留已验证的首轮早退实现` |
| `33c5738` | `test(chat): 契约测试随 DCD 裁定乙更新（26 条首轮用例）—— 测试侧全绿`（**仅 `tests/**`，产品代码与 `dist` 未变**） |

> 对 studio 的意义：**`2d54f06` 是锚点 commit，`660feda` 是代码基线**；`8c0d27f`/`43364ce`/`f24d2c5`/`33c5738` 是冻结期内为收口而追加的提交，**不在** tag 指向的提交里。要逐字节比对上游文件，用工作树当前状态（=`33c5738`）；要引「冻结版本号」，用 tag `v1.16.0-frozen`。**真机读数（43B / 0/10）对应的产品基线是 `f24d2c5`**（`33c5738` 只改测试，不影响产物）。

### 1.3 相对上一版 `v1.14.0` 的变更面

复跑命令（在 `E:\NAS\deepseek-pp\src` 下）：

```powershell
git -C E:\NAS\deepseek-pp\src diff --name-only v1.14.0..v1.16.0-frozen
```

- `v1.14.0` → commit `32d6f73`；`v1.16.0-frozen` → commit `2d54f06`
- **改动文件数：652**
- 前 20 条（按 git 默认排序）：

```
.github/workflows/ci.yml
.gitignore
AGENTS.md
README.md
README_EN.md
core/automation/natural-language-create.ts
core/automation/pow.ts
core/automation/runner.ts
core/automation/schedule.ts
core/automation/scheduler.ts
core/automation/storage-codec.ts
core/automation/store.ts
core/automation/types.ts
core/browser-control/cdp.ts
core/browser-control/service.ts
core/browser-control/tool.ts
core/chat/active-loop.ts
core/chat/active-transcript.ts
core/chat/auth-retry.ts
core/chat/context-budget.ts
```

> 需要全量清单时直接跑上面那条命令，**不要把清单拷进本仓库**（理由见 §3）。

## 2. 正确用法（替代原来的内嵌拷贝）

1. **读上游直接读 `E:\NAS\deepseek-pp\src`**，它是 git 仓库，可以 `git log` / `git diff 187f6227..HEAD -- <path>` 精确定位变更；快照做不到这件事——这才是删掉它的核心收益。
2. **禁止把上游代码拷进本仓库**。需要复用就写适配层（`src/inject/`、`src/shared/`），并在文件头登记锚点：

```ts
 * @upstream-commit 187f6227 @upstream-path src/core/inline-agent/step-control.ts
```

3. 现有 **5** 个移植文件已带锚点（2026-10-31 实测；D-7 删除 `message-anchor.ts` / `trace-store.ts` 后由 7 减为 5），由 `scripts/check-upstream-drift.mjs` 检测；该脚本读的是真实上游，**不依赖**被删除的目录。5 个文件分别是 `src/shared/continuation-prompt.ts`、`src/inject/markdown.ts`、`src/inject/step-control.ts`、`src/inject/render-code-runner.ts`、`src/inject/streaming-tool-parser.ts`，锚点均为 `187f6227`（2026-11-01 复核仍是这 5 个）。
   **上游已冻结（§1.1）⇒ 该脚本的比对基线（真实上游工作树）不再前进**，`@upstream-commit` 之后的「变更次数」也停止增长；漂移从「持续增长」变为「存量固定」。
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
robocopy E:\NAS\deepseek-pp\src E:\NAS\deepseek-studio\deepseek-pp\src /E /XD node_modules dist .git videos .github .wxt
```

历史上曾排除：`node_modules/`(263MB) `dist/`(111MB) `.git/`(41MB) `videos/`(35MB) `.github/` `.wxt/`；拷贝规模 1133 文件 / 12.96MB。

*（文件结束）*
