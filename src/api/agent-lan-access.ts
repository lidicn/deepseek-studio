/**
 * /agent 面板的局域网访问闸门（P2）
 *
 * 背景：`/agent` 路由原本免鉴权，真实 API 令牌直接内嵌在 HTML 里
 * （server.ts 把 `__STUDIO_API_TOKEN__` 占位符替换成 config.json 的 token）。
 * 只要服务绑在 127.0.0.1，威胁模型与"本地进程本就能读 config.json"等价。
 * 一旦为手机访问绑到 0.0.0.0，同局域网任何人都能拿到完整令牌并控制 agent。
 *
 * 因此局域网模式必须显式开启，且访问要带配对码：
 *   - 未开启局域网模式：只放行 loopback（localhost / 127.0.0.1 / ::1），行为与原来一致。
 *   - 开启后：非 loopback 请求必须在 URL 上带正确的配对码，否则 403。
 *     403 时**不返回**任何内嵌令牌的 HTML，只回 JSON 错误。
 *
 * 这是最小安全面：不做账号体系、不做令牌轮换、不做 HTTPS。
 */

/** loopback 主机名集合（与 server.ts 的 LOCAL_HOSTS 同源，但这里只判回路）。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

export interface AgentLanAccessOptions {
  /** 是否开启局域网访问；默认 false（只放行 loopback）。 */
  lanEnabled: boolean;
  /** 配对码；lanEnabled=true 时必填，空串视为未配置（一律拒绝非 loopback）。 */
  pairingCode: string;
}

export type AgentAccessDecision =
  | { allowed: true; reason: 'loopback' | 'paired' }
  | { allowed: false; reason: 'lan-disabled' | 'missing-code' | 'bad-code' };

/** 取客户端地址的主机部分；IPv4-mapped IPv6（::ffff:127.0.0.1）归一为 127.0.0.1。 */
export function clientHostOf(remoteAddress: string | undefined): string {
  if (!remoteAddress) return '';
  let host = remoteAddress;
  // Node 的 req.socket.remoteAddress 可能是 '::ffff:192.168.1.5'。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (mapped) return mapped[1];
  // 带端口形式（少见）剥离端口。
  const idx = host.lastIndexOf(':');
  if (idx > 0 && host.indexOf(':') === idx && !host.startsWith('[')) host = host.slice(0, idx);
  return host;
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 判定一次 /agent 请求能否拿到内嵌令牌的页面。
 *
 * @param clientHost 客户端主机（已归一）
 * @param providedCode URL 上带的配对码（?pair=xxx）
 */
export function decideAgentAccess(
  options: AgentLanAccessOptions,
  clientHost: string,
  providedCode: string | undefined,
): AgentAccessDecision {
  // loopback 永远放行：这是桌面端自己的用法，与开启局域网无关。
  if (isLoopback(clientHost)) return { allowed: true, reason: 'loopback' };

  if (!options.lanEnabled) return { allowed: false, reason: 'lan-disabled' };

  const expected = options.pairingCode;
  // 未配置配对码却开了局域网：fail-closed，一律拒绝（不允许"裸奔"）。
  if (!expected) return { allowed: false, reason: 'missing-code' };

  if (!providedCode) return { allowed: false, reason: 'missing-code' };
  if (providedCode !== expected) return { allowed: false, reason: 'bad-code' };

  return { allowed: true, reason: 'paired' };
}

/** 403 响应体：不泄露配对码本身，也不返回任何令牌相关内容。 */
export function agentAccessDeniedBody(decision: Extract<AgentAccessDecision, { allowed: false }>): {
  error: { code: string; message: string };
} {
  switch (decision.reason) {
    case 'lan-disabled':
      return {
        error: {
          code: 'lan_access_disabled',
          message: '局域网访问未开启：请在启动环境设置 DEEPSEEK_STUDIO_LAN=1 并配置配对码。',
        },
      };
    case 'missing-code':
      return {
        error: {
          code: 'pairing_code_required',
          message: '缺少配对码：请在 URL 上带 ?pair=<配对码>。配对码见启动日志。',
        },
      };
    case 'bad-code':
      return {
        error: {
          code: 'pairing_code_mismatch',
          message: '配对码不正确。',
        },
      };
  }
}

/** 生成一次性配对码（默认开启局域网时由启动流程调用）。 */
export function generatePairingCode(): string {
  // 8 位 base32 风格，避免易混淆字符（0/O/1/I），便于手机上手输。
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  // crypto 在 node 与 jsdom 下都可用；失败时退化到 Math.random（仅测试路径）。
  try {
    const webcrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (webcrypto?.getRandomValues) webcrypto.getRandomValues(bytes);
    else throw new Error('no crypto');
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
