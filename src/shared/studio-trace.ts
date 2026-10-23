/**
 * Studio 执行轨迹事件模型 + 纯文本报告（v2.0）
 *
 * 移植自 deepseek-pp `src/core/trace/report.ts`（零依赖、零 IO 的纯函数部分）。
 * 上游文件头注释写明了用途，这里原样保留意图：
 *   用户报「断流」时，把一轮（turn）内的事件流渲染成可直接阅读的纯文本，
 *   回答：prompt 多大、吐了哪些 SSE 帧、工具 XML 解析成什么、续轮为何没触发、
 *   在哪一轮截断。本模块只做「定义 + 格式化」，不采集事件、不触碰存储/网络。
 *
 * 与上游的差异（按 Studio 现状裁剪）：
 * - 上游 turnId 来自 harness 的 turn 概念；Studio 的 turn 就是「一次用户消息 → 到最终答复」，
 *   直接用 studio-execution 的 turnId，不另造一套 id。
 * - 上游有 `continuation.decision` 的 model_requested / user_continued 两源；
 *   Studio 的续跑触发源只有「工具结果已返回」与「流截断无工具」两种，用 reason 字符串表达，
 *   不引入上游的 ContinuationReason 联合类型（Studio 没有那个枚举）。
 * - 采集器（createStudioTraceCollector）是 Studio 侧新增：上游把采集留在调用方，
 *   这里收进一个可单测的有界缓冲区，避免每个调用点各自实现「封顶 + 去重」。
 */

// ---------------------------------------------------------------- 类型

/** 单轮内出现的因果事件类型。 */
export type StudioTraceEventType =
  | 'turn.start'
  | 'request.sent'
  | 'sse.frame'
  | 'tool.parsed'
  | 'tool.exec'
  | 'continuation.decision'
  | 'turn.end';

/** SSE 帧分类：文本 / 思考 / 工具。 */
export type StudioSseFrameKind = 'text' | 'think' | 'tool';

interface BaseTraceEvent {
  readonly turnId: string;
  /** 毫秒时间戳（monotonic 或 epoch 均可，仅用于同轮内相对时长）。 */
  readonly timestamp: number;
}

export interface StudioTurnStartEvent extends BaseTraceEvent {
  readonly t: 'turn.start';
}

export interface StudioRequestSentEvent extends BaseTraceEvent {
  readonly t: 'request.sent';
  /** 请求体字节数（UTF-8 字节，不是字符数）。 */
  readonly bytes: number;
  /** PoW 求解耗时（毫秒），无则省略。 */
  readonly powMs?: number;
}

export interface StudioSseFrameEvent extends BaseTraceEvent {
  readonly t: 'sse.frame';
  readonly kind: StudioSseFrameKind;
  /**
   * 本次新增的字符数（不是帧数）。
   * 上游同名字段语义是帧计数，但 Studio 的 SSE 提取器（SseTextStreamExtractor）只暴露
   * 累积文本，没有帧计数入口；逐帧计数要为每条 data: 事件记一次，成本高于收益。
   * 断流取证真正关心的是「这一轮吐了多少字」，字符数比帧数更直接，故改为字符并在此注明。
   */
  readonly count: number;
}

export interface StudioToolParsedEvent extends BaseTraceEvent {
  readonly t: 'tool.parsed';
  readonly name: string;
  /** 'ok' 表示参数 JSON 合法；'invalid-json' 表示被 tryFixEscapedQuotes 兜住或失败。 */
  readonly status: string;
}

export interface StudioToolExecEvent extends BaseTraceEvent {
  readonly t: 'tool.exec';
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs?: number;
}

export interface StudioContinuationDecisionEvent extends BaseTraceEvent {
  readonly t: 'continuation.decision';
  /**
   * 为什么这样判。Studio 侧已知取值：
   *   'tools-pending'     有待回填工具结果 → 续跑
   *   'tools-returned'    工具结果已到 → 续跑
   *   'stream-cut'        流截断且无工具 → 空转续轮（受 MAX_AUTO_CONTINUE 封顶）
  *   'no-tools'          本轮无工具 → 收尾
   *   'loop-depth-max'    达到 MAX_LOOP → 停止
   *   'error-budget-out'  错误重试预算耗尽 → 停止
   */
  readonly reason: string;
  readonly triggered: boolean;
}

export interface StudioTurnEndEvent extends BaseTraceEvent {
  readonly t: 'turn.end';
  /** true = 正常拿到最终答复；false = 被截断/中断。 */
  readonly finished: boolean;
  readonly stopReason: string;
}

export type StudioTraceEvent =
  | StudioTurnStartEvent
  | StudioRequestSentEvent
  | StudioSseFrameEvent
  | StudioToolParsedEvent
  | StudioToolExecEvent
  | StudioContinuationDecisionEvent
  | StudioTurnEndEvent;

/**
 * 分布式 Omit：直接 Omit<联合, K> 会把联合压成「公共键交集」，
 * 导致 record({t:'request.sent', bytes}) 这类调用报「bytes 不在类型中」。
 * 逐成员 Omit 再并回联合，保留各事件的专属字段。
 */
type WithoutTimestamp<T> = T extends unknown ? Omit<T, 'timestamp'> : never;

/** record 的入参：任一事件类型去掉 timestamp（由采集器补）。 */
export type StudioTraceEventInput = WithoutTimestamp<StudioTraceEvent>;

// ---------------------------------------------------------------- 采集器

/**
 * 有界轨迹采集器。环形缓冲：超过 maxEvents 丢弃最旧的，避免长会话内存无上限增长。
 * 纯内存，不落盘；需要落盘的调用方应自行接 studio-execution 的 kv 通道
 * （本模块刻意不依赖它，保持可在页端 iframe 与 Node 测试两端运行）。
 */
export interface StudioTraceCollector {
  /** 记录一个事件；时间戳缺省用 Date.now()。 */
  record(event: StudioTraceEventInput & { timestamp?: number }): void;
  /** 当前缓冲快照（副本，调用方修改不影响内部）。 */
  snapshot(): StudioTraceEvent[];
  /** 清空。 */
  clear(): void;
  /** 当前事件数。 */
  size(): number;
}

export function createStudioTraceCollector(maxEvents = 2000): StudioTraceCollector {
  const cap = Math.max(1, Math.floor(maxEvents));
  let buf: StudioTraceEvent[] = [];
  return {
    record(event) {
      const stamped = { ...event, timestamp: event.timestamp ?? Date.now() } as StudioTraceEvent;
      buf.push(stamped);
      if (buf.length > cap) buf = buf.slice(buf.length - cap);
    },
    snapshot() {
      return buf.slice();
    },
    clear() {
      buf = [];
    },
    size() {
      return buf.length;
    },
  };
}

// ---------------------------------------------------------------- 报告

/** 单轮聚合结果。 */
interface TurnGroup {
  turnId: string;
  events: StudioTraceEvent[];
  firstTs: number;
  lastTs: number;
  ended: boolean;
  finished: boolean;
  stopReason: string | null;
}

type TurnStatus = 'DONE' | 'TRUNCATED' | 'OPEN';

function formatDurationMs(durationMs: number): string {
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function groupTurns(events: readonly StudioTraceEvent[]): TurnGroup[] {
  const order: string[] = [];
  const byId = new Map<string, TurnGroup>();

  for (const event of events) {
    let group = byId.get(event.turnId);
    if (!group) {
      group = {
        turnId: event.turnId,
        events: [],
        firstTs: event.timestamp,
        lastTs: event.timestamp,
        ended: false,
        finished: false,
        stopReason: null,
      };
      byId.set(event.turnId, group);
      order.push(event.turnId);
    }
    group.events.push(event);
    if (event.timestamp < group.firstTs) group.firstTs = event.timestamp;
    if (event.timestamp > group.lastTs) group.lastTs = event.timestamp;
    if (event.t === 'turn.end') {
      group.ended = true;
      group.finished = event.finished;
      group.stopReason = event.stopReason;
    }
  }

  return order.map((id) => byId.get(id) as TurnGroup);
}

function statusOf(group: TurnGroup): TurnStatus {
  if (group.ended && group.finished) return 'DONE';
  if (group.ended && !group.finished) return 'TRUNCATED';
  return 'OPEN';
}

/** 聚合一轮内 sse.frame 的各类计数。 */
function aggregateSse(group: TurnGroup): Record<StudioSseFrameKind, number> {
  const totals: Record<StudioSseFrameKind, number> = { text: 0, think: 0, tool: 0 };
  for (const event of group.events) {
    if (event.t !== 'sse.frame') continue;
    totals[event.kind] += Math.max(0, Math.floor(event.count));
  }
  return totals;
}

function renderDetailLines(group: TurnGroup): string[] {
  const lines: string[] = [];
  const sse = aggregateSse(group);
  let sseRendered = false;

  for (const event of group.events) {
    switch (event.t) {
      case 'request.sent': {
        const pow = event.powMs !== undefined ? `  pow=${event.powMs}ms` : '';
        lines.push(`request.sent    ${formatBytes(event.bytes)}${pow}`);
        break;
      }
      case 'sse.frame': {
        // sse 计数聚合为一行，避免每条事件刷屏。单位是字符数，不是帧数。
        if (!sseRendered) {
          const parts = [`text×${sse.text}`, `think×${sse.think}`, `tool×${sse.tool}`].join(' ');
          lines.push(`sse(chars): ${parts}`);
          sseRendered = true;
        }
        break;
      }
      case 'tool.parsed':
        lines.push(`tool.parsed     ${event.name}  ${event.status}`);
        break;
      case 'tool.exec': {
        // 耗时缺失时省略，而不是显示假的 0.0s。
        const duration = event.durationMs === undefined ? '' : `  ${formatDurationMs(event.durationMs)}`;
        lines.push(`tool.exec       ${event.name}${duration}  ${event.ok ? 'ok' : 'FAIL'}`);
        break;
      }
      case 'continuation.decision':
        lines.push(`continuation.decision: ${event.reason} -> triggered=${String(event.triggered)}`);
        break;
      case 'turn.end':
        lines.push(`turn.end stopReason=${event.stopReason} finished=${String(event.finished)}`);
        break;
      default:
        break;
    }
  }
  return lines;
}

/**
 * 把事件流渲染为纯文本报告。空输入返回空字符串（不输出占位标题）。
 * 纯函数：不修改入参，不产生副作用。
 *
 * 输出示例：
 *   turn 1 (12.3s)  DONE
 *     ├─ request.sent    8.4KB  pow=812ms
 *     ├─ sse: text×342 think×0 tool×2
 *     ├─ tool.parsed     shell_exec  ok
 *     ├─ tool.exec       shell_exec  1.5s  ok
 *     ├─ continuation.decision: tools-pending -> triggered=true
 *     └─ turn.end stopReason=completed finished=true
 */
export function renderStudioTraceReport(events: readonly StudioTraceEvent[]): string {
  if (events.length === 0) return '';

  const groups = groupTurns(events);
  const out: string[] = [];

  groups.forEach((group, index) => {
    const status = statusOf(group);
    const duration = formatDurationMs(group.lastTs - group.firstTs);
    const suffix = status === 'TRUNCATED' ? '  <-- 断在这里' : '';
    out.push(`turn ${index + 1} (${duration})  ${status}${suffix}`);

    const detailLines = renderDetailLines(group);
    detailLines.forEach((line, i) => {
      const branch = i === detailLines.length - 1 ? '└─' : '├─';
      out.push(`  ${branch} ${line}`);
    });
  });

  return out.join('\n');
}
