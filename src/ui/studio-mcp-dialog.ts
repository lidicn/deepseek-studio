/**
 * StudioUI MCP 服务器配置弹窗 —— **只读版**（v1.1）
 *
 * ── 为什么变成只读 ──
 *
 * 原实现是可写表单：读 `mcp.get` → 回填 → `mcp.save` 写回。
 * 但 MCP 配置里装着**凭据**（`env` / `headers` 的值、`url` 里的 userinfo、
 * `args` 里的 `--token xxx`），而这个弹窗跑在 **DeepSeek 页面内** ——
 * 与模型拦截器**同一个 `globalThis`**（Core 核实：UI 面板与模型拦截器同 bundle、
 * 同 main world、同 host 实例）。→ 页面里的任何写路径，都是模型够得着的路径。
 *
 * PM 裁定（2026-11-02，(B) 方案）：**明文密钥不过页面**。
 * 页面内面板一律只读：只显示**宿主侧已掩码**的值，
 * 写操作全部集中到**工作台**（独立 origin `127.0.0.1:8760`，独立 webview 窗口，
 * 模型读不到；`/agent` HTML 由服务端把 `__STUDIO_TOKEN__` 替换成真令牌）。
 *
 * 现状事实（宿主侧已做，不需要 UI 重复掩码）：
 *   - `mcp.list` → `toMcpServerSummary()`：url 的 userinfo/凭据形参值、args 的
 *     凭据形参值**已掩码**（F11）；command / transport / 名字**保留**。
 *   - `mcp.get`  → `maskMcpServerSecrets()`：`env` / `headers` 的**值 = `****`**，
 *     键名保留（R2-02）。
 * 所以本弹窗拿到的**本来就全是掩码值**；只读化要做的是**堵住「拿 `****` 也能写回」**
 * 这条口子（原先表单可编辑 → 用户点保存 → `mergeMaskedSecrets` 兜底，
 * 但那是宿主侧补丁，UI 侧不该留这条路）。
 *
 * 纪律：
 *   - 本文件**不 import** `callHostTool` 的写类调用，只保留 `mcp.get`（读掩码值）。
 *   - 「去工作台编辑」按钮走 `openMcpSettings`（卡 C 主路径）：
 *     读 `window.__studioOpenMcpSettings`（Core Rust 注入，调 `studio_open_mcp_settings`，
 *     开 `/mcp-settings` 独立 webview 窗）；未注入时**回落既有**工作台入口
 *     `window.__studioOpenWorkbench`（`src/desktop/entry.ts` 注入，UI 域，只调不改），
 *     明文仍只在工作台可见，**不新开任何凭据面**。
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, callHostTool, openMcpSettings } from './studio-ui-core';

interface ReadonlyMcpConfig {
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const dialogStyles = `
  .studio-mcp-dialog { width: 560px; }
  .studio-mcp-readonly-note {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 10px 12px; border-radius: 6px; font-size: 12px; line-height: 1.6;
    background: #f4f6fb; color: #4a5573; margin-bottom: 14px;
  }
  .studio-mcp-readonly-fields { display: flex; flex-direction: column; gap: 12px; }
  .studio-mcp-ro-field { display: flex; flex-direction: column; gap: 4px; }
  .studio-mcp-ro-label { font-size: 12px; color: #8a93a8; }
  .studio-mcp-ro-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.7; color: #1a1a2e;
    background: #f7f8fc; border: 1px solid #e6e9f2; border-radius: 6px;
    padding: 8px 10px; white-space: pre-wrap; word-break: break-all;
  }
  .studio-mcp-ro-value.is-empty { color: #aab; font-style: italic; }
  .studio-mcp-ro-mask { color: #8a93a8; }
`;

/**
 * MCP 配置**只读**弹窗。
 *
 * 签名与 v1.0 保持一致（两个挂载点 `studio-settings-entry.ts` 与
 * `studio-ui-install.ts` 不用改）—— 但 `open()` 内部**不再有任何写路径**。
 */
export function createMcpConfigDialog(): { container: HTMLElement; open: (serverId?: string) => void; close: () => void } {
  const { container, shadow } = createShadowContainer('studio-mcp-dialog-root');
  injectStyles(shadow, dialogStyles);

  let editingServerId: string | null = null;

  const overlay = el('div', { className: 'studio-modal-overlay', style: { display: 'none' } });
  const modal = el('div', { className: 'studio-modal studio-mcp-dialog' });

  // Header
  const header = el('div', { className: 'studio-modal-header' }, [
    el('h2', { className: 'studio-modal-title', text: 'MCP 服务器（只读）' }),
  ]);
  const closeBtn = el('button', { className: 'studio-close-btn' }, [icon(Icons.x, 18)]);
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body
  const body = el('div', { className: 'studio-modal-body' });

  const note = el('div', { className: 'studio-mcp-readonly-note' }, [
    icon(Icons.puzzle, 14),
    el('span', {
      text: '出于安全考虑，MCP 配置的明文（命令、参数、环境变量、URL、Headers）不在聊天页面内显示或编辑。请到工作台中查看与修改。',
    }),
  ]);
  body.appendChild(note);

  const fields = el('div', { className: 'studio-mcp-readonly-fields' });
  body.appendChild(fields);

  modal.appendChild(body);

  // Footer：只留「去工作台编辑」+「关闭」。**没有保存 / 测试连接 / 删除。**
  const footer = el('div', { className: 'studio-modal-footer' });
  const workbenchBtn = el('button', { className: 'studio-btn primary' }, [
    icon(Icons.settings, 14),
    el('span', { text: '去工作台编辑' }),
  ]);
  workbenchBtn.addEventListener('click', () => {
    openMcpSettings();
    close();
  });
  const cancelBtn = el('button', { className: 'studio-btn', text: '关闭' });
  cancelBtn.addEventListener('click', close);
  footer.appendChild(workbenchBtn);
  footer.appendChild(cancelBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  shadow.appendChild(overlay);

  /** 只读字段行：标签 + 等宽值（空值显示占位）。 */
  function roField(label: string, value: string | undefined, opts?: { masked?: boolean }): HTMLElement {
    const group = el('div', { className: 'studio-mcp-ro-field' });
    group.appendChild(el('div', { className: 'studio-mcp-ro-label', text: label }));
    const empty = !value;
    const box = el('div', {
      className: empty ? 'studio-mcp-ro-value is-empty' : 'studio-mcp-ro-value',
      text: empty ? '（未设置）' : (value as string),
    });
    if (opts?.masked && !empty) {
      // 值是宿主侧掩码后的占位（`****`）—— 明确标出来，别让人以为是真值。
      box.classList.add('studio-mcp-ro-mask');
    }
    group.appendChild(box);
    return group;
  }

  /** 键值对表（env / headers）：只显示**键名**与掩码后的值。 */
  function roRecordField(label: string, record: Record<string, string> | undefined): HTMLElement {
    const keys = record ? Object.keys(record) : [];
    const text = keys.length
      ? keys.map((k) => `${k} = ${record?.[k] ?? ''}`).join('\n')
      : '';
    return roField(label, text, { masked: keys.length > 0 });
  }

  function renderFields(config: ReadonlyMcpConfig | null, serverId: string | null): void {
    fields.replaceChildren();
    if (!serverId) {
      // 「添加」在页面内不可用（写操作）→ 只给工作台入口。
      fields.appendChild(roField('提示', '请到工作台中添加或修改 MCP 服务器。'));
      return;
    }
    fields.appendChild(roField('服务器名称', serverId));
    if (!config) {
      fields.appendChild(roField('状态', '（读取配置失败）'));
      return;
    }
    fields.appendChild(roField('传输类型', (config.transport ?? 'stdio').toUpperCase()));
    if (config.transport === 'http' || config.transport === 'sse') {
      fields.appendChild(roField('服务器 URL', config.url));
      fields.appendChild(roRecordField('自定义 Headers', config.headers));
    } else {
      fields.appendChild(roField('启动命令', config.command));
      fields.appendChild(roField('参数', (config.args ?? []).join('\n')));
    }
    fields.appendChild(roRecordField('环境变量', config.env));
  }

  async function loadReadonly(serverId: string): Promise<void> {
    try {
      const r = await callHostTool('mcp.get', { serverId });
      if (!r.ok || !r.data) {
        renderFields(null, serverId);
        return;
      }
      const cfg = (r.data as { config?: ReadonlyMcpConfig }).config;
      renderFields(cfg ?? null, serverId);
    } catch (e) {
      console.warn('[StudioUI] load MCP config failed:', e instanceof Error ? e.message : String(e));
      renderFields(null, serverId);
    }
  }

  function open(serverId?: string): void {
    editingServerId = serverId ?? null;
    header.querySelector('.studio-modal-title')!.textContent = serverId
      ? `MCP 服务器（只读）· ${serverId}`
      : 'MCP 服务器（只读）';
    overlay.style.display = 'flex';
    renderFields(null, editingServerId);
    if (serverId) void loadReadonly(serverId);
  }

  function close(): void {
    overlay.style.display = 'none';
    editingServerId = null;
  }

  // 事件入口只有一条：查看（只读）。
  //
  // 原来还有 `ui:mcp-add` / `ui:mcp-edit` 两条 —— 只读化后**没有任何 emit 点**
  // （页面的写操作全搬到工作台）。留着监听 = 留死路径（PM 2026-11-02 纪律：
  // 不制造死代码），所以这里只保留 `ui:mcp-view`。
  globalEvents.on('ui:mcp-view', (payload) => open(payload as string));

  return { container, open, close };
}
