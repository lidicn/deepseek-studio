/**
 * 工作台 MCP 服务器编辑器（`/agent` 页面）。
 *
 * ── 定位 ──
 *
 * MCP 配置里装着**凭据**（`env` / `headers` 的值、`url` 里的 userinfo、`args` 里的
 * `--token xxx`）。本编辑器是**唯一**能看见并修改明文的地方，理由：
 *
 *   1. 本页面跑在**独立 origin**（`http://127.0.0.1:8760/agent`）——由
 *      `open_workbench`（`src-tauri/src/main.rs:747`）用 `WebviewUrl::External`
 *      开的**独立 webview 窗口**，**不是 iframe**。
 *   2. DeepSeek 页面里的模型与 UI 面板**同 `globalThis`**（Core 核实），
 *      但它**跨不到**本 origin 的 DOM / JS —— 本页面在模型的可达面之外。
 *   3. 本页 HTML 由服务端把 `__STUDIO_TOKEN__` 替换成**真令牌**
 *      （`src/api/server.ts:100-107`），因此能通过 `/v1/*` 的统一 Bearer 校验。
 *
 * ── 纪律 ──
 *
 *   - **不经工具通道**：本文件**不 import** `studio-ui-core`（`callHostTool` 的家），
 *     也不碰 `sendToolCall`。只走 `fetch` + Bearer。
 *   - 只打 `/v1/mcp/servers*`（`/v1/*` 在 `src/api/server.ts:362-363` 统一走
 *     Bearer 校验、fail-closed）；**绝不**挂到 `/agent` 那段免鉴权路由旁。
 *   - 用户输入（服务器名 / URL / env 值…）一律走 `textContent` / `value`，
 *     **不拼 innerHTML**。
 */

/** 端点集中在这里，便于与 Core 的 `src/api/server.ts` 对齐。 */
export const MCP_SERVERS_ENDPOINT = '/v1/mcp/servers';

export interface McpServerConfigView {
  id?: string;
  name?: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
}

export interface McpEditorOptions {
  /** 挂载容器（工作台 center-canvas 内的一个 section）。 */
  root: HTMLElement;
  /** Bearer 令牌（工作台 HTML 内嵌的真令牌）。 */
  token: string;
  /** 服务端 origin；默认取当前页面 origin。 */
  origin?: string;
}

export interface McpEditorHandle {
  /** 重新拉取列表并渲染。 */
  refresh(): Promise<void>;
  /** 显示/隐藏整个编辑器。 */
  setVisible(visible: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: { className?: string; text?: string; attrs?: Record<string, string> },
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props?.className) node.className = props.className;
  if (props?.text !== undefined) node.textContent = props.text;
  if (props?.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  }
  return node;
}

/** `KEY=VALUE` 多行文本 ⇄ 记录。空行与 `#` 开头行忽略。 */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** 记录 ⇄ `KEY=VALUE` 多行文本。 */
export function formatKeyValueLines(record: Record<string, string> | undefined): string {
  if (!record) return '';
  return Object.entries(record).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function formatArgsLines(args: readonly string[] | undefined): string {
  return (args ?? []).join('\n');
}

/** 解析参数列表（每行一个参数；空行忽略）。 */
export function parseArgsLines(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function transportLabel(transport: string | undefined): string {
  return (transport ?? 'stdio').toUpperCase();
}

export function targetOf(cfg: McpServerConfigView | undefined): string {
  if (!cfg) return '';
  return cfg.url || cfg.command || '';
}

/**
 * 挂载 MCP 编辑器。
 *
 * 返回的 handle 由 `agent-panel.ts` 持有；编辑器的每次请求都带 Bearer。
 */
export function mountMcpEditor(options: McpEditorOptions): McpEditorHandle {
  const { root, token } = options;
  const origin = options.origin ?? location.origin;

  // ── 结构 ──
  root.classList.add('mcp-editor');
  root.replaceChildren();

  const header = el('div', { className: 'mcp-editor-header' });
  const title = el('h3', { className: 'mcp-editor-title', text: 'MCP 服务器' });
  const hint = el('span', {
    className: 'mcp-editor-hint',
    text: '此处显示明文配置（仅工作台可见）。DeepSeek 页面内只读。',
  });
  const addBtn = el('button', { className: 'btn btn-primary', attrs: { type: 'button', id: 'btn-mcp-add' }, text: '添加服务器' });
  addBtn.addEventListener('click', () => { openForm(null); });
  header.appendChild(title);
  header.appendChild(hint);
  header.appendChild(addBtn);
  root.appendChild(header);

  const list = el('div', { className: 'mcp-editor-list', attrs: { id: 'mcp-editor-list' } });
  root.appendChild(list);

  const status = el('p', { className: 'mcp-editor-status', attrs: { id: 'mcp-editor-status' }, text: '' });
  root.appendChild(status);

  const form = el('div', { className: 'mcp-editor-form', attrs: { id: 'mcp-editor-form' } });
  form.style.display = 'none';
  root.appendChild(form);

  let servers: McpServerConfigView[] = [];
  let editingId: string | null = null;

  function setStatus(text: string, tone: 'ok' | 'err' | '' = ''): void {
    status.textContent = text;
    status.className = `mcp-editor-status${tone ? ` is-${tone}` : ''}`;
  }

  async function request(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  }

  function renderList(): void {
    list.replaceChildren();
    if (servers.length === 0) {
      list.appendChild(el('div', { className: 'mcp-editor-empty', text: '暂无配置的 MCP 服务器' }));
      return;
    }
    for (const cfg of servers) {
      const id = cfg.id ?? cfg.name ?? '';
      const item = el('div', { className: 'mcp-editor-item' });
      const info = el('div', { className: 'mcp-editor-item-info' });
      const name = el('div', { className: 'mcp-editor-item-name' });
      name.appendChild(el('span', { text: id }));
      name.appendChild(el('span', { className: 'mcp-editor-item-transport', text: transportLabel(cfg.transport) }));
      info.appendChild(name);
      info.appendChild(el('div', { className: 'mcp-editor-item-target', text: targetOf(cfg) }));
      item.appendChild(info);

      const actions = el('div', { className: 'mcp-editor-item-actions' });
      const editBtn = el('button', { className: 'btn btn-ghost', attrs: { type: 'button' }, text: '编辑' });
      editBtn.addEventListener('click', () => { openForm(cfg); });
      const delBtn = el('button', { className: 'btn btn-danger', attrs: { type: 'button' }, text: '删除' });
      delBtn.addEventListener('click', () => { void removeServer(id); });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const r = await request('GET', MCP_SERVERS_ENDPOINT);
      if (!r.ok) {
        setStatus(`读取失败（HTTP ${r.status}）`, 'err');
        return;
      }
      const payload = (r.data ?? {}) as { servers?: McpServerConfigView[] };
      servers = Array.isArray(payload.servers) ? payload.servers : [];
      renderList();
      setStatus(`已加载 ${servers.length} 台服务器`, 'ok');
    } catch (e) {
      setStatus(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  // ── 表单 ──
  interface McpEditorFields {
    id: HTMLInputElement;
    transport: HTMLSelectElement;
    command: HTMLInputElement;
    args: HTMLTextAreaElement;
    cwd: HTMLInputElement;
    env: HTMLTextAreaElement;
    url: HTMLInputElement;
    headers: HTMLTextAreaElement;
  }
  let fields: McpEditorFields | null = null;

  function buildForm(): void {
    form.replaceChildren();

    const idGroup = el('div', { className: 'mcp-editor-field' });
    idGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '服务器名称 *' }));
    const idInput = el('input', { className: 'mcp-editor-input', attrs: { type: 'text', placeholder: '如 filesystem、github' } });
    idGroup.appendChild(idInput);

    const transportGroup = el('div', { className: 'mcp-editor-field' });
    transportGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '传输类型' }));
    const transportSelect = el('select', { className: 'mcp-editor-input' });
    for (const [value, label] of [['stdio', 'stdio（本地进程）'], ['http', 'HTTP'], ['sse', 'SSE']] as const) {
      const opt = el('option', { attrs: { value }, text: label });
      transportSelect.appendChild(opt);
    }
    transportGroup.appendChild(transportSelect);

    const commandGroup = el('div', { className: 'mcp-editor-field' });
    commandGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '启动命令 *（stdio）' }));
    const commandInput = el('input', { className: 'mcp-editor-input', attrs: { type: 'text', placeholder: '如 npx、python、uvx' } });
    commandGroup.appendChild(commandInput);

    const argsGroup = el('div', { className: 'mcp-editor-field' });
    argsGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '参数（每行一个，stdio）' }));
    const argsArea = el('textarea', { className: 'mcp-editor-textarea', attrs: { rows: '3' } });
    argsGroup.appendChild(argsArea);

    // cwd 属于定稿契约里的字段（`GET /v1/mcp/servers` → `{ id, transport, command, args, env, headers, url, cwd }`）。
    // 这里**必须有**输入框：编辑既有服务器时若不回传原值，保存会把 cwd 丢掉。
    const cwdGroup = el('div', { className: 'mcp-editor-field' });
    cwdGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '工作目录 cwd（可选，stdio）' }));
    const cwdInput = el('input', { className: 'mcp-editor-input', attrs: { type: 'text', placeholder: '如 E:/NAS/mcp-server' } });
    cwdGroup.appendChild(cwdInput);

    const urlGroup = el('div', { className: 'mcp-editor-field' });
    urlGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '服务器 URL *（http / sse）' }));
    const urlInput = el('input', { className: 'mcp-editor-input', attrs: { type: 'text', placeholder: 'https://mcp.example.com/mcp' } });
    urlGroup.appendChild(urlInput);

    const envGroup = el('div', { className: 'mcp-editor-field' });
    envGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '环境变量（每行 KEY=VALUE）' }));
    const envArea = el('textarea', { className: 'mcp-editor-textarea', attrs: { rows: '3' } });
    envGroup.appendChild(envArea);

    const headersGroup = el('div', { className: 'mcp-editor-field' });
    headersGroup.appendChild(el('label', { className: 'mcp-editor-label', text: 'Headers（每行 KEY=VALUE，http / sse）' }));
    const headersArea = el('textarea', { className: 'mcp-editor-textarea', attrs: { rows: '3' } });
    headersGroup.appendChild(headersArea);

    const actions = el('div', { className: 'mcp-editor-actions' });
    const testBtn = el('button', { className: 'btn btn-ghost', attrs: { type: 'button' }, text: '测试连接' });
    const cancelBtn = el('button', { className: 'btn btn-ghost', attrs: { type: 'button' }, text: '取消' });
    const saveBtn = el('button', { className: 'btn btn-primary', attrs: { type: 'button' }, text: '保存' });
    actions.appendChild(testBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    form.appendChild(idGroup);
    form.appendChild(transportGroup);
    form.appendChild(commandGroup);
    form.appendChild(argsGroup);
    form.appendChild(cwdGroup);
    form.appendChild(urlGroup);
    form.appendChild(envGroup);
    form.appendChild(headersGroup);
    form.appendChild(actions);

    fields = {
      id: idInput,
      transport: transportSelect,
      command: commandInput,
      args: argsArea,
      cwd: cwdInput,
      env: envArea,
      url: urlInput,
      headers: headersArea,
    };

    transportSelect.addEventListener('change', syncTransportFields);
    cancelBtn.addEventListener('click', closeForm);
    saveBtn.addEventListener('click', () => { void saveServer(); });
    testBtn.addEventListener('click', () => { void testServer(); });
  }

  function syncTransportFields(): void {
    const f = fields;
    if (!f) return;
    const isStdio = f.transport.value === 'stdio';
    f.command.disabled = !isStdio;
    f.args.disabled = !isStdio;
    f.cwd.disabled = !isStdio;
    f.url.disabled = isStdio;
    f.headers.disabled = isStdio;
  }

  function collectConfig(): { id: string; config: McpServerConfigView } | null {
    const f = fields;
    if (!f) return null;
    const id = f.id.value.trim();
    if (!id) {
      setStatus('请填写服务器名称', 'err');
      return null;
    }
    const transport = f.transport.value as 'stdio' | 'http' | 'sse';
    const config: McpServerConfigView = { id, name: id, transport };
    if (transport === 'stdio') {
      const command = f.command.value.trim();
      if (!command) {
        setStatus('请填写启动命令', 'err');
        return null;
      }
      config.command = command;
      config.args = parseArgsLines(f.args.value);
      // cwd 是定稿契约里的字段：**必须回传**，否则编辑既有服务器会把 cwd 丢掉。
      const cwd = f.cwd.value.trim();
      if (cwd) config.cwd = cwd;
    } else {
      const url = f.url.value.trim();
      if (!url) {
        setStatus('请填写服务器 URL', 'err');
        return null;
      }
      config.url = url;
      config.headers = parseKeyValueLines(f.headers.value);
    }
    config.env = parseKeyValueLines(f.env.value);
    return { id, config };
  }

  async function saveServer(): Promise<void> {
    const collected = collectConfig();
    if (!collected) return;
    const isNew = editingId === null;
    const path = isNew
      ? MCP_SERVERS_ENDPOINT
      : `${MCP_SERVERS_ENDPOINT}/${encodeURIComponent(collected.id)}`;
    try {
      const r = await request(isNew ? 'POST' : 'PUT', path, { id: collected.id, config: collected.config });
      if (!r.ok) {
        setStatus(`保存失败（HTTP ${r.status}）`, 'err');
        return;
      }
      setStatus('已保存', 'ok');
      closeForm();
      await refresh();
    } catch (e) {
      setStatus(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  async function removeServer(id: string): Promise<void> {
    try {
      const r = await request('DELETE', `${MCP_SERVERS_ENDPOINT}/${encodeURIComponent(id)}`);
      if (!r.ok) {
        setStatus(`删除失败（HTTP ${r.status}）`, 'err');
        return;
      }
      setStatus('已删除', 'ok');
      await refresh();
    } catch (e) {
      setStatus(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  async function testServer(): Promise<void> {
    const collected = collectConfig();
    if (!collected) return;
    try {
      // PM 定的口径（2026-11-02）：**body 可选 `{ config }`** ——
      //   - 有 body ⇒ 测这份配置（用户「改了再测」是真实需求，不测就保存心里没底）
      //   - 无 body ⇒ 用已存配置
      // 这里总是带 body（测的正是表单里这份可能尚未保存的配置）。
      // `id` 已在 URL 路径里，body 不重复带。
      const r = await request('POST', `${MCP_SERVERS_ENDPOINT}/${encodeURIComponent(collected.id)}/test`, {
        config: collected.config,
      });
      setStatus(r.ok ? '连接成功' : `连接失败（HTTP ${r.status}）`, r.ok ? 'ok' : 'err');
    } catch (e) {
      setStatus(`连接失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  function openForm(cfg: McpServerConfigView | null): void {
    if (!fields) buildForm();
    const f = fields;
    if (!f) return;
    editingId = cfg?.id ?? cfg?.name ?? null;
    f.id.value = editingId ?? '';
    f.id.readOnly = editingId !== null;
    f.transport.value = cfg?.transport ?? 'stdio';
    f.command.value = cfg?.command ?? '';
    f.args.value = formatArgsLines(cfg?.args);
    f.cwd.value = cfg?.cwd ?? '';
    f.url.value = cfg?.url ?? '';
    f.env.value = formatKeyValueLines(cfg?.env);
    f.headers.value = formatKeyValueLines(cfg?.headers);
    syncTransportFields();
    form.style.display = 'flex';
    setStatus('');
  }

  function closeForm(): void {
    editingId = null;
    form.style.display = 'none';
    form.replaceChildren();
    fields = null;
  }

  return {
    refresh,
    setVisible(visible: boolean) {
      root.style.display = visible ? '' : 'none';
    },
  };
}
