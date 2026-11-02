// @vitest-environment node
/**
 * C1 P1 安全批（(B) 方案）：MCP 配置端点的**宿主侧真实实现**。
 *
 * ── 为什么另起一个文件 ──
 *
 * `c1p1-mcp-workbench-endpoints.test.ts` 打的是 API 层的**路由与闸门**
 * （用假 MCP 实现喂数据）。本文件打的是**真相源**：宿主真的起一个
 * `createDesktopHost` → 真的读 MCP 配置文件 → 真的落盘 → 真的重载。
 *
 * PM 纪律：「验收用例必须打在真相源上，打函数不算过门禁」。
 *
 * ── 断言口径 ──
 *
 * 1. 读端点回**明文**（工作台的功能需求；不经工具通道、不进模型上下文）。
 * 2. 写回走 `mergeMaskedSecrets` → 用户没改的掩码占位 `****` **还原成磁盘原值**
 *    （防毁配置：不能把真实密钥写成 `****`）。
 * 3. 写回后控制器**内存态**与磁盘一致（`reload()` 生效）。
 * 4. `cwd` 不丢（UI 补过的字段，回写后仍在）。
 * 5. 非回环 Origin + 正确 Bearer → 403（模型够不到）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDirs: string[] = [];

function mkConfigDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpapi-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d as string, { recursive: true, force: true });
  }
});

/**
 * 隔离 MCP 控制器单例。
 *
 * `getMcpController()` 是**模块级单例**，构造时读一次 `STUDIO_MCP_CONFIG`；
 * 而 `STUDIO_MCP_CONFIG` 只在**模块首次 import 时**被读进单例的 configPath。
 * 不重置模块的话，第二个用例会复用第一个用例的单例 → 读写**另一个**配置文件。
 *
 * `vi.resetModules()` 清模块注册表 → 随后的动态 import 得到**全新**的模块实例
 * → 单例重建 → 读到本次的 env。
 */
async function freshHost(cfgPath: string) {
  vi.resetModules();
  process.env.STUDIO_MCP_CONFIG = cfgPath;
  const { createDesktopHost } = await import('../../src/host/desktop-host');
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 'test-token' },
    secret: 's',
  });
  await host.start();
  return host;
}

const SECRET_CFG = {
  command: 'npx',
  args: ['-y', '@scope/server'],
  env: { API_KEY: '{{SECRET_ckuxu34d}}' },
  headers: { Authorization: 'Bearer real-token-abc123' },
  cwd: '/ws',
  transport: 'stdio' as const,
};

describe('MCP 端点 · 宿主真实实现（读明文 / 写回不毁配置）', () => {
  it('GET 回明文；PUT 写回后磁盘上的真实密钥未被覆盖；cwd 不丢', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: { 'srv-a': SECRET_CFG } }, null, 2), 'utf8');

    const prev = process.env.STUDIO_MCP_CONFIG;
    try {
      const host = await freshHost(cfgPath);
      const base = host.url;
      const auth = { Authorization: 'Bearer test-token' };
      try {
        // ① 读端点回明文
        const listRes = await fetch(`${base}/v1/mcp/servers`, { headers: auth });
        expect(listRes.status).toBe(200);
        const body = (await listRes.json()) as { servers: Array<Record<string, unknown>> };
        expect(body.servers).toHaveLength(1);
        const s = body.servers[0];
        expect(s.id).toBe('srv-a');
        // 明文：工作台要看到真实密钥
        expect((s.env as Record<string, string>).API_KEY).toBe('{{SECRET_ckuxu34d}}');
        expect((s.headers as Record<string, string>).Authorization).toBe('Bearer real-token-abc123');
        expect(s.cwd).toBe('/ws');

        // ② 写回：模拟 UI 编辑弹窗提交（表单里躺的是**掩码占位**）
        const putRes = await fetch(`${base}/v1/mcp/servers/srv-a`, {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'srv-a',
            config: {
              command: 'npx',
              args: ['-y', '@scope/server'],
              env: { API_KEY: '****' },
              headers: { Authorization: '****' },
              cwd: '/ws',
              transport: 'stdio',
            },
          }),
        });
        expect(putRes.status).toBe(200);

        // ③ 磁盘上的真实密钥**未被覆盖成 ******
        const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
          servers: Record<string, typeof SECRET_CFG>;
        };
        expect(onDisk.servers['srv-a'].env.API_KEY).toBe('{{SECRET_ckuxu34d}}');
        expect(onDisk.servers['srv-a'].headers.Authorization).toBe('Bearer real-token-abc123');
        // ④ cwd 不丢
        expect(onDisk.servers['srv-a'].cwd).toBe('/ws');

        // ⑤ 内存态与磁盘一致（reload 生效）：再读一次仍是原值
        const listRes2 = await fetch(`${base}/v1/mcp/servers`, { headers: auth });
        const body2 = (await listRes2.json()) as { servers: Array<Record<string, unknown>> };
        expect((body2.servers[0].env as Record<string, string>).API_KEY).toBe('{{SECRET_ckuxu34d}}');
      } finally {
        await host.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.STUDIO_MCP_CONFIG;
      else process.env.STUDIO_MCP_CONFIG = prev;
    }
  });

  it('用户真改过的值才覆盖（改过的 key 用新值，没改的还原成原值）', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: { 'srv-a': SECRET_CFG } }, null, 2), 'utf8');

    const prev = process.env.STUDIO_MCP_CONFIG;
    try {
      const host = await freshHost(cfgPath);
      const base = host.url;
      const auth = { Authorization: 'Bearer test-token' };
      try {
        const putRes = await fetch(`${base}/v1/mcp/servers/srv-a`, {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'srv-a',
            config: {
              command: 'npx',
              args: ['-y', '@scope/server'],
              // 用户真改了 API_KEY（不再是掩码占位）；headers 仍是占位（没改）
              env: { API_KEY: '{{SECRET_ewtxlpwe}}' },
              headers: { Authorization: '****' },
              cwd: '/ws',
              transport: 'stdio',
            },
          }),
        });
        expect(putRes.status).toBe(200);

        const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
          servers: Record<string, typeof SECRET_CFG>;
        };
        // 改过的 → 新值
        expect(onDisk.servers['srv-a'].env.API_KEY).toBe('{{SECRET_ewtxlpwe}}');
        // 没改的 → 还原成磁盘原值（没被写成 ****）
        expect(onDisk.servers['srv-a'].headers.Authorization).toBe('Bearer real-token-abc123');
      } finally {
        await host.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.STUDIO_MCP_CONFIG;
      else process.env.STUDIO_MCP_CONFIG = prev;
    }
  });

  it('非回环 Origin（DeepSeek 页面）+ 正确 Bearer → 403（模型够不到）', async () => {
    const dir = mkConfigDir();
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: { 'srv-a': SECRET_CFG } }, null, 2), 'utf8');

    const prev = process.env.STUDIO_MCP_CONFIG;
    try {
      const host = await freshHost(cfgPath);
      try {
        const r = await fetch(`${host.url}/v1/mcp/servers`, {
          headers: { Authorization: 'Bearer test-token', Origin: 'https://chat.deepseek.com' },
        });
        expect(r.status).toBe(403);
      } finally {
        await host.stop();
      }
    } finally {
      if (prev === undefined) delete process.env.STUDIO_MCP_CONFIG;
      else process.env.STUDIO_MCP_CONFIG = prev;
    }
  });
});
