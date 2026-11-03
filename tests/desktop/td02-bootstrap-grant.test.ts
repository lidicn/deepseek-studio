/**
 * 组 TD-02：bootstrap grant（页面连 WS 的短期一次性凭据）单测。
 *
 * 背景：原实现把 config.token 注入外部页面（window.__studioHostToken），
 * 页面拿到即等于拿到宿主全权凭据。改为注入 60s、一次性、仅 ws-connect、绑 audience 的 grant。
 *
 * 本测试覆盖设计稿 §5 六条负控：
 *  1. 注入脚本内容不含 config.token 原值（主负控，见 Rust 侧 td02_script_uses_grant_not_token + 此处）
 *  2. grant 一次性（同 jti 二次验 → consumed）
 *  3. grant 过期 → expired
 *  4. scope 限权（非 ws-connect → scope-mismatch）
 *  5. audience 绑定（aud 不匹配 → aud-mismatch）
 *  6. 缺 grant / 伪造签名 → malformed / bad-signature
 */
import { describe, it, expect } from 'vitest';
import {
  createHostTokenAuthority,
  issueBootstrapGrant,
  verifyBootstrapGrant,
  BOOTSTRAP_GRANT_SCOPE,
  type HostTokenAuthority,
} from '../../src/host/host-token';

const SECRET = 'unit-test-secret';

function auth(): HostTokenAuthority {
  return createHostTokenAuthority(SECRET);
}

describe('TD-02 bootstrap grant: 签发 + 验签（正常路径）', () => {
  it('合法 grant（aud 匹配、未过期、未用）→ ok', async () => {
    const a = auth();
    const g = await issueBootstrapGrant(a, { aud: 'main', ttlMs: 60_000 });
    const used = new Set<string>();
    const r = await verifyBootstrapGrant(a, g, used, 'main');
    expect(r.ok).toBe(true);
    expect(r.claims?.aud).toBe('main');
    expect(r.claims?.scope).toBe(BOOTSTRAP_GRANT_SCOPE);
    expect(used.size).toBe(1);
  });

  it('Rust 同算法交叉验证：手工构造 payload + signRaw → 验得过', async () => {
    // 模拟 tauri 侧 issue_bootstrap_grant_rs 的输出格式：payload.sig（都用 signRaw）
    const a = auth();
    const claims = {
      iss: 'deepseek-studio-host',
      jti: 'rjti123',
      aud: 'bot:alpha',
      scope: 'ws-connect',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const sig = await a.signRaw(payload);
    const grant = `${payload}.${sig}`;
    const used = new Set<string>();
    const r = await verifyBootstrapGrant(a, grant, used, 'bot:alpha');
    expect(r.ok).toBe(true);
    expect(r.claims?.jti).toBe('rjti123');
  });
});

describe('TD-02 负控', () => {
  it('一次性：同一 grant 第二次验 → consumed', async () => {
    const a = auth();
    const g = await issueBootstrapGrant(a, { aud: 'main', ttlMs: 60_000 });
    const used = new Set<string>();
    expect((await verifyBootstrapGrant(a, g, used, 'main')).ok).toBe(true);
    const second = await verifyBootstrapGrant(a, g, used, 'main');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('consumed');
  });

  it('过期 → expired（now 往后拨过 exp）', async () => {
    const a = auth();
    const g = await issueBootstrapGrant(a, { aud: 'main', ttlMs: 1000, now: () => 1_000_000 });
    const used = new Set<string>();
    const r = await verifyBootstrapGrant(a, g, used, 'main', () => 1_000_000 + 2000);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('expired');
  });

  it('scope 限权：非 ws-connect → scope-mismatch', async () => {
    const a = auth();
    const claims = {
      iss: 'deepseek-studio-host',
      jti: 'j-scope',
      aud: 'main',
      scope: 'tool-exec', // 非法 scope
      iat: Date.now(),
      exp: Date.now() + 60_000,
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const sig = await a.signRaw(payload);
    const r = await verifyBootstrapGrant(a, `${payload}.${sig}`, new Set(), 'main');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('scope-mismatch');
  });

  it('audience 绑定：bot A 的 grant 连 bot B → aud-mismatch', async () => {
    const a = auth();
    const g = await issueBootstrapGrant(a, { aud: 'bot:alpha', ttlMs: 60_000 });
    const r = await verifyBootstrapGrant(a, g, new Set(), 'bot:beta');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('aud-mismatch');
  });

  it('缺 grant → malformed', async () => {
    const a = auth();
    expect((await verifyBootstrapGrant(a, null, new Set(), 'main')).reason).toBe('malformed');
    expect((await verifyBootstrapGrant(a, '', new Set(), 'main')).reason).toBe('malformed');
  });

  it('伪造签名 → bad-signature（换了密钥签的 grant）', async () => {
    const a = auth();
    const attacker = createHostTokenAuthority('attacker-secret');
    const g = await issueBootstrapGrant(attacker, { aud: 'main', ttlMs: 60_000 });
    const r = await verifyBootstrapGrant(a, g, new Set(), 'main');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  it('篡改 payload（改 aud）→ bad-signature', async () => {
    const a = auth();
    const g = await issueBootstrapGrant(a, { aud: 'main', ttlMs: 60_000 });
    const dot = g.indexOf('.');
    const payload = g.slice(0, dot);
    const sig = g.slice(dot + 1);
    // 把 payload 解开改 aud 再拼回去（签名不再匹配）
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    json.aud = 'bot:evil';
    const tampered = Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
    const r = await verifyBootstrapGrant(a, `${tampered}.${sig}`, new Set(), 'bot:evil');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });
});
