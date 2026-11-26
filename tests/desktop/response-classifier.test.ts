/**
 * R0-R2 / R0-R5：响应分类器单测（纯模块，无 DOM / 运行时依赖）。
 *
 * 验证：HTTP 状态分类、200 内嵌错误体、SSE 错误帧、指数退避、重放头白名单、错误遥测环。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyResponse,
  classifySseFrame,
  composeAuthInvalidMessage,
  composeChallengeMessage,
  composeQuotaWallMessage,
  detectChallengeRequired,
  detectQuotaWall,
  errorBackoffMs,
  filterReplayableHeaders,
  parseAuthInvalidFromText,
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
  // R6 回归锁（2026-11-12 实跑现场）：DeepSeek 的瞬态上游故障以 event:hint 下发，
  // 没有 code/status/error/message 字段；旧实现当正常帧放行，空回复烧掉唯一一次
  // protocol repair 后硬失败，MAX_ERROR_RETRIES 退避链一次都用不上。
  it('event=hint generation_err → retryable（不得当正常帧）', () => {
    const v = classifySseFrame('hint', {
      type: 'error',
      content: '服务器暂时不可用',
      clear_response: false,
      finish_reason: 'generation_err',
    });
    expect(v?.verdict).toBe('retryable');
    expect(v?.reason).toBe('sse-hint-generation_err');
  });
  it('event=hint rate_limit_reached → retryable', () => {
    const v = classifySseFrame('hint', {
      type: 'error',
      content: '消息发送过于频繁，请稍后重试',
      clear_response: true,
      finish_reason: 'rate_limit_reached',
    });
    expect(v?.verdict).toBe('retryable');
    expect(v?.reason).toBe('sse-hint-rate_limit_reached');
  });
  it('event=hint 非 error 类型 → null（正常提示帧不受影响）', () => {
    expect(classifySseFrame('hint', { type: 'info', content: '提示' })).toBeNull();
  });
  it('event=hint 带 finish_reason 但无 type → retryable', () => {
    const v = classifySseFrame('hint', { content: '服务器暂时不可用', finish_reason: 'generation_err' });
    expect(v?.verdict).toBe('retryable');
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

describe('quota wall — ㊿-c① quota-exhausted（200 外壳套 data 层业务码）', () => {
  // 现场装版 sidecar 原文钉死的撞墙形态：外层 code:0（骗过只看 HTTP/外层 code 的分类器），
  // 真信号在 data 层 biz_code:29 ＋ quotas[0].is_exhausted ＋ reset_at ＋ 上游 alert。
  const wallBody = JSON.stringify({
    code: 0,
    msg: '',
    data: {
      biz_code: 29,
      biz_msg: 'user restricted',
      quotas: [{ is_exhausted: true, reset_at: 1795107600.0, msg: '服务器繁忙，使用额度已达上限，将于 2026 年 11 月 20 日 01:00 恢复' }],
      alert: {
        content: {
          title: '额度已用完',
          description: '你的 Coding Plan 额度已用完，将于 2026 年 11 月 20 日 01:00 恢复。',
          button_group: { buttons: [{ label: '我知道了' }] },
        },
      },
    },
  });

  it('200 ＋ 额度墙 body ⇒ quota-exhausted（非 ok/retryable），带元数据', () => {
    const v = classifyResponse(200, wallBody);
    expect(v.verdict).toBe('quota-exhausted');
    expect(v.reason).toBe('quota-exhausted');
    expect(v.quota?.bizCode).toBe(29);
    expect(v.quota?.resetAtSeconds).toBe(1795107600);
    expect(v.quota?.quotaMsg).toContain('恢复');
    expect(v.quota?.alertText).toContain('额度已用完');
  });

  it('真实 476 B 形态（quotas/alert 在 data.biz_data 层，装版日志原文）⇒ 三断言全中', () => {
    // ㊿-c① 返工（2026-11-20 PM 探针坐实）：现场真实响应里 quotas/alert 不在 data 层，
    // 在 data.biz_data 层；读取层不下探 ⇒ 文案退化（丢恢复时刻＋上游文案）。
    const realBody = JSON.stringify({
      code: 0,
      msg: '',
      data: {
        biz_code: 29,
        biz_msg: 'user restricted',
        biz_data: {
          generated_at: 1795105580.842,
          quotas: [
            {
              model_type: null,
              is_exhausted: true,
              reset_at: 1795107600.0,
              msg: '服务器繁忙，使用额度已达上限，将于 2026 年 11 月 20 日 01:00 恢复',
            },
          ],
          alert: {
            content: {
              title: '服务器繁忙，使用额度已达上限',
              description: '将于 2026 年 11 月 20 日 01:00 恢复',
              button_group: { buttons: [] },
            },
          },
        },
      },
    });
    const v = classifyResponse(200, realBody);
    // ① 判类
    expect(v.verdict).toBe('quota-exhausted');
    // ② 文案含恢复时刻（上游 msg 透传，非泛化句）
    expect(composeQuotaWallMessage(v.quota)).toContain('2026 年 11 月 20 日 01:00 恢复');
    // ③ reset_at 原值取到
    expect(v.quota?.resetAtSeconds).toBe(1795107600);
  });

  it('额度墙在顶层（无 data 层）⇒ 兜底仍能识别', () => {
    const top = JSON.stringify({ biz_code: 29, quotas: [{ is_exhausted: true, reset_at: 1795107600.0 }] });
    const v = classifyResponse(200, top);
    expect(v.verdict).toBe('quota-exhausted');
    expect(v.quota?.resetAtSeconds).toBe(1795107600);
  });

  it('is_exhausted:false / biz_code:0 ⇒ 非墙，落回既有分类（200⇒ok）', () => {
    expect(
      classifyResponse(200, JSON.stringify({ code: 0, data: { biz_code: 0, quotas: [{ is_exhausted: false }] } })).verdict,
    ).toBe('ok');
    expect(detectQuotaWall({ data: { biz_code: 5, quotas: [] } })).toBeNull();
  });

  it('正常 SSE 200 body 不误判为墙', () => {
    expect(classifyResponse(200, 'data: {"v":[]}\n\n').verdict).toBe('ok');
  });

  it('detectQuotaWall 纯函数：无墙输入 ⇒ null', () => {
    expect(detectQuotaWall(null)).toBeNull();
    expect(detectQuotaWall({ code: 0 })).toBeNull();
  });
});

describe('composeQuotaWallMessage — 额度墙文案三段回退（㊿-c①）', () => {
  it('① 上游文案已含恢复时刻 ⇒ 原样透传（不硬编码）', () => {
    const msg = composeQuotaWallMessage({
      quotaMsg: '服务器繁忙，使用额度已达上限，将于 2026 年 11 月 20 日 01:00 恢复',
      alertText: '额度已用完 将于 2026 年 11 月 20 日 01:00 恢复 我知道了',
      resetAtSeconds: 1795107600.0,
    });
    expect(msg).toContain('恢复');
    expect(msg).toContain('2026 年 11 月 20 日 01:00');
  });
  it('② 文案无恢复时刻但 reset_at 可得 ⇒ 本地时区明示', () => {
    const msg = composeQuotaWallMessage({ quotaMsg: '额度已用完', resetAtSeconds: 1795107600.0 });
    expect(msg).toContain('将于');
    expect(msg).toContain('恢复');
  });
  it('③ 有文案但无时刻、无 reset_at ⇒ 透传文案', () => {
    const msg = composeQuotaWallMessage({ alertText: '服务暂时不可用，请稍后再试' });
    expect(msg).toBe('服务暂时不可用，请稍后再试');
  });
  it('④ 全无 ⇒ 泛化文案', () => {
    expect(composeQuotaWallMessage(undefined)).toBe('使用额度已用完，请稍后再试。');
    expect(composeQuotaWallMessage({})).toBe('使用额度已用完，请稍后再试。');
  });
});

describe('challenge — ㊿-c-补⑩ 40303 CHALLENGE_REQUIRED（200 外壳套确定性人机验证）', () => {
  // 现场装版 sidecar 原文钉死的挑战形态：外层 code:40303 + msg:CHALLENGE_REQUIRED，
  // 真信号在 data 层 provider / challenge_id / extras.expected_mode。
  const challengeBody = JSON.stringify({
    code: 40303,
    msg: 'CHALLENGE_REQUIRED',
    data: {
      provider: 'shumei',
      challenge_id: 'bd11a494-0000-4000-8000-000000000000',
      extras: { expected_mode: 'spatial_select' },
    },
  });

  it('① 200 ＋ 40303 挑战体 ⇒ challenge-required（非 ok/retryable），data 层三字段读出', () => {
    const v = classifyResponse(200, challengeBody);
    expect(v.verdict).toBe('challenge-required');
    expect(v.reason).toBe('challenge-required');
    expect(v.challenge?.provider).toBe('shumei');
    expect(v.challenge?.challengeId).toBe('bd11a494-0000-4000-8000-000000000000');
    expect(v.challenge?.expectedMode).toBe('spatial_select');
  });

  it('② 既有额度墙体 ⇒ 仍 quota-exhausted（挑战判定不抢额度墙的优先级）', () => {
    const wall = JSON.stringify({
      code: 0,
      msg: '',
      data: { biz_code: 29, quotas: [{ is_exhausted: true, reset_at: 1795107600.0 }] },
    });
    expect(classifyResponse(200, wall).verdict).toBe('quota-exhausted');
  });

  it('③ 正常成功包（code:0 无错误）仍 ok；401/402/403/429/500 语义不变', () => {
    expect(classifyResponse(200, JSON.stringify({ code: 0 })).verdict).toBe('ok');
    expect(classifyResponse(200, JSON.stringify({ code: 0, data: {} })).verdict).toBe('ok');
    expect(classifyResponse(401, null).verdict).toBe('fatal');
    expect(classifyResponse(402, null).verdict).toBe('fatal');
    expect(classifyResponse(403, null).verdict).toBe('fatal');
    expect(classifyResponse(429, null).verdict).toBe('retryable');
    expect(classifyResponse(500, null).verdict).toBe('retryable');
  });

  it('detectChallengeRequired 纯函数：命中三条件任一（外层 code/msg/任一层 challenge_id）＋无命中⇒null', () => {
    // 仅外层 code:40303（无 data）⇒ 命中，读不到三字段 ⇒ 空对象。
    expect(detectChallengeRequired({ code: 40303 })).toEqual({});
    // msg:CHALLENGE_REQUIRED ⇒ 命中，data 层 provider 读出。
    expect(detectChallengeRequired({ code: 0, msg: 'CHALLENGE_REQUIRED', data: { provider: 'shumei' } })).toEqual({ provider: 'shumei' });
    // 仅任一层有 challenge_id ⇒ 命中。
    expect(detectChallengeRequired({ code: 0, data: { challenge_id: 'abc' } })).toEqual({ challengeId: 'abc' });
    // 无命中 ⇒ null。
    expect(detectChallengeRequired({ code: 0 })).toBeNull();
    expect(detectChallengeRequired({ code: 0, msg: 'OK' })).toBeNull();
    expect(detectChallengeRequired(null)).toBeNull();
  });

  it('composeChallengeMessage：expectedMode 在/缺 两形态＋不冒充服务器故障', () => {
    const withMode = composeChallengeMessage({ provider: 'shumei', expectedMode: 'spatial_select' });
    expect(withMode).toContain('人机验证');
    expect(withMode).toContain('spatial_select');
    expect(withMode).not.toContain('服务器暂时无法访问');
    const noMode = composeChallengeMessage({ provider: 'shumei' });
    expect(noMode).toContain('人机验证');
    expect(noMode).not.toContain('当前要求'); // expectedMode 缺省 ⇒ 省略括号段
    expect(composeChallengeMessage(undefined)).toContain('人机验证');
  });
});

describe('auth-invalid — ㊿-c-补⑪ 40003 鉴权失效（200 外壳 invalid token）', () => {
  // 现场装版 sidecar 原文钉死的失效形态：外层 code:40003 + msg:"Authorization Failed (invalid token)"。
  const authInvalidBody = JSON.stringify({
    code: 40003,
    msg: 'Authorization Failed (invalid token)',
    data: null,
  });

  it('200 ＋ 40003 失效体 ⇒ auth-invalid（非 ok/retryable/fatal），不可重试', () => {
    const v = classifyResponse(200, authInvalidBody);
    expect(v.verdict).toBe('auth-invalid');
    expect(v.reason).toBe('auth-invalid');
  });

  it('正常成功包（code:0）行为不变 ⇒ 仍 ok（不误判失效）', () => {
    expect(classifyResponse(200, JSON.stringify({ code: 0, data: {} })).verdict).toBe('ok');
    expect(classifyResponse(200, 'data: {"v":[]}').verdict).toBe('ok');
  });

  it('优先级：challenge（40303）先于 auth-invalid（40003）；额度墙先于两者', () => {
    // 40303 挑战体仍是 challenge-required（不被 40003 判定抢走）。
    const chal = JSON.stringify({ code: 40303, msg: 'CHALLENGE_REQUIRED', data: { provider: 'shumei' } });
    expect(classifyResponse(200, chal).verdict).toBe('challenge-required');
    // 额度墙先判（biz_code:29 时不落到 40003/40303）。
    const wall = JSON.stringify({ code: 0, data: { biz_code: 29, quotas: [{ is_exhausted: true }] } });
    expect(classifyResponse(200, wall).verdict).toBe('quota-exhausted');
  });

  it('parseAuthInvalidFromText 纯函数：命中两形态＋非失效⇒false', () => {
    expect(parseAuthInvalidFromText(authInvalidBody)).toBe(true);
    // msg 语义（code 非 40003 但 msg 含 invalid token）也命中。
    expect(parseAuthInvalidFromText(JSON.stringify({ code: 1, msg: 'Authorization Failed (invalid token)' }))).toBe(true);
    // 正常包 / 非 JSON ⇒ false。
    expect(parseAuthInvalidFromText(JSON.stringify({ code: 0, msg: 'ok' }))).toBe(false);
    expect(parseAuthInvalidFromText('data: {"v":[]}')).toBe(false);
    expect(parseAuthInvalidFromText(null)).toBe(false);
  });

  it('composeAuthInvalidMessage：明确需重新登录＋MFA 路径，不冒充服务器故障', () => {
    const msg = composeAuthInvalidMessage();
    expect(msg).toContain('重新登录');
    expect(msg).toContain('MFA');
    expect(msg).not.toContain('服务器暂时无法访问');
  });
});

