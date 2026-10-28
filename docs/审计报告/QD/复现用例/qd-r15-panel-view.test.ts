// @vitest-environment jsdom
/**
 * QD-R15 复现件 · 手机/远程端画布的「带外节点」与整块重渲染的相互作用
 *
 * 真源：src/ui/workbench/workbench-execution-view.ts（f088646a）
 *      + src/ui/workbench/workbench-center.ts（74188d1f）
 * 复刻的只有 agent-panel.ts 的调用顺序（handleAck :206-211 / selectSession :79-85），
 * 渲染函数本身一律用真码。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  renderExecutionSession,
} from '../../src/ui/workbench/workbench-execution-view';
import { getCenterBody } from '../../src/ui/workbench/workbench-center';
import {
  STUDIO_EXECUTION_VERSION,
  type StudioExecutionEvent,
  type StudioExecutionSession,
} from '../../src/shared/studio-execution';

function session(key: string, events: StudioExecutionEvent[]): StudioExecutionSession {
  return { version: STUDIO_EXECUTION_VERSION, key, createdAt: 1, updatedAt: 2, events };
}

function makeCanvas(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'center-canvas';
  document.body.replaceChildren(el);
  return el;
}

/** agent-panel.ts:206-211 的原始形状：ack 失败时直接往 .canvas-body 挂一条 error 节点。 */
function appendOutOfBandError(canvas: HTMLElement, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'msg msg-error';
  el.textContent = text;
  canvas.querySelector<HTMLElement>('.canvas-body')?.appendChild(el);
  return el;
}

describe('QD-R15 · 远程端画布 × 带外 ack 节点', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('CONTROL：renderExecutionSession 是整块重绘，会把上一份会话的内容换掉', () => {
    const canvas = makeCanvas();
    renderExecutionSession(canvas, [], session('chat:a', [
      { type: 'user-message', at: 1, turnId: 't1', text: '甲会话的第一轮' },
    ]));
    expect.soft(getCenterBody(canvas).textContent).toContain('甲会话的第一轮');

    renderExecutionSession(canvas, [], session('chat:b', [
      { type: 'user-message', at: 2, turnId: 't2', text: '乙会话的第一轮' },
    ]));
    const body = getCenterBody(canvas).textContent ?? '';
    expect(body).toContain('乙会话的第一轮');
    expect(body).not.toContain('甲会话的第一轮');
  });

  it('REPRO-C：宿主拒绝（agent-busy 等）的提示是带外节点，下一次执行会话广播时被无声清除', () => {
    const canvas = makeCanvas();
    renderExecutionSession(canvas, [], session('chat:a', [
      { type: 'user-message', at: 1, turnId: 't1', text: '甲会话的第一轮' },
    ]));

    // 用户点发送 → 宿主 ack(ok:false, error:'agent-busy') → handleAck 挂提示
    appendOutOfBandError(canvas, '操作失败：agent-busy');
    expect.soft(getCenterBody(canvas).textContent).toContain('操作失败：agent-busy');

    // 紧接着的任何一次执行会话镜像（同一回合里几乎必然发生：页端写入事件 → 宿主广播）
    renderExecutionSession(canvas, [], session('chat:a', [
      { type: 'user-message', at: 1, turnId: 't1', text: '甲会话的第一轮' },
      { type: 'final-answer', at: 3, turnId: 't1', text: '这是模型的回复' },
    ]));

    const body = getCenterBody(canvas).textContent ?? '';
    console.log(`[REPRO-C] 重绘后正文=${JSON.stringify(body)}`);
    // 期望：失败提示不该在被看到的概率上依赖「下一次广播什么时候来」
    expect(body, '带外错误节点被整块重绘吃掉 ⇒ 用户看不到宿主拒绝原因').toContain('操作失败：agent-busy');
  });

  it('EVIDENCE-D：只要走到渲染就会清屏 ⇒ agent-panel 对 session:null 的早退（R14-03）才是残留的唯一来源', () => {
    const canvas = makeCanvas();
    renderExecutionSession(canvas, [], session('chat:a', [
      { type: 'user-message', at: 1, turnId: 't1', text: '甲会话的第一轮' },
    ]));
    appendOutOfBandError(canvas, '操作失败：pick-folder 取消');

    // 面板若在 selectSession / applyExecutionIndex 里补一次 renderActiveSession()，
    // 传 null 也会走这里：清空 + 空态。证明「清屏」能力本来就存在，只是没被调用。
    renderExecutionSession(canvas, [], null);
    const body = getCenterBody(canvas).textContent ?? '';
    console.log(`[EVIDENCE-D] null 渲染后正文=${JSON.stringify(body)}`);
    expect.soft(body).not.toContain('甲会话的第一轮');
    expect.soft(body).not.toContain('操作失败：pick-folder 取消');
    expect(body).toContain('暂无执行记录');
  });

  it('REPRO-E：selectSession 的「置 null 不重绘」时序复刻 ⇒ 列表已切到乙、正文仍是甲', () => {
    const canvas = makeCanvas();
    const inspector = document.createElement('div');
    renderExecutionSession(canvas, [inspector], session('chat:a', [
      { type: 'user-message', at: 1, turnId: 't1', text: '甲会话的第一轮' },
    ]));

    // agent-panel.ts:79-85 的真实顺序：selectedSessionKey=B; activeSession=null; renderSessionList(); requestExecutionSession(B)
    // ——⛔ 没有任何 renderActiveSession() 调用
    let activeSession: StudioExecutionSession | null = session('chat:a', []);
    const selected: { key: string } = { key: 'chat:a' };
    selected.key = 'chat:b';
    activeSession = null;
    // 宿主回 session:null（幽灵条目 / 会话尚未落盘）→ :114-115 的早退，同样不重绘
    const incoming: StudioExecutionSession | null = null;
    if (!incoming) {
      /* 早退，正文节点原封不动 */
    }

    const body = getCenterBody(canvas).textContent ?? '';
    console.log(`[REPRO-E] selected=${selected.key} activeSession=${activeSession === null ? 'null' : 'object'} 正文=${JSON.stringify(body)}`);
    expect.soft(selected.key).toBe('chat:b');
    expect.soft(activeSession).toBeNull();
    // 期望：选中项已经换到乙，正文不该再留着甲的内容
    expect(body, '切会话后正文仍是上一条会话 ⇒ 看起来像「新对话里有旧对话」').not.toContain('甲会话的第一轮');
  });
});
