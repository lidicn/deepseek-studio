// @vitest-environment jsdom
/**
 * 聊天页 MCP 面板启用开关（㊿-c-补③ 2026-11-21，PM 卡面）：
 *   - 回显数据源＝`mcp.listAll`（管理面全量＋每枚 `enabled`，掩码真源；模型面
 *     `mcp.list` enabled-only **不得**当回显源——禁用台从面板消失后无法再启用）；
 *   - 行内开关调 `mcp.enabled.set {id, enabled}`；**成功才刷新**（重拉 listAll，
 *     真源在宿主），**失败保持原态（不假亮）＋行级可见报错**（同技能面板
 *     toggleHint 范式，`tests/desktop/skills-panel-toggle.test.ts` 同族）；
 *   - 明文凭据不流经聊天页 JS（listAll 掩码面；`mcp.enabled.set` 只翻 enabled 键）。
 *
 * 判据有区分力的对照格：「失败不假亮」格摘掉 `if (r.ok)` 守卫（开关先翻 class
 * 再调宿主）必红——负控由仓外副本树承担（`logs/ui-editor-negctl` 同批）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsPanel } from '../../src/ui/studio-settings-panel';
import { setHostBridge, type StudioHostBridge } from '../../src/ui/studio-ui-core';

const deadBridge: StudioHostBridge = {
  sendToolCall: async () => ({ ok: false, error: 'dead-bridge' }),
  log: () => {},
};

function flushOneTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface ListAllShape {
  servers: string[];
  configs: Array<{ id: string; transport: 'stdio' | 'http' | 'sse'; url?: string; command?: string; args?: string[]; enabled?: boolean }>;
  tools: unknown[];
}

/**
 * 可控宿主桩：`mcp.listAll` 回当前「盘上态」，`mcp.enabled.set` 真翻盘上态
 * （模拟宿主落盘＋热重载），其余 RPC 一律 ok/null。
 */
function mcpBridge(initial: ListAllShape, setFail?: (id: string, enabled: boolean) => string | null): {
  bridge: StudioHostBridge;
  state: ListAllShape;
} {
  const state: ListAllShape = {
    servers: [...initial.servers],
    configs: initial.configs.map((c) => ({ ...c })),
    tools: [...(initial.tools ?? [])],
  };
  const bridge: StudioHostBridge = {
    sendToolCall: async (req) => {
      switch (req.invocationName) {
        case 'mcp.listAll':
          return { ok: true, data: { servers: [...state.servers], configs: state.configs.map((c) => ({ ...c })), tools: state.tools } };
        case 'mcp.enabled.set': {
          const p = req.params as { id?: string; enabled?: boolean };
          if (setFail) {
            const err = setFail(p.id ?? '', p.enabled ?? false);
            if (err) return { ok: false, error: err };
          }
          const cfg = state.configs.find((c) => c.id === p.id);
          if (!cfg) return { ok: false, error: `mcp-server-not-found: ${p.id}` };
          cfg.enabled = p.enabled ?? true;
          return { ok: true, data: { id: p.id, enabled: p.enabled ?? true } };
        }
        case 'settings.get':
          return { ok: true, data: null };
        default:
          return { ok: true, data: null };
      }
    },
    log: () => {},
  };
  return { bridge, state };
}

afterEach(() => {
  setHostBridge(deadBridge);
  document.body.innerHTML = '';
});

describe('聊天页 MCP 面板：启用开关（㊿-c-补③）', () => {
  it('回显：`enabled:false` 台开关熄灭＋缺键台开关点亮（缺键＝启用）；回显源是 mcp.listAll', async () => {
    const { bridge, state } = mcpBridge({
      servers: ['off-srv', 'default-srv'],
      configs: [
        { id: 'off-srv', transport: 'stdio', command: 'npx', enabled: false },
        { id: 'default-srv', transport: 'http', url: 'https://mcp.example.com/mcp' },
      ],
      tools: [],
    });
    setHostBridge(bridge);
    const handle = createSettingsPanel({});
    document.body.appendChild(handle.container);
    handle.open('mcp');
    await flushOneTick();

    const rows = handle.container.querySelectorAll('.studio-mcp-server-item');
    expect(rows.length).toBe(2);
    const offSw = rows[0]!.querySelector('.studio-switch') as HTMLDivElement;
    const onSw = rows[1]!.querySelector('.studio-switch') as HTMLDivElement;
    expect(offSw.classList.contains('on')).toBe(false);
    expect(onSw.classList.contains('on')).toBe(true);
    // 回显源判据：面板吃的必须是全量管理面（禁用台「在列」＝能再启用，防死锁）。
    expect(state.servers).toContain('off-srv');
    handle.destroy();
  });

  it('成功格：点灭→宿主翻盘→重拉 listAll→开关点亮（以宿主真源刷新，非本地乐观）', async () => {
    const { bridge, state } = mcpBridge({
      servers: ['off-srv'],
      configs: [{ id: 'off-srv', transport: 'stdio', command: 'npx', enabled: false }],
      tools: [],
    });
    setHostBridge(bridge);
    const handle = createSettingsPanel({});
    document.body.appendChild(handle.container);
    handle.open('mcp');
    await flushOneTick();

    const sw = handle.container.querySelector('.studio-mcp-server-item .studio-switch') as HTMLDivElement;
    expect(sw.classList.contains('on')).toBe(false);
    sw.click();
    await flushOneTick();

    // 宿主盘上态已翻（成功＝真源在前）
    expect(state.configs[0]!.enabled).toBe(true);
    // 刷新后的开关是「on」
    const swAfter = handle.container.querySelector('.studio-mcp-server-item .studio-switch') as HTMLDivElement;
    expect(swAfter.classList.contains('on')).toBe(true);
    // 行级报错区在成功路径必须收起来（不残留旧错）
    const hint = handle.container.querySelector('.studio-mcp-server-item .studio-mcp-toggle-hint') as HTMLDivElement;
    expect(hint.hidden).toBe(true);
    handle.destroy();
  });

  it('失败不假亮：宿主拒（not-found）⇒ 开关保持原态＋行内可见报错（fail-visible）', async () => {
    const { bridge, state } = mcpBridge({
      servers: ['on-srv'],
      configs: [{ id: 'on-srv', transport: 'stdio', command: 'npx' }], // 缺键＝启用
      tools: [],
    }, () => 'mcp-server-not-found: on-srv');
    setHostBridge(bridge);
    const handle = createSettingsPanel({});
    document.body.appendChild(handle.container);
    handle.open('mcp');
    await flushOneTick();

    const sw = handle.container.querySelector('.studio-mcp-server-item .studio-switch') as HTMLDivElement;
    expect(sw.classList.contains('on')).toBe(true); // 缺键台点亮
    sw.click(); // 用户点「关」
    await flushOneTick();

    // 不假亮：开关仍亮（未发生本地乐观翻转）；盘上态未被写（桩因 setFail 未翻）
    expect(sw.classList.contains('on')).toBe(true);
    expect(state.configs[0]!.enabled).toBeUndefined();
    // 报错可见：挂在行内、文案带宿主错误码、hidden=false
    const hint = handle.container.querySelector('.studio-mcp-server-item .studio-mcp-toggle-hint') as HTMLDivElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('mcp-server-not-found: on-srv');
    expect(hint.textContent).toContain('on-srv');
    handle.destroy();
  });
});
