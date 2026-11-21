// @vitest-environment jsdom
/**
 * ㊿-c-补② 技能面板开关落盘回归（studio-skills-panel.ts）：
 * - 点开关 ⇒ 调 `callHostTool('skill.enabled.set', {id, enabled:新值})`（原实现只翻内存，是假开关）；
 * - 成功才更新本地态＋亮灯（落盘成功后才更新本地态）；
 * - 失败保持原态（不许假亮）＋ `.studio-skill-toggle-hint` 可见报错（fail-visible，879e7ac 范式）。
 * 判据＝行为级：摘掉 callHostTool 调用 / 把「成功才更新」改成「乐观先翻」⇒ 假亮格转红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkillsPanel } from '../../src/ui/studio-skills-panel';
import { setHostBridge } from '../../src/ui/studio-ui-core';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const SKILL = {
  id: 'adm-auditkit',
  name: 'ADM-auditkit',
  description: '审计容器',
  skillMdPath: 'C:\\skills\\adm-auditkit\\SKILL.md',
  enabled: true,
};

function makeSkillBridge(overrides: Record<string, () => { ok: boolean; data?: unknown; error?: string }> = {}) {
  const calls: Array<{ invocationName: string; params: Record<string, unknown> }> = [];
  const bridge = {
    sendToolCall: vi.fn(async (req: { callId: string; invocationName: string; params?: Record<string, unknown> }) => {
      calls.push({ invocationName: req.invocationName, params: req.params ?? {} });
      if (overrides[req.invocationName]) return overrides[req.invocationName]();
      switch (req.invocationName) {
        case 'skill.list':
          return { ok: true, data: { dir: 'C:\\skills', skills: [SKILL] } };
        default:
          return { ok: false, error: 'unsupported-in-test' };
      }
    }),
    log: () => undefined,
  };
  return { bridge, calls };
}

async function openPanelWithSkill(overrides?: Record<string, () => { ok: boolean; data?: unknown; error?: string }>) {
  const { bridge, calls } = makeSkillBridge(overrides);
  setHostBridge(bridge);
  const panel = createSkillsPanel();
  document.body.appendChild(panel.container);
  panel.open();
  await flush();
  await flush();
  return { panel, calls };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('㊿-c-补② 技能面板开关落盘', () => {
  it('点开关关 ⇒ 发 skill.enabled.set{id, enabled:false}；成功才熄灯（落盘成功后才更新本地态）', async () => {
    const { panel, calls } = await openPanelWithSkill({
      'skill.enabled.set': () => ({ ok: true, data: { id: SKILL.id, enabled: false } }),
    });
    const toggle = panel.container.querySelector('.studio-switch') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.classList.contains('on')).toBe(true); // skill.list enabled:true ⇒ 初始亮
    toggle.click();
    await flush();
    const setCall = calls.find((c) => c.invocationName === 'skill.enabled.set');
    expect(setCall).toBeDefined();
    expect(setCall!.params).toMatchObject({ id: SKILL.id, enabled: false });
    expect(toggle.classList.contains('on')).toBe(false); // 成功 ⇒ 熄灯
  });

  it('skill.enabled.set 失败 ⇒ 保持亮（不假亮）＋ .studio-skill-toggle-hint 可见报错（含错误码）', async () => {
    const { panel, calls } = await openPanelWithSkill({
      'skill.enabled.set': () => ({ ok: false, error: 'denied-by-consent' }),
    });
    const toggle = panel.container.querySelector('.studio-switch') as HTMLElement;
    expect(toggle.classList.contains('on')).toBe(true);
    toggle.click();
    await flush();
    expect(calls.some((c) => c.invocationName === 'skill.enabled.set')).toBe(true); // 确实发起了
    expect(toggle.classList.contains('on')).toBe(true); // 失败 ⇒ 不假亮，保持原态
    const hint = panel.container.querySelector('.studio-skill-toggle-hint') as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('技能开关设置失败');
    expect(hint.textContent).toContain('denied-by-consent');
  });
});
