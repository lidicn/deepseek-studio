// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decideAgentAccess,
  agentAccessDeniedBody,
  clientHostOf,
  generatePairingCode,
} from '../../src/api/agent-lan-access';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.DEEPSEEK_STUDIO_LAN;
  delete process.env.DEEPSEEK_STUDIO_PAIR_CODE;
});

describe('clientHostOf · IPv4-mapped IPv6 归一', () => {
  it('::ffff:127.0.0.1 → 127.0.0.1', () => {
    expect(clientHostOf('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  it('::ffff:192.168.1.5 → 192.168.1.5', () => {
    expect(clientHostOf('::ffff:192.168.1.5')).toBe('192.168.1.5');
  });

  it('裸 IPv4 原样返回', () => {
    expect(clientHostOf('192.168.1.5')).toBe('192.168.1.5');
    expect(clientHostOf('127.0.0.1')).toBe('127.0.0.1');
  });

  it('IPv6 loopback 原样返回', () => {
    expect(clientHostOf('::1')).toBe('::1');
  });

  it('undefined → 空串（不得抛错）', () => {
    expect(clientHostOf(undefined)).toBe('');
  });
});

describe('decideAgentAccess · loopback 永远放行', () => {
  const opts = { lanEnabled: false, pairingCode: '' };

  it('127.0.0.1 在 LAN 关闭时也放行', () => {
    const d = decideAgentAccess(opts, '127.0.0.1', undefined);
    expect(d.allowed).toBe(true);
    expect(d.allowed && d.reason).toBe('loopback');
  });

  it('localhost 在 LAN 关闭时也放行', () => {
    const d = decideAgentAccess(opts, 'localhost', undefined);
    expect(d.allowed).toBe(true);
  });

  it('::1 在 LAN 开启时也放行', () => {
    const d = decideAgentAccess({ lanEnabled: true, pairingCode: 'ABC123' }, '::1', undefined);
    expect(d.allowed).toBe(true);
  });
});

describe('decideAgentAccess · LAN 关闭时拒绝非回环', () => {
  it('192.168.1.5 → lan-disabled', () => {
    const d = decideAgentAccess({ lanEnabled: false, pairingCode: '' }, '192.168.1.5', undefined);
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reason).toBe('lan-disabled');
  });

  it('即使带了正确配对码，LAN 未开启也拒绝（不能绕过开关）', () => {
    const d = decideAgentAccess({ lanEnabled: false, pairingCode: 'ABC123' }, '192.168.1.5', 'ABC123');
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reason).toBe('lan-disabled');
  });

  it('403 响应体不含配对码明文', () => {
    const d = decideAgentAccess({ lanEnabled: false, pairingCode: 'SECRET' }, '10.0.0.2', undefined);
    if (d.allowed) throw new Error('should deny');
    const body = JSON.stringify(agentAccessDeniedBody(d));
    expect(body).not.toContain('SECRET');
    expect(body).toContain('lan_access_disabled');
  });
});

describe('decideAgentAccess · LAN 开启时配对码校验', () => {
  const opts = { lanEnabled: true, pairingCode: 'PAIR1234' };

  it('正确配对码 → 放行', () => {
    const d = decideAgentAccess(opts, '192.168.1.5', 'PAIR1234');
    expect(d.allowed).toBe(true);
    expect(d.allowed && d.reason).toBe('paired');
  });

  it('缺少配对码 → missing-code', () => {
    const d = decideAgentAccess(opts, '192.168.1.5', undefined);
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reason).toBe('missing-code');
  });

  it('空串配对码等同缺少', () => {
    const d = decideAgentAccess(opts, '192.168.1.5', '');
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reason).toBe('missing-code');
  });

  it('错误配对码 → bad-code', () => {
    const d = decideAgentAccess(opts, '192.168.1.5', 'WRONG!!');
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reason).toBe('bad-code');
  });

  it('大小写敏感：不完全相等即拒绝', () => {
    const d = decideAgentAccess(opts, '192.168.1.5', 'pair1234');
    expect(d.allowed).toBe(false);
  });

  it('开了 LAN 但配对码为空串 → fail-closed 拒绝一切非回环', () => {
    const d = decideAgentAccess({ lanEnabled: true, pairingCode: '' }, '192.168.1.5', undefined);
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.reason).toBe('missing-code');
  });

  it('bad-code 响应体不泄露正确配对码', () => {
    const d = decideAgentAccess(opts, '192.168.1.5', 'WRONG');
    if (d.allowed) throw new Error('should deny');
    expect(JSON.stringify(agentAccessDeniedBody(d))).not.toContain('PAIR1234');
  });
});

describe('generatePairingCode · 可用性', () => {
  it('生成长度 8', () => {
    expect(generatePairingCode()).toHaveLength(8);
  });

  it('不含易混淆字符 0/O/1/I', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePairingCode()).not.toMatch(/[01OI]/);
    }
  });

  it('两次生成不同（非固定值）', () => {
    const a = generatePairingCode();
    const b = generatePairingCode();
    expect(a).not.toBe(b);
  });
});
