/**
 * DiffReview：只读变更摘要。只展示 details 白名单字段（path/replacements/
 * bytesBefore/bytesAfter/sha256Before/sha256After）；后端未给行级 before/after 文本时，
 * 显示「当前后端未提供行级 diff」，不渲染逐块接受/拒绝，不伪造全部接受/全部拒绝。
 */
import type { ToolRunEvent } from '../../../shared/tool-run-event';

export function renderDiffReview(event: ToolRunEvent | null | undefined): HTMLElement | null {
  const details = event?.details;
  if (!details) return null;

  const hasWhitelist =
    details.path ||
    typeof details.replacements === 'number' ||
    typeof details.bytesBefore === 'number' ||
    typeof details.bytesAfter === 'number' ||
    details.sha256Before ||
    details.sha256After;
  if (!hasWhitelist) return null;

  const el = document.createElement('div');
  el.className = 'wb-diff-review';

  if (details.path) {
    const path = document.createElement('div');
    path.className = 'wb-diff-path';
    path.textContent = `文件：${details.path}`;
    el.appendChild(path);
  }

  const meta = document.createElement('div');
  meta.className = 'wb-diff-meta';
  const parts: string[] = [];
  if (typeof details.replacements === 'number') parts.push(`替换 ${details.replacements} 处`);
  if (typeof details.bytesBefore === 'number' && typeof details.bytesAfter === 'number') {
    parts.push(`体积 ${details.bytesBefore}B → ${details.bytesAfter}B`);
  }
  meta.textContent = parts.join(' · ');
  if (parts.length) el.appendChild(meta);

  const note = document.createElement('div');
  note.className = 'wb-diff-note';
  note.textContent = '当前后端未提供行级 diff，仅展示只读摘要。';
  el.appendChild(note);

  return el;
}
