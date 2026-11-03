// 假 MCP server（stdio）：**只**响应 initialize，tools/list 一律不应答。
// 用途：组 A 的失败路径（超时后必须收尸）——服务端仍然活着，
// 所以「子进程被收掉」只能来自我们自己的清理逻辑，不能来自它自己退出。
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
    if (msg.method === 'tools/list') continue; // 故意不应答 → 走超时分支
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-silent' } },
    }) + '\n');
  }
});
setInterval(() => {}, 1e6);
