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

  // QD-R2-04：policy.set / workspace.set 原 risk:'read' 会被自动放行——
  // 模型自调一次 policy.set=full 就能拆掉所有同意闸门，等于自授权。
  // 修复后必须是 privileged（≥ insert 阈值 → needsConsent=true）。
  it('QD-R2-04：policy.set / workspace.set 是 privileged，必须用户同意', () => {
    const byId = Object.fromEntries(DEFAULT_TOOL_DEFINITIONS.map((d) => [d.id, d]));
    expect(byId['policy.set'].risk).toBe('privileged');
    expect(byId['workspace.set'].risk).toBe('privileged');
  });
});
