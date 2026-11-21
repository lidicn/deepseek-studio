// @vitest-environment node
/**
 * ㊿-c-补（2026-11-21）：MCP per-server 开关的轻量落盘口 `mcp.enabled.set`。
 *
 * 本卡的安全锚在第一格：**只翻 `enabled` 一枚键**，其余字段（含 `env` / `headers`
 * 的明文凭据）一个字节都不动。判据不是「看起来没变」，而是**单编辑（one-edit）证明**：
 * 新旧文本只差一个连续片段，且该片段的内容恰是 enabled 的写入 ⇒ 其余字节逐字相同。
 *
 * 覆盖：
 *   1. 控制器级：缺键插入 `enabled:false`（纯插入）／已有 `false` → `true`（纯替换）／
 *      缺键台设 `true` 成功且**不写盘**（bytes 与 mtime 双证不动）；
 *   2. 控制器级失败面：未知 id → `mcp-server-not-found`；坏 JSON → `config-corrupt`
 *      （两者必须可区分：一台没配 ≠ 配置文件坏了）；
 *   3. 真宿主链：`invokeTool('mcp.enabled.set')` 落盘 → 模型面 `mcp.list` 消失 →
 *      管理面 `GET /v1/mcp/servers` 仍全量带 `enabled:false` → 回开恢复；
 *   4. 缺参回 `missing-argument`；`mcp.enabled.set` **不在模型面**（仅 UI 可达）。
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startListenable } from './_host-port-guard';
import { createDesktopHost } from '../../src/host/desktop-host';
import { McpController } from '../../src/host/mcp-controller';
import {
  SUPPORTED_INVOCATION_NAMES,
  mapUpstreamToolInvocation,
} from '../../src/shared/tool-contract';

const TOKEN = '{{SECRET_k3xm9vta}}';

/** 凭据金丝雀：只翻 enabled 之后它们必须**逐字**还在盘上（掩码/丢失都算红）。 */
const CANARY_ENV = 'canary-env-value-2f91';
const CANARY_HEADER = 'Bearer canary-header-7c3d';
const CANARY_ARG = 'canary-arg-token-5ab0';

const tmpDirs: string[] = [];
let prevMcpConfig: string | undefined;

function mkTmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** 一枚带凭据金丝雀的 stdio 服务器（`command` 故意不存在：spawn 立刻 ENOENT，不连外网）。 */
function serverWithSecrets(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'nonexistent-bin-xyz-mcp-set-test',
    args: ['-y', '@scope/fake', '--token', CANARY_ARG],
    transport: 'stdio',
    env: { API_KEY: CANARY_ENV },
    headers: { Authorization: CANARY_HEADER },
    ...extra,
  };
}

function writeCfg(cfgPath: string, servers: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify({ servers }, null, 2), 'utf8');
  // mtime 往前挪 2ms：避开同一毫秒内「写后立刻 stat」的等值假象（与既有用例同口径）。
  const t = new Date(Date.now() + 2);
  fs.utimesSync(cfgPath, t, t);
}

/**
 * 「单编辑」证明：返回两段文本的公共前缀长度、被删片段、被插片段。
 *
 * 判据用法：
 *   - 纯插入 ⇒ `removed === ''`（一个既有字节都没被删改）；
 *   - 纯替换 ⇒ `removed` 恰是要被换掉的那枚值原文。
 */
function oneEdit(before: string, after: string): { prefix: number; removed: string; inserted: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p += 1;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) {
    s += 1;
  }
  return {
    prefix: p,
    removed: before.slice(p, before.length - s),
    inserted: after.slice(p, after.length - s),
  };
}

/** 去掉所有空白后比对（对序列化缩进不敏感，对「写了什么键值」敏感）。 */
function squash(s: string): string {
  return s.replace(/\s+/g, '');
}

/**
 * 「只改一行」证明（用于 `false` → `true` 这类**纯替换**）：
 * 行数不变、且**恰有一行**不同 ⇒ 其余行逐字节相同。
 *
 * 为什么不复用 `oneEdit` 判替换：公共前缀/后缀各自最大化时，「false → true」
 * 会被切成 `fals`/`tru` 共享尾部 `e`，两种切法都合法 ⇒ 断不成「整枚值被换掉」。
 */
function changedLine(before: string, after: string): { beforeLine: string; afterLine: string } {
  const b = before.split('\n');
  const a = after.split('\n');
  expect(a.length, '替换 enabled 不应增删行').toBe(b.length);
  const idx: number[] = [];
  for (let i = 0; i < b.length; i += 1) if (b[i] !== a[i]) idx.push(i);
  expect(idx.length, `应恰有一行不同，实际 ${idx.length} 行`).toBe(1);
  return { beforeLine: b[idx[0]], afterLine: a[idx[0]] };
}

afterEach(() => {
  if (prevMcpConfig === undefined) delete process.env.STUDIO_MCP_CONFIG;
  else process.env.STUDIO_MCP_CONFIG = prevMcpConfig;
  prevMcpConfig = undefined;
});

afterAll(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d as string, { recursive: true, force: true }); } catch { /* OS temp 兜底 */ }
  }
});

describe('㊿-c-补 · 控制器级（只翻 enabled，其余字节不动）', () => {
  it('缺键台 set(false) ⇒ 纯插入一枚 enabled，凭据明文逐字未动', () => {
    const dir = mkTmpDir('mcp-set-ctl-');
    const cfgPath = path.join(dir, 'mcp-servers.json');
    writeCfg(cfgPath, { 'srv-a': serverWithSecrets() });
    const before = fs.readFileSync(cfgPath, 'utf8');

    const controller = new McpController(cfgPath);
    const r = controller.setServerEnabled('srv-a', false);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const after = fs.readFileSync(cfgPath, 'utf8');
    const d = oneEdit(before, after);
    // ① 安全锚：纯插入 —— 其余字段（含 env/headers 明文）逐字节不变
    expect(d.removed).toBe('');
    expect(squash(d.inserted)).toBe(',"enabled":false');
    // ② 语义面：只有 enabled 变了
    const parsed = JSON.parse(after) as { servers: Record<string, Record<string, unknown>> };
    expect(parsed.servers['srv-a'].enabled).toBe(false);
    const { enabled: _ignored, ...rest } = parsed.servers['srv-a'];
    expect(rest).toEqual(serverWithSecrets());
    // ③ 凭据金丝雀在原文里还在（不是被掩码成 ****）
    expect(after).toContain(CANARY_ENV);
    expect(after).toContain(CANARY_HEADER);
    expect(after).toContain(CANARY_ARG);
    expect(after).not.toContain('****');
  });

  it('已有 enabled:false 台 set(true) ⇒ 纯替换 false→true，其余字段不动', () => {
    const dir = mkTmpDir('mcp-set-ctl-');
    const cfgPath = path.join(dir, 'mcp-servers.json');
    writeCfg(cfgPath, { 'srv-b': serverWithSecrets({ enabled: false }) });
    const before = fs.readFileSync(cfgPath, 'utf8');

    const controller = new McpController(cfgPath);
    const r = controller.setServerEnabled('srv-b', true);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const after = fs.readFileSync(cfgPath, 'utf8');
    // 纯替换：行数不变、恰一行不同，且该行内容就是 enabled 的值
    const line = changedLine(before, after);
    expect(squash(line.beforeLine)).toBe('"enabled":false');
    expect(squash(line.afterLine)).toBe('"enabled":true');
    const parsed = JSON.parse(after) as { servers: Record<string, Record<string, unknown>> };
    expect(parsed.servers['srv-b'].enabled).toBe(true);
    expect(after).toContain(CANARY_ENV);
  });

  it('缺键台 set(true) ⇒ 成功但无写动作（bytes 与 mtime 双证不动）', () => {
    const dir = mkTmpDir('mcp-set-ctl-');
    const cfgPath = path.join(dir, 'mcp-servers.json');
    writeCfg(cfgPath, { 'srv-c': serverWithSecrets() });
    const before = fs.readFileSync(cfgPath, 'utf8');
    const mtimeBefore = fs.statSync(cfgPath).mtimeMs;

    const controller = new McpController(cfgPath);
    const r = controller.setServerEnabled('srv-c', true);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
    expect(fs.statSync(cfgPath).mtimeMs).toBe(mtimeBefore);
  });

  it('未知 id ⇒ mcp-server-not-found；坏 JSON ⇒ config-corrupt（两态可区分）', () => {
    const dir = mkTmpDir('mcp-set-ctl-');
    const cfgPath = path.join(dir, 'mcp-servers.json');
    writeCfg(cfgPath, { 'srv-d': serverWithSecrets() });
    const controller = new McpController(cfgPath);
    const r1 = controller.setServerEnabled('ghost-server', false);
    expect(r1.ok).toBe(false);
    expect(String(r1.error)).toContain('mcp-server-not-found');

    const brokenPath = path.join(dir, 'mcp-broken.json');
    fs.writeFileSync(brokenPath, '{ "servers": { "srv-e": ', 'utf8');
    const brokenBefore = fs.readFileSync(brokenPath, 'utf8');
    const broken = new McpController(brokenPath);
    const r2 = broken.setServerEnabled('srv-e', false);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('config-corrupt');
    // 损坏文件不得被这次调用改写（拒写，不是「覆盖成空表」）
    expect(fs.readFileSync(brokenPath, 'utf8')).toBe(brokenBefore);
  });
});

describe('㊿-c-补 · 真宿主链（invokeTool / 模型面 / 管理面）', () => {
  async function bootHost(cfgPath: string) {
    prevMcpConfig = process.env.STUDIO_MCP_CONFIG;
    process.env.STUDIO_MCP_CONFIG = cfgPath;
    return startListenable(() =>
      createDesktopHost({
        config: { host: '127.0.0.1', port: 0, token: TOKEN },
        secret: 's',
      }),
    );
  }

  it('set(false) 落盘 ⇒ 模型面消失、管理面仍全量带 enabled ⇒ set(true) 恢复', async () => {
    const dir = mkTmpDir('mcp-set-host-');
    const cfgPath = path.join(dir, 'mcp-servers.json');
    writeCfg(cfgPath, { 'srv-live': serverWithSecrets() });
    const before = fs.readFileSync(cfgPath, 'utf8');

    const host = await bootHost(cfgPath);
    const auth = { Authorization: `Bearer ${TOKEN}` };
    try {
      // ① 关：落盘 + 纯插入
      const off = await host.invokeTool('mcp.enabled.set', { id: 'srv-live', enabled: false });
      expect(off.ok, JSON.stringify(off)).toBe(true);
      expect(off.data).toEqual({ id: 'srv-live', enabled: false });

      const afterOff = fs.readFileSync(cfgPath, 'utf8');
      const d = oneEdit(before, afterOff);
      expect(d.removed).toBe('');
      expect(squash(d.inserted)).toBe(',"enabled":false');
      expect(afterOff).toContain(CANARY_ENV);

      // ② 模型面：禁用的服务器整体不可见（热重载后 getAllTools 跳过 ⇒ 不 spawn）
      const model = await host.invokeTool('mcp.list', {});
      expect(model.ok).toBe(true);
      expect(JSON.stringify(model.data)).not.toContain('srv-live');

      // ③ 管理面：仍全量列出（否则禁用后再也开不回来），且回显 enabled:false
      const listRes = await fetch(`${host.url}/v1/mcp/servers`, { headers: auth });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as { servers: Array<{ id: string; enabled?: boolean }> };
      const row = body.servers.find((s) => s.id === 'srv-live');
      expect(row?.enabled).toBe(false);

      // ④ 开：恢复（纯替换 true 写回），模型面重新出现
      const on = await host.invokeTool('mcp.enabled.set', { id: 'srv-live', enabled: true });
      expect(on.ok, JSON.stringify(on)).toBe(true);
      expect(on.data).toEqual({ id: 'srv-live', enabled: true });
      const afterOn = fs.readFileSync(cfgPath, 'utf8');
      // 回开：恰一行不同（enabled false → true），其余字节相同
      const lineOn = changedLine(afterOff, afterOn);
      expect(squash(lineOn.beforeLine)).toBe('"enabled":false');
      expect(squash(lineOn.afterLine)).toBe('"enabled":true');
      const model2 = await host.invokeTool('mcp.list', {});
      expect(model2.ok).toBe(true);
      expect(JSON.stringify(model2.data)).toContain('srv-live');
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('缺参回 missing-argument；未知 id 回 mcp-server-not-found', async () => {
    const dir = mkTmpDir('mcp-set-host-');
    const cfgPath = path.join(dir, 'mcp-servers.json');
    writeCfg(cfgPath, { 'srv-arg': serverWithSecrets() });
    const host = await bootHost(cfgPath);
    try {
      const r1 = await host.invokeTool('mcp.enabled.set', { enabled: false });
      expect(r1.ok).toBe(false);
      expect(String(r1.reason)).toContain('missing-argument');

      const r2 = await host.invokeTool('mcp.enabled.set', { id: 'srv-arg' });
      expect(r2.ok).toBe(false);
      expect(String(r2.reason)).toContain('missing-argument');

      const r3 = await host.invokeTool('mcp.enabled.set', { id: 'srv-arg', enabled: 'false' });
      expect(r3.ok).toBe(false);
      expect(String(r3.reason)).toContain('missing-argument');

      const r4 = await host.invokeTool('mcp.enabled.set', { id: 'ghost-server', enabled: false });
      expect(r4.ok).toBe(false);
      expect(String(r4.reason)).toContain('mcp-server-not-found');
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('mcp.enabled.set 不在模型面（仅 UI 可达）', () => {
    const modelFace = new Set(
      SUPPORTED_INVOCATION_NAMES.map((n) => mapUpstreamToolInvocation(n, {})?.id).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    );
    expect(modelFace.has('mcp.enabled.set')).toBe(false);
    // 页端 UI 经 callHostTool 投递仍能映射（UI_ONLY 表可达），且 enabled 原样透传不强转
    expect(mapUpstreamToolInvocation('mcp.enabled.set', { id: 'x', enabled: false })).toEqual({
      id: 'mcp.enabled.set',
      params: { id: 'x', enabled: false },
    });
    expect(mapUpstreamToolInvocation('mcp.enabled.set', { id: 'x' })?.params).toEqual({
      id: 'x',
      enabled: undefined,
    });
  });
});
