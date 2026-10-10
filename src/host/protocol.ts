/**
 * 宿主 ↔ 注入页 工具执行协议（v0.4）
 *
 * 单一 ws 通道（默认路径 /studio）承载两类交互：
 *   1. 工具派发：宿主 dispatch → 页执行 → 页回传 result（按 callId 关联）。
 *   2. 同意闸门：宿主 consent-required → 页渲染模态 → 页回传 consent-decision。
 *
 * 协议刻意保持最小、显式、可枚举；两端（host/page-runtime 与 desktop/host-client）
 * 共用本类型，保证消息结构同构。错误一律走 result.ok=false + error 码，
 * 不走 ws 层异常（ws 关闭/解析失败由各自重连与超时兜底）。
 */

import type { ExecuteResult } from '../capabilities/types';

export type ConsentDecision = 'allow-once' | 'deny' | 'allow-session';

/**
 * 同意请求的呈现元数据（v0.5）。
 * 全部为「已翻译好的展示字符串」而非枚举：注入页打包产物不应为了显示几个标签
 * 而整包引入 policy.ts（含全部风险正则），体积与攻击面都不划算。
 */
export interface ConsentMeta {
  /** 风险等级展示名（如「特权级」）。 */
  riskLabel?: string;
  /** 当前审批档位展示名（如「询问审批」）。 */
  modeLabel?: string;
  /** 命中的风险项中文标签（如「递归删除」「提权执行」）。 */
  riskFlagLabels?: readonly string[];
  /** 是否越出工作区（用于显示越界徽标）。 */
  outside?: boolean;
}

/** 宿主 → 注入页 */
export type HostToPageMessage =
  | { type: 'hello-ack'; sessionId: string }
  | { type: 'dispatch'; callId: string; tool: string; params: unknown }
  | { type: 'consent-required'; callId: string; tool: string; params: unknown; meta?: ConsentMeta }
  /** v0.6：宿主把工具执行结果回传给页端（按 callId 关联页端发来的 tool-call）。 */
  | { type: 'tool-call-result'; callId: string; ok: boolean; data?: unknown; error?: string }
  /** v0.7：KV 读写结果回传。 */
  | { type: 'kv-result'; requestId: string; ok: boolean; value?: unknown; error?: string }
  /** v0.7：runtime envelope 响应。 */
  | { type: 'runtime-envelope-result'; requestId: string; response: unknown };

/** 注入页 → 宿主 */
export type PageToHostMessage =
  | { type: 'hello'; origin: string; sessionId: string }
  | { type: 'result'; callId: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'consent-decision'; callId: string; decision: ConsentDecision }
  /** v0.5 5.4：页端自检发现宿主注入对象被篡改，上报宿主以便降级。 */
  | { type: 'integrity-alert'; reason: string; detail?: string }
  /** v0.6：页端 MAIN-world 拦截器解析出模型发起的工具调用，反向投递给宿主真实执行。 */
  | { type: 'tool-call'; callId: string; invocationName: string; params: unknown }
  /** 调试：页端把拦截/诊断日志发到宿主 stdout。 */
  | { type: 'log'; text: string }
  /** v0.7：页端 storage shim 的 KV 读写请求（落盘 backend 在宿主侧）。 */
  | { type: 'kv-get'; requestId: string; key: string }
  | { type: 'kv-set'; requestId: string; key: string; value: unknown }
  | { type: 'kv-remove'; requestId: string; key: string }
  /** v0.7：页端 chrome.runtime.sendMessage 的 envelope（RuntimeBridge post 到宿主）。 */
  | { type: 'runtime-envelope'; envelope: { command: string; requestId: string; payload: unknown } };

export type { ExecuteResult };
