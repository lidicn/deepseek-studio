const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:8760/studio");
ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "tool-call",
    invocationName: "local_file_read",
    params: { path: "E:/NAS/deepseek-studio/scripts/e2e-test-output.txt" },
    callId: "debug-1"
  }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.callId === "debug-1") {
    console.log("FULL RESULT:", JSON.stringify(m, null, 2));
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log("timeout"); process.exit(1); }, 10000);
