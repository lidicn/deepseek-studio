/**
 * MCP 控制器（v1.0，移植自 deepseek++）
 *
 * 参考 deepseek++ 的 MCP 工具控制器，用 stdio 传输连接 MCP 服务器：
 * - 读取 MCP 服务器配置（命令、参数、环境变量）
 * - 通过 stdio 启动并连接 MCP 服务器
 * - 动态注册 MCP 工具到 studio 工具列表
 * - 转发工具调用到 MCP 服务器并返回结果
 *
 * 配置文件：~/.config/deepseek-studio/mcp-servers.json
 * 格式：{ "servers": { "server-id": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] } } }
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface McpServerConfig {
  /** 启动命令（如 npx、python、uvx），stdio 传输时必填 */
  readonly command: string;
  /** 命令参数 */
  readonly args?: readonly string[];
  /** 环境变量 */
  readonly env?: Record<string, string>;
  /** 工作目录 */
  readonly cwd?: string;
  /** 传输类型：stdio（默认）/ http / sse */
  readonly transport?: 'stdio' | 'http' | 'sse';
  /** HTTP/SSE 传输时的服务器 URL */
  readonly url?: string;
  /** HTTP/SSE 传输时的自定义请求头（如 Authorization） */
  readonly headers?: Record<string, string>;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  /** Pi Agent 风格：多模态内容数组（文本+图片） */
  readonly content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
  /** 结构化详情（工具返回的元数据） */
  readonly details?: Record<string, unknown>;
  /** 是否为错误结果 */
  readonly isError?: boolean;
}

interface McpServerConnection {
  /** stdio 传输时的子进程；HTTP 传输时为 null */
  readonly process: ChildProcess | null;
  readonly id: string;
  /** HTTP 传输时的服务器 URL */
  readonly httpUrl?: string;
  /** HTTP 传输时的自定义请求头 */
  readonly httpHeaders?: Record<string, string>;
  /** 传输类型 */
  readonly transport: 'stdio' | 'http' | 'sse';
  requestId: number;
  pendingRequests: Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>;
  tools: McpTool[];
  initialized: boolean;
  /** R1-05：进程已退出/连接已关闭，后续请求快速失败，不再空等 30s 超时。 */
  closed?: boolean;
}

function defaultConfigPath(): string {
  return process.env.STUDIO_MCP_CONFIG ?? path.join(os.homedir(), '.config', 'deepseek-studio', 'mcp-servers.json');
}

/** 读取 MCP 服务器配置 */
export function loadMcpServers(configPath?: string): Record<string, McpServerConfig> {
  const p = configPath ?? defaultConfigPath();
  try {
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // 标准嵌套式：{ servers: { id: cfg } }
    if (parsed.servers && typeof parsed.servers === 'object') {
      return parsed.servers as Record<string, McpServerConfig>;
    }
    // 兼容历史平铺式：顶层键（除 servers 外）当作服务器配置
    // 只接受含 command 或 url 的对象，避免把 meta/说明性键误当服务器
    const out: Record<string, McpServerConfig> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k !== 'servers' && v && typeof v === 'object') {
        const cfg = v as Record<string, unknown>;
        if (typeof cfg.command === 'string' || typeof cfg.url === 'string') {
          out[k] = v as McpServerConfig;
        }
      }
    }
    return out;
  } catch (err) {
    console.warn(`[mcp-controller] failed to load MCP servers config: ${err}`);
    return {};
  }
}

/** 确保配置文件存在（如果不存在则创建示例配置） */
export function ensureMcpConfig(configPath?: string): string {
  const p = configPath ?? defaultConfigPath();
  try {
    if (!fs.existsSync(p)) {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            servers: {
              'example-filesystem': {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', path.join(os.homedir(), 'projects')],
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );
    }
  } catch {
    // 创建失败忽略
  }
  return p;
}

/**
 * MCP 控制器：管理多个 MCP 服务器连接，动态注册工具，转发工具调用。
 */
export class McpController {
  private connections = new Map<string, McpServerConnection>();
  private servers: Record<string, McpServerConfig> = {};

  constructor(configPath?: string) {
    this.servers = loadMcpServers(configPath);
  }

  /** 重新加载配置 */
  reload(configPath?: string): void {
    this.servers = loadMcpServers(configPath);
  }

  /** 获取所有已配置的 MCP 服务器 ID */
  listServerIds(): string[] {
    return Object.keys(this.servers);
  }

  /**
   * 连接到指定 MCP 服务器并初始化（发送 initialize + tools/list）。
   * 如果已连接且初始化完成，直接返回。
   * 支持 stdio 和 HTTP 传输。
   */
  async connect(serverId: string): Promise<McpServerConnection | null> {
    const existing = this.connections.get(serverId);
    if (existing && existing.initialized) return existing;

    const config = this.servers[serverId];
    if (!config) return null;

    const transport = config.transport ?? 'stdio';

    try {
      if (transport === 'http' || transport === 'sse') {
        return this.connectHttp(serverId, config);
      }
      return this.connectStdio(serverId, config);
    } catch (e) {
      console.error(`[mcp ${serverId}] connect failed:`, e instanceof Error ? e.message : String(e));
      this.connections.delete(serverId);
      return null;
    }
  }

  /** stdio 传输连接 */
  private async connectStdio(serverId: string, config: McpServerConfig): Promise<McpServerConnection> {
    const isWin = process.platform === 'win32';
    // env 白名单：只透传 MCP server 运行必需的系统环境变量，避免泄露宿主 token
    const ALLOWED_ENV_KEYS = new Set([
      'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive',
      'COMPUTERNAME', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
      'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
      'PUBLIC', 'DRIVERDATA', 'OS', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
    ]);
    const filteredEnv: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      if (ALLOWED_ENV_KEYS.has(key.toUpperCase()) && process.env[key] !== undefined) {
        filteredEnv[key] = process.env[key] as string;
      }
    }
    // 用户配置的 env 覆盖（用户明确指定的变量允许透传）
    const finalEnv = { ...filteredEnv, ...(config.env ?? {}) };

    // Windows 上 .cmd/.bat 需要 shell 解析；其他命令直接 spawn（避免命令注入）
    const isCmdBatch = isWin && /\.(cmd|bat)$/i.test(config.command);
    const proc = spawn(config.command, config.args ?? [], {
      env: finalEnv,
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isCmdBatch,
    });

    const conn: McpServerConnection = {
      process: proc,
      id: serverId,
      transport: 'stdio',
      requestId: 0,
      pendingRequests: new Map(),
      tools: [],
      initialized: false,
    };

    // P0-3 修复：spawn 失败（命令不存在 / 权限不足）必须监听 error，否则 uncaughtException 杀宿主
    proc.on('error', (err) => {
      console.error(`[mcp] spawn error for ${serverId}: ${err.message}`);
      // 触发所有 pending 请求的 reject，避免调用方永久等待
      for (const [, req] of conn.pendingRequests) req.reject(err);
      conn.pendingRequests.clear();
    });

    let buffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id != null) {
            const pending = conn.pendingRequests.get(msg.id);
            if (pending) {
              conn.pendingRequests.delete(msg.id);
              if (pending.timer) clearTimeout(pending.timer);
              if (msg.error) pending.reject(new Error(msg.error.message ?? 'MCP error'));
              else pending.resolve(msg.result);
            }
          }
        } catch { /* ignore */ }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      console.warn(`[mcp ${serverId}] stderr: ${chunk.toString().slice(0, 200)}`);
    });

    proc.on('exit', (code) => {
      console.warn(`[mcp ${serverId}] exited with code ${code}`);
      // R1-05：标记关闭，持有旧 conn 引用的后续调用快速失败，不再空等 30s。
      conn.closed = true;
      // reject 所有在途请求，避免干等 30s 超时
      for (const [, p] of conn.pendingRequests) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`MCP server ${serverId} exited with code ${code}`));
      }
      conn.pendingRequests.clear();
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      this.connections.delete(serverId);
    });

    this.connections.set(serverId, conn);
    await this.initializeConnection(conn);
    return conn;
  }

  /** HTTP/SSE 传输连接 */
  private async connectHttp(serverId: string, config: McpServerConfig): Promise<McpServerConnection> {
    if (!config.url) throw new Error('HTTP transport requires url');

    const conn: McpServerConnection = {
      process: null,
      id: serverId,
      transport: config.transport ?? 'http',
      httpUrl: config.url,
      httpHeaders: config.headers,
      requestId: 0,
      pendingRequests: new Map(),
      tools: [],
      initialized: false,
    };

    this.connections.set(serverId, conn);
    await this.initializeConnection(conn);
    return conn;
  }

  /** 初始化连接（initialize + notifications/initialized + tools/list） */
  private async initializeConnection(conn: McpServerConnection): Promise<void> {
    await this.sendRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'deepseek-studio', version: '1.0.0' },
    });
    this.sendNotification(conn, 'notifications/initialized', {});
    const toolsResult = (await this.sendRequest(conn, 'tools/list', {})) as { tools?: McpTool[] };
    conn.tools = toolsResult.tools ?? [];
    conn.initialized = true;
  }

  /** 发送 JSON-RPC 请求并等待响应（stdio 或 HTTP） */
  private async sendRequest(conn: McpServerConnection, method: string, params: unknown): Promise<unknown> {
    const id = ++conn.requestId;
    const msg = { jsonrpc: '2.0', id, method, params };

    if (conn.transport === 'http' || conn.transport === 'sse') {
      return this.sendHttpRequest(conn, msg);
    }

    // stdio 传输
    return new Promise((resolve, reject) => {
      // R1-05：进程缺失/已退出时显式快速失败。原可选链 `conn.process?.stdin?.write`
      // 在 process 为 undefined 时不抛错也不写入，promise 只能干等 30s 定时器。
      if (conn.closed || !conn.process || !conn.process.stdin) {
        reject(new Error(`MCP server ${conn.id} not running`));
        return;
      }
      const timer = setTimeout(() => {
        if (conn.pendingRequests.has(id)) {
          conn.pendingRequests.delete(id);
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, 30000);
      conn.pendingRequests.set(id, { resolve, reject, timer });
      try {
        conn.process.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        conn.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** HTTP 传输：POST JSON-RPC 到服务器 URL */
  private async sendHttpRequest(conn: McpServerConnection, msg: Record<string, unknown>): Promise<unknown> {
    if (!conn.httpUrl) throw new Error('HTTP connection missing url');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(conn.httpHeaders ?? {}),
    };
    const res = await fetch(conn.httpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // SSE 响应：解析第一个 JSON-RPC 响应
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.id != null) return parsed.result ?? parsed;
            } catch { /* ignore */ }
          }
        }
      }
      throw new Error('No JSON-RPC response in SSE stream');
    }
    const data = await res.json() as { result?: unknown; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message ?? 'MCP error');
    return data.result ?? data;
  }

  /** 发送 JSON-RPC 通知（不需要响应） */
  private sendNotification(conn: McpServerConnection, method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    if (conn.transport === 'http' || conn.transport === 'sse') {
      // HTTP 通知：fire-and-forget POST（加超时，避免挂起）
      if (conn.httpUrl) {
        fetch(conn.httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(conn.httpHeaders ?? {}) },
          body: msg,
          signal: AbortSignal.timeout(10000),
        }).catch((err) => {
          console.debug(`[mcp] notification failed for ${conn.id}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return;
    }
    try {
      conn.process?.stdin?.write(msg + '\n');
    } catch {
      // 忽略
    }
  }

  /**
   * 获取所有已连接 MCP 服务器的工具列表（合并去重）。
   * 自动连接尚未连接的服务器。每个服务器有独立超时，失败不阻塞其他服务器。
   */
  async getAllTools(): Promise<Array<McpTool & { serverId: string }>> {
    const allTools: Array<McpTool & { serverId: string }> = [];
    for (const serverId of Object.keys(this.servers)) {
      try {
        const conn = await Promise.race([
          this.connect(serverId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
        ]);
        if (conn) {
          for (const tool of conn.tools) {
            allTools.push({ ...tool, serverId });
          }
        } else {
          console.warn(`[mcp ${serverId}] connect timed out, skipping`);
        }
      } catch (e) {
        console.warn(`[mcp ${serverId}] getAllTools failed:`, e instanceof Error ? e.message : String(e));
      }
    }
    return allTools;
  }

  /**
   * 调用 MCP 工具。
   * @param serverId MCP 服务器 ID
   * @param toolName 工具名
   * @param args 工具参数
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const conn = await this.connect(serverId);
    if (!conn) return { ok: false, error: `MCP server "${serverId}" not available` };

    try {
      const result = (await this.sendRequest(conn, 'tools/call', { name: toolName, arguments: args })) as {
        content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        isError?: boolean;
      };
      if (result.isError) {
        const text = result.content?.find((c) => c.type === 'text')?.text ?? 'Unknown MCP tool error';
        return { ok: false, error: text, isError: true };
      }

      // 提取文本内容
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // 非 JSON 文本，原样返回
      }

      // 构建 Pi Agent 风格的 content 数组（文本 + 图片）
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [];
      if (text) {
        content.push({ type: 'text', text });
      }

      // 处理 MCP 标准 image 类型 content（单张图片上限 5MB，超限截断为文本占位）
      const MAX_IMAGE_BASE64_LEN = Math.floor((5 * 1024 * 1024 * 4) / 3); // base64 约为原始 4/3
      for (const c of result.content ?? []) {
        if (c.type === 'image' && c.data) {
          if (c.data.length > MAX_IMAGE_BASE64_LEN) {
            content.push({ type: 'text', text: `[图片过大已省略：${(c.data.length * 3 / 4 / 1024 / 1024).toFixed(1)}MB，超过 5MB 上限]` });
          } else {
            const mime = c.mimeType ?? 'image/png';
            content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${c.data}` } });
          }
        }
      }

      // 处理 TVPilot 风格的 inline_bytes（在 JSON data 里，同样 5MB 上限）
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>;
        if (typeof obj.inline_bytes === 'string') {
          if (obj.inline_bytes.length > MAX_IMAGE_BASE64_LEN) {
            content.push({ type: 'text', text: `[图片过大已省略：${(obj.inline_bytes.length * 3 / 4 / 1024 / 1024).toFixed(1)}MB，超过 5MB 上限]` });
          } else {
            const mime = typeof obj.format === 'string' ? `image/${obj.format}` : 'image/png';
            content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${obj.inline_bytes}` } });
          }
        }
      }

      return {
        ok: true,
        data,
        content: content.length > 0 ? content : undefined,
        details: data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 断开所有 MCP 服务器连接 */
  disconnectAll(): void {
    for (const conn of this.connections.values()) {
      try {
        conn.process?.kill();
      } catch {
        // 忽略
      }
    }
    this.connections.clear();
  }

  /**
   * 测试 MCP 服务器连接（不保存到配置，临时连接测试）。
   * 支持 stdio 和 HTTP/SSE 传输。
   */
  async testConnection(config: McpServerConfig): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
    const transport = config.transport ?? 'stdio';
    if (transport === 'http' || transport === 'sse') {
      return this.testHttpConnection(config);
    }
    if (!config.command) {
      return { ok: false, error: 'command is required for stdio transport' };
    }
    try {
      const isWin = process.platform === 'win32';
      const isCmdBatch = isWin && /\.(cmd|bat)$/i.test(config.command);
      // 复用 connectStdio 的 env 白名单逻辑
      const ALLOWED_ENV_KEYS = new Set([
        'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'SystemDrive',
        'COMPUTERNAME', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL',
        'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
        'PUBLIC', 'DRIVERDATA', 'OS', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
      ]);
      const filteredEnv: Record<string, string> = {};
      for (const key of Object.keys(process.env)) {
        if (ALLOWED_ENV_KEYS.has(key.toUpperCase()) && process.env[key] !== undefined) {
          filteredEnv[key] = process.env[key] as string;
        }
      }
      const proc = spawn(config.command, config.args ?? [], {
        env: { ...filteredEnv, ...(config.env ?? {}) },
        cwd: config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isCmdBatch,
      });

      const conn: McpServerConnection = {
        process: proc,
        id: '__test__',
        transport: 'stdio',
        requestId: 0,
        pendingRequests: new Map(),
        tools: [],
        initialized: false,
      };

      // P0-3 修复：testConnection 的 spawn 也要 error 监听，否则命令不存在直接杀宿主
      proc.on('error', (err) => {
        console.error(`[mcp] testConnection spawn error: ${err.message}`);
        for (const [, req] of conn.pendingRequests) req.reject(err);
        conn.pendingRequests.clear();
      });

      let buffer = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id && conn.pendingRequests.has(msg.id)) {
              conn.pendingRequests.get(msg.id)?.resolve(msg);
              conn.pendingRequests.delete(msg.id);
            }
          } catch { /* ignore */ }
        }
      });

      // 等待进程启动
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (proc.killed || proc.exitCode !== null) {
        return { ok: false, error: `process exited with code ${proc.exitCode}` };
      }

      // 发送 initialize
      const initResult = await new Promise<any>((resolve, reject) => {
        const id = ++conn.requestId;
        conn.pendingRequests.set(id, { resolve, reject });
        proc.stdin?.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'studio-test', version: '1.0' } },
        }) + '\n');
        setTimeout(() => reject(new Error('initialize timeout')), 5000);
      });

      if (!initResult.result) {
        proc.kill();
        return { ok: false, error: 'initialize failed' };
      }

      // 发送 initialized 通知
      proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      // 发送 tools/list
      const toolsResult = await new Promise<any>((resolve, reject) => {
        const id = ++conn.requestId;
        conn.pendingRequests.set(id, { resolve, reject });
        proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n');
        setTimeout(() => reject(new Error('tools/list timeout')), 5000);
      });

      proc.kill();
      const toolNames = (toolsResult.result?.tools ?? []).map((t: any) => t.name);
      return { ok: true, tools: toolNames };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** HTTP/SSE 传输连接测试 */
  private async testHttpConnection(config: McpServerConfig): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
    if (!config.url) return { ok: false, error: 'url is required for HTTP transport' };
    const customHeaders = config.headers ?? {};
    try {
      // initialize
      const initRes = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...customHeaders },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'studio-test', version: '1.0' } },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!initRes.ok) return { ok: false, error: `HTTP ${initRes.status}: ${initRes.statusText}` };
      const initData = await initRes.json();
      if (initData.error) return { ok: false, error: initData.error.message ?? 'initialize failed' };

      // notifications/initialized（fire-and-forget，加超时）
      fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...customHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});

      // tools/list
      const toolsRes = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...customHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        signal: AbortSignal.timeout(15000),
      });
      const toolsData = await toolsRes.json();
      const toolNames = (toolsData.result?.tools ?? []).map((t: any) => t.name);
      return { ok: true, tools: toolNames };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 保存 MCP 服务器配置到磁盘 */
  saveServer(serverId: string, config: McpServerConfig): { ok: boolean; error?: string } {
    try {
      const configPath = process.env.STUDIO_CONFIG_DIR
        ? path.join(process.env.STUDIO_CONFIG_DIR, 'mcp-servers.json')
        : path.join(os.homedir(), '.config', 'deepseek-studio', 'mcp-servers.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      // 统一为嵌套式 { servers: { id: cfg } }
      let file: { servers: Record<string, McpServerConfig> } = { servers: {} };
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          // 优先取 .servers；兼容历史平铺式（顶层键当作服务器）
          if (parsed.servers && typeof parsed.servers === 'object') {
            file.servers = parsed.servers as Record<string, McpServerConfig>;
          } else {
            for (const [k, v] of Object.entries(parsed)) {
              if (k !== 'servers' && v && typeof v === 'object') {
                file.servers[k] = v as McpServerConfig;
              }
            }
          }
        }
      } catch { /* 新文件 */ }
      file.servers[serverId] = config;
      fs.writeFileSync(configPath, JSON.stringify(file, null, 2), 'utf8');
      this.servers = file.servers;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** 全局单例 */
let globalController: McpController | null = null;

export function getMcpController(): McpController {
  if (!globalController) {
    globalController = new McpController();
  }
  return globalController;
}
