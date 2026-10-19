/** 状态点（连接/执行/错误指示器） */
export function statusDot(tone: 'ok' | 'running' | 'error' | 'idle' = 'idle'): HTMLSpanElement {
  const el = document.createElement('span');
  el.setAttribute('role', 'status');
  const colors: Record<string, string> = {
    ok: '#1F7A52',
    running: '#4D6BFE',
    error: '#C43A3A',
    idle: '#6B7280',
  };
  el.style.cssText = [
    'display: inline-block',
    'width: 8px',
    'height: 8px',
    'border-radius: 50%',
    `background: ${colors[tone]}`,
    tone === 'running' ? 'animation: studio-pulse 1.2s infinite;' : '',
  ].join('; ');
  return el;
}
