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
  const out = { sendNamed: [], composerTree: [] };
  // 1) class 里含 send 的元素
  document.querySelectorAll('[class*="send" i]').forEach((el) => {
    out.sendNamed.push({ tag: el.tagName, cls: String(el.className).slice(0, 90) });
  });
  // 2) textarea 的祖先容器里找 ds-button
  const ta = document.querySelector('textarea[placeholder*="DeepSeek"]');
  if (ta) {
    let p = ta;
    for (let i = 0; i < 6 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      const btns = [];
      p.querySelectorAll('.ds-button, [role="button"]').forEach((b) => {
        btns.push({
          primary: String(b.className).includes('Primary'),
          xs: String(b.className).includes('--xs'),
          svg: !!b.querySelector('svg'),
          cls: String(b.className).slice(0, 110),
        });
      });
      out.composerTree.push({
        depth: i + 1,
        tag: p.tagName,
        cls: String(p.className).slice(0, 90),
        buttonCount: btns.length,
        btns: btns.slice(0, 6),
      });
    }
  }
  return JSON.stringify(out);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r));
process.exit(0);
