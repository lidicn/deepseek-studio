/**
 * Studio 手机/远程端（/agent）。
 *
 * 产品定位：它不再是一套独立聊天 UI，也不自造会话历史。
 * 任务由电脑端 DeepSeek 页面 + Studio overlay 执行；本页只负责：
 *   - 发送远程任务 / 停止 / 切换策略与工作区
 *   - 读取宿主镜像的同一份 StudioExecutionSession
 *   - 在手机窄屏上展示执行记录与工具进度
 */

declare global {
  interface Window {
    __STUDIO_TOKEN__?: string;
  }
}

export {};

import {
  createInitialState,
  canSend,
  canStop,
  type WorkbenchState,
} from './workbench/workbench-state';
import { createWorkbenchSocket, type WorkbenchSocket } from './workbench/workbench-ws';
import { mountInspectorDrawer } from './workbench/inspector-drawer';
import type {
  WorkbenchRequest,
  AckPayload,
  StudioExecutionIndex,
  StudioExecutionSession,
} from './workbench/workbench-types';
import { renderStatusbar } from './workbench/workbench-statusbar';
import { mountThemeToggle } from './workbench/theme-toggle';
import { mountDesktopHint } from './workbench/desktop-hint';
import { mountLayoutBreakpoints } from './workbench/layout-breakpoints';
import { createWidthObserver } from './workbench/width-observer';
import {
  renderExecutionIndex,
  renderExecutionIndexSelect,
  renderExecutionSession,
} from './workbench/workbench-execution-view';

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
const btnTheme = $<HTMLButtonElement>('btn-theme');
const btnInspector = $<HTMLButtonElement>('btn-inspector');
const drawer = $('inspector-drawer');
const btnDrawerClose = $<HTMLButtonElement>('btn-drawer-close');
const wsPath = $('ws-path');
const connDot = $('conn-dot');
const connText = $('conn-text');
const hint = $('hint');
const sessionList = $('session-list');
const sessionSelect = $<HTMLSelectElement>('session-select');

const appRoot = document.getElementById('app') ?? document.body;
const layoutRoot = document.getElementById('studio-workbench-root') ?? document.body;

let socket: WorkbenchSocket | null = null;
let reqSeq = 0;
let state: WorkbenchState = createInitialState();
let executionIndex: StudioExecutionIndex | null = null;
let selectedSessionKey: string | null = null;
let activeSession: StudioExecutionSession | null = null;
let requestedSessionKey: string | null = null;

function selectSession(key: string): void {
  if (!key || key === selectedSessionKey) return;
  selectedSessionKey = key;
  activeSession = null;
  renderSessionList();
  requestExecutionSession(key);
}

function renderSessionList(): void {
  renderExecutionIndex(sessionList, executionIndex, selectedSessionKey, selectSession);
  renderExecutionIndexSelect(sessionSelect, executionIndex, selectedSessionKey);
}

function renderActiveSession(): void {
  renderExecutionSession(canvas, [inspector, drawer], activeSession);
}

function applyExecutionIndex(index: StudioExecutionIndex | null): void {
  executionIndex = index;
  const entries = index?.sessions ?? [];
  const selectedStillExists = !!selectedSessionKey && entries.some((e) => e.key === selectedSessionKey);
  if (!selectedStillExists && entries.length > 0) {
    selectedSessionKey = entries[0].key;
    activeSession = null;
  }
  renderSessionList();
  if (selectedSessionKey) requestExecutionSession(selectedSessionKey);
  if (entries.length === 0) {
    selectedSessionKey = null;
    activeSession = null;
    requestedSessionKey = null;
    renderActiveSession();
  }
}

function applyExecutionSession(session: StudioExecutionSession | null): void {
  if (!session) return;
  if (selectedSessionKey && session.key !== selectedSessionKey) return;
  selectedSessionKey = session.key;
  activeSession = session;
  renderSessionList();
  renderActiveSession();
}

function applyExecutionCleared(): void {
  executionIndex = null;
  selectedSessionKey = null;
  activeSession = null;
  requestedSessionKey = null;
  renderSessionList();
  renderActiveSession();
}

function requestExecutionSession(key: string): void {
  if (requestedSessionKey === key && activeSession?.key === key) return;
  requestedSessionKey = key;
  call({ type: 'get-execution-session', key });
}

function syncFromState(): void {
  renderStatusbar(statusbar, state);
  btnSend.disabled = !canSend(state);
  input.disabled = !canSend(state);
  btnStop.classList.toggle('hidden', !canStop(state));
  const desktopOnline = state.connection === 'connected' && state.desktopPageConnected;
  connDot.className = `conn-dot ${desktopOnline ? 'ok' : state.connection === 'connecting' ? '' : 'bad'}`;
  connText.textContent = state.connection === 'connected'
    ? (state.desktopPageConnected ? '电脑页面在线' : '电脑页面离线')
    : state.connection === 'auth-failed'
      ? '鉴权失败（请重启桌面端）'
      : state.connection === 'disconnected'
        ? '连接断开，重试中…'
        : '连接中…';
  hint.textContent = state.running
    ? '电脑端执行中…'
    : state.connection === 'connected' && !state.desktopPageConnected
      ? '电脑端 DeepSeek 页面离线，远程发送已禁用'
      : '远程控制：任务由电脑端 DeepSeek 页面执行';
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
      // AgentLoopEvent 只驱动运行/错误状态；可展示历史统一来自执行会话。
      onLoopEvent: () => {},
      // 工具最终渲染以持久化执行会话为准，避免同一事件出现两份卡片。
      onToolRun: () => {},
      onExecutionIndex: (index) => applyExecutionIndex(index),
      onExecutionSession: (session) => applyExecutionSession(session),
      onExecutionCleared: () => applyExecutionCleared(),
    },
  });
}

function call(payload: Record<string, unknown>): string {
  const reqId = `r${++reqSeq}`;
  socket?.send({ ...payload, reqId } as WorkbenchRequest);
  return reqId;
}

function handleAck(ack: AckPayload): void {
  const ok = ack.ok === true;
  const data = ack.data;
  const error = typeof ack.error === 'string' ? ack.error : undefined;

  if (!ok && error) {
    const el = document.createElement('div');
    el.className = 'msg msg-error';
    el.textContent = `操作失败：${error}`;
    canvas.querySelector<HTMLElement>('.canvas-body')?.appendChild(el);
  }

  if (data?.index !== undefined) applyExecutionIndex(data.index ?? null);
  if (data?.session !== undefined) applyExecutionSession(data.session ?? null);

  if (ok && data && typeof data.path === 'string' && data.path.length > 0) {
    call({ type: 'set-workspace', path: data.path });
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
sessionSelect.addEventListener('change', () => selectSession(sessionSelect.value));

document.querySelectorAll<HTMLButtonElement>('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode) call({ type: 'set-policy', mode: btn.dataset.mode });
  });
});

mountInspectorDrawer({ drawer, toggleButton: btnInspector, closeButton: btnDrawerClose });
mountThemeToggle({ toggleButton: btnTheme });

const widthObserver = createWidthObserver(window.innerWidth);
const breakpoints = mountLayoutBreakpoints({ root: layoutRoot, observer: widthObserver });
mountDesktopHint({ parent: appRoot, observer: widthObserver, mobile: breakpoints.mobile });

startSocket();
syncFromState();
renderSessionList();
renderActiveSession();
input.focus();
