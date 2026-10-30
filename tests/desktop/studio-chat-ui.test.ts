// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioChatUI, type StudioChatUIHandle } from '../../src/ui/studio-chat-ui';
import { createStudioExecutionStore, type StudioExecutionKv } from '../../src/ui/studio-execution-store';
import {
  STUDIO_EXECUTION_INDEX_KEY,
  appendExecutionEvent,
  createEmptyStudioExecutionSession,
  type StudioExecutionSession,
} from '../../src/shared/studio-execution';

function historySession(
  key: string,
  events: Array<{ type: 'user-message'; text: string } | { type: 'final-answer'; text: string }>,
): StudioExecutionSession {
  const session = createEmptyStudioExecutionSession(key, 1000);
  events.forEach((event, index) => {
    appendExecutionEvent(session, {
      ...event,
      at: 1000 + index,
      turnId: `history-${index}`,
    });
  });
  return session;
}

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

function fakeBox(el: Element, rect: { top: number; height: number; width?: number; left?: number }): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: rect.width ?? 600 });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: rect.height });
  (el as HTMLElement).getBoundingClientRect = () => ({
    x: rect.left ?? 280,
    y: rect.top,
    top: rect.top,
    left: rect.left ?? 280,
    right: (rect.left ?? 280) + (rect.width ?? 600),
    bottom: rect.top + rect.height,
    width: rect.width ?? 600,
    height: rect.height,
    toJSON: () => ({}),
  });
}

function addMeasuredComposer(): void {
  const card = document.createElement('div');
  const textarea = document.createElement('textarea');
  card.appendChild(textarea);
  document.body.appendChild(card);
  fakeBox(textarea, { top: 630, height: 24 });
  fakeBox(card, { top: 560, height: 180 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
}

function mount(options?: Parameters<typeof createStudioChatUI>[0]): StudioChatUIHandle {
  const ui = createStudioChatUI(options);
  document.body.appendChild(ui.container);
  return ui;
}

describe('Studio 主视图', () => {
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

  it('默认可见；测量到 composer 后避开内容区，并支持 Ctrl+Shift+H 往返', () => {
    addMeasuredComposer();
    ui = mount();
    expect(ui.container.classList.contains('ds-studio-chat-hidden')).toBe(false);
    expect(ui.container.classList.contains('ds-studio-chat-pending')).toBe(false);
    expect(ui.container.style.bottom).not.toBe('');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', ctrlKey: true, shiftKey: true }));
    expect(ui.container.classList.contains('ds-studio-chat-hidden')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, shiftKey: true }));
    expect(ui.container.classList.contains('ds-studio-chat-hidden')).toBe(false);
  });

  it('测不到 composer 时保持 pending，不用 Studio 层遮挡原生页面', () => {
    ui = mount();
    expect(ui.container.classList.contains('ds-studio-chat-pending')).toBe(true);
    expect(ui.container.style.pointerEvents).toBe('');
  });

  it('工具卡只写入 .ds-sc-msg-assistant，原生消息树完全不变', () => {
    addMeasuredComposer();
    const native = document.createElement('div');
    native.className = 'ds-assistant-message-main-content';
    native.innerHTML = '<p>原生内容</p>';
    document.body.appendChild(native);
    const before = native.innerHTML;

    ui = mount();
    ui.addUserMessage('执行任务');
    ui.startAssistantMessage();
    ui.startToolCard('call-1', { toolName: 'shell_exec', params: { command: 'pwd' } });
    expect(ui.finishToolCard(
      'call-1',
      { toolName: 'shell_exec', params: { command: 'pwd' } },
      { ok: true, data: { stdout: 'E:/work' } },
      12,
    )).toBe(true);

    expect(native.innerHTML).toBe(before);
    expect(ui.container.querySelectorAll('.ds-sc-msg-assistant .ds-flow-item')).toHaveLength(1);
    expect(document.querySelectorAll('.ds-assistant-message-main-content .ds-flow-item')).toHaveLength(0);
  });

  it('Workbench Inspector 已吸收到主视图：可展开并显示工具终态', () => {
    addMeasuredComposer();
    ui = mount();
    ui.addUserMessage('执行任务');
    ui.startAssistantMessage();
    ui.startToolCard('call-inspector', { toolName: 'shell_exec', params: { command: 'pwd' } });
    ui.finishToolCard(
      'call-inspector',
      { toolName: 'shell_exec', params: { command: 'pwd' } },
      { ok: true, data: { stdout: 'E:/work' } },
      12,
    );

    const toggle = ui.container.querySelector<HTMLButtonElement>('.ds-sc-inspector-toggle');
    const inspector = ui.container.querySelector<HTMLElement>('.ds-sc-inspector');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(inspector?.classList.contains('open')).toBe(true);
    expect(inspector?.textContent).toContain('shell_exec');
    expect(inspector?.textContent).toContain('成功');
  });

  it('最终答复走 Markdown 清洗，错误卡显示中文错误码并写持久化记录', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:test' });
    await ui.activateSession('chat:test');
    ui.addUserMessage('总结');
    ui.startAssistantMessage();
    ui.appendToAssistantMessage('**结论**\n\n<script>alert(1)</script>');
    ui.finishAssistantMessage();
    ui.appendError('page-disconnected');

    const markdown = ui.container.querySelector('.ds-sc-markdown');
    expect(markdown?.innerHTML).toContain('<strong>结论</strong>');
    expect(markdown?.querySelector('script')).toBeNull();
    expect(ui.container.querySelector('.ds-sc-error-card')?.textContent).toContain('页面连接已断开');
    await vi.waitFor(() => {
      expect(kv.values.get(STUDIO_EXECUTION_INDEX_KEY)).toBeDefined();
    });
  });

  it('工具结果晚于气泡定稿返回时，仍回写原 callId 卡片而不是新回合', () => {
    addMeasuredComposer();
    ui = mount();
    ui.addUserMessage('延迟工具');
    ui.startAssistantMessage();
    const firstAssistant = ui.container.querySelector('.ds-sc-msg-assistant');
    ui.startToolCard('slow-call', { toolName: 'shell_exec', params: { command: 'sleep 2' } });
    ui.finishAssistantMessage({ recordFinal: false });
    ui.startAssistantMessage({ name: '下一回合' });

    expect(ui.finishToolCard(
      'slow-call',
      { toolName: 'shell_exec', params: { command: 'sleep 2' } },
      { ok: true, data: { stdout: 'done' } },
      2000,
    )).toBe(true);
    expect(firstAssistant?.querySelector('.ds-flow-item[data-status="succeeded"]')).not.toBeNull();
    expect(ui.container.querySelectorAll('.ds-flow-item')).toHaveLength(1);
  });

  it('切换会话会从持久化记录恢复最终答复', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:a' });
    await ui.activateSession('chat:a');
    ui.addUserMessage('旧会话');
    ui.startAssistantMessage();
    ui.appendToAssistantMessage('恢复出来的结论');
    ui.finishAssistantMessage();
    await vi.waitFor(() => expect(kv.values.size).toBeGreaterThan(0));

    await ui.activateSession('chat:b');
    expect(ui.container.textContent).not.toContain('恢复出来的结论');
    await ui.activateSession('chat:a');
    await vi.waitFor(() => {
      expect(ui?.container.textContent).toContain('恢复出来的结论');
    });
  });

  it('切换会话恢复工具记录时保留原始参数', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:tools' });
    await ui.activateSession('chat:tools');
    ui.addUserMessage('执行工具');
    ui.startAssistantMessage();
    ui.startToolCard('call-restore', {
      toolName: 'shell_exec',
      params: { command: 'Write-Output studio-restore-ok' },
    });
    ui.finishToolCard(
      'call-restore',
      { toolName: 'shell_exec', params: {} },
      { ok: true, data: { stdout: 'studio-restore-ok' } },
      10,
    );
    await vi.waitFor(() => expect(kv.values.size).toBeGreaterThan(0));

    await ui.activateSession('chat:other');
    await ui.activateSession('chat:tools');
    await vi.waitFor(() => {
      expect(ui?.container.textContent).toContain('Write-Output studio-restore-ok');
    });
  });

  it('重放历史错误折叠成一条汇总，不逐张刷卡片', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:replay-err' });
    // 造一段带 3 条历史错误的会话（模拟 QD-R4 之前被静默吞掉、修复后才显形的旧账）。
    for (let i = 0; i < 3; i++) {
      await persistence.saveEvent('chat:replay-err', {
        type: 'system-error',
        at: Date.now(),
        turnId: 'stale-turn',
        code: i === 2 ? 'stream-incomplete' : 'network-error',
        message: '历史错误',
      });
    }
    await persistence.saveEvent('chat:replay-err', {
      type: 'user-message',
      at: Date.now(),
      turnId: 'stale-turn',
      text: '上一段对话',
    });

    await ui.activateSession('chat:other');
    await ui.activateSession('chat:replay-err');
    await vi.waitFor(() => {
      expect(ui?.container.querySelector('.ds-sc-replay-error-summary')).not.toBeNull();
    });

    // 折叠：3 条错误只出 1 条汇总，且逐张的错误卡一张都没有。
    expect(ui.container.querySelectorAll('.ds-sc-error-card')).toHaveLength(0);
    const summary = ui.container.querySelector('.ds-sc-replay-error-summary-text');
    expect(summary?.textContent).toContain('历史记录中有 3 条执行未完成');
    expect(summary?.textContent).toContain('network-error x2');
    expect(summary?.textContent).toContain('stream-incomplete x1');
    // 明确标注非本轮，避免用户把旧账当成本轮失败。
    expect(summary?.textContent).toContain('非本轮产生');
  });

  it('孤儿错误不入账：没有 user-message 的回合错误被丢弃', () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:orphan' });
    // 不调用 addUserMessage，currentTurnId 与任何 user-message 都对应不上。
    ui.appendError('network-error', '服务器暂时无法访问。');

    const card = ui.container.querySelector('.ds-sc-error-card');
    expect(card?.textContent).toContain('服务器暂时无法访问');
    // 画面仍提示，但这条孤儿错误不写任何持久化键：既不进会话，也不建索引。
    return Promise.resolve().then(() => {
      const keys = [...kv.values.keys()];
      for (const k of keys) {
        const session = kv.values.get(k) as { events?: Array<{ type: string }> };
        expect(session?.events?.some((e) => e.type === 'system-error')).not.toBe(true);
      }
    });
  });

  it('激活 route: 临时桶按空白会话处理，不放纵历史残留', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'route:/' });
    // 先在 route: 桶里写一段历史（模拟上一次临时对话）。
    await persistence.saveEvent('route:/', {
      type: 'user-message',
      at: Date.now(),
      turnId: 'stale-turn',
      text: '上一段临时对话',
    });
    await persistence.saveEvent('route:/', {
      type: 'final-answer',
      at: Date.now(),
      turnId: 'stale-turn',
      text: '上一段临时结论',
    });

    // 新开对话：激活同一个 route: 键必须清空，而不是重放旧历史。
    await ui.activateSession('route:/');
    expect(ui.container.textContent).not.toContain('上一段临时结论');
    expect(ui.container.querySelector('[data-studio-empty-state="true"]')).not.toBeNull();
  });

  it('侧栏收起态 fab 避让：overlay 首带被裁掉，fab 可点击', () => {
    addMeasuredComposer();
    // 伪造左上角 fab：白底圆角条，top/left 都贴 0，含按钮。
    const fab = document.createElement('div');
    const btn = document.createElement('button');
    btn.textContent = '新对话';
    fab.appendChild(btn);
    document.body.appendChild(fab);
    fakeBox(fab, { top: 0, height: 44, width: 140, left: 0 });

    ui = mount();
    // fab 下沿写入容器变量，CSS 用 clip-path 真正裁掉首带（既透明又点击穿透）。
    expect(ui.container.style.getPropertyValue('--sc-fab-guard')).toBe('44px');
  });

  it('fab 嵌在 #root 深层时也能测到（body 直接子元素里没有它）', () => {
    addMeasuredComposer();
    // 复现真实缺陷：fab 位于 #root > div > ... > div.ca6d4be1._5a20a69，
    // 旧实现只扫 body > *，永远返回 0，避让静默失效。
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    const level1 = document.createElement('div');
    const level2 = document.createElement('div');
    level2.className = 'c3ecdb44';
    const level3 = document.createElement('div');
    level3.className = 'dc04ec1d a02af2e6';
    const level4 = document.createElement('div');
    level4.className = 'ca6d4be1 _5a20a69';
    level4.appendChild(document.createElement('button'));
    root.appendChild(level1);
    level1.appendChild(level2);
    level2.appendChild(level3);
    level3.appendChild(level4);
    fakeBox(level4, { top: 12, height: 40, width: 140, left: 12 });

    ui = mount();
    expect(ui.container.style.getPropertyValue('--sc-fab-guard')).toBe('52px');
  });

  it('侧栏展开态不做 fab 避让：变量归零，不裁任何区域', () => {
    addMeasuredComposer();
    // 侧栏展开：measureSidebarRight 命中，left>0，fab 本就在侧栏里。
    const sidebar = document.createElement('div');
    sidebar.className = 'ds-native-sidebar';
    document.body.appendChild(sidebar);
    fakeBox(sidebar, { top: 0, height: 800, width: 260, left: 0 });

    ui = mount();
    expect(ui.container.style.left).toBe('268px');
    expect(ui.container.style.getPropertyValue('--sc-fab-guard')).toBe('0px');
  });

  it('上下文预算提示：有文案时可见，空串清除，且不产生消息气泡', () => {
    addMeasuredComposer();
    ui = mount();
    const notice = ui.container.querySelector('.ds-sc-context-notice') as HTMLElement;
    expect(notice).toBeTruthy();
    expect(notice.classList.contains('visible')).toBe(false);
    expect(notice.textContent).toBe('');

    ui.setContextNotice('上下文已过半（约 33k 字符）');
    expect(notice.classList.contains('visible')).toBe(true);
    expect(notice.textContent).toContain('33k');

    ui.setContextNotice('   ');
    expect(notice.classList.contains('visible')).toBe(false);

    // 提示只是状态栏文字，不写进消息列表，也不落执行记录。
    expect(ui.container.querySelectorAll('.ds-sc-msg-assistant')).toHaveLength(0);
  });

  it('切换会话会清掉上一条预算提示，避免旧告警挂到新会话', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:budget-a' });
    await ui.activateSession('chat:budget-a');
    ui.setContextNotice('上下文已过半（约 33k 字符）');
    const notice = ui.container.querySelector('.ds-sc-context-notice') as HTMLElement;
    expect(notice.classList.contains('visible')).toBe(true);

    await ui.activateSession('chat:budget-b');
    expect(notice.textContent).toBe('');
    expect(notice.classList.contains('visible')).toBe(false);

    // 同一会话重复激活（回合在飞）不清屏，但也不该把提示复活。
    ui.setContextNotice('上下文已接近上限');
    await ui.activateSession('chat:budget-b');
    expect(notice.classList.contains('visible')).toBe(false);
  });

  it('清空记录同时清掉预算提示', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    ui = mount({ persistence, initialSessionKey: 'chat:budget-c' });
    await ui.activateSession('chat:budget-c');
    ui.setContextNotice('上下文已过半');
    await ui.clearHistory();
    const notice = ui.container.querySelector('.ds-sc-context-notice') as HTMLElement;
    expect(notice.classList.contains('visible')).toBe(false);
  });

  it('本地无记录时水合跨设备历史并写入本地缓存', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    const hydrateHistory = vi.fn(async (key: string) => historySession(key, [
      { type: 'user-message', text: key === 'chat:remote' ? '其他设备提出的问题' : '另一会话' },
      ...(key === 'chat:remote'
        ? [{ type: 'final-answer' as const, text: '其他设备得到的**回答**' }]
        : []),
    ]));
    ui = mount({ persistence, initialSessionKey: 'chat:remote', hydrateHistory });
    await ui.activateSession('chat:remote');

    expect(hydrateHistory).toHaveBeenCalledWith('chat:remote');
    expect(ui.container.textContent).toContain('其他设备提出的问题');
    expect(ui.container.querySelector('.ds-sc-markdown')?.innerHTML).toContain('<strong>回答</strong>');
    await vi.waitFor(() => {
      expect(kv.values.get(STUDIO_EXECUTION_INDEX_KEY)).toBeDefined();
    });

    // 已落盘后再次切回不再重复请求。
    await ui.activateSession('chat:other');
    await ui.activateSession('chat:remote');
    expect(hydrateHistory.mock.calls.filter(([key]) => key === 'chat:remote')).toHaveLength(1);
    await vi.waitFor(() => {
      expect(ui?.container.textContent).toContain('其他设备提出的问题');
    });
  });

  it('水合失败时显示明确空态，不伪造内容', async () => {
    addMeasuredComposer();
    ui = mount({
      initialSessionKey: 'chat:missing',
      hydrateHistory: async () => null,
    });
    await ui.activateSession('chat:missing');

    expect(ui.container.textContent).toContain('未找到该会话可显示的历史内容');
    expect(ui.container.querySelector('.ds-sc-msg-user')).toBeNull();
    expect(ui.container.querySelector('.ds-sc-msg-assistant')).toBeNull();
  });

  it('本地存在空壳会话（有记录但无事件）时也走水合', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    // 索引里已有标题、但正文从未落盘：只存一个空壳会话。
    await persistence.saveSession(createEmptyStudioExecutionSession('chat:shell'));
    const hydrateHistory = vi.fn(async (key: string) => historySession(key, [
      { type: 'user-message', text: '空壳会话的历史问题' },
      { type: 'final-answer', text: '空壳会话的历史回答' },
    ]));
    ui = mount({ persistence, initialSessionKey: 'chat:shell', hydrateHistory });
    await ui.activateSession('chat:shell');

    expect(hydrateHistory).toHaveBeenCalledWith('chat:shell');
    expect(ui.container.textContent).toContain('空壳会话的历史问题');
    expect(ui.container.textContent).toContain('空壳会话的历史回答');
  });

  it('本地只有用户提问的半截记录时，也水合补全回答', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    // 流式中断等场景：本地只落下了用户提问，没有回答。
    await persistence.saveSession(historySession('chat:half', [
      { type: 'user-message', text: '半截会话的提问' },
    ]));
    const hydrateHistory = vi.fn(async (key: string) => historySession(key, [
      { type: 'user-message', text: '半截会话的提问' },
      { type: 'final-answer', text: '半截会话的补全回答' },
    ]));
    ui = mount({ persistence, initialSessionKey: 'chat:half', hydrateHistory });
    await ui.activateSession('chat:half');

    expect(hydrateHistory).toHaveBeenCalledWith('chat:half');
    expect(ui.container.textContent).toContain('半截会话的提问');
    expect(ui.container.textContent).toContain('半截会话的补全回答');
  });

  it('本地只捕获到部分轮次时，按原生轮数补全并替换本地记录', async () => {
    addMeasuredComposer();
    const kv = memoryKv();
    const persistence = createStudioExecutionStore({
      kv,
      onConnected: () => () => {},
      isConnected: () => true,
    });
    // 旧逻辑的坑：本地已有 final-answer 就被当成"完整"，永远不水合。
    const partial = createEmptyStudioExecutionSession('chat:partial', 1000);
    appendExecutionEvent(partial, {
      type: 'tool-start', at: 1001, turnId: 't1', callId: 'c1',
      toolName: 'shell_exec', params: { command: 'echo 1' },
    });
    appendExecutionEvent(partial, {
      type: 'tool-result', at: 1002, turnId: 't1', callId: 'c1',
      toolName: 'shell_exec', ok: true, result: { stdout: 'done' },
    });
    appendExecutionEvent(partial, {
      type: 'user-message', at: 1003, turnId: 't1', text: '第一轮提问',
    });
    appendExecutionEvent(partial, {
      type: 'final-answer', at: 1004, turnId: 't1', text: '第一轮回答',
    });
    await persistence.saveSession(partial);
    const hydrateHistory = vi.fn(async (key: string) => historySession(key, [
      { type: 'user-message', text: '第一轮提问' },
      { type: 'final-answer', text: '第一轮回答' },
      { type: 'user-message', text: '第二轮提问' },
      { type: 'final-answer', text: '第二轮回答' },
      { type: 'user-message', text: '第三轮提问' },
    ]));
    ui = mount({ persistence, initialSessionKey: 'chat:partial', hydrateHistory });
    await ui.activateSession('chat:partial');

    expect(hydrateHistory).toHaveBeenCalledWith('chat:partial');
    const text = ui.container.textContent ?? '';
    expect(text).toContain('第三轮提问');
    expect(text).toContain('第二轮回答');
    expect(ui.container.querySelectorAll('.ds-sc-msg-user')).toHaveLength(3);
    // 原生历史轮数更多时以原生为准，工具过程卡让位。
    expect(ui.container.querySelectorAll('.ds-sc-msg-assistant')).toHaveLength(2);
  });

  it('快速切换会话时，慢水合响应不得覆盖当前会话', async () => {
    addMeasuredComposer();
    let resolveSlow: ((session: StudioExecutionSession | null) => void) | null = null;
    const hydrateHistory = vi.fn((key: string) => {
      if (key === 'chat:slow') {
        return new Promise<StudioExecutionSession | null>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(historySession(key, [
        { type: 'user-message', text: 'B 会话内容' },
      ]));
    });
    ui = mount({ initialSessionKey: 'chat:slow', hydrateHistory });
    const slow = ui.activateSession('chat:slow');
    await ui.activateSession('chat:fast');
    (resolveSlow as ((session: StudioExecutionSession | null) => void) | null)?.(historySession('chat:slow', [
      { type: 'user-message', text: 'A 会话迟到内容' },
    ]));
    await slow;

    expect(ui.container.textContent).toContain('B 会话内容');
    expect(ui.container.textContent).not.toContain('A 会话迟到内容');
  });
});
