import WebSocket from 'ws';
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('chat.deepseek.com'));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((r) => ws.on('open', r));

const expr = `(() => {
  const out = {};
  // 现有 chat-read 选择器命中情况
  out.currentSelectors = {};
  for (const sel of ['[class*="message-item"]', '[class*="chat-message"]', '#chat-messages > *', '.message']) {
    out.currentSelectors[sel] = document.querySelectorAll(sel).length;
  }
  // 找「消息列表」容器：class 含 message / chat / conversation 的容器
  const candidates = new Map();
  document.querySelectorAll('[class*="message"],[class*="chat-"],[class*="conversation"]').forEach((el) => {
    const cls = String(el.className);
    const key = el.tagName + '|' + cls.slice(0, 60);
    candidates.set(key, (candidates.get(key) || 0) + 1);
  });
  out.containers = [...candidates.entries()].slice(0, 20).map(([k, n]) => ({ key: k, count: n }));
  // markdown 内容块（模型回复的典型容器）
  out.markdown = document.querySelectorAll('[class*="markdown"]').length;
  const md = document.querySelector('[class*="markdown"]');
  if (md) {
    out.mdSample = { cls: String(md.className).slice(0, 80), parentCls: String(md.parentElement.className).slice(0, 80) };
  }
  // 页面里角色特征：ds-markdown--block 等
  out.dsMarkdownBlock = document.querySelectorAll('.ds-markdown--block').length;
  return JSON.stringify(out);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r));
process.exit(0);
