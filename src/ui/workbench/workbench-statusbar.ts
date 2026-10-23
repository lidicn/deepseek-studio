/**
 * 状态条（§10.7 28px）：connection / running / lastError 的只读投影。
 * 1008 鉴权失败显示「鉴权失败，请重启应用」；断线显示「连接断开，重试中」。
 */
import type { WorkbenchState } from './workbench-state';

const CONNECTION_LABEL: Record<WorkbenchState['connection'], string> = {
  connecting: '连接中…',
  connected: '已连接',
  disconnected: '连接断开，重试中',
  'auth-failed': '鉴权失败，请重启应用',
};

export function renderStatusbar(bar: HTMLElement, state: WorkbenchState): void {
  bar.textContent = '';

  const conn = document.createElement('span');
  conn.className = `status-conn conn-${state.connection}`;
  conn.textContent = CONNECTION_LABEL[state.connection];
  bar.appendChild(conn);

  if (state.running) {
    const running = document.createElement('span');
    running.className = 'status-running';
    running.textContent = '智能体执行中…';
    bar.appendChild(running);
  }

  if (state.memoryBackend === 'memory') {
    const memory = document.createElement('span');
    memory.className = 'status-memory-warning';
    memory.textContent = '记忆库降级为内存，重启后丢失';
    bar.appendChild(memory);
  }

  if (state.lastError && state.connection !== 'connected') {
    const err = document.createElement('span');
    err.className = 'status-error';
    err.textContent = state.lastError;
    bar.appendChild(err);
  }
}
