/**
 * 网页模型引擎（M1）：把 chat.deepseek.com 页面当作无头模型用。
 *
 * 链路：chat-insert（写入文本）→ chat-send（触发发送）→ 轮询 chat-read 做完成检测。
 * 工具调用不走这里——页面内拦截器流式解析工具标签 → ws 反向投递 → hub 执行
 * （完整授权链）→ 结果存入拦截器 pending → 下一次出站请求自动回填。
 * 引擎只负责「发消息 + 等回复 + 报告期间发生了几次工具调用」。
 *
 * 完成检测：快照连续 2 次稳定（间隔 pollIntervalMs）且与发送前基线不同，即认为回复结束；
 * 单步看门狗（默认 120s）兜底，超时把已见文本带 timedOut 标记返回。
 */

import type { CompletionStatus, EngineSendResult, ModelEngine, ToolCallRecord } from './model-engine';
import type { HarnessMetrics } from '../../shared/harness-metrics';
import type { ToolEventBus } from '../../shared/tool-event-bus';
import { createHarnessMetrics } from '../../shared/harness-metrics';

// ---------------------------------------------------------------- pure completion decision

/**
 * S2：纯函数——根据一轮的退出原因判定完成状态。
 * 纯逻辑、无副作用，便于单测。
 */
export function decideCompletion(opts: {
  timedOut: boolean;
  dispatchFailed: boolean;
  stopped: boolean;
  partial?: boolean;
}): CompletionStatus {
  if (opts.dispatchFailed) return 'disconnected';
  if (opts.timedOut) return 'truncated';
  if (opts.stopped) return 'unknown';
  return 'complete';
}

// ---------------------------------------------------------------- options

export interface WebEngineOptions {
  /**
   * 页端 DOM 能力调用入口（desktop-host.invokeTool：完整授权链 + 同意闸门）。
   *
   * C1-F6 根因（20261101 真机取证）：这里原来声明成 `ExecuteResult`（只有 `error?`），
   * 但实际注入的是 `desktop-host.routeExecution`，返回 `ToolExecutionResult`——它把能力层的
   * `error` **映射成了 `reason`**（`desktop-host.ts:1811` 的 `reason: r.error`）。
   * 声明与运行时形状不一致，TS 按错的形状检查，于是「读 `r.error` 得空串」在闸门下完全隐形：
   * 真机 `chat-read` 软失败（`no-messages-found`）被判成硬失败 → 重连×3 → `empty-response`。
   * 故这里显式声明两种字段都在。
   */
  dispatch(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string; reason?: string }>;
  /** 工具调用计数器（由 desktop-host 的 hub.onToolCall 累加）。 */
  toolCallCounter: { current: number };
  /** 完成检测轮询间隔（默认 1500ms）。 */
  pollIntervalMs?: number;
  /** 单步看门狗（默认 120_000ms）。 */
  stepTimeoutMs?: number;
  /**
   * C1-F6：连续多少次「读不到数据」就快速失败（默认 **9**）。
   * 超过即返回 `completion='disconnected'` + `reason='read-no-data'`，
   * 不再空转到 120s 看门狗——「读不到」和「模型还在答」必须能被区分。
   *
   * 为什么是 9 而不是 10：每拍还有读取代价，实测 10 拍 × 1500ms + 读取 ≈ **15.8s**，
   * 超出 15s 速度线 0.85s（Verify 20261101 真机读数 `elapsedMs=15852`）。
   * 9 拍 ≈ 13.5s + 读取代价，留出余量后仍严格落在 15s 内。
   */
  maxEmptyReads?: number;
  /** 中止钩子：AgentLoop.stop() 置位后，等待中的 send 尽快返回。 */
  isStopped?(): boolean;
  /** v0.9：读取页端 auto-continue 推送的模型回复（不渲染到 DOM）。 */
  getAutoReply?(): { text: string; loop: number; updatedAt: number; fresh: boolean; seq?: number };
  /** v0.9：消费（读取并清除 fresh 标志）页端 auto-continue 推送的回复。 */
  consumeAutoReply?(): { text: string; loop: number; updatedAt: number; fresh: boolean; seq?: number };
  /**
   * M2-2：工具调用结构化回调。传入后，WebEngine 会在本轮 send/waitForNextReply 期间
   * 累积每条 ToolCallRecord，并在返回值里填充 toolCallRecords 数组。
   * 未传入时 toolCallRecords 为 undefined，行为与改动前完全一致。
   */
  onToolCall?(rec: ToolCallRecord): void;
  /**
   * M1-2：可选注入的 harness 指标收集器。外部注入方便测试与替换；
   * 未注入时行为与之前完全一致。
   */
  metrics?: HarnessMetrics;
  /**
   * M1-2：若未注入 metrics，可传入 toolEventBus 由引擎内部懒创建。
   * 两者都不传时 metrics 为 undefined，getMetrics() 返回 undefined。
   */
  toolEventBus?: ToolEventBus;
  /**
   * S4：断流恢复——轮询中 dispatch 失败时尝试重连的最大次数（默认 3）。
   * 重连通过 health() 探测；耗尽后本轮以 completion='disconnected' 返回。
   */
  maxReconnectAttempts?: number;
  /** S4：重连退避基数 ms（默认 500，线性退避：第 n 次等 n*backoff）。 */
  reconnectBackoffMs?: number;
  /**
   * S5：结构化日志注入。每轮结束打一条 {round, completion, toolCalls, elapsedMs}。
   * 未注入时默认 no-op，不污染测试输出。
   */
  logger?: (entry: Record<string, unknown>) => void;
  /**
   * S7：流式 delta 回调。轮询中检测到文本增长时回调当前累计文本。
   * 不传时行为完全不变。
   */
  onDelta?: (text: string) => void;
  /**
   * S8：send() 初始请求（chat-insert/chat-send）失败时的重试次数（默认 2）。
   * 指数退避：500ms / 1500ms。仅重试幂等的初始发送，不重试已发 tool call 的轮次。
   */
  maxSendRetries?: number;
  /** S21：每轮结束输出结构化事件，未注入则静默。 */
  onRoundComplete?: (entry: { round: number; content: string; toolCalls: number; completion: CompletionStatus; durationMs: number }) => void;
  /**
   * S24：MutationObserver 流式 delta 钩子。宿主注入脚本通过 postMessage 推送 delta，
   * WebEngine 收到后转发给 onDelta。真机验证前此回调不自动触发。
   */
  streamPush?: (text: string) => void;
}

export interface WebEngine extends ModelEngine {
  /** WebEngine 一定实现（覆盖 ModelEngine 的可选声明）。 */
  waitForNextReply(): Promise<EngineSendResult>;
  /**
   * M2-2：由 hub 在执行完一次工具调用后调用，把结构化记录喂进当前轮的缓冲区。
   * 仅当创建时传了 onToolCall 才有意义；否则缓冲为 null，此调用为空操作。
   */
  recordToolCall(rec: ToolCallRecord): void;
  /** M1-2：获取当前 harness 指标（可能为 undefined，取决于注入方式）。 */
  getMetrics(): HarnessMetrics | undefined;
  /** S4：获取本轮已尝试的重连次数（测试断言用）。 */
  getReconnectAttempts(): number;
  /** S15：完整清理（metrics dispose、缓冲清空）。 */
  destroy(): void;
  /** M9：外部推流式 delta（页端 SSE 逐 token 推送），转发给 onDelta。 */
  pushStreamDelta(text: string): void;
}

export function createWebEngine(options: WebEngineOptions): WebEngine {
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const stepTimeoutMs = options.stepTimeoutMs ?? 120_000;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
  const reconnectBackoffMs = options.reconnectBackoffMs ?? 500;
  // C1-F6：连续多少次「能力跑通但读不到数据」就快速失败，而不是烧满 120s 看门狗。
  // 10 拍 × 默认 1.5s ≈ 15s，足够覆盖「页面刚发出去、DOM/镜像还没落地」的正常窗口。
  const maxEmptyReads = options.maxEmptyReads ?? 9;

  // M2-2：本轮工具调用记录缓冲。仅当 options.onToolCall 存在时才创建（非 null）。
  // 每次 send / waitForNextReply 开始时重置，结束时随返回值带出。
  let currentRecords: ToolCallRecord[] | null = options.onToolCall ? [] : null;

  /**
   * F1（复验 R5 决定性缺陷）：**本轮身份基线**，由 `send()` 在发送之前取，
   * 随后的 `waitForNextReply()` 复用同一条基线。
   *
   * 为什么必须复用：续跑等待原来在**自己开始时**重取基线，而那时答案早已落地
   * （复验 R5：正控镜像 15 条，发送后 2s 变 16 并恒定），于是「条数增长 / 文本变化」
   * 全部为假 → `candidate=''` → 空转到 120s → 对外 500（实测 129.8s）。
   * 只在这一轮有效（`at` 超过 10 分钟视为陈旧）。
   */
  let roundBaseline: { mirrorCount: number; mirrorText: string; text: string; at: number } | null = null;

  const BASELINE_TTL_MS = 10 * 60_000;

  // M1-2：harness 指标。外部注入优先；否则若给了 bus 则懒创建。
  let metrics: HarnessMetrics | undefined = options.metrics;
  if (!metrics && options.toolEventBus) {
    metrics = createHarnessMetrics(options.toolEventBus);
  }

  function recordToolCall(rec: ToolCallRecord): void {
    if (currentRecords) currentRecords.push(rec);
    options.onToolCall?.(rec);
    // M1-2：把工具调用事件喂给 harness 指标（type='tool' 回合计数）。
    metrics?.onEvent({ type: 'tool', text: rec.tool, toolCalls: 1 });
  }

  /** S3：一轮结束时按 completion 关闭指标回合。truncated/disconnected → 记 nudge。 */
  function closeRoundForMetrics(completion: CompletionStatus): void {
    if (!metrics) return;
    if (completion === 'truncated' || completion === 'disconnected') {
      metrics.onEvent({ type: 'status', text: `纠偏（completion=${completion}）` });
    }
    metrics.onEvent({ type: 'assistant' });
  }

  /**
   * F1：读一次对话快照。
   *
   * - `state:'hard'` = 页面能力不可用（no-page / no-document）→ 硬失败，走重连/退出；
   * - `state:'empty'` = 读到了但没有非空文本（答案还没挂载）→ **不是错误**，继续等；
   * - `state:'ok'` = 读到内容。
   *
   * `promptText`：本轮刚发给模型的原文。用户自己的气泡**一定**在 DOM 里、且常常是最后一条，
   * 把它当答案就是 F1 的主要症状（宿主把「我刚发的 prompt」当模型回答），
   * 所以这里按「文本包含 prompt」把它剔除。
   */
  async function readConversation(
    promptText: string,
    ensureLatest: boolean,
  ): Promise<{
    state: 'ok' | 'empty' | 'hard';
    text: string;
    mirrorText: string;
    mirrorCount: number;
    count: number;
    texts: string[];
  }> {
    const r = await options.dispatch('chat-read', ensureLatest ? { ensureLatest: true } : {});
    if (!r.ok) {
      // C1-F6：`error` 是能力层字段，`reason` 是宿主路由层字段（`routeExecution` 把前者映射成后者）。
      // 两个都要读——只读 `error` 时真机恒为空串，软失败被误判成硬失败（见 WebEngineOptions.dispatch 注释）。
      const err = String(r.error ?? r.reason ?? '');
      // 只有「能力跑通了、但这会儿没有可读的消息」才算「还没读到」→ 继续等。
      // 其余失败（no-page-for-dom-capability / 传输失败 …）都是**硬失败** → 走 S4 重连。
      if (err.includes('no-messages')) {
        return { state: 'empty', text: '', mirrorText: '', mirrorCount: 0, count: 0, texts: [] };
      }
      // 取证打点（一行）：真机 F6 走到 hard 提前 return，但 `error` 的真实内容一直看不到，
      // 导致「字段错位」与「实际是别的硬失败」两种解释都站不住。这里把 err 原样打出来，
      // 用于区分 no-page-runtime / page-timeout / unknown-tool / 异常消息。
      console.log(`[web-engine] read-hard err=${err.slice(0, 160)}`);
      return { state: 'hard', text: '', mirrorText: '', mirrorCount: 0, count: 0, texts: [] };
    }
    const data = r.data as {
      count?: number;
      messages?: { text?: string; injected?: boolean }[];
      mirror?: { count?: number; assistantTexts?: string[]; lastAssistantText?: string };
    } | undefined;
    const raw = data?.messages ?? [];
    const all = raw
      .map((m) => (m.text ?? '').trim())
      .filter((t) => t.length > 0);
    const needle = promptText.trim();
    const isPrompt = (t: string): boolean => needle.length >= 8 && t.includes(needle);
    // 候选：非空、不是本轮刚发的 prompt、不是带能力前导注入的用户气泡。
    // （真机上每条用户消息都挂 ~10k 的 `[studio-tool-capability]` 前导块，
    //   不剔除的话「最后一条消息」永远是它而不是答案。）
    const candidates = raw
      .filter((m) => (m.text ?? '').trim().length > 0)
      .filter((m) => !isPrompt((m.text ?? '').trim()))
      .filter((m) => m.injected !== true && !(m.text ?? '').includes('[studio-tool-capability]'))
      .map((m) => (m.text ?? '').trim());
    return {
      state: all.length === 0 && (data?.mirror?.assistantTexts?.length ?? 0) === 0 ? 'empty' : 'ok',
      text: candidates.at(-1) ?? '',
      // SSE 派生答案（Studio 注入层镜像，不受虚拟列表挂载影响）。
      mirrorText: (data?.mirror?.lastAssistantText ?? '').trim(),
      // 镜像里助手消息的条数——**身份信号**：条数增长 = 本轮答案落地，
      // 比「文本 ≠ 基线」稳（模型 1–2s 就答完，基线取在发送之后会漏判）。
      mirrorCount: data?.mirror?.count ?? (data?.mirror?.assistantTexts?.length ?? 0),
      count: data?.count ?? all.length,
      texts: all,
    };
  }

  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  // S4：重连计数（测试断言用）。
  let reconnectAttempts = 0;
  // S5：轮次计数。
  let roundNum = 0;

  /** S5：打一条结构化日志（未注入 logger 则 no-op）。 */
  function logRound(elapsedMs: number, completion: CompletionStatus, toolCalls: number, content: string): void {
    const round = ++roundNum;
    options.logger?.({
      round,
      completion,
      toolCalls,
      elapsedMs,
      reconnects: reconnectAttempts,
    });
    options.onRoundComplete?.({
      round,
      content,
      toolCalls,
      completion,
      durationMs: elapsedMs,
    });
  }

  /** S4：轮询中检测到 dispatch 失败时，尝试重连。成功返回 true。 */
  async function tryReconnect(): Promise<boolean> {
    for (let i = 1; i <= maxReconnectAttempts; i++) {
      reconnectAttempts = i;
      await sleep(reconnectBackoffMs * i); // 线性退避
      const h = await options.dispatch('chat-read', {});
      if (h.ok) return true;
    }
    return false;
  }

  return {
    name: 'web',
    recordToolCall,
    getMetrics(): HarnessMetrics | undefined {
      return metrics;
    },
    getReconnectAttempts(): number {
      return reconnectAttempts;
    },
    destroy(): void {
      metrics?.dispose();
      currentRecords = null;
    },
    pushStreamDelta(text: string): void {
      // M9：外部推流式 delta，转发给 onDelta（UI 打字机效果）
      options.onDelta?.(text);
    },
    async health() {
      // M9：health 探测加 5 秒超时，避免页端无响应时挂死。
      // W7：race 结束统一 clearTimeout，赢家分支不再悬空 timer（原 Promise.race 输掉分支不撤 dispatch）。
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([
          options.dispatch('chat-read', {}),
          new Promise<{ ok: false; error: string; reason?: string }>((resolve) =>
            // 保留 dispatch 取消标志；timer 句柄透出供 finally 清理。
            (timer = setTimeout(() => resolve({ ok: false, error: 'health-timeout' }), 5000)),
          ),
        ]);
        if (r.ok) return { ok: true };
        return { ok: false, reason: r.error ?? r.reason ?? 'chat-read-failed' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async send(text: string): Promise<EngineSendResult> {
      // 工具调用计数从本轮起点清零
      const counterStart = options.toolCallCounter.current;
      // M2-2：每轮重置缓冲（onToolCall 存在时新建空数组）
      currentRecords = options.onToolCall ? [] : null;

      // F1：本轮发给模型的原文。宿主据此把**用户自己的气泡**从候选答案里剔除
      // （用户气泡总是 DOM 里最后一条、且含记忆注入块 ~10k 字符）。
      const promptText = typeof text === 'string' ? text.trim() : '';
      // F1：本轮开始前的 SSE 回复序号，用来判断「这条 SSE 回复是不是本轮的」。
      const autoReplySeqBefore = options.getAutoReply?.().seq ?? -1;
      // F1：**基线必须在发送之前取**。模型常常 1–2s 就答完，而基线原来取在 chat-send
      // 之后 —— 那时代码里「文本 ≠ 基线」的判停就会漏掉已经到达的答案（复验 R4 的 130s）。
      // 现在基线同时记三样：DOM 候选文本、镜像最后一条答案、**镜像助手条数**（身份信号）。
      const baselineRead = await readConversation(promptText, false);
      const baselineText = baselineRead.text;
      const baselineMirror = baselineRead.mirrorText;
      const baselineMirrorCount = baselineRead.mirrorCount;
      // 把本轮基线留给紧随其后的 waitForNextReply（续跑轮）。
      roundBaseline = {
        mirrorCount: baselineRead.mirrorCount,
        mirrorText: baselineRead.mirrorText,
        text: baselineRead.text,
        at: Date.now(),
      };
      console.log(
        `[web-engine][path] send-start baseMirror=${baselineRead.mirrorCount} ` +
          `baseMirrorLen=${baselineRead.mirrorText.length} baseDomLen=${baselineRead.text.length}`,
      );

      // S8：初始发送带指数退避重试
      const maxSendRetries = options.maxSendRetries ?? 2;
      let insOk = false, sentOk = false;
      for (let attempt = 0; attempt <= maxSendRetries; attempt++) {
        if (attempt > 0) await sleep(500 * Math.pow(3, attempt - 1)); // 500ms, 1500ms
        const ins = await options.dispatch('chat-insert', { text });
        if (!ins.ok) continue;
        const sent = await options.dispatch('chat-send', {});
        if (sent.ok) { insOk = true; sentOk = true; break; }
      }
      if (!insOk || !sentOk) {
        closeRoundForMetrics('disconnected');
        return { content: '', toolCalls: 0, toolCallRecords: currentRecords ?? undefined, completion: 'disconnected' };
      }

      const startedAt = Date.now();

      let prevSnapshot: string | null = null;
      let stableHits = 0;
      let lastText = '';
      let timedOut = false;
      let stopped = false;
      // F1：是否见到过「本轮」的新文本。没见到就**绝不返回旧答案**冒充本轮结果。
      let sawNewText = false;
      // C1-F6：连续「读不到数据」计数（超过 maxEmptyReads 快速失败）。
      let emptyReads = 0;
      let readNoData = false;

      for (;;) {
        if (options.isStopped?.()) { stopped = true; break; }
        if (Date.now() - startedAt > stepTimeoutMs) {
          timedOut = true;
          break;
        }
        await sleep(pollIntervalMs);

        // ① SSE 通道优先：页端拦截器推来的回复带单调 seq，比本轮开始时新 → 权威答案。
        //    注意：普通回合（非 auto-continue）页端**不会**推 SSE
        //    （src/inject/main-world-interceptor.ts:2093 明确「普通回合 autoReplyText 恒为空」），
        //    所以这条只在 auto-continue 轮生效；普通轮走 ② DOM。
        const ar = options.getAutoReply?.();
        if (
          ar &&
          typeof ar.seq === 'number' &&
          ar.seq > autoReplySeqBefore &&
          (ar.text ?? '').trim().length > 0
        ) {
          lastText = ar.text;
          sawNewText = true;
          break;
        }

        // ② DOM 读取。虚拟列表只挂载视口内的项 → 让页端 ensureLatest 滚到底部强制挂载最新项。
        const snap = await readConversation(promptText, !sawNewText);
        if (snap.state === 'hard') {
          // S4：页面能力不可用 → 尝试重连
          const reconnected = await tryReconnect();
          if (!reconnected) {
            closeRoundForMetrics('disconnected');
            const tc = options.toolCallCounter.current - counterStart;
            logRound(Date.now() - startedAt, 'disconnected', tc, lastText);
            return {
              content: lastText,
              toolCalls: tc,
              toolCallRecords: currentRecords ?? undefined,
              completion: 'disconnected',
            };
          }
          continue;
        }
        if (snap.state === 'empty') {
          // 「还没读到」不是错误：继续等（答案可能还没挂载 / 虚拟列表还没滚到底）。
          // C1-F6：但连续读不到要快速失败——否则页面能力彻底不可用时仍会烧满 120s 看门狗。
          emptyReads += 1;
          if (emptyReads >= maxEmptyReads) {
            readNoData = true;
            console.log(
              `[web-engine] read-no-data after ${emptyReads} empty reads (elapsedMs=${Date.now() - startedAt})`,
            );
            break;
          }
          continue;
        }
        emptyReads = 0;
        // 答案候选（按可靠性排序）：
        //   ① SSE 派生镜像（Studio 注入层 .ds-sc-msg-assistant）——不受虚拟列表影响，答案一落地就在；
        //   ② 真实 DOM 里「非本轮 prompt、非能力前导注入」的最后一条消息。
        // 判「是不是本轮」用**身份信号**（镜像助手条数增长）**或**文本变化，
        // 不再只靠「文本 ≠ 基线」——模型 1–2s 就答完，纯文本比较会漏判。
        const mirrorNew =
          snap.mirrorCount > baselineMirrorCount ||
          (snap.mirrorText.length > 0 && snap.mirrorText !== baselineMirror);
        const domChanged = snap.text.length > 0 && snap.text !== baselineText;
        const candidate = mirrorNew && snap.mirrorText.length > 0 ? snap.mirrorText : domChanged ? snap.text : '';
        if (candidate.length > 0) {
          console.log(
            `[web-engine][path] send-pick source=${mirrorNew && snap.mirrorText.length > 0 ? 'mirror' : 'dom'} ` +
              `len=${candidate.length} mirrorCount=${snap.mirrorCount} baseMirror=${baselineMirrorCount} ` +
              `atMs=${Date.now() - startedAt}`,
          );
        }
        if (candidate.length === 0) {
          stableHits = 0;
          continue;
        }
        lastText = candidate;
        if (candidate !== prevSnapshot) {
          options.onDelta?.(candidate); // S7：delta 回调
        }
        if (candidate === prevSnapshot) {
          stableHits += 1;
          if (stableHits >= 2) {
            sawNewText = true;
            break;
          }
        } else {
          stableHits = 0;
        }
        prevSnapshot = candidate;
      }

      const toolCalls = options.toolCallCounter.current - counterStart;
      // C1-F6：连续读不到数据 → 快速失败（disconnected + read-no-data），不烧满看门狗。
      const completion: 'complete' | 'truncated' | 'disconnected' | 'unknown' = readNoData
        ? 'disconnected'
        : decideCompletion({ timedOut, dispatchFailed: false, stopped });
      closeRoundForMetrics(completion);
      // F1：超时且从未见到本轮新文本 → 返回空内容，**不拿上一轮答案冒充本轮**。
      const finalContent = sawNewText ? lastText : '';
      console.log(
        `[web-engine][path] send-end completion=${completion} elapsedMs=${Date.now() - startedAt} ` +
          `contentLen=${finalContent.length} toolCalls=${toolCalls}${readNoData ? ' reason=read-no-data' : ''}`,
      );
      logRound(Date.now() - startedAt, completion, toolCalls, finalContent);
      return {
        content: finalContent,
        toolCalls,
        timedOut: timedOut || undefined,
        toolCallRecords: currentRecords ?? undefined,
        completion,
        ...(readNoData ? { reason: 'read-no-data' } : {}),
      };
    },
    /**
     * 不发消息，只等待下一条回复（页端 auto-continue 触发）。
     * v0.9：优先读 getAutoReply（页端通过 WebSocket 推送的回复，不渲染到 DOM）；
     * 降级为 DOM 轮询（兼容 auto-continue 未推送的情况）。
     */
    async waitForNextReply(): Promise<EngineSendResult> {
      const counterStart = options.toolCallCounter.current;
      const startedAt = Date.now();
      currentRecords = options.onToolCall ? [] : null;
      console.log(`[web-engine] waitForNextReply start, hasConsume=${!!options.consumeAutoReply}`);

      let timedOut = false;
      let stopped = false;

      // F1（复验 R5）：复用 send() 留下的本轮基线；没有（或已陈旧）才自己取一条。
      const reused = roundBaseline !== null && Date.now() - roundBaseline.at < BASELINE_TTL_MS;
      const baselineRead = reused ? null : await readConversation('', false);
      const baselineText = reused ? roundBaseline!.text : baselineRead!.text;
      const baselineMirrorText = reused ? roundBaseline!.mirrorText : baselineRead!.mirrorText;
      const baselineMirrorCount = reused ? roundBaseline!.mirrorCount : baselineRead!.mirrorCount;
      console.log(
        `[web-engine][path] wait-start baselineSource=${reused ? 'handoff-from-send' : 'fresh-read'} ` +
          `baseMirror=${baselineMirrorCount} baseMirrorLen=${baselineMirrorText.length} baseDomLen=${baselineText.length}`,
      );
      let prevSnapshot: string | null = null;
      let stableHits = 0;
      let lastText = '';
      let sawNewText = false;
      // PM 要求：两条路径的起止与选中依据要能判读。
      let bStarted = false;
      let lastSeen = { mirrorCount: baselineMirrorCount, mirrorText: baselineMirrorText, text: baselineText };
      // C1-F6：连续读不到数据计数（同 send()）。
      let emptyReads = 0;
      let readNoData = false;

      for (;;) {
        if (options.isStopped?.()) { stopped = true; break; }
        if (Date.now() - startedAt > stepTimeoutMs) {
          timedOut = true;
          break;
        }

        // 路径 A（页端 auto-continue 推送）：**不再独占预算**。
        // 旧实现先把它跑满整个 stepTimeoutMs（120s）才轮到 DOM 轮询，
        // 而普通轮 `onAssistantReply` 根本不会推送 → 永远不 fresh →
        // 答案明明已进了镜像/DOM，也被这段空转饿死（复验 R4：130s / 500）。
        // 现在它只是每轮 poll 里的一个「先看一眼」的快路径。
        if (options.consumeAutoReply) {
          const reply = options.consumeAutoReply();
          if (reply.fresh && reply.text.length > 0) {
            console.log(`[web-engine][path] A-hit len=${reply.text.length} atMs=${Date.now() - startedAt}`);
            const toolCalls = options.toolCallCounter.current - counterStart;
            return { content: reply.text, toolCalls, toolCallRecords: currentRecords ?? undefined, completion: 'complete' };
          }
        }

        if (!bStarted) {
          bStarted = true;
          console.log(`[web-engine][path] B-start (mirror/dom polling) atMs=${Date.now() - startedAt}`);
        }

        await sleep(pollIntervalMs);
        const snap = await readConversation('', !sawNewText);
        lastSeen = { mirrorCount: snap.mirrorCount, mirrorText: snap.mirrorText, text: snap.text };
        if (snap.state === 'hard') {
          const reconnected = await tryReconnect();
          if (!reconnected) {
            closeRoundForMetrics('disconnected');
            const tc = options.toolCallCounter.current - counterStart;
            logRound(Date.now() - startedAt, 'disconnected', tc, lastText);
            return {
              content: lastText,
              toolCalls: tc,
              toolCallRecords: currentRecords ?? undefined,
              completion: 'disconnected',
            };
          }
          continue;
        }
        if (snap.state === 'empty') {
          emptyReads += 1;
          if (emptyReads >= maxEmptyReads) {
            readNoData = true;
            console.log(
              `[web-engine] read-no-data after ${emptyReads} empty reads (wait path, elapsedMs=${Date.now() - startedAt})`,
            );
            break;
          }
          continue;
        }
        emptyReads = 0;

        // 答案候选：镜像优先（SSE 派生、不受虚拟列表影响），其次真实 DOM。
        // 判「是不是本轮」用**身份信号**（镜像助手消息条数增长）或文本变化，
        // 不依赖「文本 ≠ 基线」——模型 1–2s 就答完，基线取在发送之后会漏判。
        const mirrorNew =
          snap.mirrorCount > baselineMirrorCount ||
          (snap.mirrorText.length > 0 && snap.mirrorText !== baselineMirrorText);
        const domNew = snap.text.length > 0 && snap.text !== baselineText;
        const candidate = mirrorNew && snap.mirrorText.length > 0 ? snap.mirrorText : domNew ? snap.text : '';
        if (candidate.length > 0) {
          console.log(
            `[web-engine][path] B-pick source=${mirrorNew && snap.mirrorText.length > 0 ? 'mirror' : 'dom'} ` +
              `len=${candidate.length} mirrorCount=${snap.mirrorCount} baseMirror=${baselineMirrorCount} ` +
              `atMs=${Date.now() - startedAt}`,
          );
        }
        if (candidate.length === 0) {
          stableHits = 0;
          continue;
        }
        lastText = candidate;
        if (candidate !== prevSnapshot) {
          options.onDelta?.(candidate);
        }
        if (candidate === prevSnapshot) {
          stableHits += 1;
          if (stableHits >= 2) {
            sawNewText = true;
            break;
          }
        } else {
          stableHits = 0;
        }
        prevSnapshot = candidate;
      }

      const toolCalls = options.toolCallCounter.current - counterStart;
      // C1-F6：连续读不到数据 → 快速失败（同 send()）。
      const completion: 'complete' | 'truncated' | 'disconnected' | 'unknown' = readNoData
        ? 'disconnected'
        : decideCompletion({ timedOut, dispatchFailed: false, stopped });
      closeRoundForMetrics(completion);
      // F1 同 send()：没见到本轮新文本就不返回旧答案。
      const finalContent = sawNewText ? lastText : '';
      // 本轮结束时的状态留作下一轮基线（多轮续跑逐轮推进，不会越比越旧）。
      roundBaseline = { mirrorCount: lastSeen.mirrorCount, mirrorText: lastSeen.mirrorText, text: lastSeen.text, at: Date.now() };
      console.log(
        `[web-engine][path] wait-end completion=${completion} elapsedMs=${Date.now() - startedAt} contentLen=${finalContent.length}${readNoData ? ' reason=read-no-data' : ''}`,
      );
      logRound(Date.now() - startedAt, completion, toolCalls, finalContent);
      return {
        content: finalContent,
        toolCalls,
        timedOut: timedOut || undefined,
        toolCallRecords: currentRecords ?? undefined,
        completion,
        ...(readNoData ? { reason: 'read-no-data' } : {}),
      };
    },
  };
}
