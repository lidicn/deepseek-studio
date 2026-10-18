/**
 * HostToolsAdapter（M4-B）：把宿主 hostTools（Map<string, ExecutableCapability>）
 * 适配成 TaskLoop 用的 ToolExecutor 接口。
 *
 * 桥接原则：
 *   - 不绕 consent 闸：hostTools.get(name).execute() 是已授权的能力执行点，
 *     consent 在 invokeTool 层已经做过了；这里只是把结果包成 ToolExecutorResult。
 *   - 工具名映射：TaskLoop 看到的 name 直接是 hostTools 的 key（shell.exec / file.read / search_files ...）。
 */

import type { ToolExecutor, ToolExecutorResult } from './tool-bridge';
import type { ExecutableCapability } from '../../capabilities/types';

export function createHostToolsAdapter(hostTools: ReadonlyMap<string, ExecutableCapability>): ToolExecutor {
  return {
    async execute(name: string, args?: unknown): Promise<ToolExecutorResult> {
      const cap = hostTools.get(name);
      if (!cap) return { ok: false, error: `unknown tool: ${name}` };
      try {
        const result = await cap.execute((args ?? {}) as Record<string, unknown>);
        if (!result.ok) return { ok: false, error: result.error ?? 'unknown error' };
        // data 序列化成字符串塞回 result
        return { ok: true, result: typeof result.data === 'string' ? result.data : JSON.stringify(result.data) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
}
