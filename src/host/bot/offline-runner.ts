/**
 * 离线执行器（v0.30 · Claude 主开发）
 *
 * 把 Scheduler 分配的审计槽位（RunHandle）跑成一个离线子 bot 任务：注册临时
 * listener 捕获全量 AgentLoopEvent 写 jsonl 转录 → slotRuntime.run 发消息 →
 * 超时 race → 取末尾 assistant 文本 → parseSubBotReport → writeSubReport。
 *
 * 复用三处已验证模式：
 *   - generateReply 的 listener 捕获（chat-room-runtime.ts:155-234）
 *   - createModelSummarizer 的 Promise.race 超时（chat-room-runtime.ts:275-277）
 *   - strategy-generator 的 onAgentEvent 订阅 + sessionAllowlist 放行（:74-78）
 *
 * 关键设计：
 *   1. executor 构造时稳定（registry+slotRuntime+onAgentEvent+reportStore+timeoutMs），
 *      每次调度的 roomId/batchId/dimension/target 从 handle.task 读——这样一个
 *      Scheduler 的 runner 能服务多批次。
 *   2. SlotRuntime.run 不调 unloadPersona（slot-runtime.ts:237-273 确认），wrapper
 *      的 finally 必须补 unloadPersona——防人设泄漏到下次同槽复用。
 *   3. Scheduler.assign 注入 runner 后在 try/finally 自动 release（scheduler.ts:83-89），
 *      runner 内部 unloadPersona 先于 Scheduler.release——顺序安全。
 *   4. SubBotReport 由 runner 副作用写 reportStore，Scheduler 不返 runner 结果
 *      （scheduler.ts:49 注释"对齐在 G1-P4"正指此模式），dispatch 事后 readSubReports。
 *   5. 超时/异常：仍推 task-complete(ok=false) + unloadPersona + throw——
 *      dispatchAuditMeeting 的 Promise.allSettled 吞。
 *
 * 边界：不 import desktop-host / 不触碰 CB 文件 / 不改 agent-loop.ts（listener 是
 * onAgentEvent 总线消费者，不改发送方）。
 */

import type { AgentLoopEvent } from '../agent-loop';
import type { BotRegistryInternal } from './registry';
import type { SlotRuntime } from './slot-runtime';
import type { RunHandle } from './scheduler';
import type { ChatRoomTaskCompleteEvent, ChatRoomTaskProgressEvent, ReportStore } from './types';
import { parseSubBotReport } from './report-protocol';

/** 事件订阅器形状（接 desktop-host 的 agentListeners，同 strategy-generator）。 */
export type AgentEventBus = (cb: (event: AgentLoopEvent) => void) => () => void;

/** task-progress 推送口（dispatchAuditMeeting 注入，转 emitChatRoomEvent）。 */
export type TaskProgressSink = (event: ChatRoomTaskProgressEvent) => void;
/** task-complete 推送口。 */
export type TaskCompleteSink = (event: ChatRoomTaskCompleteEvent) => void;

/** 离线执行器：Scheduler 注入的 runner。 */
export type OfflineRunExecutor = (handle: RunHandle) => Promise<unknown>;

export interface OfflineRunExecutorDeps {
  readonly registry: BotRegistryInternal;
  readonly slotRuntime: SlotRuntime;
  readonly onAgentEvent: AgentEventBus;
  readonly reportStore: ReportStore;
  /** 单次审计超时毫秒；缺省 120s（审计比摘要长）。 */
  readonly timeoutMs?: number;
  /** 进度推送（可选，转 emitChatRoomEvent）。 */
  readonly onTaskProgress?: TaskProgressSink;
  /** 完成推送（可选，转 emitChatRoomEvent）。 */
  readonly onTaskComplete?: TaskCompleteSink;
}

/**
 * 建离线执行器。返回的函数签名 = Scheduler.TaskRunner，注入 Scheduler 构造参数的 runner。
 *
 * handle.task 需含字段：dimension, target, batchId, roomId, text（buildAuditTaskPrompt 产物）。
 * slotId===botId（audit slot identity，desktop-host 预创建时 botIdForSlot 用 identity）。
 */
export function createOfflineRunExecutor(deps: OfflineRunExecutorDeps): OfflineRunExecutor {
  const { registry, slotRuntime, onAgentEvent, reportStore } = deps;
  const timeoutMs = deps.timeoutMs ?? 120000;

  return async (handle: RunHandle): Promise<unknown> => {
    const { slotId, task } = handle;
    const botId = slotId; // audit slot identity：slotId===botId
    const dimension = String(task.dimension ?? 'audit');
    const batchId = String(task.batchId ?? '');
    const roomId = String(task.roomId ?? '');
    const transcriptPath = `runs/${batchId}/${slotId}.jsonl`;
    const now = () => Date.now();

    // 放行页面驱动工具（同 strategy-generator :74-78），让 loop.send 触发子 bot 回复。
    const state = registry.getState(botId);
    state?.sessionAllowlist.add('chat-insert');
    state?.sessionAllowlist.add('chat-send');

    // 临时 listener：捕获该 botId 全量事件，逐条写 jsonl 转录 + 记末尾 assistant 文本。
    let lastAssistantText = '';
    const listener = (event: AgentLoopEvent): void => {
      if (event.botId !== botId) return;
      reportStore.appendTranscript(batchId, slotId, event);
      if (event.type === 'assistant' && event.text) {
        lastAssistantText = event.text;
      }
    };
    const unsub = onAgentEvent(listener);

    // 超时 race（同 createModelSummarizer :275-277）。
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
    });

    try {
      deps.onTaskProgress?.({
        kind: 'task-progress',
        roomId,
        batchId,
        slotId,
        dimension,
        status: 'running',
        timestamp: now(),
      });

      const sendP = slotRuntime.run(handle);
      const raced = await Promise.race([sendP, timeout]);

      if (raced === '__timeout__') {
        throw new Error(`offline-runner timeout (${timeoutMs}ms)`);
      }

      // 成功：解析末尾 assistant 文本 → 写 SubBotReport → 推 task-complete(ok=true)。
      const report = parseSubBotReport(lastAssistantText, slotId, dimension, transcriptPath);
      reportStore.writeSubReport(batchId, slotId, report);

      deps.onTaskComplete?.({
        kind: 'task-complete',
        roomId,
        batchId,
        slotId,
        dimension,
        ok: true,
        findingCount: report.findings.length,
        timestamp: now(),
      });

      return report;
    } catch (err) {
      // 失败：推 task-complete(ok=false) + 仍写一份降级报告（不丢执行记录）。
      const errMsg = err instanceof Error ? err.message : String(err);
      const fallback = parseSubBotReport('', slotId, dimension, transcriptPath);
      reportStore.writeSubReport(batchId, slotId, fallback);

      deps.onTaskComplete?.({
        kind: 'task-complete',
        roomId,
        batchId,
        slotId,
        dimension,
        ok: false,
        findingCount: 0,
        error: errMsg,
        timestamp: now(),
      });
      throw err;
    } finally {
      unsub();
      if (timer) clearTimeout(timer);
      // SlotRuntime.run 不调 unload（:237-273），这里必须补——防人设泄漏到下次同槽复用。
      await slotRuntime.unloadPersona(botId);
    }
  };
}
