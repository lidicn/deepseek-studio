import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApiServer, type ApiServer } from '../../src/api/server';
import { createFakeOfficialBackend } from '../../src/api/official-backend';

let activeServer: ApiServer | null = null;

async function startServer(lanEnabled: boolean): Promise<{ server: ApiServer; port: number }> {
  const backend = createFakeOfficialBackend({ chunks: [], models: [] });
  const server = createApiServer({
    config: { host: '127.0.0.1', port: 0, token: 'test-token' },
    backend,
    agentLanAccess: { lanEnabled, pairingCode: 'PAIR1234' },
  });
  await server.start();
  activeServer = server;
  return { server, port: Number(new URL(server.url).port) };
}

function preflight(port: number, origin: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/agent-ws',
      method: 'OPTIONS',
      headers: {
        Host: host,
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
      },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await activeServer?.stop();
  activeServer = null;
});

describe('LAN PWA · /agent-ws 预检', () => {
  it('显式开启 LAN 时，与请求 Host 完全同源的 Origin 返回 204', async () => {
    const { port } = await startServer(true);
    const host = `192.168.2.201:${port}`;
    await expect(preflight(port, `http://${host}`, host)).resolves.toBe(204);
  });

  it('LAN 未开启时，同一局域网 Origin 返回 403', async () => {
    const { port } = await startServer(false);
    const host = `192.168.2.201:${port}`;
    await expect(preflight(port, `http://${host}`, host)).resolves.toBe(403);
  });

  it('LAN 开启也不会放行跨源 Origin', async () => {
    const { port } = await startServer(true);
    const host = `192.168.2.201:${port}`;
    await expect(preflight(port, 'http://192.168.2.202:8760', host)).resolves.toBe(403);
  });
});
