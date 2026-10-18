/**
 * step-control.ts — 步骤级控制（移植自 deepseek++ step-control.ts）
 * @upstream-commit 187f6227 @upstream-path core/inline-agent/step-control.ts
 *
 * 功能：
 * - 步骤超时（120s）+ AbortSignal
 * - 请求节流（2.5-6.5s 随机延迟）
 */

const STEP_TIMEOUT_MS = 120_000;
const REQUEST_DELAY_MIN_MS = 2500;
const REQUEST_DELAY_MAX_MS = 6500;

export interface StepSignal {
  signal: AbortSignal;
  clear: () => void;
  timedOut: () => boolean;
}

/**
 * 创建步骤超时信号：120s 后自动 abort，或父信号 abort 时立即 abort。
 */
export function createStepSignal(parentSignal: AbortSignal): StepSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Agent step timed out.', 'TimeoutError'));
  }, STEP_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    onParentAbort();
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const clear = () => {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', onParentAbort);
  };
  return { signal: controller.signal, clear, timedOut: () => timedOut };
}

/** 在两次请求之间等待随机 2.5-6.5s，避免触发风控。 */
export function waitBetweenRequests(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const delay = randomInt(REQUEST_DELAY_MIN_MS, REQUEST_DELAY_MAX_MS);
  return new Promise((resolve) => {
    const timeout = setTimeout(cleanup, delay);
    const onAbort = () => cleanup();

    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
