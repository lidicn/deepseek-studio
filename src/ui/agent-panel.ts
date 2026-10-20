/**
 * 智能体面板前端（/agent，原生 TS，esbuild 打包为 dist/agent-panel.js）
 *
 * 经 WS /agent-ws 驱动宿主 AgentLoop：send / stop / set-policy / set-workspace / pick-folder。
 * W2：三栏 Workbench —— 消息进中栏画布，tool-run 卡片进右栏 Inspector（复用 tool-run-card），
 * 连接/运行状态进状态条；禁用态只由 WorkbenchState 的 canSend/canStop 决定。
 */

declare global {
  interface Window {
    __STUDIO_TOKEN__?: string;
  }
}

/** 让本文件成为 ES 模块（declare global 的前置条件）。 */
export {};

import { createStepFlowContainer, type StepFlowHandle } from '../inject/step-flow-ui';
import {
  createInitialState,
  canSend,
  canStop,
  type WorkbenchState,
} from './workbench/workbench-state';
import { createWorkbenchSocket, type WorkbenchSocket } from './workbench/workbench-ws';
import type { WorkbenchRequest, AckPayload, AgentLoopEvent } from './workbench/workbench-types';
import { appendMessage, getCenterBody } from './workbench/workbench-center';
import { appendToolRun } from './workbench/workbench-inspector';
import { renderStatusbar } from './workbench/workbench-statusbar';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const canvas = $('center-canvas');
const inspector = $('right-inspector');
const statusbar = $('statusbar');
const input = $<HTMLTextAreaElement>('input');
const btnSend = $<HTMLButtonElement>('btn-send');
const btnStop = $<HTMLButtonElement>('btn-stop');
const btnFolder = $<HTMLButtonElement>('btn-open-folder');
const btnFocus = $<HTMLButtonElement>('btn-open-focus');
const wsPath = $('ws-path');
const connDot = $('conn-dot');
const connText = $('conn-text');
const hint = $('hint');

let socket: WorkbenchSocket | null = null;
let reqSeq = 0;
let currentFlow: StepFlowHandle | null = null;
let tickTimer: number | null = null;
let flowStep = 0;
let flowTools = 0;
let state: WorkbenchState = createInitialState();

/* ---------- 状态 → DOM ---------- */

function syncFromState(): void {
  renderStatusbar(statusbar, state);
  btnSend.disabled = !canSend(state);
  input.disabled = state.running;
  btnStop.classList.toggle('hidden', !canStop(state));
  connDot.className = `conn-dot ${state.connection === 'connected' ? 'ok' : state.connection === 'connecting' ? '' : 'bad'}`;
  connText.textContent = state.connection === 'connected'
    ? '已连接'
    : state.connection === 'auth-failed'
      ? '鉴权失败（请重启应用）'
      : state.connection === 'disconnected'
        ? '连接断开，重试中…'
        : '连接中…';
  hint.textContent = state.running ? '智能体执行中…' : '';
  document.querySelectorAll<HTMLButtonElement>('.seg').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.policyMode);
  });
  if (state.workspaceRoot) {
    wsPath.textContent = state.workspaceRoot;
    wsPath.classList.add('configured');
  } else {
    wsPath.textContent = '未选择工作区（文件能力不可用）';
    wsPath.classList.remove('configured');
  }
}

function commit(next: WorkbenchState): void {
  state = next;
  syncFromState();
}

/* ---------- 中栏步骤流 ---------- */

function startTick(): void {
  stopTick();
  tickTimer = window.setInterval(() => {
    currentFlow?.setPhase('running', flowStep, flowTools);
  }, 1000);
}
function stopTick(): void {
  if (tickTimer !== null) { window.clearInterval(tickTimer); tickTimer = null; }
}

function renderEvent(event: AgentLoopEvent): void {
  switch (event.type) {
    case 'user':
      appendMessage(canvas, 'user', event.text ?? '');
      if (currentFlow) { try { currentFlow.destroy(); } catch { /* */ } }
      flowStep = 0; flowTools = 0;
      currentFlow = createStepFlowContainer(() => call({ type: 'stop' }));
      canvas.appendChild(currentFlow.container);
      currentFlow.setPhase('running', 0, 0);
      startTick();
      break;
    case 'assistant':
      if (currentFlow) {
        currentFlow.updateNarration(flowStep, event.text ?? '');
        stopTick();
        currentFlow.finish(flowStep + 1, flowTools, 0);
        currentFlow = null;
      } else {
        appendMessage(canvas, 'assistant', event.text ?? '');
      }
      break;
    case 'status':
      if (event.step !== undefined) flowStep = event.step - 1;
      if (currentFlow) currentFlow.setPhase('running', flowStep, flowTools);
      appendMessage(canvas, 'status', event.text ?? '');
      break;
    case 'error':
      if (currentFlow) {
        stopTick();
        currentFlow.setPhase('error', flowStep, flowTools);
        currentFlow = null;
      }
      appendMessage(canvas, 'error', event.text ?? '');
      break;
    case 'tool': {
      flowTools += event.toolCalls ?? 0;
      if (currentFlow) currentFlow.setPhase('running', flowStep, flowTools);
      const card = document.createElement('div');
      card.className = 'msg msg-tool';
      const badge = document.createElement('span');
      badge.className = 'tool-badge';
      badge.textContent = `⚙ 工具执行完成（${event.toolCalls ?? 0} 次）`;
      card.appendChild(badge);
      if (event.step !== undefined) {
        const tag = document.createElement('span');
        tag.className = 'step-tag';
        tag.textContent = `第 ${event.step} 步`;
        card.appendChild(tag);
      }
      getCenterBody(canvas).appendChild(card);
      break;
    }
    case 'done':
      stopTick();
      if (currentFlow) {
        currentFlow.finish(flowStep + 1, flowTools, 0);
        currentFlow = null;
      }
      break;
  }
}

/* ---------- WS 通道（workbench-ws 统一连接/1008 不重连/分发） ---------- */

function startSocket(): void {
  const token = window.__STUDIO_TOKEN__ ?? '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/agent-ws?token=${encodeURIComponent(token)}`;
  socket = createWorkbenchSocket({
    url,
    initial: state,
    handlers: {
      onState: (next) => commit(next),
      onAck: (ack) => handleAck(ack),
      onLoopEvent: (ev) => renderEvent(ev),
      onToolRun: (toolEvent) => appendToolRun(inspector, toolEvent),
    },
  });
}

function call(payload: Record<string, unknown>): string {
  const reqId = `r${++reqSeq}`;
  socket?.send({ ...payload, reqId } as WorkbenchRequest);
  return reqId;
}

/* ---------- 交互 ---------- */

function handleAck(ack: AckPayload): void {
  const ok = ack.ok === true;
  const data = ack.data as { path?: string | null } | undefined;
  const error = typeof ack.error === 'string' ? ack.error : undefined;
  if (!ok && error) appendMessage(canvas, 'error', `操作失败：${error}`);
  if (ok && data && typeof data.path === 'string' && data.path.length > 0) {
    call({ type: 'set-workspace', path: data.path });
    appendMessage(canvas, 'status', `工作区已切换：${data.path}`);
  }
}

btnSend.addEventListener('click', () => {
  const text = input.value.trim();
  if (!text || !canSend(state)) return;
  input.value = '';
  call({ type: 'send', text });
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    btnSend.click();
  }
});

btnStop.addEventListener('click', () => call({ type: 'stop' }));
btnFolder.addEventListener('click', () => call({ type: 'pick-folder' }));

document.querySelectorAll<HTMLButtonElement>('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode) call({ type: 'set-policy', mode: btn.dataset.mode });
  });
});

// Focus 模式本期无自动挂载/快捷键：按钮降级为提示，不造假入口。
btnFocus.addEventListener('click', () => {
  appendMessage(canvas, 'status', '专注模式将由托盘菜单触发，本期不自动打开。');
});

startSocket();
syncFromState();
input.focus();
