/**
 * Harness 埋点（M0-2）：工具回合完成率 / 需 nudge 率。
 *
 * 定位：纯内存订阅器。不改 tool-event-bus，不改 agent-loop；
 *   - 从 tool-event-bus 统计「单次工具调用」的结局（成功 / 失败 / 跳过）；
 *   - 包装 agent-loop 的 onEvent，统计「工具回合」（一次 tool 事件 = 一个回合，
 *     与该事件带的 toolCalls 次数无关），并识别回合内是否发生过一次纠偏 nudge。
 *
 * 统计口径（D1 裁决点）：
 *   - toolCallsTotal = after-call + call-error + call-skip（已结束的单次调用数）；
 *       after-call 记 success，call-error 记 failure，call-skip 记 skip；
 *       before-call 只是「开始」，不计入结局分母。
 *   - toolRounds = loop 事件里 type==='tool' 的次数；一个 tool 事件即使 toolCalls=N
 *       也只算一个回合（多次工具调用聚合在同一步）。
 *   - nudgeRounds = 打开中的工具回合内，出现一次「纠偏」类 status 事件的回合数；
 *       同一回合连续多次纠偏（MAX_CORRECTION_ATTEMPTS=3）只计一次。
 *   - nudgeRate = toolRounds>0 ? nudgeRounds/toolRounds : 0；
 *   - noNudgeCompletionRate = 1 - nudgeRate（=「无需 nudge 完成率」，对齐 §1.3 ≥95% 阈值）。
 *
 * 可观测边界：当前 agent-loop 只在「未解析工具标签 → 格式纠偏」时发一条含「纠偏」
 * 字样的 status；waitForNextReply 的 path A 超时降级走 console.log、不经 onEvent，
 * 故本版本以「纠偏」status 作为 nudge 的唯一可观测信号。M2-3 TaskLoop 落地后，
 * nudge 发送点会显式经 onEvent，届时只需扩充 NUDGE_STATUS_RE。
 *
 * 纯模块：无 DOM / 无 IO / 无运行时依赖（仅 type-only import），可直接单测。
 */

import type { AgentLoopEvent } from './agent-loop-event';
import type { ToolEventBus, ToolEventPayload } from './tool-event-bus';

// ---------------------------------------------------------------- 类型

/** 一次工具回合的运行态（打开中时挂在指标上）。 */
interface OpenToolRound {
  /** 本回合是否已计过一次 nudge（防连续纠偏重复计数）。 */
  nudge: boolean;
}

export interface HarnessMetricsSnapshot {
  /** 已结束的单次工具调用总数（= success + failure + skip）。 */
  readonly toolCallsTotal: number;
  /** after-call：执行成功。 */
  readonly successCount: number;
  /** call-error：执行抛错。 */
  readonly failureCount: number;
  /** call-skip：钩子拦截 / 跳过。 */
  readonly skipCount: number;
  /** 工具回合数（type==='tool' 的 loop 事件次数）。 */
  readonly toolRounds: number;
  /** 其中需 nudge 的回合数。 */
  readonly nudgeRounds: number;
  /** nudge 率 = nudgeRounds / toolRounds（无回合为 0）。 */
  readonly nudgeRate: number;
  /** 无需 nudge 完成率 = 1 - nudgeRate（无回合为 1）。 */
  readonly noNudgeCompletionRate: number;
}

export interface HarnessMetrics {
  /**
   * 包装后的 onEvent：传给 createAgentLoop 替代原始回调。
   * 先记入指标，再转发给构造时传入的原始 loopOnEvent。
   */
  onEvent(event: AgentLoopEvent): void;
  /** 当前快照（纯数据，可 JSON.stringify）。 */
  snapshot(): HarnessMetricsSnapshot;
  /** nudge 率（nudgeRounds / toolRounds，无回合为 0）。 */
  nudgeRate(): number;
  /** 退订 bus、清空内部态。 */
  dispose(): void;
}

// ---------------------------------------------------------------- 常量

/**
 * 识别「纠偏 nudge」status 的子串。真值来自 agent-loop.ts：
 *   `检测到未解析的工具调用，发送格式纠偏（第 N 次）…`
 * 只认「纠偏」二字，避免匹配正常的「等待页端续跑」。
 */
const NUDGE_STATUS_MARKER = '纠偏';

function isNudgeStatus(text: string | undefined): boolean {
  return typeof text === 'string' && text.indexOf(NUDGE_STATUS_MARKER) >= 0;
}

// ---------------------------------------------------------------- 实现

export function createHarnessMetrics(
  bus: ToolEventBus,
  loopOnEvent?: (event: AgentLoopEvent) => void,
): HarnessMetrics {
  // 单次调用结局计数（来自 bus）
  let successCount = 0;
  let failureCount = 0;
  let skipCount = 0;

  // 回合计数（来自 loop 事件）
  let toolRounds = 0;
  let nudgeRounds = 0;
  let openRound: OpenToolRound | null = null;

  function closeOpenRound(): void {
    openRound = null;
  }

  // ---- bus 订阅：'*' 通配，按事件名分桶 ----
  function onBusEvent(p: ToolEventPayload): void {
    switch (p.event) {
      case 'after-call':
        successCount += 1;
        break;
      case 'call-error':
        failureCount += 1;
        break;
      case 'call-skip':
        skipCount += 1;
        break;
      case 'before-call':
        // 只是调用开始，不计结局分母
        break;
      default:
        // 穷尽检查：新增事件名时这里必须显式处理
        break;
    }
  }
  const offBus = bus.on('*', onBusEvent);

  // ---- loop 事件状态机 ----
  function onEvent(event: AgentLoopEvent): void {
    switch (event.type) {
      case 'tool': {
        // 上一回合续跑成新工具回合 → 上回合自然关闭（无 nudge 标记除非已标）
        closeOpenRound();
        openRound = { nudge: false };
        toolRounds += 1;
        break;
      }
      case 'status': {
        if (openRound !== null && !openRound.nudge && isNudgeStatus(event.text)) {
          openRound.nudge = true;
          nudgeRounds += 1;
        }
        break;
      }
      case 'assistant': {
        // 最终回答：回合收尾
        closeOpenRound();
        break;
      }
      case 'error': {
        closeOpenRound();
        break;
      }
      case 'done': {
        closeOpenRound();
        break;
      }
      case 'user': {
        // 新一轮用户消息：防御性关闭残留的打开回合（上一轮未正常 done）
        closeOpenRound();
        break;
      }
      default:
        break;
    }
    // 转发给原始面板回调
    loopOnEvent?.(event);
  }

  function nudgeRate(): number {
    return toolRounds > 0 ? nudgeRounds / toolRounds : 0;
  }

  function snapshot(): HarnessMetricsSnapshot {
    const toolCallsTotal = successCount + failureCount + skipCount;
    const rate = nudgeRate();
    return {
      toolCallsTotal,
      successCount,
      failureCount,
      skipCount,
      toolRounds,
      nudgeRounds,
      nudgeRate: rate,
      noNudgeCompletionRate: toolRounds > 0 ? 1 - rate : 1,
    };
  }

  function dispose(): void {
    offBus();
    closeOpenRound();
  }

  return { onEvent, snapshot, nudgeRate, dispose };
}
