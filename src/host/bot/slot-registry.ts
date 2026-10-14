/**
 * 账号 / 槽位注册表（Bot 基础设施 · 副开发 CodeBuddy 负责）
 *
 * 契约来源：src/host/bot/types.ts（Claude 定义，签名锁定）。
 * 职责：账号池（Account，凭证层）+ 槽位池（Slot，执行层）与「槽位 ↔ 账号」
 * 绑定管理。人设层在 persona-registry.ts，由 Scheduler 串起来。
 *
 * 铁律（设计稿 §6）：1 槽位 : 1 账号 : 1 窗口 —— 一个账号任一时刻只绑定
 * 一个槽位，bindAccount 对重复绑定直接抛错，不静默改绑。
 *
 * 说明：绑定/状态为运行时态，不落盘（重启后由上层重新 configure/seed）。
 */

import type { Account, Slot, SlotRegistry } from './types';

const ACCOUNT_STATUSES: readonly Account['status'][] = ['ready', 'rate-limited', 'banned', 'logged-out'];

/** 账号池：凭证层，长期稳定。 */
export class AccountRegistry {
  private readonly accounts = new Map<string, Account>();

  /** 注册账号；id 重复抛错。 */
  register(account: Account): void {
    if (!account?.id) throw new Error('account.id is required');
    if (this.accounts.has(account.id)) {
      throw new Error(`account already registered: ${account.id}`);
    }
    if (!ACCOUNT_STATUSES.includes(account.status)) {
      throw new Error(`invalid account status: ${String(account.status)}`);
    }
    // 存副本，避免调用方持引用改内部状态
    this.accounts.set(account.id, { ...account });
  }

  unregister(id: string): boolean {
    return this.accounts.delete(id);
  }

  get(id: string): Account | undefined {
    const a = this.accounts.get(id);
    return a ? { ...a } : undefined;
  }

  list(): Account[] {
    return [...this.accounts.values()].map((a) => ({ ...a })).sort((x, y) => x.id.localeCompare(y.id));
  }

  /** 更新账号状态（含可选限流冷却截止时间戳）。 */
  setStatus(id: string, status: Account['status'], cooldownUntil?: number): void {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`account not found: ${id}`);
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw new Error(`invalid account status: ${String(status)}`);
    }
    a.status = status;
    if (cooldownUntil !== undefined) a.cooldownUntil = cooldownUntil;
    else if (status === 'ready') delete a.cooldownUntil;
  }

  /** 当前可接单的账号：ready 且冷却已过。 */
  available(): Account[] {
    const now = Date.now();
    return this.list().filter((a) => a.status === 'ready' && (a.cooldownUntil === undefined || a.cooldownUntil <= now));
  }
}

/** 默认槽位：S1..S5 工作槽 + S6 汇总槽（types.ts Slot 注释口径）。 */
export function defaultSlotIds(): string[] {
  return ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
}

/**
 * 槽位注册表：管理「槽位 ↔ 账号」绑定与忙碌状态。
 * list()/get() 返回副本，调用方无法直接改内部状态。
 */
export class FileSlotRegistry implements SlotRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly accounts: AccountRegistry | null;

  constructor(opts?: { slotIds?: string[]; accounts?: AccountRegistry }) {
    this.accounts = opts?.accounts ?? null;
    const ids = opts?.slotIds ?? defaultSlotIds();
    if (ids.length === 0) throw new Error('slotIds must not be empty');
    for (const id of ids) {
      if (this.slots.has(id)) throw new Error(`duplicate slot id: ${id}`);
      this.slots.set(id, { id, accountId: '', state: 'idle' });
    }
  }

  list(): Slot[] {
    return [...this.slots.values()].map(cloneSlot);
  }

  get(id: string): Slot | undefined {
    const s = this.slots.get(id);
    return s ? cloneSlot(s) : undefined;
  }

  /**
   * 绑定槽位到账号。
   * - 槽位/账号必须存在；
   * - 账号已被其它槽位绑定 → 抛错（1 槽位 : 1 账号 铁律）；
   * - 槽位 busy → 抛错（跑着任务不换账号）。
   */
  bindAccount(slotId: string, accountId: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`slot not found: ${slotId}`);
    if (slot.state !== 'idle') {
      throw new Error(`slot busy: ${slotId} (run=${slot.currentRunId ?? '?'}), cannot rebind account`);
    }
    if (this.accounts && !this.accounts.get(accountId)) {
      throw new Error(`account not found: ${accountId}`);
    }
    const holder = this.findSlotByAccount(accountId);
    if (holder && holder.id !== slotId) {
      throw new Error(`account ${accountId} already bound to slot ${holder.id} (1 slot : 1 account)`);
    }
    slot.accountId = accountId;
  }

  /** 标记槽位忙碌/空闲。busy 时 runId 缺省则自动生成；idle 时清空 runId。 */
  setState(slotId: string, state: 'idle' | 'busy', runId?: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`slot not found: ${slotId}`);
    if (state === 'busy') {
      slot.state = 'busy';
      slot.currentRunId = runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    } else {
      slot.state = 'idle';
      delete slot.currentRunId;
    }
  }

  /** 记录/清除槽位当前加载的人设名（Scheduler 用；契约外扩展方法）。 */
  setLoadedPersona(slotId: string, personaName: string | undefined): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`slot not found: ${slotId}`);
    if (personaName) slot.loadedPersona = personaName;
    else delete slot.loadedPersona;
  }

  /** 查账号当前绑定在哪个槽位（内部 + 诊断用）。 */
  findSlotByAccount(accountId: string): Slot | undefined {
    for (const s of this.slots.values()) {
      if (s.accountId === accountId) return cloneSlot(s);
    }
    return undefined;
  }
}

function cloneSlot(s: Slot): Slot {
  return {
    id: s.id,
    accountId: s.accountId,
    state: s.state,
    ...(s.currentRunId !== undefined ? { currentRunId: s.currentRunId } : {}),
    ...(s.loadedPersona !== undefined ? { loadedPersona: s.loadedPersona } : {}),
  };
}
