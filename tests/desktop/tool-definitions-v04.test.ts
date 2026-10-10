/**
 * v0.4 工具定义表测试：chat-* 已登记且风险分级正确，origin 白名单仅放行 DeepSeek 聊天页。
 */

import { DEFAULT_TOOL_DEFINITIONS, DEEPSEEK_ORIGIN } from '../../src/host/tool-definitions';
import { createToolRegistry } from '../../src/host/tool-registry';

describe('v0.4 工具定义', () => {
  it('chat-* 已登记且风险分级正确', () => {
    const byId = Object.fromEntries(DEFAULT_TOOL_DEFINITIONS.map((d) => [d.id, d]));
    expect(byId['echo'].risk).toBe('read');
    expect(byId['chat-read'].risk).toBe('read');
    expect(byId['chat-insert'].risk).toBe('insert');
    expect(byId['chat-send'].risk).toBe('send');
  });

  it('origin 白名单仅放行 DeepSeek 聊天页', () => {
    const reg = createToolRegistry(DEFAULT_TOOL_DEFINITIONS);
    expect(reg.isOriginAllowed('chat-send', DEEPSEEK_ORIGIN)).toBe(true);
    expect(reg.isOriginAllowed('chat-send', 'https://evil.example.com')).toBe(false);
  });
});
