// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { describeErrorCode, UI_ERROR_CODES } from '../../src/shared/ui-error-codes';

describe('ui-error-codes 中文映射', () => {
  it('已知码返回中文说明', () => {
    expect(describeErrorCode('page-disconnected')).toContain('断开');
    expect(describeErrorCode('consent-denied')).toContain('拒绝');
    expect(describeErrorCode('not-found')).toContain('不存在');
    expect(describeErrorCode('cancelled')).toBe('已取消');
  });

  it('未知码显示原始 code + 通用说明，不抛错', () => {
    const out = describeErrorCode('some-unknown-code');
    expect(out).toContain('some-unknown-code');
    expect(out).toContain('未归类');
  });

  it('空/undefined code 返回通用说明', () => {
    expect(describeErrorCode(undefined)).toBe('发生未知错误');
    expect(describeErrorCode(null)).toBe('发生未知错误');
    expect(describeErrorCode('')).toBe('发生未知错误');
  });

  it('映射表覆盖审批/连接/文件三类关键码', () => {
    for (const code of ['consumed', 'not-found', 'page-disconnected', 'denied', 'failed', 'cancelled']) {
      expect(UI_ERROR_CODES[code]).toBeTruthy();
    }
  });
});
