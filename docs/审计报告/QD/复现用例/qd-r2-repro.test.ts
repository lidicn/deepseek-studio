/**
 * QD-R2 复现用例（2026-10-17，标的 = 今日修复链 6dc1812 / 59220b8 / dd59515 / 07896e6 / 71bef05 / 0686a26）
 *
 * 运行方式（vitest include 只认 tests/desktop 与 tests/e2e）：
 *   cp docs/审计报告/QD/复现用例/qd-r2-repro.test.ts tests/desktop/qd-r2-repro.test.ts
 *   npx vitest run tests/desktop/qd-r2-repro.test.ts
 *   rm tests/desktop/qd-r2-repro.test.ts
 *
 * 约定：每条 it() 断言「期望的正确行为」——红 = 缺陷复现，绿 = 证伪。
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPageRuntimeHub } from '../../src/host/page-runtime';
import { createFileStorageKvBackend } from '../../src/host/file-storage-backend';
import { evaluatePolicy } from '../../src/host/policy';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';

const TOKEN = 'qd-r2-token';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

/** 起一个只挂 page-runtime hub 的 http server，返回 { url, hub, server, close }。 */
async function startHub(): Promise<{
  url: string;
  hub: ReturnType<typeof createPageRuntimeHub>;
  close: () => Promise<void>;
  sockets: WebSocket[];
}> {
  const server: Server = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const hub = createPageRuntimeHub({ server, token: TOKEN });
  const sockets: WebSocket[] = [];
  return {
    url: `ws://127.0.0.1:${port}/studio`,
    hub,
    sockets,
    close: async () => {
      for (const s of sockets) { try { s.terminate(); } catch { /* ignore */ } }
      await Promise.race([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => setTimeout(r, 800)),
      ]);
    },
  };
}

/** 连接并等 hello-ack；reject 时返回原因。 */
function connect(url: string, bag: WebSocket[]): Promise<{ ws: WebSocket; opened: boolean; ack: unknown; closed: number | null; err: string | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    bag.push(ws);
    let ack: unknown = null;
    let settled = false;
    const finish = (opened: boolean, err: string | null, closed: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened, ack, closed, err });
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello' }));
      setTimeout(() => finish(true, null, null), 200);
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'hello-ack') ack = msg;
      } catch { /* ignore */ }
    });
    ws.on('error', (e: Error) => finish(false, e.message, null));
    ws.on('close', (code: number) => finish(false, null, code));
    setTimeout(() => finish(false, 'timeout', null), 1500);
  });
}

describe('QD-R2-01 P0-2 WS 鉴权只落服务端，页端客户端不带 token', () => {
  it('A. 闸门确实生效：不带 token 的 /studio 连接拿不到 hello-ack', async () => {
    const h = await startHub();
    const noToken = await connect(h.url, h.sockets);
    const withToken = await connect(`${h.url}?token=${TOKEN}`, h.sockets);
    await h.close();
    // 期望：带 token 能握手，不带 token 被拒
    expect(withToken.ack).not.toBeNull();
    expect(noToken.ack).toBeNull();
  });

  it('B. 出厂包里的页端连接 URL 必须自带 token（否则真实页面永远连不上 /studio）', () => {
    const bundle = readFileSync(path.join(repoRoot(), 'src-tauri/inject/entry.js'), 'utf8');
    const m = bundle.match(/var DEFAULT_HOST_URL = "([^"]+)"/);
    expect(m).not.toBeNull();
    const url = m![1];
    const clientSrc = readFileSync(path.join(repoRoot(), 'src/desktop/host-client.ts'), 'utf8');
    const appendsToken = /token=/.test(url) || /searchParams\.set\(['"]token['"]/.test(clientSrc);
    expect(appendsToken).toBe(true);
  });
});

describe('QD-R2-02 P0-4 写链：一次失败后，下一批写被静默丢弃且调用方看到成功', () => {
  it('两次 writeBatch 都要么落盘要么抛错（当前实现：第一次抛、第二次静默成功）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qd-r2-'));
    const filePath = path.join(dir, 'storage.json');
    mkdirSync(filePath); // 用「同名目录」制造必然失败的 rename
    const backend = createFileStorageKvBackend({ filePath });
    const outcomes: string[] = [];
    for (const key of ['k1', 'k2']) {
      try {
        await backend.writeBatch({ set: { [key]: 'v' }, remove: [] });
        outcomes.push(`${key}: resolved`);
      } catch (e) {
        outcomes.push(`${key}: threw ${(e as Error).message}`);
      }
    }
    const readBack = await backend.readAll();
    rmSync(dir, { recursive: true, force: true });
    // 期望：静默成功不可接受——要么数据在盘上，要么两次都抛错
    const silentSuccess = outcomes[1] === 'k2: resolved' && Object.keys(readBack).length === 0;
    expect(silentSuccess, `实测 ${JSON.stringify({ outcomes, readBack })}`).toBe(false);
  });
});

describe('QD-R2-04 R4-P0-1 把 mcp.test 纳入 PROCESS_TOOLS 后，工具在任何档位永久拒绝', () => {
  it('full 档下 mcp.test（参数嵌在 config 里，与执行侧读取的字段一致）应放行', () => {
    const v = evaluatePolicy({
      tool: 'mcp.test',
      params: { config: { command: 'npx', args: ['-y', 'some-mcp'] } },
      mode: 'full',
      workspace: null,
    });
    // 执行侧 desktop-host.ts:427-436 只从 params.config 取 command，
    // 策略侧 policy.ts:156-164 只看顶层 command|cmd|argv ⇒ 结构错配。
    expect(v.decision, `实测 ${JSON.stringify(v)}`).not.toBe('deny');
  });

  it('对照：顶层 command 形状能通过（证明错配在参数形状而非档位）', () => {
    const v = evaluatePolicy({ tool: 'mcp.test', params: { command: 'npx' }, mode: 'full', workspace: null });
    expect(v.decision, `实测 ${JSON.stringify(v)}`).toBe('allow');
  });
});

describe('QD-R2-03 页端闸门：consent/result 结算不校验连接身份状态', () => {
  it('A. 被 integrity-alert 判为篡改的页，其伪造 result 不得被结算', async () => {
    const h = await startHub();
    const c = await connect(`${h.url}?token=${TOKEN}`, h.sockets);
    expect(c.ack).not.toBeNull();
    const dispatchPromise = h.hub.dispatch('file.read', { path: 'a.txt' }, 'call-1');
    await new Promise((r) => setTimeout(r, 100));
    c.ws.send(JSON.stringify({ type: 'integrity-alert', reason: 'qd-r2-probe' }));
    await new Promise((r) => setTimeout(r, 50));
    c.ws.send(JSON.stringify({ type: 'result', callId: 'call-1', ok: true, data: 'FORGED' }));
    const res = await dispatchPromise;
    await h.close();
    // 期望：fail-closed（篡改页的回报不被采信）
    expect(res.ok, `实测 ${JSON.stringify(res)}`).toBe(false);
  });

  it('B. 未做 Origin 自证的连接不得被当作可信页并允许其回 consent-decision', async () => {
    const h = await startHub();
    const c = await connect(`${h.url}?token=${TOKEN}`, h.sockets);
    expect(c.ack, '对照组：带 token 连接须已完成 hello 握手，否则本腿的 deny 是假绿').not.toBeNull();
    const consentPromise = h.hub.requestConsent('call-2', 'shell.exec', { command: 'del /q C:\\*' });
    await new Promise((r) => setTimeout(r, 100));
    c.ws.send(JSON.stringify({ type: 'consent-decision', callId: 'call-2', decision: 'allow-session' }));
    const decision = await consentPromise;
    await h.close();
    // 期望：hello 未携带可核验 origin 的连接无权代表用户放行
    expect(decision, `实测 ${decision}`).not.toBe('allow-session');
  });
});

describe('QD-R2-06 streaming-tool-parser「next === :」修复的实测行为表', () => {
  it('打印各形状 mangled body 的修复结果（观察腿，不主张缺陷）', () => {
    const cases: Array<{ name: string; intent: string; body: string }> = [
      { name: '键名结束引号（6dc1812 目标）', intent: 'echo a', body: `{"command":"echo a"}` },
      { name: '值内裸引号+冒号', intent: 'echo "a": 1', body: `{"command":"echo "a": 1"}` },
      { name: '两键，值内裸引号+冒号', intent: 'grep "x": y', body: `{"command":"grep "x": y","cwd":"."}` },
      { name: '嵌套对象值引号', intent: '{"p":"a"b"}', body: `{"params":{"p":"a"b"}}` },
    ];
    const table = cases.map((cs) => {
      const p = new StreamingToolCallParser(['shell_exec']);
      const r = p.feed(`<shell_exec>${cs.body}</shell_exec>`);
      const call = r.calls[0];
      return { name: cs.name, intent: cs.intent, params: call?.params, invalid: call?.params.__invalid_json === true };
    });
    console.log('QD-R2-06 parser 行为表:', JSON.stringify(table, null, 2));
    expect(table).toHaveLength(4);
  });
});
