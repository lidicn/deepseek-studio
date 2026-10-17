/**
 * R0-R2 / R0-R5：上游响应分类器（纯模块，无 DOM / 运行时依赖，便于单测）。
 *
 * 原 auto-continue/nudge 路径只识别 429，其余（status=0 网络错误、5xx、200 错误 JSON、
 * SSE error 帧）全部落入「空回复」分支，被当成「模型没说完」继续 nudge，叠加续跑预算形成
 * 33 连发。这里把响应显式分为 ok / retryable / fatal 三类：
 *   - ok        正常完成，走既有续跑/nudge 决策
 *   - retryable 可重试（429 限流、status=0 断连、5xx、SSE 错误载荷），消耗独立错误预算
 *   - fatal     不可重试（401/403 鉴权、402/欠费、400 参数错误），立即停手并上报
 *
 * 另含：错误重试指数退避、重放请求头白名单（R0-R3）、错误遥测环形缓冲（R0-R5）。
 */

export type ResponseVerdict = 'ok' | 'retryable' | 'fatal';

export interface ClassifiedResponse {
  verdict: ResponseVerdict;
  status: number;
  reason: string;
  /** 429 Retry-After 建议（毫秒），无则 undefined。 */
  retryAfterMs?: number;
}

/** 解析 200 响应体里的错误载荷（DeepSeek 偶发在 200 内回 status=0 / error.message）。 */
function parseBodyError(bodyText: string | null): { retryable: boolean; reason: string } | null {
  if (!bodyText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const code = typeof o.code === 'number' ? o.code : typeof o.status === 'number' ? o.status : undefined;
  const err = o.error;
  if (code === undefined && !err) return null;
  // 401/403/402 等鉴权/计费错误即使包在 200 里也是 fatal
  if (code === 401 || code === 403 || code === 402 || code === 429) {
    return { retryable: code === 429, reason: `body-error-${code}` };
  }
  // 其余 body 错误（含 status=0）按可重试处理
  return { retryable: true, reason: `body-error-${code ?? 'unknown'}` };
}

/**
 * 按 HTTP 状态码 + 响应体分类上游响应。
 * @param status  xhr.status（0 = 断连/网络错误/代理失败）
 * @param bodyText 响应文本（可为 null）
 */
export function classifyResponse(status: number, bodyText: string | null): ClassifiedResponse {
  if (status === 0) return { verdict: 'retryable', status, reason: 'network-error' };
  if (status === 429) {
    return { verdict: 'retryable', status, reason: 'rate-limited', retryAfterMs: parseRetryAfterMs(bodyText) };
  }
  if (status >= 500 && status < 600) return { verdict: 'retryable', status, reason: `server-${status}` };
  if (status === 401 || status === 403 || status === 402) return { verdict: 'fatal', status, reason: `auth-billing-${status}` };
  if (status >= 400) return { verdict: 'fatal', status, reason: `client-${status}` };
  if (status >= 200 && status < 300) {
    const bodyErr = parseBodyError(bodyText);
    if (bodyErr) {
      return bodyErr.retryable
        ? { verdict: 'retryable', status, reason: bodyErr.reason }
        : { verdict: 'fatal', status, reason: bodyErr.reason };
    }
    return { verdict: 'ok', status, reason: 'success' };
  }
  // 其他状态（3xx 等）保守按 retryable
  return { verdict: 'retryable', status, reason: `unclassified-${status}` };
}

function parseRetryAfterMs(bodyText: string | null): number | undefined {
  if (!bodyText) return undefined;
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    const ra = obj.retryAfter ?? obj.retry_after;
    if (typeof ra === 'number' && ra > 0) return ra * 1000;
  } catch {
    // 非 JSON 忽略
  }
  return undefined;
}

/**
 * R0-R5：SSE 错误帧分类。event=error 或载荷带 status=0/error 即视为异常帧；
 * 正常帧返回 null。供 XHR/fetch hook 在流过程中识别「服务端在流里报错」。
 */
export function classifySseFrame(eventType: string | null, parsed: unknown): ClassifiedResponse | null {
  if (eventType && eventType.toLowerCase() === 'error') {
    return { verdict: 'fatal', status: 200, reason: 'sse-error-frame' };
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const code = typeof o.code === 'number' ? o.code : typeof o.status === 'number' ? o.status : undefined;
  if ((code === 0 || code === 429 || code === 500) && (o.error || o.message)) {
    return { verdict: code === 429 || code === 500 ? 'retryable' : 'fatal', status: 200, reason: `sse-error-payload-${code}` };
  }
  return null;
}

/**
 * R0-R2：错误重试指数退避（2s → 4s → 8s，封顶 8s + 抖动），取代固定 1.2s 连发。
 * @param attempt 本次是第几次错误重试（从 0 起）
 */
export function errorBackoffMs(attempt: number, jitterMs = 300): number {
  const base = Math.min(2000 * 2 ** Math.max(0, Math.min(attempt, 2)), 8000);
  return base + Math.round(Math.random() * jitterMs);
}

/**
 * R0-R3：重放请求头白名单。auto-continue 复用首次请求头时，只转发协议必需的中性头；
 * 一次性会话令牌（x-hif-leim/x-hif-dliq 等）、Cookie、CSRF 一律剔除，避免复用过期/一次性凭证。
 */
const REPLAYABLE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'user-agent',
  'authorization',
  'lang',
  'x-client-build',
  'x-client-platform',
  'x-client-version',
]);

export function filterReplayableHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REPLAYABLE_HEADER_ALLOWLIST.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 错误遥测（R0-R5）

export interface ErrorTrace {
  at: number;
  status: number;
  verdict: ResponseVerdict;
  reason: string;
  attempt: number;
}

const TELEMETRY_CAP = 50;
const ring: ErrorTrace[] = [];

export function recordVerdict(trace: Omit<ErrorTrace, 'at'>): void {
  ring.push({ at: Date.now(), ...trace });
  if (ring.length > TELEMETRY_CAP) ring.shift();
}

export function getErrorTraces(): readonly ErrorTrace[] {
  return [...ring];
}

export function clearErrorTraces(): void {
  ring.length = 0;
}
