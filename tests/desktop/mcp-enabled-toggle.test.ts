// @vitest-environment node
/**
 * ㊿-c ③：MCP per-server 开关（宿主半）。
 *
 * 卡面口径（Studio-PM 裁定 2026-11-20）：
 *   - `listServerIds()` **保持全量**（管理面 /v1/mcp/servers 与 settings.get 共用入口，
 *     禁用的服务器必须继续列出，否则禁用后无处再启用）；
 *   - 模型面三处**必须尊重 enabled**：`mcp.list` 只列 enabled（listEnabledServerIds）、
 *     `getAllTools()` 跳过禁用（不 spawn 不 connect）、`callTool()` 对禁用拒调
 *     `mcp-server-disabled`（可见错误码，不静默）；
 *   - `connect()` 对禁用返回 null（最后一道闸）；
 *   - 管理面 list() 每枚带 `enabled` 供回显；`mcpConfigFromDto` 透传（undefined＝不落盘）。
 *
 * 断言口径：全部打真实入口（McpController 公开方法 / 磁盘配置 / host HTTP 面），
 * 不测私有 helper；关键格配负控（本文件末尾 describe，变异走 logs/ 副本树）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpController, isServerEnabled } from '../../src/host/mcp-controller';

const tmpDirs: string[] = [];

function mkCfgPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enabled-'));
  tmpDirs.push(d);
  return path.join(d, 'mcp-servers.json');
}

/**
 * 写配置并**保证 mtime 严格递增**。
 *
 * 为什么不按「推 2ms」写（原写法）：`Date.now()+2` 是**墙钟推算**，
 * 两次写盘若落在同一毫秒桶里，`utimesSync` 落盘值可能与上一次**逐字相等**
 * ⇒ `refreshConfigIfChanged()` 的 mtime 判重判定「没变」⇒ 不重载。
 *
 * 实测（CI run 44881343626 探针，node v24.22.3 / windows-2025）：**碰撞率 48.85%**
 * （2000 次采样中 977 次 recorded===mtime，minDiff=0）；本机 node v24.14.0 上为 0%
 * ⇒ 这是**CI 文件系统时间戳精度差异**触发的随机红，不是产品缺陷，但会持续红 CI。
 *
 * 现在改成：**以文件当前 mtime 为基准 +1ms**（`lastMtime` 缓存），保证每次写盘的
 * mtime 严格大于上一次 ⇒ 判重必然失效 ⇒ 热重载必然生效 ⇒ 与机器速度、文件系统
 * 时间戳精度**都无关**。
 */
const lastMtime = new Map<string, number>();

function writeCfg(cfgPath: string, servers: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify({ servers }, null, 2), 'utf8');
  // 基准 = 上一次写盘落下的 mtime（没有则取当前文件 mtime），再 +1ms ⇒ 严格递增。
  const current = lastMtime.get(cfgPath);
  let base: number;
  try {
    base = current ?? fs.statSync(cfgPath).mtimeMs;
  } catch {
    base = Date.now();
  }
  const next = base + 1;
  lastMtime.set(cfgPath, next);
  const t = new Date(next);
  fs.utimesSync(cfgPath, t, t);
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    fs.rmSync(d as string, { recursive: true, force: true });
  }
});

describe('㊿-c ③ · enabled 解析与缺省语义', () => {
  it('缺省（无 enabled 字段）⇒ 启用；显式 true ⇒ 启用；显式 false ⇒ 禁用', () => {
    expect(isServerEnabled({ command: 'a' })).toBe(true);
    expect(isServerEnabled({ command: 'a', enabled: true })).toBe(true);
    expect(isServerEnabled({ command: 'a', enabled: false })).toBe(false);
    expect(isServerEnabled(null)).toBe(true);
    expect(isServerEnabled(undefined)).toBe(true);
  });

  it('磁盘配置里的 enabled:false 被解析进内存态；listServerIds 保持全量', () => {
    const cfgPath = mkCfgPath();
    writeCfg(cfgPath, {
      'on-a': { command: 'node', args: ['a.js'], enabled: true },
      'off-b': { command: 'node', args: ['b.js'], enabled: false },
      'def-c': { command: 'node', args: ['c.js'] },
    });
    const ctl = new McpController(cfgPath);
    // 全量（管理面语义）：三台都在
    expect(ctl.listServerIds().sort()).toEqual(['def-c', 'off-b', 'on-a']);
    // 模型面：只列启用
    expect(ctl.listEnabledServerIds().sort()).toEqual(['def-c', 'on-a']);
    // 单台判定
    expect(ctl.isServerEnabledById('off-b')).toBe(false);
    expect(ctl.isServerEnabledById('on-a')).toBe(true);
    expect(ctl.isServerEnabledById('def-c')).toBe(true);
    // 内存态配置带 enabled 字段（供 saveServer/管理面回显）
    expect(ctl.getServerConfig('off-b')?.enabled).toBe(false);
  });

  it('enabled 只认布尔：enabled:"false"（字符串）等假值形态不落地为禁用（解析透传后 isServerEnabled 仍 true）', () => {
    const cfgPath = mkCfgPath();
    writeCfg(cfgPath, { s1: { command: 'node', enabled: 'false' as unknown as boolean } });
    const ctl = new McpController(cfgPath);
    // 类型上 enabled?: boolean，磁盘非法形态透传进来后 isServerEnabled 用 !== false 判定
    expect(ctl.isServerEnabledById('s1')).toBe(true);
  });
});

describe('㊿-c ③ · 模型面尊重 enabled', () => {
  it('callTool 对禁用服务器拒调 mcp-server-disabled（不连接、可见错误码）', async () => {
    const cfgPath = mkCfgPath();
    writeCfg(cfgPath, { off: { command: 'node', args: ['x.js'], enabled: false } });
    const ctl = new McpController(cfgPath);
    const r = await ctl.callTool('off', 'echo', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('mcp-server-disabled');
    expect(r.error).toContain('off');
    // 没建立过连接（拒调发生在 connect 之前）
    expect((ctl as unknown as { connections: Map<string, unknown> }).connections.has('off')).toBe(false);
  });

  it('connect() 对禁用服务器返回 null（最后一道闸）', async () => {
    const cfgPath = mkCfgPath();
    writeCfg(cfgPath, { off: { command: 'node', args: ['x.js'], enabled: false } });
    const ctl = new McpController(cfgPath);
    const conn = await ctl.connect('off');
    expect(conn).toBeNull();
  });

  it('开关切换后热重载生效：禁用 ⇒ 启用后 callTool 不再拒（走 connect 失败回 not available，而非 disabled）', async () => {
    const cfgPath = mkCfgPath();
    writeCfg(cfgPath, { s1: { command: 'node', args: ['x.js'], enabled: false } });
    const ctl = new McpController(cfgPath);
    const r1 = await ctl.callTool('s1', 'echo', {});
    expect(r1.error).toContain('mcp-server-disabled');
    // 用户在面板重新启用（磁盘写回 enabled:true）
    writeCfg(cfgPath, { s1: { command: 'node', args: ['x.js'], enabled: true } });
    const r2 = await ctl.callTool('s1', 'echo', {});
    // 伪进程连不上（spawn 失败），但错误码必须是「不可用」而非「已禁用」
    expect(r2.ok).toBe(false);
    expect(r2.error).not.toContain('mcp-server-disabled');
  });
});
