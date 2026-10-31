// F1/F2 第二版复现：Node 侧轮询（页内 setInterval 会被浏览器节流） + 直接问宿主 chat-read 的实时视角
//
//   node docs/验收/_probe/f1f2-repro2.mjs ["<prompt>"] ["<宿主 stdout 日志路径>"]
//   argv[2] = 提示词（不给则用带唯一标记的短答）；argv[3] = 宿主 stdout 日志路径（可选，用于取 page session 证据）
//
// 关键改动（相对第一版）：
//   1) 不再用页内 setInterval 采样（P1 采到 0 样本 = 隐藏页定时器被节流/冻结）；
//      改为 Node 侧定时调 CDP Runtime.evaluate，页面定时器节流不影响。
//   2) 不再用「镜像 chat-read」当证据（镜像≠宿主）：改为**每 2s 直接问宿主**
//      POST /v1/tools/execute {tool:'chat-read'} —— 与引擎 dispatch 同一条 invokeTool 路径。
//   3) audit 解析修正：返回体是 {"object":"list","data":[...]}（第一版取了 .audit/.items → 恒为空）。
//   4) 跑前开 __studioMemorySelect（页内 flag）以取到**页内预取**的 memory.select durationMs；
//      跑完复原为原值（undefined → delete）。
//
// 纪律：只读观察 + 一次真机发送；不写库、不打印 token。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:8760';
// 本轮唯一标记：用于断言「返回的 answer 确实对得上本轮请求」
// （Studio-PM 新增判据：状态码 + 内容都对得上本轮，两条都过才算 PASS）
//
// 关键设计：标记分**小写/大写**两形——提示词里放小写，模型必须把它**转成大写**回显。
//   → 大写形只可能出现在「模型的答案」里；
//   → 小写形只可能出现在「用户气泡（提示词原文）」里。
// 于是可以区分「宿主读到的是 assistant 答案」与「读到的是用户气泡 + 记忆注入块」
// （后者约 10k 字符，正是现网最容易踩的坑）。
const MARK_LOWER = 'f1v3-' + Date.now().toString(36);
const MARK_UPPER = MARK_LOWER.toUpperCase();
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = join('docs', '验收', '_probe', `f1f2-v2-${TS}.json`);
const SHORT_PROMPT = process.argv[2] ?? `只回一行，把 ${MARK_LOWER} 全部改成大写写出来，不要做任何其他操作。`;

const cfg = JSON.parse(readFileSync(join(homedir(), '.config', 'deepseek-studio', 'config.json'), 'utf8'));
const token = cfg.token;
const apiHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

// ---------- CDP ----------
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const pages = list.filter((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url));
console.log('=== CDP page targets ===');
for (const p of pages) console.log(`  id=${p.id} title=${p.title} url=${p.url}`);
const page = pages[0];
if (!page) { console.error('NO_PAGE chat.deepseek.com'); process.exit(3); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg); }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 30000 });
  if (res.result?.exceptionDetails) return { __exception: JSON.stringify(res.result.exceptionDetails).slice(0, 300) };
  return res.result?.result?.value;
};

// ---------- 页面 DOM 视角（宽选择器，看真实答案长什么样）----------
const DOM_SNAP = `(() => {
  const txt = (n) => (n ? (n.textContent ?? '').replace(/\\s+/g,' ').trim() : '');
  const q = (s) => Array.from(document.querySelectorAll(s));
  const root = document.querySelector('#chat-container');
  const md = q('.ds-markdown');
  const amc = q('.ds-assistant-message-main-content');
  const wide = q('[class*="markdown"], [class*="message"], [class*="reply"], [class*="bubble"]');
  const lastWide = wide.at(-1);
  const cls = {};
  for (const n of wide) { const c = String(n.className || '').slice(0, 70); cls[c] = (cls[c] || 0) + 1; }
  return {
    t: Math.round(performance.now()),
    url: location.href,
    // 证据③：页面上真实的会话 id（路径里的 /a/chat/s/<id>）
    convId: (/\/a\/chat\/s\/([0-9a-f-]+)/.exec(location.pathname) || [])[1] ?? null,
    hasChatContainer: !!root,
    rootTextLen: root ? txt(root).length : null,
    rootTextTail: root ? txt(root).slice(-160) : null,
    nDsMarkdown: md.length,
    nAssistantMain: amc.length,
    dsMarkdownLast: txt(md.at(-1)).slice(0, 200),
    wideCount: wide.length,
    wideClasses: Object.entries(cls).sort((a,b)=>b[1]-a[1]).slice(0, 6),
    wideLastText: txt(lastWide).slice(0, 200),
    wideLastClass: lastWide ? String(lastWide.className).slice(0, 90) : null,
    bodyTextLen: txt(document.body).length,
  };
})()`;

// ---------- 宿主视角：直接调 chat-read ----------
async function hostChatRead() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}/v1/tools/execute`, {
      method: 'POST', headers: apiHeaders, body: JSON.stringify({ tool: 'chat-read', params: {} }),
    });
    const j = await res.json().catch(() => null);
    const msgs = j?.data?.messages ?? [];
    const last = msgs[msgs.length - 1];
    return {
      t: Date.now(), wallMs: Date.now() - t0,
      ok: j?.ok ?? null, reason: j?.reason ?? null, count: j?.data?.count ?? null,
      lastTextLen: typeof last?.text === 'string' ? last.text.length : null,
      lastText: typeof last?.text === 'string' ? last.text.slice(0, 160) : null,
      // 证据①：chat-read 返回体里有没有 session / 消息标识（现在没有 → 宿主无法对账轮次）
      payloadKeys: j?.data ? Object.keys(j.data) : null,
      messageKeys: msgs[0] ? Object.keys(msgs[0]) : null,
      // 大写标记 = 模型答案；小写标记 = 用户气泡（提示词原文）
      lastTextHasUpper: typeof last?.text === 'string' ? last.text.includes(MARK_UPPER) : null,
      anyMsgHasUpper: msgs.some((m) => typeof m?.text === 'string' && m.text.includes(MARK_UPPER)),
      anyMsgHasLowerOnly: msgs.some((m) => typeof m?.text === 'string' && m.text.includes(MARK_LOWER) && !m.text.includes(MARK_UPPER)),
    };
  } catch (e) { return { t: Date.now(), error: String(e) }; }
}

// ---------- 宿主 page session 证据（Studio-PM 要求的三项硬证据之 ②）----------
// 从宿主 stdout 日志里提取：宿主当时连了几条 page session、那条 session 的页在往哪个
// chat_session_id 发消息、parent_message_id 链如何推进。日志行格式见 page-runtime.ts:328。
// 用法：node f1f2-repro2.mjs "<prompt>" "<宿主 stdout 日志路径>"
function collectHostSessionEvidence(logPath) {
  if (!logPath) return { skipped: '未提供宿主 stdout 日志路径' };
  let raw;
  try { raw = readFileSync(logPath, 'utf8'); } catch (e) { return { error: String(e) }; }
  const lines = raw.split('\n');
  const sessions = new Set();
  const chatBodies = [];
  for (const line of lines) {
    const m = /\[page ([0-9a-f-]{36})\]/.exec(line);
    if (!m) continue;
    sessions.add(m[1]);
    const sid = /"chat_session_id"\s*:\s*"([^"]+)"/.exec(line);
    if (sid) {
      const pm = /"parent_message_id"\s*:\s*(null|\d+)/.exec(line);
      chatBodies.push({ session: m[1], chatSessionId: sid[1], parentMessageId: pm ? pm[1] : null });
    }
  }
  return {
    logPath,
    distinctPageSessions: [...sessions],
    pageSessionCount: sessions.size,
    chatSessionIds: [...new Set(chatBodies.map((b) => b.chatSessionId))],
    parentMessageChain: chatBodies.map((b) => b.parentMessageId),
    chatBodyCount: chatBodies.length,
  };
}
const hostSessionEvidence = collectHostSessionEvidence(process.argv[3]);
console.log('=== 宿主 page session 证据 ===');
console.log(JSON.stringify(hostSessionEvidence, null, 2));

// ---------- 记录 flag 原值并打开页内预取 ----------
const flagBefore = await evaluate('typeof window.__studioMemorySelect === "undefined" ? "__undefined__" : JSON.stringify(window.__studioMemorySelect)');
await evaluate('window.__studioMemorySelect = true; return window.__studioMemorySelect;');
console.log(`flag: before=${JSON.stringify(flagBefore)} → now=true`);

const domSamples = [];
const hostSamples = [];
let running = true;
const domTimer = setInterval(async () => {
  if (!running) return;
  try { const s = await evaluate(DOM_SNAP); if (s) domSamples.push(s); } catch {}
}, 1000);
const hostTimer = setInterval(async () => {
  if (!running) return;
  try { hostSamples.push(await hostChatRead()); } catch {}
}, 2000);

// ---------- 触发一次真机发送 ----------
const t0 = Date.now();
let apiRes;
try {
  const res = await fetch(`${API}/v1/agent/send`, {
    method: 'POST', headers: apiHeaders, body: JSON.stringify({ message: SHORT_PROMPT }),
  });
  const body = await res.text();
  apiRes = { status: res.status, elapsedMs: Date.now() - t0, body: body.slice(0, 900) };
} catch (e) { apiRes = { status: -1, elapsedMs: Date.now() - t0, error: String(e) }; }
running = false;
clearInterval(domTimer); clearInterval(hostTimer);

// ---------- 跑后：J7 视口外消息可读性（用本轮唯一标记判断「最新消息是否已挂载」）----------
const post = await evaluate(`(() => {
  const M = ${JSON.stringify(MARK_UPPER)};
  const vlist = document.querySelector('.ds-virtual-list:not(.ds-virtual-list--printable)');
  const items = vlist ? Array.from(vlist.querySelectorAll('.ds-virtual-list-visible-items > *')) : [];
  const raw = (n) => (n ? (n.textContent ?? '').replace(/\\s+/g,' ').trim() : '');
  return {
    mountedItems: items.length,
    markerMounted: items.filter(i => raw(i).includes(M)).length,
    lastItemLen: items.length ? raw(items.at(-1)).length : null,
    vlistScrollTop: vlist ? Math.round(vlist.scrollTop) : null,
    vlistScrollHeight: vlist ? vlist.scrollHeight : null,
    vlistClientHeight: vlist ? vlist.clientHeight : null,
    atBottom: vlist ? (vlist.scrollTop + vlist.clientHeight >= vlist.scrollHeight - 40) : null,
    vlistExists: !!vlist,
  };
})()`);
console.log('=== J7 视口外消息可读性 ===');
console.log(JSON.stringify(post, null, 2));

// ---------- 复原 flag ----------
const restored = await evaluate(
  flagBefore === '__undefined__' ? 'delete window.__studioMemorySelect; return typeof window.__studioMemorySelect;'
                               : 'window.__studioMemorySelect = JSON.parse(' + JSON.stringify(flagBefore) + '); return window.__studioMemorySelect;');

// ---------- audit（修正解析：{object:"list",data:[...]}）----------
let auditAll = [];
try {
  const res = await fetch(`${API}/v1/tools/audit`, { headers: apiHeaders });
  const j = await res.json().catch(() => null);
  auditAll = j?.data ?? (Array.isArray(j) ? j : []);
} catch (e) { auditAll = [{ error: String(e) }]; }
const msel = auditAll.filter((a) => a.tool === 'memory.select').map((a) => ({ origin: a.origin, durationMs: a.durationMs, at: a.at, outcome: a.outcome }));
const chatReadAudit = auditAll.filter((a) => a.tool === 'chat-read').map((a) => ({ origin: a.origin, durationMs: a.durationMs, outcome: a.outcome }));
const chatReadOutcomes = {};
for (const a of chatReadAudit) { const k = `${a.outcome}|${a.origin}`; chatReadOutcomes[k] = (chatReadOutcomes[k] || 0) + 1; }

// ---------- 判读 ----------
const uniqHost = [...new Set(hostSamples.map((s) => `${s.ok}|${s.reason}|${s.count}|${s.lastTextLen}`))];
const uniqDom = [...new Set(domSamples.map((s) => `${s.nDsMarkdown}|${s.nAssistantMain}|${s.rootTextLen}|${s.bodyTextLen}`))];
const verdict = {
  apiStatus: apiRes.status,
  apiElapsedMs: apiRes.elapsedMs,
  apiBody: apiRes.body,
  // —— 内容对账（Studio-PM 新增判据）——
  markerLower: MARK_LOWER,
  markerUpper: MARK_UPPER,
  answerText: (() => { try { return JSON.parse(apiRes.body).answer ?? null; } catch { return null; } })(),
  // 大写形出现 = 真的是模型答案；只有小写形 = 返回的是用户气泡（提示词原文）
  answerContainsMarker: (() => { try { return String(JSON.parse(apiRes.body).answer ?? '').includes(MARK_UPPER); } catch { return null; } })(),
  answerIsUserBubbleOnly: (() => {
    try {
      const a = String(JSON.parse(apiRes.body).answer ?? '');
      return a.includes(MARK_LOWER) && !a.includes(MARK_UPPER);
    } catch { return null; }
  })(),
  // 陈旧答案检测：本轮开始前页面上已有的那条答案（domFirst.wideLastText）若出现在返回里 → stale
  answerEqualsPreTurnText: (() => {
    const pre = domSamples[0]?.wideLastText ?? '';
    const ans = (() => { try { return String(JSON.parse(apiRes.body).answer ?? ''); } catch { return ''; } })();
    if (!pre || pre.length < 12 || !ans) return null;
    return ans.includes(pre.slice(0, 60));
  })(),
  hostSamples: hostSamples.length,
  hostDistinctStates: uniqHost,
  hostStateStable: uniqHost.length <= 1,
  hostFirst: hostSamples[0] ?? null,
  hostLast: hostSamples.at(-1) ?? null,
  domSamples: domSamples.length,
  domDistinctStates: uniqDom.length,
  domStateStable: uniqDom.length <= 1,
  domFirst: domSamples[0] ?? null,
  domLast: domSamples.at(-1) ?? null,
  mselSamples: msel,
  chatReadAuditCount: chatReadAudit.length,
  chatReadOutcomes,
  flagRestoredTo: restored,
  // Studio-PM 要求的三项硬证据
  ev1_chatReadPayloadShape: {
    payloadKeys: hostSamples[0]?.payloadKeys ?? null,
    messageKeys: hostSamples[0]?.messageKeys ?? null,
    hasSessionField: !!(hostSamples[0]?.payloadKeys ?? []).some((k) => /session|conv|message_id|turn/i.test(k)),
  },
  ev2_hostPageSessions: hostSessionEvidence,
  ev3_pageConvId: domSamples[0]?.convId ?? null,
  ev3_pageConvIdMatchesHost: hostSessionEvidence?.chatSessionIds?.length
    ? (domSamples[0]?.convId ?? null) !== null &&
      hostSessionEvidence.chatSessionIds.includes(domSamples[0].convId)
    : null,
  // J7：最新消息当时是否已挂载进 DOM（0 = 被虚拟列表卸载 → 纯 DOM 实现读不到）
  j7_post: post,
};
console.log('=== VERDICT ===');
console.log(JSON.stringify(verdict, null, 2));

mkdirSync(join('docs', '验收', '_probe'), { recursive: true });
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), pageTarget: { id: page.id, url: page.url }, apiRes, verdict, hostSamples, domSamples, msel, chatReadAudit }, null, 2));
console.log('written: ' + OUT);
ws.close();
