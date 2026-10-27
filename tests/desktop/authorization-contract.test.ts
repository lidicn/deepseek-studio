// @vitest-environment node
/**
 * A1 契约测试：工具审批分级与 full 语义（交接单_20261026 §4）。
 *
 * 这一层只锁"数据契约"：每个工具必须显式归类、归类必须与批准的基准表一致、
 * full 档的免审范围只能覆盖 approvalClass=mode。
 * 运行时判定行为在 A2（tests/desktop/authorization.test.ts）取证。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_DEFINITIONS,
} from '../../src/host/tool-definitions';
import {
  approvalClassOf,
  executionSide,
  requiresApproval,
  type ToolDefinition,
} from '../../src/host/tool-registry';
import {
  APPROVAL_CLASSES,
  CANONICAL_TARGET_KINDS,
  CONSENT_BUTTON_LABELS,
  GRANT_SCOPES,
  type ApprovalClass,
} from '../../src/shared/consent-contract';

/** PM 批准的分级基准表（§1.3）。键为工具 id，值为 [approvalClass, canonicalTargetKind]。 */
const BASELINE: Record<string, ApprovalClass> = {
  // mode：跟随 policyMode，full 下免逐次确认
  'file.read': 'mode',
  'file.write': 'mode',
  'file.edit': 'mode',
  'file.list': 'mode',
  'file.stat': 'mode',
  'shell.exec': 'mode',
  'mcp.test': 'mode',
  // always：任何档位都要新鲜人工确认（含 full）
  'policy.set': 'always',
  'workspace.set': 'always',
  'memory.delete': 'always',
  'memory.purge': 'always',
  'memory.unarchive': 'always',
  'chat-send': 'always',
  // chat-insert 同为页侧写出动作，按 always 收口（bot 内部预授权另标源，见 A3）
  'chat-insert': 'always',
  'python.exec': 'always',
  'consent.whitelist.revoke': 'always',
  'mcp.call': 'always',
  'mcp.save': 'always',
  'mcp.remove': 'always',
  // none：只读/低风险，自动放行
  echo: 'none',
  'chat-read': 'none',
  'skill.list': 'none',
  search_files: 'none',
  web_fetch: 'none',
  web_search: 'none',
  'memory.save': 'none',
  'mcp.list': 'none',
  'mcp.get': 'none',
  'memory.list': 'none',
  'memory.listArchived': 'none',
  'memory.select': 'none',
  'consent.whitelist.list': 'none',
  'settings.get': 'none',
  'project.list': 'none',
  'project.create': 'none',
  'folder.pick': 'none',
};

const byId: Record<string, ToolDefinition> = Object.fromEntries(
  DEFAULT_TOOL_DEFINITIONS.map((d) => [d.id, d]),
);

describe('A1 · 工具审批分级契约', () => {
  it('基准表覆盖当前全部已登记工具，无漏标', () => {
    const ids = DEFAULT_TOOL_DEFINITIONS.map((d) => d.id).sort();
    expect(ids).toEqual(Object.keys(BASELINE).sort());
  });

  it('每个工具的 approvalClass 合法且与基准表一致', () => {
    for (const def of DEFAULT_TOOL_DEFINITIONS) {
      expect(APPROVAL_CLASSES).toContain(def.approvalClass);
      expect(def.approvalClass, `approvalClass of ${def.id}`).toBe(BASELINE[def.id]);
    }
  });

  it('canonicalTargetKind 合法；none 类不声明目标（禁止参与 grant 复用）', () => {
    for (const def of DEFAULT_TOOL_DEFINITIONS) {
      if (def.canonicalTargetKind !== undefined) {
        expect(CANONICAL_TARGET_KINDS, `target kind of ${def.id}`).toContain(def.canonicalTargetKind);
      }
      if (def.approvalClass === 'none') {
        expect(def.canonicalTargetKind, `${def.id} 是 none，不应带 grant 目标`).toBeUndefined();
        expect(def.grantScopes, `${def.id} 是 none，不应带 grant 作用域`).toBeUndefined();
      }
    }
  });

  it('grantScopes 合法，且 never 含 project/global（弹窗不得偷偷创建持久规则）', () => {
    for (const def of DEFAULT_TOOL_DEFINITIONS) {
      for (const scope of def.grantScopes ?? []) {
        expect(GRANT_SCOPES, `${def.id} scope`).toContain(scope);
        expect(['project', 'global'], `${def.id} 不允许在定义表里发放持久规则`).not.toContain(scope);
      }
    }
  });

  it('always 类不得发放 session（§1.4 硬规则 4：只能 once / 精确 temporary）', () => {
    for (const def of DEFAULT_TOOL_DEFINITIONS) {
      if (def.approvalClass !== 'always') continue;
      const scopes = def.grantScopes ?? ['once'];
      expect(scopes, `${def.id} 不能发 session grant`).not.toContain('session');
      expect(scopes, `${def.id} 不能发 turn grant`).not.toContain('turn');
      if (scopes.includes('temporary')) {
        expect(def.canonicalTargetKind, `${def.id} 的 temporary 必须绑定规范目标`).toBeDefined();
      }
    }
  });

  it('mode 类必须绑定规范目标，否则 grant 无从精确命中', () => {
    for (const def of DEFAULT_TOOL_DEFINITIONS) {
      if (def.approvalClass !== 'mode') continue;
      expect(def.canonicalTargetKind, `mode 工具缺规范目标：${def.id}`).toBeDefined();
      expect(def.grantScopes ?? [], `mode 工具至少能发 session：${def.id}`).toContain('session');
    }
  });

  it('宿主侧特权能力的执行侧必须是 host', () => {
    for (const def of DEFAULT_TOOL_DEFINITIONS) {
      if (executionSide(def) !== 'host') continue;
      expect(['mode', 'always', 'none'], `${def.id} 归类非法`).toContain(def.approvalClass);
    }
    for (const id of ['shell.exec', 'file.write', 'python.exec', 'mcp.call']) {
      expect(executionSide(byId[id]!), `${id} 必须宿主执行`).toBe('host');
    }
  });

  it('full 的免审范围恰好等于 mode 类（§1.2）', () => {
    const exemptUnderFull = DEFAULT_TOOL_DEFINITIONS.filter((d) => d.approvalClass === 'mode').map((d) => d.id).sort();
    expect(exemptUnderFull).toEqual(
      ['file.edit', 'file.list', 'file.read', 'file.stat', 'file.write', 'mcp.test', 'shell.exec'].sort(),
    );
    // 逐次确认（requiresApproval）在 full 下仍为真的，必须包含全部 always 工具
    const stillAsks = DEFAULT_TOOL_DEFINITIONS.filter((d) => requiresApproval(d)).map((d) => d.id);
    for (const id of Object.keys(BASELINE)) {
      if (BASELINE[id] === 'always') expect(stillAsks, `${id} 在 full 下仍需确认`).toContain(id);
    }
    for (const d of DEFAULT_TOOL_DEFINITIONS) {
      if (d.approvalClass === 'none') expect(requiresApproval(d), `${d.id} 应自动放行`).toBe(false);
    }
  });
});

describe('A1 · approvalClass fail-closed', () => {
  it('缺字段 / 非法值 / 未知值一律落到 always，绝不回落 mode', () => {
    expect(approvalClassOf({} as ToolDefinition)).toBe('always');
    expect(approvalClassOf({ approvalClass: undefined } as unknown as ToolDefinition)).toBe('always');
    expect(approvalClassOf({ approvalClass: 'mode-ish' } as unknown as ToolDefinition)).toBe('always');
    expect(approvalClassOf({ approvalClass: 'none' })).toBe('none');
    expect(approvalClassOf(undefined)).toBe('always');
  });

  it('注册表入库时归一化：漏标的运行期 register 不会静默免审', async () => {
    const { createToolRegistry } = await import('../../src/host/tool-registry');
    const reg = createToolRegistry();
    reg.register({
      id: 'sneaky',
      title: 'Sneaky',
      description: 'd',
      risk: 'privileged',
      // 故意不写 approvalClass
      allowedOrigins: ['https://chat.deepseek.com'],
    } as unknown as ToolDefinition);
    const stored = reg.get('sneaky')!;
    expect(stored.approvalClass).toBe('always');
    expect(requiresApproval(stored)).toBe(true);
  });
});

describe('A1 · full 文案与 session 文案', () => {
  const root = resolve(__dirname, '../..');

  it('设置面板 full 文案不再声称"所有工具调用自动执行，无需确认"', () => {
    const src = readFileSync(resolve(root, 'src/ui/studio-settings-panel.ts'), 'utf8');
    expect(src).not.toContain('所有工具调用自动执行');
    expect(src).toMatch(/full: '[^']*执行范围放开[^']*'/);
    // 必须同时说清"执行范围放开"与"高风险仍需确认"
    const fullLine = src.split(/\r?\n/).find((l) => l.trim().startsWith("full: '"));
    expect(fullLine).toBeDefined();
    expect(fullLine).toContain('不再逐次确认');
    expect(fullLine).toMatch(/仍需确认|直接拒绝/);
  });

  it('allow-session 按钮文案去掉"10 分钟"（TTL 只属于 temporary）', () => {
    expect(CONSENT_BUTTON_LABELS['allow-session']).toBe('本次会话允许此操作');
    expect(CONSENT_BUTTON_LABELS['allow-session']).not.toMatch(/10\s*分钟/);
  });

  it('policy.ts 头部注释不再声称 full 不询问', () => {
    const src = readFileSync(resolve(root, 'src/host/policy.ts'), 'utf8');
    expect(src).not.toMatch(/full\s+完全放开——不询问/);
    expect(src).toContain('approvalClass');
  });

  it('既有档位标签不变（workspace/auto/full，ask 仍为兼容旧值）', async () => {
    const { POLICY_MODE_LABELS, PANEL_POLICY_MODES, POLICY_MODES } = await import(
      '../../src/shared/policy-contract'
    );
    expect(PANEL_POLICY_MODES).toEqual(['workspace', 'auto', 'full']);
    expect(POLICY_MODES).toContain('ask');
    expect(POLICY_MODE_LABELS.full).toBe('完全放开');
  });
});

describe('A1 · 未登记的宿主能力必须 fail-closed', () => {
  it('未知工具与无 origin 的 grant 都不会被判成"自动放行"', async () => {
    const { createToolRegistry } = await import('../../src/host/tool-registry');
    const reg = createToolRegistry(DEFAULT_TOOL_DEFINITIONS);
    expect(reg.get('file.delete')).toBeUndefined();
    expect(reg.isOriginAllowed('shell.exec', '')).toBe(false);
    expect(reg.isOriginAllowed('shell.exec', 'https://evil.example.com')).toBe(false);
  });
});
