/**
 * Workbench 空态组件（薄包 primitives/emptyState，不重造第二份）。
 * 无数据源的区域一律走这里，不虚构内容。
 */
import { emptyState as primitiveEmptyState } from '../../primitives/empty-state';

export function workbenchEmptyState(message: string, hint?: string): HTMLDivElement {
  return primitiveEmptyState(message, hint);
}
