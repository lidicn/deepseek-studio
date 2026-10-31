// F1/F2 真机复现 runbook（在**干净的新构建实例**上跑）
//
//   node docs/验收/_probe/f1f2-repro.mjs
//
// 做四件事，产物写 docs/验收/_probe/f1f2-<ts>.json：
//   P0 前置体检：CDP 页面存在？/healthz？chat-read 通不通（= trustedPages 是否健康）
//   P1 F1 样本①：一行短答   → /v1/agent/send 预期 500 '(timeout)'
//   P2 F1 样本②：7 轮工具链 → /v1/agent/send + trace turn.end 统计
//   P3 F2 样本：直连 memory.select ×2（taskText 长度与真机轮次相当）
//
// 关键设计：页面内每 400ms 采样一次「宿主 chat-read 会读到什么」（镜像
// src/capabilities/chat-read.ts + dom.ts 的选择器级联），与「整个 document 的最新答案」
// 并排记录 —— 这一对就是判别 F1 机制的核心证据。
//
// 纪律：只读观察 + 两次真机发送；不改代码、不写库、不打印 token。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:8760';
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join('docs', '验收', '_probe', `f1f2-${TS}.json`);

const SHORT_PROMPT = '只回一行「F1-PROBE-OK」，不要做任何其他操作。';
const CHAIN_PROMPT = [
  '请依次执行下面 7 步，每步都用工具真实执行，不要跳过：',
  '1) 列出 E:/NAS/deepseek-studio 项目根目录的前 5 个文件；',
  '2) 读取该目录的 package.json，告诉我 name 和 version；',
  '3) 数一下 src 目录下有多少个 .ts 文件；',
  '4) 找出其中最大的那个 .ts 文件并给出路径；',
  '5) 读取该文件的前 20 行；',
  '6) 用一句话说明这个文件的作用；',
  '7) 最后只输出一行「CHAIN-DONE」。',
].join('\n');

// 约 1100 字符的 taskText（与 10-31 C1 复现时长相当）
const LONG_TASKTEXT = '请分析这个项目的构建与测试流程并给出改进建议。'.repeat(28);

const cfg = JSON.parse(readFileSync(join(homedir(), '.config', 'deepseek-studio', 'config.json'), 'utf8'));
const token = cfg.token;
if (!token) throw new Error('config.json 无 token');
const apiHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

// ---------------- CDP ----------------
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
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 60000 });
  if (res.result?.exceptionDetails) throw new Error('CDP exception: ' + JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
};

// ---------------- P0 前置体检（三态分类，不做二值门禁）----------------
// 重要（Studio-PM 纠正）：不能把「chat-read 必须 ok 且有内容」当门禁——
// 候选 A 预测的恰恰是「ok:true 但 text 为空」，用门禁挡掉会让 A 在真机上自证。
// 所以这里只做**三态分类并记录**，**不因任何一态中止复现**：
//   a-no-page   : ok=false, reason=no-page-for-dom-capability → 页面通道断（环境态）
//   b-healthy   : ok=true 且 count>0 且末条文本非空            → 正常
//   c-empty-text: ok=true 但 count==0 或末条文本为空            → **这本身就是候选 A/C 的证据**
function classifyChatRead(j) {
  if (!j || typeof j !== 'object') return 'unknown';
  if (j.ok !== true) return j.reason === 'no-page-for-dom-capability' ? 'a-no-page' : 'a-other-error';
  const msgs = j.data?.messages ?? [];
  const last = msgs[msgs.length - 1];
  const lastText = typeof last?.text === 'string' ? last.text : '';
  if (msgs.length === 0 || lastText.length === 0) return 'c-empty-text';
  return 'b-healthy';
}
const p0 = {};
try { p0.healthz = (await fetch(`${API}/healthz`)).status; } catch (e) { p0.healthz = String(e); }
try {
  const r = await fetch(`${API}/v1/tools/execute`, {
    method: 'POST', headers: apiHeaders,
    body: JSON.stringify({ tool: 'chat-read', params: {} }),
  });
  const j = await r.json().catch(() => null);
  p0.chatRead = { status: r.status, body: j };
  p0.chatReadState = classifyChatRead(j);
  const msgs = j?.data?.messages ?? [];
  p0.chatReadCount = msgs.length;
  p0.chatReadLastLen = typeof msgs.at(-1)?.text === 'string' ? msgs.at(-1).text.length : null;
} catch (e) { p0.chatRead = { error: String(e) }; p0.chatReadState = 'a-other-error'; }
console.log('=== P0 前置体检（三态）===');
console.log(JSON.stringify(p0, null, 2));
console.log(`P0 分类 = ${p0.chatReadState} —— 不作门禁，复现照跑；分类只用于解释样本。`);

// ---------------- 页内采样器（镜像 chat-read 级联）----------------
const INSTALL = `(() => {
  const SEL = ['.ds-assistant-message-main-content','.ds-markdown','[class*="message-item"]','[class*="chat-message"]','#chat-messages > *','.message'];
  const txt = (n) => (n ? (n.textContent ?? '').replace(/\\s+/g,' ').trim() : '');
  const cascade = (r) => { for (const s of SEL) { const f = Array.from(r.querySelectorAll(s)); if (f.length > 0) return { sel: s, nodes: f }; } return { sel: null, nodes: [] }; };
  const snap = () => {
    const rootEl = document.querySelector('#chat-container');
    const root = rootEl ?? document.body;
    const inRoot = cascade(root);
    const lastRoot = inRoot.nodes.at(-1);
    const msgs = inRoot.nodes.map((n) => txt(n)).filter((t) => t.length > 0);
    const all = Array.from(document.querySelectorAll('.ds-assistant-message-main-content, .ds-markdown'));
    const newest = all.at(-1);
    return {
      t: Math.round(performance.now()),
      rootExists: !!rootEl,
      sel: inRoot.sel,
      nodeCount: inRoot.nodes.length,
      msgCount: msgs.length,
      hostWouldRead: txt(lastRoot).slice(0, 300),
      hostWouldReadEmpty: txt(lastRoot).length === 0,
      docNewest: txt(newest).slice(0, 300),
      docNewestLen: txt(newest).length,
      docNewestInsideRoot: newest ? (rootEl ? rootEl.contains(newest) : 'body-root') : null,
    };
  };
  window.__f1f2 = { samples: [], snap };
  if (window.__f1f2Timer) clearInterval(window.__f1f2Timer);
  window.__f1f2Timer = setInterval(() => { try { window.__f1f2.samples.push(window.__f1f2.snap()); } catch (e) {} }, 400);
  return snap();
})()`;

async function runSend(label, prompt) {
  await evaluate(INSTALL);
  const t0 = Date.now();
  let r;
  try {
    const res = await fetch(`${API}/v1/agent/send`, {
      method: 'POST', headers: apiHeaders, body: JSON.stringify({ message: prompt }),
    });
    const body = await res.text();
    r = { label, status: res.status, elapsedMs: Date.now() - t0, body: body.slice(0, 900) };
  } catch (e) {
    r = { label, status: -1, elapsedMs: Date.now() - t0, error: String(e) };
  }
  const samples = await evaluate(`(() => { clearInterval(window.__f1f2Timer); window.__f1f2Timer=null; return window.__f1f2.samples; })()`);
  const hostTexts = new Set(samples.map((s) => s.hostWouldRead));
  const docTexts = new Set(samples.map((s) => s.docNewest));
  // 失败模式分类：'(timeout)' = 引擎内层 120s 到期；'(empty-response)' = 页面通道断/判停无内容；
  // '(disconnected)' = 通道断。分类不同源，不能混成一个「500」。
  const body = String(r.body ?? '');
  const apiBodyClass = r.status === 200 ? '200-ok'
    : /\(timeout\)/.test(body) ? '500-timeout'
    : /\(empty-response\)/.test(body) ? '500-empty-response'
    : /\(disconnected\)/.test(body) ? '500-disconnected'
    : 'other';
  const summary = {
    label,
    apiStatus: r.status,
    apiBodyClass,
    apiElapsedMs: r.elapsedMs,
    apiBody: r.body,
    sampleCount: samples.length,
    hostWouldRead_changed: hostTexts.size > 1,
    docNewest_changed: docTexts.size > 1,
    hostEmpty_ratio: samples.length ? +(samples.filter((s) => s.hostWouldReadEmpty).length / samples.length).toFixed(3) : null,
    sel_used: samples.at(-1)?.sel ?? null,
    nodeCount: samples.at(-1)?.nodeCount ?? null,
    msgCount: samples.at(-1)?.msgCount ?? null,
    hostFinal: samples.at(-1)?.hostWouldRead ?? null,
    docFinal: samples.at(-1)?.docNewest ?? null,
    docNewestInsideRoot: samples.at(-1)?.docNewestInsideRoot ?? null,
    first_sample_t: samples[0]?.t ?? null,
    last_sample_t: samples.at(-1)?.t ?? null,
  };
  console.log(`=== ${label} ===`);
  console.log(JSON.stringify(summary, null, 2));
  return { summary, samples, raw: r };
}

// ---------------- P1 / P2 ----------------
const shortRun = await runSend('P1-短答', SHORT_PROMPT);
const chainRun = await runSend('P2-七轮工具链', CHAIN_PROMPT);

// ---------------- P3 F2：直连 memory.select ×2 ----------------
const f2 = [];
for (let i = 0; i < 2; i++) {
  const t0 = Date.now();
  const res = await fetch(`${API}/v1/tools/execute`, {
    method: 'POST', headers: apiHeaders,
    body: JSON.stringify({ tool: 'memory.select', params: { taskText: LONG_TASKTEXT } }),
  });
  const j = await res.json().catch(() => null);
  f2.push({ i, wallMs: Date.now() - t0, status: res.status, ok: j?.ok, count: j?.data?.memories?.length ?? null, selection: j?.data?.selection ?? null });
  await new Promise((r) => setTimeout(r, 800));
}
console.log('=== P3 F2 直连 memory.select ×2 ===');
console.log(JSON.stringify(f2, null, 2));

// ---------------- 审计：取页内预取的 memory.select 真实 durationMs ----------------
let audit = [];
try {
  const res = await fetch(`${API}/v1/tools/audit`, { headers: apiHeaders });
  const j = await res.json().catch(() => null);
  const arr = Array.isArray(j) ? j : (j?.audit ?? j?.items ?? []);
  audit = (arr ?? []).filter((a) => a.tool === 'memory.select').map((a) => ({
    origin: a.origin, durationMs: a.durationMs, at: a.at, outcome: a.outcome,
    summaryLen: typeof a.summary === 'string' ? a.summary.length : null,
  }));
} catch (e) { audit = [{ error: String(e) }]; }
console.log('=== audit: memory.select ===');
console.log(JSON.stringify(audit, null, 2));

// ---------------- trace：落盘 JSONL（无 HTTP 端点），跑前快照行数、跑后读增量 ----------------
// 落盘路径见 src/host/page-runtime.ts:336 —— process.cwd()/logs/trace/trace-<UTC日期>.jsonl
const tracePath = join('logs', 'trace', `trace-${new Date().toISOString().slice(0, 10)}.jsonl`);
const readTrace = () => {
  try { return readFileSync(tracePath, 'utf8').split('\n').filter((l) => l.trim().length > 0); }
  catch { return []; }
};
const traceBefore = readTrace();
console.log(`=== trace 基线: ${tracePath} 共 ${traceBefore.length} 行 ===`);

const traceAfter = readTrace();
const traceNew = traceAfter.slice(traceBefore.length);
const turnEnds = traceNew.filter((l) => l.includes('turn.end'));
const traceStats = {
  path: tracePath,
  beforeLines: traceBefore.length,
  afterLines: traceAfter.length,
  newLines: traceNew.length,
  turnEndCount: turnEnds.length,
  turnEndFinishedTrue: turnEnds.filter((l) => /finished["']?\s*[:=]\s*true/.test(l)).length,
  truncatHits: traceNew.filter((l) => /truncat|stream-incomplete|incomplete/i.test(l)).length,
  sample: turnEnds.slice(0, 8),
};
console.log('=== trace 增量统计 ===');
console.log(JSON.stringify(traceStats, null, 2));

mkdirSync(join('docs', '验收', '_probe'), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  at: new Date().toISOString(), p0,
  short: shortRun.summary, shortSamples: shortRun.samples,
  chain: chainRun.summary, chainSamples: chainRun.samples,
  f2, audit, traceStats,
}, null, 2));
console.log('written: ' + OUT);
ws.close();
