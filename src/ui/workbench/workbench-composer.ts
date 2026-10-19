/**
 * Composer 绑定：输入框 + 发送/停止按钮的禁用态与事件。
 * 禁用只由 state 的 connection/running 决定（canSend/canStop），UI 不自行猜。
 */
import { canSend, canStop, type WorkbenchState } from './workbench-state';

export interface ComposerBinding {
  sync(state: WorkbenchState): void;
  dispose(): void;
}

export interface ComposerOptions {
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  onSend(text: string): void;
  onStop(): void;
}

export function bindComposer(options: ComposerOptions): ComposerBinding {
  const { input, sendBtn, stopBtn, onSend, onStop } = options;

  const handleSend = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onSend(text);
  };

  const onClickSend = () => handleSend();
  const onClickStop = () => onStop();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  sendBtn.addEventListener('click', onClickSend);
  stopBtn.addEventListener('click', onClickStop);
  input.addEventListener('keydown', onKeyDown);

  return {
    sync(state: WorkbenchState) {
      sendBtn.disabled = !canSend(state);
      input.disabled = state.running;
      stopBtn.classList.toggle('hidden', !canStop(state));
    },
    dispose() {
      sendBtn.removeEventListener('click', onClickSend);
      stopBtn.removeEventListener('click', onClickStop);
      input.removeEventListener('keydown', onKeyDown);
    },
  };
}
