/**
 * StudioUI MCP 服务器配置弹窗（v1.0）
 *
 * 参考豆包工作 MCP 连接器配置界面：
 * - 服务器名称
 * - 传输类型（stdio / HTTP / SSE）
 * - 启动命令 / 服务器 URL
 * - 参数（动态添加/删除行）
 * - 环境变量（动态添加/删除行）
 * - 自定义 Headers（动态添加/删除行）
 * - 测试连接按钮
 * - 保存/取消
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState, callHostTool } from './studio-ui-core';

const dialogStyles = `
  .studio-mcp-dialog { width: 560px; }
  .studio-mcp-form { display: flex; flex-direction: column; gap: 16px; }
  .studio-mcp-row { display: flex; gap: 12px; }
  .studio-mcp-row .studio-form-group { flex: 1; }
  .studio-kv-list { display: flex; flex-direction: column; gap: 6px; }
  .studio-kv-row { display: flex; gap: 8px; align-items: center; }
  .studio-kv-row .studio-input { flex: 1; }
  .studio-kv-remove {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    border: 1px solid #e0e0e0; border-radius: 4px; background: #fff; cursor: pointer;
    color: #999; flex-shrink: 0; transition: all 0.15s;
  }
  .studio-kv-remove:hover { color: #e53935; border-color: #ffcdd2; background: #ffebee; }
  .studio-kv-add {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px;
    border: 1px dashed #d0d0d0; border-radius: 6px; background: transparent;
    cursor: pointer; color: #888; font-size: 12px; transition: all 0.15s;
  }
  .studio-kv-add:hover { border-color: #4D6BFE; color: #4D6BFE; }
  .studio-mcp-test-result {
    padding: 10px 12px; border-radius: 6px; font-size: 12px; margin-top: 8px;
    display: none;
  }
  .studio-mcp-test-result.success { display: block; background: #e8f5e9; color: #2e7d32; }
  .studio-mcp-test-result.error { display: block; background: #ffebee; color: #c62828; }
  .studio-mcp-test-result.loading { display: block; background: #e3f2fd; color: #1565c0; }
`;

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export function createMcpConfigDialog(): { container: HTMLElement; open: (serverId?: string) => void; close: () => void } {
  const { container, shadow } = createShadowContainer('studio-mcp-dialog-root');
  injectStyles(shadow, dialogStyles);

  let editingServerId: string | null = null;
  let transportType: 'stdio' | 'http' | 'sse' = 'stdio';

  const overlay = el('div', { className: 'studio-modal-overlay', style: { display: 'none' } });
  const modal = el('div', { className: 'studio-modal studio-mcp-dialog' });

  // Header
  const header = el('div', { className: 'studio-modal-header' }, [
    el('h2', { className: 'studio-modal-title', text: '添加 MCP 服务器' }),
  ]);
  const closeBtn = el('button', { className: 'studio-close-btn' }, [icon(Icons.x, 18)]);
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body
  const body = el('div', { className: 'studio-modal-body' });
  const form = el('div', { className: 'studio-mcp-form' });

  // 服务器名称
  const nameGroup = el('div', { className: 'studio-form-group' });
  nameGroup.appendChild(el('label', { className: 'studio-form-label', text: '服务器名称 *' }));
  const nameInput = el('input', { className: 'studio-input', attrs: { placeholder: '如：filesystem、github' } });
  nameGroup.appendChild(nameInput);
  form.appendChild(nameGroup);

  // 传输类型
  const transportGroup = el('div', { className: 'studio-form-group' });
  transportGroup.appendChild(el('label', { className: 'studio-form-label', text: '传输类型' }));
  const transportSelect = el('select', { className: 'studio-input' });
  for (const [value, label] of [['stdio', 'stdio（本地进程）'], ['http', 'HTTP'], ['sse', 'SSE']] as const) {
    const option = el('option', { attrs: { value }, text: label });
    transportSelect.appendChild(option);
  }
  transportSelect.addEventListener('change', () => {
    transportType = (transportSelect as HTMLSelectElement).value as 'stdio' | 'http' | 'sse';
    updateTransportFields();
  });
  transportGroup.appendChild(transportSelect);
  form.appendChild(transportGroup);

  // stdio 字段：命令 + 参数
  const stdioFields = el('div', { style: { display: 'block' } });
  const cmdGroup = el('div', { className: 'studio-form-group' });
  cmdGroup.appendChild(el('label', { className: 'studio-form-label', text: '启动命令 *' }));
  const cmdInput = el('input', { className: 'studio-input', attrs: { placeholder: '如：npx、python、uvx' } });
  cmdGroup.appendChild(cmdInput);
  stdioFields.appendChild(cmdGroup);

  const argsGroup = el('div', { className: 'studio-form-group' });
  argsGroup.appendChild(el('label', { className: 'studio-form-label', text: '参数' }));
  const argsList = el('div', { className: 'studio-kv-list' });
  const addArgBtn = el('button', { className: 'studio-kv-add' }, [icon(Icons.plus, 12), el('span', { text: '添加参数' })]);
  addArgBtn.addEventListener('click', () => addKvRow(argsList, '参数值'));
  argsGroup.appendChild(argsList);
  argsGroup.appendChild(addArgBtn);
  stdioFields.appendChild(argsGroup);
  form.appendChild(stdioFields);

  // http/sse 字段：URL
  const httpFields = el('div', { style: { display: 'none' } });
  const urlGroup = el('div', { className: 'studio-form-group' });
  urlGroup.appendChild(el('label', { className: 'studio-form-label', text: '服务器 URL *' }));
  const urlInput = el('input', { className: 'studio-input', attrs: { placeholder: 'https://mcp.example.com/mcp' } });
  urlGroup.appendChild(urlInput);
  httpFields.appendChild(urlGroup);
  form.appendChild(httpFields);

  // 环境变量
  const envGroup = el('div', { className: 'studio-form-group' });
  envGroup.appendChild(el('label', { className: 'studio-form-label', text: '环境变量' }));
  const envList = el('div', { className: 'studio-kv-list' });
  const addEnvBtn = el('button', { className: 'studio-kv-add' }, [icon(Icons.plus, 12), el('span', { text: '添加环境变量' })]);
  addEnvBtn.addEventListener('click', () => addKvPairRow(envList, '变量名', '变量值'));
  envGroup.appendChild(envList);
  envGroup.appendChild(addEnvBtn);
  form.appendChild(envGroup);

  // 自定义 Headers（仅 http/sse）
  const headersGroup = el('div', { className: 'studio-form-group', style: { display: 'none' } });
  headersGroup.appendChild(el('label', { className: 'studio-form-label', text: '自定义 Headers' }));
  const headersList = el('div', { className: 'studio-kv-list' });
  const addHeaderBtn = el('button', { className: 'studio-kv-add' }, [icon(Icons.plus, 12), el('span', { text: '添加 Header' })]);
  addHeaderBtn.addEventListener('click', () => addKvPairRow(headersList, 'Header 名', 'Header 值'));
  headersGroup.appendChild(headersList);
  headersGroup.appendChild(addHeaderBtn);
  form.appendChild(headersGroup);

  // 测试连接结果
  const testResult = el('div', { className: 'studio-mcp-test-result' });
  form.appendChild(testResult);

  body.appendChild(form);
  modal.appendChild(body);

  // Footer
  const footer = el('div', { className: 'studio-modal-footer' });
  const testBtn = el('button', { className: 'studio-btn', text: '测试连接' });
  testBtn.addEventListener('click', testConnection);
  const cancelBtn = el('button', { className: 'studio-btn', text: '取消' });
  cancelBtn.addEventListener('click', close);
  const saveBtn = el('button', { className: 'studio-btn primary', text: '保存' });
  saveBtn.addEventListener('click', saveConfig);
  footer.appendChild(testBtn);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  shadow.appendChild(overlay);

  function addKvRow(container: HTMLElement, placeholder: string): void {
    const row = el('div', { className: 'studio-kv-row' });
    const input = el('input', { className: 'studio-input', attrs: { placeholder } });
    const removeBtn = el('button', { className: 'studio-kv-remove' }, [icon(Icons.x, 12)]);
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(input);
    row.appendChild(removeBtn);
    container.appendChild(row);
  }

  function addKvPairRow(container: HTMLElement, placeholder1: string, placeholder2: string): void {
    const row = el('div', { className: 'studio-kv-row' });
    const input1 = el('input', { className: 'studio-input', attrs: { placeholder: placeholder1 } });
    const input2 = el('input', { className: 'studio-input', attrs: { placeholder: placeholder2 } });
    const removeBtn = el('button', { className: 'studio-kv-remove' }, [icon(Icons.x, 12)]);
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(input1);
    row.appendChild(input2);
    row.appendChild(removeBtn);
    container.appendChild(row);
  }

  function updateTransportFields(): void {
    const isStdio = transportType === 'stdio';
    stdioFields.style.display = isStdio ? 'block' : 'none';
    httpFields.style.display = isStdio ? 'none' : 'block';
    headersGroup.style.display = isStdio ? 'none' : 'block';
  }

  function collectConfig(): McpServerConfig | null {
    const name = (nameInput as HTMLInputElement).value.trim();
    if (!name) {
      testResult.className = 'studio-mcp-test-result error';
      testResult.textContent = '请输入服务器名称';
      return null;
    }
    const config: McpServerConfig = { name, transport: transportType };
    if (transportType === 'stdio') {
      const command = (cmdInput as HTMLInputElement).value.trim();
      if (!command) {
        testResult.className = 'studio-mcp-test-result error';
        testResult.textContent = '请输入启动命令';
        return null;
      }
      config.command = command;
      const args: string[] = [];
      argsList.querySelectorAll('input').forEach((input) => {
        const val = (input as HTMLInputElement).value.trim();
        if (val) args.push(val);
      });
      config.args = args;
    } else {
      const url = (urlInput as HTMLInputElement).value.trim();
      if (!url) {
        testResult.className = 'studio-mcp-test-result error';
        testResult.textContent = '请输入服务器 URL';
        return null;
      }
      config.url = url;
      const headers: Record<string, string> = {};
      headersList.querySelectorAll('.studio-kv-row').forEach((row) => {
        const inputs = row.querySelectorAll('input');
        const key = (inputs[0] as HTMLInputElement).value.trim();
        const val = (inputs[1] as HTMLInputElement).value.trim();
        if (key) headers[key] = val;
      });
      config.headers = headers;
    }
    const env: Record<string, string> = {};
    envList.querySelectorAll('.studio-kv-row').forEach((row) => {
      const inputs = row.querySelectorAll('input');
      const key = (inputs[0] as HTMLInputElement).value.trim();
      const val = (inputs[1] as HTMLInputElement).value.trim();
      if (key) env[key] = val;
    });
    config.env = env;
    return config;
  }

  async function testConnection(): Promise<void> {
    const config = collectConfig();
    if (!config) return;
    testResult.className = 'studio-mcp-test-result loading';
    testResult.textContent = '正在测试连接...';
    try {
      const result = await callHostTool('mcp.test', { config });
      if (result.ok) {
        testResult.className = 'studio-mcp-test-result success';
        testResult.textContent = '连接成功！';
      } else {
        testResult.className = 'studio-mcp-test-result error';
        testResult.textContent = `连接失败：${result.error ?? '未知错误'}`;
      }
    } catch (e) {
      testResult.className = 'studio-mcp-test-result error';
      testResult.textContent = `连接失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function saveConfig(): Promise<void> {
    const config = collectConfig();
    if (!config) return;
    try {
      const result = await callHostTool('mcp.save', { serverId: editingServerId ?? config.name, config });
      if (result.ok) {
        if (!globalState.mcpServers.includes(config.name)) {
          globalState.mcpServers.push(config.name);
        }
        globalEvents.emit('ui:mcp-saved', config);
        close();
      } else {
        testResult.className = 'studio-mcp-test-result error';
        testResult.textContent = `保存失败：${result.error ?? '未知错误'}`;
      }
    } catch (e) {
      testResult.className = 'studio-mcp-test-result error';
      testResult.textContent = `保存失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function resetForm(serverId?: string): void {
    (nameInput as HTMLInputElement).value = serverId ?? '';
    (cmdInput as HTMLInputElement).value = '';
    (urlInput as HTMLInputElement).value = '';
    argsList.replaceChildren();
    envList.replaceChildren();
    headersList.replaceChildren();
    transportType = 'stdio';
    (transportSelect as HTMLSelectElement).value = 'stdio';
    updateTransportFields();
  }

  /** 用宿主回传的配置回填表单（编辑已有服务器时）。 */
  function fillForm(config: {
    transport?: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }): void {
    transportType = config.transport ?? 'stdio';
    (transportSelect as HTMLSelectElement).value = transportType;
    (cmdInput as HTMLInputElement).value = config.command ?? '';
    (urlInput as HTMLInputElement).value = config.url ?? '';
    for (const a of config.args ?? []) {
      addKvRow(argsList, '参数值');
      const inputs = argsList.querySelectorAll('input');
      (inputs[inputs.length - 1] as HTMLInputElement).value = a;
    }
    for (const [k, v] of Object.entries(config.env ?? {})) {
      addKvPairRow(envList, '变量名', '变量值');
      const rows = envList.querySelectorAll('.studio-kv-row');
      const inputs = rows[rows.length - 1].querySelectorAll('input');
      (inputs[0] as HTMLInputElement).value = k;
      (inputs[1] as HTMLInputElement).value = v;
    }
    for (const [k, v] of Object.entries(config.headers ?? {})) {
      addKvPairRow(headersList, 'Header 名', 'Header 值');
      const rows = headersList.querySelectorAll('.studio-kv-row');
      const inputs = rows[rows.length - 1].querySelectorAll('input');
      (inputs[0] as HTMLInputElement).value = k;
      (inputs[1] as HTMLInputElement).value = v;
    }
    updateTransportFields();
  }

  function open(serverId?: string): void {
    editingServerId = serverId ?? null;
    header.querySelector('.studio-modal-title')!.textContent = serverId ? '编辑 MCP 服务器' : '添加 MCP 服务器';
    overlay.style.display = 'flex';
    testResult.className = 'studio-mcp-test-result';
    testResult.textContent = '';
    resetForm(serverId);
    // 编辑已有服务器：从宿主读回真实配置。
    // 原实现无条件把表单重置成 stdio，于是「存的是 HTTP，再打开变成 stdio」。
    if (serverId) void loadExisting(serverId);
  }

  async function loadExisting(serverId: string): Promise<void> {
    try {
      const r = await callHostTool('mcp.get', { serverId });
      if (!r.ok || !r.data) {
        testResult.className = 'studio-mcp-test-result error';
        testResult.textContent = `读取配置失败：${r.error ?? '未知错误'}`;
        return;
      }
      const cfg = (r.data as { config?: Parameters<typeof fillForm>[0] }).config;
      if (cfg) fillForm(cfg);
    } catch (e) {
      testResult.className = 'studio-mcp-test-result error';
      testResult.textContent = `读取配置失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function close(): void {
    overlay.style.display = 'none';
  }

  globalEvents.on('ui:mcp-add', () => open());
  globalEvents.on('ui:mcp-edit', (payload) => open(payload as string));

  return { container, open, close };
}
