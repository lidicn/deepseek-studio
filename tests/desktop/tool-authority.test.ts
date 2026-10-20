import { describe, it, expect } from 'vitest';
import { createPlatformDesktop } from '../../src/host/platform-desktop';

describe('tool authority (resident host)', () => {
  it('签发 → 校验通过 → 一次性消费 → 重放失败', async () => {
    const host = createPlatformDesktop({ secret: 's3cr3t' });
    const token = await host.requestToolExecution({
      documentId: 'doc1',
      sessionId: 'sess1',
      requestId: 'req1',
      scope: 'tool:fs:read',
    });
    const v1 = await host.verify(token);
    expect(v1.ok).toBe(true);
    expect(v1.grant?.requestId).toBe('req1');

    const c1 = await host.consume(token);
    expect(c1.ok).toBe(true);

    const c2 = await host.consume(token); // 一次性 reservation：第二次失败
    expect(c2.ok).toBe(false);
    expect(c2.reason).toBe('consumed');
  });

  it('已消费后 verifyGrant 返回 consumed 而非 not-found（区分不存在与已用过）', async () => {
    const host = createPlatformDesktop({ secret: 's3cr3t' });
    const token = await host.requestToolExecution({ documentId: 'd', sessionId: 's', requestId: 'req-consume', scope: 'x' });
    await host.consume(token);
    const v = await host.verify(token);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('consumed');
    expect(v.reason).not.toBe('not-found');
  });

  it('grant 绑定 document/session/requestId', async () => {
    const host = createPlatformDesktop({ secret: 's3cr3t' });
    const token = await host.requestToolExecution({ documentId: 'd', sessionId: 's', requestId: 'r', scope: 'x' });
    const v = await host.verify(token);
    expect(v.grant).toMatchObject({ documentId: 'd', sessionId: 's', requestId: 'r', scope: 'x' });
  });

  it('错误密钥签发的 token 校验失败', async () => {
    const a = createPlatformDesktop({ secret: 'right' });
    const b = createPlatformDesktop({ secret: 'wrong' });
    const token = await a.requestToolExecution({ documentId: 'd', sessionId: 's', requestId: 'r', scope: 'x' });
    const v = await b.verify(token);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('bad-signature');
  });

  it('过期 token 校验失败', async () => {
    const host = createPlatformDesktop({ secret: 's', grantTtlMs: -1 });
    const token = await host.requestToolExecution({ documentId: 'd', sessionId: 's', requestId: 'r', scope: 'x' });
    const v = await host.verify(token);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('expired');
  });

  it('host token 跨实例可验（共享密钥）', async () => {
    const a = createPlatformDesktop({ secret: 'shared' });
    const b = createPlatformDesktop({ secret: 'shared' });
    // 跨实例验证的是 host token 签名（grant 记录存于签发方宿主，验证须在同实例）
    const tok = await a.authority.hostToken.sign({ iat: Date.now(), exp: Date.now() + 10_000 });
    expect(await b.authority.hostToken.verify(tok)).not.toBeNull();
  });

  it('同实例签发+校验 grant 通过', async () => {
    const host = createPlatformDesktop({ secret: 'shared' });
    const token = await host.requestToolExecution({ documentId: 'd', sessionId: 's', requestId: 'r', scope: 'x' });
    expect((await host.verify(token)).ok).toBe(true);
  });
});
