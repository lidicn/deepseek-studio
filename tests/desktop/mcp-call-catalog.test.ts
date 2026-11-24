// @vitest-environment node
import { describe, expect, it } from 'vitest';

/**
 * ㊿-c-补⑨（2026-11-25 出资人实测卡，Verify ㊿-c-补⑧ 复验观察②派生）：
 * mcp_call 目录行占位参数教模型照抄中文占位。
 *
 * 现场：q1 会话（dev 窗真机，v0.14.33）模型连发 12 枚 mcp_call 全 invalid-tool-json——
 * 目录行/「调用方式」示例写的是占位参数，模型把中文占位（「服务器名／工具名」）原样
 * 当 JSON 参数发出。与 ㊿-c-补⑧ memory_save 抢跑同族：提示词自身在教模型照抄。
 *
 * 判据（卡面三格 ＋ 同族根子一格）：
 *   ① mcp_call 行带形态示例（最小合法 JSON、可解析），说明带来源（serverId/tool/args）；
 *   ② 首段＋续跑目录两枚 mcp_call 行逐字一致（防两份手工文本脱节漂移）；
 *   ③ toolCatalogNames 名字集合不变（mcp_call 仍在目录、10 枚齐全）；
 *   ④「调用方式」示例（formatMcpToolsBlock，现场 12×invalid-tool-json 直接根子）
 *      不再含中文占位 服务器名/工具名，改中性 example。
 *
 * 负控（仓外副本树 logs/ui-mcp-call-catalog-negctl/）：摘形态示例＋「调用方式」改回
 * 中文占位 ⇒ ①④ 格必红；还原复绿，真树 SHA256 前后逐字相等。
 */

import {
  buildCapabilityPrompt,
  capabilityPromptText,
  catalogText,
  setMcpToolsForTesting,
  toolCatalogNames,
} from '../../src/inject/main-world-interceptor';

/** 取某枚 `- mcp_call — ...` 目录行（两处目录同款）。 */
function mcpCallLine(text: string): string {
  return text.split('\n').find((l) => l.startsWith('- mcp_call')) ?? '';
}

/** 卡面定稿的最小合法示例 JSON（中性占位、不含真 secret、不含 C:/Users/）。 */
const EXAMPLE_JSON = '{"serverId":"example","tool":"example","args":{}}';

describe('㊿-c-补⑨ mcp_call 目录行占位参数改可执行形态', () => {
  it('① mcp_call 行带形态示例（合法 JSON 可解析）＋说明带来源（serverId/tool/args）', () => {
    const line = mcpCallLine(capabilityPromptText());
    expect(line.length).toBeGreaterThan(0);
    // 形态示例在位，且示例体是合法 JSON（模型可照抄成合法调用，不再吃 invalid-tool-json）。
    expect(line).toContain(EXAMPLE_JSON);
    expect(() => JSON.parse(EXAMPLE_JSON)).not.toThrow();
    // 说明带「来源」：serverId 指设置里启用的 id、tool 指 mcp_list 返回、args 指入参对象。
    expect(line).toContain('serverId');
    expect(line).toContain('mcp_list');
    expect(line).toContain('args');
  });

  it('② 首段＋续跑目录两枚 mcp_call 行逐字一致（防两份手工文本脱节漂移）', () => {
    const capLine = mcpCallLine(capabilityPromptText());
    const catLine = mcpCallLine(catalogText());
    expect(capLine.length).toBeGreaterThan(0);
    expect(catLine.length).toBeGreaterThan(0);
    expect(capLine).toBe(catLine);
    // 两处都带同一枚形态示例。
    expect(capLine).toContain(EXAMPLE_JSON);
    expect(catLine).toContain(EXAMPLE_JSON);
  });

  it('③ toolCatalogNames 名字集合不变：mcp_call 仍在目录、首段与续跑目录同名集且 10 枚齐全', () => {
    const capNames = toolCatalogNames(capabilityPromptText());
    const catNames = toolCatalogNames(catalogText());
    expect(capNames).toContain('mcp_call');
    expect(catNames).toContain('mcp_call');
    expect([...capNames].sort()).toEqual([...catNames].sort());
    expect(capNames).toHaveLength(10);
  });

  it('④「调用方式」示例（formatMcpToolsBlock，现场根子）不再含中文占位 服务器名/工具名，改中性 example', () => {
    setMcpToolsForTesting([{ serverId: 'example-server', name: 'list_shows', description: '示例工具' }]);
    try {
      const prompt = buildCapabilityPrompt('请调用一个工具');
      // 中文占位清零（模型连发 12 枚 invalid-tool-json 的照抄源）。
      expect(prompt).not.toContain('"serverId":"服务器名"');
      expect(prompt).not.toContain('"tool":"工具名"');
      // 中性调用方式示例在位。
      expect(prompt).toContain('调用方式：<mcp_call>{"serverId":"example","tool":"example","args":{...}}</mcp_call>');
    } finally {
      setMcpToolsForTesting(null);
    }
  });
});
