/**
 * 右栏 Inspector：把 {type:'tool-run'} 事件渲染为工具卡片。
 * 复用 primitives/tool-run-card（不得重造）；终态按 runId 去重，每 runId 只留一条终态。
 */
import { toolRunCard } from '../primitives/tool-run-card';
import { TERMINAL_PHASES, type ToolRunEvent } from '../../shared/tool-run-event';

export function getInspectorBody(inspector: HTMLElement): HTMLElement {
  let body = inspector.querySelector<HTMLElement>('.inspector-body, .pane-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'pane-body inspector-body';
    inspector.appendChild(body);
  }
  return body;
}

/** 追加/刷新一张工具运行卡片；卡片以 data-run-id 锚定。 */
export function appendToolRun(inspector: HTMLElement, event: ToolRunEvent): void {
  if (!event || !event.tool) return;
  const body = getInspectorBody(inspector);
  body.querySelectorAll('[data-empty]').forEach((n) => n.remove());

  let existing: HTMLElement | null = null;
  const matched = body.querySelectorAll<HTMLElement>('[data-run-id]');
  for (const n of Array.from(matched)) {
    if (n.getAttribute('data-run-id') === event.runId) {
      existing = n;
      break;
    }
  }
  const card = toolRunCard(event);
  card.setAttribute('data-run-id', event.runId);

  if (existing) {
    // 已有终态，不被进行中事件覆盖。
    const prevPhase = existing.getAttribute('data-phase');
    const terminal = TERMINAL_PHASES.has(event.phase);
    if (prevPhase && TERMINAL_PHASES.has(prevPhase as never) && !terminal) return;
    existing.replaceWith(card);
    card.setAttribute('data-phase', event.phase);
    return;
  }
  card.setAttribute('data-phase', event.phase);
  body.appendChild(card);
  body.scrollTop = body.scrollHeight;
}
