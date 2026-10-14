/**
 * v0.25：SlotRuntime 人设工具白名单测试
 *
 * 核心断言是「两条工具路径的不对称」：
 *   - 页面驱动工具（chat-read/insert/send）永不拒——引擎靠它们跟页面通信，
 *     过滤掉它们引擎就死了；
 *   - 模型发起工具按 persona.tools 白名单过滤，拒绝码固定
 *     tool-not-allowed-by-persona（与 consent-denied / unknown-tool 区分）。
 *
 * 另一条红线：白名单只是「拒绝」，命中后仍委托 invokeTool——授权链与同意闸门不被绕过。
 * 所以本测试会断言「放行的工具确实调到了 invokeTool」。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PAGE_DRIVING_TOOLS,
  REASON_TOOL_NOT_ALLOWED,
  createPersonaExecutor,
  renderPersonaBlock,
  renderTaskText,
} from '../../src/host/bot/slot-runtime';
import type { Persona } from '../../src/host/bot/types';

function persona(overrides: Partial<Persona> = {}): Persona {
  return { name: 'audit-expert', prompt: '你是审计专家。', tools: ['file.read'], memoryDir: '/tmp/x', ...overrides };
}

describe('createPersonaExecutor —— 人设工具白名单', () => {
  it('非白名单工具被拒，reason 固定为 tool-not-allowed-by-persona', async () => {
    const invokeTool = vi.fn();
    const exec = createPersonaExecutor({ botId: 'b1', whitelist: new Set(['file.read']), invokeTool });

    const r = await exec('shell.exec', { command: 'rm -rf /' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(REASON_TOOL_NOT_ALLOWED);
    expect(r.isError).toBe(true);
    // 拒绝发生在白名单层，根本不该到 invokeTool（授权链也不该被触碰）
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it('白名单工具放行，且确实委托 invokeTool（不绕过授权链）', async () => {
    const invokeTool = vi.fn(async () => ({ ok: true, data: { stdout: 'ok' } }));
    const exec = createPersonaExecutor({ botId: 'b1', whitelist: new Set(['file.read']), invokeTool });

    const r = await exec('file.read', { path: '/etc/hosts' });
    expect(r.ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledTimes(1);
    // botId 必须透传——否则多窗口寻址失效
    expect(invokeTool).toHaveBeenCalledWith('file.read', { path: '/etc/hosts' }, 'b1');
  });

  it('页面驱动工具不受白名单限制（引擎↔页面通信通道，必须始终可用）', async () => {
    const invokeTool = vi.fn(async () => ({ ok: true }));
    const exec = createPersonaExecutor({ botId: 'b1', whitelist: new Set(['file.read']), invokeTool });

    for (const tool of PAGE_DRIVING_TOOLS) {
      const r = await exec(tool, {});
      expect(r.ok, `tool ${tool} should be allowed`).toBe(true);
    }
    expect(invokeTool).toHaveBeenCalledTimes(PAGE_DRIVING_TOOLS.size);
  });

  it('白名单为空/缺省 = 继承全部工具（与 v0.23/v0.24 行为一致，直接透传）', async () => {
    const invokeTool = vi.fn(async () => ({ ok: true }));

    for (const whitelist of [new Set<string>(), undefined]) {
      const exec = createPersonaExecutor({ botId: 'b2', whitelist, invokeTool });
      const r = await exec('shell.exec', { command: 'ls' });
      expect(r.ok).toBe(true);
    }
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  it('拒绝结果带给模型看的文本内容（不只是结构化 reason）', async () => {
    const invokeTool = vi.fn();
    const exec = createPersonaExecutor({ botId: 'b1', whitelist: new Set(['file.read']), invokeTool });

    const r = await exec('shell.exec', {});
    expect(r.content).toBeDefined();
    expect(JSON.stringify(r.content!)).toContain('shell.exec');
  });
});

describe('renderPersonaBlock / renderTaskText —— 消息文本渲染', () => {
  it('人设块含人设名与 prompt 正文，prompt 为空时返回空串', () => {
    expect(renderPersonaBlock(persona())).toContain('audit-expert');
    expect(renderPersonaBlock(persona())).toContain('你是审计专家');
    expect(renderPersonaBlock(persona({ prompt: '   ' }))).toBe('');
  });

  it('任务文本优先用显式 text，否则从 dimension/target 拼出', () => {
    expect(renderTaskText({ text: '请审查并发安全' })).toBe('请审查并发安全');
    const s = renderTaskText({ dimension: '并发安全', target: '登录链路' });
    expect(s).toContain('并发安全');
    expect(s).toContain('登录链路');
  });

  it('纯 dimension 任务不丢信息（scheduler.assign 的验收用例形态）', () => {
    const s = renderTaskText({ dimension: '并发安全' });
    expect(s).toContain('并发安全');
    expect(s.trim()).not.toBe('');
  });
});
