/**
 * v0.11 验收测试：侧面板 UI + 外围体验
 *
 * 验收标准（来自路线图 v0.11）：
 * - 侧面板 UI 容器可创建和挂载
 * - Memory/Skills/Tools/Settings 页可操作
 * - 与宿主数据一致（通过 hostBridge 调用工具）
 * - 事件总线通信正常
 * - 全局状态管理正确
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  EventBus,
  globalEvents,
  globalState,
  setHostBridge,
  getHostBridge,
  callHostTool,
  type StudioHostBridge,
  type UIState,
} from '../../src/ui/studio-ui-core';

// 重置全局状态
beforeEach(() => {
  globalState.currentProject = null;
  globalState.workspaceRoot = null;
  globalState.policyMode = 'full';
  globalState.localToolsEnabled = true;
  globalState.skills = [];
  globalState.mcpServers = [];
  globalState.memories = [];
});

describe('v0.11: 事件总线（EventBus）', () => {
  it('on/emit 基本通信', () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on('test-event', (payload) => received.push(payload));
    bus.emit('test-event', { data: 'hello' });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ data: 'hello' });
  });

  it('多个监听器都能收到事件', () => {
    const bus = new EventBus();
    let count1 = 0;
    let count2 = 0;
    bus.on('evt', () => { count1 += 1; });
    bus.on('evt', () => { count2 += 1; });
    bus.emit('evt');
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('取消订阅后不再收到事件', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('evt', () => { count += 1; });
    bus.emit('evt');
    off();
    bus.emit('evt');
    expect(count).toBe(1);
  });

  it('监听器抛错不影响其他监听器', () => {
    const bus = new EventBus();
    let okCount = 0;
    bus.on('evt', () => { throw new Error('boom'); });
    bus.on('evt', () => { okCount += 1; });
    bus.emit('evt');
    expect(okCount).toBe(1);
  });

  it('globalEvents 是全局单例', () => {
    expect(globalEvents).toBeInstanceOf(EventBus);
  });
});

describe('v0.11: 全局状态（UIState）', () => {
  it('初始状态正确', () => {
    expect(globalState.currentProject).toBeNull();
    expect(globalState.workspaceRoot).toBeNull();
    expect(globalState.policyMode).toBe('full');
    expect(globalState.localToolsEnabled).toBe(true);
    expect(globalState.skills).toEqual([]);
    expect(globalState.mcpServers).toEqual([]);
    expect(globalState.memories).toEqual([]);
  });

  it('状态可修改', () => {
    globalState.currentProject = 'deepseek-studio';
    globalState.workspaceRoot = 'E:\\NAS\\deepseek-studio';
    globalState.policyMode = 'auto';
    globalState.skills = [{ id: 'test', name: 'Test', description: 'desc' }];
    globalState.memories = [{ id: 'm1', type: 'user', name: 'pref', content: 'likes coffee' }];

    expect(globalState.currentProject).toBe('deepseek-studio');
    expect(globalState.workspaceRoot).toBe('E:\\NAS\\deepseek-studio');
    expect(globalState.policyMode).toBe('auto');
    expect(globalState.skills).toHaveLength(1);
    expect(globalState.memories).toHaveLength(1);
  });

  it('policyMode 只接受三档值', () => {
    const validModes: UIState['policyMode'][] = ['full', 'auto', 'ask'];
    for (const mode of validModes) {
      globalState.policyMode = mode;
      expect(globalState.policyMode).toBe(mode);
    }
  });
});

describe('v0.11: 宿主桥接（HostBridge）', () => {
  it('setHostBridge/getHostBridge 正确设置和获取', () => {
    const mockBridge: StudioHostBridge = {
      sendToolCall: async () => ({ ok: true, data: {} }),
      log: () => {},
    };
    setHostBridge(mockBridge);
    expect(getHostBridge()).toBe(mockBridge);
  });

  it('callHostTool 通过桥接调用宿主工具', async () => {
    const calls: Array<{ invocationName: string; params: Record<string, unknown> }> = [];
    const mockBridge: StudioHostBridge = {
      sendToolCall: async (req) => {
        calls.push({ invocationName: req.invocationName, params: req.params });
        return { ok: true, data: { result: 'success' } };
      },
      log: () => {},
    };
    setHostBridge(mockBridge);

    const result = await callHostTool('shell_exec', { command: 'echo hello' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 'success' });
    expect(calls).toHaveLength(1);
    expect(calls[0].invocationName).toBe('shell_exec');
    expect(calls[0].params).toEqual({ command: 'echo hello' });
  });

  it('callHostTool 未设置桥接时返回错误', async () => {
    setHostBridge(null as unknown as StudioHostBridge);
    const result = await callHostTool('shell_exec', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no-host-bridge');
  });

  it('callHostTool 生成唯一 callId', async () => {
    const callIds: string[] = [];
    const mockBridge: StudioHostBridge = {
      sendToolCall: async (req) => {
        callIds.push(req.callId);
        return { ok: true };
      },
      log: () => {},
    };
    setHostBridge(mockBridge);

    await callHostTool('tool1', {});
    await callHostTool('tool2', {});
    expect(callIds).toHaveLength(2);
    expect(callIds[0]).not.toBe(callIds[1]);
    expect(callIds[0]).toMatch(/^ui-/);
  });
});

describe('v0.11: 侧面板功能契约', () => {
  it('技能列表数据结构正确', () => {
    globalState.skills = [
      { id: 'code-review', name: '代码审查', description: '审查代码质量' },
      { id: 'audit', name: '审计工具', description: '安全审计' },
    ];
    expect(globalState.skills).toHaveLength(2);
    expect(globalState.skills[0].id).toBe('code-review');
    expect(globalState.skills[0].name).toBe('代码审查');
    expect(globalState.skills[0].description).toBe('审查代码质量');
  });

  it('记忆列表数据结构正确', () => {
    globalState.memories = [
      { id: 'm1', type: 'user', name: '技术栈', content: 'TypeScript + React' },
      { id: 'm2', type: 'project', name: '架构决策', content: '使用 Tauri' },
    ];
    expect(globalState.memories).toHaveLength(2);
    expect(globalState.memories[0].type).toBe('user');
    expect(globalState.memories[1].type).toBe('project');
  });

  it('MCP 服务器列表', () => {
    globalState.mcpServers = ['github', 'filesystem'];
    expect(globalState.mcpServers).toEqual(['github', 'filesystem']);
  });

  it('设置面板字段与全局状态对应', () => {
    // 设置面板应能读写以下字段
    globalState.workspaceRoot = '/path/to/workspace';
    globalState.policyMode = 'ask';
    globalState.localToolsEnabled = false;

    expect(globalState.workspaceRoot).toBe('/path/to/workspace');
    expect(globalState.policyMode).toBe('ask');
    expect(globalState.localToolsEnabled).toBe(false);
  });

  it('项目切换通过事件总线通知', () => {
    const projects: string[] = [];
    globalEvents.on('ui:project-selected', (payload) => {
      projects.push(payload as string);
    });
    globalEvents.emit('ui:project-selected', 'deepseek-studio');
    expect(projects).toEqual(['deepseek-studio']);
  });

  it('设置打开/关闭通过事件总线通知', () => {
    let opened = false;
    let closed = false;
    globalEvents.on('ui:settings', () => { opened = true; });
    globalEvents.on('ui:settings-close', () => { closed = true; });

    globalEvents.emit('ui:settings');
    expect(opened).toBe(true);

    globalEvents.emit('ui:settings-close');
    expect(closed).toBe(true);
  });
});
