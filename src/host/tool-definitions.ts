/**
 * 默认工具定义表（v0.3.1 → v0.3.3）
 *
 * echo：v0.2 骨架能力，证明「授权 → 执行」链路（在 Node 宿主内 rehydrate）。
 * chat-read / chat-insert / chat-send：v0.3.3 真实能力，在注入页的真实 DOM 中执行，
 * 各自带 DeepSeek 聊天页 origin 白名单与风险等级（read < insert < send）。
 *
 * allowlist 默认只放 https://chat.deepseek.com：任何其它源发起 grant 都会被
 * desktop-host 的 allowlist 闸门 fail-closed 拒绝（验证见 tests/desktop/tool-registry.test.ts）。
 * 风险等级驱动同意闸门（v0.3.2）：insert / send 需用户在页端模态点选同意。
 */

import type { ToolDefinition } from './tool-registry';

export const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';

/**
 * R2-05：宿主内部调用（AgentLoop / Bot 经 invokeTool）使用的专用 origin。
 * 不复用 DEEPSEEK_ORIGIN：后者是页面白名单来源，硬编码它会让 origin 闸门对内部调用恒真、
 * 形同虚设。内部 origin 在 executeTool 的治理闸门里显式放行，页面来源仍走白名单校验。
 */
export const HOST_INTERNAL_ORIGIN = 'studio://host-internal';

export const DEFAULT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    id: 'echo',
    title: 'Echo',
    description: '最小回显能力，用于证明「授权 → 执行」链路（v0.2 骨架）。',
    risk: 'read',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'chat-read',
    title: '读取对话',
    description: '读取当前 DeepSeek 对话的消息列表（只读，低风险，自动放行）。',
    risk: 'read',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'chat-insert',
    title: '插入文本',
    description: '向当前对话输入框写入文本（中风险，需用户同意）。',
    risk: 'insert',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'chat-send',
    title: '发送消息',
    description: '提交当前输入框内容、向 DeepSeek 发送一条消息（高风险，需用户同意）。',
    risk: 'send',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // —— v0.5 宿主侧能力：最高风险等级 + 宿主执行侧 ——
  {
    id: 'shell.exec',
    title: '执行命令',
    description: '在常驻宿主进程内以 argv 方式执行一条本机命令（特权级，受三档审批策略约束，永不启用 shell 解释器）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'file.read',
    title: '读取文件',
    description: '读取工作区内的文件内容（特权级；工作区外需审批，未配置工作区时不可用）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'file.write',
    title: '写入文件',
    description: '写入或追加文件内容到工作区内（特权级；工作区外需审批）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'file.edit',
    title: '局部修改文件',
    description: '在工作区内对文件做局部字符串替换（唯一匹配，失败零写入）。小改用 file.edit，新建或整体重写用 file.write；改之前先 file.read 确认原文。特权级。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'file.list',
    title: '列出目录',
    description: '列出工作区内目录内容（特权级；工作区外需审批）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  {
    id: 'file.stat',
    title: '文件元信息',
    description: '查询工作区内文件/目录的大小、类型与时间戳（特权级；目标必须已存在）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v0.9：本地技能目录。
  {
    id: 'skill.list',
    title: '列出技能',
    description: '列出当前可用的本地技能及其描述（只读，自动放行）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // ORD-001：本地文件检索（listFiles + grepFiles）。
  {
    id: 'search_files',
    title: '搜索本地文件',
    description: '在工作区内按文件名通配列出文件（operation=list），或按内容子串/正则检索（operation=grep）。只读，不写不改。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // ORD-002：网页抓取。
  {
    id: 'web_fetch',
    title: '抓取网页',
    description: '抓取指定 URL 的正文内容，自动去 script/style/HTML 标签。生产未接真实通道，fail-closed。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // ORD-003：网页搜索。
  {
    id: 'web_search',
    title: '网页搜索',
    description: '按查询词搜索网页，返回标题+摘要+链接。生产未接真实通道，fail-closed。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.0：长期记忆（移植自 deepseek++）。
  {
    id: 'memory.save',
    title: '保存记忆',
    description: '保存一条长期记忆（用户身份/偏好/技术栈/项目决策等），跨会话持久化存储。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.0：Python 代码执行（移植自 deepseek++）。
  {
    id: 'python.exec',
    title: '执行 Python',
    description: '在宿主环境执行 Python 代码（特权级，受工作区策略约束）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.0：MCP 工具列表（只读，自动放行）。
  {
    id: 'mcp.list',
    title: '列出 MCP 工具',
    description: '列出已配置的 MCP 服务器及其提供的工具（只读，自动放行）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.0：MCP 工具调用（特权级）。
  {
    id: 'mcp.call',
    title: '调用 MCP 工具',
    description: '调用指定 MCP 服务器上的工具（特权级，受审批策略约束）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：MCP 连接测试（R4-P0-1：会 spawn 任意命令，改为 privileged 级别）。
  {
    id: 'mcp.test',
    title: '测试 MCP 连接',
    description: '测试 MCP 服务器配置是否能正常连接（会启动子进程，需要授权）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：MCP 配置保存（R4-P0-1：写配置文件，改为 privileged 级别）。
  {
    id: 'mcp.save',
    title: '保存 MCP 配置',
    description: '保存 MCP 服务器配置到磁盘（会写入配置文件，需要授权）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.9：读取单台 MCP 服务器配置（只读，自动放行）。
  {
    id: 'mcp.get',
    title: '读取 MCP 配置',
    description: '读取指定 MCP 服务器的完整配置（只读，自动放行）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：删除 MCP 配置（R4-P0-1：删除配置文件，改为 privileged 级别）。
  {
    id: 'mcp.remove',
    title: '删除 MCP 配置',
    description: '从配置中删除指定 MCP 服务器（会删除配置条目，需要授权）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：归档记忆（M10-1 提级需同意；M10-5 改为软删，可从「已归档」恢复）。
  {
    id: 'memory.delete',
    title: '归档记忆',
    description: '把一条长期记忆归档（不再注入提示词，可从「已归档」恢复；需用户同意）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // M10-5：恢复已归档记忆（写回注入面，需用户同意）。
  {
    id: 'memory.unarchive',
    title: '恢复记忆',
    description: '把一条已归档的长期记忆恢复为生效状态（会重新进入提示词，需用户同意）。',
    risk: 'insert',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // M10-5：彻底删除已归档记忆（不可恢复，必须人工同意）。
  {
    id: 'memory.purge',
    title: '彻底删除记忆',
    description: '从记忆库彻底删除一条记录（不可恢复，需用户同意）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // M10-5：已归档列表（面板两态视图，只读）。
  {
    id: 'memory.listArchived',
    title: '列出已归档记忆',
    description: '列出已归档的长期记忆（只读，自动放行）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：设置工作区（改写后续文件工具的可信边界——高危，必须用户同意）。
  // QD-R2-04 修复：原 risk:'read' 会被自动放行，模型自调即可把文件根指向任意目录。
  {
    id: 'workspace.set',
    title: '设置工作区',
    description: '设置当前工作区根目录（改写后续文件工具的可信边界，需用户同意）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：设置策略模式（直接改写同意闸门松紧——最高危，必须用户同意）。
  // QD-R2-04 修复：原 risk:'read' 会被自动放行，模型自调一次 policy.set=full 即可拆掉所有闸。
  {
    id: 'policy.set',
    title: '设置策略模式',
    description: '设置工具执行策略模式（workspace/ask/auto/full）（改写同意闸门松紧，需用户同意）。',
    risk: 'privileged',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.9：读取当前生效设置（只读，自动放行）。
  {
    id: 'settings.get',
    title: '读取设置',
    description: '读取当前生效的工作区、策略档位、MCP 服务器与技能目录（只读，自动放行）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：项目列表（只读，自动放行）。
  {
    id: 'project.list',
    title: '列出项目',
    description: '列出已配置的项目（只读，自动放行）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：创建项目（配置管理，自动放行）。
  {
    id: 'project.create',
    title: '创建项目',
    description: '创建新项目并写入配置（配置管理，自动放行）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
  // v1.1：选择文件夹（配置管理，自动放行；需 Tauri dialog 或环境变量回退）。
  {
    id: 'folder.pick',
    title: '选择文件夹',
    description: '弹出文件夹选择对话框（需 Tauri dialog；Node 宿主回退到 STUDIO_PICK_FOLDER 环境变量）。',
    risk: 'read',
    execution: 'host',
    allowedOrigins: [DEEPSEEK_ORIGIN],
  },
];
