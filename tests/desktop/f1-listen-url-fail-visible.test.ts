// @vitest-environment node
/**
 * tests/desktop/f1-listen-url-fail-visible.test.ts —— F-1：**绑定后交出的 URL 必须是真的**
 * （2026-11-09，卡 F-1，写域 `src/api/server.ts`）。
 *
 * ── 缺口形状（闸里撞出来的，不是推演）──
 * #51 第一发闸红在 `c1p2-api-server-hardening.test.ts`，错是 `bad port`。定性四条：
 * ① 该文件不在 #51 覆盖集内、`git hash-object` 与 `HEAD:` 逐位同；
 * ② 闸后单跑两次均 `10 passed`；③ 62 枚历史闸日志里它首次红；
 * ④ #51 只改注释与一行拆分，与 HTTP 端口无因果链。
 * ⇒ 这是一枚**在高负载下才会现形的真隐患**，不是 flake：
 *   `server.ts` 原 `L1300` 把 `resolvedUrl` 初始化成 `http://${host}:${port}`，
 *   `port=0` 时它是一个**语法合法、实际不可用**的地址；listen 回调里
 *   `if (addr && typeof addr === 'object')` 才改写，**随后无条件 `resolve()`**
 *   ⇒ 那一刻拿不到 address 就把 `:0` 当可用 URL 交出去，调用方 `fetch` 立刻 `bad port`。
 *
 * 它违反**同一个文件** `L1312-1318` 自己写的原则：「本进程不自动换端口、绝不静默交出一个
 * 不存在的地址」——端口面 fail-visible 做了，URL 面 fail-silent 留着。
 *
 * ── 本文件判据 ──
 * ① 未 `start()` 时读 `url` **直接抛**，错误信息点明"尚未就绪"（不是给个 `:0`）；
 * ② `server.address()` 返回 `null`（负控桩）⇒ `start()` **reject**，且此后读 `url` 仍抛
 *    ——**绝不产出一个 `:0` 的 url**；
 * ③ 正常 start ⇒ `url` 是**真端口**（非 0）且能连上（正控，防"一律抛"混过去）。
 *
 * ③ 是必要的：只写 ①② 的话，一个"永远抛"的实现也能全绿。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApiServer, type ApiServer } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import type { ApiConfig } from '../../src/api/types';

const TOKEN = 'f1-token';

let active: ApiServer | null = null;

afterEach(async () => {
  try {
    await active?.stop();
  } catch {
    /* 未起或已停 */
  }
  active = null;
});

function mkServer(port = 0): ApiServer {
  const config: ApiConfig = { host: '127.0.0.1', port, token: TOKEN };
  const s = createApiServer({
    config,
    backend: createFakeOfficialBackend({ chunks: [chunk('deepseek-chat', 'Hi')], models: ['deepseek-chat'] }),
    authenticator: createBearerAuthenticator(TOKEN),
  });
  active = s;
  return s;
}

describe('F-1 ①：未就绪时读 url 必须抛，不许给出 :0', () => {
  it('start() 之前 read url ⇒ throw，错误信息含"尚未就绪"且不含可用地址', () => {
    const s = mkServer();
    let err: unknown;
    try {
      void s.url;
    } catch (e) {
      err = e;
    }
    expect(err, '未 start 就读 url 必须抛错').toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('尚未就绪');
    // 反向：错误信息里不得出现一个":0"形态的"可用地址"给调用方照抄
    expect(/http:\/\/[^\s]*:0\b/.test(msg), '错误信息不得给出 :0 的地址').toBe(false);
  });
});

describe('F-1 ②：address() 取不到端口 ⇒ start() reject，且不产出 :0', () => {
  it('打桩 address() 返回 null ⇒ start() 明确失败、url 仍抛', async () => {
    const s = mkServer();
    const raw = s.rawServer;
    const original = raw.address.bind(raw);
    // 负控桩：listen 回调里取不到端口（地址未就绪 / 运行时异常态）
    (raw as unknown as { address: () => null }).address = () => null;
    let startErr: unknown;
    try {
      await s.start();
    } catch (e) {
      startErr = e;
    } finally {
      (raw as unknown as { address: typeof original }).address = original;
    }

    expect(startErr, 'start() 必须 reject，不许 resolve 后交坏 URL').toBeInstanceOf(Error);
    const msg = (startErr as Error).message;
    expect(msg).toContain('未能取到端口');
    expect(msg).toContain('server.address()');

    // 核心判据：不许有一个 `:0` 的 url 漏给调用方
    let urlErr: unknown;
    try {
      void s.url;
    } catch (e) {
      urlErr = e;
    }
    expect(urlErr, 'start() 失败后 url 仍必须抛').toBeInstanceOf(Error);
  });
});

describe('F-1 ③：正常 start ⇒ url 是真端口且能连上（正控）', () => {
  it('start() 后 url 端口非 0，且该地址真的能响应', async () => {
    const s = mkServer(0);
    await s.start();
    const url = s.url;
    expect(url).not.toMatch(/:0$/);
    const port = Number(new URL(url).port);
    expect(port).toBeGreaterThan(0);
    // 与真实 socket 一致：address() 报的就是这个端口
    const addr = s.rawServer.address() as AddressInfo;
    expect(addr.port).toBe(port);
    // 真连一次（不只看字符串）
    const res = await fetch(`${url}/healthz`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBeLessThan(500);
  });
});
