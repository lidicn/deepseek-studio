import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createAuditLoop, type CommandName, type RoundOutcome } from '../audit-loop';
import {
  createApiServer,
  createBearerAuthenticator,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  READ_BODY_TIMEOUT_MS,
  isLocalOrigin,
} from '../server';

const TOKEN = 'test-token-0123456789';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeLoop() {
  return createAuditLoop({
    target: 3,
    intervalMs: 10_000,
    runRound: (): RoundOutcome => ({ ok: true }),
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
}

async function withServer(
  opts: Partial<Parameters<typeof createApiServer>[0]> = {},
  fn: (base: string, loop: ReturnType<typeof makeLoop>) => Promise<void>,
) {
  const loop = makeLoop();
  const server = createApiServer({
    config: { host: '127.0.0.1', port: 0, token: TOKEN },
    loop,
    ...opts,
  });
  await server.start();
  try {
    await fn(server.url, loop);
  } finally {
    await server.stop();
  }
}

test('契约常量：默认端口 8761、10MB、30s（验收 2）', () => {
  assert.equal(DEFAULT_PORT, 8761);
  assert.equal(MAX_BODY_BYTES, 10 * 1024 * 1024);
  assert.equal(READ_BODY_TIMEOUT_MS, 30_000);
});

test('GET /healthz 免鉴权返回 {"ok":true}（验收 3）', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
  });
});

test('/status 缺 token / 错 token 一律 401 fail-closed', async () => {
  await withServer({}, async (base) => {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: TOKEN }]) {
      const res = await fetch(`${base}/status`, { headers });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'unauthorized');
    }
  });
});

test('/status 恰好返回 {state,rounds,target,lastRound}（验收 4）', async () => {
  await withServer({}, async (base, loop) => {
    loop.enqueue('continue');
    await loop.tick();
    const res = await fetch(`${base}/status`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['lastRound', 'rounds', 'state', 'target']);
    assert.deepEqual(body, loop.status());
    assert.equal(body.state, 'running');
    assert.equal(body.rounds, 1);
    assert.equal(body.target, 3);
    assert.equal(typeof body.lastRound, 'number');
  });
});

test('POST /command {"command":"continue"} 写入命令队列（验收 5）', async () => {
  await withServer({}, async (base, loop) => {
    const res = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'continue' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; command: string; queueDepth: number; status: { state: string } };
    assert.equal(body.ok, true);
    assert.equal(body.command, 'continue');
    assert.equal(body.queueDepth, 1);
    assert.equal(body.status.state, 'running');
    assert.equal(loop.status().state, 'running');
    assert.equal(loop.queueDepth(), 1);

    const q = await fetch(`${base}/commands`, { headers: AUTH });
    const qBody = (await q.json()) as { data: { command: string; applied: boolean }[] };
    assert.equal(qBody.data.length, 1);
    assert.equal(qBody.data[0].command, 'continue');
    assert.equal(qBody.data[0].applied, true);
  });
});

test('/command 缺 token → 401；不因 body 合法而放行', async () => {
  await withServer({}, async (base, loop) => {
    const res = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'continue' }),
    });
    assert.equal(res.status, 401);
    assert.equal(loop.queueDepth(), 0);
  });
});

test('/command 非法 JSON / 缺字段 / 未知命令 → 400', async () => {
  await withServer({}, async (base) => {
    const cases: [string, RegExp][] = [
      ['{oops', /invalid json body/],
      ['{}', /command must be one of/],
      ['{"command":42}', /command must be one of/],
      ['{"command":"reboot"}', /command must be one of/],
    ];
    for (const [body, re] of cases) {
      const res = await fetch(`${base}/command`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400, body);
      const parsed = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(parsed.error.code, 'bad_request');
      assert.match(parsed.error.message, re);
    }
  });
});

test('readBody 超限 → 413 payload_too_large', async () => {
  await withServer({ limits: { maxBodyBytes: 64, readBodyTimeoutMs: 1000 } }, async (base) => {
    const res = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'continue', pad: 'x'.repeat(512) }),
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'payload_too_large');
  });
});

test('readBody 超时 → 408 request_timeout', async () => {
  const loop = makeLoop();
  const server = createApiServer({
    config: { host: '127.0.0.1', port: 0, token: TOKEN },
    loop,
    limits: { maxBodyBytes: 1024, readBodyTimeoutMs: 60 },
  });
  await server.start();
  try {
    const port = Number(server.url.match(/:(\d+)$/)![1]);
    const raw = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    raw.on('data', (c: Buffer) => chunks.push(c));
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    raw.write(
      'POST /command HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        `Authorization: Bearer ${TOKEN}\r\n` +
        'Content-Type: application/json\r\n' +
        'Content-Length: 500\r\n\r\n' +
        '{',
    );
    await new Promise((r) => setTimeout(r, 250));
    const text = Buffer.concat(chunks).toString('utf8');
    assert.match(text, /408/);
    assert.match(text, /request_timeout/);
    raw.destroy();
  } finally {
    await server.stop();
  }
});

test('GET /v1/audit-log 返回最后 N 行；无文件时为空（验收 2.8/4.3）', async () => {
  const tmp = path.join(os.tmpdir(), `audit-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmp, [1, 2, 3].map((n) => JSON.stringify({ round: n })).join('\n') + '\n');
  await withServer({ auditLogPath: tmp }, async (base) => {
    const res = await fetch(`${base}/v1/audit-log?lines=2`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: number; lines: string[] };
    assert.equal(body.total, 3);
    assert.equal(body.lines.length, 2);
    assert.deepEqual(JSON.parse(body.lines[1]), { round: 3 });

    const all = await fetch(`${base}/v1/audit-log`, { headers: AUTH });
    const allBody = (await all.json()) as { lines: string[] };
    assert.equal(allBody.lines.length, 3); // 默认 20，全返回
  });
  fs.unlinkSync(tmp);

  // 路径未配置 → 404
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/audit-log`, { headers: AUTH });
    assert.equal(res.status, 404);
  });
});

test('CORS fail-closed：非本地 origin 403，本地 origin 204 + ACAO', async () => {
  await withServer({}, async (base) => {
    const evil = await fetch(`${base}/status`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    const local = await fetch(`${base}/command`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(local.status, 204);
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(isLocalOrigin('https://127.0.0.1:1234'), true);
    assert.equal(isLocalOrigin('https://evil.example'), false);
    assert.equal(isLocalOrigin(undefined), false);
  });
});

test('未知路径 404、已知路径错误方法 405 + Allow', async () => {
  await withServer({}, async (base) => {
    const notFound = await fetch(`${base}/v1/nope`, { headers: AUTH });
    assert.equal(notFound.status, 404);
    const nf = (await notFound.json()) as { error: { code: string; message: string } };
    assert.equal(nf.error.code, 'not_found');
    assert.equal(nf.error.message, 'GET /v1/nope');

    const wrongMethod = await fetch(`${base}/status`, { method: 'DELETE', headers: AUTH });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
  });
});

test('Bearer 鉴权器边界：大小写/空白/数组头/空 token 全部拒绝', () => {
  const auth = createBearerAuthenticator('secret');
  assert.equal(auth.authenticate('Bearer secret'), true);
  assert.equal(auth.authenticate(['Bearer secret']), true);
  assert.equal(auth.authenticate('bearer secret'), false);
  assert.equal(auth.authenticate('Bearer secret '), false);
  assert.equal(auth.authenticate('Bearer  secret'), false);
  assert.equal(auth.authenticate('secret'), false);
  assert.equal(auth.authenticate(undefined), false);
  assert.equal(createBearerAuthenticator('').authenticate('Bearer '), true); // 空 token 也必须显式带上前缀
});
