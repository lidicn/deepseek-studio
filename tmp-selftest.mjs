// M1 自测驱动（验证后删除）：模拟面板 WS 通道，驱动真实 AgentLoop 全链路。
// 任务：读取 E:\NAS\deepseek-studio\package.json 并报告 name 字段（基准值 deepseek-studio）。
// 为无人值守，测试期间临时切 full 档（不弹同意框），结束后恢复 auto。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config', 'deepseek-studio', 'config.json'), 'utf8'),
);
const { WebSocket } = await import('ws');
const ws = new WebSocket(`ws://127.0.0.1:8756/agent-ws?token=${encodeURIComponent(cfg.token)}`);

const t0 = Date.now();
const ts = () => {
  const s = Math.floor((Date.now() - t0) / 1000);
  return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`;
};
const events = [];
let done = false;
let finalText = '';
let sawTool = false;

const hardTimeout = setTimeout(() => {
  console.log(`${ts()} SELFTEST_FAIL: 420s 超时，事件序列=${events.join(',')}`);
  process.exit(1);
}, 420_000);

ws.on('open', () => {
  console.log(`${ts()} WS_OPEN`);
  // 无人值守：临时 full（全自动+审计），完成后恢复 auto
  ws.send(JSON.stringify({ type: 'set-policy', mode: 'full', reqId: 'p1' }));
  ws.send(JSON.stringify({
    type: 'send',
    text: '请读取文件 E:\\NAS\\deepseek-studio\\package.json，然后告诉我其中 name 字段的值。只做这一件事。',
    reqId: 's1',
  }));
});

ws.on('message', async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'ack' && msg.ok === false) {
    console.log(`${ts()} ACK_ERR ${msg.error}`);
    process.exit(1);
  }
  if (msg.type === 'state') {
    console.log(`${ts()} STATE policy=${msg.policyMode} ws=${msg.workspaceRoot ?? 'null'} running=${msg.running}`);
    return;
  }
  if (msg.type !== 'event') return;
  const e = msg.event;
  events.push(e.type);
  if (e.type === 'tool') sawTool = true;
  if (e.type === 'assistant') finalText = e.text ?? '';
  const text = (e.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
  console.log(`${ts()} EVT ${e.type}${e.step ? ` step=${e.step}` : ''}${e.toolCalls != null ? ` toolCalls=${e.toolCalls}` : ''} :: ${text}`);

  if (e.type === 'done') {
    done = true;
    // 恢复默认档位
    ws.send(JSON.stringify({ type: 'set-policy', mode: 'auto', reqId: 'p2' }));
    clearTimeout(hardTimeout);
    // 审计佐证
    try {
      const r = await fetch('http://127.0.0.1:8756/v1/tools/audit?limit=15', {
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      const j = await r.json();
      for (const a of (j.data ?? []).slice(0, 8)) {
        console.log(`${ts()} AUDIT ${a.tool} outcome=${a.outcome} ok=${a.ok} mode=${a.mode ?? ''} ${a.summary ?? ''}`);
      }
    } catch { /* 审计读取失败不影响判定 */ }

    const pass = sawTool && finalText.includes('deepseek-studio');
    console.log(`${ts()} SELFTEST_${pass ? 'PASS' : 'FAIL'} sawTool=${sawTool} final="${finalText.replace(/\s+/g, ' ').slice(0, 120)}"`);
    process.exit(pass ? 0 : 1);
  }
});

ws.on('error', (err) => {
  console.log(`${ts()} WS_ERR ${err.message}`);
  process.exit(1);
});
ws.on('close', (code, reason) => {
  if (!done) {
    console.log(`${ts()} WS_CLOSED_EARLY code=${code} reason=${reason.toString()}`);
    process.exit(1);
  }
});
