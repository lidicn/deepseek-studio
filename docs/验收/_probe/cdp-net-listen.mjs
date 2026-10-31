// CDP 网络取证监听器：抓 chat/completion 请求的真实 postData + 页面 msel 钩子。
// 用法：node cdp-net-listen.mjs <durationMs> <outJson>
// 只读：仅开启 Network 域观察并注入一个页面内存钩子（不改磁盘代码、不 reload）。
const durationMs = Number(process.argv[2] ?? 120000);
const outJson = process.argv[3] ?? 'net-capture.json';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url));
if (!page) {
  console.error('NO_PAGE');
  process.exit(3);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const captures = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const req = msg.params.request;
    if (req.url.includes('/api/v0/chat/completion') && req.method === 'POST') {
      captures.push({
        wallTime: msg.params.wallTime,
        ts: msg.params.timestamp,
        url: req.url,
        postDataLen: typeof req.postData === 'string' ? req.postData.length : null,
        postData: typeof req.postData === 'string' ? req.postData : null,
      });
    }
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Network.enable', { maxTotalBufferSize: 100000000, maxPostDataSize: 50000000 });

// 页面内存钩子：记录 memory.select 的 callId 与时刻（performance.now），不改磁盘代码。
const hookExpr = `(() => {
  const rec = globalThis.__c1probe || (globalThis.__c1probe = { msel: [], t0: performance.now() });
  const host = globalThis.__deepseekStudio && globalThis.__deepseekStudio.host;
  if (host && !host.__c1wrapped) {
    const orig = host.sendToolCall.bind(host);
    host.sendToolCall = (req) => {
      if (req && String(req.invocationName || '').startsWith('memory.')) {
        rec.msel.push({ t: performance.now(), callId: req.callId, name: req.invocationName, taskTextLen: String(req.params && req.params.taskText || '').length });
      }
      return orig(req);
    };
    host.__c1wrapped = true;
  }
  return { installed: true, host: !!host, flag: globalThis.__studioMemorySelect ?? null };
})()`;
const hook = await send('Runtime.evaluate', { expression: hookExpr, returnByValue: true });
console.log('HOOK=' + JSON.stringify(hook.result?.result?.value));

const started = Date.now();
while (Date.now() - started < durationMs) {
  await new Promise((r) => setTimeout(r, 500));
}

const probe = await send('Runtime.evaluate', {
  expression: `({ msel: (globalThis.__c1probe||{}).msel || [], resources: performance.getEntriesByType('resource').filter(e => e.name.includes('/api/v0/chat/completion')).map(e => ({ name: e.name, startTime: e.startTime, responseEnd: e.responseEnd, duration: e.duration, transferSize: e.transferSize })) })`,
  returnByValue: true,
});

const out = {
  captures,
  probe: probe.result?.result?.value ?? null,
  finishedAt: new Date().toISOString(),
};
await import('node:fs').then((fs) => fs.writeFileSync(outJson, JSON.stringify(out, null, 2), 'utf8'));
console.log('CAPTURED=' + captures.length + ' -> ' + outJson);
console.log('MSEL=' + JSON.stringify((out.probe?.msel ?? []).map((m) => ({ callId: m.callId, name: m.name, t: Math.round(m.t) }))));
ws.close();
