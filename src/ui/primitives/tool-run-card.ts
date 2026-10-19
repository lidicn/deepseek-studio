/**
 * 工具运行状态卡片
 */
import type { ToolRunEvent } from '../../shared/tool-run-event';
import { statusDot } from './status-dot';
import { badge } from './badge';

export function toolRunCard(event: ToolRunEvent): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'padding: 10px 12px',
    'border-bottom: 1px solid var(--studio-border, #eee)',
    'font-size: 12px',
  ].join('; ');

  const row1 = document.createElement('div');
  row1.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 4px;';

  const dot = statusDot(
    event.phase === 'started' ? 'running' :
    event.phase === 'succeeded' ? 'ok' :
    event.phase === 'failed' || event.phase === 'denied' ? 'error' : 'idle'
  );
  row1.appendChild(dot);

  const toolName = document.createElement('span');
  toolName.textContent = event.tool;
  toolName.style.cssText = 'font-weight: 600; color: var(--studio-text-primary, #16181D);';
  row1.appendChild(toolName);

  row1.appendChild(badge(event.phase, event.phase === 'failed' || event.phase === 'denied' ? 'danger' : event.phase === 'succeeded' ? 'success' : 'default'));

  el.appendChild(row1);

  if (event.durationMs !== undefined) {
    const dur = document.createElement('div');
    dur.textContent = `${event.durationMs}ms`;
    dur.style.cssText = 'color: var(--studio-text-weak, #6B7280); font-size: 11px; margin-left: 14px;';
    el.appendChild(dur);
  }

  if (event.errorCode) {
    const err = document.createElement('div');
    err.textContent = event.errorCode;
    err.style.cssText = 'color: var(--studio-danger, #C43A3A); font-size: 11px; margin-left: 14px; margin-top: 2px;';
    el.appendChild(err);
  }

  return el;
}
