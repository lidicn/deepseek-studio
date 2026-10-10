const html = await (await fetch('http://127.0.0.1:8756/agent')).text();
const m = html.match(/window\.__STUDIO_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")/);
const token = m ? JSON.parse(m[1]) : '';
console.log('token_len=' + token.length);
const { WebSocket } = await import('ws');
const ws = new WebSocket(`ws://127.0.0.1:8756/agent-ws?token=${encodeURIComponent(token)}`);
ws.on('open', () => console.log('OPEN'));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'state') { console.log('STATE_OK policy=' + msg.policyMode); process.exit(0); }
});
ws.on('close', (code, reason) => { console.log('CLOSE code=' + code + ' reason=' + reason.toString()); process.exit(1); });
ws.on('error', (e) => { console.log('ERR ' + e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);
