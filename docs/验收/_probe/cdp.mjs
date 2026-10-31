// CDP 取证探针：连接页面目标，执行表达式并打印结果。
// 用法：node cdp.mjs "<expression>"  [--await-promise] [--raw]
// 只读观察，不修改页面代码。
const expr = process.argv[2];
const flags = new Set(process.argv.slice(3));
if (!expr) {
  console.error('usage: node cdp.mjs "<expression>" [--await-promise]');
  process.exit(2);
}

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url));
if (!page) {
  console.error('NO_PAGE chat.deepseek.com; targets=' + JSON.stringify(list.map((t) => ({ type: t.type, url: t.url }))));
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

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const res = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: flags.has('--await-promise'),
  timeout: 60000,
});

if (res.result?.exceptionDetails) {
  console.log('EXCEPTION: ' + JSON.stringify(res.result.exceptionDetails, null, 2));
  process.exitCode = 4;
} else {
  const v = res.result?.result?.value;
  console.log(flags.has('--raw') ? String(v) : JSON.stringify(v, null, 2));
}
ws.close();
