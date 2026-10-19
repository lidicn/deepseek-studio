/**
 * ArtifactCard：只展示 ToolRunEvent.artifactPaths 中的真实路径。
 * 空数组返回 null（不渲染）；不根据工具名猜测产物。
 */
import type { ToolRunEvent } from '../../../shared/tool-run-event';

export function renderArtifactCard(event: ToolRunEvent | null | undefined): HTMLElement | null {
  const paths = event?.artifactPaths;
  if (!paths || paths.length === 0) return null;

  const el = document.createElement('div');
  el.className = 'wb-artifact-card';
  const title = document.createElement('div');
  title.className = 'wb-artifact-title';
  title.textContent = '产物';
  el.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'wb-artifact-list';
  for (const p of paths) {
    if (!p) continue;
    const li = document.createElement('li');
    li.className = 'wb-artifact-item';
    li.textContent = p;
    list.appendChild(li);
  }
  el.appendChild(list);
  return el;
}
