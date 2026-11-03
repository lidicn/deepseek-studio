// 假 MCP server（stdio）：响应 initialize 与 tools/list，然后保活不退。
// 用途：组 A 的生命周期用例（连接成功路径 / 并发去重 / 定时器纪律）。
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id == null) continue;
    const result = msg.method === 'tools/list'
      ? { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
      : { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp' } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  }
});
setInterval(() => {}, 1e6);
