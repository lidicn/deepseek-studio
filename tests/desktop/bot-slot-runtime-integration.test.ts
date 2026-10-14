/**
 * v0.25：SlotRuntime ↔ Scheduler 集成测试
 *
 * 路线图验收标准：
 *   scheduler.assign({ slot:'S1', persona:'audit-expert', task:{dimension:'并发安全'} })
 *   能跑通——Bot 加载人设、收到任务、在对应窗口执行。
 *
 * 这里用真实 Scheduler + 真实 createBotRegistry（含真实 AgentLoop + 假引擎），
 * 只把 persona/slot 注册表换成内存假实现——焦点是「装配是否接对了」，不是文件系统。
 * 与 CB 的 bot-slot-scheduler.test.ts 互补：那边验文件系统 PersonaRegistry，这边验运行时接线。
 */

import { describe, expect, it, vi } from 'vitest';
import { createBotRegistry } from '../../src/host/bot/registry';
import { Scheduler } from '../../src/host/bot/scheduler';
import { createSlotRuntime, REASON_TOOL_NOT_ALLOWED, renderPersonaBlock, renderTaskText } from '../../src/host/bot/slot-runtime';
import type { ToolExecutionResult } from '../../src/host/desktop-host';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';
import type { Persona, PersonaRegistry, Slot, SlotRegistry } from '../../src/host/bot/types';

const PERSONA: Persona = {
  name: 'audit-expert',
  prompt: '你是并发安全审计专家，专注于竞态条件与资源泄漏。',
  tools: ['file.read', 'file.stat'],
  memoryDir: '/tmp/memory',
};

/** 假 PersonaRegistry：只认 audit-expert。 */
class FakePersonaRegistry implements PersonaRegistry {
  async load(name: string): Promise<Persona> {
    if (name === 'audit-expert') return PERSONA;
    throw new Error(`persona not found: ${name}`);
  }
  list(): string[] {
    return ['audit-expert'];
  }
}

/** 假 SlotRegistry：固定 S1 一个工作槽。 */
class FakeSlotRegistry implements SlotRegistry {
  private slots: Slot[];
  private loaded = new Map<string, string>();

  constructor(slotId = 'S1') {
    this.slots = [{ id: slotId, accountId: 'A1', state: 'idle' }];
  }
  list(): Slot[] {
    return this.slots.map((s) => ({ ...s, loadedPersona: this.loaded.get(s.id) }));
  }
  get(id: string): Slot | undefined {
    const s = this.slots.find((x) => x.id === id);
    return s ? { ...s, loadedPersona: this.loaded.get(id) } : undefined;
  }
  bindAccount(): void {}
  setState(slotId: string, state: 'idle' | 'busy', runId?: string): void {
    const s = this.slots.find((x) => x.id === slotId);
    if (!s) throw new Error(`slot not found: ${slotId}`);
    s.state = state;
    s.currentRunId = runId;
  }
  setLoadedPersona(slotId: string, personaName: string | undefined): void {
    if (personaName) this.loaded.set(slotId, personaName);
    else this.loaded.delete(slotId);
  }
}

/** 假引擎：记录收到的消息文本，返回空回复（AgentLoop 据此推进）。 */
function makeRecordingEngine(): { engine: ModelEngine; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    engine: {
      name: 'web',
      async health() {
        return { ok: true };
      },
      async send(text: string): Promise<EngineSendResult> {
        sent.push(text);
        return { content: '', toolCalls: 0 };
      },
    },
  };
}

function setup() {
  const { engine, sent } = makeRecordingEngine();
  const registry = createBotRegistry({
    createEngine: () => engine,
    onEvent: () => {},
  });
  const invokeTool = vi.fn(async (): Promise<ToolExecutionResult> => ({ ok: true }));
  const slots = new FakeSlotRegistry('S1');
  const slotRuntime = createSlotRuntime({
    registry,
    personas: new FakePersonaRegistry(),
    invokeTool,
    slots,
    botIdForSlot: () => 'S1',
  });
  const scheduler = new Scheduler({ slots, personas: new FakePersonaRegistry(), runner: slotRuntime.run });
  return { registry, slots, slotRuntime, scheduler, sent, invokeTool, engine };
}

describe('slot-runtime ↔ scheduler 集成', () => {
  it('scheduler.assign 跑通验收用例：占槽→加载人设→执行→释放', async () => {
    const { slots, slotRuntime, scheduler, registry } = setup();
    const bot = await registry.create({ botId: 'S1', slotId: 'S1' });

    const handle = await scheduler.assign({
      slot: 'S1',
      persona: 'audit-expert',
      task: { dimension: '并发安全' },
    });

    // runId 是 scheduler 生成的
    expect(handle.runId).toMatch(/^run-/);
    expect(handle.slotId).toBe('S1');
    expect(handle.persona.name).toBe('audit-expert');

    // 占槽后由 runner 释放（try/finally），结束时回 idle
    expect(slots.get('S1')!.state).toBe('idle');
    expect(slots.get('S1')!.loadedPersona).toBeUndefined();

    // 人设确实加载到了 bot 实例上
    expect(bot.persona?.name).toBe('audit-expert');
    const view = slotRuntime.loaded('S1');
    expect(view?.persona.name).toBe('audit-expert');
    expect(view?.whitelist).toEqual(new Set(['file.read', 'file.stat']));
  });

  it('执行时把人设块 + 任务文本一起发给引擎（带 AGENT_SENTINEL 前缀）', async () => {
    const ctx = setup();
    await ctx.registry.create({ botId: 'S1', slotId: 'S1' });
    await ctx.scheduler.assign({ slot: 'S1', persona: 'audit-expert', task: { dimension: '并发安全' } });

    expect(ctx.sent).toHaveLength(1);
    const msg = ctx.sent[0];
    expect(msg.startsWith('【Studio Agent】')).toBe(true);
    // 人设块与任务都在
    expect(msg).toContain('并发安全审计专家');
    expect(msg).toContain('维度：并发安全');
    // 人设块与任务之间有分隔，模型不会混淆「你是谁」与「现在做什么」
    expect(msg).toContain('\n---\n');
  });

  it('executorFor 返回按人设过滤的执行器；拒绝时 reason 固定', async () => {
    const { registry, slotRuntime, invokeTool } = setup();
    await registry.create({ botId: 'S1', slotId: 'S1' });
    await slotRuntime.loadPersona('S1', 'audit-expert');

    const exec = slotRuntime.executorFor('S1');
    expect(exec).toBeDefined();

    // 白名单内：放行，委托 invokeTool
    expect((await exec!('file.read', { path: '/a' })).ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledTimes(1);
    // 白名单外：拒绝
    const denied = await exec!('shell.exec', { command: 'ls' });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe(REASON_TOOL_NOT_ALLOWED);
    expect(invokeTool).toHaveBeenCalledTimes(1); // 仍是 1 次，没多调
  });

  it('executorFor 对未加载人设 / 未知 bot 返回 undefined（调用方回退 invokeTool）', () => {
    const { slotRuntime } = setup();
    expect(slotRuntime.executorFor('S1')).toBeUndefined();
    expect(slotRuntime.executorFor(undefined)).toBeUndefined();
  });

  it('unloadPersona 清理 persona + 白名单 + executor', async () => {
    const { slotRuntime, registry } = setup();
    const bot = await registry.create({ botId: 'S1', slotId: 'S1' });
    await slotRuntime.loadPersona('S1', 'audit-expert');
    expect(bot.persona).toBeDefined();
    expect(slotRuntime.executorFor('S1')).toBeDefined();

    await slotRuntime.unloadPersona('S1');
    expect(bot.persona).toBeUndefined();
    expect(slotRuntime.loaded('S1')).toBeUndefined();
    expect(slotRuntime.executorFor('S1')).toBeUndefined();
  });

  it('loadPersona 对不存在的 bot 抛错（不静默跳过）', async () => {
    const { slotRuntime } = setup();
    await expect(slotRuntime.loadPersona('nope', 'audit-expert')).rejects.toThrow(/not found: nope/);
  });

  it('人设重复加载幂等（同名重载不报错、白名单保持）', async () => {
    const { slotRuntime, registry } = setup();
    await registry.create({ botId: 'S1', slotId: 'S1' });
    await slotRuntime.loadPersona('S1', 'audit-expert');
    await slotRuntime.loadPersona('S1', 'audit-expert');
    expect(slotRuntime.loaded('S1')!.whitelist).toEqual(new Set(['file.read', 'file.stat']));
  });

  it('空白名单人设 = 继承全部工具（v0.23/v0.24 行为不变）', async () => {
    // 直接构造一个 tools 为空数组的人设（区别于未加载人设）
    const emptyPersona: Persona = { name: 'reader', prompt: '只读角色', tools: [], memoryDir: '/tmp' };
    const reg: PersonaRegistry = { load: async () => emptyPersona, list: () => ['reader'] };
    const invokeTool = vi.fn(async () => ({ ok: true }) as ToolExecutionResult);
    const registry = createBotRegistry({
      createEngine: () => makeRecordingEngine().engine,
      onEvent: () => {},
    });
    const rt = createSlotRuntime({ registry, personas: reg, invokeTool });
    await registry.create({ botId: 'S1', slotId: 'S1' });
    await rt.loadPersona('S1', 'reader');

    // 人设已加载，但白名单为 undefined（继承全部）
    expect(rt.loaded('S1')!.persona.name).toBe('reader');
    expect(rt.loaded('S1')!.whitelist).toBeUndefined();
    // 执行器存在且不放行——直接委托 invokeTool
    const exec = rt.executorFor('S1');
    expect(exec).toBeDefined();
    await exec!('shell.exec', { command: 'ls' });
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it('未注入 slots 时 run 仍可执行（slotRegistry 可选，跳过 runId 对账）', async () => {
    const invokeTool = vi.fn(async () => ({ ok: true }) as ToolExecutionResult);
    const registry = createBotRegistry({
      createEngine: () => makeRecordingEngine().engine,
      onEvent: () => {},
    });
    const rt = createSlotRuntime({ registry, personas: new FakePersonaRegistry(), invokeTool });
    await registry.create({ botId: 'S1', slotId: 'S1' });

    await rt.run({
      runId: 'run-manual',
      slotId: 'S1',
      persona: PERSONA,
      task: { dimension: '并发安全' },
      startedAt: Date.now(),
    });
    // 手动 run 路径也会把人设加载到 bot 上并真正 send
    expect(registry.get('S1')!.persona?.name).toBe('audit-expert');
  });

  it('任务文本为空时 run 抛错（不向页面发空消息）', async () => {
    const { slotRuntime, registry } = setup();
    await registry.create({ botId: 'S1', slotId: 'S1' });
    await expect(
      slotRuntime.run({
        runId: 'run-empty',
        slotId: 'S1',
        persona: PERSONA,
        task: { text: '   ' },
        startedAt: Date.now(),
      }),
    ).rejects.toThrow(/任务文本为空/);
  });

  it('runId 与槽位不符时拒绝执行（防止污染别人的 run）', async () => {
    const { slotRuntime, registry, slots } = setup();
    await registry.create({ botId: 'S1', slotId: 'S1' });
    await slotRuntime.loadPersona('S1', 'audit-expert');
    // 模拟槽位被别的 run 占用
    slots.setState('S1', 'busy', 'run-other');

    await expect(
      slotRuntime.run({
        runId: 'run-mine',
        slotId: 'S1',
        persona: PERSONA,
        task: { dimension: '并发安全' },
        startedAt: Date.now(),
      }),
    ).rejects.toThrow(/run-other/);
  });
});

describe('渲染纯函数', () => {
  it('renderPersonaBlock 产出含人设名与 prompt 的文本块', () => {
    expect(renderPersonaBlock(PERSONA)).toContain('audit-expert');
    expect(renderPersonaBlock(PERSONA)).toContain('竞态条件');
  });

  it('renderTaskText 稳定输出 dimension/target', () => {
    const s = renderTaskText({ dimension: '并发安全', target: '登录链路' });
    expect(s).toContain('维度：并发安全');
    expect(s).toContain('目标：登录链路');
  });
});
