// 卡㉘（2026-11-16，UI）：三项真机窗口的 CDP 取证探针。自包含零依赖（全局 fetch + WebSocket + Buffer），
// 用法：node cdp.mjs <command> [args] [--port 9222] [--idx N] [--url <regex>] [--raw] [--await]
//   targets                          列 CDP targets（type/url/title）——runtime 锚定先跑这条
//   eval "<expr>"                    在聊天页 Runtime.evaluate
//   flag-on | flag-off               置/删 globalThis.__studioMemorySelect
//                                    （C1-F1 起页端是动态 getter 读，**无需 reload**；
//                                      依据 src/desktop/entry.ts：enabled: () => Boolean(globalThis.__studioMemorySelect)）
//   send "<text>"  |  send --b64 <base64>
//                                    填聊天输入框＋点发送（⑩-b 实发消息同形技术：原型 setter＋InputEvent＋按钮坐标点击）
//   dom "<selector>"                 每个命中的 tag/class/rect/innerText(截 200)——审批弹窗文案取证（主证据）
//   grep-dom "<selector> <regex>"    目标 DOM innerText 正则 grep（协议名残留面，预期 0 命中）
//   console-tap "<pattern>" [秒]     订阅 Runtime.consoleAPICalled，按正则抓页端 console 行（默认 10s）
//   shot <out.png>                   Page.captureScreenshot（**只作辅助证据**，不作唯一判据）
// 退出码：0 ok · 2 用法错 · 3 端口不可达或无目标 · 4 eval 异常
// 端口：dev 实例 9222 缺省开（debug 构建）；装版（release 构建）可能不开——不可达时按 JUDGE.md §4 走文件面取证。
// 目标选择：缺省 = url 命中 /chat\.deepseek\.com/ 的 page；--idx 按 targets 序号；--url 自定义正则。

const args = process.argv.slice(2);

function take(name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] === undefined ? true : args[i + 1];
}
function takeStr(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
function has(name) {
  return args.includes(name);
}

const cmd = args[0];
if (!cmd) {
  console.error('usage: node cdp.mjs <targets|eval|flag-on|flag-off|send|dom|grep-dom|console-tap|shot> [args] [--port N] [--idx N] [--url <re>]');
  process.exit(2);
}

const port = takeStr('--port') ?? process.env.STUDIO_CDP_PORT ?? '9222';
const urlRe = takeStr('--url');
const idxArg = takeStr('--idx');
const idx = idxArg === undefined ? undefined : Number(idxArg);

let targets;
try {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  targets = await res.json();
} catch (e) {
  console.error(`PORT_CLOSED port=${port}: ${e.message}`);
  process.exit(3);
}

function pickTarget() {
  if (idx !== undefined) return targets[idx];
  if (urlRe) {
    const re = new RegExp(urlRe);
    return targets.find((t) => t.type === 'page' && re.test(t.url));
  }
  return (
    targets.find((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url)) ??
    targets.find((t) => t.type === 'page')
  );
}

if (cmd === 'targets') {
  const brief = targets.map((t, i) => ({ i, type: t.type, url: t.url, title: t.title ?? '' }));
  console.log(JSON.stringify({ port, count: targets.length, targets: brief }, null, 2));
  process.exit(targets.length === 0 ? 3 : 0);
}

const target = pickTarget();
if (!target || !target.webSocketDebuggerUrl) {
  console.error('NO_TARGET: ' + JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url }))));
  process.exit(3);
}
console.log(`TARGET idx=${targets.indexOf(target)} url=${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const eventLog = [];
function send(method, params = {}) {
  const id = nextId++;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  ws.send(JSON.stringify({ id, method, params }));
  return p;
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
  } else if (msg.method) {
    eventLog.push(msg);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws-open-failed')), { once: true });
});

async function evaluate(expression, { raw = false, awaitPromise = false } = {}) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    timeout: 60000,
  });
  if (res.exceptionDetails) {
    console.log('EXCEPTION: ' + JSON.stringify(res.exceptionDetails));
    process.exit(4);
  }
  const v = res.result?.value;
  console.log(raw ? String(v) : JSON.stringify(v, null, 2));
  return v;
}

switch (cmd) {
  case 'eval': {
    const expr = args.slice(1).find((a) => !a.startsWith('--')) ?? '';
    if (!expr) process.exit(2);
    await evaluate(expr, { raw: has('--raw'), awaitPromise: has('--await') });
    break;
  }
  case 'flag-on':
  case 'flag-off': {
    const on = cmd === 'flag-on';
    const expr = on
      ? '(() => { globalThis.__studioMemorySelect = true; return { flag: true }; })()'
      : '(() => { delete globalThis.__studioMemorySelect; return { flag: globalThis.__studioMemorySelect === true }; })()';
    await evaluate(expr);
    break;
  }
  case 'send': {
    let text;
    const b64 = takeStr('--b64');
    if (b64 !== undefined) text = Buffer.from(b64, 'base64').toString('utf8');
    else text = args.slice(1).find((a) => !a.startsWith('--'));
    if (!text) {
      console.error('usage: send "<text>" | send --b64 <base64>');
      process.exit(2);
    }
    const fill = await evaluate(
      `(() => {
        const prompt = ${JSON.stringify(text)};
        const ta = document.querySelector('textarea[placeholder*="DeepSeek"]') || document.querySelector('textarea');
        let via = 'textarea';
        if (ta) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')?.set;
          setter?.call(ta, prompt);
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          ta.focus();
        } else {
          via = 'contenteditable';
          const ce = document.querySelector('[contenteditable="true"]');
          if (!ce) return { ok: false, reason: 'input-not-found' };
          ce.textContent = prompt;
          ce.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
          ce.focus();
        }
        return { ok: true, via, len: prompt.length };
      })()`,
    );
    if (!fill?.ok) {
      console.log('SEND-FAIL: ' + JSON.stringify(fill));
      process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 600));
    const locate = await evaluate(
      `(() => {
        let btn = document.querySelector('[role="button"].ds-button--primary:not(.ds-button--disabled)');
        let cls = 'ds-button--primary';
        if (!btn) {
          const cands = [...document.querySelectorAll('button:not([disabled])')];
          btn = cands[cands.length - 1];
          cls = btn ? String(btn.className) : 'none';
        }
        if (!btn) return { ok: false, reason: 'send-button-not-found-or-disabled' };
        const r = btn.getBoundingClientRect();
        return { ok: true, cls, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
    );
    if (!locate?.ok) {
      console.log('SEND-FAIL: ' + JSON.stringify(locate));
      process.exitCode = 1;
      break;
    }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: locate.x, y: locate.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: locate.x, y: locate.y, button: 'left', clickCount: 1 });
    console.log('[sent] via=' + fill.via + ' btn=' + locate.cls);
    break;
  }
  case 'dom': {
    const sel = takeStr('--sel') ?? args.slice(1).find((a) => !a.startsWith('--'));
    if (!sel) process.exit(2);
    await evaluate(
      `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
        return els.map((el, i) => ({
          i, tag: el.tagName, cls: String(el.className).slice(0, 120),
          text: (el.innerText || '').slice(0, 200),
          rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(el.getBoundingClientRect()),
        }));
      })()`,
    );
    break;
  }
  case 'grep-dom': {
    const spec = args.slice(1).find((a) => !a.startsWith('--'));
    const m = spec?.match(/^([\s\S]+?)\s+(\/.+\/(?:[a-z]*))$/i);
    if (!m) {
      console.error('usage: grep-dom "<selector> /regex/[imsu]*"');
      process.exit(2);
    }
    const sel = m[1];
    const reSrc = m[2];
    await evaluate(
      `(() => {
        const re = new RegExp(${JSON.stringify(reSrc)});
        const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
        const hits = [];
        for (const el of els) {
          const text = el.innerText || '';
          for (const line of text.split('\\n')) if (re.test(line)) hits.push(line.trim().slice(0, 160));
        }
        return { selector: ${JSON.stringify(sel)}, regex: ${JSON.stringify(reSrc)}, hits: hits.length, sample: hits.slice(0, 10) };
      })()`,
    );
    break;
  }
  case 'console-tap': {
    const pattern = args.slice(1).find((a) => !a.startsWith('--')) ?? '';
    const secs = Number(takeStr('--secs') ?? 10);
    if (!pattern) {
      console.error('usage: console-tap "<pattern>" [--secs N]');
      process.exit(2);
    }
    const re = new RegExp(pattern);
    await send('Runtime.enable');
    const since = Date.now();
    await new Promise((r) => setTimeout(r, secs * 1000));
    const lines = eventLog
      .filter((m) => m.method === 'Runtime.consoleAPICalled')
      .map((m) => {
        const text = (m.params?.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        return { ts: Date.now() - since, type: m.params.type, text: String(text).slice(0, 400) };
      })
      .filter((l) => re.test(l.text));
    console.log(JSON.stringify({ pattern, windowMs: secs * 1000, matched: lines.length, lines: lines.slice(0, 200) }, null, 2));
    break;
  }
  case 'shot': {
    const out = takeStr('--out') ?? args.slice(1).find((a) => !a.startsWith('--'));
    if (!out) {
      console.error('usage: shot <out.png>');
      process.exit(2);
    }
    await send('Page.enable');
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, buf);
    console.log(`[shot] ${out} ${buf.length} B`);
    break;
  }
  default:
    console.error('unknown command: ' + cmd);
    process.exit(2);
}

ws.close();
process.exit(process.exitCode ?? 0);
