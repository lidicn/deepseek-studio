/**
 * meeting-state 单测（v0.29 · Claude 主开发）
 *
 * 覆盖：
 *   - SQLite 模式：start/end/increment/reset/get CRUD + 幂等
 *   - 内存降级模式：同上，走 Map 路径
 *   - parseMeetingStrategy 宽松解析（脏数据/越界/缺失字段回落默认）
 *   - defaultMeetingStrategy 兜底
 *   - 独立表：不碰 chat_snapshots（不在此测，但 schema 存在性可断言）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../../src/host/memory-store';
import {
  SqliteRoomStateStore,
  parseMeetingStrategy,
  defaultMeetingStrategy,
} from '../../src/host/bot/meeting-state';
import type { MemoryStore as MemoryStoreType } from '../../src/host/memory-store';
import type { MeetingStrategy } from '../../src/host/bot/types';

let tmpDir: string;
let tmpDb: string;
let lastMem: MemoryStore | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-meet-'));
  tmpDb = path.join(tmpDir, 'state.db');
  lastMem = undefined;
});

afterEach(() => {
  try {
    lastMem?.getDb()?.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// 公用策略：3 轮阈值、2 个议题、带风格。
const STRAT: MeetingStrategy = {
  focusTopics: ['接口契约', '错误码规范'],
  minRoundsBeforeAutoSummary: 3,
  summaryStyle: '分议题罗列结论与待定项',
};

describe('SqliteRoomStateStore - SQLite 模式', () => {
  function makeStore(): SqliteRoomStateStore {
    lastMem = new MemoryStore(tmpDb);
    return new SqliteRoomStateStore(lastMem);
  }

  it('get 未开启会议的房间返回 null', () => {
    const store = makeStore();
    expect(store.get('r-never')).toBeNull();
  });

  it('startMeeting 写入 active 态 + 策略，roundsSinceSummary 归零', () => {
    const store = makeStore();
    store.startMeeting('r1', STRAT, 'user-a');
    const s = store.get('r1');
    expect(s).not.toBeNull();
    expect(s!.status).toBe('active');
    expect(s!.strategy).toEqual(STRAT);
    expect(s!.roundsSinceSummary).toBe(0);
  });

  it('startMeeting 在已 active 时幂等（不覆盖既有策略）', () => {
    const store = makeStore();
    store.startMeeting('r1', STRAT, 'user-a');
    store.incrementRounds('r1'); // rounds=1
    // 再 start —— 不应清零 rounds，也不换策略
    store.startMeeting('r1', { focusTopics: ['别的'], minRoundsBeforeAutoSummary: 5 }, 'user-b');
    const s = store.get('r1');
    expect(s!.status).toBe('active');
    expect(s!.strategy).toEqual(STRAT); // 仍是旧策略
    expect(s!.roundsSinceSummary).toBe(1); // 未被清零
  });

  it('endMeeting 切 closed 且策略保留、rounds 清零', () => {
    const store = makeStore();
    store.startMeeting('r1', STRAT, 'user-a');
    store.incrementRounds('r1');
    store.incrementRounds('r1');
    store.endMeeting('r1', 'user-a');
    const s = store.get('r1');
    expect(s!.status).toBe('closed');
    expect(s!.strategy).toEqual(STRAT); // 策略保留供审计
    expect(s!.roundsSinceSummary).toBe(0);
  });

  it('endMeeting 在非 active 态幂等（idle/closed 都 no-op）', () => {
    const store = makeStore();
    // idle 直接 end —— no-op，不造行
    store.endMeeting('r1', 'user-a');
    expect(store.get('r1')).toBeNull();

    // active → end → 再 end —— 第二次 no-op
    store.startMeeting('r1', STRAT, 'user-a');
    store.endMeeting('r1', 'user-a');
    const after1 = store.get('r1');
    store.endMeeting('r1', 'user-a'); // 重复散会
    const after2 = store.get('r1');
    expect(after2).toEqual(after1);
  });

  it('closed → startMeeting 可重开会议（覆盖策略 + 清零）', () => {
    const store = makeStore();
    store.startMeeting('r1', STRAT, 'user-a');
    store.endMeeting('r1', 'user-a');
    // 重开新会议
    const strat2: MeetingStrategy = { focusTopics: ['第二轮议题'], minRoundsBeforeAutoSummary: 2 };
    store.startMeeting('r1', strat2, 'user-b');
    const s = store.get('r1');
    expect(s!.status).toBe('active');
    expect(s!.strategy).toEqual(strat2);
    expect(s!.roundsSinceSummary).toBe(0);
  });

  it('incrementRounds 累加；resetRounds 清零；空房间 increment 先造 idle 行', () => {
    const store = makeStore();
    // 未开会议就 increment —— 造 idle 行，rounds=1
    store.incrementRounds('r1');
    let s = store.get('r1');
    expect(s!.status).toBe('idle');
    expect(s!.roundsSinceSummary).toBe(1);

    store.incrementRounds('r1');
    store.incrementRounds('r1');
    expect(store.get('r1')!.roundsSinceSummary).toBe(3);

    store.resetRounds('r1');
    expect(store.get('r1')!.roundsSinceSummary).toBe(0);
  });

  it('resetRounds 在无行或已为 0 时幂等', () => {
    const store = makeStore();
    store.resetRounds('r-no-row'); // 无行 no-op
    expect(store.get('r-no-row')).toBeNull();

    store.startMeeting('r1', STRAT, 'u');
    store.resetRounds('r1'); // rounds 已为 0
    expect(store.get('r1')!.roundsSinceSummary).toBe(0);
  });

  it('不同房间状态互相隔离', () => {
    const store = makeStore();
    store.startMeeting('r1', STRAT, 'u');
    store.incrementRounds('r1');
    store.startMeeting('r2', { focusTopics: ['x'], minRoundsBeforeAutoSummary: 1 }, 'u');
    store.endMeeting('r2', 'u');
    expect(store.get('r1')!.status).toBe('active');
    expect(store.get('r1')!.roundsSinceSummary).toBe(1);
    expect(store.get('r2')!.status).toBe('closed');
  });

  it('持久化跨 store 实例（同 db 文件）', () => {
    lastMem = new MemoryStore(tmpDb);
    const s1 = new SqliteRoomStateStore(lastMem);
    s1.startMeeting('persist', STRAT, 'u');
    s1.incrementRounds('persist');
    s1.incrementRounds('persist');

    // 关旧连接、开新连接（模拟重启）
    try {
      lastMem?.getDb()?.close();
    } catch {
      /* ignore */
    }
    lastMem = new MemoryStore(tmpDb);
    const s2 = new SqliteRoomStateStore(lastMem);
    const s = s2.get('persist');
    expect(s).not.toBeNull();
    expect(s!.status).toBe('active');
    expect(s!.roundsSinceSummary).toBe(2);
    expect(s!.strategy).toEqual(STRAT);
  });
});

describe('SqliteRoomStateStore - 内存降级模式', () => {
  function makeFallbackStore(): SqliteRoomStateStore {
    const stub = { getDb: () => null, isInMemoryFallback: () => true } as unknown as MemoryStoreType;
    return new SqliteRoomStateStore(stub);
  }

  it('降级模式 start/end/increment/reset/get 全工作', () => {
    const store = makeFallbackStore();
    expect(store.get('r1')).toBeNull();

    store.startMeeting('r1', STRAT, 'u');
    let s = store.get('r1');
    expect(s!.status).toBe('active');
    expect(s!.strategy).toEqual(STRAT);

    store.incrementRounds('r1');
    store.incrementRounds('r1');
    expect(store.get('r1')!.roundsSinceSummary).toBe(2);

    store.resetRounds('r1');
    expect(store.get('r1')!.roundsSinceSummary).toBe(0);

    store.endMeeting('r1', 'u');
    expect(store.get('r1')!.status).toBe('closed');
  });

  it('降级模式 active 幂等不覆盖策略', () => {
    const store = makeFallbackStore();
    store.startMeeting('r1', STRAT, 'u');
    store.startMeeting('r1', { focusTopics: ['别的'], minRoundsBeforeAutoSummary: 9 }, 'u');
    expect(store.get('r1')!.strategy).toEqual(STRAT);
  });

  it('降级模式非 active end 幂等 no-op', () => {
    const store = makeFallbackStore();
    store.endMeeting('r-none', 'u');
    expect(store.get('r-none')).toBeNull();
  });
});

describe('parseMeetingStrategy - 宽松解析', () => {
  it('合法输入原样返回', () => {
    const out = parseMeetingStrategy({
      focusTopics: ['A', 'B'],
      minRoundsBeforeAutoSummary: 4,
      summaryStyle: '简洁',
    });
    expect(out.focusTopics).toEqual(['A', 'B']);
    expect(out.minRoundsBeforeAutoSummary).toBe(4);
    expect(out.summaryStyle).toBe('简洁');
  });

  it('null/undefined/非对象 → 默认空策略', () => {
    for (const v of [null, undefined, 'string', 42, true] as unknown[]) {
      const out = parseMeetingStrategy(v);
      expect(out.focusTopics).toEqual([]);
      expect(out.minRoundsBeforeAutoSummary).toBe(3);
      expect(out.summaryStyle).toBeUndefined();
    }
  });

  it('focusTopics 非数组或全空 → 空数组（有 fallbackTopic 时保留）', () => {
    expect(parseMeetingStrategy({ focusTopics: 'oops' }).focusTopics).toEqual([]);
    expect(parseMeetingStrategy({ focusTopics: [] }).focusTopics).toEqual([]);
    expect(parseMeetingStrategy({ focusTopics: [] }, '兜底主题').focusTopics).toEqual(['兜底主题']);
    // 含空白条目被过滤
    expect(parseMeetingStrategy({ focusTopics: ['  ', '', '有效'] }).focusTopics).toEqual(['有效']);
  });

  it('minRoundsBeforeAutoSummary 越界 → 钳到 [1,20]', () => {
    expect(parseMeetingStrategy({ minRoundsBeforeAutoSummary: 0 }).minRoundsBeforeAutoSummary).toBe(1);
    expect(parseMeetingStrategy({ minRoundsBeforeAutoSummary: 100 }).minRoundsBeforeAutoSummary).toBe(20);
    expect(parseMeetingStrategy({ minRoundsBeforeAutoSummary: -5 }).minRoundsBeforeAutoSummary).toBe(1);
    expect(parseMeetingStrategy({ minRoundsBeforeAutoSummary: 7.4 }).minRoundsBeforeAutoSummary).toBe(7);
    // 非数 → 默认 3
    expect(parseMeetingStrategy({ minRoundsBeforeAutoSummary: '很多' }).minRoundsBeforeAutoSummary).toBe(3);
    expect(parseMeetingStrategy({ minRoundsBeforeAutoSummary: NaN }).minRoundsBeforeAutoSummary).toBe(3);
    expect(parseMeetingStrategy({ minRoundsBeforeAutoSummary: Infinity }).minRoundsBeforeAutoSummary).toBe(3);
  });

  it('summaryStyle 非串/空白 → 省略', () => {
    expect(parseMeetingStrategy({ summaryStyle: 123 }).summaryStyle).toBeUndefined();
    expect(parseMeetingStrategy({ summaryStyle: '   ' }).summaryStyle).toBeUndefined();
    expect(parseMeetingStrategy({ summaryStyle: '分议题' }).summaryStyle).toBe('分议题');
  });
});

describe('defaultMeetingStrategy', () => {
  it('有主题时取首主题', () => {
    const s = defaultMeetingStrategy('后端接口设计');
    expect(s.focusTopics).toEqual(['后端接口设计']);
    expect(s.minRoundsBeforeAutoSummary).toBe(3);
  });

  it('空主题 → 空 topics（仍可开会，策略仅含阈值）', () => {
    const s = defaultMeetingStrategy('   ');
    expect(s.focusTopics).toEqual([]);
    expect(s.minRoundsBeforeAutoSummary).toBe(3);
  });
});
