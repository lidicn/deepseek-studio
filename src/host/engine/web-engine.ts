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

import type { ExecuteResult } from '../../capabilities/types';
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
  /** 页端 DOM 能力调用入口（desktop-host.invokeTool：完整授权链 + 同意闸门）。 */
  dispatch(tool: string, params: Record<string, unknown>): Promise<ExecuteResult>;
  /** 工具调用计数器（由 desktop-host 的 hub.onToolCall 累加）。 */
  toolCallCounter: { current: number };
  /** 完成检测轮询间隔（默认 1500ms）。 */
  pollIntervalMs?: number;
  /** 单步看门狗（默认 120_000ms）。 */
  stepTimeoutMs?: number;
  /** 中止钩子：AgentLoop.stop() 置位后，等待中的 send 尽快返回。 */
  isStopped?(): boolean;
  /** v0.9：读取页端 auto-continue 推送的模型回复（不渲染到 DOM）。 */
  getAutoReply?(): { text: string; loop: number; updatedAt: number; fresh: boolean };
  /** v0.9：消费（读取并清除 fresh 标志）页端 auto-continue 推送的回复。 */
  consumeAutoReply?(): { text: string; loop: number; updatedAt: number; fresh: boolean };
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

  // M2-2：本轮工具调用记录缓冲。仅当 options.onToolCall 存在时才创建（非 null）。
  // 每次 send / waitForNextReply 开始时重置，结束时随返回值带出。
  let currentRecords: ToolCallRecord[] | null = options.onToolCall ? [] : null;

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

  async function readLastMessage(): Promise<{ text: string; count: number } | null> {
    const r = await options.dispatch('chat-read', {});
    if (!r.ok) return null;
    const data = r.data as { count?: number; messages?: { text: string }[] } | undefined;
    const messages = data?.messages ?? [];
    const last = messages.at(-1);
    return { text: last?.text ?? '', count: data?.count ?? 0 };
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
      // M9：health 探测加 5 秒超时，避免页端无响应时挂死
      const r = await Promise.race([
        options.dispatch('chat-read', {}),
        new Promise<{ ok: false; error: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, error: 'health-timeout' }), 5000),
        ),
      ]);
      if (r.ok) return { ok: true };
      return { ok: false, reason: r.error ?? 'chat-read-failed' };
    },
    async send(text: string): Promise<EngineSendResult> {
      // 工具调用计数从本轮起点清零
      const counterStart = options.toolCallCounter.current;
      // M2-2：每轮重置缓冲（onToolCall 存在时新建空数组）
      currentRecords = options.onToolCall ? [] : null;

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

      const baseline = await readLastMessage();
      const baselineText = baseline?.text ?? '';
      const startedAt = Date.now();

      let prevSnapshot: string | null = null;
      let stableHits = 0;
      let lastText = '';
      let timedOut = false;
      let stopped = false;

      for (;;) {
        if (options.isStopped?.()) { stopped = true; break; }
        if (Date.now() - startedAt > stepTimeoutMs) {
          timedOut = true;
          break;
        }
        await sleep(pollIntervalMs);
        let snap = await readLastMessage();
        if (!snap) {
          // S4：dispatch 失败 → 尝试重连
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
          snap = await readLastMessage();
          if (!snap) continue; // 重连成功但首读仍失败，下一轮再试
        }
        lastText = snap.text;
        if (lastText !== baselineText && lastText.length > 0 && lastText !== prevSnapshot) {
          options.onDelta?.(lastText); // S7：delta 回调
        }
        if (lastText !== baselineText && lastText.length > 0 && lastText === prevSnapshot) {
          stableHits += 1;
          if (stableHits >= 2) break;
        } else {
          stableHits = 0;
        }
        prevSnapshot = lastText;
      }

      const toolCalls = options.toolCallCounter.current - counterStart;
      const completion = decideCompletion({ timedOut, dispatchFailed: false, stopped });
      closeRoundForMetrics(completion);
      logRound(Date.now() - startedAt, completion, toolCalls, lastText);
      return {
        content: lastText,
        toolCalls,
        timedOut: timedOut || undefined,
        toolCallRecords: currentRecords ?? undefined,
        completion,
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

      // 路径 A：consumeAutoReply
      if (options.consumeAutoReply) {
        while (Date.now() - startedAt < stepTimeoutMs) {
          if (options.isStopped?.()) { stopped = true; break; }
          const reply = options.consumeAutoReply();
          if (reply.fresh && reply.text.length > 0) {
            const toolCalls = options.toolCallCounter.current - counterStart;
            return { content: reply.text, toolCalls, toolCallRecords: currentRecords ?? undefined, completion: 'complete' };
          }
          await sleep(pollIntervalMs);
        }
        if (stopped) {
          return { content: '', toolCalls: 0, toolCallRecords: currentRecords ?? undefined, completion: 'unknown' };
        }
        timedOut = true;
      }

      // 路径 B：DOM 轮询
      const baseline = await readLastMessage();
      const baselineText = baseline?.text ?? '';
      let prevSnapshot: string | null = null;
      let stableHits = 0;
      let lastText = '';

      for (;;) {
        if (options.isStopped?.()) { stopped = true; break; }
        if (Date.now() - startedAt > stepTimeoutMs) {
          timedOut = true;
          break;
        }
        await sleep(pollIntervalMs);
        let snap = await readLastMessage();
        if (!snap) {
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
          snap = await readLastMessage();
          if (!snap) continue;
        }
        lastText = snap.text;
        if (lastText !== baselineText && lastText.length > 0 && lastText !== prevSnapshot) {
          options.onDelta?.(lastText); // S7：delta 回调
        }
        if (lastText !== baselineText && lastText.length > 0 && lastText === prevSnapshot) {
          stableHits += 1;
          if (stableHits >= 2) break;
        } else {
          stableHits = 0;
        }
        prevSnapshot = lastText;
      }

      const toolCalls = options.toolCallCounter.current - counterStart;
      const completion = decideCompletion({ timedOut, dispatchFailed: false, stopped });
      closeRoundForMetrics(completion);
      logRound(Date.now() - startedAt, completion, toolCalls, lastText);
      return {
        content: lastText,
        toolCalls,
        timedOut: timedOut || undefined,
        toolCallRecords: currentRecords ?? undefined,
        completion,
      };
    },
  };
}
