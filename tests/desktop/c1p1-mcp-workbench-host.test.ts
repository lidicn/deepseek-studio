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

import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// 静态 import：模块图在 collect 阶段一次性就位，用例执行期不再触发
// vitest 的「模块 fetch RPC」——满载时那条 RPC 会被饿死（`Timeout calling "fetch"`），
// 这正是全量 gate 偶发红的直接机制。单例是懒建的（`new McpController()` 才读 env），
// 所以只要 bootHost() 在 start 前设好 STUDIO_MCP_CONFIG，静态导入安全。
import { createDesktopHost } from '../../src/host/desktop-host';
import { startListenable } from './_host-port-guard';

/**
 * 20261105（全量 gate 两轮 flaky 定位后重构）：
 *
 * 旧实现每条用例都 `vi.resetModules()` + `await import('../../src/host/desktop-host')`，
 * 目的是让 MCP 控制器单例重读 `STUDIO_MCP_CONFIG`。代价是**每条用例重载整张宿主模块图**——
 * 满载时这会走 vitest 的「模块 fetch RPC」，实测直接饿死：
 *   `[vitest-worker]: Timeout calling "fetch" with "/src/host/desktop-host.ts"`
 * （12 个 CPU 占用进程 / 8 核时三条用例全部 5000ms 超时，与 CI 红的现象一致）。
 *
 * 新实现只用**一张**配置路径 + 静态 import：
 *   - 单例是进程级的，但 `McpController` 自己会按文件 mtime 热重载（`refreshConfigIfChanged`），
 *     所以只要每条用例**改写同一个配置文件**，单例就能读到新内容 —— 不需要 resetModules；
 *   - 断言一条未减：读明文 / 掩码还原 / 磁盘不被毁 / cwd 不丢 / 非回环 Origin 403 全在。
 */
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpapi-'));
const cfgPath = path.join(cfgDir, 'mcp-servers.json');
/** 本文件宿主的唯一 token 来源：host 配置与请求头共用，避免两处字面量漂移。 */
const TOKEN = 'test-token';

/** 写一份配置；顺手把 mtime 往后推 1ms，确保单例的 mtime 快照一定失效（不靠计时巧合）。 */
function writeCfg(servers: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify({ servers } as unknown, null, 2), 'utf8');
  const next = new Date(Date.now() + 1);
  fs.utimesSync(cfgPath, next, next);
}

/** 起一个真宿主；控制器单例在 start() 内首次构造时读 env。 */
async function bootHost() {
  process.env.STUDIO_MCP_CONFIG = cfgPath;
  // 端口交给 OS 分配 + 校验 undici 禁用表（机制见 _host-port-guard.ts）：
  // CI 与本机动态范围不同，用 fetch 打本机 host 的测试都要过这一层。
  return startListenable(() =>
    createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: TOKEN },
      secret: 's',
    }),
  );
}

afterAll(() => {
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

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
    writeCfg({ 'srv-a': SECRET_CFG });

    const host = await bootHost();
    const base = host.url;
    const auth = { Authorization: `Bearer ${TOKEN}` };
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
  });

  it('用户真改过的值才覆盖（改过的 key 用新值，没改的还原成原值）', async () => {
    writeCfg({ 'srv-a': SECRET_CFG });

    const host = await bootHost();
    const base = host.url;
    const auth = { Authorization: `Bearer ${TOKEN}` };
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
  });

  it('非回环 Origin（DeepSeek 页面）+ 正确 Bearer → 403（模型够不到）', async () => {
    writeCfg({ 'srv-a': SECRET_CFG });

    const host = await bootHost();
    try {
        const r = await fetch(`${host.url}/v1/mcp/servers`, {
          headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://chat.deepseek.com' },
        });
        expect(r.status).toBe(403);
      } finally {
        await host.stop();
      }
  });
});
