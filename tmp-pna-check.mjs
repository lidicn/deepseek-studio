import WebSocket from 'ws';
import fs from 'node:fs';

const out = [];
const log = (s) => out.push(s);
const origin = process.argv[2] ?? 'https://chat.deepseek.com';
const url = process.argv[3] ?? 'ws://127.0.0.1:8756/studio';

log(`origin=${origin} url=${url}`);
const ws = new WebSocket(url, { headers: { Origin: origin } });

ws.on('upgrade', (res) => {
  log(`UPGRADE status=${res.statusCode}`);
  for (const [k, v] of Object.entries(res.headers)) log(`  hdr ${k}: ${v}`);
  const pna = String(res.headers['access-control-allow-private-network'] ?? '').includes('true');
  log(`PNA_PRESENT_AND_TRUE=${pna}`);
  fs.writeFileSync('tmp-pna-result.txt', out.join('\n'));
  process.exit(pna ? 0 : 3);
});
ws.on('open', () => { log('OPEN'); });
ws.on('error', (e) => { log('ERROR ' + e.message); fs.writeFileSync('tmp-pna-result.txt', out.join('\n')); process.exit(1); });
setTimeout(() => { log('TIMEOUT'); fs.writeFileSync('tmp-pna-result.txt', out.join('\n')); process.exit(2); }, 5000);
