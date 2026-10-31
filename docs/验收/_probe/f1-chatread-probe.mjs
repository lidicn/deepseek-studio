// F1 复现探针：判定 /v1/agent/send 的 500 timeout 到底是不是「宿主 chat-read 看不见新答案」。
//
// 做法：
//   1) 在页面内按 chat-read.ts 的**原样逻辑**（src/capabilities/chat-read.ts + dom.ts）镜像一份「宿主此刻会读到什么」；
//   2) 每 400ms 采一次样，同时记录「整个 document 里最新的一条答案」作为对照；
//   3) 期间走一次真实 POST /v1/agent/send（宿主自己驱动页面），对比两者是否同步变化。
//
// 只读观察：不改页面代码、不 reload、不写库。token 从 config.json 取，全程不打印。
// 用法：node f1-chatread-probe.mjs "<一句话指令>" [outFile]
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const prompt = process.argv[2] ?? '只回一行「F1-PROBE-OK」，不要做任何其他操作。';
const outFile = process.argv[3] ?? join('docs', '验收', '_probe', `f1-samples-${Date.now()}.json`);
const API = 'http://127.0.0.1:8760';

// ---- token（不打印）----
const cfg = JSON.parse(readFileSync(join(homedir(), '.config', 'deepseek-studio', 'config.json'), 'utf8'));
const token = cfg.token;
if (!token) throw new Error('config.json 无 token 字段');

// ---- CDP 连接 ----
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

// ---- 页面内采样器：镜像 chat-read.ts 的选择器级联 + root ----
const INSTALL = `(() => {
  const SEL = ['.ds-assistant-message-main-content','.ds-markdown','[class*="message-item"]','[class*="chat-message"]','#chat-messages > *','.message'];
  const txt = (n) => (n ? (n.textContent ?? '').replace(/\\s+/g,' ').trim() : '');
  const cascade = (r) => { for (const s of SEL) { const f = Array.from(r.querySelectorAll(s)); if (f.length > 0) return { sel: s, nodes: f }; } return { sel: null, nodes: [] }; };
  const snap = () => {
    const rootEl = document.querySelector('#chat-container');
    const root = rootEl ?? document.body;
    const inRoot = cascade(root);
    const inDoc = cascade(document);
    const lastRoot = inRoot.nodes.at(-1);
    const lastDoc = inDoc.nodes.at(-1);
    // document 范围内「最后一条答案」对照组（不看级联，直接取所有 assistant/markdown 节点里 DOM 序最后的）
    const all = Array.from(document.querySelectorAll('.ds-assistant-message-main-content, .ds-markdown'));
    const newest = all.at(-1);
    return {
      t: Math.round(performance.now()),
      rootExists: !!rootEl,
      rootSel: inRoot.sel,
      rootCount: inRoot.nodes.length,
      rootLastText: txt(lastRoot),
      rootLastClass: lastRoot ? String(lastRoot.className).slice(0, 80) : null,
      rootLastInsideRoot: lastRoot ? (rootEl ? rootEl.contains(lastRoot) : 'body-root') : null,
      docSel: inDoc.sel,
      docCount: inDoc.nodes.length,
      docLastText: txt(lastDoc),
      newestAnyText: txt(newest).slice(0, 240),
      newestAnyClass: newest ? String(newest.className).slice(0, 80) : null,
      newestInsideRoot: newest ? (rootEl ? rootEl.contains(newest) : 'body-root') : null,
      newestLen: txt(newest).length,
    };
  };
  window.__f1probe = { samples: [], snap };
  if (window.__f1probeTimer) clearInterval(window.__f1probeTimer);
  window.__f1probeTimer = setInterval(() => {
    try { window.__f1probe.samples.push(window.__f1probe.snap()); } catch (e) { /* 忽略 */ }
  }, 400);
  return snap();
})()`;

const before = await evaluate(INSTALL);
console.log('=== BEFORE (宿主 chat-read 此刻读到的) ===');
console.log(JSON.stringify(before, null, 2));

// ---- 真实发送（宿主驱动页面）----
const t0 = Date.now();
let apiResult;
try {
  const res = await fetch(`${API}/v1/agent/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: prompt }),
  });
  const body = await res.text();
  apiResult = { status: res.status, elapsedMs: Date.now() - t0, body: body.slice(0, 800) };
} catch (e) {
  apiResult = { status: -1, elapsedMs: Date.now() - t0, error: String(e) };
}
console.log('=== /v1/agent/send ===');
console.log(JSON.stringify(apiResult, null, 2));

// ---- 停采样并取样 ----
const samples = await evaluate(`(() => { clearInterval(window.__f1probeTimer); window.__f1probeTimer = null; return window.__f1probe.samples; })()`);
const after = await evaluate('window.__f1probe.snap()');

// ---- 判据 ----
const rootTexts = new Set(samples.map((s) => s.rootLastText));
const docTexts = new Set(samples.map((s) => s.docLastText));
const changed = (set) => set.size > 1;
const verdict = {
  sampleCount: samples.length,
  rootLastTextChanged: changed(rootTexts),
  docLastTextChanged: changed(docTexts),
  rootFinalText: after.rootLastText,
  docFinalText: after.docLastText,
  newestInsideRoot: after.newestInsideRoot,
  newestAnyText: after.newestAnyText,
  rootSel: after.rootSel,
  rootCount: after.rootCount,
  apiStatus: apiResult.status,
  apiElapsedMs: apiResult.elapsedMs,
  hypothesis_baseline_never_changes: !changed(rootTexts),
  hypothesis_answer_outside_root: after.newestInsideRoot === false,
};

writeFileSync(outFile, JSON.stringify({ prompt, before, after, samples, apiResult, verdict }, null, 2));
console.log('=== VERDICT ===');
console.log(JSON.stringify(verdict, null, 2));
console.log('samples written: ' + outFile);
ws.close();
