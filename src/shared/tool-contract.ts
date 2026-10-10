/**
 * 工具契约映射层（v0.6，纯模块，无上游运行时依赖）
 *
 * 上游 DeepSeek 以 XML 调用标签返回工具调用（如 `<shell_exec>` / `<local_file_read>`），
 * 其 invocationName 与 Studio 已登记的点分层级工具 id 不同，且参数形态也有差异。
 * 本模块是页端（拦截后投递）与宿主（执行前映射）共用的唯一契约真相源：
 *   - 页端：判断该 invocation 是否受支持，决定是否拦截转发；
 *   - 宿主：把上游 invocationName + 原始参数映射为 Studio 工具 id + 适配参数后执行。
 *
 * 保持纯函数、零副作用，便于两端（浏览器 IIFE / Node 宿主）共享同一份逻辑。
 */

export interface MappedToolCall {
  /** Studio 已登记工具 id（如 shell.exec / file.read）。 */
  readonly id: string;
  /** 适配后的参数（对齐 Studio 能力期望形态）。 */
  readonly params: Record<string, unknown>;
}

interface UpstreamToolMapping {
  readonly id: string;
  readonly adapt: (params: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * 上游 invocationName → Studio 工具 映射表。
 * 新增上游工具时只改这里；页端与宿主通过同一张表保持一致。
 */
const UPSTREAM_TO_STUDIO: Record<string, UpstreamToolMapping> = {
  shell_exec: {
    id: 'shell.exec',
    adapt: (p) => ({
      command: typeof p.command === 'string' ? p.command : typeof p.cmd === 'string' ? p.cmd : '',
      ...(typeof p.timeout_ms === 'number' ? { timeoutMs: p.timeout_ms } : {}),
      ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
    }),
  },
  local_file_read: {
    id: 'file.read',
    adapt: (p) => ({ path: typeof p.path === 'string' ? p.path : '' }),
  },
  local_file_write: {
    id: 'file.write',
    adapt: (p) => ({
      path: typeof p.path === 'string' ? p.path : '',
      content: typeof p.content === 'string' ? p.content : '',
    }),
  },
  local_file_stat: {
    id: 'file.stat',
    adapt: (p) => ({ path: typeof p.path === 'string' ? p.path : '' }),
  },
};

/** 受支持的下游 invocationName 列表（用于喂给上游流式解析器的 toolDescriptors）。 */
export const SUPPORTED_INVOCATION_NAMES: readonly string[] = Object.keys(UPSTREAM_TO_STUDIO);

export function isSupportedUpstreamTool(invocationName: string): boolean {
  return Object.prototype.hasOwnProperty.call(UPSTREAM_TO_STUDIO, invocationName);
}

/**
 * 把上游 invocationName + 原始参数映射为 Studio 工具调用。
 * 不受支持的 invocation 返回 null（调用方据此放行原始 XML 文本，不拦截）。
 */
export function mapUpstreamToolInvocation(
  invocationName: string,
  params: unknown,
): MappedToolCall | null {
  const mapping = UPSTREAM_TO_STUDIO[invocationName];
  if (!mapping) return null;
  const raw = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  return { id: mapping.id, params: mapping.adapt(raw) };
}
