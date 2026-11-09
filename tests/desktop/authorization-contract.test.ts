// @vitest-environment node
/**
 * A1 契约测试：工具审批分级与 full 语义（交接单_20261026 §4）。
 *
 * 这一层只锁"数据契约"：每个工具必须显式归类、归类必须与批准的基准表一致。
 * full 档放行所有已登记工具，但仍受 hard-deny / policy deny / 未知工具约束；
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
  // C1 P1 安全批 TD-01：search_files 由 none 提为 mode ——
  // 它的 root 是一次递归遍历入口，与 file.list 同构，原来零审批 + root 直通 = 越界搜盘。
  search_files: 'mode',
  // always：静态分类为高风险；非 full 档要新鲜人工确认，full 档由运行时统一放行
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
  // C1 P1 安全批 R2-02：mcp.get 由 none 提为 always ——
  // 它原样返回含 env/headers 明文的配置，零审批 = 模型调一次就把密钥送进模型上下文。
  'mcp.get': 'always',
  // none：只读/低风险，自动放行
  echo: 'none',
  'chat-read': 'none',
  'skill.list': 'none',
  web_fetch: 'none',
  web_search: 'none',
  'memory.save': 'none',
  'mcp.list': 'none',
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

  it('静态 requiresApproval 仍区分 always / none；full 放行由 A2 运行时验证', () => {
    const stillAsks = DEFAULT_TOOL_DEFINITIONS.filter((d) => requiresApproval(d)).map((d) => d.id);
    for (const id of Object.keys(BASELINE)) {
      if (BASELINE[id] === 'always') expect(stillAsks, `${id} 的静态分类仍应为需确认`).toContain(id);
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

  it('设置面板 full 文案不再声称"所有工具调用自动执行"，新语义＝不再询问＋安全硬规则直接拒绝', () => {
    const src = readFileSync(resolve(root, 'src/ui/studio-settings-panel.ts'), 'utf8');
    // 旧假话不许回流
    expect(src).not.toContain('所有工具调用自动执行');
    // 新语义：不再询问（卡 H/I 后 full 档语义更正）
    expect(src).toMatch(/full: '[^']*不再询问[^']*'/);
    const fullLine = src.split(/\r?\n/).find((l) => l.trim().startsWith("full: '"));
    expect(fullLine).toBeDefined();
    expect(fullLine).toContain('不再询问');
    // 安全硬规则仍直接拒绝
    expect(fullLine).toMatch(/安全硬规则|策略拒绝/);
  });

  it('设置面板 full 文案必须写明仍需确认的两种情况（出工作区／彻底删除记忆）——防"唯一例外"漏项', () => {
    const src = readFileSync(resolve(root, 'src/ui/studio-settings-panel.ts'), 'utf8');
    const fullLine = src.split(/\r?\n/).find((l) => l.trim().startsWith("full: '"));
    expect(fullLine, 'full: 行未找到').toBeDefined();
    // 依据 authorization.ts:325-327 的 !outsideRequested ⇒ full 档越界仍逐次 ask
    expect(fullLine).toContain('出工作区');
    // memory.purge 在 FULL_MODE_STILL_ASKS 常量里、full 档仍需人工确认
    expect(fullLine).toContain('彻底删除记忆');
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

/**
 * isHighRiskConsent 源码结构锁（2026-11-08 终版：四条判据，Gate 结构锁＋Core 行为真值表互补）。
 *
 * 背景：旧第 5 条把 UI 形态字段 hideAllowSession（按钮显隐开关，consent.ts:276-281）
 * 当风险判据（语义挪用）；旧第 4 条 allowedGrantScopes.includes('allow-session') 是哑判据（恒不命中）。
 * 终版四条判据：outside／hardRule／allowConversation／riskFlags 非空。
 * 形态/展示/时效字段一律不得进判据。
 *
 * 本锁＝源码结构锁（文本取段＋正/负断言），与 Core 新文件的行为真值表互补：
 * Gate 锁"结构有没有被改坏"（判据在/不在），Core 锁"运行时行为对不对"（真值表）。
 */
describe('A1 · isHighRiskConsent 源码结构锁（四条判据在、形态/展示字段不在）', () => {
  const root = resolve(__dirname, '../..');
  const hostSrc = readFileSync(resolve(root, 'src/host/desktop-host.ts'), 'utf8');
  const contractSrc = readFileSync(resolve(root, 'src/shared/consent-contract.ts'), 'utf8');
  const consentSrc = readFileSync(resolve(root, 'src/ui/consent.ts'), 'utf8');

  /** 取出 isHighRiskConsent 函数体（花括号配平，不用 'return false;\n  }' 那个跨模块撞串） */
  function extractFn(src: string): string {
    const marker = 'function isHighRiskConsent(';
    const start = src.indexOf(marker);
    expect(start, 'isHighRiskConsent not found in desktop-host.ts').toBeGreaterThanOrEqual(0);
    const rest = src.slice(start);
    const open = rest.indexOf('{');
    expect(open, 'isHighRiskConsent 函数体起始 { 未找到').toBeGreaterThanOrEqual(0);
    let depth = 0;
    let end = -1;
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    expect(end, 'isHighRiskConsent 函数体闭合 } 未找到').toBeGreaterThanOrEqual(0);
    return rest.slice(0, end + 1);
  }

  const fn = extractFn(hostSrc);

  it('锁① 四条正判据＋三条负断言＋ConsentMeta 字段锁', () => {
    // 四条正判据（负控＝删任一条 ⇒ 对应 toContain 红）
    expect(fn).toContain('meta.outside === true');
    expect(fn).toContain('meta.hardRule');
    expect(fn).toContain('meta.allowConversation === true');
    expect(fn).toContain('meta.riskFlags');
    // 负断言①：hideAllowSession（UI 形态字段）不得进判据（负控＝把旧第 5 条加回必红）
    expect(fn, 'isHighRiskConsent 含 hideAllowSession——旧第 5 条（语义挪用）回流').not.toContain('hideAllowSession');
    // 负断言②：riskLabel/riskFlagLabels（展示字段）不得进判据（负控＝加回必红）
    expect(fn, 'isHighRiskConsent 含 riskLabel——展示字段进判据（本案病根）').not.toContain('riskLabel');
    // 负断言③：哑值 'allow-session' 不得再用（负控＝改回哑值必红）
    expect(fn, "isHighRiskConsent 含哑值 'allow-session'——哑判据回流").not.toContain("'allow-session'");
    // ConsentMeta 须含 riskFlags 字段（防删回去）
    expect(contractSrc, 'ConsentMeta 缺 riskFlags 字段').toMatch(/riskFlags\s*\??:/);
  });

  it('锁①b highRiskAllowedDecisions 同族清扫：哑判据不得回流', () => {
    // 2026-11-08 同族清扫（Core）：原实现用 `meta.allowedGrantScopes.includes('allow-session')`
    // 决定是否给 `allow-session` —— 把 **ConsentDecision 值**（'allow-session'）当 **GrantScope 名**
    // （'session'）在找，结构上恒不命中（consent-contract.ts:16 vs :83）。与 isHighRiskConsent 旧第
    // 4/5 条同型：拿「时效/形态」字段当判据。已删，且**不做** includes('session') 的"修好"——那等于
    // 让原生框发会话级授权，与 native-consent.ts:16-17「长时效必须回页端模态走 nonce」冲突。
    const marker = 'function highRiskAllowedDecisions(';
    const start = hostSrc.indexOf(marker);
    expect(start, 'highRiskAllowedDecisions not found in desktop-host.ts').toBeGreaterThanOrEqual(0);
    const rest = hostSrc.slice(start);
    const open = rest.indexOf('{');
    let depth = 0;
    let end = -1;
    for (let i = open; i < open + 4000 && i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    expect(end, 'highRiskAllowedDecisions 函数体闭合 } 未找到').toBeGreaterThanOrEqual(0);
    const body = rest.slice(0, end + 1);

    // 基线：恒给「允许一次 / 拒绝」
    expect(body).toContain("['allow-once', 'deny']");
    // 事实字段仍在（allowConversation 不是挪用，保留）
    expect(body).toContain('meta.allowConversation === true');
    expect(body).toContain("out.push('allow-conversation')");
    // 负控①：哑判据回流 ⇒ 红（把 includes('allow-session') 加回必红）
    expect(body, '哑判据回流：又把 ConsentDecision 值当 GrantScope 名在 allowedGrantScopes 里找')
      .not.toContain('allowedGrantScopes');
    // 负控②：任何 'allow-session' 决策项不得再出现在本函数体（负控＝加回必红）
    expect(body, "highRiskAllowedDecisions 又给出 'allow-session'（长时效不得回原生框）")
      .not.toContain("'allow-session'");
  });

  it('锁② hideAllowSession 语义链：源＝desktop-host.ts:1872 赋值、消费＝consent.ts 按钮显隐', () => {
    // 源：desktop-host.ts:1872 赋值形态——从 grantScopes 派生（工具是否支持会话级放行）
    expect(hostSrc).toContain("hideAllowSession: !allowed.includes('session')");
    // 消费：consent.ts 用它决定是否渲染「本次会话允许」按钮（UI 渲染开关）
    expect(consentSrc).toContain('meta?.hideAllowSession');
    expect(consentSrc).toContain('ds-consent-allow-session');
    // hideAllowSession=true（不支持 session）→ 只渲染 allowOnce + deny
    expect(consentSrc).toContain('actions.append(btnAllowOnce, btnDeny)');
    // hideAllowSession=false（支持 session）→ 渲染 allowOnce + deny + allowSession
    expect(consentSrc).toContain('actions.append(btnAllowOnce, btnDeny, btnAllowSession)');
  });
});
