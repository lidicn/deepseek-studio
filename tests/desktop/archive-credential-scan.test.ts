/**
 * 卡㉕ 验收测试（2026-11-16）：档案面凭证形串「按型计数」——零行为改动。
 *
 * 契约（Studio-PM 卡㉕ 定字）：
 *   - 宿主 flush KV 批次时，对**本批 set 的值**按型计数，命中 ≥1 落一行
 *     `archive credential-shaped hits: bearer=N sk=N`（宿主日志族 `console.warn('[kv] …')`）。
 *   - **正控**：构造载荷必须断到**非零**值——恒 0 的计数器看起来一样绿，不算锁（⑫ 甲口径）。
 *   - **负控 1（边界）**：`task-…`／`risk-…`／`disk-…` 这类词内假阳性不计入
 *     （2026-11-16 卡㉔ 复核时 `sk-` 裸模式 over-match 制造过一整轮误报）。
 *   - **负控 2（不落行）**：载荷无凭证形 ⇒ 整行不落。
 *   - **反计数陷阱回归**：只数本批 set，不数合并后的整对象。若有人改成数 `current`，
 *     「第二轮只写普通值」也会再报一次 —— 下面第 3 枚集成用例正是抓这个。
 *
 * 夹具是合成串（`'a1B2'.repeat(6)`，24 字符低熵重复），不是真凭据。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDesktopHost } from '../../src/host/desktop-host';
import {
  CREDENTIAL_SHAPE_PATTERNS,
  countCredentialShapesInKvSet,
  countCredentialShapesInText,
  formatCredentialShapeHits,
  hasCredentialShapeHit,
} from '../../src/host/archive-credential-scan';

/** 合成键体：24 字符、[A-Za-z0-9]、低熵重复（≥16 门槛足够，且不像真凭据）。 */
const BODY = 'a1B2'.repeat(6);
const BEARER_FIXTURE = `Authorization: Bearer ${BODY}`;
const SK_FIXTURE = `api key sk-${BODY}`;
const HIT_LINE = 'archive credential-shaped hits: bearer=1 sk=1';

const tmpRoot = path.join(os.tmpdir(), `studio-card25-${Date.now()}`);

const hosts: Array<{ stop: () => Promise<void> }> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  for (const host of hosts.splice(0)) {
    try {
      await host.stop();
    } catch {
      /* ignore */
    }
  }
  vi.restoreAllMocks();
});

function storageFile(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'storage.json');
}

async function startHost(name: string, warnings: string[]): Promise<{ port: number; file: string }> {
  const file = storageFile(name);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  });
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    storageFilePath: file,
  });
  hosts.push(host);
  await host.start();
  return { port: Number(new URL(host.url).port), file };
}

function connectPage(port: number): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    sockets.push(ws);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
      resolve(ws);
    });
  });
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe('卡㉕：凭证形串按型计数（纯函数面）', () => {
  it('正控：合成载荷必须断到非零值 bearer=1 sk=1', () => {
    const counts = countCredentialShapesInText(`${BEARER_FIXTURE}\n${SK_FIXTURE}`);
    expect(counts).toEqual({ bearer: 1, sk: 1 });
    expect(hasCredentialShapeHit(counts)).toBe(true);
    expect(formatCredentialShapeHits(counts)).toBe(HIT_LINE);
  });

  it('负控（边界）：task-／risk-／disk- 这类词内形态不计入', () => {
    for (const word of ['task', 'risk', 'disk', 'monosk']) {
      const counts = countCredentialShapesInText(`${word}-${BODY}`);
      expect(counts.sk, `${word}-… 不该计入`).toBe(0);
    }
    expect(countCredentialShapesInText('no credential shapes here').sk).toBe(0);
  });

  it('负控（长度门槛）：键体不足 16 字符不计入', () => {
    const short = BODY.slice(0, 15);
    expect(countCredentialShapesInText(`sk-${short}`).sk).toBe(0);
    expect(countCredentialShapesInText(`Bearer ${short}`).bearer).toBe(0);
  });

  it('前界写死：两个模式都必须是「前字符非 [A-Za-z0-9]」', () => {
    // 防后人「简化」掉前界——卡㉔ 那轮 over-match 的直接原因就在这里。
    expect(CREDENTIAL_SHAPE_PATTERNS.sk.source.startsWith('(?<![A-Za-z0-9])')).toBe(true);
    expect(CREDENTIAL_SHAPE_PATTERNS.bearer.source.startsWith('(?<![A-Za-z0-9])')).toBe(true);
  });

  it('值面扫描：字符串与嵌套对象/数组都扫（只扫字符串会漏掉事件流）', () => {
    const counts = countCredentialShapesInKvSet({
      plain: 'hello',
      nested: [{ type: 'final-answer', text: SK_FIXTURE }],
      number: 42,
      serialized: { header: BEARER_FIXTURE },
    });
    expect(counts).toEqual({ bearer: 1, sk: 1 });
  });

  it('不可序列化值不抛错，也不影响同批其它值的计数', () => {
    const cyclic: Record<string, unknown> = { name: 'cyclic' };
    cyclic.self = cyclic;
    const counts = countCredentialShapesInKvSet({ bad: cyclic, good: SK_FIXTURE });
    expect(counts).toEqual({ bearer: 0, sk: 1 });
  });

  it('零命中时 hasCredentialShapeHit 为假（整行不落的判据）', () => {
    expect(hasCredentialShapeHit({ bearer: 0, sk: 0 })).toBe(false);
    expect(hasCredentialShapeHit({ bearer: 0, sk: 1 })).toBe(true);
  });
});

describe('卡㉕：宿主落盘路径接线（正控/负控各一枚 + 反计数陷阱回归）', () => {
  it('正控：页端写入含凭证形的值 ⇒ 落盘后出一行 bearer=1 sk=1', async () => {
    const warnings: string[] = [];
    const { port, file } = await startHost('wiring-hit', warnings);
    const ws = await connectPage(port);
    await new Promise((r) => setTimeout(r, 200));

    ws.send(JSON.stringify({
      type: 'kv-set',
      requestId: 'h1',
      key: 'session-events',
      value: `${BEARER_FIXTURE}\n${SK_FIXTURE}`,
    }));

    // 落盘（防抖 100ms）后应当出现诊断行。
    const landed = await waitFor(() => warnings.includes(HIT_LINE));
    expect(landed, `日志里未见 ${HIT_LINE}，实收：${JSON.stringify(warnings)}`).toBe(true);
    // 且内容真的落进档案（计数说的是「已落进档案」的东西）。
    expect(fs.readFileSync(file, 'utf8')).toContain('session-events');
  });

  it('负控：页端写入无凭证形的值 ⇒ 整行不落', async () => {
    const warnings: string[] = [];
    const { port, file } = await startHost('wiring-clean', warnings);
    const ws = await connectPage(port);
    await new Promise((r) => setTimeout(r, 200));

    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'c1', key: 'plain', value: 'just some text' }));
    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'c2', key: 'taskish', value: `task-${BODY}` }));

    const flushed = await waitFor(() => {
      try {
        return fs.readFileSync(file, 'utf8').includes('taskish');
      } catch {
        return false;
      }
    });
    expect(flushed, '两枚写入应已落盘').toBe(true);
    expect(warnings.filter((w) => w.startsWith('archive credential-shaped hits:'))).toEqual([]);
  });

  it('反计数陷阱回归：第二轮只写普通值，不得把第一轮的历史命中再报一次', async () => {
    const warnings: string[] = [];
    const { port, file } = await startHost('wiring-recount', warnings);
    const ws = await connectPage(port);
    await new Promise((r) => setTimeout(r, 200));

    // 第一轮：含命中。
    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'r1', key: 'k1', value: SK_FIXTURE }));
    expect(await waitFor(() => warnings.includes('archive credential-shaped hits: bearer=0 sk=1'))).toBe(true);

    // 第二轮：只写普通值（另一个批次、另一个 flush 窗口）。
    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'r2', key: 'k2', value: 'plain value' }));
    const secondLanded = await waitFor(() => {
      try {
        return fs.readFileSync(file, 'utf8').includes('k2');
      } catch {
        return false;
      }
    });
    expect(secondLanded, '第二轮应已落盘').toBe(true);
    // 再等一个防抖窗口，确认没有第二次诊断行（数 current 的实现在这里会变成 2）。
    await new Promise((r) => setTimeout(r, 300));

    const lines = warnings.filter((w) => w.startsWith('archive credential-shaped hits:'));
    expect(lines, `应恰有一次诊断行，实收：${JSON.stringify(lines)}`).toEqual([
      'archive credential-shaped hits: bearer=0 sk=1',
    ]);
  });
});
