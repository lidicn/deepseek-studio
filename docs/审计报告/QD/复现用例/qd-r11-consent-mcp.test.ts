/**
 * QD-R11：设置 / MCP / 同意闸门复现件（跑在 E:/NAS/tmp 副本树）。
 *
 * 面：HEAD dcedede + 盘面（consent-router / policy / mcp-controller / desktop-host 与盘面同 sha1）。
 * 口径：CONTROL 腿断言"应有行为"并通过，REPRO 腿同样断言"应有行为"——实测红即缺陷复现。
 *
 * CONTROL-A / A1：routeConsent 的硬拒绝地板对 POSIX 敏感路径、反斜杠 C:\Windows 路径
 *                 确实返回 deny（证明尺会响）。
 * REPRO-A2：正斜杠 C:/Windows 形态未被 hard-deny。
 * REPRO-A3：用户家目录 .ssh 绝对路径未被 hard-deny（`~` 模式永不出现于绝对路径）。
 * CONTROL-B：routeConsent 对 `format C:` 返回 deny/dangerous-disk（地板本身可判）。
 * REPRO-B1：full 档下 evaluatePolicy 直接 allow ⇒ 生产 `requiresHumanConsent` 为 false，
 *            `if (requiresHumanConsent && !outsideApproved)` 根本不会调用 routeConsent。
 * REPRO-B2：生产调用点未传 realPath ⇒ 敏感路径分支不可达。
 * REPRO-B3：生产调用点只消费 `safe && whitelist-hit` ⇒ routeConsent 的 deny 被丢弃。
 * REPRO-C1：MCP 编辑配置后不重连，工具表仍是旧进程的旧工具。
 * REPRO-C2：MCP 删除服务器后，已建立连接仍可 callTool（listServerIds 已为空）。
 * REPRO-D：白名单首条同工具异 action 记录提前 return action-mismatch，跳过后续命中记录。
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeConsent } from '../../src/host/consent-router';
import type { WhitelistEntry } from '../../src/host/consent-router';
import { evaluatePolicy } from '../../src/host/policy';
import { McpController, removeMcpServer } from '../../src/host/mcp-controller';

const WORKSPACE = {
  root: 'C:\\work',
  contains(target: string): boolean {
    const root = path.resolve('C:\\work').toLowerCase();
    const p = path.resolve(target).toLowerCase();
    return p === root || p.startsWith(root + path.sep);
  },
} as never;

function consent(partial: Partial<Parameters<typeof routeConsent>[0]> & Pick<Parameters<typeof routeConsent>[0], 'toolId' | 'params' | 'policy' | 'policyReason'>) {
  return routeConsent({
    mode: 'auto',
    resolvedPath: null,
    relPath: null,
    outside: false,
    workspaceRoot: 'C:\\work',
    workspaceHash: 'ws-hash',
    whitelist: [],
    now: 1_700_000_000_000,
    ...partial,
  });
}

const mcpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-r11-mcp-'));
const fakeServerPath = path.join(mcpTmp, 'fake-mcp-server.js');

function writeFakeServer(): void {
  fs.writeFileSync(
    fakeServerPath,
    [
      "const readline = require('node:readline');",
      "const toolName = process.argv[2] || 'old_tool';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function out(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }",
      "rl.on('line', (line) => {",
      "  let msg; try { msg = JSON.parse(line); } catch { return; }",
      "  if (msg.id == null) return;",
      "  if (msg.method === 'initialize') { out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1.0' } } }); return; }",
      "  if (msg.method === 'tools/list') { out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: toolName, description: 'fake tool', inputSchema: { type: 'object' } }] } }); return; }",
      "  if (msg.method === 'tools/call') { out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ tool: toolName, args: msg.params && msg.params.arguments }) }] } }); return; }",
      "  out({ jsonrpc: '2.0', id: msg.id, result: {} });",
      "});",
    ].join('\n'),
    'utf8',
  );
}

async function runMcpScenario(tag: string) {
  const dir = fs.mkdtempSync(path.join(mcpTmp, `scenario-${tag}-`));
  const prev = process.env.STUDIO_CONFIG_DIR;
  process.env.STUDIO_CONFIG_DIR = dir;
  const sid = `srv-${tag}`;
  const controller = new McpController();
  try {
    controller.saveServer(sid, { command: process.execPath, args: [fakeServerPath, 'old_tool'] });
    const tools1 = await controller.getAllTools();
    controller.saveServer(sid, { command: process.execPath, args: [fakeServerPath, 'new_tool'] });
    controller.reload();
    const tools2 = await controller.getAllTools();
    const rm = removeMcpServer(sid, path.join(dir, 'mcp-servers.json'));
    controller.reload();
    const listed = controller.listServerIds();
    const call = await controller.callTool(sid, 'old_tool', { tag });
    const reading = {
      tools1: tools1.map((t) => t.name),
      tools2: tools2.map((t) => t.name),
      rmOk: rm.ok,
      listed,
      callOk: call.ok,
      callData: call.data,
    };
    console.log(`[R11-C/${tag}]`, JSON.stringify(reading));
    return reading;
  } finally {
    controller.disconnectAll();
    if (prev === undefined) delete process.env.STUDIO_CONFIG_DIR;
    else process.env.STUDIO_CONFIG_DIR = prev;
  }
}

afterAll(() => {
  try { fs.rmSync(mcpTmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('QD-R11 硬拒绝地板', () => {
  it('CONTROL-A：POSIX 敏感路径会命中 hard-deny', () => {
    const r = consent({
      toolId: 'file.write',
      params: { path: '/etc/passwd' },
      policy: 'allow',
      policyReason: 'outside-workspace',
      resolvedPath: '/etc/passwd',
      realPath: '/etc/passwd',
      outside: true,
      mode: 'full',
    });
    console.log('[R11-A/CONTROL] verdict=', r.verdict, 'reason=', r.reason, 'hardRule=', r.hardRule);
    expect(r.verdict).toBe('deny');
    expect(r.hardRule).toBe('sensitive-path');
  });

  it('CONTROL-A1：反斜杠 C:\\Windows 路径（Windows 真实形态）会命中 hard-deny', () => {
    const target = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
    const r = consent({
      toolId: 'file.write',
      params: { path: target },
      policy: 'allow',
      policyReason: 'outside-workspace',
      resolvedPath: target,
      realPath: target,
      outside: true,
      mode: 'full',
    });
    console.log('[R11-A1/CONTROL] verdict=', r.verdict, 'reason=', r.reason, 'hardRule=', r.hardRule);
    expect(r.verdict).toBe('deny');
    expect(r.hardRule).toBe('sensitive-path');
  });

  it('REPRO-A2：正斜杠 C:/Windows 路径应命中 hard-deny（实际未命中）', () => {
    const target = 'C:/Windows/System32/drivers/etc/hosts';
    const r = consent({
      toolId: 'file.write',
      params: { path: target },
      policy: 'allow',
      policyReason: 'outside-workspace',
      resolvedPath: target,
      realPath: target,
      outside: true,
      mode: 'full',
    });
    console.log('[R11-A2/REPRO] verdict=', r.verdict, 'reason=', r.reason, 'hardRule=', r.hardRule);
    expect(r.verdict).toBe('deny');
  });

  it('REPRO-A3：用户 .ssh 绝对路径应命中 hard-deny（实际只到 ask）', () => {
    const target = 'C:\\Users\\dev\\.ssh\\id_rsa';
    const r = consent({
      toolId: 'file.write',
      params: { path: target },
      policy: 'require-consent',
      policyReason: 'outside-workspace',
      resolvedPath: target,
      realPath: target,
      outside: true,
      mode: 'auto',
    });
    console.log('[R11-A3/REPRO] verdict=', r.verdict, 'reason=', r.reason, 'hardRule=', r.hardRule);
    expect(r.verdict).toBe('deny');
  });

  it('CONTROL-B：format C: 在地板里会 deny（地板本身可判）', () => {
    const hard = consent({
      toolId: 'shell.exec',
      params: { command: 'format C:' },
      policy: 'require-consent',
      policyReason: 'risk-detected',
      mode: 'auto',
    });
    console.log('[R11-B/CONTROL] routeConsent=', hard.verdict, hard.reason, hard.hardRule);
    expect(hard.verdict).toBe('deny');
    expect(hard.hardRule).toBe('dangerous-disk');
  });

  it('REPRO-B1：full 档下危险命令应仍受地板约束（实际 requiresHumanConsent=false）', () => {
    const policy = evaluatePolicy({
      tool: 'shell.exec',
      params: { command: 'shutdown /s /t 0' },
      mode: 'full',
      workspace: WORKSPACE,
    });
    const requiresHumanConsent = policy.decision === 'require-consent';
    console.log('[R11-B1/REPRO] full-policy=', policy.decision, policy.reason,
      'requiresHumanConsent=', requiresHumanConsent);
    expect(requiresHumanConsent).toBe(true);
  });

  it('REPRO-B2：生产调用点应传 realPath（实际未传）', () => {
    const src = fs.readFileSync(new URL('../../src/host/desktop-host.ts', import.meta.url), 'utf8');
    const start = src.indexOf('const wlResult = routeConsent({');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    const call = src.slice(start, end);
    console.log('[R11-B2/REPRO] callHasRealPath=', /realPath\s*:/.test(call));
    expect(/realPath\s*:/.test(call)).toBe(true);
  });

  it('REPRO-B3：生产调用点应消费 routeConsent 的 deny（实际只消费 whitelist-hit）', () => {
    const src = fs.readFileSync(new URL('../../src/host/desktop-host.ts', import.meta.url), 'utf8');
    const start = src.indexOf('const wlResult = routeConsent({');
    const end = src.indexOf('});', start);
    const after = src.slice(end, end + 500);
    console.log('[R11-B3/REPRO] consumesDeny=', /wlResult\.verdict\s*===\s*'deny'/.test(after));
    expect(/wlResult\.verdict\s*===\s*'deny'/.test(after)).toBe(true);
  });
});

describe('QD-R11 MCP 连接生命周期', () => {
  it('REPRO-C1：编辑配置后工具表应切到新命令（实际仍是旧进程）', async () => {
    writeFakeServer();
    const r = await runMcpScenario('edit');
    expect(r.tools1).toEqual(['old_tool']);
    expect(r.tools2).toEqual(['new_tool']);
  });

  it('REPRO-C2：删除服务器后不应再可调用（实际仍返回 ok）', async () => {
    writeFakeServer();
    const r = await runMcpScenario('remove');
    expect(r.rmOk).toBe(true);
    expect(r.listed).toEqual([]);
    expect(r.callOk).toBe(false);
  });
});

describe('QD-R11 白名单匹配', () => {
  it('REPRO-D：后续 append 白名单记录应被命中（实际首条 write 提前短路）', () => {
    const now = 1_700_000_000_000;
    const entries: WhitelistEntry[] = [
      { id: 'w-write', toolId: 'file.write', action: 'write', pathPattern: '*', workspaceHash: 'ws-hash', createdAt: now },
      { id: 'w-append', toolId: 'file.write', action: 'append', pathPattern: '*', workspaceHash: 'ws-hash', createdAt: now },
    ];
    const r = consent({
      toolId: 'file.write',
      params: { path: 'C:\\work\\notes.txt', append: true },
      policy: 'require-consent',
      policyReason: 'requires-approval',
      resolvedPath: 'C:\\work\\notes.txt',
      realPath: 'C:\\work\\notes.txt',
      relPath: 'notes.txt',
      outside: false,
      mode: 'auto',
      whitelist: entries,
    });
    console.log('[R11-D/REPRO] verdict=', r.verdict, 'reason=', r.reason, 'matchedEntryId=', r.matchedEntryId);
    expect(r.verdict).toBe('safe');
    expect(r.reason).toBe('whitelist-hit');
  });
});
