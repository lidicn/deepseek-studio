/**
 * Studio 端到端自动化验证脚本
 * 通过 WebSocket 模拟 agent 的完整工具调用循环：
 * 1. local_file_write - 写测试脚本
 * 2. shell_exec - 运行脚本
 * 3. local_file_read - 读取输出
 * 4. local_file_stat - 检查文件
 * 验证工具调用链路的稳定性和结果回填。
 */
const WebSocket = require("ws");

const WS_URL = "ws://127.0.0.1:8760/studio";
const TEST_DIR = "E:/NAS/deepseek-studio/scripts";
const TEST_FILE = TEST_DIR + "/e2e-test-output.txt";

let callId = 0;
const results = [];

function nextId() {
  return "e2e-" + (++callId);
}

function sendTool(ws, invocationName, params) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timeout = setTimeout(() => {
      reject(new Error("timeout: " + invocationName));
    }, 15000);

    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.callId === id) {
        clearTimeout(timeout);
        ws.removeListener("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "tool-call", invocationName, params, callId: id }));
  });
}

async function main() {
  console.log("=== Studio 端到端自动化验证 ===\n");

  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
  console.log("[1/6] WebSocket 连接成功 ✓");

  // Test 1: local_file_write
  const testContent = "E2E Test - " + new Date().toISOString() + "\nHello from Studio e2e test!\n";
  const r1 = await sendTool(ws, "local_file_write", { path: TEST_FILE, content: testContent });
  console.log("[2/6] local_file_write:", r1.ok ? "✓ ok" : "✗ " + r1.error);
  results.push({ tool: "local_file_write", ok: r1.ok, error: r1.error });

  // Test 2: local_file_stat
  const r2 = await sendTool(ws, "local_file_stat", { path: TEST_FILE });
  console.log("[3/6] local_file_stat:", r2.ok ? "✓ size=" + r2.data.size : "✗ " + r2.error);
  results.push({ tool: "local_file_stat", ok: r2.ok, error: r2.error });

  // Test 3: local_file_read
  const r3 = await sendTool(ws, "local_file_read", { path: TEST_FILE });
  const contentMatch = r3.ok && r3.data && r3.data.text && r3.data.text.includes("E2E Test");
  console.log("[4/6] local_file_read:", contentMatch ? "✓ 内容匹配" : "✗ 内容不匹配/错误");
  results.push({ tool: "local_file_read", ok: contentMatch, error: r3.error });

  // Test 4: shell_exec
  const r4 = await sendTool(ws, "shell_exec", { command: "echo hello-from-shell-e2e" });
  const shellOk = r4.ok && r4.data && r4.data.stdout && r4.data.stdout.includes("hello-from-shell-e2e");
  console.log("[5/6] shell_exec:", shellOk ? "✓ 输出匹配" : "✗ " + (r4.error || "输出不匹配"));
  results.push({ tool: "shell_exec", ok: shellOk, error: r4.error });

  // Test 5: 连续调用稳定性（连续5次 shell_exec）
  console.log("[6/6] 连续调用稳定性测试 (5x shell_exec)...");
  let consecutiveOk = 0;
  for (let i = 0; i < 5; i++) {
    const r = await sendTool(ws, "shell_exec", { command: "echo test-" + i });
    if (r.ok && r.data && r.data.stdout && r.data.stdout.includes("test-" + i)) {
      consecutiveOk++;
    }
  }
  console.log("      连续5次: " + consecutiveOk + "/5 成功");
  results.push({ tool: "shell_exec x5", ok: consecutiveOk === 5, detail: consecutiveOk + "/5" });

  ws.close();

  // 汇总
  console.log("\n=== 验证结果汇总 ===");
  let pass = 0;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    if (r.ok) pass++;
    console.log(`  [${status}] ${r.tool}` + (r.error ? " - " + r.error : "") + (r.detail ? " - " + r.detail : ""));
  }
  console.log(`\n总计: ${pass}/${results.length} 通过`);
  console.log(pass === results.length ? "\n✅ 全部通过！Studio 工具调用链路正常。" : "\n❌ 有失败项，需要排查。");
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
