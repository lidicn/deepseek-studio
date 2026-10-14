/**
 * 调度器（Bot 基础设施 · 副开发 CodeBuddy 负责）
 *
 * 职责：把「人设 + 任务」分配到空闲槽位（设计稿 §5 Scheduler.assign）。
 * 本版是数据层调度：负责校验 + 占用/释放槽位 + 记录 loadedPersona；
 * 真正的任务执行由可选的 runner 回调接入（Claude 的 AgentLoop/BotRegistry
 * 就绪后注入），runner 缺省时返回 RunHandle 由调用方自行执行并 release。
 *
 * 完成标志（分工方案 §2.2）：
 *   scheduler.assign({ slot: 'S1', persona: 'audit-expert', task: {...} }) 不抛错。
 */

import type { Persona, PersonaRegistry, Slot, SlotRegistry } from './types';

/**
 * SlotRegistry 契约扩展：记录槽位当前加载的人设名。
 * 契约（types.ts）未声明该方法，这里声明为可选 —— Claude 若传入其它
 * SlotRegistry 实现，Scheduler 自动降级为不记录 loadedPersona。
 */
interface SlotRegistryWithPersona extends SlotRegistry {
  setLoadedPersona?(slotId: string, personaName: string | undefined): void;
}

/** 任务描述（维度 + 目标，其余字段透传，见设计稿 §5 示例）。 */
export interface BotTask {
  readonly dimension?: string;
  readonly target?: string;
  readonly [key: string]: unknown;
}

export interface AssignOptions {
  /** 指定槽位；缺省自动挑第一个空闲槽。 */
  readonly slot?: string;
  /** 人设名（必须已被 PersonaRegistry 加载，否则抛错）。 */
  readonly persona: string;
  /** 任务内容（透传给 runner / 落盘）。 */
  readonly task: BotTask;
}

/** 一次调度的句柄。 */
export interface RunHandle {
  readonly runId: string;
  readonly slotId: string;
  readonly persona: Persona;
  readonly task: BotTask;
  readonly startedAt: number;
}

/** 任务执行体（Claude 侧接入；返回值和 SubBotReport 协议对齐在 G1-P4）。 */
export type TaskRunner = (handle: RunHandle) => Promise<unknown>;

export class Scheduler {
  private readonly slots: SlotRegistryWithPersona;
  private readonly personas: PersonaRegistry;
  private readonly runner: TaskRunner | undefined;

  constructor(deps: { slots: SlotRegistry; personas: PersonaRegistry; runner?: TaskRunner }) {
    this.slots = deps.slots;
    this.personas = deps.personas;
    this.runner = deps.runner;
  }

  /**
   * 分配槽位执行任务。
   * - 槽位不存在 / 忙 → 抛错；
   * - 人设不存在 → 抛错（PersonaRegistry.load 语义）；
   * - 注入了 runner：执行完（含异常）自动 release 槽位；
   * - 未注入 runner：只占用槽位，返回句柄，调用方负责 release。
   */
  async assign(opts: AssignOptions): Promise<RunHandle> {
    if (!opts?.persona) throw new Error('scheduler.assign: persona is required');
    if (!opts.task || typeof opts.task !== 'object') throw new Error('scheduler.assign: task is required');

    const slot = this.pickSlot(opts.slot);
    const persona = await this.personas.load(opts.persona);

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.slots.setState(slot.id, 'busy', runId);
    this.slots.setLoadedPersona?.(slot.id, persona.name);

    const handle: RunHandle = { runId, slotId: slot.id, persona, task: opts.task, startedAt: Date.now() };

    if (this.runner) {
      try {
        await this.runner(handle);
      } finally {
        this.release(slot.id, runId);
      }
    }
    return handle;
  }

  /**
   * 释放槽位（卸载人设 + 回 idle）。
   * runId 提供时做归属校验，防止把已被重新分配的槽位误释放。
   */
  release(slotId: string, runId?: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`slot not found: ${slotId}`);
    if (runId && slot.currentRunId && slot.currentRunId !== runId) {
      throw new Error(`runId mismatch on slot ${slotId}: holder=${slot.currentRunId}, release=${runId}`);
    }
    this.slots.setLoadedPersona?.(slotId, undefined);
    this.slots.setState(slotId, 'idle');
  }

  /** 列出当前空闲槽（诊断/自动分配预览）。 */
  idleSlots(): Slot[] {
    return this.slots.list().filter((s) => s.state === 'idle');
  }

  private pickSlot(slotId: string | undefined): Slot {
    if (slotId) {
      const slot = this.slots.get(slotId);
      if (!slot) throw new Error(`slot not found: ${slotId}`);
      if (slot.state !== 'idle') {
        throw new Error(`slot busy: ${slotId} (run=${slot.currentRunId ?? '?'})`);
      }
      return slot;
    }
    const idle = this.idleSlots();
    if (idle.length === 0) throw new Error('no idle slot available');
    return idle[0];
  }
}
