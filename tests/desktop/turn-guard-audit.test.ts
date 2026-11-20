/**
 * 卡 P3-b（验收提案）：护栏拒绝必须**恰记一枚**审计（denied），不再落通用出口的
 * execution-failed——原实现同一次拒绝落两枚（同 at 同 dur），枚数巡检把「拒绝次数」
 * 系统性多算一倍。
 *
 * 硬约束（同卡）：**非护栏**失败的通用出口一字不动——spawn-failed／io-error 等仍各 1 枚。
 *
 * 复现面用真宿主（createDesktopHost + invokeTool），走完整授权链；
 * 优雅停机后停 host，不给闸留尾巴。
 */
import { describe, expect, it, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import { studioExecutionStorageKey, STUDIO_EXECUTION_VERSION } from '../../src/shared/studio-execution';

const roots: string[] = [];
const running: DesktopHost[] = [];

afterEach(async () => {
  while (running.length) {
    const h = running.pop();
    try { await h?.stop(); } catch { /* 已停 */ }
  }
});

function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-audit-'));
  roots.push(root);
  return root;
}

async function startHost(workspaceRoot: string, policyMode: 'full' | 'auto'): Promise<DesktopHost> {
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    workspace: createWorkspace(workspaceRoot),
    policyMode,
  });
  await host.start();
  running.push(host);
  return host;
}

/** 用假页 ws 经真实 kv-set 通道把执行会话种进宿主 KV（turnId 才有边界，dedupe 才开）。 */
async function seedExecutionSession(host: DesktopHost, convId: string, turnId: string): Promise<void> {
  const port = Number(new URL(host.url).port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'seed-kv' }));
  const session = {
    version: STUDIO_EXECUTION_VERSION,
    key: studioExecutionStorageKey(convId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    events: [{ type: 'user-message', at: Date.now(), turnId, text: '跑一遍工具' }],
  };
  const ack = new Promise<void>((resolve, reject) => {
    const onMsg = (raw: unknown): void => {
      const buf = Array.isArray(raw) ? (raw[0] as unknown) : raw;
      const m = JSON.parse(String((buf as { data?: string }).data ?? buf)) as { type: string; requestId: string; ok?: boolean };
      if (m.type === 'kv-result' && m.requestId === 'seed-1') {
        ws.off('message', onMsg);
        if (m.ok) resolve(); else reject(new Error('kv-set failed'));
      }
    };
    ws.on('message', onMsg);
  });
  ws.send(JSON.stringify({ type: 'kv-set', requestId: 'seed-1', key: studioExecutionStorageKey(convId), value: session }));
  await ack;
  ws.close();
}

describe('P3-b 护栏拒绝恰记一枚审计', () => {
  it('同 turn 同签名重复 → 恰 1 枚 denied，无 execution-failed', async () => {
    const tmp = mkRoot();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    const host = await startHost(tmp, 'full');

    // 种带 turnId 的执行会话 ⇒ 护栏键有真 turn 边界（dedupe 开）。
    const convId = 'audit-p3b-conv';
    await seedExecutionSession(host, convId, 'turn-p3b-1');
    const first = await host.invokeTool('search_files', { operation: 'list' }, undefined, convId);
    expect(first.ok).toBe(true);
    const dup = await host.invokeTool('search_files', { operation: 'list' }, undefined, convId);
    expect(dup.ok).toBe(false);
    expect(dup.reason).toBe('duplicate-tool-signature');

    const recs = host.audit.list().filter((r) => r.tool === 'search_files');
    const denied = recs.filter((r) => r.outcome === 'denied');
    const execFailed = recs.filter((r) => r.outcome === 'execution-failed');
    expect(denied.length, `denied 应恰 1 枚（实得 ${denied.length}）`).toBe(1);
    expect(denied[0]?.reason).toBe('duplicate-tool-signature');
    expect(execFailed.length, `拒绝不得再记 execution-failed（实得 ${execFailed.length}）`).toBe(0);
    // 成功那枚仍恰 1 枚 executed
    expect(recs.filter((r) => r.outcome === 'executed').length).toBe(1);
  });

  it('写类并发直拒 → 同样恰 1 枚 denied', async () => {
    const tmp = mkRoot();
    const host = await startHost(tmp, 'full');
    const convId = 'audit-p3b-mutating';
    await seedExecutionSession(host, convId, 'turn-p3b-2');
    // 第一枚占住执行位（search_files 只读），第二枚写类并发直拒。
    const busy = host.invokeTool('search_files', { operation: 'list' }, undefined, convId);
    const blocked = await host.invokeTool('file.edit', { path: path.join(tmp, 'a.txt'), edits: [] }, undefined, convId);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('concurrent-mutation-blocked');
    await busy;

    const recs = host.audit.list().filter((r) => r.tool === 'file.edit');
    expect(recs.filter((r) => r.outcome === 'denied').length).toBe(1);
    expect(recs.filter((r) => r.outcome === 'execution-failed').length).toBe(0);
  });

  it('非护栏失败仍走通用出口恰 1 枚 execution-failed（不欠记）', async () => {
    const tmp = mkRoot();
    const host = await startHost(tmp, 'full');
    // root 指向不存在目录 → 能力层 io-error（非护栏拒绝），通用出口必须原样记账。
    const missing = path.join(tmp, 'no-such-dir');
    const res = await host.invokeTool('search_files', { operation: 'list', root: missing });
    expect(res.ok).toBe(false);

    const recs = host.audit.list().filter((r) => r.tool === 'search_files');
    expect(recs.length, '非护栏失败恰记 1 枚').toBe(1);
    expect(recs[0]?.outcome).toBe('execution-failed');
    expect(recs.filter((r) => r.outcome === 'denied').length).toBe(0);
  });
});
