// @vitest-environment node
/**
 * ㊿-c ③：MCP per-server 开关（宿主级，真宿主链）。
 *
 * 与 `mcp-enabled-toggle.test.ts`（控制器级）互补：这里打**真相源**——
 * 真起 `createDesktopHost`，走真实 `invokeTool` 与真实 HTTP 管理面：
 *   1. 模型面 `mcp.list` 只列 enabled（禁用服务器的 id / 工具都不出现）；
 *   2. 管理面 `GET /v1/mcp/servers` 全量列出（禁用的也在），每枚带 `enabled` 回显；
 *   3. 管理面 `PUT /v1/mcp/servers/:id` 带 `enabled:false` ⇒ 落盘；
 *   4. 模型面 `mcp.call` 对禁用服务器回 `mcp-server-disabled`（经宿主授权链）。
 *
 * 传输层：禁用格不需要真连接（拒调发生在 connect 之前）；启用格用
 * fetch stub 立刻失败（同 f11 口径，单测不连外网）。
 */

import { describe, it, expect, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startListenable } from './_host-port-guard';

// 静态 import（同 workbench-host 口径）：单例懒建，bootHost 在 start 前设 env 即可。
import { createDesktopHost } from '../../src/host/desktop-host';

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enabled-host-'));
const cfgPath = path.join(cfgDir, 'mcp-servers.json');
const TOKEN = 'test-token';

function writeCfg(servers: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify({ servers }, null, 2), 'utf8');
  const t = new Date(Date.now() + 2);
  fs.utimesSync(cfgPath, t, t);
}

async function bootHost(nativeConsent?: (req: { callId: string }) => Promise<'allow-once' | null>) {
  process.env.STUDIO_MCP_CONFIG = cfgPath;
  return startListenable(() =>
    createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: TOKEN },
      secret: 's',
      // mcp.call 是 approvalClass 'always'：测试宿主无页端可弹模态，
      // 用 nativeConsent 桩自动放行（production 无此参数时 fail-closed 不受影响）。
      ...(nativeConsent ? { nativeConsent: async () => await nativeConsent({ callId: 'x' }) } : {}),
    }),
  );
}

/** 假页：完成 hello 握手；对 consent-required 自动回 allow-once（mcp.call 的审批路径）。 */
function connectConsentPage(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=${TOKEN}`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p-consent' }));
    });
    ws.on('message', (raw) => {
      let msg: { type?: string; callId?: string; nonce?: string };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
      if (msg.type === 'consent-required' && msg.callId) {
        ws.send(JSON.stringify({ type: 'consent-decision', callId: msg.callId, decision: 'allow-once', nonce: msg.nonce }));
      }
    });
    ws.on('error', reject);
    // hello-ack 回来即视为就绪（hub 端 ready 置位）
    const onAck = (raw: unknown): void => {
      try {
        const m = JSON.parse(String(raw)) as { type?: string };
        if (m.type === 'hello-ack') {
          ws.off('message', onAck);
          resolve(ws);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', onAck);
  });
}

afterAll(() => {
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('㊿-c ③ · 真宿主链（模型面过滤 / 管理面全量回显 / 落盘）', () => {
  it('mcp.list 只列 enabled；GET /v1/mcp/servers 全量带 enabled；PUT 落盘 false；mcp.call 拒调 disabled', async () => {
    writeCfg({
      'on-a': { command: 'npx', args: ['-y', '@scope/server'], transport: 'stdio' },
      'off-b': { command: 'npx', args: ['-y', '@scope/other'], transport: 'stdio', enabled: false },
    });

    // 单测不连外网：stdio 连接失败路径（spawn ENOENT）本机/CI 行为一致，无需 stub fetch
    // ——getAllTools 对连接失败的服务器 warn 后跳过（toolCount 0），不阻塞断言。

    const host = await bootHost();
    const base = host.url;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    // mcp.call（approvalClass always）需要人类在场：接一枚假页并自动 allow-once。
    const page = await connectConsentPage(Number(new URL(base).port));
    try {
      // ① 模型面 mcp.list：禁用服务器整体不可见
      const res = await host.invokeTool('mcp.list', {});
      expect(res.ok).toBe(true);
      const payload = JSON.stringify(res.data);
      expect(payload).toContain('on-a');
      expect(payload).not.toContain('off-b');

      // ② 管理面 GET：全量（禁用的也在），每枚带 enabled 回显
      const listRes = await fetch(`${base}/v1/mcp/servers`, { headers: auth });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as { servers: Array<{ id: string; enabled?: boolean }> };
      const ids = body.servers.map((s) => s.id).sort();
      expect(ids).toEqual(['off-b', 'on-a']);
      const off = body.servers.find((s) => s.id === 'off-b');
      const on = body.servers.find((s) => s.id === 'on-a');
      expect(off?.enabled).toBe(false);
      expect(on?.enabled).toBe(true);

      // ③ 管理面 PUT enabled:false ⇒ 落盘（原 config 不带 enabled 字段）
      const putRes = await fetch(`${base}/v1/mcp/servers/on-a`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'on-a',
          config: { command: 'npx', args: ['-y', '@scope/server'], transport: 'stdio', enabled: false },
        }),
      });
      expect(putRes.status).toBe(200);
      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
        servers: Record<string, { enabled?: boolean }>;
      };
      expect(onDisk.servers['on-a'].enabled).toBe(false);

      // ④ 落盘后模型面立即生效：mcp.list 不再含 on-a（热重载按 mtime）
      const res2 = await host.invokeTool('mcp.list', {});
      expect(res2.ok).toBe(true);
      expect(JSON.stringify(res2.data)).not.toContain('on-a');

      // ⑤ 模型面 mcp.call 对禁用服务器拒调（经宿主完整授权链；approvalClass always
      //    的工具在测试宿主里按同链走，错误码在拒绝回执里可见）
      const callRes = await host.invokeTool('mcp.call', { serverId: 'on-a', tool: 'echo', args: {} });
      const callPayload = JSON.stringify(callRes);
      expect(callPayload).toContain('mcp-server-disabled');
    } finally {
      page.close();
      await host.stop();
    }
  }, 60_000);
});

describe('㊿-c ③ · 编辑其它字段不得静默重开禁用服务器（PM 补正 2）', () => {
  it('PUT 不带 enabled 字段（用户只改 args）⇒ 磁盘上 enabled:false 保留', async () => {
    writeCfg({
      'off-b': { command: 'npx', args: ['-y', '@scope/old'], transport: 'stdio', enabled: false },
    });
    const host = await bootHost();
    const base = host.url;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    try {
      const putRes = await fetch(`${base}/v1/mcp/servers/off-b`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'off-b',
          // 用户只改了 args，表单不带 enabled 字段
          config: { command: 'npx', args: ['-y', '@scope/new'], transport: 'stdio' },
        }),
      });
      expect(putRes.status).toBe(200);
      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
        servers: Record<string, { enabled?: boolean; args?: string[] }>;
      };
      // 禁用语义未被「字段缺省」抹掉
      expect(onDisk.servers['off-b'].enabled).toBe(false);
      // 用户改的字段确实落了
      expect(onDisk.servers['off-b'].args).toEqual(['-y', '@scope/new']);
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('PUT 显式 enabled:true ⇒ 真的重启用（覆盖 existing）', async () => {
    writeCfg({
      'off-c': { command: 'npx', args: ['-y', '@scope/x'], transport: 'stdio', enabled: false },
    });
    const host = await bootHost();
    const base = host.url;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    try {
      const putRes = await fetch(`${base}/v1/mcp/servers/off-c`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'off-c',
          config: { command: 'npx', args: ['-y', '@scope/x'], transport: 'stdio', enabled: true },
        }),
      });
      expect(putRes.status).toBe(200);
      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
        servers: Record<string, { enabled?: boolean }>;
      };
      expect(onDisk.servers['off-c'].enabled).toBe(true);
    } finally {
      await host.stop();
    }
  }, 60_000);
});