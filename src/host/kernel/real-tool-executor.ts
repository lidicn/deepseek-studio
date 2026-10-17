/**
 * RealToolExecutor（S17）：接宿主真实工具。
 *
 * tool-registry 尚未存在；本模块用注入函数桥接，与 history-store 同模式。
 * 生产接 tauri shell / fs；测试塞内存实现。
 */

import type { ToolExecutor, ToolExecutorResult } from './tool-bridge';

export interface RealToolHandlers {
  /** 跑 shell 命令；stdout 作为 result。 */
  shellExec?: (cmd: string) => Promise<{ stdout: string; stderr?: string; code: number }>;
  /** 读文件。 */
  fileRead?: (path: string) => Promise<string>;
  /** 写文件。 */
  fileWrite?: (path: string, content: string) => Promise<void>;
}

export function createRealToolExecutor(handlers: RealToolHandlers): ToolExecutor {
  async function execute(name: string, args?: unknown): Promise<ToolExecutorResult> {
    const a = (args ?? {}) as { cmd?: string; path?: string; content?: string };
    try {
      switch (name) {
        case 'shell_exec': {
          if (!handlers.shellExec) return { ok: false, error: 'shell_exec handler not wired' };
          const r = await handlers.shellExec(a.cmd ?? '');
          if (r.code !== 0) return { ok: false, error: r.stderr ?? `exit ${r.code}` };
          return { ok: true, result: r.stdout };
        }
        case 'file_read': {
          if (!handlers.fileRead) return { ok: false, error: 'file_read handler not wired' };
          const content = await handlers.fileRead(a.path ?? '');
          return { ok: true, result: content };
        }
        case 'file_write': {
          if (!handlers.fileWrite) return { ok: false, error: 'file_write handler not wired' };
          await handlers.fileWrite(a.path ?? '', a.content ?? '');
          return { ok: true, result: `wrote ${a.path}` };
        }
        default:
          return { ok: false, error: `unknown tool: ${name}` };
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  return { execute };
}
