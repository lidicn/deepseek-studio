/**
 * step-flow-ui.ts — 分布思考步骤流 UI（移植自 deepseek++ render-steps.ts + render-console.ts）
 *
 * 在助手消息区域渲染：
 *   - 顶部状态栏（正在运行·第N步·已调用M次工具·Xs + 停止按钮）
 *   - 折叠推理笔记（Thought · step N）
 *   - 步骤叙述文本（流式 markdown）
 *   - 工具调用分组（已调用M次工具，单行条目，可展开详情）
 *   - 滚动跟随
 */

const STEP_FLOW_STYLE_ID = 'ds-studio-step-flow-css';

const svgDataUri = (body: string, viewBox = '0 0 24 24'): string =>
  `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor">${body}</svg>`,
  )}")`;

const ICON_GEAR = svgDataUri('<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62-.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>');
const ICON_CHEVRON_DOWN = svgDataUri('<path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>');
const ICON_CHEVRON_RIGHT = svgDataUri('<path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>');

function injectStepFlowStyles(): void {
  if (document.getElementById(STEP_FLOW_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STEP_FLOW_STYLE_ID;
  style.textContent = `
    .ds-sf-container { position: fixed; bottom: 160px; left: 50%; transform: translateX(-50%); width: min(768px, 92vw); max-height: 240px; margin: 0; padding: 8px 14px; border-radius: 10px; background: #eef0ff; color: #1f2329; z-index: 2147483647; box-shadow: 0 2px 12px rgba(51,112,255,.12); overflow: hidden; display: flex; flex-direction: column; }
    /* v1.7：步骤流主体可滚动，容器 max-height 限制不无限增高挡住对话内容 */
    .ds-sf-stream { flex: 1; min-height: 0; overflow-y: auto; }
    .ds-sf-status-line { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; line-height: 1.5; color: #646a73; }
    .ds-sf-status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #8f959e; }
    .ds-sf-container[data-phase="running"] .ds-sf-status-dot { background: #3370ff; animation: ds-sf-pulse 1.1s ease-in-out infinite; }
    .ds-sf-container[data-phase="complete"] .ds-sf-status-dot { background: #34a853; }
    .ds-sf-container[data-phase="error"] .ds-sf-status-dot { background: #e5484d; }
    @keyframes ds-sf-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
    .ds-sf-status-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ds-sf-container[data-phase="error"] .ds-sf-status-text { color: #e5484d; }
    .ds-sf-stop-btn { flex: none; padding: 2px 9px; font-size: 12px; border: 1px solid #e5484d; border-radius: 6px; background: transparent; color: #e5484d; cursor: pointer; }
    .ds-sf-stop-btn:hover { background: #fef0f0; }

    /* 推理笔记（折叠） */
    .ds-sf-reasoning-note { margin: 4px 0; }
    .ds-sf-reasoning-note-toggle { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; color: #646a73; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-reasoning-note-icon { flex: none; width: 14px; height: 14px; background: currentColor; opacity: .6; mask-image: ${ICON_CHEVRON_RIGHT}; mask-size: contain; -webkit-mask-image: ${ICON_CHEVRON_RIGHT}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-reasoning-note-toggle[aria-expanded="true"] .ds-sf-reasoning-note-icon { transform: rotate(90deg); }
    .ds-sf-reasoning-note-title { flex: 1; }
    .ds-sf-reasoning-note-body { padding: 4px 0 4px 20px; font-size: 13px; line-height: 1.6; color: #646a73; white-space: pre-wrap; word-break: break-word; }

    /* 步骤叙述文本 */
    .ds-sf-step { margin: 4px 0; }
    .ds-sf-step-body { font-size: 14px; line-height: 1.7; color: #1f2329; word-break: break-word; }
    .ds-sf-step-body:empty { display: none; }

    /* 工具分组 */
    .ds-sf-tool-group { margin: 4px 0; }
    .ds-sf-tool-group-toggle { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; color: #646a73; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-tool-group-icon { flex: none; width: 14px; height: 14px; background: currentColor; mask-image: ${ICON_GEAR}; mask-size: contain; -webkit-mask-image: ${ICON_GEAR}; -webkit-mask-size: contain; }
    .ds-sf-tool-group-title { flex: 1; }
    .ds-sf-tool-group-chevron { flex: none; width: 14px; height: 14px; background: currentColor; opacity: .6; mask-image: ${ICON_CHEVRON_DOWN}; mask-size: contain; -webkit-mask-image: ${ICON_CHEVRON_DOWN}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-tool-group[data-collapsed="true"] .ds-sf-tool-group-chevron { transform: rotate(-90deg); }
    .ds-sf-tool-group-items { padding-left: 20px; }
    .ds-sf-tool-group[data-collapsed="true"] .ds-sf-tool-group-items { display: none; }

    /* 工具条目 */
    .ds-sf-tool-item { margin: 2px 0; }
    .ds-sf-tool-toggle { display: flex; align-items: center; gap: 6px; padding: 1px 0; font-size: 13px; color: #1f2329; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-tool-state-icon { flex: none; width: 12px; height: 12px; border-radius: 50%; background: #8f959e; }
    .ds-sf-tool-item[data-tool-status="pending"] .ds-sf-tool-state-icon { background: #3370ff; animation: ds-sf-pulse 1.1s ease-in-out infinite; }
    .ds-sf-tool-item[data-tool-status="ok"] .ds-sf-tool-state-icon { background: #34a853; }
    .ds-sf-tool-item[data-tool-status="err"] .ds-sf-tool-state-icon { background: #e5484d; }
    .ds-sf-tool-name { flex: none; font-weight: 500; }
    .ds-sf-tool-param { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8f959e; }
    .ds-sf-tool-state { flex: none; font-size: 12px; color: #8f959e; }
    .ds-sf-tool-item[data-tool-status="ok"] .ds-sf-tool-state { color: #34a853; }
    .ds-sf-tool-item[data-tool-status="err"] .ds-sf-tool-state { color: #e5484d; }
    .ds-sf-tool-chevron { flex: none; width: 12px; height: 12px; background: currentColor; opacity: .4; mask-image: ${ICON_CHEVRON_RIGHT}; mask-size: contain; -webkit-mask-image: ${ICON_CHEVRON_RIGHT}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-tool-toggle[aria-expanded="true"] .ds-sf-tool-chevron { transform: rotate(90deg); }
    .ds-sf-tool-summary { padding: 4px 0 4px 24px; font-size: 12px; line-height: 1.5; color: #646a73; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
  `;
  document.head.appendChild(style);
}

export type StepFlowPhase = 'starting' | 'running' | 'complete' | 'paused' | 'error';

export interface StepFlowHandle {
  container: HTMLElement;
  setPhase: (phase: StepFlowPhase, step?: number, toolCount?: number, elapsed?: number) => void;
  addToolEntry: (stepIndex: number, toolName: string, params?: Record<string, unknown>) => number;
  resolveToolEntry: (stepIndex: number, ok: boolean, detail?: string) => void;
  addReasoningNote: (stepIndex: number, text?: string) => void;
  updateNarration: (stepIndex: number, text: string) => void;
  finish: (totalSteps: number, totalTools: number, elapsed: number) => void;
  destroy: () => void;
}

interface StreamState {
  currentToolGroup: HTMLElement | null;
  pendingRows: HTMLElement[];
  narrationMap: Map<number, HTMLElement>;
  reasoningMap: Map<number, HTMLElement>;
  stepCount: number;
  toolCount: number;
  startTime: number;
}

function summarizeParams(params?: Record<string, unknown>): string | null {
  if (!params) return null;
  const keys = Object.keys(params);
  if (keys.length === 0) return null;
  // 取第一个参数的值做摘要
  const firstKey = keys[0];
  const firstVal = String(params[firstKey]).slice(0, 40);
  return `${firstKey}=${firstVal}`;
}

export function createStepFlowContainer(onStop?: () => void): StepFlowHandle {
  injectStepFlowStyles();

  const container = document.createElement('div');
  container.className = 'ds-sf-container';
  container.setAttribute('data-phase', 'starting');

  const statusLine = document.createElement('div');
  statusLine.className = 'ds-sf-status-line';

  const dot = document.createElement('span');
  dot.className = 'ds-sf-status-dot';

  const status = document.createElement('span');
  status.className = 'ds-sf-status-text';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = '正在启动…';

  statusLine.appendChild(dot);
  statusLine.appendChild(status);

  if (onStop) {
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'ds-sf-stop-btn';
    stopBtn.textContent = '停止';
    stopBtn.addEventListener('click', (e) => { e.stopPropagation(); onStop!(); });
    statusLine.appendChild(stopBtn);
  }

  const stream = document.createElement('div');
  stream.className = 'ds-sf-stream';

  container.appendChild(statusLine);
  container.appendChild(stream);

  const state: StreamState = {
    currentToolGroup: null,
    pendingRows: [],
    narrationMap: new Map(),
    reasoningMap: new Map(),
    stepCount: 0,
    toolCount: 0,
    startTime: Date.now(),
  };

  function setPhase(phase: StepFlowPhase, step?: number, toolCount?: number, elapsed?: number): void {
    container.setAttribute('data-phase', phase);
    if (phase === 'running') {
      const s = step ?? state.stepCount;
      const tc = toolCount ?? state.toolCount;
      const el = elapsed ?? Math.round((Date.now() - state.startTime) / 1000);
      status.textContent = `deepseek++ 执行中 · 第${s + 1}步 · 已调用${tc}次工具 · ${el}s`;
    } else if (phase === 'complete') {
      status.textContent = `完成 · ${state.stepCount}步 · ${state.toolCount}次工具 · ${Math.round((Date.now() - state.startTime) / 1000)}s`;
    } else if (phase === 'error') {
      status.textContent = `出错 · ${state.stepCount}步 · ${state.toolCount}次工具`;
    } else if (phase === 'paused') {
      status.textContent = `暂停 · ${state.stepCount}步 · ${state.toolCount}次工具`;
    } else {
      status.textContent = '正在启动…';
    }
  }

  function followScroll(): void {
    // v1.8：step-flow 是 position:fixed 悬浮容器，不需要跟随对话滚动。
    // 之前会爬祖先链找可滚动容器并强制滚到底（el.scrollTop = el.scrollHeight），
    // 与 auto-continue 渲染结论时的 last.scrollIntoView 冲突 —— 每次工具调用
    // /结果回填都把对话拉到工具卡片位置，结论被反复顶走。
    // fixed 容器自身在视口内固定，移除对话滚动跟随即可。
  }

  function createToolGroup(stepIndex: number): HTMLElement {
    const group = document.createElement('div');
    group.className = 'ds-sf-tool-group';
    group.setAttribute('data-step-index', String(stepIndex));
    group.setAttribute('data-collapsed', 'false');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ds-sf-tool-group-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.addEventListener('click', () => {
      group.setAttribute('data-user-toggled', 'true');
      const collapsed = group.getAttribute('data-collapsed') === 'true';
      group.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
    });

    const icon = document.createElement('span');
    icon.className = 'ds-sf-tool-group-icon';

    const title = document.createElement('span');
    title.className = 'ds-sf-tool-group-title';

    const chevron = document.createElement('span');
    chevron.className = 'ds-sf-tool-group-chevron';

    toggle.appendChild(icon);
    toggle.appendChild(title);
    toggle.appendChild(chevron);

    const items = document.createElement('div');
    items.className = 'ds-sf-tool-group-items';

    group.appendChild(toggle);
    group.appendChild(items);
    return group;
  }

  function updateGroupCount(group: HTMLElement): void {
    const title = group.querySelector('.ds-sf-tool-group-title');
    if (!title) return;
    const count = group.querySelectorAll('.ds-sf-tool-item').length;
    title.textContent = `已调用${count}次工具`;
  }

  function addToolEntry(stepIndex: number, toolName: string, params?: Record<string, unknown>): number {
    // 创建工具条目
    const item = document.createElement('div');
    item.className = 'ds-sf-tool-item';
    item.setAttribute('data-tool-status', 'pending');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ds-sf-tool-toggle';
    toggle.setAttribute('aria-expanded', 'false');

    const stateIcon = document.createElement('span');
    stateIcon.className = 'ds-sf-tool-state-icon';

    const name = document.createElement('span');
    name.className = 'ds-sf-tool-name';
    name.textContent = toolName;

    const param = document.createElement('span');
    param.className = 'ds-sf-tool-param';
    const summary = summarizeParams(params);
    param.textContent = summary ? `· ${summary}` : '';

    const stateLabel = document.createElement('span');
    stateLabel.className = 'ds-sf-tool-state';
    stateLabel.textContent = '';

    const chevron = document.createElement('span');
    chevron.className = 'ds-sf-tool-chevron';

    toggle.appendChild(stateIcon);
    toggle.appendChild(name);
    toggle.appendChild(param);
    toggle.appendChild(stateLabel);
    toggle.appendChild(chevron);

    const detail = document.createElement('div');
    detail.className = 'ds-sf-tool-summary';
    detail.hidden = true;

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      detail.hidden = expanded;
    });

    item.appendChild(toggle);
    item.appendChild(detail);

    // 添加到当前工具组；v0.18：步骤变化时新建分组（工具按步骤折叠）
    let group = state.currentToolGroup;
    const groupStep = group?.getAttribute('data-step-index');
    if (!group || group.parentElement !== stream || groupStep !== String(stepIndex)) {
      group = createToolGroup(stepIndex);
      stream.appendChild(group);
      state.currentToolGroup = group;
    }
    group.querySelector('.ds-sf-tool-group-items')?.appendChild(item);
    updateGroupCount(group);

    state.pendingRows.push(item);
    state.toolCount++;
    followScroll();
    return state.toolCount;
  }

  function resolveToolEntry(_stepIndex: number, ok: boolean, detail?: string): void {
    const row = state.pendingRows.shift();
    if (!row) return;
    row.setAttribute('data-tool-status', ok ? 'ok' : 'err');
    const stateLabel = row.querySelector('.ds-sf-tool-state') as HTMLElement;
    if (stateLabel) stateLabel.textContent = ok ? 'OK' : 'Error';
    const detailEl = row.querySelector('.ds-sf-tool-summary') as HTMLElement;
    if (detailEl && detail) {
      detailEl.textContent = detail.length > 4000 ? detail.slice(0, 4000) + '\n...[截断]' : detail;
    }
    followScroll();
  }

  function addReasoningNote(stepIndex: number, text?: string): void {
    // v0.18：已存在则流式更新 body，而非忽略
    const existing = state.reasoningMap.get(stepIndex);
    if (existing) {
      const bodyEl = existing.querySelector('.ds-sf-reasoning-note-body') as HTMLElement;
      if (bodyEl && text != null && bodyEl.textContent !== text) {
        bodyEl.textContent = text;
        followScroll();
      }
      return;
    }
    const note = document.createElement('div');
    note.className = 'ds-sf-reasoning-note';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ds-sf-reasoning-note-toggle';
    toggle.setAttribute('aria-expanded', 'false');

    const icon = document.createElement('span');
    icon.className = 'ds-sf-reasoning-note-icon';

    const title = document.createElement('span');
    title.className = 'ds-sf-reasoning-note-title';
    title.textContent = `已思考 · 第${stepIndex + 1}步`;

    toggle.appendChild(icon);
    toggle.appendChild(title);

    const body = document.createElement('div');
    body.className = 'ds-sf-reasoning-note-body';
    body.hidden = true;
    body.textContent = text ?? '该步骤的思考过程未保留';

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      body.hidden = expanded;
    });

    note.appendChild(toggle);
    note.appendChild(body);

    // 插入到流的末尾（叙述文本之前）
    stream.appendChild(note);
    state.reasoningMap.set(stepIndex, note);
    followScroll();
  }

  function updateNarration(stepIndex: number, text: string): void {
    let narration = state.narrationMap.get(stepIndex);
    if (!narration) {
      narration = document.createElement('div');
      narration.className = 'ds-sf-step';
      narration.setAttribute('data-step-index', String(stepIndex));
      const body = document.createElement('div');
      body.className = 'ds-sf-step-body';
      narration.appendChild(body);
      stream.appendChild(narration);
      state.narrationMap.set(stepIndex, narration);
      state.stepCount = Math.max(state.stepCount, stepIndex + 1);
    }
    const body = narration.querySelector('.ds-sf-step-body') as HTMLElement;
    if (body && body.textContent !== text) {
      body.textContent = text;
      followScroll();
    }
  }

  function finish(totalSteps: number, totalTools: number, _elapsed: number): void {
    state.stepCount = totalSteps;
    state.toolCount = totalTools;
    // 折叠所有工具组
    stream.querySelectorAll('.ds-sf-tool-group').forEach((group) => {
      if (group.getAttribute('data-user-toggled') !== 'true') {
        group.setAttribute('data-collapsed', 'true');
      }
    });
    state.currentToolGroup = null;
    setPhase('complete');
  }

  function destroy(): void {
    container.remove();
    document.getElementById(STEP_FLOW_STYLE_ID)?.remove();
  }

  return {
    container,
    setPhase,
    addToolEntry,
    resolveToolEntry,
    addReasoningNote,
    updateNarration,
    finish,
    destroy,
  };
}
