/**
 * Bot 基础设施 · Account/Slot 注册表 + Scheduler 验收测试（副开发 CodeBuddy）
 *
 * 契约：src/host/bot/types.ts（Account/Slot/SlotRegistry）。
 * 完成标志（分工方案 §2.2）：scheduler.assign({slot:'S1', persona:'audit-expert', task:{...}}) 不抛错。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AccountRegistry, FileSlotRegistry, defaultSlotIds } from '../../src/host/bot/slot-registry';
import { Scheduler } from '../../src/host/bot/scheduler';
import { FilePersonaRegistry } from '../../src/host/bot/persona-registry';

const tmpRoot = path.join(os.tmpdir(), `studio-slot-test-${Date.now()}`);

function makeAccount(id: string): Parameters<AccountRegistry['register']>[0] {
  return { id, kind: 'web', loginRef: `/profiles/${id}`, status: 'ready' };
}

function makePersonaDir(name: string): void {
  const dir = path.join(tmpRoot, 'personas', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), `你是 ${name}`, 'utf8');
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(['file.read']), 'utf8');
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  makePersonaDir('audit-expert');
  makePersonaDir('dev-expert');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AccountRegistry', () => {
  it('注册 / 查询 / 列表（返回副本，外部改不动内部）', () => {
    const reg = new AccountRegistry();
    reg.register(makeAccount('A1'));
    reg.register(makeAccount('A2'));
    expect(reg.list().map((a) => a.id)).toEqual(['A1', 'A2']);
    const a = reg.get('A1')!;
    a.status = 'banned'; // 改副本
    expect(reg.get('A1')!.status).toBe('ready');
  });

  it('重复注册 / 非法状态抛错', () => {
    const reg = new AccountRegistry();
    reg.register(makeAccount('A1'));
    expect(() => reg.register(makeAccount('A1'))).toThrow(/already registered/);
    expect(() => reg.setStatus('A1', 'nope' as never)).toThrow(/invalid account status/);
    expect(() => reg.setStatus('missing', 'ready')).toThrow(/account not found/);
  });

  it('available 只返回 ready 且冷却已过的账号', () => {
    const reg = new AccountRegistry();
    reg.register(makeAccount('A1'));
    reg.register(makeAccount('A2'));
    reg.register(makeAccount('A3'));
    reg.setStatus('A2', 'rate-limited');
    reg.setStatus('A3', 'ready', Date.now() + 60_000); // 冷却中
    expect(reg.available().map((a) => a.id)).toEqual(['A1']);
  });
});

describe('SlotRegistry（FileSlotRegistry）', () => {
  it('默认 6 槽（S1..S5 工作 + S6 汇总），初始 idle 无绑定', () => {
    const reg = new FileSlotRegistry();
    expect(reg.list().map((s) => s.id)).toEqual(defaultSlotIds());
    expect(reg.list().every((s) => s.state === 'idle' && s.accountId === '')).toBe(true);
  });

  it('bindAccount 绑定后 get/list 可见', () => {
    const accounts = new AccountRegistry();
    accounts.register(makeAccount('A1'));
    const slots = new FileSlotRegistry({ accounts });
    slots.bindAccount('S1', 'A1');
    expect(slots.get('S1')!.accountId).toBe('A1');
  });

  it('铁律 1 槽位 : 1 账号 —— 账号已被其它槽位绑定则抛错', () => {
    const accounts = new AccountRegistry();
    accounts.register(makeAccount('A1'));
    const slots = new FileSlotRegistry({ accounts });
    slots.bindAccount('S1', 'A1');
    expect(() => slots.bindAccount('S2', 'A1')).toThrow(/already bound to slot S1/);
    // 账号未注册也拒绝
    expect(() => slots.bindAccount('S3', 'A9')).toThrow(/account not found/);
  });

  it('busy 槽位不允许改绑账号', () => {
    const accounts = new AccountRegistry();
    accounts.register(makeAccount('A1'));
    accounts.register(makeAccount('A2'));
    const slots = new FileSlotRegistry({ accounts });
    slots.bindAccount('S1', 'A1');
    slots.setState('S1', 'busy', 'run-1');
    expect(() => slots.bindAccount('S1', 'A2')).toThrow(/slot busy/);
  });

  it('setState busy 自动生成 runId；idle 清空 runId', () => {
    const slots = new FileSlotRegistry();
    slots.setState('S1', 'busy');
    expect(slots.get('S1')!.state).toBe('busy');
    expect(slots.get('S1')!.currentRunId).toMatch(/^run-/);
    slots.setState('S1', 'idle');
    expect(slots.get('S1')!.state).toBe('idle');
    expect(slots.get('S1')!.currentRunId).toBeUndefined();
  });

  it('findSlotByAccount 反查绑定槽位', () => {
    const accounts = new AccountRegistry();
    accounts.register(makeAccount('A1'));
    const slots = new FileSlotRegistry({ accounts });
    slots.bindAccount('S2', 'A1');
    expect(slots.findSlotByAccount('A1')!.id).toBe('S2');
    expect(slots.findSlotByAccount('nope')).toBeUndefined();
  });
});

describe('Scheduler', () => {
  function build(withRunner = false) {
    const accounts = new AccountRegistry();
    accounts.register(makeAccount('A1'));
    accounts.register(makeAccount('A2'));
    const slots = new FileSlotRegistry({ accounts });
    slots.bindAccount('S1', 'A1');
    slots.bindAccount('S2', 'A2');
    const personas = new FilePersonaRegistry(path.join(tmpRoot, 'personas'));
    const scheduler = new Scheduler({ slots, personas, ...(withRunner ? { runner: async () => 'done' } : {}) });
    return { accounts, slots, personas, scheduler };
  }

  it('完成标志：assign({slot:S1, persona:audit-expert, task}) 不抛错且槽位占用', async () => {
    const { scheduler, slots } = build();
    const handle = await scheduler.assign({
      slot: 'S1',
      persona: 'audit-expert',
      task: { dimension: '并发安全', target: 'E:/NAS/AutoForge' },
    });
    expect(handle.slotId).toBe('S1');
    expect(handle.runId).toMatch(/^run-/);
    expect(handle.persona.name).toBe('audit-expert');
    expect(handle.persona.tools).toEqual(['file.read']);
    const s = slots.get('S1')!;
    expect(s.state).toBe('busy');
    expect(s.currentRunId).toBe(handle.runId);
    expect(s.loadedPersona).toBe('audit-expert');
  });

  it('忙槽再分配抛错', async () => {
    const { scheduler } = build();
    await scheduler.assign({ slot: 'S1', persona: 'audit-expert', task: {} });
    await expect(scheduler.assign({ slot: 'S1', persona: 'dev-expert', task: {} }))
      .rejects.toThrow(/slot busy: S1/);
  });

  it('人设不存在抛错（不占用槽位）', async () => {
    const { scheduler, slots } = build();
    await expect(scheduler.assign({ slot: 'S1', persona: 'ghost', task: {} }))
      .rejects.toThrow(/persona not found/);
    expect(slots.get('S1')!.state).toBe('idle'); // 槽位不被脏占
  });

  it('release 释放槽位并清 loadedPersona；runId 不匹配拒绝释放', async () => {
    const { scheduler, slots } = build();
    const h = await scheduler.assign({ slot: 'S1', persona: 'audit-expert', task: {} });
    expect(() => scheduler.release('S1', 'run-other')).toThrow(/runId mismatch/);
    scheduler.release('S1', h.runId);
    expect(slots.get('S1')!.state).toBe('idle');
    expect(slots.get('S1')!.loadedPersona).toBeUndefined();
    expect(scheduler.idleSlots().map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('slot 缺省自动挑第一个空闲槽', async () => {
    const { scheduler, slots } = build();
    // 先把 S1 占掉
    await scheduler.assign({ slot: 'S1', persona: 'audit-expert', task: {} });
    const h2 = await scheduler.assign({ persona: 'dev-expert', task: {} });
    expect(h2.slotId).toBe('S2');
    expect(slots.get('S2')!.loadedPersona).toBe('dev-expert');
  });

  it('全部忙时自动分配抛错', async () => {
    const slots = new FileSlotRegistry({ slotIds: ['S1'] });
    const personas = new FilePersonaRegistry(path.join(tmpRoot, 'personas'));
    const scheduler = new Scheduler({ slots, personas });
    await scheduler.assign({ slot: 'S1', persona: 'audit-expert', task: {} });
    await expect(scheduler.assign({ persona: 'dev-expert', task: {} })).rejects.toThrow(/no idle slot/);
  });

  it('注入 runner 时执行完自动释放（异常也释放）', async () => {
    const slots = new FileSlotRegistry({ slotIds: ['S1'] });
    const personas = new FilePersonaRegistry(path.join(tmpRoot, 'personas'));
    let ran = 0;
    const scheduler = new Scheduler({
      slots,
      personas,
      runner: async () => {
        ran += 1;
        throw new Error('boom');
      },
    });
    await expect(scheduler.assign({ slot: 'S1', persona: 'audit-expert', task: {} })).rejects.toThrow('boom');
    expect(ran).toBe(1);
    expect(slots.get('S1')!.state).toBe('idle'); // finally 释放
  });
});
