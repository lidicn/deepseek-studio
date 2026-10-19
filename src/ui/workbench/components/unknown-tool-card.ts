/**
 * UnknownToolCard：未知/未识别工具的兜底卡片，保证 switch 不崩溃、不白屏。
 * 不臆造工具能力，只展示工具名与未知说明。
 */

export function renderUnknownTool(tool: string | undefined | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wb-tool-card wb-tool-unknown';
  el.setAttribute('data-unknown-tool', 'true');
  const name = document.createElement('div');
  name.className = 'wb-tool-name';
  name.textContent = tool ? `未识别工具：${tool}` : '未识别工具';
  const hint = document.createElement('div');
  hint.className = 'wb-tool-hint';
  hint.textContent = '该工具没有对应的展示卡片，已原样记录。';
  el.appendChild(name);
  el.appendChild(hint);
  return el;
}
