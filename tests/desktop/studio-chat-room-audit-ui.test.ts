// @vitest-environment jsdom
/**
 * v0.30 审计报告卡 UI 单测（Claude 主开发）
 *
 * 覆盖 handleStructuredEvent 的 3 个新 kind → 渲染函数：
 *   task-progress → 蓝边进度行；task-complete → 绿/红完成卡；report-ready → 靛边综合卡。
 * 另验 roomId 隔离（非当前房间事件不渲染）——与其它 kind 共用同一道闸。
 *
 * 用假 WebSocket 驱动 onmessage（createChatRoom 在 connect() 时 new WebSocket）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChatRoom } from '../../src/ui/studio-chat-room';

/** 捕获最近一次 new WebSocket 的实例，供测试手动触发 onmessage。 */
let lastWs: { onmessage?: (ev: { data: string }) => void; readyState: number } | null = null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  onclose?: (ev: { code: number }) => void;
  onerror?: () => void;
  onmessage?: (ev: { data: string }) => void;
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWs = this as never;
  }
  send() {}
  close() {}
}

function pushEvent(ev: Record<string, unknown>): void {
  lastWs?.onmessage?.({ data: JSON.stringify({ type: 'chat-room-event', event: ev }) });
}

function mkRoom() {
  const handle = createChatRoom({
    wsUrl: 'ws://127.0.0.1:8760/agent-ws',
    token: 't',
    roomId: 'r1',
    roomName: '审计室',
    members: ['audit-expert'],
  });
  document.body.appendChild(handle.container);
  // WS 懒连接：show() 才 connect()（不 show 则 lastWs 为 null，事件推不进来）。
  handle.show();
  return handle;
}

function msgBoxes(): Element[] {
  return Array.from(document.querySelectorAll('.studio-chat-msg'));
}

function byClass(cls: string): Element[] {
  return Array.from(document.querySelectorAll(`.${cls}`));
}

describe('v0.30 审计报告卡 UI', () => {
  beforeEach(() => {
    lastWs = null;
    document.body.innerHTML = '';
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('task-progress → 渲染蓝边进度行', () => {
    const h = mkRoom();
    pushEvent({ kind: 'task-progress', roomId: 'r1', slotId: 'S1', dimension: 'security', taskStatus: 'running' });

    const boxes = msgBoxes();
    expect(boxes).toHaveLength(1);
    expect((boxes[0] as HTMLElement).style.borderLeftColor).toBe('rgb(59, 130, 246)');
    expect(boxes[0].textContent).toContain('security');
    expect(boxes[0].textContent).toContain('S1');
    expect(boxes[0].textContent).toContain('执行中');
    h.destroy();
  });

  it('task-complete ok=true → 绿边 + finding 数', () => {
    const h = mkRoom();
    pushEvent({ kind: 'task-complete', roomId: 'r1', slotId: 'S2', dimension: 'performance', ok: true, findingCount: 3 });

    const boxes = msgBoxes();
    expect(boxes).toHaveLength(1);
    expect((boxes[0] as HTMLElement).style.borderLeftColor).toBe('rgb(34, 197, 94)');
    expect(boxes[0].textContent).toContain('performance');
    expect(boxes[0].textContent).toContain('发现 3 条');
    h.destroy();
  });

  it('task-complete ok=false → 红边 + 失败原因', () => {
    const h = mkRoom();
    pushEvent({
      kind: 'task-complete', roomId: 'r1', slotId: 'S3', dimension: 'maintainability',
      ok: false, findingCount: 0, error: '槽 S3 无可用窗口',
    });

    const boxes = msgBoxes();
    expect((boxes[0] as HTMLElement).style.borderLeftColor).toBe('rgb(239, 68, 68)');
    expect(boxes[0].textContent).toContain('失败');
    expect(boxes[0].textContent).toContain('槽 S3 无可用窗口');
    h.destroy();
  });

  it('report-ready → 靛边综合卡（维度汇总 + 路径）', () => {
    const h = mkRoom();
    pushEvent({
      kind: 'report-ready', roomId: 'r1', batchId: 'batch-1',
      summaryPath: 'C:/runs/batch-1/summary.md',
      subReports: [
        { slotId: 'S1', dimension: 'security', findingCount: 2, summary: '两个注入点' },
        { slotId: 'S2', dimension: 'performance', findingCount: 1, summary: '一次全表扫' },
      ],
    });

    const boxes = msgBoxes();
    expect(boxes).toHaveLength(1);
    const report = boxes[0] as HTMLElement;
    expect(report.style.borderLeftColor).toBe('rgb(99, 102, 241)');
    expect(report.textContent).toContain('综合审计报告');
    expect(report.textContent).toContain('共 2 个维度 · 3 条发现');
    expect(report.textContent).toContain('security');
    expect(report.textContent).toContain('performance');
    expect(report.textContent).toContain('C:/runs/batch-1/summary.md');
    h.destroy();
  });

  it('roomId 隔离：非当前房间的 task 事件不渲染', () => {
    const h = mkRoom();
    pushEvent({ kind: 'task-progress', roomId: 'other-room', slotId: 'S1', dimension: 'security', taskStatus: 'running' });
    pushEvent({ kind: 'report-ready', roomId: 'other-room', batchId: 'b', summaryPath: 'x', subReports: [] });

    expect(msgBoxes()).toHaveLength(0);
    h.destroy();
  });

  it('完整审计时序 → 3 进度 + 3 完成 + 1 综合卡（按序追加）', () => {
    const h = mkRoom();
    const dims = [['S1', 'security'], ['S2', 'performance'], ['S3', 'maintainability']] as const;
    for (const [slot, dim] of dims) {
      pushEvent({ kind: 'task-progress', roomId: 'r1', slotId: slot, dimension: dim, taskStatus: 'running' });
    }
    for (const [slot, dim] of dims) {
      pushEvent({ kind: 'task-complete', roomId: 'r1', slotId: slot, dimension: dim, ok: true, findingCount: 1 });
    }
    pushEvent({
      kind: 'report-ready', roomId: 'r1', batchId: 'b1', summaryPath: 'C:/runs/b1/summary.md',
      subReports: dims.map(([slot, dim]) => ({ slotId: slot, dimension: dim, findingCount: 1, summary: 's' })),
    });

    const boxes = msgBoxes();
    expect(boxes).toHaveLength(7);
    expect(boxes[6].className).toContain('studio-chat-msg-report');
    // 顺序：先 3 进度（蓝），再 3 完成（绿），最后 1 综合（靛）
    expect((boxes[0] as HTMLElement).style.borderLeftColor).toBe('rgb(59, 130, 246)');
    expect((boxes[3] as HTMLElement).style.borderLeftColor).toBe('rgb(34, 197, 94)');
    expect((boxes[6] as HTMLElement).style.borderLeftColor).toBe('rgb(99, 102, 241)');
    h.destroy();
  });
});
