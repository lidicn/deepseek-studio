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
 *
 * v1.8：用 Object.create(null) 切断原型链。之前是普通对象字面量，原型为
 * Object.prototype，直接索引 UPSTREAM_TO_STUDIO[invocationName] 会对
 * 'constructor' / '__proto__' / 'toString' 等原型属性名命中 truthy 的继承
 * 成员，绕过 mapUpstreamToolInvocation 的 null 兜底，随后 mapping.adapt
 * 为 undefined 抛 TypeError。create(null) 从根上消除穿透，对 Object.keys
 * 与直接索引都安全，与同文件 isSupportedUpstreamTool 的 hasOwnProperty 语义一致。
 */
const UPSTREAM_TO_STUDIO: Record<string, UpstreamToolMapping> = Object.assign(
  Object.create(null) as Record<string, UpstreamToolMapping>,
  ({
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
    adapt: (p) => ({
      path: typeof p.path === 'string' ? p.path : '',
      ...(typeof p.start === 'number' ? { offset: p.start } : typeof p.offset === 'number' ? { offset: p.offset } : {}),
      ...(typeof p.max_chars === 'number' ? { limit: p.max_chars } : typeof p.limit === 'number' ? { limit: p.limit } : {}),
    }),
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
  // v1.0：长期记忆保存（移植自 deepseek++ memory_save）。
  memory_save: {
    id: 'memory.save',
    adapt: (p) => ({
      type: typeof p.type === 'string' ? p.type : 'user',
      name: typeof p.name === 'string' ? p.name : '',
      content: typeof p.content === 'string' ? p.content : '',
      tags: Array.isArray(p.tags) ? p.tags : [],
    }),
  },
  // v1.0：Python 代码执行（移植自 deepseek++ python_exec）。
  python_exec: {
    id: 'python.exec',
    adapt: (p) => ({
      code: typeof p.code === 'string' ? p.code : '',
    }),
  },
  // v1.0：列出 MCP 工具。
  mcp_list: {
    id: 'mcp.list',
    adapt: () => ({}),
  },
  // v1.0：调用 MCP 工具。
  mcp_call: {
    id: 'mcp.call',
    adapt: (p) => ({
      serverId: typeof p.serverId === 'string' ? p.serverId : '',
      tool: typeof p.tool === 'string' ? p.tool : typeof p.name === 'string' ? p.name : '',
      args: p.args && typeof p.args === 'object' ? p.args : p.arguments && typeof p.arguments === 'object' ? p.arguments : {},
    }),
  },
  // v1.1：测试 MCP 连接（UI 直接调用时用点号，模型 XML 标签用下划线）。
  mcp_test: {
    id: 'mcp.test',
    adapt: (p) => ({ config: p.config && typeof p.config === 'object' ? p.config : {} }),
  },
  'mcp.test': {
    id: 'mcp.test',
    adapt: (p) => ({ config: p.config && typeof p.config === 'object' ? p.config : {} }),
  },
  // v1.1：保存 MCP 配置。
  mcp_save: {
    id: 'mcp.save',
    adapt: (p) => ({
      serverId: typeof p.serverId === 'string' ? p.serverId : typeof p.id === 'string' ? p.id : '',
      config: p.config && typeof p.config === 'object' ? p.config : {},
    }),
  },
  'mcp.save': {
    id: 'mcp.save',
    adapt: (p) => ({
      serverId: typeof p.serverId === 'string' ? p.serverId : typeof p.id === 'string' ? p.id : '',
      config: p.config && typeof p.config === 'object' ? p.config : {},
    }),
  },
  // v1.1：UI 点号直调（无需适配，透传参数）。
  'mcp.remove': { id: 'mcp.remove', adapt: (p) => p },
  'mcp.get': { id: 'mcp.get', adapt: (p) => p },
  'memory.delete': { id: 'memory.delete', adapt: (p) => p },
  'workspace.set': { id: 'workspace.set', adapt: (p) => p },
  'policy.set': { id: 'policy.set', adapt: (p) => p },
  'settings.get': { id: 'settings.get', adapt: (p) => p },
  'project.list': { id: 'project.list', adapt: (p) => p },
  'project.create': { id: 'project.create', adapt: (p) => p },
  'folder.pick': { id: 'folder.pick', adapt: (p) => p },
  'skill.list': { id: 'skill.list', adapt: (p) => p },
  'memory.save': { id: 'memory.save', adapt: (p) => p },
  'python.exec': { id: 'python.exec', adapt: (p) => p },
  'mcp.list': { id: 'mcp.list', adapt: (p) => p },
  'mcp.call': { id: 'mcp.call', adapt: (p) => p },
  'shell.exec': { id: 'shell.exec', adapt: (p) => p },
  'file.read': { id: 'file.read', adapt: (p) => p },
  'file.write': { id: 'file.write', adapt: (p) => p },
    'file.stat': { id: 'file.stat', adapt: (p) => p },
  }) as Record<string, UpstreamToolMapping>,
);

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
