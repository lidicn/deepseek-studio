/**
 * 卡 ㊿-b ②：search_files 慢检索治理（宿主侧）。
 *
 * 现场（装版 storage.json，turn 4922ceac）：
 *   ① `root` 传文件（af_service.py）→ 宿主回裸 `invalid-argument`，模型靠试错学工具契约；
 *   ② `grep` 大目录（E:/NAS/AutoForge）无任何遍历预算 → 75,002 ms 才被页端 75s 截断；
 *   ③ 页端超时后宿主侧遍历继续跑 ⇒ 孤儿遍历（用户看到 host-timeout，机器还在读盘）。
 *
 * 三格分别对应本文件的三个 describe：
 *   - root 必须为目录（可操作错误：content 里写明 local_file_read / 父目录+glob 两条出路）
 *   - 遍历预算（深度/条目/文件数/耗时，truncatedReason 披露 + hint）
 *   - 取消链（tool-cancel → 宿主 AbortController → 能力层 cancelled，不再跑完）
 */

import { describe, expect, it, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { grepFiles, listFiles } from '../../src/capabilities/search-files';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import { WebSocket } from 'ws';

const roots: string[] = [];
const running: DesktopHost[] = [];

afterEach(async () => {
  while (running.length) {
    const h = running.pop();
    try { await h?.stop(); } catch { /* 已停 */ }
  }
});

function mkRootSync(): string {
  // fsp.mkdtemp 是异步的；这里用同步版保持用例体内简洁。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('node:fs') as typeof import('node:fs');
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sf-b50b-'));
  roots.push(root);
  return root;
}

/** 深度 15 层、每层 1 文件的窄深树（测 maxDepth 用）。 */
function makeDeepTree(depth: number): string {
  const root = mkRootSync();
  let cur = root;
  for (let i = 0; i < depth; i++) {
    cur = path.join(cur, `d${i}`);
    fsSyncMkdir(cur);
    fsSyncWrite(path.join(cur, 'f.txt'), 'hello\n');
  }
  return root;
}

let fsSyncMkdir: (p: string) => void;
let fsSyncWrite: (p: string, data: string) => void;
// 顶层初始化同步辅助（require 已在上面用过一次；这里直接拿句柄）
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('node:fs') as typeof import('node:fs');
  fsSyncMkdir = (p) => fsSync.mkdirSync(p, { recursive: true });
  fsSyncWrite = (p, data) => fsSync.writeFileSync(p, data);
}

describe('㊿-b② root 必须为目录（可操作错误）', () => {
  it('root 传文件 → invalid-argument + content 写明 local_file_read / 父目录两条出路', async () => {
    const root = mkRootSync();
    const file = path.join(root, 'af_service.py');
    fsSyncWrite(file, 'x = 1\n');

    const res = await grepFiles({ root: file, query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
    const text = res.content?.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    expect(text).toContain('local_file_read');
    expect(text).toContain(path.dirname(file));
    const details = res.details as { reason?: string; kind?: string; parent?: string };
    expect(details.reason).toBe('root-not-directory');
    expect(details.kind).toBe('file');
    expect(details.parent).toBe(path.dirname(file));
  });

  it('宿主接线同口径：invokeTool({root: 文件}) 也能拿到可操作文案', async () => {
    const tmp = mkRootSync();
    const file = path.join(tmp, 'a.py');
    fsSyncWrite(file, 'x = 1\n');
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(tmp),
      policyMode: 'auto',
    });
    await host.start();
    running.push(host);
    const res = await host.invokeTool('search_files', { operation: 'grep', root: file, query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid-argument');
    const text = res.content?.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    expect(text).toContain('local_file_read');
  });

  it('root 是正常目录 → 不受影响（防误伤）', async () => {
    const root = mkRootSync();
    fsSyncWrite(path.join(root, 'a.txt'), 'hello\n');
    const res = await grepFiles({ root, query: 'hello' });
    expect(res.ok).toBe(true);
  });
});

describe('㊿-b② 遍历预算', () => {
  it('深度超 maxDepth → depthLimited，结果披露 truncatedReason=max-depth', async () => {
    const root = makeDeepTree(10);
    const res = await listFiles({ root, limits: { maxDepth: 3 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; hint?: string; entries: Array<{ path: string }> };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('max-depth');
    expect(data.hint).toContain('root');
    // 第 4 层以下不可见
    expect(data.entries.some((e) => e.path.split('/').length > 3)).toBe(false);
  });

  it('条目超 maxEntries → 停止遍历，truncatedReason=max-entries', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 10; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const res = await listFiles({ root, limits: { maxEntries: 4 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; total: number; scanned: { entries: number } };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('max-entries');
    expect(data.total).toBeLessThanOrEqual(4);
    expect(data.scanned.entries).toBeLessThanOrEqual(5);
  });

  it('grep 读文件数超 maxFiles → truncatedReason=max-files', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 8; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'needle\n');
    const res = await grepFiles({ root, query: 'needle', limits: { maxFiles: 3 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; matches: unknown[]; scanned: { files: number } };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('max-files');
    expect(data.scanned.files).toBeLessThanOrEqual(4);
  });

  it('timeBudgetMs 压到 0 后的下一枚即停 → truncatedReason=time-budget（不跑完整棵树）', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 200; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const res = await listFiles({ root, limits: { timeBudgetMs: 1 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('time-budget');
  });

  it('不超预算 → truncated=false，无 truncatedReason', async () => {
    const root = mkRootSync();
    fsSyncWrite(path.join(root, 'a.txt'), 'hello\n');
    const res = await listFiles({ root });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string };
    expect(data.truncated).toBe(false);
    expect(data.truncatedReason).toBeUndefined();
  });

  it('命中条数上限（limit）→ truncatedReason=limit（既有行为保留，但披露原因）', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 10; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const res = await listFiles({ root, limit: 3 });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; total: number };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('limit');
    expect(data.total).toBe(3);
  });
});

describe('㊿-b② 取消链（孤儿遍历治理）', () => {
  it('能力层：signal 已 abort → 立即返回 cancelled（不产出结果）', async () => {
    const root = mkRootSync();
    fsSyncWrite(path.join(root, 'a.txt'), 'hello\n');
    const ac = new AbortController();
    ac.abort();
    const res = await grepFiles({ root, query: 'hello', signal: ac.signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cancelled');
    expect(res.details).toMatchObject({ reason: 'cancelled' });
  });

  it('能力层：遍历中途 abort → 尽快收口为 cancelled（可证伪：时限 < 全树扫描）', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 4000; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const ac = new AbortController();
    // 20ms 后撤销（模拟页端中途超时）；全树 4000 文件顺序读远超这个时限。
    const t = setTimeout(() => ac.abort(), 20);
    const started = Date.now();
    const res = await grepFiles({ root, query: 'zzz-no-hit-anywhere', signal: ac.signal });
    clearTimeout(t);
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cancelled');
    // 可证伪边界：中途收口应在秒级完成；若实现退化成"扫完整棵树才检查"，
    // 4000 文件的读取会让 elapsed 超出这条线（本机全扫实测秒级以上）。
    expect(elapsed).toBeLessThan(5000);
  });

  /**
   * 卡 ㊿-b-补2（CI run 44679065554 竞态）：原用例时序假设「50ms 后 cancel 必在途」
   * 在 CI 快机器上不成立（400 文件遍历秒级完成 ⇒ cancel 落在完成之后 ⇒ 收到 ok:true）。
   * 拆成**两格可证伪**：
   *   格① 执行确定在途（遍历中途）cancel ⇒ 回 `cancelled`（真取消）；
   *   格② 执行已完成后 cancel ⇒ 先收到**正常回执（原样，未被改写）**、再**追加**一枚
   *       `cancelled-late`（非静默吞、非追改）。
   */
  function openPageWs(port: number, sessionId: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId }));
      });
      ws.on('message', function onMsg(raw: unknown) {
        const buf = Array.isArray(raw) ? (raw[0] as unknown) : raw;
        const m = JSON.parse(String((buf as { data?: string }).data ?? buf)) as { type: string };
        if (m.type === 'hello-ack') {
          ws.off('message', onMsg);
          resolve(ws);
        }
      });
      ws.on('error', reject);
    });
  }

  /** 收集该 callId 的所有回执（tool-call-result 可能不止一枚：正常回执＋late 告知）。 */
  function collectReplies(ws: WebSocket, callId: string): Array<Record<string, unknown>> {
    const replies: Array<Record<string, unknown>> = [];
    ws.on('message', (raw: unknown) => {
      const buf = Array.isArray(raw) ? (raw[0] as unknown) : raw;
      const m = JSON.parse(String((buf as { data?: string }).data ?? buf)) as Record<string, unknown>;
      if (m.type === 'tool-call-result' && m.callId === callId) replies.push(m);
    });
    return replies;
  }

  /**
   * 格①（卡 ㊿-b-补3 重铸）：**机器速度无关**的在途取消。
   *
   * 旧构造「1500 个小文件＋30ms 后 cancel」是环境假设——CI 快机器上遍历先完成，
   * cancel 落在完成态 ⇒ 收到 ok:true（CI run 44690083980 红点）。重铸为**受控闸**：
   *   - 覆盖 hostTools 注入"真 search_files ＋ onEntryAwait 闸"（闸在测试手里）；
   *   - 先断言「闸已被触达」（= 遍历确在途，机器速度无关的事实）；
   *   - 再发 cancel ⇒ 放闸 ⇒ 遍历在下一个 abort 检查点停下 ⇒ 回 `cancelled`。
   * 快慢机器行为同构：CI 上同样先停在闸上，不存在"跑完"的时间窗。
   */
  it('格① 在途 cancel ⇒ 回执 error=cancelled（受控闸，机器速度无关）', async () => {
    const tmp = mkRootSync();
    fsSyncWrite(path.join(tmp, 'a.txt'), 'hello\n');
    fsSyncWrite(path.join(tmp, 'b.txt'), 'hello\n');

    // 闸：第一个条目触达后停住，测试放行。
    let entriesSeen = 0;
    let releaseGate!: () => void;
    const gateReached = new Promise<void>((resolve) => { releaseGate = () => resolve(); });
    const releaseRef = { current: (): void => releaseGate() };
    const gate = async (): Promise<void> => {
      entriesSeen += 1;
      releaseRef.current();
      await gateReached;
    };

    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(tmp),
      policyMode: 'auto',
      hostTools: {
        search_files: {
          id: 'search_files',
          async execute(params: Record<string, unknown>, ctx) {
            return listFiles({
              root: typeof params.root === 'string' ? params.root : tmp,
              // 三态语义：不传 workspace（undefined）＝不施加工作区约束（测试注入路径）。
              limit: typeof params.limit === 'number' ? params.limit : undefined,
              ...(ctx?.signal ? { signal: ctx.signal } : {}),
              limits: { onEntryAwait: gate },
            });
          },
        },
      },
    });
    await host.start();
    running.push(host);
    const port = Number(new URL(host.url).port);
    const ws = await openPageWs(port, 'p-cancel-live');
    const callId = 'cancel-live-1';
    const replies = collectReplies(ws, callId);

    ws.send(JSON.stringify({ type: 'tool-call', callId, invocationName: 'search_files', params: { operation: 'list' } }));
    // **在途确认**（判据本体，不是时间差）：闸被触达 ⇒ 遍历已在 walk 的产出循环里。
    const arrived = await Promise.race([
      gateReached.then(() => 'gate' as const),
      new Promise((r) => setTimeout(() => r('never' as const), 3000)),
    ]);
    expect(arrived, '遍历必须触达闸（= 在途），未触达说明注入面没生效').toBe('gate');
    expect(entriesSeen).toBeGreaterThanOrEqual(1);

    // 在途事实坐实后再撤：abort 置位 ⇒ 放闸 ⇒ 下一检查点停下 ⇒ cancelled。
    ws.send(JSON.stringify({ type: 'tool-cancel', callId, reason: 'page-timeout' }));
    releaseGate();
    await new Promise((r) => setTimeout(r, 600));
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error).toBe('cancelled');
    ws.close();
  });

  it('格② 完成后 cancel ⇒ 原回执不被改写（ok:true 仍在）＋追加 cancelled-late', async () => {
    const tmp = mkRootSync();
    fsSyncWrite(path.join(tmp, 'a.txt'), 'hello\n');
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(tmp),
      policyMode: 'auto',
    });
    await host.start();
    running.push(host);
    const port = Number(new URL(host.url).port);
    const ws = await openPageWs(port, 'p-cancel-late');
    const callId = 'cancel-late-1';
    const replies = collectReplies(ws, callId);
    ws.send(JSON.stringify({ type: 'tool-call', callId, invocationName: 'search_files', params: { operation: 'list' } }));
    // 等正常回执落地（小目录秒回，无竞态歧义）。
    await new Promise((r) => setTimeout(r, 1500));
    ws.send(JSON.stringify({ type: 'tool-cancel', callId, reason: 'page-timeout' }));
    await new Promise((r) => setTimeout(r, 600));
    const normal = replies.filter((r) => r.error !== 'cancelled-late');
    const late = replies.filter((r) => r.error === 'cancelled-late');
    expect(normal.length, '原回执必须已发出且未被改写').toBe(1);
    expect(normal[0].ok).toBe(true);
    expect(late.length, '晚到的撤销必须得到追加告知，不许静默').toBe(1);
    expect(late[0].ok).toBe(false);
    // 可证伪边界：完成表命中的 late 必须带"已执行完成"正文——
    // 这条把「登记生效」与「未知 callId 的裸 late」区分开（后者无正文）。
    // 若把登记改成 if(false)，cancel 会落未知分支回裸 late ⇒ 此断言必红。
    const lateText = Array.isArray(late[0].content)
      ? (late[0].content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('')
      : '';
    expect(lateText).toContain('已执行完成');
    ws.close();
  });

  it('格②-负态：未知 callId 的同连接 cancel ⇒ 裸 cancelled-late（非静默）', async () => {
    const tmp = mkRootSync();
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(tmp),
      policyMode: 'auto',
    });
    await host.start();
    running.push(host);
    const port = Number(new URL(host.url).port);
    const ws = await openPageWs(port, 'p-cancel-unknown');
    const callId = 'never-registered-1';
    const replies = collectReplies(ws, callId);
    ws.send(JSON.stringify({ type: 'tool-cancel', callId, reason: 'page-timeout' }));
    await new Promise((r) => setTimeout(r, 400));
    expect(replies.length).toBe(1);
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error).toBe('cancelled-late');
    ws.close();
  });
});
