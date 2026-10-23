/**
 * 手机/远程端统一执行会话视图。
 *
 * 数据源只有 Studio overlay 写入、宿主镜像的 StudioExecutionSession；
 * 不再用 AgentLoopEvent 另造一份聊天历史。
 */
import type {
  StudioExecutionIndex,
  StudioExecutionSession,
} from '../../shared/studio-execution';
import { renderMarkdown } from '../../inject/markdown';
import { appendMessage, getCenterBody } from './workbench-center';
import { appendToolRun, getInspectorBody } from './workbench-inspector';
import type { ToolRunEvent } from '../../shared/tool-run-event';

function clear(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function emptyState(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.setAttribute('data-empty', '');
  el.textContent = text;
  return el;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function renderExecutionIndex(
  container: HTMLElement,
  index: StudioExecutionIndex | null,
  activeKey: string | null,
  onSelect: (key: string) => void,
): void {
  clear(container);
  const sessions = index?.sessions ?? [];
  if (sessions.length === 0) {
    container.appendChild(emptyState('暂无 Studio 执行记录'));
    return;
  }

  for (const entry of sessions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'session-item';
    item.dataset.sessionKey = entry.key;
    item.setAttribute('aria-current', entry.key === activeKey ? 'true' : 'false');

    const title = document.createElement('span');
    title.className = 'session-item-title';
    title.textContent = entry.title || '未命名会话';

    const meta = document.createElement('span');
    meta.className = 'session-item-meta';
    meta.textContent = formatTime(entry.updatedAt);

    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener('click', () => onSelect(entry.key));
    container.appendChild(item);
  }
}

/**
 * 窄屏没有左侧栏时，用原生 select 复用同一份索引。
 * 这里只重建 option，不绑定 change，避免每次刷新累积监听器。
 */
export function renderExecutionIndexSelect(
  select: HTMLSelectElement,
  index: StudioExecutionIndex | null,
  activeKey: string | null,
): void {
  clear(select);
  const sessions = index?.sessions ?? [];
  if (sessions.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '暂无 Studio 执行记录';
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const entry of sessions) {
    const option = document.createElement('option');
    option.value = entry.key;
    option.textContent = `${entry.title || '未命名会话'} · ${formatTime(entry.updatedAt)}`;
    option.selected = entry.key === activeKey;
    select.appendChild(option);
  }
}

function appendAssistantMarkdown(canvas: HTMLElement, text: string): void {
  const el = appendMessage(canvas, 'assistant', '');
  // renderMarkdown 已通过 marked + DOMPurify 清洗。
  el.innerHTML = renderMarkdown(text);
}

function toolEvent(
  event: Extract<StudioExecutionSession['events'][number], { type: 'tool-start' | 'tool-result' }>,
): ToolRunEvent {
  if (event.type === 'tool-start') {
    return {
      type: 'tool-run',
      runId: event.callId,
      tool: event.toolName,
      phase: 'started',
      botId: 'main',
    };
  }
  return {
    type: 'tool-run',
    runId: event.callId,
    tool: event.toolName,
    phase: event.ok ? 'succeeded' : 'failed',
    durationMs: event.durationMs,
    errorCode: event.ok ? undefined : (event.error || 'tool-failed'),
    botId: 'main',
  };
}

export function renderExecutionSession(
  canvas: HTMLElement,
  inspectors: readonly HTMLElement[],
  session: StudioExecutionSession | null,
): void {
  const center = getCenterBody(canvas);
  clear(center);
  for (const inspector of inspectors) clear(getInspectorBody(inspector));

  if (!session || session.events.length === 0) {
    center.appendChild(emptyState('暂无执行记录。请在电脑端 Studio 主视图发起任务。'));
    return;
  }

  for (const event of session.events) {
    switch (event.type) {
      case 'user-message':
        appendMessage(canvas, 'user', event.text);
        break;
      case 'tool-start':
      case 'tool-result': {
        const run = toolEvent(event);
        for (const inspector of inspectors) appendToolRun(inspector, run);
        break;
      }
      case 'final-answer':
        appendAssistantMarkdown(canvas, event.text);
        break;
      case 'system-error':
        appendMessage(canvas, 'error', `${event.message}（${event.code}）`);
        break;
    }
  }
}
