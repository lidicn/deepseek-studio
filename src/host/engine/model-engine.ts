/**
 * 模型引擎抽象（M1）
 *
 * AgentLoop 只面向本接口，不关心底层是网页引擎还是官方 API：
 *   - WebEngine：驱动 chat.deepseek.com 页面当模型（免费，XML 工具标签协议）
 *   - ApiEngine：DeepSeek 官方 API（原生 function calling，M3 落地）
 *
 * 引擎差异（工具调用协议、重试策略）全部隔离在各自实现内；
 * send() 返回的 content 已经是「本轮回复的可见文本」，toolCalls 是本轮发生的工具调用次数。
 */

/** 一次引擎调用期间发生的工具调用记录（供面板展示与审计）。 */
export interface ToolCallRecord {
  readonly tool: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * S2：本轮完成状态自证。
 *
 * M1-C（新增 `interrupted`）：原先把「看门狗截断」与「流被截断（无完成哨兵）」混成一件事，
 * 于是「模型答到一半网络断了」和「宿主等超时主动砍」在下游是同一个终态，
 * 用户无法区分「回答没说完」和「等待太久被砍」。这里把两件事**拆成两个状态**：
 *   - `truncated`    — **宿主**侧超时主动砍（看门狗 `timedOut`）；
 *   - `interrupted` — **页面**侧流提前结束、没见到完成哨兵（模型自己没答完）。
 */
export type CompletionStatus = 'complete' | 'truncated' | 'interrupted' | 'disconnected' | 'unknown';

export interface EngineSendResult {
  /** 本轮模型回复的可见文本（工具标签已被拦截器摘除）。 */
  readonly content: string;
  /** 本轮发生（并已由宿主执行）的工具调用条数。 */
  readonly toolCalls: number;
  /** 看门狗超时被截断的回复（内容可能不完整，调用方决定是否提示用户）。 */
  readonly timedOut?: boolean;
  /**
   * 本轮工具调用的结构化记录（M2-2 additive）。
   * 仅当引擎在创建时传入了 onToolCall 回调时才会填充；
   * 老调用方继续读 toolCalls 数字即可，此字段对老代码完全透明。
   */
  readonly toolCallRecords?: readonly ToolCallRecord[];
  /**
   * C1-F6：本轮失败的结构化原因（additive）。例如 `read-no-data`：
   * 连续多次 `chat-read` 都拿不到数据 → 快速失败，不再烧满 120s 看门狗。
   */
  readonly reason?: string;
  /**
   * S2：本轮完成状态自证。老调用方不读此字段则完全无感知。
   *   complete     — 模型正常输出完毕（页面侧见到了完成哨兵）
   *   truncated    — **宿主**侧看门狗超时，主动砍掉本轮（`timedOut`）
   *   interrupted  — **页面**侧流提前结束、**没见到完成哨兵**（模型自己没答完）
   *   disconnected — 页端不可达 / dispatch 失败
   *   unknown      — 兜底（用户主动 stop 等）
   */
  readonly completion?: CompletionStatus;

  /**
   * M1-C：页面侧「本轮流是否见到完成哨兵」的自证结论。
   *
   * 语义三态：
   *   - `true`  — 页面侧确认本轮流收到了完成哨兵（`response/status=FINISHED` 或 `event: close`）；
   *   - `false` — 页面侧确认本轮流**结束但没有完成哨兵**（模型吐到一半断流）；
   *   - `undefined` — 页面侧**未提供**该结论（老页面/未接入该字段/该路径不产出）。
   *
   * `undefined` 绝不能当成 `false`：
   * `false` 是「明确知道被截断」，`undefined` 是「不知道」——
   * 混淆两者会让老页面（无此能力）一律被判成 `interrupted`，把正常回合全打成失败。
   * 判据：`false` **且**本轮有可见输出时才是 `interrupted`（见 `decideCompletion`）。
   */
  readonly sawFinishSentinel?: boolean;
}

export interface ModelEngine {
  readonly name: 'web' | 'api';
  /** 引擎可用性探测（网页引擎：页面已连接且能读到对话）。 */
  health(): Promise<{ ok: boolean; reason?: string }>;
  /**
   * 发送一条消息并等模型回复结束。
   * 实现负责：注入文本 → 触发发送 → 完成检测（稳定性启发式 + 看门狗）。
   */
  send(text: string): Promise<EngineSendResult>;
  /**
   * 不发消息，只轮询等待下一条回复（由页端 auto-continue 触发）。
   * v0.9：页端 POW auto-continue 是唯一续跑权威，宿主不再发 continueNudge。
   */
  waitForNextReply?(): Promise<EngineSendResult>;
}

/** ApiEngine 占位（M3）：只提供明确的「未实现」语义，避免误用。 */
export function createApiEngineStub(): ModelEngine {
  return {
    name: 'api',
    async health() {
      return { ok: false, reason: 'api-engine-not-implemented (M3)' };
    },
    async send(): Promise<EngineSendResult> {
      throw new Error('api-engine-not-implemented (M3)：请切换到网页引擎');
    },
  };
}
