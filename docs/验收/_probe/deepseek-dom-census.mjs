// DeepSeek 真实消息 DOM 普查 v3（只读）→ 直接产出「选择器配方」交 Core 写 chat-read
//
//   node docs/验收/_probe/deepseek-dom-census.mjs [conversationUrl] [--with-text]
//
// 只读约束（Studio-PM 定）：只打开**既有会话**、不发任何消息、不改页面。
//
// 【隐私】默认**结构模式**：只输出类名/计数/长度，**不留任何页面文本原文**。
//   原因：DeepSeek 页面左侧栏是用户真实会话列表（真实标题就在 DOM 里），
//   任何一次 DOM 普查都会碰到它。--with-text 仅允许用于**探针自己创建的会话**，
//   且需自行确认页面里没有用户真实内容；其余一律结构模式。
//
// v3 相比 v2 的修正：
//   ① 等主区渲染完再采样（v2 在骨架屏阶段就采，只有 ds-skeleton，什么都没采到）
//   ② className 取值兼容 SVG（SVGAnimatedString 会拆出 "[object" 这类垃圾类名）
//   ③ 默认结构模式（v2 默认留原文 → 产物里混进了用户会话标题，已清理）
//   ④ 主区/侧边栏分开统计，避免把侧边栏当消息列表
//
// 产出：A 结构画像 / B 消息节点定位 / C 选择器配方（Core 可直接挑一条写进 chat-read.ts）
const WITH_TEXT = process.argv.includes('--with-text');
const STRUCTURE_ONLY = !WITH_TEXT;
const conversationUrl = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'https://chat.deepseek.com/a/chat/s/33507439-d490-4054-bbbc-dcd3d4d6f37a';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const pages = list.filter((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url));
if (!pages.length) { console.error('NO_PAGE chat.deepseek.com; targets=' + JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })))); process.exit(3); }
const page = pages[0];
console.log(`page id=${page.id} url=${page.url}  mode=${STRUCTURE_ONLY ? 'structure-only' : 'with-text'}`);

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
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 60000 });
  if (res.result?.exceptionDetails) return { __exception: JSON.stringify(res.result.exceptionDetails).slice(0, 400) };
  return res.result?.result?.value;
};

// ---- 打开既有会话（只导航，不发消息）----
const cur = await evaluate('location.href');
if (cur !== conversationUrl) {
  console.log(`navigate -> ${conversationUrl}`);
  await send('Page.navigate', { url: conversationUrl });
}

// ---- 等主区渲染完：骨架消失 + #root 文本长度连续两次稳定且 > 500 ----
const READY_PROBE = `(() => ({
  skeleton: document.querySelectorAll('[class*="ds-skeleton"]').length,
  rootLen: (document.querySelector('#root')?.textContent ?? '').replace(/\\s+/g,' ').trim().length,
  bodyLen: (document.body?.textContent ?? '').replace(/\\s+/g,' ').trim().length,
  url: location.href,
}))()`;
let ready = { ok: false };
let prevLen = -1, stable = 0;
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const s = await evaluate(READY_PROBE);
  if (s && s.__exception) { console.log('probe error: ' + s.__exception); break; }
  if (s && s.skeleton === 0 && s.rootLen > 500 && s.rootLen === prevLen) {
    stable += 1;
    if (stable >= 2) { ready = { ok: true, ...s, waitedMs: 90000 - (deadline - Date.now()) }; break; }
  } else { stable = 0; }
  prevLen = s?.rootLen ?? -1;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('=== 主区就绪探测 ===');
console.log(JSON.stringify(ready, null, 2));
if (!ready.ok) console.log('!! 主区未在 90s 内稳定渲染完，普查结果可能只覆盖骨架/侧边栏 —— 请如实读数后再用');

const CENSUS = `(() => {
  const STUDIO = /^(ds-studio|studio-|ds-sc-|ds-flow-|ds-tool-|ds-notification)/;
  const clsOf = (n) => { const c = (typeof n.className === 'string') ? n.className : (n.getAttribute && n.getAttribute('class')) || ''; return c; };
  const rawTxt = (n) => (n ? (n.textContent ?? '').replace(/\\s+/g, ' ').trim() : '');
  const STRUCTURE_ONLY = __STRUCTURE_ONLY__;
  const txt = (n) => { const t = rawTxt(n); return STRUCTURE_ONLY ? (t.length ? '<len:' + t.length + '>' : '') : t; };
  const chainOf = (n) => { const out = []; let p = n; while (p && p !== document.body) { out.push(p.tagName + '.' + clsOf(p).split(/\\s+/).slice(0,3).join('.')); p = p.parentElement; } return out.slice(0, 10); };
  // 侧边栏判据用**几何**（左窄列），不能用 closest('[class*="scroll-area"]')——
  // 对话消息列表本身也是 scroll-area，会把主区误判成侧边栏（v3 第一版就踩了：mainLeaves=4）
  const isSide = (n) => {
    try { const r = n.getBoundingClientRect(); if (!r.width || !r.height) return false; return r.left < 360 && r.width < 460; }
    catch (e) { return false; }
  };
  const sidebarLink = (n) => isSide(n);

  // A) DeepSeek 侧类名频次（排除 Studio 注入层）
  const freq = {};
  for (const n of document.querySelectorAll('#root *')) {
    for (const c of clsOf(n).split(/\\s+/)) {
      if (!c || STUDIO.test(c)) continue;
      freq[c] = (freq[c]||0)+1;
    }
  }
  const classFreq = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0, 45);

  // A2) 虚拟列表结构（若存在）
  const vlists = Array.from(document.querySelectorAll('[class*="virtual-list"]')).map(v => ({
    cls: clsOf(v).slice(0,90), childCount: v.children.length,
    children: Array.from(v.children).slice(0,10).map(c => ({
      cls: clsOf(c).slice(0,90), len: rawTxt(c).length, kids: c.children.length,
      kidClasses: Array.from(c.children).slice(0,5).map(k => clsOf(k).slice(0,70)),
    })),
  }));

  // B) 文本叶子：区分「侧边栏」与「主区」
  const leaves = Array.from(document.querySelectorAll('#root p, #root span, #root div'))
    .filter(n => n.children.length === 0 && rawTxt(n).length > 0);
  const leavesMain = leaves.filter(n => !sidebarLink(n));
  const leavesSide = leaves.filter(n => sidebarLink(n));
  const leavesTail = leavesMain.slice(-16).map(n => ({
    len: rawTxt(n).length, text: txt(n).slice(0, 110),
    chain: chainOf(n),
  }));

  // C) 选择器配方：对候选选择器实测命中数 + 末条长度（不取原文，除非 with-text）
  const evalSel = (sel) => {
    try {
      const ns = Array.from(document.querySelectorAll(sel));
      const last = ns.at(-1);
      return { sel, n: ns.length, lastLen: last ? rawTxt(last).length : null, last: last ? txt(last).slice(0,110) : null,
               lastInSidebar: last ? sidebarLink(last) : null };
    } catch (e) { return { sel, err: String(e).slice(0,80) }; }
  };
  const candidates = new Set();
  for (const s of ['#root', '.ds-virtual-list', '.ds-virtual-list-items', '.ds-virtual-list-visible-items',
                   '[class*="virtual-list"] > *', '[class*="virtual-list-items"] > *',
                   '.ds-markdown', '.ds-assistant-message-main-content', '#chat-container', '#chat-messages > *',
                   '[class*="message"]', '[class*="msg"]', '[class*="markdown"]', '[class*="chat"]']) candidates.add(s);
  for (const l of leavesTail.slice(-8)) {
    for (const anc of l.chain) {
      const m = /\\.([A-Za-z_][\\w-]*)/.exec(anc);
      if (m && !STUDIO.test(m[1])) { candidates.add('.' + m[1]); candidates.add('#root .' + m[1]); }
    }
  }
  const recipe = [...candidates].map(evalSel)
    .filter(r => r.n > 0 && r.lastInSidebar !== true)
    .sort((a,b)=>b.n - a.n);

  // C2) 主区大文本块（对话正文所在容器）
  const bigBlocks = Array.from(document.querySelectorAll('#root div'))
    .filter(n => rawTxt(n).length > 200 && !sidebarLink(n))
    .slice(-8)
    .map(n => ({ cls: clsOf(n).slice(0,90), len: rawTxt(n).length, kids: n.children.length, chain: chainOf(n) }));

  return { url: location.href, title: document.title,
           counts: { totalLeaves: leaves.length, mainLeaves: leavesMain.length, sidebarLeaves: leavesSide.length,
                     rootNodes: document.querySelectorAll('#root *').length, rootLen: readyRootLen(), skeletons: document.querySelectorAll('[class*="ds-skeleton"]').length },
           classFreq, vlists, leavesTail, recipe, bigBlocks };
})()`.replace('readyRootLen()', "((document.querySelector('#root')?.textContent ?? '').replace(/\\s+/g,' ').trim().length)");

const census = await evaluate(CENSUS.replace('__STRUCTURE_ONLY__', JSON.stringify(STRUCTURE_ONLY)));
console.log(JSON.stringify(census, null, 2));
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('docs/验收/_probe', { recursive: true });
const out = `docs/验收/_probe/deepseek-dom-census-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`;
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), mode: STRUCTURE_ONLY ? 'structure-only' : 'with-text', page: { id: page.id }, conversationUrl, ready, census }, null, 2));
console.log('written: ' + out);
ws.close();
