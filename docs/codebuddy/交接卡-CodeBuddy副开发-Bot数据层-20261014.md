# 交接卡：CodeBuddy 副开发 · Bot 数据层第一批（2026-10-14）

> 分支：`feat/bot-data`（从 master 0b950ba 切出）
> 范围：分工方案 §2 的 2.1 记忆层 v2 + 2.2 Persona/Slot 注册表（数据层部分）
> 状态：**已交付，tsc 0 错误，新增 44 测试全过，全量回归 466 passed / 1 failed（既有失败，非本次引入）**

## 1. 交付物（文件清单）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/host/bot/persona-registry.ts` | 新增 | `FilePersonaRegistry` 实现契约 `PersonaRegistry`：扫描 personas/ 目录，加载 prompt.md + tools.json + memory/；名字白名单防路径穿越；tools.json 支持 `string[]` 或 `{tools:[]}`；加载缓存 + reload() |
| `src/host/bot/slot-registry.ts` | 新增 | `AccountRegistry`（账号池 + 状态/冷却 + available()）+ `FileSlotRegistry`（契约 `SlotRegistry`：list/get/bindAccount/setState + 扩展 setLoadedPersona/findSlotByAccount）。默认 S1..S5 工作槽 + S6 汇总槽 |
| `src/host/bot/scheduler.ts` | 新增 | `Scheduler.assign({slot?, persona, task})`：校验槽位空闲 + 人设存在 → 占用槽位（busy + runId + loadedPersona）→ 返回 RunHandle；可选 runner 回调（Claude 的 AgentLoop 就绪后注入，执行完自动 release，异常也释放）；release 带 runId 归属校验 |
| `src/host/memory-store.ts` | 重写 | 记忆层 v2：SQLite（node:sqlite）+ FTS5（trigram）+ 失效标记 + 人设路由。实现契约 `MemoryStoreV2`（search/invalidate/listByPersona/list/formatForPrompt 全部 async 化）；保留 v1 save/remove/getMemoryStore 同步 API；旧 memories.json 首次启动自动迁移（原文件保留） |
| `src/host/desktop-host.ts` | 小改 | 3 处适配：memory.save 透传 v2 字段（source/confidence/personaTags）；两处 `store.list()` 改 `await`（list() 按契约变 async） |
| `src/types/node-sqlite.d.ts` | 新增 | node:sqlite 最小类型 shim（@types/node 20 无声明；升级到 >=22 后可删） |
| `tests/desktop/bot-persona-registry.test.ts` | 新增 | 10 项 |
| `tests/desktop/bot-slot-scheduler.test.ts` | 新增 | 16 项 |
| `tests/desktop/memory-store-v2.test.ts` | 新增 | 18 项 |
| `personas/audit-expert/` | 新增 | 示例人设包（prompt.md + tools.json + memory/index.md），让 `load("audit-expert")` 开箱可用；运行时根目录 = `<configDir>/personas` 或 `STUDIO_PERSONAS_DIR` |

## 2. 行为变化（Review 要点）

1. **记忆存储从 JSON 迁到 SQLite**（`~/.config/deepseek-studio/memories.db`）。首次启动若存在旧 `memories.json` 自动导入（DB 为空时才导），原文件保留作备份。导入/FTS 索引/降级均有 console warn 日志。
2. **`MemoryStore.list()` 变 async**（契约 `MemoryStoreV2.list(): Promise<Memory[]>`）。v1 调用方只有 desktop-host.ts 两处，已适配。`save`/`remove` 保持同步（node:sqlite 本身同步）。
3. **`formatForPrompt` 签名变**为契约的 `formatForPrompt(memories, limit?)`（v1 是 `formatForPrompt(limit)`）。当前仓库无调用方（grep 确认），输出格式与 v1 逐字一致（`- #id [type] name: content`，空 → `(No memories yet)`）。
4. **同 type+name 的记忆仍走更新**（v1 语义），新增：内容完全一致（contentHash 同 + tags 同）则空操作，不搅动 updatedAt。
5. **invalidate 是失效不是删除**：list/search/listByPersona 均过滤 `invalidAt !== null`；数据保留在 `listInvalidated()` 可审计，`restore(id)` 可回滚。
6. **1 槽位 : 1 账号铁律落在服务端**：bindAccount 对「账号已被其它槽位绑定」「槽位 busy 时改绑」直接抛错，不静默改绑。
7. **Scheduler 无 runner 时不执行任务**，只占用槽位返回句柄（Claude 的 BotRegistry 接入后传 runner 即可）；人设不存在时抛错且**不脏占槽位**。

## 3. 验证方式

```bash
npx tsc --noEmit        # 0 错误
npx vitest run tests/desktop/bot-persona-registry.test.ts tests/desktop/bot-slot-scheduler.test.ts tests/desktop/memory-store-v2.test.ts
# 3 files / 44 tests 全过
```

全量回归（本次改动后）：`467 tests → 466 passed / 1 failed`。
唯一失败 `desktop-entry.test.ts`（`document.addEventListener is not a function`）为**既有失败**——已用 `git stash` 暂存本次两个改动文件后单跑复现，与本次无关（疑与工作区里 src/ui/studio-chat-ui.ts 的未提交改动有关，属主开发线）。

关键验收点（分工方案完成标志）均有对应用例：
- `search("并发 bug")` 返回相关记忆 ✅（FTS bm25 + 标签加权）
- `invalidate(id)` 后 `list()` 不返回但数据保留 ✅（listInvalidated/restore）
- `listByPersona("audit")` 只返回该人设记忆 ✅
- `personaRegistry.load("audit-expert")` 返回完整人设包 ✅
- `scheduler.assign({slot:'S1', persona:'audit-expert', task:{...}})` 不抛错 ✅

## 4. 已知风险 / 未做

- **向量索引未做**（分工方案里「可选」）。当前混合检索 = FTS5 trigram + LIKE 兜底 + 标签加权；需要语义召回时再议（宿主侧无 embedding 基建）。
- **FTS trigram 对 <3 字符查询不命中**，由 LIKE 兜底覆盖（已测：2 字中文查询走 LIKE 仍命中）。
- **node:sqlite 是 Node 24 experimental API**：已做降级——不可用时自动退化为内存存储（读写/检索/失效/人设路由全功能可用，仅不持久化），控制台打 warn。Node < 22.5 的机器因此不会崩。
- **槽位绑定/账号为运行时态不落盘**：重启后由上层重新 seed（设计稿 P3 的账号健康检查接入时再定持久化形态）。
- 未 git push（等 Claude review 后合流）；未动 `src/host/bot/types.ts`（契约文件，主开发所有）。

## 5. 对 Claude 的接入说明（合并影响）

- 你的 `BotRegistry.create({slotId, personaName, engine})` 可直接吃我的产出：`PersonaRegistry.load(name)` → Persona；`SlotRegistry` 管槽位；建议 `Scheduler` 构造时传 runner = 你的 loop 执行体，assign 即完成「占槽 + 加载人设 + 执行 + 释放」闭环。
- 记忆层注入：`MemoryStoreV2.search(query, {personaTag})` / `listByPersona(tag)` 取子集，`formatForPrompt(memories)` 拼系统提示词（格式与现有注入一致）。
- 耦合面只有 `src/host/bot/types.ts`：我未改它；若你要改（如 Scheduler 签名、Memory 字段），按分工方案 §3 规则走 PR + description，我同步。
- desktop-host.ts 我只改了两处 memory 相关（`git diff` 可查，无其它改动），合并冲突应仅此一处。
