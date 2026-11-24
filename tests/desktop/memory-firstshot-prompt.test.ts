// @vitest-environment node
import { describe, expect, it } from 'vitest';

/**
 * ㊿-c-补⑧（2026-11-25 出资人实测卡）：memory_save「轮首抢跑」——提示词自身在教模型抢跑。
 *
 * 现场：出资人问「当前可用的 skill 和 mcp 有哪些」，模型轮首第一枚调用就是
 * memory_save（占位串 {"type":"user","name":"测试","content":"测试","tags":["test"]}）
 * ⇒ 被闸拒（memory-save-needs-explicit-instruction）。根因是 `main-world-interceptor.ts`
 * 提示词常量两处自相矛盾：
 *   ① 工具调用示例段给了一枚 memory_save「标准示范」（示范即抢跑样板）；
 *   ② 扩展能力段写「长期记忆（保存…）……主动使用、无需先询问」，与
 *   ③ 记忆保存规则「只有明确要求才调用」打架；
 *   ④ 目录行 memory_save 无「仅限明确要求」限定。
 *
 * 修法四处判据（卡面）：
 *   ① 示例段移除 memory_save 示范（换中性 search_files），capabilityPromptText 无 <memory_save> 标签；
 *   ② 扩展能力段第三条收紧为「仅当用户明确…才调用 memory_save」；
 *   ③ 首段＋续跑目录两枚 memory_save 行都带「仅限用户明确要求时调用」限定，
 *      且 toolCatalogNames 提取出的名字集合不变（memory_save 仍在目录里，加限定不动 name 提取正则）。
 *
 * 负控（仓外副本树 logs/ui-memory-firstshot-negctl/）：把扩展能力第三条改回旧措辞
 * （「保存用户身份…跨会话信息」/「主动使用…无需先询问」）⇒ ② 格必红；还原复绿，
 * 真树 SHA256 前后逐字相等。
 */

import {
  capabilityPromptText,
  catalogText,
  toolCatalogNames,
} from '../../src/inject/main-world-interceptor';

/** 取某枚 `- <name> — ...` 目录行（两处目录同款），取不到返空串。 */
function memorySaveLine(text: string): string {
  return text.split('\n').find((l) => l.startsWith('- memory_save')) ?? '';
}

describe('㊿-c-补⑧ memory_save 轮首抢跑·提示词四处改', () => {
  it('① 示例段不再示范 memory_save（换中性 search_files），capabilityPromptText 无 <memory_save> 标签', () => {
    const prompt = capabilityPromptText();
    expect(prompt).not.toContain('<memory_save>');
    // 换进去的中性示例在位（合法 JSON、合法标签），旧占位示范「测试」串不残留。
    expect(prompt).toContain('<search_files>{"operation":"list","root":"E:/Users/name","limit":10}</search_files>');
    expect(prompt).not.toContain('"name":"测试"');
  });

  it('② 扩展能力段第三条收紧为「仅当用户明确…才调用 memory_save」，消除与记忆规则的矛盾', () => {
    const prompt = capabilityPromptText();
    // 关键限定短语在位（负控靶心：把这一条改回旧宽松措辞 ⇒ 本断言红）。
    expect(prompt).toContain('仅当用户明确说“记住 / 记一下 / 别忘了”时才调用 memory_save');
    // 且不再让「主动使用…无需先询问」这条通用引导直接罩住长期记忆（长期记忆一条已收紧，
    // 不再出现旧的「长期记忆（保存…）」宽松句）。
    expect(prompt).not.toContain('长期记忆（保存用户身份、偏好、技术栈、项目决策等跨会话信息）');
  });

  it('③ 首段＋续跑目录两枚 memory_save 行都带限定语，且 toolCatalogNames 名字集合不变（含 memory_save）', () => {
    const capLine = memorySaveLine(capabilityPromptText());
    const catLine = memorySaveLine(catalogText());
    // 两处逐字一致（M1.5 护栏：防两份手工文本脱节漂移）。
    expect(capLine).toBe(catLine);
    // 两处都带「仅限用户明确要求时调用」限定。
    expect(capLine).toContain('仅限用户明确要求时调用');
    expect(catLine).toContain('仅限用户明确要求时调用');
    // 加限定不动 name 提取正则：memory_save 仍在目录里，首段与续跑目录名字集合一致且 10 枚齐全。
    const capNames = toolCatalogNames(capabilityPromptText());
    const catNames = toolCatalogNames(catalogText());
    expect(capNames).toContain('memory_save');
    expect(catNames).toContain('memory_save');
    expect([...capNames].sort()).toEqual([...catNames].sort());
    expect(capNames).toHaveLength(10);
  });
});
