/**
 * 右栏 Inspector：把 {type:'tool-run'} 事件渲染为工具卡片。
 * 复用 primitives/tool-run-card（不得重造）；终态按 runId 去重，每 runId 只留一条终态。
 * P1：有真实数据源的 W3 附属卡（artifact / diff-review / error）挂进主卡片内部，
 * 不新增右栏顶层节点——否则按 data-run-id 的终态去重会漏掉附属卡。
 */
import { toolRunCard } from '../primitives/tool-run-card';
import { renderArtifactCard } from './components/artifact-card';
import { renderDiffReview } from './components/diff-review';
import { renderErrorCard } from './components/error-card';
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
/**
 * 附属卡：只挂有真实数据源的三个（P1）。
 * - artifact-card：X2 已供 artifactPaths（仅 file.edit，无源不猜）
 * - diff-review：EditEngineData 的 path/替换数/字节数/哈希，后端已在发
 * - error-card：终态失败/拒绝时展示中文错误码
 * 全部 appendChild 进主卡片内部，随主卡片一起 replaceWith，不会叠加。
 */
export function attachToolRunAttachments(card: HTMLElement, event: ToolRunEvent): void {
  const artifact = renderArtifactCard(event);
  if (artifact) card.appendChild(artifact);

  const diff = renderDiffReview(event);
  if (diff) card.appendChild(diff);

  const failed = event.phase === 'failed' || event.phase === 'denied';
  if (failed && event.errorCode) {
    card.appendChild(renderErrorCard({ errorCode: event.errorCode }));
  }
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
  attachToolRunAttachments(card, event);

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
