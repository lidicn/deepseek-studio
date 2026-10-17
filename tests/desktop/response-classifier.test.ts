/**
 * R0-R2 / R0-R5：响应分类器单测（纯模块，无 DOM / 运行时依赖）。
 *
 * 验证：HTTP 状态分类、200 内嵌错误体、SSE 错误帧、指数退避、重放头白名单、错误遥测环。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyResponse,
  classifySseFrame,
  errorBackoffMs,
  filterReplayableHeaders,
  recordVerdict,
  getErrorTraces,
  clearErrorTraces,
} from '../../src/inject/response-classifier';

describe('classifyResponse — HTTP 状态分类（R0-R2）', () => {
  it('200 正常 → ok', () => {
    expect(classifyResponse(200, 'data: {"v":[]}').verdict).toBe('ok');
  });
  it('status=0 断连/网络错误 → retryable（原实现当空回复 nudge）', () => {
    const v = classifyResponse(0, null);
    expect(v.verdict).toBe('retryable');
    expect(v.reason).toBe('network-error');
  });
  it('429 限流 → retryable，解析 retryAfter', () => {
    const v = classifyResponse(429, JSON.stringify({ retryAfter: 3 }));
    expect(v.verdict).toBe('retryable');
    expect(v.reason).toBe('rate-limited');
    expect(v.retryAfterMs).toBe(3000);
  });
  it('5xx → retryable', () => {
    expect(classifyResponse(502, null).verdict).toBe('retryable');
    expect(classifyResponse(503, null).reason).toBe('server-503');
  });
  it('401/403/402 → fatal（鉴权/计费，立即停手不重试）', () => {
    expect(classifyResponse(401, null).verdict).toBe('fatal');
    expect(classifyResponse(403, null).verdict).toBe('fatal');
    expect(classifyResponse(402, null).verdict).toBe('fatal');
  });
  it('其他 4xx → fatal', () => {
    expect(classifyResponse(400, null).verdict).toBe('fatal');
  });
  it('200 内嵌 401 错误体 → fatal', () => {
    const v = classifyResponse(200, JSON.stringify({ code: 401, error: { message: 'unauthorized' } }));
    expect(v.verdict).toBe('fatal');
  });
  it('200 内嵌 status=0 错误体 → retryable', () => {
    const v = classifyResponse(200, JSON.stringify({ status: 0, error: { message: 'server error' } }));
    expect(v.verdict).toBe('retryable');
  });
});

describe('classifySseFrame — 流内错误帧（R0-R5）', () => {
  it('event=error → fatal', () => {
    const v = classifySseFrame('error', { message: 'boom' });
    expect(v?.verdict).toBe('fatal');
  });
  it('载荷 status=500 → retryable', () => {
    const v = classifySseFrame('message', { code: 500, error: { message: 'upstream' } });
    expect(v?.verdict).toBe('retryable');
  });
  it('正常帧 → null', () => {
    expect(classifySseFrame('message', { v: [{ type: 'RESPONSE', content: 'hi' }] })).toBeNull();
  });
});

describe('errorBackoffMs — 指数退避（R0-R2）', () => {
  it('0/1/2 次分别约 2s/4s/8s，封顶 8s', () => {
    expect(errorBackoffMs(0, 0)).toBe(2000);
    expect(errorBackoffMs(1, 0)).toBe(4000);
    expect(errorBackoffMs(2, 0)).toBe(8000);
    expect(errorBackoffMs(5, 0)).toBe(8000);
  });
});

describe('filterReplayableHeaders — 重放头白名单（R0-R3）', () => {
  it('保留中性协议头，剔除一次性令牌/Cookie/CSRF/POW', () => {
    const out = filterReplayableHeaders({
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      Authorization: 'Bearer session-credential',
      'x-hif-leim': 'one-time-token-a',
      'x-hif-dliq': 'one-time-token-b',
      Cookie: 'session=abc',
      'x-csrf-token': 'csrf',
      'x-ds-pow-response': 'pow',
      'X-Client-Build': '123',
    });
    expect(out['content-type'] ?? out['Content-Type']).toBeDefined();
    expect(out['user-agent'] ?? out['User-Agent']).toBeDefined();
    expect(out['authorization'] ?? out['Authorization']).toBeDefined();
    expect(out['x-client-build'] ?? out['X-Client-Build']).toBeDefined();
    expect(out['x-hif-leim']).toBeUndefined();
    expect(out['x-hif-dliq']).toBeUndefined();
    expect(out['Cookie']).toBeUndefined();
    expect(out['x-csrf-token']).toBeUndefined();
    expect(out['x-ds-pow-response']).toBeUndefined();
  });
});

describe('错误遥测环（R0-R5）', () => {
  beforeEach(() => clearErrorTraces());
  it('recordVerdict 可经 getErrorTraces 读出，环形封顶 50', () => {
    recordVerdict({ status: 429, verdict: 'retryable', reason: 'rate-limited', attempt: 0 });
    recordVerdict({ status: 401, verdict: 'fatal', reason: 'auth-billing-401', attempt: 0 });
    const traces = getErrorTraces();
    expect(traces).toHaveLength(2);
    expect(traces[0].reason).toBe('rate-limited');
    expect(traces[1].verdict).toBe('fatal');
  });
});
