// @vitest-environment jsdom
/**
 * QD-R20 复现件（DOM 腿）· 工具卡投递不带归属
 *
 * 真用：appendToolRun（src/ui/workbench/workbench-inspector.ts:45）、toolRunCard。
 * 面：workbench-inspector=33aa222a / 复制树 == 实时盘（08:58:11 同步）。
 * HEAD 面消费点：agent-panel.ts:195-196（onToolRun → appendToolRun ×2）；
 * 盘面（在飞改动）已把 onToolRun 改成 no-op（agent-panel.ts:187），故此腿记为「HEAD 的债 + 盘面在飞」。
 */
import { describe, expect, it } from 'vitest';
import { appendToolRun, getInspectorBody } from '../../src/ui/workbench/workbench-inspector';
import type { ToolRunEvent } from '../../src/shared/tool-run-event';

function cards(inspector: HTMLElement): HTMLElement[] {
  return Array.from(inspector.querySelectorAll<HTMLElement>('[data-run-id]'));
}

describe('QD-R20-F 工具卡右栏不辨来源', () => {
  it('CONTROL-F：本方 bot 的工具事件正常成卡（尺子会响）', () => {
    const inspector = document.createElement('div');
    appendToolRun(inspector, { type: 'tool-run', runId: 'own-1', tool: 'file.read', phase: 'succeeded', botId: 'main' });
    expect(cards(inspector)).toHaveLength(1);
    console.log(`[CONTROL-F] 卡片数=${cards(inspector).length} body存在=${!!getInspectorBody(inspector)}`);
  });

  it('REPRO-F：副 bot（聊天室成员）的工具终态在同一右栏成卡，事件里没有任何归属可过滤', () => {
    const inspector = document.createElement('div');
    // 生产 emitToolRun（desktop-host.ts:1564/1587）只戳 botId，从不戳 roomId —— 复刻其真实形状：
    const foreign: ToolRunEvent = {
      type: 'tool-run',
      runId: 'room-B-1',
      tool: 'shell.exec',
      phase: 'succeeded',
      botId: 'analyst',
    };
    expect(foreign.roomId, '契约声明了 roomId（shared/tool-run-event.ts:33），发送端从不填').toBeUndefined();
    appendToolRun(inspector, foreign);
    appendToolRun(inspector, { ...foreign, phase: 'failed', errorCode: 'policy-denied' });
    const list = cards(inspector);
    console.log(`[REPRO-F] 卡片数=${list.length} runId=${list.map((c) => c.getAttribute('data-run-id')).join()} roomId=${String(foreign.roomId)}`);
    expect.soft(list, '别 bot 的工具事件不应在主面板右栏成卡').toHaveLength(0);
    expect(list.length, '右栏混入别 bot 工具卡').toBe(0);
  });

  it('REPRO-F2：同一 reducer（applyToolRun）同样不带归属判定', async () => {
    const { applyToolRun, createInitialState } = await import('../../src/ui/workbench/workbench-state');
    let s = createInitialState();
    s = applyToolRun(s, { type: 'tool-run', runId: 'a', tool: 'file.read', phase: 'started', botId: 'main' });
    s = applyToolRun(s, { type: 'tool-run', runId: 'b', tool: 'shell.exec', phase: 'succeeded', botId: 'analyst', roomId: undefined });
    console.log(`[REPRO-F2] toolRuns 数=${s.toolRuns.length} botId=${s.toolRuns.map((r) => String(r.botId)).join()}`);
    expect(s.toolRuns.map((r) => r.botId), 'state.toolRuns 混入别 bot 的 run').toEqual(['main']);
  });
});
