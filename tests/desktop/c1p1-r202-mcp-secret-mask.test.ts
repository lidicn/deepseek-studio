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

import { describe, it, expect, afterEach, vi } from 'vitest';
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

  // P2 小卡（裁定五十六，2026-11-06）：本条原口径是「磁盘上没有该 key → **保留占位**
  // （如实，不凭空造值）」。**已按裁定 (a) 改为拒写** —— 理由：
  //   `****` 落盘不是「如实记录」，而是**造了一个假凭据**：之后它被当真值使用，
  //   认证必失败，而日志里看不出这是掩码残留（用户只会反复重填）。
  //   「不凭空造值」的意图由此**以更强的形式**保留：什么都不写，而不是写一个假值。
  // 前提已核（裁定五十六 二）：该断言的原始意图见本文件头部「本文件的断言口径」第 4 条
  //   （只要求「绝不能把 `****` 写回磁盘」），引入提交 `7759a96` 的正文亦无「必须落盘」的要求；
  //   `mergeMaskedSecrets` 的三个生产调用方 `desktop-host.ts:784/:1518/:1529` 全部是
  //   `if (!ok) return {ok:false, error}` ⇒ **无消费方依赖 `****` 落盘**。
  it('磁盘上没有该 key → **拒写**（不得把 `****` 当值落盘）', () => {
    const incoming: McpServerConfig = { command: 'npx', env: { NEW_KEY: MCP_SECRET_MASK } };
    // 兼容入口的形态 = 抛错（绝不静默写回）
    expect(() => mergeMaskedSecrets(incoming, { command: 'npx' })).toThrow(/unresolved-mask/);
  });

  it('拒写时 error/detail **可区分**（不是笼统失败，用户看得懂为什么被拒）', async () => {
    const { mergeMaskedSecretsChecked } = await import('../../src/host/mcp-controller');
    const incoming: McpServerConfig = { command: 'npx', env: { NEW_KEY: MCP_SECRET_MASK } };
    const r = mergeMaskedSecretsChecked(incoming, { command: 'npx' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('unresolved-mask');
      // detail 必须点名是哪个字段、哪个键、以及「磁盘上没有该键可还原」
      expect(r.detail).toContain('env.NEW_KEY');
      expect(r.detail).toContain('磁盘上没有该键可还原');
    }
  });

  // F4（PM 复核）：env 与 headers 对称，但原回归只覆盖 env ⇒ 补 headers 一枚。
  it('headers 同样拒写：掩码但磁盘无 headers 键 → detail 点名 headers.Authorization', async () => {
    const { mergeMaskedSecretsChecked } = await import('../../src/host/mcp-controller');
    const incoming: McpServerConfig = { command: 'npx', headers: { Authorization: MCP_SECRET_MASK } };
    const r = mergeMaskedSecretsChecked(incoming, { command: 'npx' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('unresolved-mask');
      expect(r.detail).toContain('headers.Authorization');
    }
  });
  it('磁盘上没有旧配置（新增服务器）→ 原样使用入参', () => {
    const incoming: McpServerConfig = { command: 'npx', env: { API_KEY: 'sk-typed-by-user' } };
    const merged = mergeMaskedSecrets(incoming, null);
    expect((merged.env as Record<string, string>).API_KEY).toBe('sk-typed-by-user');
  });
});

describe('R2-02 · 端到端：宿主真实落盘，密钥不被覆盖', () => {
  // F1（PM 复核，2026-11-06）：本条初版**根本没走写路径** —— 只调纯函数
  // `mergeMaskedSecretsChecked` 就断言「磁盘不含 `****`」，那两条断言物理上不可能失败。
  // 现在按 `desktop-host.ts:784-790` 的真实 handler 形状走：**只有 ok 才 saveServer**，
  // 并用 spy 证明「拒写时 saveServer 真的没被调用」，最后配一条**正控**证明磁盘断言有牙。
  it('P2 真回归（走真实写路径）：拒写 ⇒ saveServer 不被调用 ⇒ 磁盘无 `****` 且逐字节不变', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    // 磁盘上 srv-a 只有 API_KEY，**没有 NEW_KEY**
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ servers: { 'srv-a': { command: 'npx', env: { API_KEY: 'sk-real-secret-value' } } } }, null, 2),
      'utf8',
    );
    const before = fs.readFileSync(cfgPath, 'utf8');

    const { McpController, mergeMaskedSecretsChecked } = await import('../../src/host/mcp-controller');
    const controller = new McpController(cfgPath);
    // 监视真实写入口：handler 里 ok 才调它
    const saveSpy = vi.spyOn(controller, 'saveServer');

    // 表单里带来一个「掩码但磁盘无此键」的 NEW_KEY（例如从别处粘来的 `****`）
    const incoming: McpServerConfig = {
      command: 'npx',
      env: { API_KEY: MCP_SECRET_MASK, NEW_KEY: MCP_SECRET_MASK },
    };
    const r = mergeMaskedSecretsChecked(incoming, controller.getServerConfig('srv-a'));
    // ① 可判别（不抛、返回可辨识联合 —— F2 并列断言）
    expect(() => mergeMaskedSecretsChecked(incoming, controller.getServerConfig('srv-a'))).not.toThrow();

    // ② 复刻真实 handler（desktop-host.ts:784-790）：**只有 ok 才落到磁盘**
    if (r.ok) controller.saveServer('srv-a', r.config);

    // ③ **真回归本体放在最前**（PM 复核 F1）：红必须红在**磁盘**上，
    //    而不是红在 `r.ok` 上 —— 若拒写闸被去掉，这一条会当场红（磁盘出现 `****`）。
    expect(fs.readFileSync(cfgPath, 'utf8')).not.toContain(MCP_SECRET_MASK);
    // ④ 拒写时文件**逐字节不变**（没有半截写入、没有顺手清空）
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
    // ⑤ 装置自检：写入口**确实没被调用** —— 证明测的是拒写分支，而不是一个从不发生的写
    expect(saveSpy).not.toHaveBeenCalled();
    // ⑥ 契约：拒写返回 ok:false
    expect(r.ok).toBe(false);
  });

  it('P2 正控（证明上一条的磁盘断言有牙）：绕过拒写直接落盘 ⇒ 磁盘**确实**出现 `****`', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ servers: { 'srv-a': { command: 'npx', env: { API_KEY: 'sk-real-secret-value' } } } }, null, 2),
      'utf8',
    );
    const { McpController } = await import('../../src/host/mcp-controller');
    const controller = new McpController(cfgPath);

    // 故意不经过 merge 的拒写闸，直接把带掩码的 config 交给真实写入口（= 旧行为）
    const bypassed: McpServerConfig = {
      command: 'npx',
      env: { API_KEY: MCP_SECRET_MASK, NEW_KEY: MCP_SECRET_MASK },
    };
    const res = controller.saveServer('srv-a', bypassed);
    expect(res.ok).toBe(true);

    // 磁盘上**确实**出现了掩码字面量 ⇒ 上一条「不得出现」的断言不是空转
    const onDisk = fs.readFileSync(cfgPath, 'utf8');
    expect(onDisk).toContain(MCP_SECRET_MASK);
    expect((JSON.parse(onDisk) as { servers: Record<string, McpServerConfig> }).servers['srv-a'].env?.NEW_KEY).toBe(
      MCP_SECRET_MASK,
    );
  });

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
