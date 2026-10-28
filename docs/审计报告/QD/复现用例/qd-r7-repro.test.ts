// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioChatUI, type StudioChatUIHandle } from '../../src/ui/studio-chat-ui';
import { createStudioExecutionStore, type StudioExecutionKv } from '../../src/ui/studio-execution-store';
import { studioExecutionStorageKey, type StudioExecutionSession } from '../../src/shared/studio-execution';

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

function storedSession(kv: StudioExecutionKv & { values: Map<string, unknown> }, key: string): StudioExecutionSession | undefined {
  return kv.values.get(studioExecutionStorageKey(key)) as StudioExecutionSession | undefined;
}

function outputTexts(ui: StudioChatUIHandle): string[] {
  return Array.from(ui.container.querySelectorAll('.ds-flow-pre')).map((el) => el.textContent ?? '');
}

const SHELL_RESULT = {
  ok: true,
  data: { stdout: 'HELLO-R7', stderr: '', exitCode: 0 },
  content: [{ type: 'text' as const, text: 'HELLO-R7' }],
  details: { exitCode: 0, durationMs: 12 },
  isError: false,
};

describe('QD-R7 工具卡与结果回填', () => {
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

  it('CONTROL: 实时工具卡按 content 渲染可读输出且状态为已执行', async () => {
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:a' });
    await ui.activateSession('chat:a');
    ui.addUserMessage('RUN-LS');
    ui.startToolCard('c1', { toolName: 'shell_exec', params: { command: 'ls' } });
    ui.finishToolCard('c1', { toolName: 'shell_exec', params: { command: 'ls' } }, SHELL_RESULT, 12);

    const item = ui.container.querySelector('.ds-flow-item[data-call-id="c1"]');
    expect(item?.getAttribute('data-status')).toBe('succeeded');
    expect(outputTexts(ui).some((text) => text.includes('HELLO-R7'))).toBe(true);
    expect(outputTexts(ui).some((text) => text.includes('"content"'))).toBe(false);
  });

  it('REPRO-A: 切会话后迟到的工具结果被丢弃，旧会话记录缺 tool-result，回放永远“执行中”', async () => {
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:a' });
    await ui.activateSession('chat:a');
    ui.addUserMessage('A-RUN-TOOL');
    ui.startToolCard('c1', { toolName: 'shell_exec', params: { command: 'sleep 30' } });

    await ui.activateSession('chat:b');
    const accepted = ui.finishToolCard(
      'c1',
      { toolName: 'shell_exec', params: { command: 'sleep 30' } },
      SHELL_RESULT,
      30000,
    );
    await vi.waitFor(() => {
      expect(storedSession(kv, 'chat:a')?.events?.some((event) => event.type === 'tool-result')).toBe(true);
    }, { timeout: 300 }).catch(() => {});

    const events = storedSession(kv, 'chat:a')?.events?.map((event) => event.type) ?? [];
    console.log('[R7-A] finishToolCard accepted =', accepted, '| chat:a events =', JSON.stringify(events));

    await ui.activateSession('chat:a');
    const replayed = ui.container.querySelector('.ds-flow-item[data-call-id="c1"]');
    const replayedStatus = replayed?.getAttribute('data-status');
    const replayedSummary = ui.container.querySelector('.ds-flow-summary-text')?.textContent ?? '';
    console.log('[R7-A] replayed status =', replayedStatus, '| summary =', JSON.stringify(replayedSummary));

    // 期望：即便 DOM 已切走，结果也应记入原会话的执行记录，回放呈现已执行。
    expect(accepted).toBe(true);
    expect(events).toContain('tool-result');
    expect(replayedStatus).toBe('succeeded');
  });

  it('REPRO-B: 回放把持久化信封当作 data，输出退化成原始 JSON 而非可读文本', async () => {
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:a' });
    await ui.activateSession('chat:a');
    ui.addUserMessage('RUN-LS');
    ui.startToolCard('c1', { toolName: 'shell_exec', params: { command: 'ls' } });
    ui.finishToolCard('c1', { toolName: 'shell_exec', params: { command: 'ls' } }, SHELL_RESULT, 12);

    const liveExpected = outputTexts(ui).some((text) => text.includes('HELLO-R7'));
    expect(liveExpected).toBe(true);

    await ui.activateSession('chat:b');
    await vi.waitFor(() => {
      expect(storedSession(kv, 'chat:a')?.events?.some((event) => event.type === 'tool-result')).toBe(true);
    }, { timeout: 1000 });
    await ui.activateSession('chat:a');

    const texts = outputTexts(ui);
    console.log('[R7-B] live output has content?', liveExpected, '| replay texts =', JSON.stringify(texts.map((t) => t.slice(0, 120))));
    // 期望：回放与实时一致，显示 content 文本；实际回放把 {data,content,details} 信封整体当 data 序列化。
    expect(texts.some((text) => text.includes('HELLO-R7'))).toBe(true);
    expect(texts.some((text) => text.includes('"details"'))).toBe(false);
  });

  it('REPRO-C: 只含 tool-start 的会话回放后计数仍显示“执行中”，且秒表从回放时刻重新起跳', async () => {
    const kv = memoryKv();
    const session: StudioExecutionSession = {
      version: 2,
      key: 'chat:crashed',
      createdAt: Date.now() - 60000,
      updatedAt: Date.now(),
      events: [
        { type: 'user-message', at: Date.now() - 60000, turnId: 't1', text: 'CRASHED-RUN' },
        {
          type: 'tool-start',
          at: Date.now() - 60000,
          turnId: 't1',
          callId: 'c9',
          toolName: 'shell_exec',
          params: { command: 'sleep 600' },
        },
      ],
    };
    kv.values.set(studioExecutionStorageKey('chat:crashed'), session);
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:crashed' });
    await ui.activateSession('chat:crashed');

    const item = ui.container.querySelector('.ds-flow-item[data-call-id="c9"]');
    const summary = ui.container.querySelector('.ds-flow-summary-text')?.textContent ?? '';
    console.log('[R7-C] replayed status =', item?.getAttribute('data-status'), '| summary =', JSON.stringify(summary));
    // 期望：页面重载/崩溃恢复后，未完成的调用应被标记为中断，而不是继续“执行中”。
    expect(item?.getAttribute('data-status')).not.toBe('running');
    expect(summary).not.toContain('执行中');
  });

  it('REPRO-D: 切到新会话后旧回合迟到的 tool-start 在新会话建卡并落账', async () => {
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
    ui.appendToAssistantMessage('A-STREAMING');

    await ui.activateSession('chat:b');
    // 旧回合的流没停：切换之后才解析出工具标签，interceptor 仍会 forward。
    ui.startToolCard('late1', { toolName: 'shell_exec', params: { command: 'cat secret.txt' } });
    ui.finishToolCard(
      'late1',
      { toolName: 'shell_exec', params: { command: 'cat secret.txt' } },
      SHELL_RESULT,
      5,
    );

    const leakedCard = ui.container.querySelector('.ds-flow-item[data-call-id="late1"]');
    await vi.waitFor(() => {
      const events = storedSession(kv, 'chat:b')?.events?.map((event) => event.type) ?? [];
      expect(events).toContain('tool-start');
    }, { timeout: 300 }).catch(() => {});
    const events = storedSession(kv, 'chat:b')?.events?.map((event) => event.type) ?? [];
    console.log('[R7-D] chat:b card present =', !!leakedCard, '| chat:b events =', JSON.stringify(events));

    // 期望：旧回合的工具调用不得出现在新会话的 DOM 与执行记录里。
    expect(leakedCard).toBeNull();
    expect(events).not.toContain('tool-start');
    expect(events).not.toContain('tool-result');
  });
});
