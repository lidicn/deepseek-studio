// @vitest-environment node
/**
 * A3 · session grant v2（交接单_20261026 §6）。
 *
 * 锁 SessionAllowlist 的数据模型与撤销语义：
 *  - user grant 绑 principal/workspaceHash/toolId/approvalClass/规范目标；
 *  - session 不设 TTL（靠生命周期清理），只有 temporary 带到期；
 *  - internal-bot 预授权不能被当成用户授权（hasUserGrant 读不到）；
 *  - 各类撤销：按 id / 按 tool / 按 workspace / clearUserGrants（保留内部预授权）。
 */

import { describe, it, expect } from 'vitest';
import { SessionAllowlist } from '../../src/host/bot/registry';
import { canonicalTargetOf, grantKeyOf } from '../../src/host/authorization';
import { DEFAULT_TOOL_DEFINITIONS } from '../../src/host/tool-definitions';
import type { ToolDefinition } from '../../src/host/tool-registry';

const byId: Record<string, ToolDefinition> = Object.fromEntries(
  DEFAULT_TOOL_DEFINITIONS.map((d) => [d.id, d]),
);
const WS = 'hash_main';

function k(tool: string, target: string, principal = 'main', wsHash = WS): string {
  const def = byId[tool];
  return grantKeyOf({ principal, workspaceHash: wsHash, toolId: tool, approvalClass: def.approvalClass, canonicalTarget: target });
}

function addSession(list: SessionAllowlist, tool: string, target: string, principal = 'main', wsHash = WS) {
  return list.grant({
    key: k(tool, target, principal, wsHash),
    toolId: tool,
    approvalClass: byId[tool].approvalClass,
    grantScope: 'session',
    workspaceHash: wsHash,
    canonicalTarget: target,
    source: 'user',
  });
}

describe('A3 · user grant 精确命中', () => {
  it('同工具同目标命中；换目标不命中', () => {
    const list = new SessionAllowlist();
    addSession(list, 'file.write', 'c:/proj/a.txt');
    expect(list.hasUserGrant(k('file.write', 'c:/proj/a.txt'))).toBeDefined();
    expect(list.hasUserGrant(k('file.write', 'c:/proj/b.txt'))).toBeUndefined();
  });

  it('session 作用域不过期（无 expiresAt）', () => {
    const list = new SessionAllowlist();
    addSession(list, 'shell.exec', 'npm test');
    expect(list.hasUserGrant(k('shell.exec', 'npm test'), Date.now() + 10 * 60_000)).toBeDefined();
  });

  it('temporary 到期后 hasUserGrant 读不到并清理', () => {
    const list = new SessionAllowlist();
    const key = k('memory.delete', 'mem-1');
    list.grant({
      key,
      toolId: 'memory.delete',
      approvalClass: 'always',
      grantScope: 'temporary',
      workspaceHash: WS,
      canonicalTarget: 'mem-1',
      expiresAt: Date.now() - 1,
      source: 'user',
    });
    expect(list.hasUserGrant(key)).toBeUndefined();
    expect(list.listGrants()).toHaveLength(0);
  });

  it('不同 principal / 不同 workspaceHash 不互相命中', () => {
    const list = new SessionAllowlist();
    addSession(list, 'file.write', 'c:/proj/a.txt', 'main', WS);
    expect(list.hasUserGrant(k('file.write', 'c:/proj/a.txt', 'bot-b'))).toBeUndefined();
    expect(list.hasUserGrant(k('file.write', 'c:/proj/a.txt', 'main', 'other_ws'))).toBeUndefined();
  });
});

describe('A3 · internal preauth 与用户授权分离', () => {
  it('addPermanent 标 internal-bot，hasUserGrant 读不到', () => {
    const list = new SessionAllowlist();
    list.addPermanent('chat-send');
    expect(list.hasInternalPreauth('chat-send')).toBe(true);
    // internal preauth 不产生 user grant
    expect(list.listGrants()).toHaveLength(0);
    expect(list.hasUserGrant(k('chat-send', 'chat-send'))).toBeUndefined();
  });

  it('clearUserGrants 撤销用户 grant，但保留内部预授权', () => {
    const list = new SessionAllowlist();
    list.addPermanent('chat-insert');
    addSession(list, 'file.write', 'c:/proj/a.txt');
    list.addTemporary('shell.exec', { command: 'ls' }, 60_000);
    const n = list.clearUserGrants();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(list.listGrants()).toHaveLength(0);
    expect(list.hasInternalPreauth('chat-insert')).toBe(true);
    // legacy 指纹桶也清了
    expect(list.has('shell.exec', { command: 'ls' })).toBe(false);
  });
});

describe('A3 · 撤销 API', () => {
  it('按 id 撤销', () => {
    const list = new SessionAllowlist();
    const g = addSession(list, 'file.write', 'c:/a.txt');
    expect(list.revokeById(g.id)).toBe(true);
    expect(list.hasUserGrant(k('file.write', 'c:/a.txt'))).toBeUndefined();
    expect(list.revokeById('nope')).toBe(false);
  });

  it('按工具撤销（连内部预授权一起）', () => {
    const list = new SessionAllowlist();
    list.addPermanent('chat-send');
    addSession(list, 'chat-send', 'chat-send');
    const n = list.revokeByTool('chat-send');
    expect(n).toBeGreaterThanOrEqual(2);
    expect(list.hasInternalPreauth('chat-send')).toBe(false);
    expect(list.hasUserGrant(k('chat-send', 'chat-send'))).toBeUndefined();
  });

  it('按 workspace 撤销：换工作区后旧 grant 全部作废', () => {
    const list = new SessionAllowlist();
    addSession(list, 'file.write', 'c:/a.txt', 'main', WS);
    addSession(list, 'file.read', 'c:/b.txt', 'main', 'other');
    // 传入"被换掉的旧 hash"：绑在该 hash 上的 grant 作废，其它 hash 不受牵连。
    const removed = list.revokeWorkspace(WS);
    expect(removed).toBe(1);
    expect(list.hasUserGrant(k('file.write', 'c:/a.txt', 'main', WS))).toBeUndefined();
    expect(list.hasUserGrant(k('file.read', 'c:/b.txt', 'main', 'other'))).toBeDefined();
  });

  it('clear() 清空一切（含 legacy 永久预授权与 internal）', () => {
    const list = new SessionAllowlist();
    list.addPermanent('chat-send');
    addSession(list, 'file.write', 'c:/a.txt');
    list.clear();
    expect(list.has('chat-send')).toBe(false);
    expect(list.hasInternalPreauth('chat-send')).toBe(false);
    expect(list.listGrants()).toHaveLength(0);
  });

  it('grant 覆盖：同 key 再次发放会替换（不重复累加）', () => {
    const list = new SessionAllowlist();
    addSession(list, 'file.write', 'c:/a.txt');
    addSession(list, 'file.write', 'c:/a.txt');
    expect(list.listGrants()).toHaveLength(1);
  });

  it('listGrants 只返回有效项', () => {
    const list = new SessionAllowlist();
    addSession(list, 'file.write', 'c:/a.txt');
    list.grant({
      key: k('shell.exec', 'rm x'),
      toolId: 'shell.exec',
      approvalClass: 'mode',
      grantScope: 'temporary',
      workspaceHash: WS,
      canonicalTarget: 'rm x',
      expiresAt: Date.now() + 1000,
      source: 'user',
    });
    expect(list.listGrants()).toHaveLength(2);
    // 未来时刻：temporary 过期
    expect(list.listGrants(Date.now() + 5000)).toHaveLength(1);
  });
});

describe('A3 · canonical target 与 bot 隔离', () => {
  it('每 bot 独立放行表：一个 bot 的 grant 不串到另一个（沿用既有不变量）', () => {
    const a = new SessionAllowlist();
    const b = new SessionAllowlist();
    a.addPermanent('chat-send');
    expect(b.has('chat-send')).toBe(false);
    expect(b.hasInternalPreauth('chat-send')).toBe(false);
  });

  it('chat-send 正文绝不进 grant key / canonicalTarget', () => {
    const def = byId['chat-send'];
    const secret = '这是一段绝不该出现在授权键里的正文';
    const t1 = canonicalTargetOf(def, { text: secret }).target;
    const t2 = canonicalTargetOf(def, { text: '另一段正文' }).target;
    expect(t1).toBe(t2);
    expect(t1).not.toContain('绝不该');
  });
});
