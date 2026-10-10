// CDP 探查聊天页 DOM（临时，验证后删）
import WebSocket from 'ws';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('chat.deepseek.com'));
if (!page) { console.log('NO_CHAT_PAGE'); process.exit(1); }

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
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((r) => ws.on('open', r));

const expr = `(() => {
  const out = { inputs: [], buttons: [] };
  document.querySelectorAll('textarea, [contenteditable="true"]').forEach((el) => {
    out.inputs.push({
      tag: el.tagName,
      id: el.id || '',
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      placeholder: el.getAttribute('placeholder') || '',
      visible: el.offsetWidth > 0,
    });
  });
  document.querySelectorAll('button, [role="button"]').forEach((b) => {
    const svg = !!b.querySelector('svg');
    out.buttons.push({
      tag: b.tagName,
      aria: b.getAttribute('aria-label') || '',
      cls: (typeof b.className === 'string' ? b.className : (b.className && b.className.baseVal) || '').slice(0, 100),
      text: (b.textContent || '').trim().slice(0, 30),
      svg,
      disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
    });
  });
  out.buttons = out.buttons.filter((b) => b.svg || b.text).slice(0, 25);
  return JSON.stringify(out);
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r));
process.exit(0);
