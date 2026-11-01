<!-- 交付元数据：task=deepseek-studio-reply-source-design | hex=4bfd824ddc542b3a9eaa16e16f97bba4 | snapshot=06ddc6e50999 | gate=pass | 大号 | 2026-11-01 12:21 -->
# Studio 多源答复读取与判停设计稿

> 来源：MiMo Studio（大号 `.profile`，ultra 面）｜ command 39,913 字符 ｜ gate **pass**（`reasoning_ratio` warn 非阻断）
> 本文件是回收正文切掉推理段后的交付稿；仅将顶级标题 `## 3.x` 归一为 `## 设计/文件/测试/决策/验收`，**正文未改**。
> 原始回收：`E:\NAS\Lever-Hub\out\4bfd824ddc542b3a9eaa16e16f97bba4.md`（含投喂稿与推理）；门读数：`E:\NAS\Lever-Hub2\work\gates\deepseek-studio-reply-source-design\4bfd824ddc542b3a9eaa16e16f97bba4.json`

## 设计
### 3.1.0 范围

新增一层 `ReplySource`：把「DOM 读取」「注入层镜像」「SSE final-answer」三源收敛为带**新鲜度（Freshness）**与**轮次身份（RoundIdentity）**契约的统一抽象，向 `WebEngine` 只输出一个 `Decision`，判停由独立状态机消费。不改现有实现代码（本单只出设计）；不动 DOM 选择器配方（`src/capabilities/chat-read.ts:117`、`src/capabilities/chat-read.ts:148` 保持原样）；不涉及多窗口 bot。

### 3.1.1 现状与问题

三条来源今天散落在两份近似重复的轮询体里：`send()` 的路径判定在 `src/host/engine/web-engine.ts:375` 至 `src/host/engine/web-engine.ts:457`，`waitForNextReply()` 又抄了一遍 `src/host/engine/web-engine.ts:524` 至 `src/host/engine/web-engine.ts:606`。四个硬约束只活在注释里：

1. **基线必须在发送前取**（`src/host/engine/web-engine.ts:320`），否则模型 1–2s 内答完会被漏判（注释记载的复验 R4/R5，见 `src/host/engine/web-engine.ts:139`）。
2. **本轮身份优先用身份信号**（镜像助手条数增长 `src/host/engine/web-engine.ts:229`、SSE seq 递增 `src/host/engine/web-engine.ts:381`），文本比较只做兜底。
3. **绝不用旧答案冒充本轮**（`src/host/engine/web-engine.ts:467`：`sawNewText ? lastText : ''`）。
4. **「读不到」≠「模型还在答」**（`src/host/engine/web-engine.ts:53` 的 `maxEmptyReads`，`src/host/engine/web-engine.ts:413` 快速失败）。

问题：约束分散、两条路径各写一份、源优先级靠 if 顺序隐式表达、冲突（镜像与 DOM 都新鲜但文本不一致）静默取其一不可观测。

### 3.1.2 分层

```
WebEngine 轮询体
  └─ decideOnce(deps, rid, ensureLatest)        每拍一次，产出 Decision
       ├─ readSse(deps, rid)                    快路径：peek，不消费（seq>seqBefore 即权威）
       ├─ readSnapshot(deps, ensureLatest)      一次 dispatch('chat-read')
       │    ├─ readMirror(snap, rid)
       │    └─ readDom(snap, rid)
       └─ arbitrate(reads, state)               优先级 + 冲突记录
  └─ stepStop(state, decision, opts)            判停状态机（stableHits/emptyReads/sawNewText）
  └─ finalizeContent(state, last)               契约 3 的守门人
  └─ decideCompletion(...)                      原样复用 src/host/engine/web-engine.ts:25
```

关键点：**一次 dispatch 供三源共用**。现状里每拍进页一次（`src/host/engine/web-engine.ts:392`、`src/host/engine/web-engine.ts:544`），镜像与 DOM 同源于同一次 `chat-read` 返回（`src/capabilities/chat-read.ts:193`），共用快照既省往返，也消除「镜像读到新条数、DOM 读到旧文本」的撕裂快照。

### 3.1.3 契约一：RoundIdentity（轮次身份）

由 `send()` 在 chat-insert **之前**构造（对齐 `src/host/engine/web-engine.ts:323`），`waitForNextReply()` 复用（对齐 `src/host/engine/web-engine.ts:497`），TTL 10 分钟（`src/host/engine/web-engine.ts:149`），过期即由 `baselineStale()` 判定并重取（`src/host/engine/web-engine.ts:498`）。

字段：`sessionId`（`src/capabilities/chat-read.ts:79`）、`round`（`src/host/engine/web-engine.ts:246`）、`seqBefore`（`src/host/engine/web-engine.ts:319`）、`promptNeedle`（`src/host/engine/web-engine.ts:317`）、`baseline{mirrorCount, mirrorText, domText, at}`。

### 3.1.4 契约二：SourceReading（源读数 + 新鲜度）

每源每次读数携带：`text`（已按 `src/capabilities/chat-read.ts:69` 同款规则归一化空白）、`count`（该源的条数身份信号）、`identity ∈ {seq,count,text,none}`、`state ∈ {ok,empty,hard}`（语义沿用 `src/host/engine/web-engine.ts:188`：`empty` 不是错误）、`freshness`、`ageMs`（**只做观测，不参与判定**，避免时钟耦合）。

新鲜度四态：

| 源 | authoritative | new | stale |
|---|---|---|---|
| sse | `text≠'' && seq>seqBefore` | — | text≠'' 但 seq 未增 |
| mirror | — | `count>baseline.mirrorCount`（identity=count）或 `text≠baseline.mirrorText` | 都不成立 |
| dom | — | `text≠baseline.domText` 且非 prompt、非注入块 | 都不成立 |

### 3.1.5 优先级 / 回退 / 冲突

优先级常量：`sse=300 > mirror=200 > dom=100`，与现有 if 顺序一致（`src/host/engine/web-engine.ts:375` 先看 SSE，`src/host/engine/web-engine.ts:432` 镜像优先于 DOM）。

选择算法：在 `freshness ∈ {authoritative, new}` 且 `text≠''` 的读数里取优先级最高者；无 → `Decision{source:'none'}`，`StopState` 走「本轮未见新文本」分支，不吐旧答案。

冲突解决（**只记录、不融合**）：
- 两条新鲜读数文本不一致 → 记 `conflict{winner, loser, deltaChars}`，取高优先级者，**绝不拼接、不截断**。
- 若一方是另一方前缀（流式未完的早期快照），视为同一答案进行中，**不记冲突**，继续累计 `stableHits`。
- 三方同现：SSE 权威命中直接短路（对应 `src/host/engine/web-engine.ts:386` 的 break），不进 DOM 读取。
- 回退是"逐拍"的：本拍 sse 不新鲜并不禁止下一拍 sse 权威命中（auto-continue 轮可能晚到）。

**peek 与消费分离**：`readSse` 只 `getAutoReply()`（`src/host/engine/web-engine.ts:57`）peek；命中并被采纳后才由引擎侧走 `consumeAutoReply()`（`src/host/engine/web-engine.ts:59`）清 `fresh`，避免判停重试时丢答案。

### 3.1.6 契约三：判停状态机（StopPolicy）

把散在两处的 `prevSnapshot/stableHits/emptyReads/sawNewText` 收敛为一个 `StopState` + `stepStop()`：

- `stopped` → `stopped`（`src/host/engine/web-engine.ts:368`）
- `timedOut` → `timeout`（`src/host/engine/web-engine.ts:369`）
- SSE 权威命中 → `done`（`src/host/engine/web-engine.ts:386`）
- 聚合 `state=empty` → 累加 `emptyReads`，达 `maxEmptyReads` → `read-no-data`（`src/host/engine/web-engine.ts:413`）
- `text=''` 但 state=ok（候选被 prompt/注入块剔光）→ 清 `stableHits`、`continue`（`src/host/engine/web-engine.ts:440`，**不计入 emptyReads**）
- 文本变化 → `emit-delta`（回调 `onDelta`，`src/host/engine/web-engine.ts:445`）
- 连续两拍相同 → `done`（`src/host/engine/web-engine.ts:450`）

出口仍用 `decideCompletion()`（`src/host/engine/web-engine.ts:25`）映射 `complete/truncated/unknown`，`read-no-data` 单独映射 `disconnected + reason`（`src/host/engine/web-engine.ts:462`）。`finalizeContent()` 保证 `sawNewText=false ⇒ content=''`。`ensureLatest` 由状态驱动：`!st.sawNewText`（对齐 `src/host/engine/web-engine.ts:392`）。流式 delta（`pushStreamDelta`，`src/host/engine/web-engine.ts:121`）与本层解耦：delta 只喂 UI，判停只认 `Decision`。

### 3.1.7 可观测性

`SourceEvent` 四类：`read`（源、state、count、ageMs）、`pick`（选中源 + reason + round）、`conflict`（winner/loser/deltaChars）、`degraded`（源异常）。出口三条，全部复用既有钩子，不新增日志通道：

- `logger`（`src/host/engine/web-engine.ts:87`）：`pick/conflict` 并入每轮一条（`src/host/engine/web-engine.ts:247`）
- `onRoundComplete`（`src/host/engine/web-engine.ts:99`）：附加 `pickedSource/conflicts`
- `metrics.onEvent`（用法见 `src/host/engine/web-engine.ts:161`、`src/host/engine/web-engine.ts:168`）：`conflict` 记 `status` 类事件

现状已有的路径日志（`src/host/engine/web-engine.ts:434`、`src/host/engine/web-engine.ts:583`）在迁移完成后由 `pick` 事件替代，字段保持 `source/len/mirrorCount/atMs` 可比对。

### 3.1.8 迁移路径（4 阶段，可回退）

| 阶段 | 内容 | 回退 |
|---|---|---|
| P0 落层 | 新增 4 文件，纯函数，不接线 | 删文件即可 |
| P1 影子 | 引擎每拍同时跑旧判定与 `decideOnce`，只比对不生效，`emit` 记 `mismatch` | `replySourceMode='off'` |
| P2 收权 | 判定切到 `Decision`，旧 if 链降级为断言失败即回退旧路径 | `='shadow'` |
| P3 清理 | 删两份重复 if 链，路径日志改 `pick` 事件 | 无（此时已跑满一轮真机回归） |

开关 `replySourceMode: 'off' | 'shadow' | 'enforce'`，默认 `off` ⇒ 行为与现状逐拍一致。阶段门槛见 §3.5。

### 3.1.9 未读依赖处理

§2 的 6 个文件一律不 import：`ExecuteResult` 用结构化最小形状 `{ok, error?, data?}` 替代（只用到 `src/host/engine/web-engine.ts:196` 已出现的字段）；`HarnessMetrics`/`ToolEventBus` 不直接持有，指标经 `emit` 回调转出（形状参考 `src/host/engine/web-engine.ts:161`）；`CompletionStatus` 仍由 `src/host/engine/web-engine.ts:25` 的 `decideCompletion` 产出，不重定义枚举；`dom.ts`/`inject/types.ts` 的选择器与 role 推断不动（`src/capabilities/chat-read.ts:56` 起保持）。

### 3.1.10 风险与边界

- 镜像 `count` 在会话切换时归零 ⇒ 用 `sessionId`（`src/capabilities/chat-read.ts:79`）换会话即整体重置 `RoundIdentity`，不跨会话比较基线。
- 虚拟列表异步挂载（`src/capabilities/chat-read.ts:172` 的 60ms）在 chat-read 侧，本层不复制。
- prompt 剔除依赖 `promptNeedle` 长度 ≥8（`src/host/engine/web-engine.ts:215`），短 prompt 会退化为「候选为空」→ `continue`，不误判 stop。
- SSE 仅 auto-continue 轮有效（`src/host/engine/web-engine.ts:377`），普通轮主路径是镜像/DOM，优先级表必须保留 `sse` 缺席时的正常回退。

---

## 文件
**文件清单（新增 4 个；不改 `src/capabilities/chat-read.ts`、`src/host/engine/web-engine.ts` 的现有实现）**

- `src/host/reply-source/types.ts`
- `src/host/reply-source/sources.ts`
- `src/host/reply-source/arbiter.ts`
- `src/host/reply-source/stop-policy.ts`

不新增 `index.ts`（减少转发面，直接从各文件导入）。四个文件合计 **159 行**（≤200）。

### 3.2.1 `src/host/reply-source/types.ts`（41 行）

```ts
// 新增 src/host/reply-source/types.ts（本单只出设计；不改 src/capabilities/chat-read.ts / src/host/engine/web-engine.ts）
export type SourceKind = 'sse' | 'mirror' | 'dom';
export type ReadState = 'ok' | 'empty' | 'hard'; // 语义对齐 web-engine.ts:188-191
export type Freshness = 'authoritative' | 'new' | 'stale' | 'unknown';
export type Identity = 'seq' | 'count' | 'text' | 'none';

export interface RoundBaseline {
  mirrorCount: number; mirrorText: string; domText: string;
  at: number; // TTL=10min，见 web-engine.ts:149
}

export interface RoundIdentity {
  sessionId: string; round: number; seqBefore: number; // chat-read.ts:79-87 / web-engine.ts:246 / web-engine.ts:319
  promptNeedle: string; baseline: RoundBaseline; // web-engine.ts:317 / web-engine.ts:323
}

export interface SourceReading {
  kind: SourceKind; state: ReadState; text: string; count: number;
  identity: Identity; freshness: Freshness; ageMs: number;
}

export interface Decision {
  text: string; source: SourceKind | 'none';
  reason: 'sse-fresh' | 'mirror-count' | 'mirror-text' | 'dom-text' | 'none';
  state: ReadState; authoritative: boolean;
  conflicts: { winner: SourceKind; loser: SourceKind; deltaChars: number }[];
}

export type SourceEvent =
  | { type: 'read'; kind: SourceKind; state: ReadState; count: number; ageMs: number }
  | { type: 'pick'; kind: SourceKind | 'none'; reason: string; round: number }
  | { type: 'conflict'; winner: SourceKind; loser: SourceKind; deltaChars: number }
  | { type: 'degraded'; kind: SourceKind; error: string };

export interface ReplySourceDeps {
  // 形状照 web-engine.ts:57 的 getAutoReply；web-engine.ts:59 的 consumeAutoReply 归调用方自理
  getAutoReply?: () => { text: string; loop: number; updatedAt: number; fresh: boolean; seq?: number };
  // ExecuteResult 定义在 §2 未读文件里，这里用结构化最小形状，不引其内部字段
  dispatch(tool: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  emit(ev: SourceEvent): void;
}
```

### 3.2.2 `src/host/reply-source/sources.ts`（52 行）

```ts
import type { ReadState, ReplySourceDeps, RoundBaseline, RoundIdentity, SourceReading } from './types';

export interface RawSnapshot { ok: boolean; error?: string; sessionId?: string;
  messages?: { text?: string; injected?: boolean }[];
  mirror?: { count?: number; assistantTexts?: string[]; lastAssistantText?: string }; }

const BASELINE_TTL_MS = 10 * 60_000; // web-engine.ts:149
const norm = (t: string): string => (t ?? '').replace(/\s+/g, ' ').trim(); // chat-read.ts:69-75

export async function readSnapshot(deps: ReplySourceDeps, ensureLatest: boolean): Promise<RawSnapshot> {
  const r = await deps.dispatch('chat-read', ensureLatest ? { ensureLatest: true } : {});
  return { ok: !!r.ok, error: String(r.error ?? ''), ...((r.data ?? {}) as Record<string, unknown>) } as RawSnapshot;
}

export function classifySnapshot(s: RawSnapshot): ReadState {
  if (!s.ok) return String(s.error ?? '').includes('no-messages') ? 'empty' : 'hard'; // web-engine.ts:200-203
  return (s.messages ?? []).length === 0 && (s.mirror?.assistantTexts ?? []).length === 0 ? 'empty' : 'ok'; // web-engine.ts:225
}

export function snapshotBaseline(snap: RawSnapshot): RoundBaseline {
  const texts = (snap.mirror?.assistantTexts ?? []).map(norm).filter((t) => t.length > 0);
  const domText = (snap.messages ?? []).map((m) => norm(m.text ?? '')).filter((t) => t.length > 0).at(-1) ?? '';
  return { mirrorCount: snap.mirror?.count ?? texts.length, mirrorText: norm(snap.mirror?.lastAssistantText ?? ''), domText, at: Date.now() };
}

export function baselineStale(rid: RoundIdentity, now = Date.now()): boolean { return now - rid.baseline.at > BASELINE_TTL_MS; }

export function readSse(deps: ReplySourceDeps, rid: RoundIdentity): SourceReading {
  const ar = deps.getAutoReply?.(); const text = norm(ar?.text ?? ''); const seq = typeof ar?.seq === 'number' ? ar.seq : -1;
  const fresh = text.length > 0 && seq > rid.seqBefore; // web-engine.ts:381-384
  return { kind: 'sse', text, count: seq, identity: 'seq', state: text.length > 0 ? 'ok' : 'empty',
    freshness: fresh ? 'authoritative' : text.length > 0 ? 'stale' : 'unknown',
    ageMs: ar?.updatedAt ? Date.now() - ar.updatedAt : 0 };
}

export function readMirror(snap: RawSnapshot, rid: RoundIdentity): SourceReading {
  const texts = (snap.mirror?.assistantTexts ?? []).map(norm).filter((t) => t.length > 0);
  const text = norm(snap.mirror?.lastAssistantText ?? texts.at(-1) ?? ''); const count = snap.mirror?.count ?? texts.length; // web-engine.ts:231
  const grew = count > rid.baseline.mirrorCount; const changed = text.length > 0 && text !== rid.baseline.mirrorText; // web-engine.ts:428-430
  return { kind: 'mirror', text, count, identity: grew ? 'count' : changed ? 'text' : 'none',
    state: texts.length > 0 ? 'ok' : 'empty',
    freshness: grew || changed ? 'new' : text.length > 0 ? 'stale' : 'unknown', ageMs: Date.now() - rid.baseline.at };
}

export function readDom(snap: RawSnapshot, rid: RoundIdentity): SourceReading {
  const needle = rid.promptNeedle; const isPrompt = (t: string): boolean => needle.length >= 8 && t.includes(needle); // web-engine.ts:215
  const all = (snap.messages ?? []).map((m) => norm(m.text ?? '')).filter((t) => t.length > 0);
  const candidates = all.filter((t) => !isPrompt(t)).filter((t) => !t.includes('[studio-tool-capability]')); // web-engine.ts:222
  const text = candidates.at(-1) ?? ''; const changed = text.length > 0 && text !== rid.baseline.domText; // web-engine.ts:431
  return { kind: 'dom', text, count: all.length, identity: changed ? 'text' : 'none', state: all.length > 0 ? 'ok' : 'empty',
    freshness: changed ? 'new' : text.length > 0 ? 'stale' : 'unknown', ageMs: Date.now() - rid.baseline.at };
}
```

### 3.2.3 `src/host/reply-source/arbiter.ts`（38 行）

```ts
import type { Decision, ReadState, ReplySourceDeps, RoundIdentity, SourceKind, SourceReading } from './types';
import { classifySnapshot, readDom, readMirror, readSse, readSnapshot } from './sources';

const PRIORITY: Record<SourceKind, number> = { sse: 300, mirror: 200, dom: 100 };

export function arbitrate(reads: SourceReading[], state: ReadState): Decision {
  const eligible = reads
    .filter((r) => r.state === 'ok' && r.text.length > 0 && (r.freshness === 'authoritative' || r.freshness === 'new'))
    .sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind]);
  const winner = eligible[0];
  if (!winner) return { text: '', source: 'none', reason: 'none', state, authoritative: false, conflicts: [] };
  const conflicts = eligible.slice(1)
    .filter((r) => r.text !== winner.text && !r.text.startsWith(winner.text) && !winner.text.startsWith(r.text))
    .map((r) => ({ winner: winner.kind, loser: r.kind, deltaChars: Math.abs(r.text.length - winner.text.length) }));
  const reason = winner.kind === 'sse' ? 'sse-fresh' : winner.identity === 'count' ? 'mirror-count'
    : winner.kind === 'mirror' ? 'mirror-text' : 'dom-text';
  return { text: winner.text, source: winner.kind, reason, state, authoritative: winner.kind === 'sse', conflicts };
}

// 每拍编排：SSE 快路径先走（web-engine.ts:375-389），未命中再进页取一次快照（web-engine.ts:392）。
export async function decideOnce(deps: ReplySourceDeps, rid: RoundIdentity, ensureLatest: boolean): Promise<Decision> {
  const sse = readSse(deps, rid);
  if (sse.freshness === 'authoritative') {
    deps.emit({ type: 'pick', kind: 'sse', reason: 'sse-fresh', round: rid.round });
    return { text: sse.text, source: 'sse', reason: 'sse-fresh', state: 'ok', authoritative: true, conflicts: [] };
  }
  const snap = await readSnapshot(deps, ensureLatest);
  const d = arbitrate([readMirror(snap, rid), readDom(snap, rid)], classifySnapshot(snap));
  for (const c of d.conflicts) deps.emit({ type: 'conflict', winner: c.winner, loser: c.loser, deltaChars: c.deltaChars });
  deps.emit({ type: 'pick', kind: d.source, reason: d.reason, round: rid.round });
  return d;
}
```

### 3.2.4 `src/host/reply-source/stop-policy.ts`（28 行）

```ts
import type { Decision } from './types';

export interface StopState {
  prev: string | null; stableHits: number; emptyReads: number; sawNewText: boolean;
}

export type StopVerdict = 'continue' | 'emit-delta' | 'done' | 'read-no-data' | 'timeout' | 'stopped';

export function newStopState(): StopState {
  return { prev: null, stableHits: 0, emptyReads: 0, sawNewText: false };
}

export function stepStop(st: StopState, d: Decision, o: { maxEmptyReads: number; stableHitsNeeded?: number; timedOut: boolean; stopped: boolean }): StopVerdict {
  if (o.stopped) return 'stopped'; // web-engine.ts:368
  if (o.timedOut) return 'timeout'; // web-engine.ts:369
  if (d.authoritative) { st.sawNewText = true; st.prev = d.text; return 'done'; }
  if (d.state === 'empty') { st.emptyReads += 1; return st.emptyReads >= o.maxEmptyReads ? 'read-no-data' : 'continue'; } // web-engine.ts:413
  if (d.text.length === 0) { st.stableHits = 0; return 'continue'; } // web-engine.ts:440-443
  st.emptyReads = 0;
  st.sawNewText = true;
  if (d.text !== st.prev) { st.prev = d.text; st.stableHits = 0; return 'emit-delta'; } // web-engine.ts:445-447
  st.stableHits += 1;
  return st.stableHits >= (o.stableHitsNeeded ?? 2) ? 'done' : 'continue'; // web-engine.ts:450
}

export function finalizeContent(st: StopState, last: string): string {
  return st.sawNewText ? last : ''; // web-engine.ts:467
}
```

**接线说明（属后续实现卡，本单不改代码）**：`send()`/`waitForNextReply()` 里的取基线、每拍判定、稳定计数、判停四段，替换为 `snapshotBaseline` / `decideOnce` / `stepStop` / `finalizeContent`；`decideCompletion`（`src/host/engine/web-engine.ts:25`）、`read-no-data` 映射（`src/host/engine/web-engine.ts:462`）、`roundBaseline` 交接（`src/host/engine/web-engine.ts:618`）保持原位不动。

---

## 测试
测试运行器与断言库沿用仓内现状（§1 未载，落实现卡时对齐）。全部为纯函数单测 + 假 `deps`，无网络、无真 DOM；`ageMs` 只断言存在性，不参与判定，故不需要伪造时钟。

**新增测试文件**

- `src/host/reply-source/sources.test.ts`：三源归一化 / 新鲜度判定 / prompt 与注入块剔除 / `classifySnapshot` / `baselineStale`
- `src/host/reply-source/arbiter.test.ts`：优先级、回退、冲突、前缀容忍
- `src/host/reply-source/stop-policy.ts` 的伴随用例 `src/host/reply-source/stop-policy.test.ts`：判停状态机、`finalizeContent` 守门
- `src/host/reply-source/parity.test.ts`：影子对照——同一「快照序列 + SSE 序列」喂旧判定（复刻 `src/host/engine/web-engine.ts:428` 的选择式）与 `decideOnce`，断言选中源与文本逐拍一致

**测试矩阵**

| # | 场景（三源状态） | 期望 source/reason | 期望 verdict | 期望 completion |
|---|---|---|---|---|
| 1 | sse `seq>seqBefore` 且 text≠'' | sse / sse-fresh | done | complete |
| 2 | sse text≠'' 但 seq 未增 | 非 sse（freshness=stale 不入选） | 按镜像/DOM | complete |
| 3 | 镜像 `count=基线+1` | mirror / mirror-count | emit-delta→done | complete |
| 4 | 镜像 count 未变、文本变 | mirror / mirror-text | emit-delta→done | complete |
| 5 | 镜像空、DOM 文本变 | dom / dom-text | emit-delta→done | complete |
| 6 | DOM 末条为本轮 prompt | 剔除后取上一条；全被剔则 source=none | continue（不计 emptyReads） | — |
| 7 | 含 `[studio-tool-capability]` 的候选 | 剔除（`src/host/engine/web-engine.ts:222`） | continue | — |
| 8 | 三源皆空连续 10 拍 | none | read-no-data | disconnected + reason=read-no-data |
| 9 | dispatch 报非 no-messages 错误 | state=hard | 走重连，失败即返回 | disconnected |
| 10 | `waitForNextReply` 复用 send 基线，镜像 count 未增 | none | continue | 继续等 |
| 11 | 基线 `at` 超 10 分钟 | `baselineStale=true` → 重取基线 | — | — |
| 12 | 镜像长文 vs DOM 短文同新鲜 | mirror，conflict{deltaChars>0} | emit-delta→done | complete |
| 13 | 镜像文本为 DOM 前缀（流式未完） | mirror，**不**记 conflict | continue 累计 stableHits | — |
| 14 | 连续两拍同文本 | 同源 | 第二拍 done | complete |
| 15 | `isStopped()` 置位 / 超时且 `sawNewText=false` | — | stopped / timeout | unknown / truncated，`finalizeContent` 返回 '' |

补充断言（不变量级）：① 任意序列下 `finalizeContent` 在 `sawNewText=false` 时必为 `''`（契约 3）；② `stepStop` 的 `emptyReads` 只在 `state==='empty'` 累加；③ `arbitrate` 不会产出「源=none 但 text≠''」；④ `decideOnce` 在 sse 权威命中时**不**发起 `dispatch`（假 deps 断言调用次数为 0）；⑤ 影子对照在 15 条矩阵输入上零 mismatch，才允许进 P2。

---

## 决策
- **D1 不改 chat-read 输出线格式**：`data.messages` / `data.mirror`（`src/capabilities/chat-read.ts:203`）是 host↔content 边界（`src/host/engine/web-engine.ts:195`），改形状需两端同步且超出本单范围；新层只做消费端收敛。
- **D2 一次 dispatch 三源共用**：消除 `src/host/engine/web-engine.ts:392` 与 `src/host/engine/web-engine.ts:544` 双读造成的快照撕裂，并省一次页端往返。
- **D3 身份信号优先于文本比较**：`seq`、镜像 `count` 单调递增是硬信号，文本比较只兜底——直接固化 `src/host/engine/web-engine.ts:229` 与 `src/host/engine/web-engine.ts:320` 记载的复验结论。
- **D4 固定优先级、不加权投票**：`sse > mirror > dom` 可预测、可逐拍断言；冲突只记录不融合，避免拼接出半真半假的答案。
- **D5 不 import §2 未读类型**：`ExecuteResult`/`HarnessMetrics` 等以结构化最小形状与 `emit` 回调绕开，不猜未读字段。
- **D6 peek 与消费分离**：`readSse` 只读不清 `fresh`，采纳后才 `consumeAutoReply`（`src/host/engine/web-engine.ts:59`），保住判停重试。
- **D7 completion 不重写**：仍由 `decideCompletion`（`src/host/engine/web-engine.ts:25`）产出，状态枚举与降级语义零漂移。
- **D8 默认 `replySourceMode='off'`**：P1 影子模式只比对不生效，任何 mismatch 可一键回退，迁移风险压到零。

---

## 验收
- **A1 结构**：`设计`/`文件`/`测试`/`决策`/`验收` 五节齐备，尾标单独成行（对应 S1/S2）。
- **A2 引用**：正文引用仅用 `path:line`，且全部落在 §1 已载行号内（S3）；§2 未读文件只以「不依赖」形式出现，未虚构其内部符号。
- **A3 文件清单**（S4）：新增 4 个文件，逐一给完整内容；`src/capabilities/chat-read.ts`、`src/host/engine/web-engine.ts` 现有实现零改动。
- **A4 预算**：四文件合计 159 行 ≤ 200（S5 预算同源约束）。
- **A5 行为等价**：§3.3 矩阵 15 条全绿，且 `parity.test.ts` 零 mismatch，方可在实现卡上把 `replySourceMode` 由 `shadow` 切 `enforce`。
- **A6 真机回归（实现卡执行）**：① auto-continue 轮走 sse 快路径；② 普通轮走 mirror/dom；③ 复验 R4/R5 场景（`src/host/engine/web-engine.ts:139` 注释记载的 130s 空转、基线漏判）不复现；④ `read-no-data` 仍在 ~15s 内快速失败（`src/host/engine/web-engine.ts:131`）；⑤ 切会话后不跨 `sessionId` 比较基线。
- **A7 可观测性**：每轮 `logger` 至少含 `pick{kind,reason}`，出现分歧时含 `conflict{winner,loser,deltaChars}`，字段与既有路径日志（`src/host/engine/web-engine.ts:434`）可对齐比对。
- **A8 迁移门槛**：P0→P1 需 A5；P1→P2 需 A5+A6；P2→P3 需 A6+A7 且影子模式跑满一轮真机回归无 mismatch。

<!--EOA:deepseek-studio-reply-source-design-->
