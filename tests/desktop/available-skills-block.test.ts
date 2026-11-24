// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

/**
 * ㊿-c-补⑦（2026-11-24 出资人实测卡）：「可用技能」提示块。
 *
 * 现场：用户问「当前可用的技能有哪些」，模型没有权威来源（显式块只注入点名技能、
 * 工具目录里没有 skill.list）⇒ 用 python_exec 扫盘，把 `~/.claude/skills`／
 * `~/.codex/skills`（Studio 从不扫描的目录）里的 10 枚技能当可用技能报出来，
 * 与设置（只认 `~/.agents/skills`，仅启用 1–2 枚）矛盾。
 *
 * 修法的四处判据（卡面）：
 *   ① 注入块只含**已启用**技能（禁用项不出现）；
 *   ② 注入块带**目录范围声明**（点名排除 `~/.claude/skills`／`~/.codex/skills`，
 *      `~/.agents/skills` 在范围内）；
 *   ③ **无启用技能** ⇒ 显式「当前没有已启用的技能」，**不是空串**（省略＝模型扫盘）；
 *   ④ `selectExplicitSkills` 的「点名才读」闸门回归：点名才注入、被禁不注入
 *      （㊿-c② 既有断言不得放宽）。
 *
 * 负控（仓外副本树 `logs/ui-skill-listing-negctl/`）：摘目录范围声明 ⇒ ②红；
 * 无启用技能时返回空串（模拟省略）⇒ ③红。
 */

import {
  buildCapabilityPrompt,
  formatAvailableSkillsBlock,
  formatExplicitSkillsBlock,
  selectExplicitSkills,
  setSkillsForTesting,
  type StudioSkillDescriptor,
} from '../../src/inject/main-world-interceptor';

const SKILL_ON: StudioSkillDescriptor = {
  id: 'media-search',
  name: 'media-search',
  description: '影视搜索与追剧推荐',
  skillMdPath: 'C:/Users/lidicn/.agents/skills/media-search/SKILL.md',
};
const SKILL_ON2: StudioSkillDescriptor = {
  id: 'ego-browser',
  name: 'ego-browser',
  description: '浏览器自动化',
  skillMdPath: 'C:/Users/lidicn/.agents/skills/ego-browser/SKILL.md',
  enabled: true,
};
const SKILL_OFF: StudioSkillDescriptor = {
  id: 'adm-auditkit',
  name: 'adm-auditkit',
  description: '审计平台工作流',
  skillMdPath: 'C:/Users/lidicn/.agents/skills/adm-auditkit/SKILL.md',
  enabled: false,
};

afterEach(() => {
  setSkillsForTesting(null);
});

describe('㊿-c-补⑦ 可用技能提示块', () => {
  it('① 注入块只含已启用技能（禁用项不出现），且经 buildCapabilityPrompt 真链路挂载', () => {
    setSkillsForTesting([SKILL_ON, SKILL_ON2, SKILL_OFF]);
    const block = formatAvailableSkillsBlock();
    expect(block).toContain('- media-search（media-search）— 影视搜索与追剧推荐');
    expect(block).toContain('- ego-browser（ego-browser）— 浏览器自动化');
    // 被禁技能不在清单（id 与 name 两形态都不出现）。
    expect(block).not.toContain('adm-auditkit');

    // 真链路：buildCapabilityPrompt 每个发送轮都带这块。
    const prompt = buildCapabilityPrompt('当前可用的技能有哪些');
    expect(prompt).toContain('## 可用技能');
    expect(prompt).toContain('media-search');
    expect(prompt).not.toContain('adm-auditkit');
  });

  it('② 目录范围声明在位：点名排除 ~/.claude/skills 与 ~/.codex/skills，~/.agents/skills 在范围内', () => {
    setSkillsForTesting([SKILL_ON]);
    const block = formatAvailableSkillsBlock();
    expect(block).toContain('~/.agents/skills');
    // 排除声明必须点名这两个非管理目录（防模型再扫到它们）。
    expect(block).toContain('~/.claude/skills');
    expect(block).toContain('~/.codex/skills');
    // 声明在**空清单时也必须在**（见 ③）：范围声明与清单解耦。
    setSkillsForTesting(null);
    const emptyBlock = formatAvailableSkillsBlock();
    expect(emptyBlock).toContain('~/.claude/skills');
    expect(emptyBlock).toContain('~/.codex/skills');
  });

  it('③ 无启用技能 ⇒ 显式「当前没有已启用的技能」，不是空串（省略＝模型扫盘）', () => {
    // 完全无技能。
    setSkillsForTesting(null);
    const block = formatAvailableSkillsBlock();
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('当前没有已启用的技能');
    expect(block).toContain('## 可用技能');

    // 全被禁（currentSkills 非空但无启用项）同口径。
    setSkillsForTesting([SKILL_OFF]);
    const allOff = formatAvailableSkillsBlock();
    expect(allOff).toContain('当前没有已启用的技能');
    expect(allOff).not.toContain('adm-auditkit');
  });

  it('④ selectExplicitSkills 闸门回归：点名才读、被禁不注入（㊿-c② 既有口径不放宽）', () => {
    const skills = [SKILL_ON, SKILL_OFF];
    // 点名（/id 或独立词）⇒ 进显式块。
    expect(selectExplicitSkills('请用 /media-search 找剧', skills).map((s) => s.id)).toEqual(['media-search']);
    const explicitBlock = formatExplicitSkillsBlock('请用 /media-search 找剧', skills);
    expect(explicitBlock).toContain('media-search');
    // 被禁技能即便点名也不注入。
    expect(selectExplicitSkills('用 /adm-auditkit 跑审计', skills)).toEqual([]);
    expect(formatExplicitSkillsBlock('用 /adm-auditkit 跑审计', skills)).toBe('');
    // 未点名 ⇒ 空串（显式块保持「仅点名」语义，与「可用技能」块各管各的）。
    expect(formatExplicitSkillsBlock('随便聊聊', skills)).toBe('');
    // buildCapabilityPrompt 里两块共存、互不串：点名块只在点名时出现。
    setSkillsForTesting(skills);
    const prompt = buildCapabilityPrompt('随便聊聊');
    expect(prompt).toContain('## 可用技能');
    expect(prompt).not.toContain('## 技能（仅限用户明确点名）');
  });
});
