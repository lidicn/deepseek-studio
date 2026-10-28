// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioChatUI, type StudioChatUIHandle } from '../../src/ui/studio-chat-ui';
import { createStudioExecutionStore, type StudioExecutionKv } from '../../src/ui/studio-execution-store';
import { studioExecutionStorageKey } from '../../src/shared/studio-execution';

function memoryKv(): StudioExecutionKv & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async kvGet(key) {
      return values.get(key);
    },
    async kvSet(key, value) {
      values.set(key, structuredClone(value));
    },
    async kvRemove(key) {
      values.delete(key);
    },
  };
}

function mount(options?: Parameters<typeof createStudioChatUI>[0]): StudioChatUIHandle {
  const ui = createStudioChatUI(options);
  document.body.appendChild(ui.container);
  return ui;
}

function status(ui: StudioChatUIHandle): string {
  return ui.container.querySelector('.ds-sc-status-text')?.textContent ?? '';
}

function emptyState(ui: StudioChatUIHandle): Element | null {
  return ui.container.querySelector('[data-studio-empty-state="true"]');
}

describe('QD-R5 新对话残留', () => {
  let ui: StudioChatUIHandle | null = null;

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    ui?.destroy();
    ui = null;
    vi.unstubAllGlobals();
  });

  it('CONTROL: 空闲时激活 route 桶会清屏并回到空态', async () => {
    ui = mount({ initialSessionKey: 'chat:old' });
    await ui.activateSession('chat:old');
    ui.addUserMessage('IDLE-OLD');
    ui.startAssistantMessage();
    ui.appendToAssistantMessage('IDLE-OLD-ANSWER');
    ui.finishAssistantMessage();

    await ui.activateSession('route:/');
    expect(ui.container.textContent).not.toContain('IDLE-OLD');
    expect(emptyState(ui)).not.toBeNull();
  });

  it('REPRO-A: 助手气泡未收尾时点新对话，清屏被 currentAssistant 守卫挡死', async () => {
    ui = mount({ initialSessionKey: 'chat:stalled' });
    await ui.activateSession('chat:stalled');
    ui.addUserMessage('STALLED-QUESTION');
    ui.startAssistantMessage();
    ui.appendToAssistantMessage('STALLED-PARTIAL');

    // 用户点“新对话”后路由从 /a/chat/s/... 变到 /，entry 侧等价调用：
    await ui.activateSession('route:/');

    expect(ui.container.textContent).not.toContain('STALLED-QUESTION');
    expect(ui.container.textContent).not.toContain('STALLED-PARTIAL');
    expect(emptyState(ui)).not.toBeNull();
  });

  it('REPRO-B: route 桶已有事件时，同键激活走早退，旧消息留在新对话', async () => {
    ui = mount({ initialSessionKey: 'route:/' });
    ui.addUserMessage('STALE-ROUTE-MSG');

    // interceptor.onNewUserMessage 在 route: 键上的实际调用形状：
    await ui.activateSession('route:/');

    expect(ui.container.textContent).not.toContain('STALE-ROUTE-MSG');
    expect(emptyState(ui)).not.toBeNull();
  });

  it('REPRO-C: 切到新会话后旧流的迟到增量写进新会话并落盘', async () => {
    addMeasured();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:a' });
    await ui.activateSession('chat:a');
    ui.addUserMessage('A-QUESTION');
    ui.startAssistantMessage();
    ui.appendToAssistantMessage('A-PARTIAL');

    await ui.activateSession('chat:b');
    expect(ui.container.textContent).not.toContain('A-PARTIAL');

    // 旧会话的流没有停，下一片增量到达时 currentAssistant 已被清空：
    ui.appendToAssistantMessage('LATE-A-DELTA');
    ui.finishAssistantMessage();

    expect(ui.container.textContent).not.toContain('LATE-A-DELTA');
    const stored = kv.values.get(studioExecutionStorageKey('chat:b')) as
      | { events?: Array<{ type: string; text?: string }> }
      | undefined;
    const leaked = stored?.events?.some(
      (event) => event.type === 'final-answer' && (event.text ?? '').includes('LATE-A-DELTA'),
    );
    expect(leaked).not.toBe(true);
  });

  it('REPRO-D: 无工具回合收尾后 busy 不复位，新会话继承“执行中…”', async () => {
    ui = mount({ initialSessionKey: 'chat:prev' });
    await ui.activateSession('chat:prev');
    ui.setBusy(true);
    ui.startAssistantMessage();
    ui.appendToAssistantMessage('PLAIN-ANSWER');
    // interceptor.onStreamEnd 的无工具分支只调 finishAssistantMessage（:1103-1105）
    ui.finishAssistantMessage();

    expect(status(ui)).toBe('完成');

    await ui.activateSession('chat:fresh');
    expect(status(ui)).toBe('完成');
  });
});

function addMeasured(): void {
  const card = document.createElement('div');
  const textarea = document.createElement('textarea');
  card.appendChild(textarea);
  document.body.appendChild(card);
  const box = (el: Element, top: number, height: number): void => {
    (el as HTMLElement).getBoundingClientRect = () => ({
      x: 280, y: top, top, left: 280, right: 880, bottom: top + height,
      width: 600, height, toJSON: () => ({}),
    });
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 600 });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
  };
  box(textarea, 630, 24);
  box(card, 560, 180);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
}
