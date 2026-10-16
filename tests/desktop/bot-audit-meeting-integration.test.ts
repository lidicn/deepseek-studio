/**
 * v0.30：审计会议端到端集成测试
 *
 * 全流程：真 BotRegistry + 真 SlotRuntime + 真 Scheduler(FileSlotRegistry) +
 * 真 offline-runner + 真 audit-dispatcher + 真 chat-room-runtime + InMemoryReportStore +
 * scriptedEngine（按 botId 返回审计 JSON）。
 *
 * 验证：@main 审计 触发 → 3 个 audit 槽并行离线执行 → 各自 SubBotReport 落 reportStore
 * → merge → summary.md → report-ready 事件（task-progress/task-complete/report-ready 全链）。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBotRegistry } from '../../src/host/bot/registry';
import { createSlotRuntime } from '../../src/host/bot/slot-runtime';
import { Scheduler } from '../../src/host/bot/scheduler';
import { FileSlotRegistry } from '../../src/host/bot/slot-registry';
import { createOfflineRunExecutor } from '../../src/host/bot/offline-runner';
import { createAuditDispatcher } from '../../src/host/bot/audit-meeting';
import { InMemoryReportStore } from '../../src/host/bot/in-memory-report-store';
import { createChatRoomRuntime } from '../../src/host/bot/chat-room-runtime';
import { createAgentInstructionBuilder } from '../../src/host/bot/instructions';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import { DefaultHandoffParser } from '../../src/host/bot/handoff-parser';
import { SqliteChatMessageStore } from '../../src/host/bot/chat-room-store';
import { SqliteContextEngine, SnapshotStore } from '../../src/host/bot/context-engine';
import { SqliteRoomSummaryService } from '../../src/host/bot/room-summary';
import type { ToolExecutionResult } from '../../src/host/desktop-host';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';
import type { Persona, PersonaRegistry, RoomConfig } from '../../src/host/bot/types';
import type { AgentLoopEvent } from '../../src/host/agent-loop';
import { MemoryStore } from '../../src/host/memory-store';

const PERSONAS: Record<string, Persona> = {
  host: { name: 'host', prompt: '你是主持人。', tools: [], memoryDir: '' },
  'audit-expert': { name: 'audit-expert', prompt: '你是审计专家。', tools: [], memoryDir: '' },
};

class FakePersonaRegistry implements PersonaRegistry {
  async load(name: string): Promise<Persona> {
    const p = PERSONAS[name];
    if (!p) throw new Error(`persona not found: ${name}`);
    return p;
  }
  list(): string[] {
    return Object.keys(PERSONAS);
  }
}

/** scripted engine：按 botId 返回预设回复文本。 */
function makeScriptedEngines() {
  const engines = new Map<string, { engine: ModelEngine; sent: string[]; reply: string }>();
  function forBot(botId: string) {
    let e = engines.get(botId);
    if (!e) {
      const sent: string[] = [];
      e = {
        sent,
        reply: '',
        engine: {
          name: 'web',
          async health() { return { ok: true }; },
          async send(text: string): Promise<EngineSendResult> {
            sent.push(text);
            return { content: e!.reply, toolCalls: 0 };
          },
        },
      };
      engines.set(botId, e);
    }
    return e;
  }
  return {
    engines,
    setReply(botId: string, reply: string) { forBot(botId).reply = reply; },
    ensureEngine: (botId: string) => forBot(botId).engine,
  };
}

const ROOM: RoomConfig = {
  roomId: 'r1',
  roomName: '审计室',
  hostPersona: 'host',
  memberPersonas: ['host'],
};

function auditJson(dimension: string): string {
  return JSON.stringify({
    summary: `${dimension} 审计摘要`,
    findings: [
      {
        id: `F-${dimension}`,
        severity: 'high',
        title: `${dimension} 问题`,
        location: 'src/x.ts:1',
        description: 'desc',
        evidenceRef: 'src/x.ts:1',
      },
    ],
    evidenceRefs: ['src/x.ts:1'],
  });
}

async function setup() {
  const script = makeScriptedEngines();
  const listeners = new Set<(event: AgentLoopEvent) => void>();
  const registry = createBotRegistry({
    createEngine: ({ botId }) => script.ensureEngine(botId),
    onEvent: (event) => {
      for (const cb of listeners) {
        try { cb(event); } catch { /* ignore */ }
      }
    },
  });

  const onAgentEvent = (cb: (event: AgentLoopEvent) => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };

  const invokeTool = vi.fn(async (): Promise<ToolExecutionResult> => ({ ok: true }));
  const slotRuntime = createSlotRuntime({
    registry,
    personas: new FakePersonaRegistry(),
    invokeTool,
  });

  // 预创建 host bot（聊天室成员）+ S1-S5 审计槽 bot。
  await registry.create({ botId: 'host', slotId: 'host' });
  await slotRuntime.loadPersona('host', 'host');
  for (const slotId of ['S1', 'S2', 'S3', 'S4', 'S5']) {
    await registry.create({ botId: slotId, slotId });
  }

  // 每个槽的 scripted engine 回各自的审计 JSON（维度从 prompt 里取不到，用槽固定映射）。
  // Scheduler 按维度顺序分配 S1/S2/S3 → 与 dimensions 顺序对齐。
  script.setReply('S1', auditJson('security'));
  script.setReply('S2', auditJson('performance'));
  script.setReply('S3', auditJson('maintainability'));

  const reportStore = new InMemoryReportStore();
  const taskProgress = vi.fn();
  const taskComplete = vi.fn();
  const reportReady = vi.fn();
  const offlineRunExecutor = createOfflineRunExecutor({
    registry,
    slotRuntime,
    onAgentEvent,
    reportStore,
    onTaskProgress: taskProgress,
    onTaskComplete: taskComplete,
  });
  const auditScheduler = new Scheduler({
    slots: new FileSlotRegistry({ slotIds: ['S1', 'S2', 'S3', 'S4', 'S5'] }),
    personas: new FakePersonaRegistry(),
    runner: offlineRunExecutor,
  });

  const auditDispatcher = createAuditDispatcher({
    scheduler: auditScheduler,
    reportStore,
    onReportReady: reportReady,
  });

  const mem = new MemoryStore(path.join(os.tmpdir(), `studio-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  const messageStore = new SqliteChatMessageStore(mem);
  const snapshots = new SnapshotStore(mem);
  const summarizer = vi.fn(async () => '[stub]');
  const contextEngine = new SqliteContextEngine({ messageStore, memoryStore: mem, summarizer: summarizer as never });
  const summaryService = new SqliteRoomSummaryService({ messageStore, memoryStore: mem, summarizer: summarizer as never, snapshots });
  const mentionParser = new DefaultMentionParser();

  const onRoundComplete = vi.fn();
  const runtime = createChatRoomRuntime({
    mentionParser,
    handoffParser: new DefaultHandoffParser(mentionParser),
    instructionBuilder: createAgentInstructionBuilder(),
    messageStore,
    contextEngine,
    summaryService,
    registry,
    slotRuntime,
    personas: new FakePersonaRegistry(),
    onAgentEvent,
    rooms: [ROOM],
    onRoundComplete,
    auditDispatcher,
  });

  return {
    runtime, registry, script, reportStore,
    taskProgress, taskComplete, reportReady, onRoundComplete, messageStore,
  };
}

describe('v0.30 审计会议集成', () => {
  it('@main 审计 → 3 槽并行离线执行 → 3 report + merged + report-ready', async () => {
    const ctx = await setup();

    await ctx.runtime.handleUserMessage('r1', '@main 审计 E:/NAS/AutoForge 维度 security,performance,maintainability');

    // batchId 由 runtime 动态生成，从 reportReady 事件拿
    expect(ctx.reportReady).toHaveBeenCalledTimes(1);
    const ready = ctx.reportReady.mock.calls[0][0];
    expect(ready.kind).toBe('report-ready');
    expect(ready.subReports).toHaveLength(3);
    expect(ready.subReports.map((r: { dimension: string }) => r.dimension).sort()).toEqual(
      ['maintainability', 'performance', 'security'],
    );

    // 3 份报告落 reportStore
    const all = ctx.reportStore.readSubReports(ready.batchId);
    expect(all).toHaveLength(3);
    for (const r of all) {
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].severity).toBe('high');
    }

    // summary.md 落盘
    expect(ctx.reportStore.getMergedReportPath(ready.batchId)).toBeTruthy();

    // task-progress × 3（每维度 running）+ task-complete × 3（全部 ok=true）
    expect(ctx.taskProgress).toHaveBeenCalledTimes(3);
    expect(ctx.taskComplete).toHaveBeenCalledTimes(3);
    for (const call of ctx.taskComplete.mock.calls) {
      expect(call[0]).toMatchObject({ kind: 'task-complete', ok: true, findingCount: 1 });
    }

    // 输入框解锁事件
    expect(ctx.onRoundComplete).toHaveBeenCalled();
  });

  it('jsonl 转录：每槽捕获全量 AgentLoopEvent', async () => {
    const ctx = await setup();
    await ctx.runtime.handleUserMessage('r1', '@main 审计 E:/x 维度 security,performance,maintainability');
    const ready = ctx.reportReady.mock.calls[0][0];

    for (const slotId of ['S1', 'S2', 'S3']) {
      const t = ctx.reportStore.getTranscript(ready.batchId, slotId);
      expect(t.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('unloadPersona 清理：执行后槽 bot 人设已卸载', async () => {
    const ctx = await setup();
    await ctx.runtime.handleUserMessage('r1', '@main 审计 E:/x 维度 security,performance,maintainability');
    // offline-runner finally 调了 unloadPersona → S1/S2/S3 无加载人设
    // slotRuntime.loaded 通过 registry state 查；用 registry.get 确认 bot 仍在（只是无人设）
    expect(ctx.registry.get('S1')).toBeTruthy();
    expect(ctx.registry.getState('S1')?.persona).toBeUndefined();
  });

  it('用户审计指令落盘进 messageStore', async () => {
    const ctx = await setup();
    await ctx.runtime.handleUserMessage('r1', '@main 审计 E:/x');
    const msgs = ctx.messageStore.getMessages('r1');
    expect(msgs.some((m) => m.content.includes('审计'))).toBe(true);
  });

  it('单个槽失败不阻断其他 + 汇总照常', async () => {
    const ctx = await setup();
    // S2 engine 抛错
    ctx.script.engines.get('S2')!.engine.send = async () => {
      throw new Error('engine down');
    };
    await ctx.runtime.handleUserMessage('r1', '@main 审计 E:/x 维度 security,performance,maintainability');

    const ready = ctx.reportReady.mock.calls[0][0];
    // 失败的维度仍写了降级报告 → 仍是 3 份（不丢执行记录）
    expect(ctx.reportStore.readSubReports(ready.batchId)).toHaveLength(3);
    // task-complete 有成功有失败
    const oks = ctx.taskComplete.mock.calls.map((c) => c[0].ok);
    expect(oks).toContain(true);
    expect(oks).toContain(false);
    // report-ready 照常推出
    expect(ctx.reportReady).toHaveBeenCalledTimes(1);
  });

  it('普通消息不触发审计（auditDispatcher 存在但不命中）', async () => {
    const ctx = await setup();
    ctx.script.setReply('host', '主持人回复');
    await ctx.runtime.handleUserMessage('r1', '今天讨论什么？');
    expect(ctx.reportReady).not.toHaveBeenCalled();
    expect(ctx.taskProgress).not.toHaveBeenCalled();
  });
});
