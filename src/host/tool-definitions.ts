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
];
