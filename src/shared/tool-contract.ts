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
 * v2.0：模型可调工具白名单（G-01 修复的权限面）。
 *
 * 背景：旧实现把「模型 XML 标签可调」与「UI 直调」混在同一张 UPSTREAM_TO_STUDIO 表里，
 * 30 个键全部喂给流式解析器（SUPPORTED_INVOCATION_NAMES = Object.keys(全表)）。
 * 这意味着 settings.get / workspace.set / policy.set / folder.pick / memory.delete
 * 等宿主 RPC 名义上对模型开放——只是被解析器的字符类意外挡住（点号匹配不上）。
 * 一旦放宽字符类让点号 id 可达，这些写权限就会真的暴露给模型。
 *
 * 因此这里显式声明「模型可以调什么」。判定入口 isSupportedUpstreamTool() 只查本表，
 * 页端解析与宿主映射共用同一真相源；UI 侧走 callHostTool（src/ui/studio-ui-core.ts:92）
 * 直投 WS，不经解析器，故不受本表限制。
 *
 * 收录原则：把宿主已登记的能力投影给模型；不含任何改变宿主配置/安全档位的 RPC。
 */
const MODEL_INVOCATION_TOOLS: Record<string, UpstreamToolMapping> = Object.assign(
  Object.create(null) as Record<string, UpstreamToolMapping>,
  {
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
  // G-02：宿主早已登记 file.edit（src/host/desktop-host.ts:419）却因缺映射而对模型
  // 不可达，模型只能靠 local_file_write 整文件覆写。这里补下划线别名，与既有 8 个
  // 工具风格一致（模型无需记点号形式）。
  file_edit: {
    id: 'file.edit',
    adapt: (p) => ({
      path: typeof p.path === 'string' ? p.path : '',
      edits: Array.isArray(p.edits) ? p.edits : [],
      ...(typeof p.expectedSha256 === 'string' ? { expectedSha256: p.expectedSha256 } : {}),
      ...(p.dryRun === true ? { dryRun: true } : {}),
    }),
  },
  // G-02：search_files（listFiles + grepFiles 合成，src/host/desktop-host.ts:421）。
  search_files: {
    id: 'search_files',
    adapt: (p) => ({
      operation: typeof p.operation === 'string' ? p.operation : 'list',
      ...(typeof p.root === 'string' ? { root: p.root } : {}),
      ...(typeof p.query === 'string' ? { query: p.query } : {}),
      ...(p.regex === true ? { regex: true } : {}),
      ...(p.caseInsensitive === true ? { caseInsensitive: true } : {}),
      ...(typeof p.glob === 'string' ? { glob: p.glob } : {}),
      ...(typeof p.pattern === 'string' ? { pattern: p.pattern } : {}),
      ...(typeof p.recursive === 'boolean' ? { recursive: p.recursive } : {}),
      ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
    }),
  },
  memory_save: {
    id: 'memory.save',
    adapt: (p) => ({
      type: typeof p.type === 'string' ? p.type : 'user',
      name: typeof p.name === 'string' ? p.name : '',
      content: typeof p.content === 'string' ? p.content : '',
      tags: Array.isArray(p.tags) ? p.tags : [],
    }),
  },
  python_exec: {
    id: 'python.exec',
    adapt: (p) => ({
      code: typeof p.code === 'string' ? p.code : '',
    }),
  },
  mcp_list: {
    id: 'mcp.list',
    adapt: () => ({}),
  },
  mcp_call: {
    id: 'mcp.call',
    adapt: (p) => ({
      serverId: typeof p.serverId === 'string' ? p.serverId : '',
      tool: typeof p.tool === 'string' ? p.tool : typeof p.name === 'string' ? p.name : '',
      args: p.args && typeof p.args === 'object' ? p.args : p.arguments && typeof p.arguments === 'object' ? p.arguments : {},
    }),
  },
  } as Record<string, UpstreamToolMapping>,
);

/**
 * v2.0：仅 UI 直调表（不经模型，不喂解析器）。
 * 这些是宿主 RPC / 设置面，保留在 UPSTREAM_TO_STUDIO 供 mapUpstreamToolInvocation
 * 使用（UI 经 callHostTool 投递时也要能映射），但不出现在 SUPPORTED_INVOCATION_NAMES。
 */
const UI_ONLY_TOOLS: Record<string, UpstreamToolMapping> = Object.assign(
  Object.create(null) as Record<string, UpstreamToolMapping>,
  {
    mcp_test: {
    id: 'mcp.test',
    adapt: (p) => ({ config: p.config && typeof p.config === 'object' ? p.config : {} }),
  },
  'mcp.test': {
    id: 'mcp.test',
    adapt: (p) => ({ config: p.config && typeof p.config === 'object' ? p.config : {} }),
  },
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
  'mcp.remove': { id: 'mcp.remove', adapt: (p) => p },
  'mcp.get': { id: 'mcp.get', adapt: (p) => p },
  'memory.delete': { id: 'memory.delete', adapt: (p) => p },
  // M10-5：归档两态（恢复 / 彻底删除 / 已归档列表），同样只对 UI 开放。
  'memory.unarchive': { id: 'memory.unarchive', adapt: (p) => ({ id: String(p.id ?? '') }) },
  'memory.purge': { id: 'memory.purge', adapt: (p) => ({ id: String(p.id ?? '') }) },
  'memory.listArchived': { id: 'memory.listArchived', adapt: () => ({}) },
  'workspace.set': { id: 'workspace.set', adapt: (p) => p },
  'policy.set': { id: 'policy.set', adapt: (p) => p },
  'settings.get': { id: 'settings.get', adapt: (p) => p },
  'project.list': { id: 'project.list', adapt: (p) => p },
  'project.create': { id: 'project.create', adapt: (p) => p },
  'folder.pick': { id: 'folder.pick', adapt: (p) => p },
  'skill.list': { id: 'skill.list', adapt: (p) => p },
  } as Record<string, UpstreamToolMapping>,
);

/**
 * 全量映射表 = 模型可调 + 仅 UI。mapUpstreamToolInvocation 用它做映射，因此 UI 经
 * callHostTool 投递的 settings.get / workspace.set 等仍能正常执行；而解析链路
 * （SUPPORTED_INVOCATION_NAMES）只喂模型表，两者权限面在此分开。
 */
const UPSTREAM_TO_STUDIO: Record<string, UpstreamToolMapping> = Object.assign(
  Object.create(null) as Record<string, UpstreamToolMapping>,
  MODEL_INVOCATION_TOOLS,
  UI_ONLY_TOOLS,
);


/**
 * v2.0：受支持的下游 invocationName 列表（喂给上游流式解析器的 toolDescriptors）。
 * 只含模型可调表，**不含** UI_ONLY_TOOLS —— 否则模型输出 <settings.get> 会被解析器
 * 接收并真的触发宿主 RPC（G-01 修复的权限面收窄）。
 */
export const SUPPORTED_INVOCATION_NAMES: readonly string[] = Object.keys(MODEL_INVOCATION_TOOLS);

/** v2.0：仅 UI 直调的 invocationName 列表（供测试与文档断言隔离边界）。 */
export const UI_ONLY_INVOCATION_NAMES: readonly string[] = Object.keys(UI_ONLY_TOOLS);

/**
 * v2.1：模型表的「对外声明名」清单，供 interceptor 的 TOOL_CAPABILITY_PROMPT /
 * TOOL_CATALOG_TEXT 与测试做跨源一致性断言。
 *
 * 为什么需要它：GAP-1 的根因是模型表与提示词工具目录两份手工维护的文本脱节
 * （表里有 19 个键、目录只声明 8 个）。本常量让「表里有什么」变成可编程查询，
 * 测试据此断言目录条目与表键集合相等，避免再次脱节。
 * 注意：不反过来用本清单生成目录文本——那会改变 prompt 的实际措辞与顺序，
 * 属于模型行为面变更，需单独评估。
 */
export const MODEL_INVOCATION_DECLARED_NAMES: readonly string[] = Object.keys(MODEL_INVOCATION_TOOLS);

export function isSupportedUpstreamTool(invocationName: string): boolean {
  // v2.0：只认模型可调表。UI 直调（settings.get / workspace.set 等）不经此闸门，
  // 它们由 UI 经 callHostTool 直接投递 WS，与页端解析链路完全隔离。
  return Object.prototype.hasOwnProperty.call(MODEL_INVOCATION_TOOLS, invocationName);
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
