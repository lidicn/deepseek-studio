import WebSocket from 'ws';
import fs from 'node:fs';

const token = process.argv[2] ?? 'live-token';
const text = process.argv[3] ?? '读取 package.json 并总结它的脚本和依赖';
const out = [];
const log = (s) => { out.push(s); fs.writeFileSync('tmp-agent-log.txt', out.join('\n')); };

const ws = new WebSocket(`ws://127.0.0.1:8756/agent-ws?token=${encodeURIComponent(token)}`);
let finished = false;

ws.on('open', () => {
  log('connected to /agent-ws');
  ws.send(JSON.stringify({ type: 'get-state', reqId: 's1' }));
  setTimeout(() => {
    log(`>>> sending: ${text}`);
    ws.send(JSON.stringify({ type: 'send', reqId: 'r1', text }));
  }, 500);
});
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === 'event') {
    const e = m.event;
    log(`[event ${e?.type}] ${JSON.stringify(e?.data ?? e).slice(0, 500)}`);
  } else {
    log(`[${m.type}] ${JSON.stringify(m).slice(0, 500)}`);
  }
});
ws.on('error', (e) => { log('WS ERROR: ' + e.message); fs.writeFileSync('tmp-agent-log.txt', out.join('\n')); process.exit(1); });
setTimeout(() => { log('=== timeout exit ==='); fs.writeFileSync('tmp-agent-log.txt', out.join('\n')); process.exit(0); }, 150000);
