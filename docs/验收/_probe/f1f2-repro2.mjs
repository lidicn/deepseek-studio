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
const SHORT_PROMPT = (process.argv[2] && process.argv[2].trim()) ? process.argv[2]
  : `只回一行，把 ${MARK_LOWER} 全部改成大写写出来，不要做任何其他操作。`;

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
    // 注意：别在这里写 /\/a\/chat\/.../ —— 模板字符串里反斜杠斜杠会被吃掉，正则字面量就变成
    // 行注释，后面整行变语法错（本轮踩过：DOM 采样全线抛 SyntaxError）
    convId: (location.pathname.split('/a/chat/s/')[1] ?? '').split('/')[0] || null,
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
    // 大写形 = 模型答案；小写形 = 用户气泡（提示词原文）
    wideLastHasUpper: (txt(lastWide) || '').includes(__MARK_UPPER__),
    wideLastHasLower: (txt(lastWide) || '').includes(__MARK_LOWER__),
    // 【P10 修正】原实现扫 #root * 且带 bbox 过滤 → Studio 注入层镜像
    // （.ds-sc-message-list，挂在 document.body 下、在 #root 之外）永远扫不到，
    // 于是 pageAnswerHasUpper 恒 false，把「实现读不到」洗成「模型没照做（待测）」。
    // 现在扫 document.body 全量，只按结构排除左栏（nav/aside/[class*=sidebar]），
    // 并把命中节点的祖先链整条记下来（含 .ds-sc-* 镜像 → 一眼能看出答案在哪个源）。
    domUpperHits: (() => {
      const M = __MARK_UPPER__;
      const hits = [];
      for (const n of document.body.querySelectorAll('*')) {
        if ((n.textContent || '').length < M.length) continue;
        if (!(n.textContent || '').includes(M)) continue;
        if (n.closest('nav, aside, [class*="sidebar"], [class*="history"]')) continue;
        if (!(n.offsetWidth || n.offsetHeight || n.getClientRects().length)) continue; // 跳过 display:none
        hits.push(n);
      }
      // 只留最深的 3 个（外层祖先也含标记，链会重复）
      const deepest = hits.filter((n) => !hits.some((m) => m !== n && n.contains(m)));
      return deepest.slice(-3).map(n => {
        const chain = []; let p = n;
        while (p && p !== document.body) { chain.push(p.tagName + '.' + String(p.className || '').split(/\\s+/).slice(0,3).join('.')); p = p.parentElement; }
        return chain.slice(0, 10);
      });
    })(),
    domLowerHitCount: (() => {
      let n = 0;
      for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || (r.left < 360 && r.width < 460)) continue;
        if ((el.textContent || '').includes(__MARK_LOWER__)) n++;
      }
      return n;
    })(),
    bodyTextLen: txt(document.body).length,
    // 虚拟列表实时状态：挂载了几项、每项文本长度、滚动指标
    // （本轮实测：只挂 3 项、scrollTop=0、scrollHeight==clientHeight=150 → 列表停在最老一屏）
    vlist: (() => {
      const v = document.querySelector('.ds-virtual-list:not(.ds-virtual-list--printable)');
      if (!v) return { exists: false };
      const items = Array.from(v.querySelectorAll('.ds-virtual-list-visible-items > *'));
      return {
        exists: true,
        mounted: items.length,
        itemLens: items.map((it) => ((it.textContent ?? '').replace(/\s+/g, ' ').trim()).length),
        itemHasUpper: items.map((it) => (it.textContent || '').includes(__MARK_UPPER__)),
        itemHasLower: items.map((it) => (it.textContent || '').includes(__MARK_LOWER__)),
        scrollTop: Math.round(v.scrollTop),
        scrollHeight: v.scrollHeight,
        clientHeight: v.clientHeight,
        atBottom: v.scrollTop + v.clientHeight >= v.scrollHeight - 40,
        totalItems: v.querySelectorAll('.ds-virtual-list-items > *').length,
      };
    })(),
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
    // v2：chat-read 新增 data.mirror（SSE 派生镜像，答案可能在 assistantTexts 里而不是 messages[].text）
    const mirror = j?.data?.mirror ?? null;
    const mirrorTexts = Array.isArray(mirror?.assistantTexts) ? mirror.assistantTexts : [];
    const mirrorHasUpper = mirrorTexts.some((t) => typeof t === 'string' && t.includes(MARK_UPPER))
      || (typeof mirror?.lastAssistantText === 'string' && mirror.lastAssistantText.includes(MARK_UPPER));
    return {
      t: Date.now(), wallMs: Date.now() - t0,
      ok: j?.ok ?? null, reason: j?.reason ?? null, count: j?.data?.count ?? null,
      lastTextLen: typeof last?.text === 'string' ? last.text.length : null,
      lastText: typeof last?.text === 'string' ? last.text.slice(0, 160) : null,
      // 证据①：chat-read 返回体里有没有 session / 消息标识
      payloadKeys: j?.data ? Object.keys(j.data) : null,
      messageKeys: msgs[0] ? Object.keys(msgs[0]) : null,
      // 镜像（SSE 派生答案源）证据
      mirrorCount: mirror ? (mirror.count ?? null) : null,
      mirrorAssistantTextCount: mirrorTexts.length,
      mirrorLastLen: typeof mirror?.lastAssistantText === 'string' ? mirror.lastAssistantText.length : null,
      mirrorHasUpper,
      // 大写标记 = 模型答案；小写标记 = 用户气泡（提示词原文）
      lastTextHasUpper: typeof last?.text === 'string' ? last.text.includes(MARK_UPPER) : null,
      anyMsgHasUpper: msgs.some((m) => typeof m?.text === 'string' && m.text.includes(MARK_UPPER)) || mirrorHasUpper,
      anyMsgHasLowerOnly: msgs.some((m) => typeof m?.text === 'string' && m.text.includes(MARK_LOWER) && !m.text.includes(MARK_UPPER)),
      // 正控用：能读到多少条历史消息
      anyMsgText: msgs.some((m) => typeof m?.text === 'string' && m.text.length > 0),
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
// ---------- 先导航到既有会话并等它渲染完，再发消息 ----------
// 教训（本轮踩过）：在**首页**发消息 = 页面根本没有会话可读，宿主 fail-closed 超时是**正确行为**，
// 但那样测不到「读虚拟列表里的会话消息」这条修复路径 → 必须先落到会话页。
const CONV_URL = process.env.F1_CONV_URL
  ?? 'https://chat.deepseek.com/a/chat/s/33507439-d490-4054-bbbc-dcd3d4d6f37a';
const READY_PROBE = `(() => ({
  skeleton: document.querySelectorAll('[class*="ds-skeleton"]').length,
  rootLen: (document.querySelector('#root')?.textContent ?? '').replace(/\\s+/g,' ').trim().length,
  vlist: !!document.querySelector('.ds-virtual-list:not(.ds-virtual-list--printable)'),
  url: location.href,
}))()`;
const curUrl = await evaluate('location.href');
if (curUrl !== CONV_URL) {
  console.log(`navigate -> ${CONV_URL}`);
  await send('Page.navigate', { url: CONV_URL });
}
let readyState = { ok: false };
let prevLen = -1, stable = 0;
const readyDeadline = Date.now() + 90000;
while (Date.now() < readyDeadline) {
  const s = await evaluate(READY_PROBE);
  if (s && !s.__exception && s.skeleton === 0 && s.rootLen > 500 && s.rootLen === prevLen) {
    stable += 1;
    if (stable >= 2) { readyState = { ok: true, ...s }; break; }
  } else stable = 0;
  prevLen = s?.rootLen ?? -1;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('=== 会话页就绪探测 ===');
console.log(JSON.stringify(readyState, null, 2));

// ---------- 正控（Studio-PM 要求）：能读到上一轮消息才算测对了路径，否则直接停 ----------
const positiveControl = await hostChatRead();
const pcPass = !!(positiveControl.ok === true && (positiveControl.count ?? 0) > 0 && positiveControl.anyMsgText === true);
console.log('=== 正控：宿主 chat-read 能否读到历史消息 ===');
console.log(JSON.stringify({ ...positiveControl, lastText: '[已隐去]', pass: pcPass }, null, 2));
if (!readyState.ok || !pcPass) {
  console.log('!! 正控不过（会话页未就绪 或 chat-read 读不到历史消息）—— 本轮**停止**，不发消息、不出判据表。');
  console.log('   reason: ready=' + readyState.ok + ' chatReadOk=' + positiveControl.ok + ' count=' + (positiveControl.count ?? 'null') + ' reason=' + (positiveControl.reason ?? '-'));
  ws.close();
  process.exit(9);
}
console.log('正控通过：路径正确，继续发送。');

// ---------- 记录 flag 原值并打开页内预取（IIFE 包裹；顶层 return 在 Runtime.evaluate 里是语法错）----------
const flagBefore = await evaluate('(() => { if (!("__studioMemorySelect" in window)) return "__undefined__"; return JSON.stringify(window.__studioMemorySelect); })()');
const flagSet = await evaluate('(() => { window.__studioMemorySelect = true; return String(window.__studioMemorySelect); })()');
console.log(`flag: before=${JSON.stringify(flagBefore)} → set 结果=${JSON.stringify(flagSet)}`);

const domSamples = [];
const hostSamples = [];
let running = true;
const domTimer = setInterval(async () => {
  if (!running) return;
  try { const s = await evaluate(DOM_SNAP.replaceAll('__MARK_UPPER__', JSON.stringify(MARK_UPPER)).replaceAll('__MARK_LOWER__', JSON.stringify(MARK_LOWER))); if (s) domSamples.push(s); } catch {}
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

// ---------- 复原 flag（IIFE；顶层 return 是语法错，上一轮就因此没复原成功）----------
const restored = await evaluate(
  flagBefore === '__undefined__'
    ? '(() => { delete window.__studioMemorySelect; return typeof window.__studioMemorySelect; })()'
    : `(() => { window.__studioMemorySelect = JSON.parse(${JSON.stringify(flagBefore)}); return String(window.__studioMemorySelect); })()`);

// ---------- 宿主 page session 证据（跑完再取：此时页面已连接、且已发生过真实发送）----------
const hostSessionEvidence = collectHostSessionEvidence(process.argv[3]);
console.log('=== 宿主 page session 证据（跑完取） ===');
console.log(JSON.stringify(hostSessionEvidence, null, 2));

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
    // v2：镜像（SSE 派生答案源）字段——Core 说答案在 data.mirror.assistantTexts 而不在 messages[].text
    mirrorInPayload: (hostSamples[0]?.payloadKeys ?? []).includes('mirror'),
    mirrorCount: hostSamples.at(-1)?.mirrorCount ?? null,
    mirrorAssistantTextCount: hostSamples.at(-1)?.mirrorAssistantTextCount ?? null,
    mirrorLastLen: hostSamples.at(-1)?.mirrorLastLen ?? null,
    mirrorHasUpper: hostSamples.at(-1)?.mirrorHasUpper ?? null,
  },
  // 正控（PM 要求）：路径正确的证据，进报告
  positiveControl: {
    pass: pcPass, ok: positiveControl.ok, count: positiveControl.count,
    reason: positiveControl.reason ?? null, messageCount: positiveControl.count ?? null,
    messageKeys: positiveControl.messageKeys ?? null,
    // 发送前的镜像基线：第五轮新增——答案靠镜像渲染时，判「本轮」要看 mirrorCount 是否增长
    mirrorCount: positiveControl.mirrorCount ?? null,
    mirrorLastLen: positiveControl.mirrorLastLen ?? null,
    mirrorHasUpper: positiveControl.mirrorHasUpper ?? null,
  },
  pageReady: { ok: readyState.ok, skeleton: readyState.skeleton ?? null, rootLen: readyState.rootLen ?? null, url: readyState.url ?? null },
  ev2_hostPageSessions: hostSessionEvidence,
  ev3_pageConvId: domSamples[0]?.convId ?? null,
  ev3_pageConvIdMatchesHost: hostSessionEvidence?.chatSessionIds?.length
    ? (domSamples[0]?.convId ?? null) !== null &&
      hostSessionEvidence.chatSessionIds.includes(domSamples[0].convId)
    : null,
  // J7：最新消息当时是否已挂载进 DOM（0 = 被虚拟列表卸载 → 纯 DOM 实现读不到）
  j7_post: post,
  // 模型是否服从指令（**真实 DOM** 里有没有大写形；不看 Studio 镜像，普通轮镜像恒空）：
  //   true  → 模型照做了，J2/J5 可直接判
  //   false → 模型没照做，本轮 J2/J5 记「待测」（不算实现 FAIL），换一轮重跑
  //   undefined → 证据缺失 → 待测
  pageAnswerHasUpper: (() => {
    const last = domSamples.at(-1);
    if (!last) return null;
    // P10 修正：两条证据任一命中即认定模型照做（只信 #root 扫描会把镜像排除在外）
    if (Array.isArray(last.domUpperHits) && last.domUpperHits.length > 0) return true;
    if (last.wideLastHasUpper === true) return true;
    return false;
  })(),
  pageAnswerHasUpperSource: (() => {
    const last = domSamples.at(-1);
    if (!last) return null;
    if (Array.isArray(last.domUpperHits) && last.domUpperHits.length > 0) return 'domUpperHits';
    if (last.wideLastHasUpper === true) return 'wideLastHasUpper';
    return 'none';
  })(),
  domUpperHitChains: domSamples.at(-1)?.domUpperHits ?? null,
  pageAnswerHasLower: domSamples.at(-1)?.domLowerHitCount ?? null,
};
console.log('=== VERDICT ===');
console.log(JSON.stringify(verdict, null, 2));

mkdirSync(join('docs', '验收', '_probe'), { recursive: true });
// 落盘前清洗：会话原文一律不留（项目规则：用户会话原文不进仓库/不进群）
// 字段名黑名单 + 超过 300 字符的字符串一律只留长度；状态/长度/布尔判定全部保留。
const DENY = new Set(['hostWouldRead', 'docNewest', 'hostFinal', 'docFinal', 'dsMarkdownLast', 'wideLastText',
  'rootTextTail', 'lastText', 'body', 'apiBody', 'answerText', 'text', 'answer', 'preTurnText']);
const scrub = (o) => {
  if (Array.isArray(o)) return o.forEach(scrub);
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      const val = o[k];
      if (typeof val === 'string') {
        if (DENY.has(k) || val.length > 300) o[k] = `[已按隐私规则删除原文 len=${val.length}]`;
      } else scrub(val);
    }
  }
  return o;
};
writeFileSync(OUT, JSON.stringify(scrub({ at: new Date().toISOString(), pageTarget: { id: page.id, url: page.url }, apiRes, verdict, hostSamples, domSamples, msel, chatReadAudit }), null, 2));
console.log('written: ' + OUT);
ws.close();
