// @vitest-environment node
/**
 * C1 P1 安全批 · R2-02：mcp.get 不得把 MCP 密钥明文送进模型上下文。
 *
 * ── 缺陷（审计 R2-02，PM 核实成立）──
 *
 * `mcp.get` 原样返回整份服务器配置（含 `env` / `headers` 的**明文**），
 * 且该工具的 `approvalClass` 是 `'none'`（**零审批**）→ 模型调一次，
 * 用户配置里的 API Key / Authorization 头就**原样进了模型上下文**
 * （模型是外部服务方 → 密钥外泄）。
 *
 * ── 本文件的断言口径 ──
 *
 * 1. **掩码**：`mcp.get` 返回的 `env` / `headers` 的**值**全是 `****`，**键名保留**
 *    （键名是「需要配哪些变量」的信息，不是秘密）。
 * 2. **不误伤**：`command` / `args` / `cwd` / `transport` / `url` **不掩码**
 *    （编辑弹窗需要它们才能回填）。
 * 3. **档位**：`mcp.get` 的 approvalClass 必须是 `always`（不再零审批）。
 * 4. **防毁配置**：UI 编辑弹窗的表单里躺的是掩码值 `****`；用户点保存时
 *    **绝不能**把 `****` 写回磁盘、覆盖用户真实的密钥。
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  MCP_SECRET_MASK,
  maskMcpServerSecrets,
  mergeMaskedSecrets,
  type McpServerConfig,
} from '../../src/host/mcp-controller';

const tmpDirs: string[] = [];

function mkConfigDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r202-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d as string, { recursive: true, force: true });
  }
});

const SECRET_CFG: McpServerConfig = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/ws'],
  env: { API_KEY: 'sk-real-secret-value', OTHER: 'another-real-secret' },
  headers: { Authorization: 'Bearer real-token-abc123' },
  transport: 'stdio',
  cwd: '/ws',
};

describe('R2-02 · 掩码：值被替换，键名保留', () => {
  it('env 的值全是 ****，键名保留', () => {
    const masked = maskMcpServerSecrets(SECRET_CFG);
    expect(masked.env).toBeDefined();
    expect(Object.keys(masked.env as Record<string, string>).sort()).toEqual(['API_KEY', 'OTHER']);
    for (const v of Object.values(masked.env as Record<string, string>)) {
      expect(v).toBe(MCP_SECRET_MASK);
    }
  });

  it('headers 的值全是 ****，键名保留', () => {
    const masked = maskMcpServerSecrets(SECRET_CFG);
    expect(Object.keys(masked.headers as Record<string, string>)).toEqual(['Authorization']);
    expect((masked.headers as Record<string, string>).Authorization).toBe(MCP_SECRET_MASK);
  });

  it('原配置不被就地修改（掩码返回新对象）', () => {
    const before = JSON.stringify(SECRET_CFG);
    maskMcpServerSecrets(SECRET_CFG);
    expect(JSON.stringify(SECRET_CFG)).toBe(before);
  });

  it('连接方式字段不掩码（编辑弹窗需要它们回填）', () => {
    const masked = maskMcpServerSecrets(SECRET_CFG);
    expect(masked.command).toBe('npx');
    expect(masked.args).toEqual(SECRET_CFG.args);
    expect(masked.transport).toBe('stdio');
    expect(masked.cwd).toBe('/ws');
  });

  it('没有 env / headers 时不凭空造出这两个键', () => {
    const masked = maskMcpServerSecrets({ command: 'npx' });
    expect(masked.env).toBeUndefined();
    expect(masked.headers).toBeUndefined();
  });

  it('明文不出现在掩码结果的 JSON 里', () => {
    const text = JSON.stringify(maskMcpServerSecrets(SECRET_CFG));
    expect(text).not.toContain('sk-real-secret-value');
    expect(text).not.toContain('another-real-secret');
    expect(text).not.toContain('real-token-abc123');
  });
});

describe('R2-02 · 契约：审批档位与规范目标', () => {
  it('mcp.get 的 approvalClass 是 always（不再是零审批的 none）', async () => {
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'mcp.get')!;
    expect(def.approvalClass).toBe('always');
    // always 类必须绑定规范目标（换一台服务器 = 换目标）
    expect(def.canonicalTargetKind).toBe('mcp-call');
  });

  it('canonicalTarget 绑定 serverId（换服务器 = 换目标）', async () => {
    const { canonicalTargetOf } = await import('../../src/host/authorization');
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'mcp.get')!;
    const a = canonicalTargetOf(def, { serverId: 'srv-a' }).target;
    const b = canonicalTargetOf(def, { serverId: 'srv-b' }).target;
    expect(a).not.toBe(b);
    expect(a).toContain('srv-a');
  });
});

describe('R2-02 · 防毁配置：掩码占位不能覆盖真实密钥', () => {
  it('写回掩码值 → 还原成磁盘上的原值（密钥不被覆盖）', () => {
    const incoming = maskMcpServerSecrets(SECRET_CFG);
    const merged = mergeMaskedSecrets(incoming, SECRET_CFG);
    expect((merged.env as Record<string, string>).API_KEY).toBe('sk-real-secret-value');
    expect((merged.env as Record<string, string>).OTHER).toBe('another-real-secret');
    expect((merged.headers as Record<string, string>).Authorization).toBe('Bearer real-token-abc123');
  });

  it('用户真的改过的值才覆盖（改过的 key 用新值）', () => {
    const incoming: McpServerConfig = {
      ...maskMcpServerSecrets(SECRET_CFG),
      env: { API_KEY: 'sk-user-typed-new-value', OTHER: MCP_SECRET_MASK },
    };
    const merged = mergeMaskedSecrets(incoming, SECRET_CFG);
    expect((merged.env as Record<string, string>).API_KEY).toBe('sk-user-typed-new-value');
    // 没改的那个仍还原成原值
    expect((merged.env as Record<string, string>).OTHER).toBe('another-real-secret');
  });

  it('用户主动清空某个值 → 空串被如实写入（不是占位，不还原）', () => {
    const incoming: McpServerConfig = {
      ...maskMcpServerSecrets(SECRET_CFG),
      env: { API_KEY: '', OTHER: MCP_SECRET_MASK },
    };
    const merged = mergeMaskedSecrets(incoming, SECRET_CFG);
    expect((merged.env as Record<string, string>).API_KEY).toBe('');
  });

  it('磁盘上没有该 key → 保留占位（如实，不凭空造值）', () => {
    const incoming: McpServerConfig = { command: 'npx', env: { NEW_KEY: MCP_SECRET_MASK } };
    const merged = mergeMaskedSecrets(incoming, { command: 'npx' });
    expect((merged.env as Record<string, string>).NEW_KEY).toBe(MCP_SECRET_MASK);
  });

  it('磁盘上没有旧配置（新增服务器）→ 原样使用入参', () => {
    const incoming: McpServerConfig = { command: 'npx', env: { API_KEY: 'sk-typed-by-user' } };
    const merged = mergeMaskedSecrets(incoming, null);
    expect((merged.env as Record<string, string>).API_KEY).toBe('sk-typed-by-user');
  });
});

describe('R2-02 · 端到端：宿主真实落盘，密钥不被覆盖', () => {
  it('mcp.get 掩码 → UI 回填 → mcp.save 写回，磁盘上的密钥仍是原值', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ servers: { 'srv-a': SECRET_CFG } }, null, 2),
      'utf8',
    );

    const { McpController, getMcpServer } = await import('../../src/host/mcp-controller');
    const controller = new McpController(cfgPath);

    // ① UI 读回配置（模拟 mcp.get 的返回值）
    const uiView = maskMcpServerSecrets(getMcpServer('srv-a', cfgPath) as McpServerConfig);
    expect((uiView.env as Record<string, string>).API_KEY).toBe(MCP_SECRET_MASK);

    // ② UI 把表单原样提交（模拟 mcp.save）
    const merged = mergeMaskedSecrets(uiView, controller.getServerConfig('srv-a'));
    const res = controller.saveServer('srv-a', merged);
    expect(res.ok).toBe(true);

    // ③ 磁盘上的真实密钥必须原封不动
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      servers: Record<string, McpServerConfig>;
    };
    expect(onDisk.servers['srv-a'].env?.API_KEY).toBe('sk-real-secret-value');
    expect(onDisk.servers['srv-a'].env?.OTHER).toBe('another-real-secret');
    expect(onDisk.servers['srv-a'].headers?.Authorization).toBe('Bearer real-token-abc123');
    // 连接方式字段也要保住
    expect(onDisk.servers['srv-a'].command).toBe('npx');
  });

  it('负控：不做合并就会把密钥写成 ****（证明这条防线真的在挡东西）', () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ servers: { 'srv-a': SECRET_CFG } }, null, 2),
      'utf8',
    );

    // 不合并，直接把掩码结果写回去 → 密钥被毁
    const masked = maskMcpServerSecrets(SECRET_CFG);
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: { 'srv-a': masked } }, null, 2), 'utf8');
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      servers: Record<string, McpServerConfig>;
    };
    expect(onDisk.servers['srv-a'].env?.API_KEY).toBe(MCP_SECRET_MASK);
    expect(onDisk.servers['srv-a'].env?.API_KEY).not.toBe('sk-real-secret-value');
  });
});
