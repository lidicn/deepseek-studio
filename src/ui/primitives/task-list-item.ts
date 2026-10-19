/**
 * 任务列表项组件
 */
import { statusDot } from './status-dot';
import { badge } from './badge';

export interface TaskItem {
  id: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed' | 'idle';
  updatedAt: number;
}

export function taskListItem(task: TaskItem): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'display: flex',
    'align-items: center',
    'gap: 8px',
    'padding: 10px 12px',
    'border-radius: 8px',
    'cursor: pointer',
    'transition: background 0.15s',
  ].join('; ');
  el.addEventListener('mouseenter', () => { el.style.background = 'var(--studio-bg-subtle, #F5F6F8)'; });
  el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });

  const dot = statusDot(task.status === 'running' ? 'running' : task.status === 'failed' ? 'error' : task.status === 'succeeded' ? 'ok' : 'idle');
  el.appendChild(dot);

  const title = document.createElement('span');
  title.textContent = task.title;
  title.style.cssText = 'flex: 1; font-size: 13px; color: var(--studio-text-primary, #16181D); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
  el.appendChild(title);

  if (task.status === 'running') {
    el.appendChild(badge('执行中', 'primary'));
  } else if (task.status === 'failed') {
    el.appendChild(badge('失败', 'danger'));
  } else if (task.status === 'succeeded') {
    el.appendChild(badge('完成', 'success'));
  }

  return el;
}
