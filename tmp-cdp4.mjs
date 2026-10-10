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

// 1) React 兼容地写入 textarea
const setExpr = `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'NO_TA';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'hi');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  // 2) 点圆形发送按钮
  let p = ta, btn = null;
  for (let i = 0; i < 6 && p && !btn; i++) {
    p = p.parentElement;
    if (!p) break;
    btn = p.querySelector('div.ds-button--circle');
  }
  if (!btn) btn = document.querySelector('div.ds-button--circle');
  if (!btn) return 'NO_BUTTON';
  btn.click();
  return 'CLICKED ' + String(btn.className).slice(0, 60);
})()`;
let r = await send('Runtime.evaluate', { expression: setExpr, returnByValue: true });
console.log('SEND_STEP:', r.result?.result?.value);

// 3) 等 8 秒让消息与回复出现，抓消息 DOM 结构
await new Promise((res) => setTimeout(res, 8000));
const dumpExpr = `(() => {
  const out = { markdownAll: document.querySelectorAll('[class*="markdown"]').length, blocks: [] };
  document.querySelectorAll('.ds-markdown, [class*="markdown"]').forEach((el) => {
    out.blocks.push({ cls: String(el.className).slice(0, 100), text: (el.textContent || '').slice(0, 50) });
  });
  // 用户消息气泡常见特征：找含 hi 文本的叶子容器
  out.hi = [];
  document.querySelectorAll('div,p,span').forEach((el) => {
    if (el.children.length === 0 && (el.textContent || '').trim() === 'hi') {
      out.hi.push({ tag: el.tagName, cls: String(el.className).slice(0, 90), parentCls: String(el.parentElement.className).slice(0, 90) });
    }
  });
  out.hi = out.hi.slice(0, 5);
  return JSON.stringify(out);
})()`;
r = await send('Runtime.evaluate', { expression: dumpExpr, returnByValue: true });
console.log('DUMP:', r.result?.result?.value);
process.exit(0);
