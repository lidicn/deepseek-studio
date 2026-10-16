# CodeBuddy 路线图：SubBotReport 数据层（v0.30）

> 下发：2026-10-16（主开发 Claude）
> 基线：总路线图 `docs/架构文档/路线图-Bot平台-v0.21-v0.38-20261014.md`
> 你的分支：`feat/bot-data`
> 你已交付：v0.21 记忆层 v2 + v0.22 Persona/Slot + v0.26 聊天室数据层 + v0.27a 路由/接力/编排算法层（commit c8207be）
> Claude 已交付：v0.23 BotRegistry + v0.24 多窗口 + v0.25 SlotRuntime + v0.27 聊天室接线 + v0.28 事件结构化推送（Claude 接管）+ v0.29 会议生命周期/陈旧摘要修复/摘要器超时

---

## 0. 为什么你之前空闲

上一版路线图（`路线图-CodeBuddy-当前批次与后续-v0.28收尾-20261015.md`）给你分了三件事：ChatRoomEvent 类型定义、onBotReply 数据准备、insights 列。**这三件 Claude 已全部接管完成**（v0.28 事件结构化推送由 Claude 在 chat-room-runtime.ts + desktop-host.ts + agent-channel.ts 实现，commits 0c881c4/8932cac/073170d）。你的 `feat/bot-data` 分支自 c8207be 后无新提交，不是你漏了——是任务被 Claude 吸收了。

**现在你有新活了。** v0.30 的核心是 SubBotReport 协议 + 离线执行 + 落盘。Claude 已定义全部接口 + 写了离线执行器/汇总/检测/接线/UI，**唯一缺 FS 落盘实现**——这是你的活。

---

## 1. 分工边界（严格遵守，与历次一致）

| 层 | 谁碰 | 文件范围 |
|---|---|---|
| 数据/算法层（消息存储、上下文、摘要、@解析、路由、接力、编排、**报告落盘**） | **CB** | `src/host/bot/` 下 |
| 宿主接线层（desktop-host、agent-channel、agent-loop、web-engine） | **Claude** | `src/host/` 下（非 bot/） |
| UI 层（聊天室 UI、侧栏、面板） | **Claude** | `src/ui/` + `src/desktop/` |
| Tauri/Rust 层 | **Claude** | `src-tauri/` |

**本次你只碰 1 个新文件 `src/host/bot/report-store.ts`。** 不碰 UI、不碰 agent-channel、不碰 Rust、不改 scheduler.ts / slot-runtime.ts（Claude 的离线执行器包装它们，不改签名）。

---

## 2. 你要做的事：ReportStore FS 实现

### 2.1 背景

v0.30 之前所有 bot 回复都是同步内联的（planRound 逐个 send，UI 等整轮）。审计等长任务需要子 bot 离线执行 → 产结构化 SubBotReport → 主 bot 汇总，不在聊天室里灌全文。

Claude 已完成的 v0.30 全部组件（在 `feat/bot-core` 分支）：

| 组件 | 文件 | 状态 |
|---|---|---|
| 契约接口（SubBotReport/Finding/ReportStore + 3 个新 ChatRoomEvent） | `src/host/bot/types.ts` | ✅ 已落 |
| prompt 构建 + 解析（复用 strategy-generator 模式） | `src/host/bot/report-protocol.ts` | ✅ 已落 |
| 离线执行器（包装 SlotRuntime.run + jsonl 转录 + 超时 + unloadPersona） | `src/host/bot/offline-runner.ts` | ✅ 已落 |
| 报告汇总（纯函数：去重/排序/markdown） | `src/host/bot/report-merge.ts` | ✅ 已落 |
| 测试桩（Map-based ReportStore） | `src/host/bot/in-memory-report-store.ts` | ✅ 已落 |
| 审计会议检测 + 调度编排 | `src/host/bot/audit-meeting.ts` | ✅ 已落 |
| 聊天室接线（audit 分支注入） | `src/host/bot/chat-room-runtime.ts` | 🔄 进行中 |
| 装配（Scheduler+runner+callbacks） | `src/host/desktop-host.ts` | 🔄 进行中 |
| UI（task 事件渲染） | `src/ui/studio-chat-room.ts` | 🔄 进行中 |

**Claude 用 `InMemoryReportStore` 测试桩跑通了全部逻辑 + 单测/集成测。真机需要你的 FS 版替换桩——`desktop-host.ts` 一行换 `new InMemoryReportStore()` → 你的 `new FileReportStore(runsDir)`。**

### 2.2 接口契约（已在 types.ts 锁定，你实现签名完全一致）

```ts
// src/host/bot/types.ts —— Claude 已定义，你实现这些方法

export interface ReportStore {
  /** mkdir -p runs/<batchId>，返回该批次目录路径。 */
  ensureBatchDir(batchId: string): string;
  /** 写 jsonl 一行到 runs/<batchId>/<slotId>.jsonl。 */
  appendTranscript(batchId: string, slotId: string, event: unknown): void;
  /** 原子写 runs/<batchId>/<slotId>.report.json。 */
  writeSubReport(batchId: string, slotId: string, report: SubBotReport): void;
  /** 读该批次所有 .report.json。 */
  readSubReports(batchId: string): SubBotReport[];
  /** 写 runs/<batchId>/summary.md，返回路径。 */
  writeMergedReport(batchId: string, content: string): string;
  /** 返回 summary.md 路径，不存在返 ''。 */
  getMergedReportPath(batchId: string): string;
}
```

### 2.3 你的实现要点

新建 `src/host/bot/report-store.ts`，导出 `FileReportStore` 类 implements `ReportStore`：

- **base dir** = `STUDIO_CONFIG_DIR/runs/`（对齐 `memory-store.ts:62` / `persona-registry.ts:27` 的 config dir 解析方式——读 `STUDIO_CONFIG` 环境变量或 `~/.config/deepseek-studio/`）
- `ensureBatchDir(batchId)`：`mkdirSync(path.join(runsDir, batchId), {recursive:true})`，返回完整路径
- `appendTranscript(batchId, slotId, event)`：`appendFileSync` 追加 `JSON.stringify(event) + '\n'` 到 `runs/<batchId>/<slotId>.jsonl`（单进程 node 架构，同步安全；参考 `file-storage-backend.ts:39-55` 的写法）
- `writeSubReport(batchId, slotId, report)`：**原子写** `runs/<batchId>/<slotId>.report.json`（写 tmp 文件 + `renameSync`，同 `file-storage-backend.ts:39-55` 的原子写模式，防写到一半被读到半截 JSON）
- `readSubReports(batchId)`：glob `*.report.json` 逐个 `JSON.parse`，返回 `SubBotReport[]`（批次目录不存在返 `[]`，不抛错）
- `writeMergedReport(batchId, content)`：写 `runs/<batchId>/summary.md`，返回完整路径
- `getMergedReportPath(batchId)`：`existsSync` 检查 summary.md，存在返路径否则返 `''`

**关键约束**：
- 不进 SQLite（设计稿 `docs/架构文档/设计稿-Bot编排-账号槽位人设三层解耦-20261014.md:161` 指定 FS jsonl + report.json，纯文件）
- batchId 格式：`batch-<base36时间>-<随机>`（Claude 的 chat-room-runtime 生成的，你只需当不透明字符串用，不要 parse）
- transcript 是 jsonl（每行一个 JSON 对象，`appendFileSync` 追加），不是单个 JSON 数组——离线执行器逐条事件写

### 2.4 测试

新建 `tests/desktop/bot-report-store.test.ts`：
- `ensureBatchDir` 创建目录（tmp dir 隔离，用 `os.tmpdir()` + 唯一子目录）
- `appendTranscript` 多次追加 → 读回文件验证每行是合法 JSON + 按序
- `writeSubReport` → `readSubReports` 往返一致（字段齐全）
- `readSubReports` 批次不存在返 `[]` 不抛
- `writeMergedReport` → `getMergedReportPath` 存在返路径
- `getMergedReportPath` 不存在返 `''`
- 原子写：写过程中即使读到文件也应是完整 JSON（可模拟：写后立即读，断言合法）

---

## 3. 衔接面与依赖时序

```
Claude 已落 types.ts 接口（SubBotReport/Finding/ReportStore）
        │
        ├── 解阻塞你：report-store.ts 可开工
        │
        └── Claude 用 InMemoryReportStore 桩并行建全部新文件（不等你）
                │
                └── 你交付 report-store.ts 后
                        │
                        └── Claude 在 desktop-host.ts 一行换：
                            new InMemoryReportStore() → new FileReportStore(runsDir)
```

**你现在就能开工**——types.ts 接口已在 `feat/bot-core` 分支。你从 `feat/bot-core` 拉最新（或只读 types.ts 的接口定义），在 `feat/bot-data` 实现 `report-store.ts`。两边不冲突：你只加新文件，Claude 的改动在接线层。

| 组件 | 谁 | 等 CB？ |
|---|---|---|
| types.ts 接口 | Claude | 否（✅ 已落） |
| report-protocol.ts（prompt+解析） | Claude | 否（✅ 已落） |
| offline-runner.ts | Claude | 否（✅ 已落，用 ReportStore 接口 + 桩） |
| report-merge.ts（纯函数） | Claude | 否（✅ 已落） |
| audit-meeting.ts | Claude | 否（✅ 已落） |
| in-memory-report-store.ts（桩） | Claude | 否（✅ 已落） |
| chat-room-runtime/desktop-host/UI 接线 | Claude | 否（用桩） |
| **report-store.ts（FS 实现）** | **CB** | **否——types.ts 已落，现在就能开工** |

---

## 4. 验收标准（CB 侧）

- `tsc --noEmit` 0 错误（含你的 `FileReportStore` 实现 + 测试）
- `tests/desktop/bot-report-store.test.ts` 全过
- `FileReportStore` 签名与 `types.ts` 的 `ReportStore` 接口完全一致（TS implements 不报错）
- 原子写 + jsonl 追加 + glob 读回的往返一致性
- 不改 scheduler.ts / slot-runtime.ts / 任何 Claude 已落的文件

---

## 5. 你后续的任务（预告）

| 版本 | 你的任务 | 时机 |
|---|---|---|
| v0.30 | **report-store.ts（FS 版 ReportStore）** | **现在** |
| v0.33 | Curator 完整治理（冲突+遗忘+路由+审计回滚）——记忆层 v2 延伸 | v0.32 完成后 |
| v0.35 | UI 数据绑定 | v0.34 完成后 |

---

## 6. 分支与合流

- 继续 `feat/bot-data` 分支
- 完成后写交接卡到 `docs/交接单/` → Claude review → 合流
- 不碰 `feat/bot-core`（Claude 的分支）

---

## 7. 你的启动清单

1. 拉最新 `feat/bot-core`，读 `src/host/bot/types.ts` 末尾的 `SubBotReport`/`Finding`/`ReportStore` 接口定义
2. 读 `src/host/bot/in-memory-report-store.ts`（Claude 的测试桩，你的 FS 版签名要和它一致——Claude 会一行换）
3. 读 `src/host/bot/report-merge.ts`（看 SubBotReport 的字段怎么被消费，确保你的 readSubReports 返回的结构对得上）
4. 读 `src/host/bot/file-storage-backend.ts:39-55`（原子写 tmp+rename 模式参考）
5. 读 `src/host/bot/memory-store.ts:62` + `persona-registry.ts:27`（config dir 解析方式参考）
6. 开工：新建 `src/host/bot/report-store.ts` → 写 `tests/desktop/bot-report-store.test.ts` → tsc + vitest → 写交接卡

---

*CB 任务已分发。Claude 并行做 chat-room-runtime 接线 + desktop-host 装配 + UI 渲染。两边靠交接单同步。Claude 先落 types.ts 接口已解阻塞你——现在就能开工。*
