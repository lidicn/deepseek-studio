/**
 * tool-card-dom.ts — 对话内工具结果渲染层
 *
 * 扫描助手消息里的原始工具标签/结果文本，替换成折叠卡片：
 *   - <tool_name>{...}</tool_name> → 折叠卡片：🔧 tool_name · 参数摘要
 *   - 【工具执行结果】... → 折叠卡片：📋 工具结果
 *   - <mcp_call>...</mcp_call> → 折叠卡片：🔌 MCP 调用
 */

const TOOL_CARD_STYLE_ID = 'ds-studio-tool-card-css';

function injectToolCardStyles(): void {
  if (document.getElementById(TOOL_CARD_STYLE_ID)) return;
  if (!document.head) { setTimeout(injectToolCardStyles, 50); return; }
  const style = document.createElement('style');
  style.id = TOOL_CARD_STYLE_ID;
  style.textContent = `
    .ds-tc-card { margin: 6px 0; border: 1px solid #e5e6eb; border-radius: 8px; overflow: hidden; }
    .ds-tc-toggle { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 13px; background: #f7f8fa; border: none; cursor: pointer; width: 100%; text-align: left; color: #1f2329; }
    .ds-tc-icon { flex: none; width: 14px; height: 14px; }
    .ds-tc-name { flex: none; font-weight: 500; }
    .ds-tc-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8f959e; font-size: 12px; }
    .ds-tc-chevron { flex: none; width: 12px; height: 12px; color: #8f959e; transition: transform .15s; }
    .ds-tc-card[data-expanded="true"] .ds-tc-chevron { transform: rotate(90deg); }
    .ds-tc-detail { display: none; padding: 8px 12px; font-size: 12px; line-height: 1.5; color: #646a73; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; border-top: 1px solid #e5e6eb; }
    .ds-tc-card[data-expanded="true"] .ds-tc-detail { display: block; }
  `;
  document.head.appendChild(style);
}

/** 创建一个工具卡片 */
function createToolCard(icon: string, name: string, summary: string, detail: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ds-tc-card';
  card.setAttribute('data-expanded', 'false');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ds-tc-toggle';

  const iconEl = document.createElement('span');
  iconEl.className = 'ds-tc-icon';
  iconEl.textContent = icon;

  const nameEl = document.createElement('span');
  nameEl.className = 'ds-tc-name';
  nameEl.textContent = name;

  const summaryEl = document.createElement('span');
  summaryEl.className = 'ds-tc-summary';
  summaryEl.textContent = summary;

  const chevron = document.createElement('span');
  chevron.className = 'ds-tc-chevron';
  chevron.textContent = '▸';

  toggle.appendChild(iconEl);
  toggle.appendChild(nameEl);
  toggle.appendChild(summaryEl);
  toggle.appendChild(chevron);

  const detailEl = document.createElement('div');
  detailEl.className = 'ds-tc-detail';
  detailEl.textContent = detail;

  toggle.addEventListener('click', () => {
    const expanded = card.getAttribute('data-expanded') === 'true';
    card.setAttribute('data-expanded', expanded ? 'false' : 'true');
  });

  card.appendChild(toggle);
  card.appendChild(detailEl);
  return card;
}

/** 处理一个文本节点，把工具标签替换成卡片 */
function processTextNode(textNode: Text): boolean {
  const text = textNode.textContent ?? '';
  if (!text) return false;

  // 匹配 <tool_name>{json}</tool_name>
  const toolCallRe = /<([a-z_][a-z0-9_]*)\s*>\s*(\{[\s\S]*?\})\s*<\/\1>/g;
  // 匹配 【工具执行结果】...
  const resultRe = /【工具执行结果】[\s\S]*?(?=<[a-z_]|$|【工具执行结果】)/g;
  // 匹配 <mcp_call>...</mcp_call>
  const mcpRe = /<mcp_call>([\s\S]*?)<\/mcp_call>/g;

  let matched = false;
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  // 先处理 tool call
  toolCallRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = toolCallRe.exec(text)) !== null) {
    if (m.index > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
    const toolName = m[1];
    const params = m[2];
    let summary = '';
    try {
      const parsed = JSON.parse(params);
      summary = Object.entries(parsed).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(' ').slice(0, 80);
    } catch { summary = params.slice(0, 60); }
    fragment.appendChild(createToolCard('🔧', toolName, summary, m[0]));
    lastIndex = m.index + m[0].length;
    matched = true;
  }

  if (!matched) {
    // 再试 mcp_call
    mcpRe.lastIndex = 0;
    while ((m = mcpRe.exec(text)) !== null) {
      if (m.index > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
      fragment.appendChild(createToolCard('🔌', 'mcp_call', '', m[0]));
      lastIndex = m.index + m[0].length;
      matched = true;
    }
  }

  if (!matched) {
    // 再试 工具执行结果
    resultRe.lastIndex = 0;
    while ((m = resultRe.exec(text)) !== null) {
      if (m.index > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
      fragment.appendChild(createToolCard('📋', '工具结果', m[0].slice(0, 100), m[0]));
      lastIndex = m.index + m[0].length;
      matched = true;
    }
  }

  if (!matched) return false;

  if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  textNode.parentNode?.replaceChild(fragment, textNode);
  return true;
}

/** 扫描一个容器，处理所有文本节点 */
function scanContainer(root: ParentNode): number {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toProcess: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const t = node as Text;
    const parent = t.parentElement;
    if (!parent) continue;
    // 跳过已经处理过的
    if (parent.closest('.ds-tc-card') || parent.closest('.ds-sf-container')) continue;
    const text = t.textContent ?? '';
    if (text.includes('<local_file_') || text.includes('<shell_exec') || text.includes('<mcp_call') || text.includes('【工具执行结果】')) {
      toProcess.push(t);
    }
  }
  for (const t of toProcess) {
    if (processTextNode(t)) count++;
  }
  return count;
}

let observer: MutationObserver | null = null;

export function startToolCardObserver(): void {
  injectToolCardStyles();
  if (observer) return;

  // 初始扫描
  const scan = () => {
    const containers = document.querySelectorAll('.ds-markdown, [class*="assistant-message"], [class*="message-content"]');
    containers.forEach((c) => scanContainer(c));
  };

  scan();
  observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  console.log('[tool-card] observer started');
}

export function stopToolCardObserver(): void {
  observer?.disconnect();
  observer = null;
}
