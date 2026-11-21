// @vitest-environment node
/**
 * ㊿-c-补 · PM 卡面增补：`mcp.listAll` —— 聊天页 MCP 面板的**全量回显**源。
 *
 * 为什么单独一枚文件（不是并进 `mcp-enabled-set.test.ts`）：`getMcpController()` 是
 * **模块级单例**，本仓多个宿主用例共用一个进程内的模块注册表——同一文件里先起过宿主，
 * 单例已绑定到前一枚 `STUDIO_MCP_CONFIG`，后面的用例改 env 不生效（不是缺陷，是单例语义）。
 * 本文件只起一枚宿主，确保单例绑定的就是本格写的配置。
 *
 * 三条硬判据：
 *   1. 全量：包含被禁用的那台（否则禁用后再无行可点回开）；禁用台 `toolCount` 记 0、
 *      它的工具名不出现在 `tools[]`；
 *   2. 掩码面：响应体**结构上无 `env`/`headers` 键**，凭据金丝雀一个都不出现，
 *      `args` 里的 `--token` 值被 `****` 掩掉（走 `toMcpServerSummary` 现成实现）；
 *   3. 不回归：模型面 `mcp.list` 仍 enabled-only；`mcp.listAll` 不在模型白名单。
 */

import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startListenable } from './_host-port-guard';
import { createDesktopHost } from '../../src/host/desktop-host';
import { MCP_SECRET_MASK } from '../../src/host/mcp-controller';
import {
  SUPPORTED_INVOCATION_NAMES,
  mapUpstreamToolInvocation,
} from '../../src/shared/tool-contract';

const TOKEN = '{{SECRET_m8vq2dke}}';

/** 凭据金丝雀：全量回显的摘要里一枚都不许出现（含 args 里那枚）。 */
const CANARY_ENV = 'listall-env-value-91ca';
const CANARY_HEADER = 'Bearer listall-header-4d7e';
const CANARY_ARG = 'listall-arg-token-63bf';

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-listall-'));
const cfgPath = path.join(cfgDir, 'mcp-servers.json');
const prevMcpConfig = process.env.STUDIO_MCP_CONFIG;

function serverWithSecrets(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'nonexistent-bin-xyz-listall-test',
    args: ['-y', '@scope/fake', '--token', CANARY_ARG],
    transport: 'stdio',
    env: { API_KEY: CANARY_ENV },
    headers: { Authorization: CANARY_HEADER },
    ...extra,
  };
}

fs.writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      servers: {
        'srv-on': serverWithSecrets(),
        'srv-off': serverWithSecrets({ enabled: false }),
      },
    },
    null,
    2,
  ),
  'utf8',
);

afterAll(() => {
  if (prevMcpConfig === undefined) delete process.env.STUDIO_MCP_CONFIG;
  else process.env.STUDIO_MCP_CONFIG = prevMcpConfig;
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* OS temp 兜底 */ }
});

describe('㊿-c-补 · mcp.listAll（全量 · 掩码面 · 无 env/headers）', () => {
  it('全量含禁用台 + enabled 布尔 + 掩码无凭据；模型面 mcp.list 仍 enabled-only', async () => {
    process.env.STUDIO_MCP_CONFIG = cfgPath;
    const host = await startListenable(() =>
      createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: TOKEN }, secret: 's' }),
    );
    try {
      const all = await host.invokeTool('mcp.listAll', {});
      expect(all.ok, JSON.stringify(all)).toBe(true);
      const data = all.data as {
        servers: string[];
        configs: Array<{ id: string; enabled: boolean; toolCount?: number; args?: string[] }>;
        tools: Array<{ serverId: string; name: string }>;
      };
      // ① 全量（禁用台必须在列，否则面板死了）
      expect([...data.servers].sort()).toEqual(['srv-off', 'srv-on']);
      expect(data.configs.map((c) => c.id).sort()).toEqual(['srv-off', 'srv-on']);
      const on = data.configs.find((c) => c.id === 'srv-on');
      const off = data.configs.find((c) => c.id === 'srv-off');
      expect(on?.enabled).toBe(true);
      expect(off?.enabled).toBe(false);
      // 禁用台不 spawn（spawn 都不发）⇒ toolCount 0，且它的工具名不在 tools[]
      expect(off?.toolCount).toBe(0);
      expect(data.tools.some((t) => t.serverId === 'srv-off')).toBe(false);

      // ② 掩码面：无 env/headers 键、无三枚金丝雀、args 里的 token 被 ****
      const payload = JSON.stringify(all.data);
      expect(payload).not.toContain('"env"');
      expect(payload).not.toContain('"headers"');
      expect(payload).not.toContain(CANARY_ENV);
      expect(payload).not.toContain(CANARY_HEADER);
      expect(payload).not.toContain(CANARY_ARG);
      expect(on?.args).toEqual(['-y', '@scope/fake', '--token', MCP_SECRET_MASK]);

      // ③ 不回归：模型面 mcp.list 仍只列 enabled
      const model = await host.invokeTool('mcp.list', {});
      expect(model.ok).toBe(true);
      const modelPayload = JSON.stringify(model.data);
      expect(modelPayload).toContain('srv-on');
      expect(modelPayload).not.toContain('srv-off');
    } finally {
      await host.stop();
    }
  }, 60_000);

  it('mcp.listAll 不在模型面（仅 UI 可达）', () => {
    const modelFace = new Set(
      SUPPORTED_INVOCATION_NAMES.map((n) => mapUpstreamToolInvocation(n, {})?.id).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    );
    expect(modelFace.has('mcp.listAll')).toBe(false);
    expect(mapUpstreamToolInvocation('mcp.listAll', {})).toEqual({
      id: 'mcp.listAll',
      params: {},
    });
  });
});
