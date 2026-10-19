/** 状态点（连接/执行/错误指示器） */

let pulseStyleInjected = false;

/** 幂等注入 studio-pulse keyframes，并提供 prefers-reduced-motion 降级覆盖。 */
function ensurePulseStyle(): void {
  if (pulseStyleInjected || typeof document === 'undefined') return;
  pulseStyleInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-studio-pulse', 'true');
  style.textContent = [
    '@keyframes studio-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }',
    '.studio-pulse-anim { animation: studio-pulse 1.2s infinite; }',
    '@media (prefers-reduced-motion: reduce) { .studio-pulse-anim { animation: none; } }',
  ].join('\n');
  document.head.appendChild(style);
}

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
  ].join('; ');
  if (tone === 'running') {
    ensurePulseStyle();
    el.classList.add('studio-pulse-anim');
  }
  return el;
}
