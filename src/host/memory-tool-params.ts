import type { SaveMemoryParams } from './memory-store';

/**
 * D-5：工具边界到 memory-store 的唯一归一入口。
 *
 * 语义契约是**有则转、无则不传**：缺省字段绝不能在这里固化成 `[]` 或 `false`。
 * 否则 `memory-store.mergeUpdateGovernance()` 里的 `params.tags ?? existing.tags`
 * 会把「未传」误判成「显式清空」，同名保存就会抹掉已有的 tags / pinned。
 *
 * 真实回归见 2026-10-26 真机验收：经工具链同名保存后 `tags_json` 变 `[]`、`pinned` 变 0。
 */
export function normalizeMemorySaveParams(params: Record<string, unknown>): SaveMemoryParams {
  const next: {
    type: string;
    name: string;
    content: string;
    source: string;
    tags?: string[];
    pinned?: boolean;
  } = {
    type: String(params.type ?? 'user'),
    name: String(params.name ?? ''),
    content: String(params.content ?? ''),
    // M10-6：治理字段由宿主决定，调用方送来的 source 一律不采信。
    source: 'agent',
  };

  if (Array.isArray(params.tags)) next.tags = params.tags.map(String);
  if (typeof params.pinned === 'boolean') next.pinned = params.pinned;

  return next;
}
