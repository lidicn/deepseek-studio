// 人工一次性取证件（非受支持入口）：路径为写死示例；要复用请自行改路径或走 scripts/e2e-verify.cjs（⑦ 已参数化）。不参数化：改动即需回归，收益低于留着"像活接口"的错误暗示。
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
