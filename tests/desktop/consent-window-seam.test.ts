// @vitest-environment node
/**
 * tests/desktop/consent-window-seam.test.ts
 *
 * 2026-11-19 卡「原生审批窗接缝缺陷」的**真回归断言**。
 *
 * ── 为什么需要这一枚（接缝两套测试各测一半，中间没人测）──
 * 同一份 `GET /v1/consent/pending` 响应有两个消费者，形状**不同**：
 *   - **Rust**（`src-tauri/src/consent_window.rs` 的 `parse_pending_body`）：只读 `pending` 键，
 *     要**扁平**对象（`callId`／`nonce` 在顶层）——`consent-endpoint-contract.test.ts` 锁的是这一半；
 *   - **审批窗页面**（`src/ui/consent-panel.ts` 的 `tick()`）：读 `payload.request`
 *     （`{pending: boolean, request: ConsentPendingRequest}`）——`consent-window.test.ts`
 *     锁的是这一半，但它的 fetch 是**桩**（L49 自己造 `{pending:true, request}`）。
 *
 * ⇒ 真端点曾只回扁平一份：`payload.pending` 是对象（真值）⇒ 页面取 `payload.request`
 *   得 `undefined` ⇒ `renderState('暂无待审批请求')` ⇒ **窗口永远空卡、宿主超时 deny**。
 *   两端各自的测试都绿，接缝没人测——正是本文件要钉死的那一格。
 *
 * 本文件**不碰 DOM**（窗口页渲染另有 `consent-window.test.ts` 用桩覆盖）：这里钉的是**真端点**，
 * 用的判据就是页面那一行表达式本身（`payload?.pending ? payload.request : undefined`），
 * 避免"我的断言与页面的取数式不同形"这种二次漂移。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer, type ApiServer } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import type { ApiConfig } from '../../src/api/types';
import type { PendingConsentEntry } from '../../src/host/consent-queue';
// 宿主侧真源：approvalClass 不许在测试里手抄，跟着 tool-definitions 走。
import { DEFAULT_TOOL_DEFINITIONS } from '../../src/host/tool-definitions';
import { approvalClassOf } from '../../src/host/tool-registry';
import { startListenable } from './_host-port-guard';

/** 普通短字面量（不用令牌形串，避免写入通道把它替换成占位符）。 */
const TOKEN = 'seam-x';
const ORIGIN_PATH = '/v1/consent/pending';

/** `memory.purge` 的 approvalClass —— 值来自宿主真源 `approvalClassOf(def)`，不手抄。 */
const PURGE_DEF = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'memory.purge');
const PURGE_CLASS = PURGE_DEF ? approvalClassOf(PURGE_DEF) : undefined;

let activeServer: ApiServer | null = null;

afterEach(async () => {
  await activeServer?.stop();
  activeServer = null;
});

/** 一条待审批条目（字段集合＝宿主 `PendingConsentView` 的真实形状）。 */
function entry(over: Partial<PendingConsentEntry['view']> = {}): PendingConsentEntry {
  return {
    view: {
      callId: 'call-seam-1',
      tool: 'memory.purge',
      summary: '彻底删除一条记忆（id: mem-x）',
      riskReason: '高风险 · 不可恢复',
      mode: '完全放开',
      target: 'memory-id:mem-x',
      outside: false,
      allowedDecisions: ['allow-once', 'deny'],
      approvalClass: PURGE_CLASS,
      requestedAt: 1_700_000_000_000,
      ...over,
    },
    nonce: 'nonce-seam',
  };
}

async function startServer(entries: PendingConsentEntry[]): Promise<string> {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
  const server = await startListenable(() =>
    createApiServer({
      config,
      backend: createFakeOfficialBackend({ chunks: [chunk('deepseek-chat', 'hi')], models: ['deepseek-chat'] }),
      authenticator: createBearerAuthenticator(TOKEN),
      consentQueue: {
        pending: () => entries,
        reply: () => ({ ok: true, decision: 'allow-once' }),
      },
    }),
  );
  activeServer = server;
  return server.url;
}

async function fetchPending(base: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${ORIGIN_PATH}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}

type SeamBody = {
  ok?: unknown;
  pending?: unknown;
  request?: unknown;
};

/**
 * **接缝断言本体**（正控与负控共用同一枚，负控才有意义）。
 *
 * 判据分两侧，缺一侧即红：
 *   ① Rust 侧：`pending` 是扁平对象且含 `callId`／`nonce`；
 *   ② 窗口页侧：页面那一行取数式必须拿得到 `request`，且页面真正读取的字段非空。
 */
function assertSeam(body: SeamBody): void {
  expect(body.ok).toBe(true);
  // ① Rust 侧契约（不许被本次修复破掉）
  expect(body.pending).toBeTruthy();
  const pending = body.pending as Record<string, unknown>;
  expect(pending.callId).toBe('call-seam-1');
  expect(pending.nonce).toBe('nonce-seam');

  // ② 页面侧契约——**逐字复制页面那一行表达式**（`consent-panel.ts` 的 tick()）：
  //    const req = payload?.pending ? payload.request : undefined;
  const req = body.pending ? (body.request as Record<string, unknown> | null | undefined) : undefined;
  expect(req, '窗口页取数式必须拿到 request（否则永远渲染「暂无待审批请求」）').toBeTruthy();
  const r = req as Record<string, unknown>;

  expect(typeof r.tool).toBe('string');
  expect((r.tool as string).length).toBeGreaterThan(0);

  // 回执凭据必须与 Rust 侧那一份逐字相同（窗口页拿它 POST /v1/consent/reply）
  expect(r.nonce).toBe(pending.nonce);

  // 档位与目标必须显形（Chief 要的「原生窗必补项」）
  expect(typeof r.paramsSummary).toBe('string');
  expect((r.paramsSummary as string).length).toBeGreaterThan(0);
  expect(typeof r.modeLabel).toBe('string');
  expect((r.modeLabel as string).length).toBeGreaterThan(0);

  const meta = r.meta as Record<string, unknown>;
  expect(meta, 'meta 必须存在（缺它档位/目标一律不显）').toBeTruthy();
  expect(meta.canonicalTarget).toBe('memory-id:mem-x');
  expect(meta.outside).toBe(false);
  // 审批类必须与宿主真源逐字一致（不是"随便有个值"）
  expect(PURGE_CLASS, '宿主真源里 memory.purge 必须是 always 类（否则本文件的夹具失去意义）').toBe('always');
  expect(meta.approvalClass).toBe(PURGE_CLASS);
}

describe('接缝 · 真端点同时满足 Rust 侧与窗口页侧', () => {
  it('正控：真起 server + 真队列 + 真 fetch ⇒ 两份形状齐备', async () => {
    const base = await startServer([entry()]);
    const body = await fetchPending(base);
    assertSeam(body as SeamBody);
  });

  it('批准类透传：approvalClass 缺省时不得凭空编一个（页面按"无该类信息"渲染）', async () => {
    const base = await startServer([entry({ approvalClass: undefined })]);
    const body = (await fetchPending(base)) as SeamBody;
    const meta = (body.request as Record<string, unknown>).meta as Record<string, unknown>;
    expect(meta.approvalClass).toBeUndefined();
    // 其余字段仍必须齐（缺 approvalClass 只少一行分类标签，不等于接缝断了）
    expect(meta.canonicalTarget).toBe('memory-id:mem-x');
  });

  it('空队列：pending 与 request 都是 null，页面走「暂无待审批请求」而不是崩', async () => {
    const base = await startServer([]);
    const body = (await fetchPending(base)) as SeamBody;
    expect(body.pending).toBeNull();
    expect(body.request).toBeNull();
  });

  it('负控：去掉 request 键 ⇒ 同一枚接缝断言必须红（证明它真会证伪）', async () => {
    const base = await startServer([entry()]);
    const body = (await fetchPending(base)) as SeamBody;
    // 装置自检：原样必须先过，否则下面的"红"可能来自别处
    expect(() => assertSeam(body)).not.toThrow();

    // 退回到修复前的形态（只有扁平 pending）
    const legacy: SeamBody = { ok: body.ok, pending: body.pending };
    expect(() => assertSeam(legacy)).toThrow();
  });
});
