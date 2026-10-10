/**
 * 智能体面板前端（M1，原生 TS，esbuild 打包为 dist/agent-panel.js）
 *
 * 经 WS /agent-ws 驱动宿主 AgentLoop：send / stop / set-policy / set-workspace / pick-folder。
 * 会话流渲染 AgentLoop 事件（user/assistant/tool/status/error/done）。
 */

declare global {
  interface Window {
    __STUDIO_TOKEN__?: string;
  }
}

/** 让本文件成为 ES 模块（declare global 的前置条件）。 */
export {};

type PolicyMode = 'workspace' | 'ask' | 'auto' | 'full';

interface AgentEvent {
  type: 'user' | 'assistant' | 'tool' | 'status' | 'error' | 'done';
  text?: string;
  step?: number;
  toolCalls?: number;
}

interface StatePayload {
  type: 'state';
  policyMode: PolicyMode;
  panelModes: PolicyMode[];
  workspaceRoot: string | null;
  running: boolean;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const stream = $('stream');
const input = $<HTMLTextAreaElement>('input');
const btnSend = $<HTMLButtonElement>('btn-send');
const btnStop = $<HTMLButtonElement>('btn-stop');
const btnFolder = $<HTMLButtonElement>('btn-open-folder');
const wsPath = $('ws-path');
const connDot = $('conn-dot');
const connText = $('conn-text');
const hint = $('hint');

let ws: WebSocket | null = null;
let running = false;
let reconnectTimer: number | null = null;
let reqSeq = 0;

/* ---------- 会话流渲染 ---------- */

function addEl(cls: string, text?: string): HTMLElement {
  stream.querySelectorAll('.welcome').forEach((n) => n.remove());
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
  return el;
}

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'user':
      addEl('msg msg-user', event.text);
      break;
    case 'assistant':
      addEl('msg msg-assistant', event.text ?? '');
      break;
    case 'status':
      addEl('msg msg-status', event.text);
      break;
    case 'error':
      addEl('msg msg-error', event.text);
      break;
    case 'tool': {
      const card = addEl('msg msg-tool');
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
      break;
    }
    case 'done':
      setRunning(false);
      break;
  }
}

function setRunning(value: boolean): void {
  running = value;
  btnSend.disabled = value || !connected;
  input.disabled = value;
  btnStop.classList.toggle('hidden', !value);
  hint.textContent = value ? '智能体执行中…' : '';
}

/* ---------- WS 通道 ---------- */

function connect(): void {
  const token = window.__STUDIO_TOKEN__ ?? '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/agent-ws?token=${encodeURIComponent(token)}`);
  ws = socket;

  socket.onopen = () => {
    connDot.className = 'conn-dot ok';
    connText.textContent = '已连接';
    connected = true;
    setRunning(running);
  };
  socket.onclose = (ev) => {
    connDot.className = 'conn-dot bad';
    // 1008 = 服务端鉴权拒绝（令牌不匹配）：提示重启宿主而非盲目重试
    connText.textContent = ev.code === 1008 ? '鉴权失败（请重启应用）' : '连接断开，重试中…';
    connected = false;
    setRunning(false);
    if (ev.code !== 1008 && reconnectTimer === null) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    }
  };
  socket.onerror = () => socket.close();
  socket.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data as string) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'state') {
      applyState(msg as unknown as StatePayload);
    } else if (msg.type === 'event') {
      renderEvent(msg.event as AgentEvent);
    } else if (msg.type === 'ack') {
      handleAck(msg);
    }
  };
}

let connected = false;

function call(payload: Record<string, unknown>): string {
  const reqId = `r${++reqSeq}`;
  ws?.send(JSON.stringify({ ...payload, reqId }));
  return reqId;
}

/* ---------- 状态与交互 ---------- */

function applyState(state: StatePayload): void {
  if (state.workspaceRoot) {
    wsPath.textContent = state.workspaceRoot;
    wsPath.classList.add('configured');
  } else {
    wsPath.textContent = '未选择工作区（文件能力不可用）';
    wsPath.classList.remove('configured');
  }
  document.querySelectorAll<HTMLButtonElement>('.seg').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.policyMode);
  });
  if (state.running !== running) setRunning(state.running);
}

function handleAck(msg: Record<string, unknown>): void {
  const ok = msg.ok === true;
  const data = msg.data as { path?: string | null } | undefined;
  const error = typeof msg.error === 'string' ? msg.error : undefined;
  if (!ok && error) addEl('msg msg-error', `操作失败：${error}`);
  if (ok && data && 'path' in data) {
    // pick-folder 的响应：选到目录则立即设为工作区
    if (typeof data.path === 'string' && data.path.length > 0) {
      call({ type: 'set-workspace', path: data.path });
      addEl('msg msg-status', `工作区已切换：${data.path}`);
    }
  }
}

btnSend.addEventListener('click', () => {
  const text = input.value.trim();
  if (!text || running || !connected) return;
  input.value = '';
  call({ type: 'send', text });
  setRunning(true);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    btnSend.click();
  }
});

btnStop.addEventListener('click', () => {
  call({ type: 'stop' });
});

btnFolder.addEventListener('click', () => {
  call({ type: 'pick-folder' });
});

document.querySelectorAll<HTMLButtonElement>('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode) call({ type: 'set-policy', mode: btn.dataset.mode });
  });
});

connect();
input.focus();
