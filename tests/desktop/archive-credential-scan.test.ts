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
 *   - **卡㉛ 键名面**：同一模块加键名面计数，两行分列（`…hits:` 与 `…keys:`）、**不得合并**；
 *     键名面与值面同源（复制 ㉕ 模式表的 `source`），正控／边界负控／反计数陷阱同样成套。
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
  CREDENTIAL_KEY_PATTERNS,
  CREDENTIAL_SHAPE_PATTERNS,
  countCredentialShapeKeysInKvSet,
  countCredentialShapeKeysInText,
  countCredentialShapesInKvSet,
  countCredentialShapesInText,
  formatCredentialKeyHits,
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

describe('卡㉛：键名面凭证形计数（纯函数面）', () => {
  it('键名面与值面同源：两条模式的 source 逐字相同，且都带非字母数字前界', () => {
    for (const kind of ['bearer', 'sk'] as const) {
      expect(CREDENTIAL_KEY_PATTERNS[kind].source).toBe(CREDENTIAL_SHAPE_PATTERNS[kind].source);
      expect(CREDENTIAL_KEY_PATTERNS[kind].source.startsWith('(?<![A-Za-z0-9])')).toBe(true);
    }
    // 复制 source 前界口径＝结构上复用；两个面必须是**不同实例**（g 标志自带 lastIndex 状态）。
    expect(CREDENTIAL_KEY_PATTERNS.sk).not.toBe(CREDENTIAL_SHAPE_PATTERNS.sk);
  });

  it('正控：键名含凭证形的键必须断到非零值', () => {
    expect(countCredentialShapeKeysInText(`Bearer ${BODY}`)).toEqual({ bearer: 1, sk: 0 });
    expect(countCredentialShapeKeysInText(`sk-${BODY}`)).toEqual({ bearer: 0, sk: 1 });
    expect(formatCredentialKeyHits({ bearer: 0, sk: 1 })).toBe('archive credential-shaped keys: bearer=0 sk=1');
  });

  it('负控（边界）：键名里的 task-／risk-／disk- 词内形态不计入', () => {
    for (const word of ['task', 'risk', 'disk', 'monosk']) {
      expect(countCredentialShapeKeysInText(`${word}-${BODY}`).sk, `${word}-… 不该计入`).toBe(0);
    }
  });

  it('两个面互不串门：键名命中不算进值面，反之亦然', () => {
    const keyShapedOnly = { [`sk-${BODY}`]: 'plain value' };
    expect(countCredentialShapeKeysInKvSet(keyShapedOnly)).toEqual({ bearer: 0, sk: 1 });
    expect(countCredentialShapesInKvSet(keyShapedOnly)).toEqual({ bearer: 0, sk: 0 });

    const valueShapedOnly = { 'plain-key': SK_FIXTURE };
    expect(countCredentialShapeKeysInKvSet(valueShapedOnly)).toEqual({ bearer: 0, sk: 0 });
    expect(countCredentialShapesInKvSet(valueShapedOnly)).toEqual({ bearer: 0, sk: 1 });
  });

  it('键名面只数本批键名：空批次与普通键名均为零', () => {
    expect(countCredentialShapeKeysInKvSet({})).toEqual({ bearer: 0, sk: 0 });
    expect(countCredentialShapeKeysInKvSet({ 'studio:session:1': 1, plain: 2 })).toEqual({
      bearer: 0,
      sk: 0,
    });
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

  it('卡㉛ 正控：键名含凭证形 ⇒ 出键名面行；值面 0 命中 ⇒ 值面行不落', async () => {
    const warnings: string[] = [];
    const { port, file } = await startHost('key-hit', warnings);
    const ws = await connectPage(port);
    await new Promise((r) => setTimeout(r, 200));

    ws.send(JSON.stringify({
      type: 'kv-set',
      requestId: 'k1',
      key: `sk-${BODY}`,
      value: 'plain value',
    }));

    const landed = await waitFor(() => warnings.includes('archive credential-shaped keys: bearer=0 sk=1'));
    expect(landed, `日志里未见键名面行，实收：${JSON.stringify(warnings)}`).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('plain value');
    // 值面无命中 ⇒ 那行不许出现（两个面互不代偿）。
    expect(warnings.filter((w) => w.startsWith('archive credential-shaped hits:'))).toEqual([]);
  });

  it('卡㉛ 负控：普通键名 ⇒ 键名面整行不落', async () => {
    const warnings: string[] = [];
    const { port, file } = await startHost('key-clean', warnings);
    const ws = await connectPage(port);
    await new Promise((r) => setTimeout(r, 200));

    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'n1', key: 'studio:plain', value: 'plain' }));
    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'n2', key: `task-${BODY}`, value: 'plain' }));

    const flushed = await waitFor(() => {
      try {
        return fs.readFileSync(file, 'utf8').includes('studio:plain');
      } catch {
        return false;
      }
    });
    expect(flushed, '两枚写入应已落盘').toBe(true);
    expect(warnings.filter((w) => w.startsWith('archive credential-shaped keys:'))).toEqual([]);
  });

  it('卡㉛ 分列：同一批次键名与值各命中 ⇒ 两行各报各的，不合并', async () => {
    const warnings: string[] = [];
    const { port } = await startHost('key-split', warnings);
    const ws = await connectPage(port);
    await new Promise((r) => setTimeout(r, 200));

    ws.send(JSON.stringify({
      type: 'kv-set',
      requestId: 's1',
      key: `sk-${BODY}`,
      value: BEARER_FIXTURE,
    }));

    const split = await waitFor(() => warnings.includes('archive credential-shaped keys: bearer=0 sk=1')
      && warnings.includes('archive credential-shaped hits: bearer=1 sk=0'));
    expect(split, `两行应分列且各报各数，实收：${JSON.stringify(warnings)}`).toBe(true);
    // 任何一行都不许出现合并后的数（1／1 或 0／2 之类）。
    expect(warnings.some((w) => w.includes('bearer=1 sk=1'))).toBe(false);
  });

  it('卡㉛ 反计数陷阱回归：键名面第二轮只写普通键，不得把第一轮历史命中再报一次', async () => {
    const warnings: string[] = [];
    const { port, file } = await startHost('key-recount', warnings);
    const ws = await connectPage(port);
    await new Promise((r) => setTimeout(r, 200));

    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'q1', key: `sk-${BODY}`, value: 'plain' }));
    expect(await waitFor(() => warnings.includes('archive credential-shaped keys: bearer=0 sk=1'))).toBe(true);

    ws.send(JSON.stringify({ type: 'kv-set', requestId: 'q2', key: 'plain-second', value: 'plain' }));
    const secondLanded = await waitFor(() => {
      try {
        return fs.readFileSync(file, 'utf8').includes('plain-second');
      } catch {
        return false;
      }
    });
    expect(secondLanded, '第二轮应已落盘').toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    const lines = warnings.filter((w) => w.startsWith('archive credential-shaped keys:'));
    expect(lines, `键名面应恰有一次诊断行，实收：${JSON.stringify(lines)}`).toEqual([
      'archive credential-shaped keys: bearer=0 sk=1',
    ]);
  });
});
