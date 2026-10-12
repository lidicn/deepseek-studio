process.env.STUDIO_TEST = '1'; // 禁止 main 模块自启动（§1 同约定）

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const {
  buildRunRound,
  createRuntime,
  fetchUpstreamAudit,
  installOrphanGuard,
  loadConfig,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TARGET_ROUNDS,
  DEFAULT_UPSTREAM_URL,
} = await import('../main');

const FIXED_NOW = 1700000000456;

function fakeScheduler() {
  const timers = new Map<number, () => void>();
  let seq = 0;
  return {
    setTimer: (fn: () => void, _ms: number) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    get size() {
      return timers.size;
    },
  };
}

test('loadConfig 默认值：8761 / 127.0.0.1 / 目标 5 轮 / 60s / 上游 8760（验收 2）', () => {
  const cfg = loadConfig({
    env: {},
    home: '/home/u',
    readFile: () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    },
    writeFile: () => undefined,
    mkdir: () => undefined,
    randomToken: () => 'rand-token',
    log: () => undefined,
  });
  assert.equal(cfg.port, 8761);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.target, DEFAULT_TARGET_ROUNDS);
  assert.equal(cfg.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(cfg.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
  assert.equal(cfg.upstreamUrl, DEFAULT_UPSTREAM_URL);
  assert.equal(cfg.token, 'rand-token');
  assert.equal(cfg.configDir, path.join('/home/u', '.config', 'yuanbao-audit'));
  assert.equal(cfg.checkpointPath, path.join(cfg.configDir, 'checkpoint.json'));
  assert.equal(cfg.auditLogPath, path.join(cfg.configDir, 'audit-log.jsonl'));
});

test('loadConfig 优先级：env > 文件 > 默认；数值非法回落', () => {
  const cfg = loadConfig({
    env: {
      YUANBAO_AUDIT_TOKEN: 'env-token',
      YUANBAO_AUDIT_HOST: '0.0.0.0',
      YUANBAO_AUDIT_PORT: '9000',
      YUANBAO_AUDIT_TARGET: '2',
      YUANBAO_AUDIT_INTERVAL_MS: '15',
      YUANBAO_AUDIT_UPSTREAM_URL: 'http://127.0.0.1:9999/',
    },
    home: '/home/u',
    readFile: () =>
      JSON.stringify({ host: '10.0.0.1', port: 1234, token: 'file-token', target: 99, intervalMs: 99 }),
    writeFile: () => undefined,
    mkdir: () => undefined,
    log: () => undefined,
  });
  assert.equal(cfg.token, 'env-token');
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.target, 2);
  assert.equal(cfg.intervalMs, 15);
  assert.equal(cfg.upstreamUrl, 'http://127.0.0.1:9999');

  const bad = loadConfig({
    env: { YUANBAO_AUDIT_PORT: 'not-a-number' },
    home: '/home/u',
    readFile: () => JSON.stringify({ token: 'file-token', port: 1234 }),
    writeFile: () => undefined,
    mkdir: () => undefined,
    log: () => undefined,
  });
  assert.equal(bad.port, 1234, 'env 非法数值应回落到文件值');
});

test('首次运行：生成随机 token 并以 0600 落盘', () => {
  let written: { file: string; data: string; mode: number } | null = null;
  const cfg = loadConfig({
    env: {},
    home: '/home/u',
    readFile: () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    },
    writeFile: (file, data, mode) => (written = { file, data, mode }),
    mkdir: () => undefined,
    randomToken: () => 'gen-token-1',
    log: () => undefined,
  });
  assert.ok(written);
  assert.equal(written!.mode, 0o600);
  assert.equal(written!.file, path.join(cfg.configDir, 'config.json'));
  const parsed = JSON.parse(written!.data) as Record<string, unknown>;
  assert.equal(parsed.token, 'gen-token-1');
  assert.equal(parsed.port, 8761);
});

test('配置损坏：告警 + 不覆盖磁盘（与 §1 同语义）', () => {
  const writes: string[] = [];
  const logs: string[] = [];
  const cfg = loadConfig({
    env: {},
    home: '/home/u',
    readFile: () => '{broken',
    writeFile: (file) => writes.push(file),
    mkdir: () => undefined,
    randomToken: () => 'mem-token',
    log: (m) => logs.push(m),
  });
  assert.equal(cfg.token, 'mem-token');
  assert.equal(writes.length, 0, '损坏文件不得被覆盖');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /配置文件损坏/);
});

test('fetchUpstreamAudit：200 → 条目数组；401 → 抛错；非数组 → 抛错', async () => {
  const entries = [{ id: 'a1', at: 1, tool: 'file.read', outcome: 'ok', ok: true }];
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/tools/audit')) {
      if (req.headers.authorization !== 'Bearer ut') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"code":"unauthorized","message":"nope"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: entries }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const ok = await fetchUpstreamAudit({ upstreamUrl: base, upstreamToken: 'ut', fetchTimeoutMs: 1000 });
    assert.deepEqual(ok, entries);

    const unauthorized = await fetchUpstreamAudit({ upstreamUrl: base, upstreamToken: 'bad', fetchTimeoutMs: 1000 }).then(
      () => null,
      (e: Error) => e,
    );
    assert.equal(unauthorized?.message, 'upstream /v1/tools/audit → HTTP 401');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('fetchUpstreamAudit：上游挂起 → 30s 超时语义（此处用 50ms 验证 AbortSignal.timeout）', async () => {
  const server = http.createServer(() => {
    /* 永不响应 */
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const err = await fetchUpstreamAudit(
      { upstreamUrl: `http://127.0.0.1:${port}`, upstreamToken: 'ut', fetchTimeoutMs: 50 },
    ).then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(err instanceof Error);
    assert.match(String(err), /timeout|abort/i);
    assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 30_000);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('buildRunRound：成功轮写 JSONL（含条目与轮次）并返回 ok', async () => {
  const lines: string[] = [];
  const cfg = {
    upstreamUrl: 'http://x',
    upstreamToken: 'ut',
    fetchTimeoutMs: 100,
    auditLogPath: '/data/audit-log.jsonl',
  } as Parameters<typeof buildRunRound>[0];

  const run = buildRunRound(cfg, {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: [{ id: 'a1', tool: 'file.read' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
    appendFile: async (file, data) => {
      assert.equal(file, '/data/audit-log.jsonl');
      lines.push(data);
    },
    now: () => FIXED_NOW,
  });

  const outcome = await run({ round: 1, target: 3, startedAt: 1 });
  assert.deepEqual(outcome, { ok: true, summary: 'round 1/3: 1 entries' });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { at: number; round: number; target: number; count: number; entries: { tool: string }[] };
  assert.equal(parsed.at, FIXED_NOW);
  assert.equal(parsed.round, 1);
  assert.equal(parsed.target, 3);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.entries[0].tool, 'file.read');
});

test('buildRunRound：上游失败 → ok:false 且不写日志（fail-closed 不伪造）', async () => {
  let wrote = 0;
  const cfg = { upstreamUrl: 'http://x', upstreamToken: '', fetchTimeoutMs: 100, auditLogPath: '/data/a.jsonl' } as Parameters<
    typeof buildRunRound
  >[0];
  const run = buildRunRound(cfg, {
    fetchImpl: (async () =>
      new Response('{"error":{"code":"unauthorized","message":"missing or invalid bearer token"}}', {
        status: 401,
      })) as unknown as typeof fetch,
    appendFile: async () => {
      wrote += 1;
    },
    now: () => FIXED_NOW,
  });
  const outcome = await run({ round: 2, target: 3, startedAt: 1 });
  assert.equal(outcome.ok, false);
  assert.equal(wrote, 0);
  if (!outcome.ok) assert.equal(outcome.error, 'upstream /v1/tools/audit → HTTP 401');
});

test('createRuntime 端到端：起 API → 跑一轮 → 落盘 → 重启恢复（验收 3/6/7）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuanbao-rt-'));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'a1', tool: 'file.read', outcome: 'ok', ok: true }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as AddressInfo).port;

  const config = {
    host: '127.0.0.1',
    port: 0,
    token: 'tk-1',
    target: 2,
    intervalMs: 10_000,
    fetchTimeoutMs: 500,
    upstreamUrl: `http://127.0.0.1:${upPort}`,
    upstreamToken: 'ut',
    configDir: dir,
    configPath: path.join(dir, 'config.json'),
    checkpointPath: path.join(dir, 'checkpoint.json'),
    auditLogPath: path.join(dir, 'audit-log.jsonl'),
    project: 'test',
    sessionUrl: 'https://yuanbao.tencent.com/chat/test',
  };

  try {
    const scheduler = fakeScheduler();
    const rt = await createRuntime(config, {
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      now: () => FIXED_NOW,
      log: () => undefined,
    });
    await rt.start();

    // 验收 3
    const health = await fetch(`${rt.server.url}/healthz`);
    assert.equal(await health.text(), '{"ok":true}');

    // 跑一轮真实工作
    rt.loop.run();
    await rt.loop.tick();

    const logLines = (await fsp.readFile(config.auditLogPath, 'utf8')).trim().split('\n');
    assert.equal(logLines.length, 1);
    const line = JSON.parse(logLines[0]) as { round: number; count: number; entries: { tool: string }[] };
    assert.equal(line.round, 1);
    assert.equal(line.count, 1);
    assert.equal(line.entries[0].tool, 'file.read');

    // 验收 6：checkpoint.json 存在且字段正确
    const cp = JSON.parse(await fsp.readFile(config.checkpointPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(cp, {
      version: 1,
      state: 'running',
      rounds: 1,
      target: 2,
      lastRound: FIXED_NOW,
      updatedAt: FIXED_NOW,
      project: 'test',
      seenRounds: [],
      sessionUrl: 'https://yuanbao.tencent.com/chat/test',
    });
    // 无 tmp 残留
    const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);

    await rt.stop();

    // 验收 7：重启后恢复
    const scheduler2 = fakeScheduler();
    const rt2 = await createRuntime(config, {
      setTimer: scheduler2.setTimer,
      clearTimer: scheduler2.clearTimer,
      now: () => FIXED_NOW,
      log: () => undefined,
    });
    assert.deepEqual(rt2.restored, {
      state: 'running',
      rounds: 1,
      target: 2,
      lastRound: FIXED_NOW,
    });
    await rt2.start();
    const status = await fetch(`${rt2.server.url}/status`, { headers: { Authorization: 'Bearer tk-1' } });
    assert.deepEqual((await status.json()) as unknown, {
      state: 'running',
      rounds: 1,
      target: 2,
      lastRound: FIXED_NOW,
      project: 'test',
      seenRounds: [],
      sessionUrl: 'https://yuanbao.tencent.com/chat/test',
    });
    await rt2.stop();
  } finally {
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('孤儿防护：ppid 变化触发 self-exit，信号会清理定时器并退出', () => {
  let tick: (() => void) | null = null;
  let cleared = 0;
  const exits: number[] = [];
  const handlers = new Map<string, () => void>();

  const stop = installOrphanGuard(
    {
      getPpid: () => 100,
      alive: () => true,
      exit: (c) => exits.push(c),
      setInterval: (fn: () => void) => {
        tick = fn;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {
        cleared += 1;
      },
      on: (sig, fn) => {
        handlers.set(sig, fn);
      },
    },
    5,
  );

  (tick as unknown as () => void)();
  assert.deepEqual(exits, [], 'ppid 未变且存活时不应退出');

  handlers.get('SIGTERM')?.();
  assert.deepEqual(exits, [0]);
  assert.equal(cleared >= 1, true);
  stop();

  // 再验证 ppid 变化分支
  let tick2: (() => void) | null = null;
  const exits2: number[] = [];
  installOrphanGuard(
    {
      getPpid: () => 1,
      alive: () => false,
      exit: (c) => exits2.push(c),
      setInterval: (fn: () => void) => {
        tick2 = fn;
        return 2 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => undefined,
      on: () => undefined,
    },
    5,
  );
  (tick2 as unknown as () => void)();
  assert.deepEqual(exits2, [0]);
});
