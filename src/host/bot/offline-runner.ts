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
import { isDegradedReport, parseSubBotReport } from './report-protocol';

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
  /**
   * 该槽是否有可用窗口（宿主提供：hub.trustedPages 里有没有 botId===槽 的页）。
   *
   * 为什么必须预检：审计槽是独立的页面驱动 bot，工具走 chat-*（页端执行侧）。槽若没有
   * 绑定窗口，desktop-host 的 routeExecution 会落到 Node rehydrate 回退分支——该分支
   * 只跑 start/stop、根本不调 execute，却返回 ok:true。于是子 bot 拿着假成功一直轮询
   * chat-read，直到 timeoutMs 才失败，报出来的原因是"超时"，而真因是"这个槽没窗口"。
   * 预检把 120s 的误导性超时换成即时、准确的环境错误。
   */
  readonly hasWindowFor?: (botId: string) => boolean;
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
    state?.sessionAllowlist.addPermanent('chat-insert');
    state?.sessionAllowlist.addPermanent('chat-send');

    // 临时 listener：捕获该 botId 全量事件，逐条写 jsonl 转录 + 记末尾 assistant 文本。
    // 同时记末尾 error 文本——AgentLoop.send 吞引擎异常（agent-loop.ts:197 只 emit 不 rethrow），
    // 引擎挂掉时 send 正常 resolve 但永远没有 assistant 文本，只有这里能拿到原因。
    let lastAssistantText = '';
    let lastErrorText = '';
    const listener = (event: AgentLoopEvent): void => {
      if (event.botId !== botId) return;
      reportStore.appendTranscript(batchId, slotId, event);
      if (event.type === 'assistant' && event.text) {
        lastAssistantText = event.text;
      }
      if (event.type === 'error' && event.text) {
        lastErrorText = event.text;
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

      // 预检窗口可用性：槽没有绑定窗口时立刻失败，不要拖到 timeoutMs（原因也会被
      // 误报成"超时"而非"这个槽没窗口"）。见 hasWindowFor 的接口注释。
      // 放在 task-progress 之后，让 UI 仍能看到 running → complete(ok=false) 的完整生命周期。
      if (deps.hasWindowFor && !deps.hasWindowFor(botId)) {
        throw new Error(`槽 ${slotId} 无可用窗口（botId=${botId} 没有已连接的审计页），无法执行页面驱动工具`);
      }

      const sendP = slotRuntime.run(handle);
      const raced = await Promise.race([sendP, timeout]);

      if (raced === '__timeout__') {
        throw new Error(`offline-runner timeout (${timeoutMs}ms)`);
      }

      // 无 assistant 文本 = 子 bot 没有产出。send 正常 resolve 不代表成功：引擎异常被
      // AgentLoop 吞掉（agent-loop.ts:197），此时 raced 是 fulfilled 但全是 error 事件。
      // 必须显式判失败，否则"引擎挂了"和"审计出报告"都推 ok=true，决策门形同虚设。
      if (!lastAssistantText) {
        throw new Error(lastErrorText || 'offline-runner 未取得子 bot 回复（assistant 文本为空）');
      }

      // 解析末尾 assistant 文本 → 写 SubBotReport。
      // 降级（模型没按要求出 JSON）仍落盘报告（不丢内容），但 ok=false——"审计完成、
      // 无问题"不该是假象：模型跑完了不等于产出了可用的结构化审计结论。
      const report = parseSubBotReport(lastAssistantText, slotId, dimension, transcriptPath);
      reportStore.writeSubReport(batchId, slotId, report);

      const degraded = isDegradedReport(report);
      deps.onTaskComplete?.({
        kind: 'task-complete',
        roomId,
        batchId,
        slotId,
        dimension,
        ok: !degraded,
        findingCount: report.findings.length,
        ...(degraded ? { error: '模型未按要求输出结构化 JSON，已降级保留原始输出' } : {}),
        timestamp: now(),
      });

      return report;
    } catch (err) {
      // 失败：推 task-complete(ok=false) + 仍写一份降级报告（不丢执行记录）。
      // 降级报告带上失败原因（而非空串）——否则 summary 只会写"(空输出)"，汇总时
      // 看不出该维度是超时、引擎挂还是解析失败。
      const errMsg = err instanceof Error ? err.message : String(err);
      const fallback = parseSubBotReport(`[执行失败] ${errMsg}`, slotId, dimension, transcriptPath);
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
