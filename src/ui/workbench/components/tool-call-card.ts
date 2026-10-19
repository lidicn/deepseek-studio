/**
 * ToolCallCard：输入 ToolRunEvent，按 phase 渲染状态文案。
 * 视觉基础复用 primitives/tool-run-card（不重造）；未知工具委托 UnknownToolCard。
 * 缺 details / 缺 tool 均不崩溃。
 */
import { toolRunCard } from '../../primitives/tool-run-card';
import type { ToolRunEvent } from '../../../shared/tool-run-event';
import { describeErrorCode } from '../../../shared/ui-error-codes';
import { renderUnknownTool } from './unknown-tool-card';

const PHASE_LABEL: Record<string, string> = {
  started: '运行中…',
  succeeded: '成功',
  failed: '失败',
  denied: '被拒绝',
  cancelled: '已取消',
};

export function renderToolCallCard(event: ToolRunEvent | null | undefined): HTMLElement {
  if (!event || !event.tool) {
    return renderUnknownTool(event?.tool);
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'wb-tool-call';
  wrapper.setAttribute('data-run-id', event.runId ?? '');
  wrapper.setAttribute('data-phase', event.phase);

  // 未知工具（无注册展示）走兜底；这里 primitives 卡片已能展示任意工具名，
  // 仅当 tool 名缺失时才视为未知。
  wrapper.appendChild(toolRunCard(event));

  const status = document.createElement('div');
  status.className = 'wb-tool-status';
  status.textContent = PHASE_LABEL[event.phase] ?? event.phase;
  wrapper.appendChild(status);

  if (event.phase === 'failed' && event.errorCode) {
    const err = document.createElement('div');
    err.className = 'wb-tool-error';
    err.textContent = describeErrorCode(event.errorCode);
    wrapper.appendChild(err);
  }
  if (event.phase === 'denied') {
    const reason = document.createElement('div');
    reason.className = 'wb-tool-denied';
    reason.textContent = event.errorCode ? describeErrorCode(event.errorCode) : '该操作未被授权';
    wrapper.appendChild(reason);
  }

  if (typeof event.durationMs === 'number') {
    const dur = document.createElement('div');
    dur.className = 'wb-tool-duration';
    dur.textContent = `${event.durationMs}ms`;
    wrapper.appendChild(dur);
  }

  return wrapper;
}
