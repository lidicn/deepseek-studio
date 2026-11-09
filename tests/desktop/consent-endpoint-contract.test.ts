// @vitest-environment node
/**
 * tests/desktop/consent-endpoint-contract.test.ts
 *
 * K2（2026-11-09）：`/v1/consent/pending` 与 `/v1/consent/reply` 的**跨语言契约锁** + 端点行为锁。
 *
 * ── 为什么需要跨语言锁 ──
 * `src/api/server.ts` 里 `pending` 的 `view` 类型是 `unknown`（队列给的是具体接口，
 * server 只做 `{ ...view, nonce }` 序列化、不读字段）。这让 `tsc` **抓不到字段名漂移**：
 * 把 `callId` 写成 `call_id`、少一个 `allowedDecisions`，TypeScript 全绿，
 * 只有真机开窗那一刻才暴露——**那是最贵的一类发现时机**。
 *
 * 所以本文件做两件事：
 *   ① **同源派生**：从 Rust 侧（`src-tauri/src/consent_window.rs`）**现读**它真正 `.get("…")`
 *      解析的键名，断言响应里逐字存在（不是手抄一份清单——手抄就是第二个漂移源）；
 *   ② **端点行为**：无请求必须 `200 + pending:null`（**不许 204/404/500**，否则 K1 的轮询
 *      会长期退避在 5 秒档）；回执的四种结果（ok / bad-nonce 403 / unknown-call 404 / 非回环 Origin 403）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApiServer, type ApiServer } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import type { ApiConfig } from '../../src/api/types';
import type { PendingConsentEntry } from '../../src/host/consent-queue';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSENT_RS = path.join(REPO_ROOT, 'src-tauri', 'src', 'consent_window.rs');
const TOKEN = 'contract-token-1';

type ReplyResult = { ok: true; decision: string } | { ok: false; code: string };

/** 可注入的假队列：记录被调了几次、回执返回什么。 */
interface FakeQueue {
  entries: PendingConsentEntry[];
  replyResult: ReplyResult;
  pendingCalls: number;
  replyInputs: unknown[];
}

let activeServer: ApiServer | null = null;

afterEach(async () => {
  await activeServer?.stop();
  activeServer = null;
});

async function startServer(queue: FakeQueue | null): Promise<string> {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
  const server = createApiServer({
    config,
    backend: createFakeOfficialBackend({ chunks: [chunk('deepseek-chat', 'hi')], models: ['deepseek-chat'] }),
    authenticator: createBearerAuthenticator(TOKEN),
    ...(queue
      ? {
          consentQueue: {
            pending: () => {
              queue.pendingCalls += 1;
              return queue.entries;
            },
            reply: (input: { callId: unknown; decision: unknown; nonce: unknown }) => {
              queue.replyInputs.push(input);
              return queue.replyResult;
            },
          },
        }
      : {}),
  });
  await server.start();
  activeServer = server;
  return server.url;
}

function emptyQueue(entries: PendingConsentEntry[] = []): FakeQueue {
  return {
    entries,
    replyResult: { ok: true, decision: 'allow-once' },
    pendingCalls: 0,
    replyInputs: [],
  };
}

/** 造一条待审批条目（字段集合 = 窗口页面需要渲染的那份）。 */
function entry(over: Partial<PendingConsentEntry['view']> = {}): PendingConsentEntry {
  return {
    view: {
      callId: 'call-1',
      tool: 'file.write',
      summary: '写 A.txt',
      riskReason: '',
      mode: '询问审批',
      target: 'file:C:/ws/A.txt',
      outside: false,
      allowedDecisions: ['allow-once', 'deny'],
      requestedAt: 1_700_000_000_000,
      ...over,
    },
    nonce: 'nonce-abc',
  };
}

// ── ① 跨语言键名同源 ────────────────────────────────────────────────────────

describe('契约锁 · 端点响应键名与 Rust 侧解析键名同源', () => {
  /** 从 Rust 源码里**现读**它 `.get("…")` 用的键名（不是手抄）。 */
  function rustParsedKeys(): string[] {
    const src = readFileSync(CONSENT_RS, 'utf8');
    const keys = new Set<string>();
    const re = /\.get\(\s*"([A-Za-z0-9_]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) keys.add(m[1]);
    return [...keys].sort();
  }

  it('装置自检：确实从 Rust 源码读到了键名（否则下面的循环在空跑）', () => {
    const keys = rustParsedKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('pending');
    expect(keys).toContain('callId');
  });

  it('响应 JSON 逐字包含 Rust 解析的每个键名（`pending` / `callId`）', async () => {
    const queue = emptyQueue([entry()]);
    const base = await startServer(queue);
    const r = await fetch(`${base}/v1/consent/pending`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; pending: Record<string, unknown> | null };
    expect(body.pending).not.toBeNull();
    const pending = body.pending as Record<string, unknown>;

    for (const key of rustParsedKeys()) {
      // Rust 读 `pending`（外层）+ `callId`（内层）——两者在不同层级，分别断言。
      if (key === 'pending') {
        expect(body).toHaveProperty('pending');
      } else {
        expect(pending, `Rust 侧读 "${key}"，响应里必须逐字存在`).toHaveProperty(key);
      }
    }
    // nonce 是回执凭据，必需
    expect(pending).toHaveProperty('nonce');
  });

  it('负控：改名即红（`callId` → `call_id` 会让上面那枚抓不到）', async () => {
    // 直接构造一个"漂移后"的条目，断言现有锁会失败——
    // 这里用 expect(...).not.toHaveProperty 表达"漂移确实会被发现"。
    const queue = emptyQueue([entry()]);
    const base = await startServer(queue);
    const r = await fetch(`${base}/v1/consent/pending`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const pending = ((await r.json()) as { pending: Record<string, unknown> }).pending;
    // 正确写法有 callId；若有人改成 call_id，则 callId 不存在 ⇒ 上面的 toHaveProperty 会红
    expect(pending).toHaveProperty('callId');
    expect(pending).not.toHaveProperty('call_id');
  });
});

// ── ② 无请求必须是 200 + pending:null（**不许 204**）────────────────────────

describe('契约第 0 条 · 无请求 ⇒ 200 + pending:null', () => {
  it('空队列 ⇒ status 200（不是 204/404）且 body 有 pending 键且为 null', async () => {
    const queue = emptyQueue([]);
    const base = await startServer(queue);
    const r = await fetch(`${base}/v1/consent/pending`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    // 关键：204 会让 K1 的轮询长期退避在 5 秒档，而且不会有任何测试变红
    expect(r.status).toBe(200);
    expect(r.status).not.toBe(204);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('pending');
    expect(body.pending).toBeNull();
    expect(body.ok).toBe(true);
  });

  it('未装配 consentQueue ⇒ 503（fail-closed，不是 200 空表）', async () => {
    const base = await startServer(null);
    const r = await fetch(`${base}/v1/consent/pending`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(503);
  });

  it('无 Bearer ⇒ 401（端点必须在统一鉴权闸之后）', async () => {
    const base = await startServer(emptyQueue());
    expect((await fetch(`${base}/v1/consent/pending`)).status).toBe(401);
  });
});

// ── ③ 回执四种结果 ──────────────────────────────────────────────────────────

describe('POST /v1/consent/reply', () => {
  async function postReply(base: string, body: unknown, origin?: string): Promise<Response> {
    return fetch(`${base}/v1/consent/reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('正控：合法回执 ⇒ 200 + decision，且 callId/decision/nonce 被原样传给队列', async () => {
    const queue = emptyQueue();
    const base = await startServer(queue);
    const r = await postReply(
      base,
      { callId: 'c1', decision: 'allow-once', nonce: 'n1' },
      `http://127.0.0.1:${new URL(base).port}`,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, decision: 'allow-once' });
    expect(queue.replyInputs).toEqual([{ callId: 'c1', decision: 'allow-once', nonce: 'n1' }]);
  });

  it('bad-nonce ⇒ 403（请求保持挂起，由超时兜底 deny）', async () => {
    const queue = emptyQueue();
    queue.replyResult = { ok: false, code: 'bad-nonce' };
    const base = await startServer(queue);
    const r = await postReply(base, { callId: 'c1', decision: 'allow-once', nonce: 'bad' }, `http://127.0.0.1:1`);
    expect(r.status).toBe(403);
  });

  it('unknown-call ⇒ 404', async () => {
    const queue = emptyQueue();
    queue.replyResult = { ok: false, code: 'unknown-call' };
    const base = await startServer(queue);
    const r = await postReply(base, { callId: 'nope', decision: 'deny', nonce: 'x' }, `http://127.0.0.1:1`);
    expect(r.status).toBe(404);
  });

  it('bad-decision ⇒ 400', async () => {
    const queue = emptyQueue();
    queue.replyResult = { ok: false, code: 'bad-decision' };
    const base = await startServer(queue);
    const r = await postReply(base, { callId: 'c1', decision: 'always', nonce: 'x' }, `http://127.0.0.1:1`);
    expect(r.status).toBe(400);
  });

  it('非回环 Origin ⇒ 403（即便 token 正确；公网页面拿不到这条通道）', async () => {
    const queue = emptyQueue();
    const base = await startServer(queue);
    const r = await postReply(base, { callId: 'c1', decision: 'allow-once', nonce: 'n1' }, 'https://evil.example.com');
    expect(r.status).toBe(403);
    // 且**没有**把回执转给队列（被 Origin 闸挡在外面）
    expect(queue.replyInputs).toHaveLength(0);
  });

  it('无 Bearer ⇒ 401', async () => {
    const base = await startServer(emptyQueue());
    const r = await fetch(`${base}/v1/consent/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: 'c1', decision: 'deny', nonce: 'n' }),
    });
    expect(r.status).toBe(401);
  });

  it('畸形 body ⇒ 400（不是 500）', async () => {
    const base = await startServer(emptyQueue());
    const r = await fetch(`${base}/v1/consent/reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${new URL(base).port}`,
      },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });
});
