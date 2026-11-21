// @vitest-environment jsdom
/**
 * 设置弹窗「技能」tab 启用开关（PM 卡 2026-11-21，出资人 0.14.28 实测补口：
 * 同一弹窗里 MCP 有开关、技能没有）。与 MCP tab 完全同构，不许自创范式：
 *   - 回显源＝宿主 `skill.list` 的 `enabled`（缺键＝启用）；
 *   - 点击调 `skill.enabled.set {id, enabled}`，**`r.ok` 才重拉 `skill.list`**
 *     （真源在宿主，零乐观翻转——不许先翻本地态再回滚）；
 *   - 失败：开关保持原态（不假亮）＋行内 `studio-skill-toggle-hint` 可见报错
 *     （独立类名，不占 `.studio-form-hint` 的 ui-dead-event-sweep 用例）。
 *
 * 负控靶心：仓外副本树 `logs/ui-skills-tab-negctl/` 单点插入「成功前乐观翻转」
 * ⇒ ③ 格（失败不假亮）必须红。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSettingsPanel } from '../../src/ui/studio-settings-panel';
import { setHostBridge, globalState, type StudioHostBridge } from '../../src/ui/studio-ui-core';

const deadBridge: StudioHostBridge = {
  sendToolCall: async () => ({ ok: false, error: 'dead-bridge' }),
  log: () => {},
};

function flushOneTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface SkillShape {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
}

/**
 * 可控宿主桩：`skill.list` 回当前盘上态；`skill.enabled.set` 默认真翻盘上态
 * （模拟宿主落盘＋键整删语义），`failSet` 置位时回 ok:false（不落盘）。
 */
function skillsBridge(initial: SkillShape[], failSet?: boolean): {
  bridge: StudioHostBridge;
  state: SkillShape[];
  calls: string[];
} {
  const state: SkillShape[] = initial.map((s) => ({ ...s }));
  const calls: string[] = [];
  const bridge: StudioHostBridge = {
    sendToolCall: async (req) => {
      calls.push(req.invocationName);
      switch (req.invocationName) {
        case 'skill.list':
          return { ok: true, data: { dir: '/tmp/skills', skills: state.map((s) => ({ ...s })) } };
        case 'skill.enabled.set': {
          if (failSet) return { ok: false, error: 'skill-enabled-set: denied (stub)' };
          const p = req.params as { id?: string; enabled?: boolean };
          const skill = state.find((s) => s.id === p.id);
          if (!skill) return { ok: false, error: `skill-not-found: ${p.id}` };
          if (p.enabled === false) skill.enabled = false;
          else delete skill.enabled; // 缺键＝启用（键整删语义，不留 enabled:true）
          return { ok: true, data: { id: p.id, enabled: p.enabled ?? true } };
        }
        case 'skill.dir.set':
          return { ok: true, data: null };
        case 'settings.get':
          return { ok: true, data: null };
        default:
          return { ok: true, data: null };
      }
    },
    log: () => {},
  };
  return { bridge, state, calls };
}

afterEach(() => {
  setHostBridge(deadBridge);
  document.body.innerHTML = '';
  globalState.skills = [];
});

/** 挂载并打开技能 tab：`open()` 自动 `fetchSkills()`（宿主真源首帧回显，L847 注释口径）。 */
async function openSkillsPanel(): Promise<{ handle: ReturnType<typeof createSettingsPanel>; skillsTab: HTMLElement }> {
  const handle = createSettingsPanel({});
  document.body.appendChild(handle.container);
  handle.open('skills');
  const skillsTab = handle.container.querySelector('[data-tab-panel="skills"]') as HTMLElement;
  await flushOneTick();
  return { handle, skillsTab };
}

function skillRows(tab: HTMLElement): HTMLElement[] {
  return Array.from(tab.querySelectorAll('.studio-mcp-server-item'));
}

describe('设置弹窗「技能」tab：启用开关（2026-11-21）', () => {
  it('① 回显走宿主 skill.list 的 enabled：`enabled:false` 台熄灭、缺键台点亮（缺键＝启用）', async () => {
    const { bridge } = skillsBridge([
      { id: 'a', name: 'Alpha', description: 'off skill', enabled: false },
      { id: 'b', name: 'Beta', description: 'default skill' },
    ]);
    setHostBridge(bridge);
    const { handle, skillsTab } = await openSkillsPanel();

    const rows = skillRows(skillsTab);
    expect(rows.length).toBe(2);
    const swA = rows[0]!.querySelector('.studio-switch') as HTMLDivElement;
    const swB = rows[1]!.querySelector('.studio-switch') as HTMLDivElement;
    expect(swA.classList.contains('on')).toBe(false);
    expect(swB.classList.contains('on')).toBe(true);
    // 开关肉眼可见判据（不许 0 尺寸 div）：`.studio-switch` 有全局 baseStyles 定尺寸，
    // 这里钉「行内 actions 容器里确实挂着开关元素」这一结构事实。
    expect(rows[0]!.querySelector('.studio-mcp-server-actions .studio-switch')).toBeTruthy();
    handle.destroy();
  });

  it('② 成功路径：调 skill.enabled.set 后**重拉 skill.list**（调用总次数 2），开关按宿主新态渲染', async () => {
    const { bridge, state, calls } = skillsBridge([
      { id: 'a', name: 'Alpha', description: 'off skill', enabled: false },
    ]);
    setHostBridge(bridge);
    const { handle, skillsTab } = await openSkillsPanel();
    // open() 首帧那一枚 skill.list 已计数
    expect(calls.filter((c) => c === 'skill.list').length).toBe(1);

    const sw = skillRows(skillsTab)[0]!.querySelector('.studio-switch') as HTMLDivElement;
    sw.click();
    await flushOneTick();

    // 宿主盘上态已翻（键整删：缺键＝启用，不写 enabled:true）
    expect(state[0]!.enabled).toBeUndefined();
    // 重拉过（总次数 2），且开关按宿主新态渲染为「on」
    expect(calls.filter((c) => c === 'skill.list').length).toBe(2);
    const swAfter = skillRows(skillsTab)[0]!.querySelector('.studio-switch') as HTMLDivElement;
    expect(swAfter.classList.contains('on')).toBe(true);
    const hint = skillRows(skillsTab)[0]!.querySelector('.studio-skill-toggle-hint') as HTMLDivElement;
    expect(hint.hidden).toBe(true);
    handle.destroy();
  });

  it('③ 失败不假亮：宿主拒（ok:false）⇒ 不重拉 skill.list、开关保持原态、hint 可见（靶心）', async () => {
    const { bridge, calls } = skillsBridge([
      { id: 'b', name: 'Beta', description: 'default skill' }, // 缺键＝启用
    ], true);
    setHostBridge(bridge);
    const { handle, skillsTab } = await openSkillsPanel();
    expect(calls.filter((c) => c === 'skill.list').length).toBe(1);

    const sw = skillRows(skillsTab)[0]!.querySelector('.studio-switch') as HTMLDivElement;
    expect(sw.classList.contains('on')).toBe(true);
    sw.click(); // 用户点「关」
    await flushOneTick();

    // 不假亮：开关仍亮（未发生本地乐观翻转、未被重渲）
    expect(sw.classList.contains('on')).toBe(true);
    // 失败路径**不得**重拉 skill.list（回显源纪律：只有成功才刷新）
    expect(calls.filter((c) => c === 'skill.list').length).toBe(1);
    // 报错可见：挂在行内、文案带宿主错误与技能名、hidden=false
    const hint = skillRows(skillsTab)[0]!.querySelector('.studio-skill-toggle-hint') as HTMLDivElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('Beta');
    expect(hint.textContent).toContain('skill-enabled-set: denied');
    handle.destroy();
  });
});
