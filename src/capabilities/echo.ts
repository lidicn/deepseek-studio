/**
 * 最小能力：echo（v0.2 证明「授权 → 执行」链路）
 *
 * 实现 ContentCapabilityController：start 持有一个资源以证明「资源所有权不变量」
 * （start 后 snapshot.total > 0，stop 后归零，硬不变量 #2）。真实能力（chat-read/insert/send）
 * 在 v0.3 接入，本能力仅用于骨架打通。
 */

import type { ContentCapabilityController, ContentResourceScope } from '../inject/types';
import type { ExecutableCapability, ExecuteResult } from './types';

let lastExecutedAt = 0;

export function createEchoCapability(): ContentCapabilityController & ExecutableCapability {
  return {
    id: 'echo',
    start(scope: ContentResourceScope): void {
      // 持有一个资源：start 后 snapshot.total > 0；stop 后由 scope 回收归零。
      scope.addCleanup('listener', () => {
        lastExecutedAt = Date.now();
      });
      lastExecutedAt = Date.now();
    },
    async stop(): Promise<void> {
      // 资源由 scope 回收，这里无需额外清理。
    },
    async execute(): Promise<ExecuteResult> {
      // 页端 echo 能力：宿主经 ws 路由到此，返回成功（不触碰 DOM）。
      return { ok: true };
    },
  };
}

/** 仅供测试 / 宿主读取最近一次执行时间戳（v0.3 起由能力经 bridge 主动回传）。 */
export function getEchoLastExecutedAt(): number {
  return lastExecutedAt;
}
