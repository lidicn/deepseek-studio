// @vitest-environment node
/**
 * C1 P1 安全批 · F11：mcp.list 不得把连接串里的凭据送进模型上下文。
 *
 * ── 缺陷（设计稿 F11，PM 核实成立）──
 *
 * `mcp.list` **在模型表里**（`tool-contract.ts` 的 `mcp_list` → `mcp.list`），
 * 且 `approvalClass:'none'`（**零审批**）→ 模型调一次就把每台 MCP 服务器的
 * `url` / `command` / `args` **原样送进模型上下文**（模型是外部服务方 → 凭据外泄）。
 *
 * 而凭据就藏在这两个字段里：
 *   - `url`：`https://user:pass@host` 的 userinfo、
 *     `?token=` / `?key=` / `?api_key=` 类查询参数；
 *   - `args`：`--token {{PASSWORD_6okzywci}}` / `--api-key={{PASSWORD_vxi4nzav}}` 形态的值。
 *
 * R2-02 只堵了 `mcp.get` 那条路（`env` / `headers` 掩码）。**F11 是另一个出口。**
 *
 * ── PM 裁定的口径 ──
 *
 * 1. 掩码**对所有入口生效**（不只模型面）——UI 与模型共用同一条 `/studio` 通道，
 *    宿主按 invocationName 路由、没有「谁发的」这一维度 → 按入口区分不了。
 * 2. `url` 的 userinfo 密码 + 凭据形态查询参数**的值**一律掩码，**参数名保留**。
 * 3. `args` 里凭据形态**参数的值**一律掩码，**参数名本身保留**。
 * 4. 保留 `id` / `transport` / `toolCount` / 服务器名 / `command`。
 * 5. 负控：模型面调 `mcp.list` 后，返回值里**不得出现任何凭据形态子串**。
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  MCP_SECRET_MASK,
  maskMcpServerUrl,
  maskMcpServerArgs,
  toMcpServerSummary,
  type McpServerConfig,
} from '../../src/host/mcp-controller';

const tmpDirs: string[] = [];

function mkConfigDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d as string, { recursive: true, force: true });
  }
});

/** 凭据明文。断言「不得出现在返回值里」时逐个查。 */
const CREDS = [
  'sk-userinfo-password',
  'sk-query-token',
  'sk-arg-token',
  'sk-arg-api-key',
  'sk-inline-token',
] as const;

describe('F11 · url 掩码：userinfo 密码 + 凭据形态查询参数', () => {
  it('userinfo 里的密码被掩码，用户名保留', () => {
    const masked = maskMcpServerUrl('https://alice:sk-userinfo-password@example.com/mcp');
    expect(masked).toBeDefined();
    expect(masked).not.toContain('sk-userinfo-password');
    expect(masked).toContain('alice');
    expect(masked).toContain(MCP_SECRET_MASK);
  });

  it('凭据形态查询参数的值被掩码，参数名保留', () => {
    const masked = maskMcpServerUrl('https://example.com/mcp?token=sk-query-token&region=cn');
    expect(masked).not.toContain('sk-query-token');
    expect(masked).toContain('token=');
    expect(masked).toContain(MCP_SECRET_MASK);
    // 非凭据参数不误伤
    expect(masked).toContain('region=cn');
  });

  it('api_key / access_token / secret 等同族参数名都被覆盖', () => {
    for (const key of ['api_key', 'apiKey', 'access_token', 'secret', 'password', 'auth']) {
      const masked = maskMcpServerUrl(`https://example.com/mcp?${key}=sk-query-token`);
      expect(masked, `查询参数 ${key} 未被掩码`).not.toContain('sk-query-token');
    }
  });

  it('非凭据查询参数不误伤', () => {
    const masked = maskMcpServerUrl('https://example.com/mcp?region=cn&version=2');
    expect(masked).toContain('region=cn');
    expect(masked).toContain('version=2');
    expect(masked).not.toContain(MCP_SECRET_MASK);
  });

  it('没有凭据时 URL 原样返回（不做无谓改写）', () => {
    const url = 'https://example.com/mcp?region=cn';
    expect(maskMcpServerUrl(url)).toBe(url);
  });

  it('非法 URL / 模板串原样返回（不猜、不吞掉）', () => {
    const raw = '${MCP_SERVER_URL}';
    expect(maskMcpServerUrl(raw)).toBe(raw);
  });

  it('undefined 原样返回', () => {
    expect(maskMcpServerUrl(undefined)).toBeUndefined();
  });
});

describe('F11 · args 掩码：凭据形态参数的值', () => {
  it('--token xxx 形态：值被掩码，参数名保留', () => {
    const masked = maskMcpServerArgs(['-y', '--token', 'sk-arg-token', '@scope/server']);
    expect(masked).not.toContain('sk-arg-token');
    expect(masked).toContain('--token');
    expect(masked).toContain(MCP_SECRET_MASK);
    // 非凭据参数不误伤
    expect(masked).toContain('-y');
    expect(masked).toContain('@scope/server');
  });

  it('--token=xxx 形态：只有值被打码', () => {
    const masked = maskMcpServerArgs(['--token=sk-inline-token']);
    expect(masked).not.toContain('sk-inline-token');
    // 数组的 toContain 是「元素级」匹配 → 用元素断言，别用子串。
    expect(masked![0]).toBe(`--token=${MCP_SECRET_MASK}`);
    expect(masked).toHaveLength(1);
  });

  it('--api-key xxx 形态被覆盖', () => {
    const masked = maskMcpServerArgs(['--api-key', 'sk-arg-api-key']);
    expect(masked).not.toContain('sk-arg-api-key');
    expect(masked).toContain(MCP_SECRET_MASK);
  });

  it('普通参数不误伤（路径、标识、flag）', () => {
    const args = ['-y', '@modelcontextprotocol/server-filesystem', '/ws', '--verbose'];
    expect(maskMcpServerArgs(args)).toEqual(args);
  });

  it('凭据参数后面没有值时不打码（不猜）', () => {
    const masked = maskMcpServerArgs(['--token']);
    expect(masked).toEqual(['--token']);
    // 下一个元素本身是参数名 → 不当作值
    const m2 = maskMcpServerArgs(['--token', '--verbose']);
    expect(m2).toEqual(['--token', '--verbose']);
  });

  it('undefined 原样返回', () => {
    expect(maskMcpServerArgs(undefined)).toBeUndefined();
  });

  it('不修改入参数组（返回新数组）', () => {
    const args = ['--token', 'sk-arg-token'];
    const masked = maskMcpServerArgs(args);
    expect(args).toEqual(['--token', 'sk-arg-token']);
    expect(masked).not.toBe(args);
  });
});

describe('F11 · 摘要：保留 id / transport / command / toolCount，掩码 url / args', () => {
  const CFG: McpServerConfig = {
    command: 'npx',
    args: ['-y', '--token', 'sk-arg-token', '@scope/server'],
    url: 'https://alice:sk-userinfo-password@example.com/mcp?token=sk-query-token',
    transport: 'http',
    env: { API_KEY: 'sk-env-secret' },
    headers: { Authorization: 'Bearer sk-header-secret' },
  };

  it('id / transport / command / toolCount 保留', () => {
    const s = toMcpServerSummary('srv-a', CFG, 7);
    expect(s.id).toBe('srv-a');
    expect(s.transport).toBe('http');
    expect(s.command).toBe('npx');
    expect(s.toolCount).toBe(7);
  });

  it('url / args 里的凭据被掩码', () => {
    const s = toMcpServerSummary('srv-a', CFG, 7);
    expect(s.url).not.toContain('sk-userinfo-password');
    expect(s.url).not.toContain('sk-query-token');
    expect(s.args).not.toContain('sk-arg-token');
  });

  it('env / headers 不进摘要（摘要根本不带这两个字段）', () => {
    const s = toMcpServerSummary('srv-a', CFG, 7);
    const text = JSON.stringify(s);
    expect(text).not.toContain('sk-env-secret');
    expect(text).not.toContain('sk-header-secret');
    expect(text).not.toContain('API_KEY');
    expect(text).not.toContain('Authorization');
  });

  it('配置不存在时只回 id + transport + toolCount', () => {
    const s = toMcpServerSummary('srv-x', null, 0);
    expect(s.id).toBe('srv-x');
    expect(s.transport).toBe('stdio');
    expect(s.toolCount).toBe(0);
    expect(s.url).toBeUndefined();
    expect(s.args).toBeUndefined();
  });
});

describe('F11 · 端到端：宿主 mcp.list 真实路径的返回值不含任何凭据形态子串', () => {
  it('宿主 invokeTool("mcp.list") 的返回值里查不到任何凭据明文', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    const cfg: McpServerConfig = {
      command: 'npx',
      args: ['-y', '--token', 'sk-arg-token', '@scope/server'],
      url: 'https://alice:sk-userinfo-password@example.com/mcp?token=sk-query-token&api_key=sk-query-token',
      transport: 'http',
      env: { API_KEY: 'sk-env-secret' },
      headers: { Authorization: 'Bearer sk-header-secret' },
    };
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: { 'srv-a': cfg } }, null, 2), 'utf8');

    // 隔离真实配置：MCP 控制器是**惰性**构造的全局单例
    // （getMcpController 首次调用才 new，构造期读 STUDIO_MCP_CONFIG），
    // 所以在 import 宿主模块**之前**设好环境变量即可把它指向临时目录。
    const prev = process.env.STUDIO_MCP_CONFIG;
    process.env.STUDIO_MCP_CONFIG = cfgPath;
    try {
      const { createDesktopHost } = await import('../../src/host/desktop-host');
      const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
      const res = await host.invokeTool('mcp.list', {});
      expect(res.ok).toBe(true);
      const payload = JSON.stringify(res.data);

      // 模型面口径：返回值里不得出现任何凭据形态子串。
      for (const cred of CREDS) {
        expect(payload, `凭据 ${cred} 出现在宿主 mcp.list 返回值里`).not.toContain(cred);
      }
      expect(payload).not.toContain('sk-env-secret');
      expect(payload).not.toContain('sk-header-secret');

      // 非凭据信息仍在（不能把整条信息都抹掉）。
      expect(payload).toContain('srv-a');
      expect(payload).toContain('npx');
      // toolCount 保留（PM 裁定要保留的字段）。
      expect(payload).toContain('toolCount');
    } finally {
      if (prev === undefined) delete process.env.STUDIO_MCP_CONFIG;
      else process.env.STUDIO_MCP_CONFIG = prev;
    }
  });

  it('负控：不做掩码时凭据明文就在返回值里（证明这条防线真的在挡东西）', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    const cfg: McpServerConfig = {
      command: 'npx',
      args: ['-y', '--token', 'sk-arg-token'],
      url: 'https://alice:sk-userinfo-password@example.com/mcp?token=sk-query-token',
      transport: 'http',
    };
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: { 'srv-a': cfg } }, null, 2), 'utf8');

    const { McpController } = await import('../../src/host/mcp-controller');
    const controller = new McpController(cfgPath);
    // 不做掩码 = 原实现口径：url / args 原样回传
    const raw = controller.getServerConfig('srv-a');
    const payload = JSON.stringify({ id: 'srv-a', url: raw?.url, args: raw?.args });

    // 明文确实在里面（这条负控必须成立，否则上面的断言是空转）
    expect(payload).toContain('sk-userinfo-password');
    expect(payload).toContain('sk-query-token');
    expect(payload).toContain('sk-arg-token');
  });
});

describe('F11 · 契约：mcp.list 的模型面身份与零审批档位（缺陷成立的前提）', () => {
  it('mcp.list 在模型表里（模型能直接调到它）', async () => {
    const { SUPPORTED_INVOCATION_NAMES, mapUpstreamToolInvocation, UI_ONLY_INVOCATION_NAMES } =
      await import('../../src/shared/tool-contract');
    // 模型可调表里必须有它 —— 这是「模型能直接调到 mcp.list」的前提。
    expect(SUPPORTED_INVOCATION_NAMES).toContain('mcp_list');
    expect(mapUpstreamToolInvocation('mcp_list', {})?.id).toBe('mcp.list');
    // 且它**不是**仅 UI 工具（否则模型面根本够不着，本条断言就是空转）。
    expect(UI_ONLY_INVOCATION_NAMES).not.toContain('mcp_list');
  });

  it('mcp.list 的 approvalClass 是 none（零审批 → 调一次就拿到）', async () => {
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'mcp.list')!;
    expect(def.approvalClass).toBe('none');
  });
});
