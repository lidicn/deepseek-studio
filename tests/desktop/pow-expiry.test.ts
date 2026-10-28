import { describe, expect, it } from 'vitest';
import { buildPowChallengeHeaders, isPowChallengeExpired } from '../../src/inject/pow';

describe('PoW challenge 过期校验', () => {
  it('支持秒/毫秒 expire_at', () => {
    expect(isPowChallengeExpired({
      expire_at: 2_000_000_000,
      expire_after: 0,
      received_at: 1_999_999_000_000,
    }, 2_000_000_001_000)).toBe(true);
    expect(isPowChallengeExpired({
      expire_at: 2_000_000_000_000,
      expire_after: 0,
      received_at: 1_999_999_000_000,
    }, 1_999_999_999_999)).toBe(false);
  });

  it('expire_after 从 challenge 接收时间起算', () => {
    expect(isPowChallengeExpired({
      expire_at: 0,
      expire_after: 30,
      received_at: 1_000,
    }, 31_001)).toBe(true);
    expect(isPowChallengeExpired({
      expire_at: 0,
      expire_after: 30,
      received_at: 1_000,
    }, 20_000)).toBe(false);
  });

  it('PoW challenge 请求头只保留一个 content-type，避免服务端 422', () => {
    expect(buildPowChallengeHeaders({
      authorization: 'Bearer token',
      'content-type': 'application/json',
      'Content-Type': 'text/plain',
      'x-device-id': 'device-1',
    })).toEqual({
      authorization: 'Bearer token',
      'x-device-id': 'device-1',
      'Content-Type': 'application/json',
    });
  });
});
