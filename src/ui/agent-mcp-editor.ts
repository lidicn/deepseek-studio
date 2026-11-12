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

/**
 * `KEY=VALUE` 多行文本 ⇄ 记录。空行与 `#` 开头行忽略。
 *
 * 分隔符**同时接受 `=` 与 `:`**（2026-11-12 真机复现）：
 * - `Headers` 框按 HTTP 标准写法填的是 `Authorization: Bearer xxx`（冒号、**没有等号**），
 *   原实现只认 `=` ⇒ `indexOf('=') === -1` ⇒ `continue` ⇒ **整行被静默丢弃**，
 *   保存后 `headers` 恒为 `{}`，请求不带 Authorization，服务器回 403，而界面不报任何错。
 * - 取「两者中先出现的那个」而非固定优先级，保证 `URL=http://x`（等号在前）
 *   仍按等号切，不会被人肉 URL 里的冒号抢走。
 */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    if (eq < 0 && colon < 0) continue;
    const idx = eq < 0 ? colon : colon < 0 ? eq : Math.min(eq, colon);
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
  // P1 测试连接反馈（2026-11-06 卡）：宿主侧 test 无超时，目标不可达时请求可长期 in-flight，
  // 此前「点测试无任何反应」= 界面上没有任何加载态、也没有客户端兜底。
  // 客户端上限：N 秒必须给出可见反馈（loading 文案 → 超时提示，提示里写清该查什么）。
  // 放在 mountMcpEditor 闭包内（**不是模块级**）：同页挂两个编辑器实例不得互相串台。
  const MCP_TEST_TIMEOUT_MS = 15_000;
  let testBtnRef: HTMLButtonElement | null = null;

  function setStatus(text: string, tone: 'ok' | 'err' | '' = ''): void {
    status.textContent = text;
    status.className = `mcp-editor-status${tone ? ` is-${tone}` : ''}`;
  }

  async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ ok: boolean; status: number; data: unknown }> {
    const res = await fetch(`${origin}${path}`, {
      method,
      signal,
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

  /**
   * 从失败响应里取宿主给的 `error.message`（2026-11-12 真机复现）。
   *
   * 原实现失败只渲染 `连接失败（HTTP 400）`——**宿主已经写明原因**
   * （`src/api/server.ts:406-408` → `{error:{code:'mcp_test_failed',message:'fetch failed'}}`），
   * 前端却把 message 丢了。用户看到一串无信息量的状态码，只能猜是 URL 错、网络错还是配置错。
   */
  function errorDetailOf(data: unknown): string {
    const msg = (data as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof msg === 'string' && msg.trim().length > 0 ? msg.trim() : '';
  }

  function failureText(prefix: string, status: number, data: unknown): string {
    const detail = errorDetailOf(data);
    return detail ? `${prefix}：${detail}（HTTP ${status}）` : `${prefix}（HTTP ${status}）`;
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
    /** Headers 的**行容器**（名称/值成对，参考豆包「自定义连接器」）。 */
    headers: HTMLElement;
    /** 按传输类型显示的字段组（stdio 独占 / 远程独占）。 */
    groups: { stdio: HTMLElement[]; remote: HTMLElement[] };
  }
  let fields: McpEditorFields | null = null;
  /** Headers 行容器（`buildForm` 里建，`openForm` 回填时用）。 */
  let headersRows: HTMLElement | null = null;

  /**
   * 追加一行 Headers（名称 / 值 / 删除）。
   *
   * 2026-11-12 定稿：**不再用 `KEY=VALUE` 文本框**。原实现把结构化数据塞进
   * 一个文本框，靠 `parseKeyValueLines` 猜分隔符——用户按 HTTP 标准写
   * `Authorization: Bearer xxx` 时整行被 `continue` 静默丢弃（真机复现：
   * 保存后 `headers:{}`，请求不带 Authorization，服务器回 403，界面零报错）。
   * 只要「分隔符靠猜」这条路还在，就还有下一种写法能被吃掉；改成名称/值两栏，
   * 结构由 UI 表达，不再存在「解析失败」这个分支。
   */
  function addHeaderRow(key = '', value = ''): void {
    const rows = headersRows;
    if (!rows) return;
    const row = el('div', { className: 'mcp-editor-row' });
    const keyInput = el('input', {
      className: 'mcp-editor-input mcp-editor-row-key',
      attrs: { type: 'text', placeholder: 'Header 名称' },
    });
    keyInput.value = key;
    const valueInput = el('input', {
      className: 'mcp-editor-input mcp-editor-row-value',
      attrs: { type: 'text', placeholder: 'Header 值' },
    });
    valueInput.value = value;
    const removeBtn = el('button', {
      className: 'btn btn-ghost mcp-editor-row-remove',
      attrs: { type: 'button' },
      text: '删除',
    });
    removeBtn.addEventListener('click', () => {
      row.remove();
      // 全删完后留一行空的：否则表单上没有可填的位置，只能关掉重开。
      if (!rows.querySelector('.mcp-editor-row')) addHeaderRow();
    });
    row.appendChild(keyInput);
    row.appendChild(valueInput);
    row.appendChild(removeBtn);
    rows.appendChild(row);
  }

  /** 记录 → 行（无记录时留一行空的）。 */
  function setHeaderRows(record: Record<string, string> | undefined): void {
    const rows = headersRows;
    if (!rows) return;
    rows.replaceChildren();
    const entries = Object.entries(record ?? {});
    if (entries.length === 0) {
      addHeaderRow();
      return;
    }
    for (const [k, v] of entries) addHeaderRow(k, v);
  }

  /** 行 → 记录。名称留空的行整行跳过（用户没填名称，值无处安放）。 */
  function readHeaderRows(): Record<string, string> {
    const out: Record<string, string> = {};
    const rows = headersRows;
    if (!rows) return out;
    for (const row of Array.from(rows.querySelectorAll('.mcp-editor-row'))) {
      const keyInput = row.querySelector('.mcp-editor-row-key') as HTMLInputElement | null;
      const valueInput = row.querySelector('.mcp-editor-row-value') as HTMLInputElement | null;
      const k = (keyInput?.value ?? '').trim();
      if (!k) continue;
      out[k] = (valueInput?.value ?? '').trim();
    }
    return out;
  }

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
    const cwdInput = el('input', { className: 'mcp-editor-input', attrs: { type: 'text', placeholder: '如 /path/to/mcp-server（相对路径或本机的目录）' } });
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
    headersGroup.appendChild(el('label', { className: 'mcp-editor-label', text: '自定义 Headers' }));
    const headersRowsEl = el('div', { className: 'mcp-editor-rows', attrs: { id: 'mcp-editor-headers-rows' } });
    headersGroup.appendChild(headersRowsEl);
    const addHeaderBtn = el('button', {
      className: 'btn btn-ghost mcp-editor-add-row',
      attrs: { type: 'button', id: 'btn-mcp-add-header' },
      text: '添加',
    });
    addHeaderBtn.addEventListener('click', () => { addHeaderRow(); });
    headersGroup.appendChild(addHeaderBtn);

    const actions = el('div', { className: 'mcp-editor-actions' });
    const testBtn = el('button', { className: 'btn btn-ghost', attrs: { type: 'button' }, text: '测试连接' });
    testBtnRef = testBtn;
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
      headers: headersRowsEl,
      // stdio 独占：启动命令 / 参数 / 工作目录 / 环境变量
      // 远程独占：服务器 URL / 自定义 Headers
      groups: {
        stdio: [commandGroup, argsGroup, cwdGroup, envGroup],
        remote: [urlGroup, headersGroup],
      },
    };
    headersRows = headersRowsEl;
    addHeaderRow();

    transportSelect.addEventListener('change', syncTransportFields);
    cancelBtn.addEventListener('click', closeForm);
    saveBtn.addEventListener('click', () => { void saveServer(); });
    testBtn.addEventListener('click', () => { void testServer(); });
  }

  /**
   * 按传输类型**显示/隐藏**对应字段组（2026-11-12 参考豆包「自定义连接器」）。
   *
   * 原实现是 `disabled` 而不隐藏——HTTP 模式下「启动命令 *」「参数」「工作目录」
   * 仍留在界面上、标签还带必填星号，看图填表的人会以为 HTTP 也要命令行。
   */
  function syncTransportFields(): void {
    const f = fields;
    if (!f) return;
    const isStdio = f.transport.value === 'stdio';
    for (const group of f.groups.stdio) group.hidden = !isStdio;
    for (const group of f.groups.remote) group.hidden = isStdio;
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
      config.headers = readHeaderRows();
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
        setStatus(failureText('保存失败', r.status, r.data), 'err');
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

  async function testServer(timeoutMs: number = MCP_TEST_TIMEOUT_MS): Promise<void> {
    const collected = collectConfig();
    // 校验失败：collectConfig 已在每个分支 setStatus 可见报错，这里直接返回（非静默）。
    if (!collected) return;
    // P1（2026-11-06 卡）：加载态 + 客户端超时。宿主侧 test 对不可达目标可能长期 in-flight，
    // 此前点「测试连接」后界面无任何反应。现在：
    //   - 点击即把按钮置为「测试中…」并禁用（可见 loading 态）；
    //   - 到点（默认 15s）宿主仍未回包 → 给可见超时提示（写明该查 URL/网络/服务是否在听）；
    //   - 状态机单调：一旦已报超时，迟到的响应/abort 引起的 reject **都不再改写**，
    //     避免「超时提示」与「迟到成功提示」互相覆盖；
    //   - 无论超时还是正常完成，按钮都还原（存原 label，不硬写回文案）。
    // 单测注入小 `timeoutMs` + fake timer，不依赖真实 15s。
    const originalLabel = testBtnRef ? (testBtnRef.textContent ?? '') : '';
    let timedOut = false;
    if (testBtnRef) {
      testBtnRef.disabled = true;
      testBtnRef.textContent = '测试中…';
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      setStatus(`测试超时（${Math.round(timeoutMs / 1000)}s）：请检查服务器 URL、网络可达性，以及该地址上的服务是否在监听。`, 'err');
    }, timeoutMs);
    try {
      // PM 定的口径（2026-11-02）：**body 可选 `{ config }`** ——
      //   - 有 body ⇒ 测这份配置（用户「改了再测」是真实需求，不测就保存心里没底）
      //   - 无 body ⇒ 用已存配置
      // 这里总是带 body（测的正是表单里这份可能尚未保存的配置）。
      // `id` 已在 URL 路径里，body 不重复带。
      const r = await request('POST', `${MCP_SERVERS_ENDPOINT}/${encodeURIComponent(collected.id)}/test`, {
        config: collected.config,
      }, controller.signal);
      if (timedOut) return; // 已报超时：迟到响应不再改写状态机
      setStatus(r.ok ? '连接成功' : failureText('连接失败', r.status, r.data), r.ok ? 'ok' : 'err');
    } catch (e) {
      if (timedOut) return; // 已报超时：abort 引起的 reject 不再改写状态机
      setStatus(`连接失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      window.clearTimeout(timer);
      if (testBtnRef) {
        testBtnRef.disabled = false;
        testBtnRef.textContent = originalLabel;
      }
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
    setHeaderRows(cfg?.headers);
    syncTransportFields();
    form.style.display = 'flex';
    setStatus('');
  }

  function closeForm(): void {
    editingId = null;
    testBtnRef = null;
    headersRows = null;
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
