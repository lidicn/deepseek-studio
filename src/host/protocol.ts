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
  // v0.31 账号身份锁：宿主检测到同账号双窗口（hello 上报的 accountFingerprint 与
  // 已登记页重复）→ 令该页 fail-closed。页端应渲染阻塞覆盖层并停止一切工具调用。
  // 这是防封号铁律「1 槽位 : 1 账号 : 1 窗口」的执行手段——同账号多窗口必封。
  | { type: 'account-duplicate-block'; reason: string; duplicateOf?: string }
  // v0.24：botId 全程可选，缺省='main'（单窗口/旧注入脚本行为不变）。
  | { type: 'dispatch'; callId: string; tool: string; params: unknown; botId?: string }
  | { type: 'consent-required'; callId: string; tool: string; params: unknown; meta?: ConsentMeta; botId?: string }
  /** v0.6：宿主把工具执行结果回传给页端（按 callId 关联页端发来的 tool-call）。 */
  | {
      type: 'tool-call-result';
      callId: string;
      ok: boolean;
      data?: unknown;
      error?: string;
      // v1.2：Pi Agent 风格统一结果格式（全可选，缺省即回退旧格式）
      content?: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
      details?: Record<string, unknown>;
      isError?: boolean;
      terminate?: boolean;
    }
  /** v0.7：KV 读写结果回传。 */
  | { type: 'kv-result'; requestId: string; ok: boolean; value?: unknown; error?: string }
  /** v0.7：runtime envelope 响应。 */
  | { type: 'runtime-envelope-result'; requestId: string; response: unknown }
  /** v1.0：宿主推送当前记忆列表（页端用于注入 "Existing Memories" 到系统提示词）。 */
  | { type: 'memories-update'; memories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }> }
  /** 调试：让页端执行 JS。 */
  | { type: 'debug-eval'; requestId: string; code: string }
  /** 调试：让页端刷新。 */
  | { type: 'debug-reload' };

/** 注入页 → 宿主 */
export type PageToHostMessage =
  // v0.24：hello 上报注入脚本自报的 botId（window.__studioBotId ?? 'main'）。
  // v0.31：同时上报账号身份指纹（localStorage.userToken 的 SHA-256，不外泄原始 token）。
  // 宿主据此做同账号双窗口去重——两窗口登同一 DeepSeek 账号 → 同指纹 → 第二个 fail-closed。
  | { type: 'hello'; origin: string; sessionId: string; botId?: string; accountFingerprint?: string }
  | { type: 'result'; callId: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'consent-decision'; callId: string; decision: ConsentDecision }
  /** v0.5 5.4：页端自检发现宿主注入对象被篡改，上报宿主以便降级。 */
  | { type: 'integrity-alert'; reason: string; detail?: string }
  /** v0.6：页端 MAIN-world 拦截器解析出模型发起的工具调用，反向投递给宿主真实执行。
   *  v0.24：带 botId，让宿主路由到发起调用的那个 bot（executor/counter/白名单）。 */
  | { type: 'tool-call'; callId: string; invocationName: string; params: unknown; botId?: string }
  /** 调试：页端把拦截/诊断日志发到宿主 stdout。 */
  | { type: 'log'; text: string }
  /** v0.7：页端 storage shim 的 KV 读写请求（落盘 backend 在宿主侧）。 */
  | { type: 'kv-get'; requestId: string; key: string }
  | { type: 'kv-set'; requestId: string; key: string; value: unknown }
  | { type: 'kv-remove'; requestId: string; key: string }
  /** v0.7：页端 chrome.runtime.sendMessage 的 envelope（RuntimeBridge post 到宿主）。 */
  | { type: 'runtime-envelope'; envelope: { command: string; requestId: string; payload: unknown } }
  /** v0.9：页端 auto-continue（POW 直连 API）收到模型最终回复后，推送给宿主。 */
  | { type: 'assistant-reply'; text: string; loop: number }
  /** M9：页端 SSE 流式 delta 推送（逐 token）。 */
  | { type: 'stream-delta'; text: string }
  /** 调试：debug-eval 结果。 */
  | { type: 'debug-eval-result'; requestId: string; ok: boolean; result: string };

export type { ExecuteResult };
