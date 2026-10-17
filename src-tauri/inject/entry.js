"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __typeError = (msg2) => {
    throw TypeError(msg2);
  };
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  var __accessCheck = (obj, member, msg2) => member.has(obj) || __typeError("Cannot " + msg2);
  var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
  var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

  // src/inject/direct-target.ts
  var buses = /* @__PURE__ */ new Map();
  function busFor(origin2) {
    let bus = buses.get(origin2);
    if (!bus) {
      bus = new EventTarget();
      buses.set(origin2, bus);
    }
    return bus;
  }
  function createDirectTarget(origin2) {
    const bus = busFor(origin2);
    const wrapped = /* @__PURE__ */ new WeakMap();
    const self = {
      origin: origin2,
      postMessage(data) {
        self._dispatch(data, self, []);
      },
      addEventListener(type, listener) {
        const fn = (e) => listener(e.detail);
        wrapped.set(listener, fn);
        bus.addEventListener(type, fn);
      },
      removeEventListener(type, listener) {
        const fn = wrapped.get(listener);
        if (fn) bus.removeEventListener(type, fn);
      },
      _dispatch(data, source, ports) {
        const ev = new Event("message");
        ev.detail = { data, origin: origin2, source, ports };
        bus.dispatchEvent(ev);
      }
    };
    return self;
  }

  // src/inject/direct-port.ts
  function createDirectMessagePort(options2) {
    const { target, sessionId, reportError } = options2;
    const handlers = /* @__PURE__ */ new Set();
    const listener = (event) => {
      const data = event.data;
      if (!data || data.__session !== sessionId) return;
      if (data.__payload) {
        for (const h2 of [...handlers]) {
          try {
            h2(data.__payload);
          } catch (err) {
            reportError?.("direct-port onMessage handler threw", err);
          }
        }
      }
    };
    target.addEventListener("message", listener);
    return {
      sessionId,
      post(message) {
        target.postMessage({ __session: sessionId, __payload: message });
      },
      onMessage(h2) {
        handlers.add(h2);
        return () => handlers.delete(h2);
      },
      close() {
        target.removeEventListener("message", listener);
        handlers.clear();
      }
    };
  }

  // src/inject/direct-bridge.ts
  function createDirectBridge(options2) {
    const { target, sessionId, reportError } = options2;
    let port;
    return {
      origin: target.origin,
      sessionId,
      get connected() {
        return port !== void 0;
      },
      start() {
        if (port) return;
        port = createDirectMessagePort({ target, sessionId, reportError });
      },
      post(message) {
        if (!port) throw new Error("direct-bridge: not connected; call start() first");
        port.post(message);
      },
      onMessage(listener) {
        if (!port) this.start();
        return port.onMessage(listener);
      },
      acceptsSession(candidate) {
        return candidate.origin === target.origin && candidate.sessionId === sessionId;
      },
      disconnect() {
        port?.close();
        port = void 0;
      }
    };
  }

  // src/inject/bridge-install.ts
  function installDirectBridge(options2) {
    const target = options2.target ?? createDirectTarget(options2.origin);
    const content = createDirectBridge({ target, sessionId: options2.sessionId, reportError: options2.reportError });
    const injected = createDirectBridge({ target, sessionId: options2.sessionId, reportError: options2.reportError });
    content.start();
    injected.start();
    return {
      target,
      content,
      injected,
      disconnect() {
        content.disconnect();
        injected.disconnect();
      }
    };
  }

  // src/inject/origin-guard.ts
  var DEFAULT_ORIGIN_WHITELIST = ["https://chat.deepseek.com"];
  function normalizeOrigin(origin2) {
    if (!origin2) return "";
    return origin2.trim().toLowerCase();
  }
  function isAllowedOrigin(locationOrigin2, whitelist = DEFAULT_ORIGIN_WHITELIST) {
    const origin2 = normalizeOrigin(locationOrigin2);
    if (!origin2) return false;
    return whitelist.map(normalizeOrigin).includes(origin2);
  }

  // src/inject/navigation.ts
  function createNavigationObserver(options2 = {}) {
    const enabled = options2.reinjectOnRouteChange ?? false;
    const max = options2.maxReinjections ?? 8;
    let count = 0;
    let stopped2 = false;
    const history = globalThis.history;
    const trigger = () => {
      if (stopped2 || !enabled) return;
      if (count >= max) {
        options2.onLimit?.(count);
        return;
      }
      count += 1;
      options2.onReinject?.();
    };
    const patchedPush = history?.pushState?.bind(history);
    const patchedReplace = history?.replaceState?.bind(history);
    const onPop = () => trigger();
    if (enabled && history && patchedPush && patchedReplace) {
      history.pushState = (...args) => {
        patchedPush(...args);
        trigger();
      };
      history.replaceState = (...args) => {
        patchedReplace(...args);
        trigger();
      };
      globalThis.addEventListener("popstate", onPop);
      globalThis.addEventListener("hashchange", onPop);
    }
    return {
      start() {
        stopped2 = false;
      },
      stop() {
        stopped2 = true;
        if (enabled && history) {
          globalThis.removeEventListener("popstate", onPop);
          globalThis.removeEventListener("hashchange", onPop);
        }
      },
      get reinjectionCount() {
        return count;
      }
    };
  }

  // src/inject/lifecycle.ts
  function noopScope() {
    const noop = () => void 0;
    return {
      signal: new AbortController().signal,
      active: true,
      addCleanup: () => async () => noop(),
      listen: () => async () => noop(),
      observe: () => async () => noop(),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (t) => clearTimeout(t),
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (t) => clearInterval(t),
      requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
      cancelAnimationFrame: (f2) => clearTimeout(f2),
      ownRoot: (r) => r,
      ownPort: (r) => r,
      snapshot: () => ({ total: 0, byKind: {} })
    };
  }
  function createLocalContentLifecycle(options2) {
    const caps = options2.capabilities;
    const kernel = {
      async start() {
        for (const c of caps) await c.start(noopScope(), 1);
        return 1;
      },
      async stop(_reason) {
        for (const c of caps) await c.stop(_reason);
      },
      snapshot: () => ({
        state: "running",
        epoch: 1,
        resources: { total: 0, byKind: {} },
        capabilities: {}
      })
    };
    return { kernel, start: kernel.start, dispose: kernel.stop };
  }
  var replaceContentDocumentLifecycle = async (options2) => createLocalContentLifecycle({ capabilities: options2.capabilities });

  // src/inject/loader.ts
  var SYMBOL_KEY = "deepseek-studio.injection-loader";
  var registry = /* @__PURE__ */ new Map();
  function locationOrigin() {
    return globalThis.location?.origin;
  }
  async function defaultLifecycleFactory(options2) {
    return replaceContentDocumentLifecycle(options2);
  }
  function createInjector(options2) {
    const whitelist = options2.originWhitelist ?? DEFAULT_ORIGIN_WHITELIST;
    const factory = options2.lifecycleFactory ?? defaultLifecycleFactory;
    const navigation = createNavigationObserver({
      reinjectOnRouteChange: options2.reinjectOnRouteChange,
      maxReinjections: options2.maxReinjections,
      onReinject: () => void reinject(),
      onLimit: (c) => console.warn(`[injection-loader] reinjection limit ${c} reached, skip`)
    });
    let lifecycle;
    let status = "pending";
    let generation = 0;
    let installed = false;
    function verifyInstallOrder() {
      const rs = globalThis.document?.readyState;
      const ok = rs === "loading" || rs === void 0;
      if (!ok && options2.strictInstallOrder) {
        status = "failed";
        return false;
      }
      if (!ok) console.warn('[injection-loader] readyState !== "loading"; proceeding (fail-open)');
      return true;
    }
    async function startLifecycle() {
      try {
        lifecycle = await factory({
          capabilities: options2.capabilities,
          onError: (error, _capabilityId) => {
            status = "failed";
            options2.onStartupError?.(error);
          }
        });
        await lifecycle.start();
        status = "running";
      } catch (error) {
        status = "failed";
        options2.onStartupError?.(error);
      }
    }
    async function reinject() {
      if (!lifecycle) return;
      await lifecycle.dispose("reinjection");
      generation += 1;
      await startLifecycle();
    }
    return {
      install() {
        if (installed) {
          return { installed: false, status, generation, reason: "already-installed" };
        }
        if (!isAllowedOrigin(locationOrigin(), whitelist)) {
          installed = true;
          status = "skipped";
          return { installed: true, status: "skipped", generation, reason: "origin-not-allowed" };
        }
        if (!verifyInstallOrder()) {
          installed = true;
          return { installed: false, status: "failed", generation, reason: "install-order" };
        }
        installed = true;
        generation += 1;
        status = "running";
        void startLifecycle();
        navigation.start();
        return { installed: true, status: "running", generation };
      },
      getLifecycle: () => lifecycle,
      getStatus: () => status,
      getGeneration: () => generation,
      async dispose(reason = "manual") {
        navigation.stop();
        if (lifecycle) await lifecycle.dispose(reason);
      }
    };
  }
  function bootstrapInjection(options2) {
    const sym = Symbol.for(SYMBOL_KEY);
    const existing = registry.get(sym);
    if (existing) return existing.install();
    const injector = createInjector(options2);
    registry.set(sym, injector);
    return injector.install();
  }

  // src/capabilities/echo.ts
  var lastExecutedAt = 0;
  function createEchoCapability() {
    return {
      id: "echo",
      start(scope) {
        scope.addCleanup("listener", () => {
          lastExecutedAt = Date.now();
        });
        lastExecutedAt = Date.now();
      },
      async stop() {
      },
      async execute() {
        return { ok: true };
      }
    };
  }

  // src/capabilities/dom.ts
  function queryAll(root, selectors) {
    for (const sel of selectors) {
      const found = Array.from(root.querySelectorAll(sel));
      if (found.length > 0) return found;
    }
    return [];
  }
  function queryFirst(root, selectors) {
    for (const sel of selectors) {
      const found = root.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  function setInputValue(el2, value) {
    const fireInput = () => {
      el2.dispatchEvent(new Event("input", { bubbles: true }));
    };
    if (el2 instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(el2, value);
      else el2.value = value;
      fireInput();
      return true;
    }
    if (el2 instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el2, value);
      else el2.value = value;
      fireInput();
      return true;
    }
    if (el2 instanceof HTMLElement && (el2.isContentEditable || el2.getAttribute("contenteditable") === "true")) {
      el2.textContent = value;
      fireInput();
      return true;
    }
    return false;
  }
  function pressEnter(el2) {
    const init = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    el2.dispatchEvent(new KeyboardEvent("keydown", init));
    el2.dispatchEvent(new KeyboardEvent("keypress", init));
    el2.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  }
  function clickElement(el2) {
    if (el2 instanceof HTMLElement) {
      el2.click();
      return true;
    }
    return false;
  }

  // src/capabilities/chat-read.ts
  var MESSAGE_SELECTORS = [
    ".ds-assistant-message-main-content",
    ".ds-markdown",
    '[class*="message-item"]',
    '[class*="chat-message"]',
    "#chat-messages > *",
    ".message"
  ];
  var USER_HINT = /(^|\s)(user|human|你|我发)/i;
  var ASSISTANT_HINT = /(^|\s)(assistant|bot|ai|deepseek|助理|助手|思考|reasoning)/i;
  function inferRole(el2) {
    const cls = (typeof el2.className === "string" ? el2.className : "").toLowerCase();
    const head = (el2.textContent ?? "").slice(0, 48);
    if (USER_HINT.test(cls) || USER_HINT.test(head)) return "user";
    if (ASSISTANT_HINT.test(cls) || ASSISTANT_HINT.test(head)) return "assistant";
    return "unknown";
  }
  function createChatReadCapability() {
    return {
      id: "chat-read",
      start() {
      },
      async stop() {
      },
      async execute() {
        const doc = globalThis.document;
        if (!doc) return { ok: false, error: "no-document" };
        const root = doc.querySelector("#chat-container") ?? doc.body;
        const nodes = queryAll(root, MESSAGE_SELECTORS);
        if (nodes.length === 0) return { ok: false, error: "no-messages-found" };
        const messages = nodes.map((n) => ({ role: inferRole(n), text: (n.textContent ?? "").replace(/\s+/g, " ").trim() })).filter((m) => m.text.length > 0);
        return { ok: true, data: { count: messages.length, messages } };
      }
    };
  }

  // src/capabilities/chat-insert.ts
  var INPUT_SELECTORS = [
    "textarea#chat-input",
    "#chat-input",
    '[contenteditable="true"]',
    "textarea",
    ".chat-input"
  ];
  function createChatInsertCapability() {
    return {
      id: "chat-insert",
      start() {
      },
      async stop() {
      },
      async execute(params) {
        const text = typeof params.text === "string" ? params.text : "";
        if (text.length === 0) return { ok: false, error: "missing-text" };
        const doc = globalThis.document;
        if (!doc) return { ok: false, error: "no-document" };
        const el2 = queryFirst(doc, INPUT_SELECTORS);
        if (!el2) return { ok: false, error: "input-not-found" };
        if (!setInputValue(el2, text)) return { ok: false, error: "input-not-writable" };
        return { ok: true, data: { inserted: text.length } };
      }
    };
  }

  // src/capabilities/chat-send.ts
  var LEGACY_SEND_SELECTORS = [
    '[data-testid="send-button"]',
    'button[aria-label*="\u53D1\u9001" i]',
    'button[aria-label*="send" i]',
    ".send-button",
    'button[type="submit"]'
  ];
  function findInput(doc) {
    const ta = Array.from(doc.querySelectorAll("textarea")).find((t) => t.offsetWidth > 0);
    if (ta) return ta;
    return queryFirst(doc, ['[contenteditable="true"]']);
  }
  function findSendButtonNear(input) {
    let p = input;
    for (let depth = 0; depth < 6 && p; depth++) {
      p = p.parentElement;
      if (!p) break;
      const btn = queryFirst(p, [
        "div.ds-button--circle",
        ".ds-button--circle",
        "div.ds-button--filled",
        '[role="button"][aria-disabled="false"]'
      ]);
      if (btn && btn.offsetWidth > 0) return btn;
    }
    return null;
  }
  function findGlobalSendButton(doc) {
    return queryFirst(doc, [
      "div.ds-button--circle",
      ".ds-button--circle"
    ]);
  }
  function readInputValue(el2) {
    if (el2 instanceof HTMLTextAreaElement || el2 instanceof HTMLInputElement) return el2.value;
    return el2.textContent ?? "";
  }
  function createChatSendCapability() {
    return {
      id: "chat-send",
      start() {
      },
      async stop() {
      },
      async execute() {
        const doc = globalThis.document;
        if (!doc) return { ok: false, error: "no-document" };
        const input = findInput(doc);
        if (input) {
          const near = findSendButtonNear(input);
          if (near && clickElement(near)) return { ok: true, data: { sent: true, via: "circle-button-near" } };
        }
        const globalBtn = findGlobalSendButton(doc);
        if (globalBtn && clickElement(globalBtn)) {
          return { ok: true, data: { sent: true, via: "circle-button-global" } };
        }
        const legacy = queryFirst(doc, LEGACY_SEND_SELECTORS);
        if (legacy && clickElement(legacy)) return { ok: true, data: { sent: true, via: "legacy-button" } };
        if (input) {
          const before = readInputValue(input);
          pressEnter(input);
          const after = readInputValue(input);
          if (before.length === 0 || after.length === 0 || after !== before) {
            return { ok: true, data: { sent: true, via: "enter-key" } };
          }
          return {
            ok: false,
            error: "send-unconfirmed",
            data: { via: "enter-key", hint: "\u5408\u6210 Enter \u672A\u88AB\u91C7\u7EB3\uFF0C\u8F93\u5165\u6846\u5185\u5BB9\u672A\u53D8" }
          };
        }
        return { ok: false, error: "send-button-not-found" };
      }
    };
  }

  // src/ui/consent.ts
  var STYLE_ID = "ds-consent-style";
  var CSS = `
.ds-consent-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(2px);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  animation: ds-consent-fade 120ms ease-out;
}
.ds-consent-card {
  min-width: 300px; max-width: 420px; padding: 20px 22px;
  border-radius: 16px; background: rgba(255,255,255,0.92);
  box-shadow: 0 12px 40px rgba(20,30,60,0.25);
  border: 1px solid rgba(77,107,254,0.18);
  color: #1F2329; animation: ds-consent-pop 120ms ease-out;
}
@media (prefers-color-scheme: dark) {
  .ds-consent-card { background: rgba(30,31,35,0.94); color: #E8EAED; border-color: rgba(77,107,254,0.35); }
}
.ds-consent-title { font-size: 13px; font-weight: 500; opacity: 0.7; }
.ds-consent-tool {
  margin-top: 8px; font-size: 15px; font-weight: 600; color: #4D6BFE;
}
@media (prefers-color-scheme: dark) { .ds-consent-tool { color: #6E8BFF; } }
.ds-consent-summary {
  margin-top: 10px; font-size: 13px; line-height: 1.5; opacity: 0.85;
  max-height: 140px; overflow: auto; word-break: break-all;
}
.ds-consent-badges { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.ds-consent-badge {
  font-size: 11px; line-height: 1.4; padding: 2px 8px; border-radius: 999px;
  background: rgba(77,107,254,0.12); color: #4D6BFE; border: 1px solid rgba(77,107,254,0.25);
}
.ds-consent-badge[data-level="danger"] {
  background: rgba(212,56,13,0.12); color: #D4380D; border-color: rgba(212,56,13,0.3);
}
.ds-consent-badge[data-level="warn"] {
  background: rgba(212,138,13,0.14); color: #B26A00; border-color: rgba(212,138,13,0.3);
}
@media (prefers-color-scheme: dark) {
  .ds-consent-badge[data-level="danger"] { color: #FF7A5C; }
  .ds-consent-badge[data-level="warn"] { color: #E8A33D; }
}
.ds-consent-actions { margin-top: 18px; display: flex; gap: 10px; justify-content: flex-end; }
.ds-consent-actions button {
  border: none; border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 500;
  cursor: pointer; transition: transform 80ms ease, filter 80ms ease;
}
.ds-consent-actions button:hover { filter: brightness(1.05); }
.ds-consent-actions button:active { transform: scale(0.97); }
.ds-consent-deny { background: rgba(212,56,13,0.12); color: #D4380D; }
.ds-consent-allow-once { background: #4D6BFE; color: #fff; }
.ds-consent-allow-session { background: rgba(43,164,113,0.14); color: #2BA471; }
@keyframes ds-consent-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ds-consent-pop { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;
  function ensureStyles() {
    if (globalThis.document.getElementById(STYLE_ID)) return;
    const style = globalThis.document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    globalThis.document.head.appendChild(style);
  }
  function showConsent(request, onDecision) {
    const doc = globalThis.document;
    const timeoutMs = request.timeoutMs ?? 6e4;
    let settled = false;
    let timer;
    ensureStyles();
    const overlay = doc.createElement("div");
    overlay.className = "ds-consent-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const card = doc.createElement("div");
    card.className = "ds-consent-card";
    const title = doc.createElement("div");
    title.className = "ds-consent-title";
    title.textContent = "DeepSeek++ Studio \u8BF7\u6C42\u6267\u884C\u5DE5\u5177";
    const tool = doc.createElement("div");
    tool.className = "ds-consent-tool";
    tool.textContent = request.tool;
    const badges = buildBadges(request.meta);
    const summary = doc.createElement("div");
    summary.className = "ds-consent-summary";
    summary.textContent = summarizeParams(request.params);
    const actions = doc.createElement("div");
    actions.className = "ds-consent-actions";
    const btnAllowOnce = mkButton("\u5141\u8BB8\u4E00\u6B21", "ds-consent-allow-once");
    const btnDeny = mkButton("\u62D2\u7EDD", "ds-consent-deny");
    const btnAllowSession = mkButton("\u672C\u6B21\u4F1A\u8BDD\u5141\u8BB8", "ds-consent-allow-session");
    actions.append(btnAllowOnce, btnDeny, btnAllowSession);
    card.append(title, tool, ...badges ? [badges] : [], summary, actions);
    overlay.append(card);
    doc.body.append(overlay);
    function settle(decision) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      overlay.remove();
      doc.removeEventListener("keydown", onKey);
      onDecision(decision);
    }
    function onKey(e) {
      if (e.key === "Escape") settle("deny");
      else if (e.key === "Enter") settle("allow-once");
    }
    btnAllowOnce.addEventListener("click", () => settle("allow-once"));
    btnDeny.addEventListener("click", () => settle("deny"));
    btnAllowSession.addEventListener("click", () => settle("allow-session"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) settle("deny");
    });
    doc.addEventListener("keydown", onKey);
    timer = setTimeout(() => settle("deny"), timeoutMs);
    return {
      decide: settle,
      dispose() {
        if (timer) clearTimeout(timer);
        overlay.remove();
        doc.removeEventListener("keydown", onKey);
      }
    };
  }
  function buildBadges(meta) {
    if (!meta) return null;
    const items = [];
    if (meta.riskLabel) items.push({ text: meta.riskLabel, level: "danger" });
    if (meta.modeLabel) items.push({ text: meta.modeLabel, level: "info" });
    if (meta.outside) items.push({ text: "\u5DE5\u4F5C\u533A\u5916", level: "warn" });
    for (const flag of meta.riskFlagLabels ?? []) items.push({ text: flag, level: "danger" });
    if (items.length === 0) return null;
    const doc = globalThis.document;
    const wrap = doc.createElement("div");
    wrap.className = "ds-consent-badges";
    for (const it2 of items) {
      const b = doc.createElement("span");
      b.className = "ds-consent-badge";
      b.dataset.level = it2.level;
      b.textContent = it2.text;
      wrap.append(b);
    }
    return wrap;
  }
  function mkButton(label, cls) {
    const b = globalThis.document.createElement("button");
    b.className = cls;
    b.textContent = label;
    return b;
  }
  function summarizeParams(params) {
    if (params == null) return "\uFF08\u65E0\u53C2\u6570\uFF09";
    if (typeof params !== "object") return String(params).slice(0, 64);
    const entries = Object.entries(params);
    if (entries.length === 0) return "\uFF08\u65E0\u53C2\u6570\uFF09";
    return entries.map(([k, v2]) => {
      const s = typeof v2 === "string" ? v2 : JSON.stringify(v2);
      const shown = s.length > 32 ? `${s.slice(0, 32)}\u2026` : s;
      return `${k}: ${shown}`;
    }).join("\uFF1B");
  }

  // src/ui/account-block.ts
  var STYLE_ID2 = "ds-account-block-style";
  var CSS2 = `
.ds-account-block-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(180, 24, 24, 0.97);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Microsoft YaHei", sans-serif;
}
.ds-account-block-card {
  max-width: 560px; margin: 0 24px; padding: 32px 28px;
  background: #fff; border-radius: 14px; color: #1a1a1a;
  box-shadow: 0 24px 60px rgba(0,0,0,.4);
}
.ds-account-block-title {
  font-size: 20px; font-weight: 700; color: #b41818; margin-bottom: 12px;
}
.ds-account-block-body {
  font-size: 15px; line-height: 1.7; color: #333; margin-bottom: 20px;
}
.ds-account-block-body strong { color: #b41818; }
.ds-account-block-hint {
  font-size: 13px; color: #666; margin-top: 16px; padding-top: 16px;
  border-top: 1px solid #eee;
}
`;
  function ensureStyles2() {
    const doc = globalThis.document;
    if (!doc) return;
    if (doc.getElementById(STYLE_ID2)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID2;
    style.textContent = CSS2;
    doc.head.appendChild(style);
  }
  var overlayEl = null;
  function showAccountBlockOverlay(reason, duplicateOf) {
    const doc = globalThis.document;
    if (!doc || !doc.body) return;
    if (overlayEl) return;
    ensureStyles2();
    const overlay = doc.createElement("div");
    overlay.className = "ds-account-block-overlay";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    const card = doc.createElement("div");
    card.className = "ds-account-block-card";
    const title = doc.createElement("div");
    title.className = "ds-account-block-title";
    title.textContent = "\u26A0\uFE0F \u8D26\u53F7\u51B2\u7A81 \u2014 \u672C\u7A97\u53E3\u5DF2\u505C\u7528";
    const body = doc.createElement("div");
    body.className = "ds-account-block-body";
    body.innerHTML = "";
    const p1 = doc.createElement("div");
    p1.textContent = reason;
    const p2 = doc.createElement("div");
    p2.innerHTML = `\u540C\u4E00 DeepSeek \u8D26\u53F7\u5728\u591A\u4E2A\u7A97\u53E3\u5E76\u53D1\u767B\u5F55\u4F1A\u89E6\u53D1 <strong>\u98CE\u63A7\u5C01\u53F7</strong>\u3002`;
    body.append(p1, p2);
    if (duplicateOf) {
      const p3 = doc.createElement("div");
      p3.textContent = `\u5DF2\u5360\u7528\u8BE5\u8D26\u53F7\u7684\u7A97\u53E3\uFF1Abot=${duplicateOf}`;
      body.append(p3);
    }
    const hint = doc.createElement("div");
    hint.className = "ds-account-block-hint";
    hint.textContent = "\u8BF7\u5173\u95ED\u672C\u7A97\u53E3\uFF0C\u6216\u5728\u672C\u7A97\u53E3\u767B\u51FA\u540E\u5207\u6362\u5230\u53E6\u4E00\u4E2A DeepSeek \u8D26\u53F7\u3002\u672C\u7A97\u53E3\u7684\u5DE5\u5177\u8C03\u7528\u5DF2\u88AB\u5BBF\u4E3B\u62D2\u7EDD\uFF08fail-closed\uFF09\u3002";
    card.append(title, body, hint);
    overlay.append(card);
    doc.body.append(overlay);
    overlayEl = overlay;
  }

  // src/desktop/host-client.ts
  var OPEN = 1;
  function createHostClient(options) {
    const capabilities = new Map(options.capabilities.map((c) => [c.id, c]));
    const origin = options.origin ?? globalThis.location?.origin ?? "https://chat.deepseek.com";
    const maxBackoff = options.maxBackoffMs ?? 1e4;
    const toolCallTimeoutMs = options.toolCallTimeoutMs ?? 3e4;
    let ws = null;
    let stopped = false;
    let backoff = 500;
    let reconnectTimer = null;
    let tokenStorageHandler = null;
    const pendingToolCalls = /* @__PURE__ */ new Map();
    const pendingKv = /* @__PURE__ */ new Map();
    const pendingEnvelope = /* @__PURE__ */ new Map();
    function failAllPending(reason) {
      for (const [id, p] of pendingToolCalls) {
        clearTimeout(p.timer);
        pendingToolCalls.delete(id);
        p.resolve({ ok: false, error: reason });
      }
      for (const [id, p] of pendingKv) {
        pendingKv.delete(id);
        p.resolve(void 0, reason);
      }
      for (const [id, p] of pendingEnvelope) {
        pendingEnvelope.delete(id);
        p.resolve({ ok: false, error: reason });
      }
    }
    function send(msg2) {
      if (ws && ws.readyState === OPEN) {
        try {
          ws.send(JSON.stringify(msg2));
        } catch (e) {
          options.reportError?.("host-client send failed", e);
        }
      }
    }
    function readAccountFingerprint() {
      try {
        const raw = globalThis.localStorage?.getItem("userToken");
        const token = readUserToken(raw);
        if (!token) return void 0;
        if (cachedRawToken === token) return cachedFingerprint;
        cachedRawToken = token;
        cachedFingerprint = fingerprintHash(token);
        return cachedFingerprint;
      } catch {
        return void 0;
      }
    }
    let cachedRawToken = null;
    let cachedFingerprint = void 0;
    function readUserToken(raw) {
      if (!raw || raw.trim() === "null") return null;
      const trimmed = raw.trim();
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") return parsed.trim() || null;
        if (parsed && typeof parsed === "object") {
          const v2 = parsed.token ?? parsed.value ?? parsed.accessToken;
          return typeof v2 === "string" && v2.trim() ? v2.trim() : null;
        }
      } catch {
      }
      return trimmed || null;
    }
    function fingerprintHash(s) {
      let h1 = 2166136261 >>> 0;
      let h2 = 16777619 >>> 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
        h2 = Math.imul(h2 + c, 268435515) >>> 0;
      }
      const mix = (h1 ^ s.length * 2654435761 ^ h2) >>> 0;
      return mix.toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
    }
    function handle(msg) {
      if (msg.type === "dispatch") {
        const cap = capabilities.get(msg.tool);
        if (!cap) {
          send({ type: "result", callId: msg.callId, ok: false, error: "unknown-tool" });
          return;
        }
        void cap.execute(msg.params ?? {}).then((r) => send({ type: "result", callId: msg.callId, ok: r.ok, data: r.data, error: r.error })).catch(
          (e) => send({ type: "result", callId: msg.callId, ok: false, error: e instanceof Error ? e.message : String(e) })
        );
      } else if (msg.type === "consent-required") {
        showConsent({ tool: msg.tool, params: msg.params, meta: msg.meta }, (decision) => {
          send({ type: "consent-decision", callId: msg.callId, decision });
        });
      } else if (msg.type === "tool-call-result") {
        const p = pendingToolCalls.get(msg.callId);
        if (p) {
          clearTimeout(p.timer);
          pendingToolCalls.delete(msg.callId);
          p.resolve({
            ok: msg.ok,
            data: msg.data,
            error: msg.error,
            ...msg.content !== void 0 ? { content: msg.content } : {},
            ...msg.details !== void 0 ? { details: msg.details } : {},
            ...msg.isError !== void 0 ? { isError: msg.isError } : {},
            ...msg.terminate !== void 0 ? { terminate: msg.terminate } : {}
          });
        }
      } else if (msg.type === "kv-result") {
        const p = pendingKv.get(msg.requestId);
        if (p) {
          pendingKv.delete(msg.requestId);
          if (msg.ok) p.resolve(msg.value);
          else p.resolve(void 0, msg.error);
        }
      } else if (msg.type === "runtime-envelope-result") {
        const p = pendingEnvelope.get(msg.requestId);
        if (p) {
          pendingEnvelope.delete(msg.requestId);
          p.resolve(msg.response);
        }
      } else if (msg.type === "memories-update") {
        options.onMemoriesUpdate?.(msg.memories);
      } else if (msg.type === "debug-eval") {
        const { requestId, code } = msg;
        try {
          const result = eval(code);
          send({ type: "debug-eval-result", requestId, ok: true, result: typeof result === "string" ? result : JSON.stringify(result) });
        } catch (e) {
          send({ type: "debug-eval-result", requestId, ok: false, result: String(e) });
        }
      } else if (msg.type === "debug-reload") {
        location.reload();
      } else if (msg.type === "account-duplicate-block") {
        showAccountBlockOverlay(msg.reason, msg.duplicateOf);
      }
    }
    function onMessage(raw) {
      let msg2;
      try {
        msg2 = JSON.parse(typeof raw === "string" ? raw : String(raw));
      } catch {
        return;
      }
      handle(msg2);
    }
    function connectWs() {
      if (stopped) return;
      const make = options.wsFactory ?? ((url) => new globalThis.WebSocket(url));
      const socket = make(options.url);
      ws = socket;
      socket.onopen = () => {
        backoff = 500;
        send({ type: "hello", origin, sessionId: crypto.randomUUID(), botId: options.botId, accountFingerprint: readAccountFingerprint() });
      };
      socket.onmessage = (ev) => onMessage(ev.data);
      socket.onclose = () => {
        ws = null;
        failAllPending("disconnected");
        if (!stopped) scheduleReconnect();
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {
        }
      };
    }
    function scheduleReconnect() {
      const delay = backoff;
      backoff = Math.min(backoff * 2, maxBackoff);
      reconnectTimer = setTimeout(connectWs, delay);
    }
    return {
      get connected() {
        return ws !== null && ws.readyState === OPEN;
      },
      reportIntegrity(alert) {
        send({ type: "integrity-alert", reason: alert.reason, detail: alert.detail });
      },
      sendToolCall(req) {
        return new Promise((resolve) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve({ ok: false, error: "no-host" });
            return;
          }
          const timer = setTimeout(() => {
            pendingToolCalls.delete(req.callId);
            resolve({ ok: false, error: "host-timeout" });
          }, toolCallTimeoutMs);
          pendingToolCalls.set(req.callId, { resolve, timer });
          send({ type: "tool-call", callId: req.callId, invocationName: req.invocationName, params: req.params, botId: options.botId });
        });
      },
      connect() {
        stopped = false;
        if (!tokenStorageHandler && typeof globalThis.addEventListener === "function") {
          tokenStorageHandler = (ev) => {
            if (ev.key !== "userToken") return;
            cachedRawToken = null;
            if (ws && ws.readyState === OPEN) {
              send({ type: "hello", origin, sessionId: crypto.randomUUID(), botId: options.botId, accountFingerprint: readAccountFingerprint() });
            }
          };
          globalThis.addEventListener("storage", tokenStorageHandler);
        }
        connectWs();
      },
      log(text) {
        send({ type: "log", text });
      },
      assistantReply(text, loop) {
        send({ type: "assistant-reply", text, loop });
      },
      kvGet(key) {
        return new Promise((resolve, reject) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve(void 0);
            return;
          }
          const requestId2 = crypto.randomUUID();
          const timer = setTimeout(() => {
            pendingKv.delete(requestId2);
            reject(new Error("kv-get timeout"));
          }, 3e4);
          pendingKv.set(requestId2, { resolve: (v2, err) => {
            clearTimeout(timer);
            err ? reject(new Error(err)) : resolve(v2);
          } });
          send({ type: "kv-get", requestId: requestId2, key });
        });
      },
      kvSet(key, value) {
        return new Promise((resolve, reject) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve();
            return;
          }
          const requestId2 = crypto.randomUUID();
          const timer = setTimeout(() => {
            pendingKv.delete(requestId2);
            reject(new Error("kv-set timeout"));
          }, 3e4);
          pendingKv.set(requestId2, { resolve: (_v, err) => {
            clearTimeout(timer);
            err ? reject(new Error(err)) : resolve();
          } });
          send({ type: "kv-set", requestId: requestId2, key, value });
        });
      },
      kvRemove(key) {
        return new Promise((resolve, reject) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve();
            return;
          }
          const requestId2 = crypto.randomUUID();
          const timer = setTimeout(() => {
            pendingKv.delete(requestId2);
            reject(new Error("kv-remove timeout"));
          }, 3e4);
          pendingKv.set(requestId2, { resolve: (_v, err) => {
            clearTimeout(timer);
            err ? reject(new Error(err)) : resolve();
          } });
          send({ type: "kv-remove", requestId: requestId2, key });
        });
      },
      sendEnvelope(envelope) {
        return new Promise((resolve) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve({ ok: false, error: "no-host" });
            return;
          }
          const timer = setTimeout(() => {
            pendingEnvelope.delete(envelope.requestId);
            resolve({ ok: false, error: "envelope timeout" });
          }, 3e4);
          pendingEnvelope.set(envelope.requestId, { resolve: (v2) => {
            clearTimeout(timer);
            resolve(v2);
          } });
          send({ type: "runtime-envelope", envelope });
        });
      },
      disconnect() {
        stopped = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (tokenStorageHandler && typeof globalThis.removeEventListener === "function") {
          globalThis.removeEventListener("storage", tokenStorageHandler);
        }
        tokenStorageHandler = null;
        for (const p of pendingToolCalls.values()) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: "disconnected" });
        }
        pendingToolCalls.clear();
        if (ws) {
          try {
            ws.close();
          } catch {
          }
          ws = null;
        }
      }
    };
  }

  // src/inject/streaming-tool-parser.ts
  var StreamingToolCallParser = class {
    constructor(names) {
      this.names = names;
      __publicField(this, "tail", "");
    }
    /**
     * 喂入一段响应文本，返回本次新解析出的完整工具调用，以及已剔除工具标签的「干净」文本
     * （用于回填到页端可见流，避免用户看到原始 XML 标签）。未完成闭合的标签尾部被保留到
     * 下次 feed，保证跨网络分片正确。
     */
    feed(text) {
      const input = this.tail + text;
      this.tail = "";
      const calls = [];
      let clean = "";
      let i = 0;
      while (i < input.length) {
        const lt2 = input.indexOf("<", i);
        if (lt2 === -1) {
          clean += input.slice(i);
          break;
        }
        clean += input.slice(i, lt2);
        const after = input.slice(lt2);
        const open = after.match(/^<([a-zA-Z_][\w-]*)>/);
        if (open && this.names.includes(open[1])) {
          const name = open[1];
          const openEnd = lt2 + open[0].length;
          const closeTag = `</${name}>`;
          const closeIdx = input.indexOf(closeTag, openEnd);
          if (closeIdx === -1) {
            this.tail = input.slice(lt2);
            break;
          }
          const body = input.slice(openEnd, closeIdx);
          const rawBlock = input.slice(lt2, closeIdx + closeTag.length);
          calls.push(this.make(name, body, rawBlock));
          i = closeIdx + closeTag.length;
        } else {
          const close = after.match(/^<\/([a-zA-Z_][\w-]*)>/);
          if (close && this.names.includes(close[1])) {
            i = lt2 + close[0].length;
          } else if (/^<\/?[a-zA-Z_][\w-]*$/.test(after) || /^<\/?$/.test(after)) {
            this.tail = input.slice(lt2);
            break;
          } else {
            clean += "<";
            i = lt2 + 1;
          }
        }
      }
      return { calls, clean };
    }
    /** 流结束时刷出剩余尾部（作为干净文本返回，不解析不完整标签）。 */
    flush() {
      const clean = this.tail;
      this.tail = "";
      return { calls: [], clean };
    }
    make(name, body, raw) {
      let params = {};
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object") params = parsed;
      } catch (e) {
        const fixed = tryFixEscapedQuotes(body);
        if (fixed !== body) {
          try {
            const parsed = JSON.parse(fixed);
            if (parsed && typeof parsed === "object") {
              params = parsed;
              return { id: this.genId(), invocationName: name, params, raw };
            }
          } catch {
          }
        }
        params = { __invalid_json: true, __error: e instanceof Error ? e.message : String(e), __raw: body };
      }
      return { id: this.genId(), invocationName: name, params, raw };
    }
    genId() {
      return typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  };
  function tryFixEscapedQuotes(body) {
    let out = "";
    let inString = false;
    let i = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === "\\" && inString) {
        out += ch;
        if (i + 1 < body.length) {
          out += body[i + 1];
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        if (!inString) {
          inString = true;
          out += ch;
        } else {
          let j2 = i + 1;
          while (j2 < body.length && (body[j2] === " " || body[j2] === "	" || body[j2] === "\n")) j2++;
          const next = body[j2];
          if (next === "," || next === "}" || next === "]" || next === ":" || next === void 0) {
            inString = false;
            out += ch;
          } else {
            out += '\\"';
          }
        }
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  // src/inject/sse-text-extractor.ts
  function snapshotFragments(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed;
    if (o.p !== void 0) return null;
    if (!o.v || typeof o.v !== "object" || Array.isArray(o.v)) return null;
    const resp = o.v.response;
    if (!resp || typeof resp !== "object") return null;
    const frags = resp.fragments;
    return Array.isArray(frags) && frags.length > 0 ? frags : null;
  }
  var SseTextStreamExtractor = class {
    constructor() {
      /** 尚未遇到换行的不完整行（跨 chunk 保留）。 */
      __publicField(this, "lineBuffer", "");
      /** 当前活跃 fragment 类型：THINK 时跳过单字符增量，RESPONSE 时保留。 */
      __publicField(this, "activeFragmentType", null);
      /** v0.18：累积 THINK 推理段文本，供步骤流推理笔记使用。 */
      __publicField(this, "reasoningBuffer", "");
      /**
       * 是否已消费过全量 response 快照的 content。快照是累积的（每次重发都含全部已流过
       * 内容），只有首次观测需要取 content，后续重发必须跳过，否则内容重复。
       * 实例按 XHR 创建，故每条回复自动重置。
       */
      __publicField(this, "snapshotSeen", false);
    }
    /**
     * 喂入一段原始 SSE 文本（可能在任意字节边界截断），返回本次可确认的完整行所携带的文本。
     * 被切开的末行不解析，留待下次 feed 与新内容拼接后再处理。
     */
    feed(rawChunk) {
      const combined = this.lineBuffer + rawChunk;
      const lines = combined.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      let out = "";
      for (const line of lines) {
        out += this.extractLine(line);
      }
      return out;
    }
    /** 流结束时调用：尝试解析缓冲区里最后的残留行。 */
    flush() {
      const tail = this.lineBuffer;
      this.lineBuffer = "";
      return this.extractLine(tail);
    }
    /** v0.18：取出并清空已累积的推理文本。 */
    consumeReasoning() {
      const r = this.reasoningBuffer;
      this.reasoningBuffer = "";
      return r;
    }
    /** 解析一行 SSE，更新 fragment 类型状态，返回可见文本（THINK 段写入推理缓冲，返回空串）。 */
    extractLine(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return "";
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return "";
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        return "";
      }
      if (obj.p === "response/fragments" && Array.isArray(obj.v)) {
        for (const item of obj.v) {
          if (item && typeof item === "object") {
            const t = item.type;
            if (t === "THINK" || t === "RESPONSE") this.activeFragmentType = t;
          }
        }
        let out = "";
        for (const item of obj.v) {
          if (!item || typeof item !== "object") continue;
          const frag = item;
          if (typeof frag.content !== "string") continue;
          if (frag.type === "THINK") {
            this.reasoningBuffer += frag.content;
          } else {
            out += frag.content;
          }
        }
        return out;
      }
      const snap = snapshotFragments(obj);
      if (snap) {
        const first = !this.snapshotSeen;
        this.snapshotSeen = true;
        for (const item of snap) {
          const t = item?.type;
          if (t === "THINK" || t === "RESPONSE") this.activeFragmentType = t;
        }
        if (!first) return "";
        let out = "";
        for (const item of snap) {
          if (!item || typeof item !== "object") continue;
          const frag = item;
          if (typeof frag.content !== "string") continue;
          if (frag.type === "THINK") this.reasoningBuffer += frag.content;
          else out += frag.content;
        }
        return out;
      }
      if (typeof obj.v === "string") {
        const p = String(obj.p ?? "");
        if (p && !isResponseContentPatchPath(p)) return "";
        if (this.activeFragmentType === "THINK") {
          this.reasoningBuffer += obj.v;
          return "";
        }
        return obj.v;
      }
      if (Array.isArray(obj.v)) {
        let out = "";
        for (const item of obj.v) {
          if (!item || typeof item !== "object") continue;
          const frag = item;
          if (typeof frag.content !== "string") continue;
          if (frag.type === "THINK") {
            this.reasoningBuffer += frag.content;
          } else {
            out += frag.content;
          }
        }
        return out;
      }
      return "";
    }
  };
  function isResponseContentPatchPath(path) {
    if (!path.startsWith("response")) return false;
    const lastSegment = path.split("/").pop();
    return lastSegment === "content" || lastSegment === "text" || lastSegment === "markdown" || lastSegment === "delta";
  }

  // src/inject/deepseek-sse-frame-decoder.ts
  var DeepSeekSseFrameDecoder = class {
    constructor() {
      __publicField(this, "buffer", "");
      __publicField(this, "scanFrom", 0);
    }
    push(text) {
      this.buffer += text;
      return this.drain();
    }
    finish() {
      const frames = this.drain();
      if (this.buffer) {
        frames.push(this.createFrame(this.buffer, ""));
        this.buffer = "";
      }
      this.scanFrom = 0;
      return frames;
    }
    drain() {
      const frames = [];
      const boundaryPattern = /\r?\n\r?\n/g;
      boundaryPattern.lastIndex = this.scanFrom;
      let offset = 0;
      let match;
      while ((match = boundaryPattern.exec(this.buffer)) !== null) {
        frames.push(this.createFrame(this.buffer.slice(offset, match.index), match[0]));
        offset = match.index + match[0].length;
      }
      this.buffer = this.buffer.slice(offset);
      this.scanFrom = Math.max(0, this.buffer.length - 3);
      return frames;
    }
    createFrame(block, _separator) {
      let eventType = "message";
      let dataLines = [];
      for (const line of block.split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trimStart();
        if (key === "event") eventType = value;
        else if (key === "data") dataLines.push(value);
      }
      const data = dataLines.join("\n");
      const event = data ? { type: eventType, data } : null;
      let parsed = null;
      if (data) {
        try {
          parsed = JSON.parse(data);
        } catch {
        }
      }
      return { block, event, parsed };
    }
  };

  // src/shared/tool-contract.ts
  var UPSTREAM_TO_STUDIO = Object.assign(
    /* @__PURE__ */ Object.create(null),
    {
      shell_exec: {
        id: "shell.exec",
        adapt: (p) => ({
          command: typeof p.command === "string" ? p.command : typeof p.cmd === "string" ? p.cmd : "",
          ...typeof p.timeout_ms === "number" ? { timeoutMs: p.timeout_ms } : {},
          ...typeof p.cwd === "string" ? { cwd: p.cwd } : {}
        })
      },
      local_file_read: {
        id: "file.read",
        adapt: (p) => ({
          path: typeof p.path === "string" ? p.path : "",
          ...typeof p.start === "number" ? { offset: p.start } : typeof p.offset === "number" ? { offset: p.offset } : {},
          ...typeof p.max_chars === "number" ? { limit: p.max_chars } : typeof p.limit === "number" ? { limit: p.limit } : {}
        })
      },
      local_file_write: {
        id: "file.write",
        adapt: (p) => ({
          path: typeof p.path === "string" ? p.path : "",
          content: typeof p.content === "string" ? p.content : ""
        })
      },
      local_file_stat: {
        id: "file.stat",
        adapt: (p) => ({ path: typeof p.path === "string" ? p.path : "" })
      },
      // v1.0：长期记忆保存（移植自 deepseek++ memory_save）。
      memory_save: {
        id: "memory.save",
        adapt: (p) => ({
          type: typeof p.type === "string" ? p.type : "user",
          name: typeof p.name === "string" ? p.name : "",
          content: typeof p.content === "string" ? p.content : "",
          tags: Array.isArray(p.tags) ? p.tags : []
        })
      },
      // v1.0：Python 代码执行（移植自 deepseek++ python_exec）。
      python_exec: {
        id: "python.exec",
        adapt: (p) => ({
          code: typeof p.code === "string" ? p.code : ""
        })
      },
      // v1.0：列出 MCP 工具。
      mcp_list: {
        id: "mcp.list",
        adapt: () => ({})
      },
      // v1.0：调用 MCP 工具。
      mcp_call: {
        id: "mcp.call",
        adapt: (p) => ({
          serverId: typeof p.serverId === "string" ? p.serverId : "",
          tool: typeof p.tool === "string" ? p.tool : typeof p.name === "string" ? p.name : "",
          args: p.args && typeof p.args === "object" ? p.args : p.arguments && typeof p.arguments === "object" ? p.arguments : {}
        })
      },
      // v1.1：测试 MCP 连接（UI 直接调用时用点号，模型 XML 标签用下划线）。
      mcp_test: {
        id: "mcp.test",
        adapt: (p) => ({ config: p.config && typeof p.config === "object" ? p.config : {} })
      },
      "mcp.test": {
        id: "mcp.test",
        adapt: (p) => ({ config: p.config && typeof p.config === "object" ? p.config : {} })
      },
      // v1.1：保存 MCP 配置。
      mcp_save: {
        id: "mcp.save",
        adapt: (p) => ({
          serverId: typeof p.serverId === "string" ? p.serverId : typeof p.id === "string" ? p.id : "",
          config: p.config && typeof p.config === "object" ? p.config : {}
        })
      },
      "mcp.save": {
        id: "mcp.save",
        adapt: (p) => ({
          serverId: typeof p.serverId === "string" ? p.serverId : typeof p.id === "string" ? p.id : "",
          config: p.config && typeof p.config === "object" ? p.config : {}
        })
      },
      // v1.1：UI 点号直调（无需适配，透传参数）。
      "mcp.remove": { id: "mcp.remove", adapt: (p) => p },
      "memory.delete": { id: "memory.delete", adapt: (p) => p },
      "workspace.set": { id: "workspace.set", adapt: (p) => p },
      "policy.set": { id: "policy.set", adapt: (p) => p },
      "project.list": { id: "project.list", adapt: (p) => p },
      "project.create": { id: "project.create", adapt: (p) => p },
      "folder.pick": { id: "folder.pick", adapt: (p) => p },
      "skill.list": { id: "skill.list", adapt: (p) => p },
      "memory.save": { id: "memory.save", adapt: (p) => p },
      "python.exec": { id: "python.exec", adapt: (p) => p },
      "mcp.list": { id: "mcp.list", adapt: (p) => p },
      "mcp.call": { id: "mcp.call", adapt: (p) => p },
      "shell.exec": { id: "shell.exec", adapt: (p) => p },
      "file.read": { id: "file.read", adapt: (p) => p },
      "file.write": { id: "file.write", adapt: (p) => p },
      "file.stat": { id: "file.stat", adapt: (p) => p }
    }
  );
  var SUPPORTED_INVOCATION_NAMES = Object.keys(UPSTREAM_TO_STUDIO);
  function isSupportedUpstreamTool(invocationName) {
    return Object.prototype.hasOwnProperty.call(UPSTREAM_TO_STUDIO, invocationName);
  }

  // src/shared/tool-result-format.ts
  function joinContent(content) {
    if (!Array.isArray(content) || content.length === 0) return null;
    const parts = [];
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("");
  }
  function formatJson(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }
  function legacyResultText(result2) {
    if (result2.error) return result2.error;
    if (result2.data == null) return "";
    if (typeof result2.data === "object" && result2.data !== null && "stdout" in result2.data) {
      const d = result2.data;
      const stdout = typeof d.stdout === "string" ? d.stdout : "";
      const stderr = typeof d.stderr === "string" ? d.stderr : "";
      const exitCode = d.exitCode;
      const cleanStderr = stderr.replace(/#< CLIXML[\s\S]*?<\/Objs>/g, "").replace(/System\.Management\.Automation\.[\s\S]*?Completed-1/g, "").replace(/\bCompleted-1\b/g, "").replace(/Preparing modules for first use\./g, "").trim();
      const parts = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (cleanStderr) parts.push(`[stderr]
${cleanStderr}`);
      if (!result2.ok && exitCode !== void 0 && exitCode !== 0) {
        parts.push(`[exit-code] ${exitCode}`);
      }
      return parts.join("\n\n") || "(empty output)";
    }
    if (typeof result2.data === "string") return result2.data;
    return formatJson(result2.data);
  }
  function formatToolResultText(result2) {
    const contentText = joinContent(result2.content);
    const base = contentText !== null ? contentText : legacyResultText(result2);
    if (result2.isError !== true) return base;
    return base ? `[\u9519\u8BEF] ${base}` : "[\u9519\u8BEF]";
  }
  function shouldSkipAutoContinue(results) {
    if (!Array.isArray(results) || results.length === 0) return false;
    return results.every((r) => !!r && r.terminate === true);
  }

  // src/shared/continuation-prompt.ts
  var MAX_LOOP = 25;
  var MAX_NUDGES = 8;
  var MAX_ERROR_RETRIES = 3;
  var FULL_TOOL_RESULT_WINDOW = 4;
  var ORIGINAL_TASK_MAX_CHARS = 8e3;
  var PREVIOUS_TEXT_MAX_CHARS = 4e3;
  var NUDGE_DECISION_TAIL_MAX_CHARS = 600;
  var PENDING_ACTION_AFTER_MAX_CHARS = 80;
  var SUMMARY_MAX_CHARS = 400;
  var DETAIL_MAX_CHARS = 4e3;
  var OUTPUT_MAX_CHARS = 8e3;
  var PENDING_ACTION_RE = /(?:我(?:将|会|想|要|先|让|再|直接|现在|继续|尝试|开始|需要|还需要|仍需|打算|计划|马上|随后|稍后|先去|先来|接下来).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:接下来|下一步|然后|让我|先让我).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:(?:现在|这就|马上|随后|稍后|立即|立刻|先|直接))?(?:为|帮)(?:你|您)(?:创建|生成|制作|输出|编写|绘制|渲染)(?!了|好|完|成|过|的)|(?:i(?:'ll| will|'m| am|'d| would| want to| should| have to| (?:still\s+)?need to|'m going to| am going to|'m about to| am about to|'ve got to| have got to)|let me|let's|next,? (?:i|we)|we(?:'ll| will| need to| can)|(?:my|the) next step is to).{0,64}(?:call|create|edit|inspect|validate|generate|save|try|search|fetch|open|run|browse|read|check|look|use|verify|test|download|write|update|review|analyze|extract|query|send|post|investigate|monitor|compare|install|start|stop|convert|parse|list|collect|request|retry|scroll|click|type|navigate))/gi;
  var COMPLETION_MARKER_RE = /(?:已经|已为|已完成|完毕|创建了|生成了|制作了|编写了|保存了|写好了|完成了|总结一下|总结如下|总结|结论是|综上所述|总的来看|这是|报告如下|如下所示|final answer|in summary|to summarize|summarize|here is|here's|the answer is|as you can see|i'?ve already|we'?ve already|created|generated|saved|completed|done)/i;
  var ENDS_WITH_SENTENCE_TERMINAL_RE = /[。！？.!?…]\s*$/;
  var TASK_COMPLETE_RE = /<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/;
  var CONTINUATION_INTRO = "\u4EE5\u4E0B\u662F\u5DE5\u5177\u7EED\u8DD1\u4EFB\u52A1\u521A\u521A\u6267\u884C\u7684\u5DE5\u5177\u7ED3\u679C\u3002\u8BF7\u50CF\u771F\u6B63\u7684 Agent \u4E00\u6837\uFF0C\u57FA\u4E8E\u539F\u59CB\u4EFB\u52A1\u548C\u8FD9\u4E9B\u5DE5\u5177\u7ED3\u679C\u7EE7\u7EED\u63A8\u8FDB\u3002";
  var CONTINUATION_ENOUGH = "\u5982\u679C\u7ED3\u679C\u5DF2\u7ECF\u8DB3\u591F\uFF0C\u8BF7\u8F93\u51FA\u6700\u7EC8\u7ED3\u8BBA\uFF1B\u53EA\u6709\u786E\u5B9E\u9700\u8981\u66F4\u591A\u4FE1\u606F\u3001\u9A8C\u8BC1\u6216\u6587\u4EF6\u4FEE\u6539\u65F6\u624D\u7EE7\u7EED\u8C03\u7528\u5DE5\u5177\u3002";
  var CONTINUATION_NO_PSEUDO = "\u4E0D\u8981\u8981\u6C42\u7528\u6237\u70B9\u51FB\u7EE7\u7EED\uFF0C\u4E5F\u4E0D\u8981\u8F93\u51FA\u4F2A\u5DE5\u5177\u8C03\u7528 JSON\uFF1B\u9700\u8981\u7EE7\u7EED\u64CD\u4F5C\u65F6\u53EA\u8F93\u51FA\u53EF\u6267\u884C XML \u5DE5\u5177\u6807\u7B7E\u3002\u6587\u4EF6\u3001HTML \u9875\u9762\u4E0E\u56FE\u8868\u7B49\u4EA4\u4ED8\u7269\u8BF7\u76F4\u63A5\u7528 Markdown \u56F4\u680F\u4EE3\u7801\u5757\u8F93\u51FA\uFF08\u5982 ```html\u3001```mermaid\uFF09\uFF0C\u4E0D\u8981\u4F7F\u7528 artifact XML \u6807\u7B7E\u3002";
  var FAILURE_RECOVERY = "\u81F3\u5C11\u4E00\u4E2A\u5DE5\u5177\u6267\u884C\u5931\u8D25\u3002\u4E0D\u8981\u56E0\u4E3A\u53EF\u6062\u590D\u9519\u8BEF\u5C31\u505C\u6B62\uFF1B\u5148\u9605\u8BFB summary/detail/error\uFF0C\u5E76\u4FEE\u6B63\u53C2\u6570\u6216\u6539\u7528\u5408\u9002\u7684\u4E0B\u4E00\u6B65\u7EE7\u7EED\u5B8C\u6210\u4EFB\u52A1\u3002";
  var NUDGE_NO_TOOLS = "\u4E0A\u4E00\u8F6E\u56DE\u590D\u6CA1\u6709\u5305\u542B\u4EFB\u4F55\u53EF\u6267\u884C\u5DE5\u5177 XML\uFF0C\u56E0\u6B64\u81EA\u52A8\u5316\u7EED\u8DD1\u65E0\u6CD5\u7EE7\u7EED\u6267\u884C\u3002";
  var NUDGE_CHOICE = "\u8BF7\u6839\u636E\u539F\u59CB\u4EFB\u52A1\u548C\u5DE5\u5177\u7ED3\u679C\u4E8C\u9009\u4E00\uFF1A";
  var NUDGE_NEXT_TOOL = "1. \u5982\u679C\u4EFB\u52A1\u4ECD\u672A\u5B8C\u6210\uFF0C\u672C\u8F6E\u5FC5\u987B\u76F4\u63A5\u8F93\u51FA\u4E0B\u4E00\u6B65\u53EF\u6267\u884C\u5DE5\u5177 XML\u3002";
  var NUDGE_COMPLETE = '2. \u5982\u679C\u4EFB\u52A1\u5DF2\u7ECF\u5B8C\u6210\uFF0C\u8F93\u51FA <task_complete>{"summary":"..."}</task_complete>\u3002\u6587\u4EF6\u3001HTML \u9875\u9762\u4E0E\u56FE\u8868\u7B49\u4EA4\u4ED8\u7269\u7528 Markdown \u56F4\u680F\u4EE3\u7801\u5757\u8F93\u51FA\u3002';
  function extractTaskCompleteSignal(text) {
    const match = TASK_COMPLETE_RE.exec(text);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : match[1].trim(),
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((a2) => typeof a2 === "string") : []
      };
    } catch {
      return { summary: match[1].trim(), artifacts: [] };
    }
  }
  function shouldNudge(visibleText) {
    if (extractTaskCompleteSignal(visibleText)) return false;
    if (!visibleText) return true;
    const tail = getNudgeDecisionText(visibleText);
    if (tail.includes("```")) return false;
    if (hasPendingActionAtTail(tail)) return true;
    if (COMPLETION_MARKER_RE.test(tail)) return false;
    if (ENDS_WITH_SENTENCE_TERMINAL_RE.test(tail)) return false;
    return true;
  }
  function getNudgeDecisionText(text) {
    const trimmed = text.trim();
    return trimmed.length > NUDGE_DECISION_TAIL_MAX_CHARS ? trimmed.slice(-NUDGE_DECISION_TAIL_MAX_CHARS) : trimmed;
  }
  function hasPendingActionAtTail(text) {
    const matches = [...text.matchAll(PENDING_ACTION_RE)];
    const lastMatch = matches[matches.length - 1];
    if (!lastMatch || lastMatch.index === void 0) return false;
    const afterPendingAction = text.slice(lastMatch.index + lastMatch[0].length).trim();
    if (afterPendingAction.length > PENDING_ACTION_AFTER_MAX_CHARS) return false;
    if (afterPendingAction.includes("```")) return false;
    return true;
  }
  function renderToolResult(p) {
    const detail = clampText(resultToDetailText(p), DETAIL_MAX_CHARS);
    const output = p.result === void 0 ? void 0 : clampText(JSON.stringify(p.result), OUTPUT_MAX_CHARS);
    return {
      tool: p.invocationName,
      ok: p.ok,
      summary: clampText(resultToSummary(p), SUMMARY_MAX_CHARS) ?? "",
      detail,
      output,
      error: !p.ok ? { code: void 0, message: p.error ?? "unknown", retryable: false } : void 0
    };
  }
  function renderCompressedToolResult(p) {
    return {
      tool: p.invocationName,
      ok: p.ok,
      summary: clampText(resultToSummary(p), SUMMARY_MAX_CHARS) ?? "",
      error: !p.ok ? { code: void 0, message: p.error ?? "unknown", retryable: false } : void 0,
      windowed: true
    };
  }
  function renderWindowedToolResults(executions) {
    if (executions.length <= FULL_TOOL_RESULT_WINDOW) {
      return executions.map(renderToolResult);
    }
    const older = executions.slice(0, -FULL_TOOL_RESULT_WINDOW);
    const recent = executions.slice(-FULL_TOOL_RESULT_WINDOW);
    return [...older.map(renderCompressedToolResult), ...recent.map(renderToolResult)];
  }
  function resultToSummary(p) {
    if (!p.ok) {
      return (p.error ?? "execution failed").slice(0, SUMMARY_MAX_CHARS);
    }
    if (p.result && typeof p.result === "object" && "stdout" in p.result) {
      const r = p.result;
      const stdout = typeof r.stdout === "string" ? r.stdout : "";
      return firstLine(stdout) || "(empty output)";
    }
    if (typeof p.result === "string") {
      return firstLine(p.result) || "(empty output)";
    }
    return "(completed)";
  }
  function resultToDetailText(p) {
    if (!p.ok) {
      return p.error ?? "execution failed";
    }
    if (p.result && typeof p.result === "object" && "stdout" in p.result) {
      const r = p.result;
      const stdout = typeof r.stdout === "string" ? r.stdout : "";
      const stderr = typeof r.stderr === "string" ? r.stderr : "";
      const exitCode = r.exitCode;
      const parts = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (stderr.trim()) parts.push(`<stderr>
${stderr.trimEnd()}
</stderr>`);
      if (exitCode !== void 0 && exitCode !== 0 && exitCode !== "") {
        parts.push(`<exit-code>${exitCode}</exit-code>`);
      }
      return parts.join("\n\n") || "(empty output)";
    }
    if (typeof p.result === "string") return p.result;
    if (p.result === void 0 || p.result === null) return "(empty output)";
    try {
      return JSON.stringify(p.result, null, 2);
    } catch {
      return String(p.result);
    }
  }
  function firstLine(s) {
    const t = s.trim();
    const nl = t.indexOf("\n");
    return (nl === -1 ? t : t.slice(0, nl)).slice(0, SUMMARY_MAX_CHARS);
  }
  function buildContinuationPrompt(originalTask, executions, toolCatalog) {
    const hasFailures = executions.some((e) => !e.ok);
    const results = renderWindowedToolResults(executions);
    return [
      CONTINUATION_INTRO,
      CONTINUATION_ENOUGH,
      CONTINUATION_NO_PSEUDO,
      "",
      "<original_task>",
      clampText(originalTask, ORIGINAL_TASK_MAX_CHARS) ?? "",
      "</original_task>",
      ...hasFailures ? ["", FAILURE_RECOVERY] : [],
      "",
      "<tool_results>",
      JSON.stringify(results, null, 2),
      "</tool_results>",
      ...toolCatalog ? ["", "### Available Tools", toolCatalog] : []
    ].join("\n");
  }
  function buildNudgePrompt(originalTask, previousText, executions, nudgeCount) {
    const results = renderWindowedToolResults(executions);
    return [
      NUDGE_NO_TOOLS,
      NUDGE_CHOICE,
      NUDGE_NEXT_TOOL,
      NUDGE_COMPLETE,
      `\u8FD9\u662F\u7B2C ${nudgeCount} \u6B21\u65E0\u5DE5\u5177\u8C03\u7528\u7EA0\u504F\u3002`,
      "",
      "<original_task>",
      clampText(originalTask, ORIGINAL_TASK_MAX_CHARS) ?? "",
      "</original_task>",
      "",
      "<previous_assistant_text>",
      clampText(previousText, PREVIOUS_TEXT_MAX_CHARS) ?? "",
      "</previous_assistant_text>",
      "",
      "<tool_results_so_far>",
      JSON.stringify(results, null, 2),
      "</tool_results_so_far>"
    ].join("\n");
  }
  function clampText(value, maxLen) {
    if (!value) return value;
    return value.length > maxLen ? `${value.slice(0, maxLen)}
...[truncated]` : value;
  }

  // src/inject/response-classifier.ts
  function parseBodyError(bodyText) {
    if (!bodyText) return null;
    let obj;
    try {
      obj = JSON.parse(bodyText);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const o = obj;
    const code2 = typeof o.code === "number" ? o.code : typeof o.status === "number" ? o.status : void 0;
    const err = o.error;
    if (code2 === void 0 && !err) return null;
    if (code2 === 401 || code2 === 403 || code2 === 402 || code2 === 429) {
      return { retryable: code2 === 429, reason: `body-error-${code2}` };
    }
    return { retryable: true, reason: `body-error-${code2 ?? "unknown"}` };
  }
  function classifyResponse(status, bodyText) {
    if (status === 0) return { verdict: "retryable", status, reason: "network-error" };
    if (status === 429) {
      return { verdict: "retryable", status, reason: "rate-limited", retryAfterMs: parseRetryAfterMs(bodyText) };
    }
    if (status >= 500 && status < 600) return { verdict: "retryable", status, reason: `server-${status}` };
    if (status === 401 || status === 403 || status === 402) return { verdict: "fatal", status, reason: `auth-billing-${status}` };
    if (status >= 400) return { verdict: "fatal", status, reason: `client-${status}` };
    if (status >= 200 && status < 300) {
      const bodyErr = parseBodyError(bodyText);
      if (bodyErr) {
        return bodyErr.retryable ? { verdict: "retryable", status, reason: bodyErr.reason } : { verdict: "fatal", status, reason: bodyErr.reason };
      }
      return { verdict: "ok", status, reason: "success" };
    }
    return { verdict: "retryable", status, reason: `unclassified-${status}` };
  }
  function parseRetryAfterMs(bodyText) {
    if (!bodyText) return void 0;
    try {
      const obj = JSON.parse(bodyText);
      const ra = obj.retryAfter ?? obj.retry_after;
      if (typeof ra === "number" && ra > 0) return ra * 1e3;
    } catch {
    }
    return void 0;
  }
  function classifySseFrame(eventType, parsed) {
    if (eventType && eventType.toLowerCase() === "error") {
      return { verdict: "fatal", status: 200, reason: "sse-error-frame" };
    }
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed;
    const code2 = typeof o.code === "number" ? o.code : typeof o.status === "number" ? o.status : void 0;
    if ((code2 === 0 || code2 === 429 || code2 === 500) && (o.error || o.message)) {
      return { verdict: code2 === 429 || code2 === 500 ? "retryable" : "fatal", status: 200, reason: `sse-error-payload-${code2}` };
    }
    return null;
  }
  function errorBackoffMs(attempt, jitterMs = 300) {
    const base = Math.min(2e3 * 2 ** Math.max(0, Math.min(attempt, 2)), 8e3);
    return base + Math.round(Math.random() * jitterMs);
  }
  var REPLAYABLE_HEADER_ALLOWLIST = /* @__PURE__ */ new Set([
    "content-type",
    "accept",
    "user-agent",
    "authorization",
    "lang",
    // 设备 / 客户端标识（PoW 挑战必需）
    "x-device-id",
    "x-device-model",
    "x-client-build",
    "x-client-bundle-id",
    "x-client-platform",
    "x-client-version",
    "x-client-locale",
    "x-client-timezone-offset"
  ]);
  function filterReplayableHeaders(headers) {
    const out = {};
    for (const [k, v2] of Object.entries(headers)) {
      if (REPLAYABLE_HEADER_ALLOWLIST.has(k.toLowerCase())) out[k] = v2;
    }
    return out;
  }
  var TELEMETRY_CAP = 50;
  var ring = [];
  function recordVerdict(trace) {
    ring.push({ at: Date.now(), ...trace });
    if (ring.length > TELEMETRY_CAP) ring.shift();
  }

  // src/inject/pow-wasm.ts
  var WASM_BASE64 = "AGFzbQEAAAABTgtgAn9/AX9gA39/fwF/YAJ/fwBgA39/fwBgAX8AYAF/AX9gBH9/f38Bf2AFf39/f38Bf2AEf39/fwBgBn9/f39/fABgB39/f39/f38BfwMwLwUJAAAEBAMGAgcAAgoBAAACAAMDBAIECAQDAwMCAwABAwcABgIAAAgCBAUAAAICBAUBcAENDQUDAQARBgkBfwFBgIDAAAsHkwEHBm1lbW9yeQIAFXdhc21fZGVlcHNlZWtfaGFzaF92MQAGCndhc21fc29sdmUAAR9fX3diaW5kZ2VuX2FkZF90b19zdGFja19wb2ludGVyACoTX193YmluZGdlbl9leHBvcnRfMAAeE19fd2JpbmRnZW5fZXhwb3J0XzEAIxNfX3diaW5kZ2VuX2V4cG9ydF8yABsJEgEAQQELDCYCLCIDLi0WHw4rJQrprQEv5iICCH8BfgJAAkACQAJAAkACQAJAAkAgAEH1AU8EQCAAQc3/e08NBSAAQQtqIgFBeHEhBUGcosAAKAIAIghFDQRBHyEHQQAgBWshAyAAQfT//wdNBEAgBUEGIAFBCHZnIgBrdkEBcSAAQQF0a0E+aiEHCyAHQQJ0QYCfwABqKAIAIgFFBEBBACEADAILQQAhACAFQRkgB0EBdmtBACAHQR9HG3QhBANAAkAgASgCBEF4cSIGIAVJDQAgBiAFayIGIANPDQAgASECIAYiAw0AQQAhAyABIQAMBAsgASgCFCIGIAAgBiABIARBHXZBBHFqQRBqKAIAIgFHGyAAIAYbIQAgBEEBdCEEIAENAAsMAQtBmKLAACgCACIEQRAgAEELakH4A3EgAEELSRsiBUEDdiIAdiIBQQNxBEACQCABQX9zQQFxIABqIgVBA3QiAEGQoMAAaiICIABBmKDAAGooAgAiASgCCCIDRwRAIAMgAjYCDCACIAM2AggMAQtBmKLAACAEQX4gBXdxNgIACyABIABBA3I2AgQgACABaiIAIAAoAgRBAXI2AgQMCAsgBUGgosAAKAIATQ0DAkACQCABRQRAQZyiwAAoAgAiAEUNBiAAaEECdEGAn8AAaigCACICKAIEQXhxIAVrIQMgAiEBA0ACQCACKAIQIgANACACKAIUIgANACABKAIYIQcCQAJAIAEgASgCDCIARgRAIAFBFEEQIAEoAhQiABtqKAIAIgINAUEAIQAMAgsgASgCCCICIAA2AgwgACACNgIIDAELIAFBFGogAUEQaiAAGyEEA0AgBCEGIAIiAEEUaiAAQRBqIAAoAhQiAhshBCAAQRRBECACG2ooAgAiAg0ACyAGQQA2AgALIAdFDQQgASABKAIcQQJ0QYCfwABqIgIoAgBHBEAgB0EQQRQgBygCECABRhtqIAA2AgAgAEUNBQwECyACIAA2AgAgAA0DQZyiwABBnKLAACgCAEF+IAEoAhx3cTYCAAwECyAAKAIEQXhxIAVrIgIgAyACIANJIgIbIQMgACABIAIbIQEgACECDAALAAsCQEECIAB0IgJBACACa3IgASAAdHFoIgZBA3QiAEGQoMAAaiIBIABBmKDAAGooAgAiAigCCCIDRwRAIAMgATYCDCABIAM2AggMAQtBmKLAACAEQX4gBndxNgIACyACIAVBA3I2AgQgAiAFaiIGIAAgBWsiA0EBcjYCBCAAIAJqIAM2AgBBoKLAACgCACIBBEAgAUF4cUGQoMAAaiEAQaiiwAAoAgAhBAJ/QZiiwAAoAgAiBUEBIAFBA3Z0IgFxRQRAQZiiwAAgASAFcjYCACAADAELIAAoAggLIQEgACAENgIIIAEgBDYCDCAEIAA2AgwgBCABNgIIC0GoosAAIAY2AgBBoKLAACADNgIAIAJBCGoPCyAAIAc2AhggASgCECICBEAgACACNgIQIAIgADYCGAsgASgCFCICRQ0AIAAgAjYCFCACIAA2AhgLAkACQCADQRBPBEAgASAFQQNyNgIEIAEgBWoiBSADQQFyNgIEIAMgBWogAzYCAEGgosAAKAIAIgRFDQEgBEF4cUGQoMAAaiEAQaiiwAAoAgAhAgJ/QZiiwAAoAgAiBkEBIARBA3Z0IgRxRQRAQZiiwAAgBCAGcjYCACAADAELIAAoAggLIQQgACACNgIIIAQgAjYCDCACIAA2AgwgAiAENgIIDAELIAEgAyAFaiIAQQNyNgIEIAAgAWoiACAAKAIEQQFyNgIEDAELQaiiwAAgBTYCAEGgosAAIAM2AgALDAcLIAAgAnJFBEBBACECQQIgB3QiAEEAIABrciAIcSIARQ0DIABoQQJ0QYCfwABqKAIAIQALIABFDQELA0AgACACIAAoAgRBeHEiBCAFayIGIANJIgcbIQggACgCECIBRQRAIAAoAhQhAQsgAiAIIAQgBUkiABshAiADIAYgAyAHGyAAGyEDIAEiAA0ACwsgAkUNACAFQaCiwAAoAgAiAE0gAyAAIAVrT3ENACACKAIYIQcCQAJAIAIgAigCDCIARgRAIAJBFEEQIAIoAhQiABtqKAIAIgENAUEAIQAMAgsgAigCCCIBIAA2AgwgACABNgIIDAELIAJBFGogAkEQaiAAGyEEA0AgBCEGIAEiAEEUaiAAQRBqIAAoAhQiARshBCAAQRRBECABG2ooAgAiAQ0ACyAGQQA2AgALIAdFDQMgAiACKAIcQQJ0QYCfwABqIgEoAgBHBEAgB0EQQRQgBygCECACRhtqIAA2AgAgAEUNBAwDCyABIAA2AgAgAA0CQZyiwABBnKLAACgCAEF+IAIoAhx3cTYCAAwDCwJAAkACQAJAIAVBoKLAACgCACIBSwRAIAVBpKLAACgCACIATwRAQQAhAyAFQa+ABGoiAEEQdkAAIgFBf0YiAg0GIAFBEHQiAUUNBkGwosAAQQAgAEGAgHxxIAIbIgNBsKLAACgCAGoiADYCAEG0osAAQbSiwAAoAgAiAiAAIAAgAkkbNgIAAkACQEGsosAAKAIAIgIEQEGAoMAAIQADQCAAKAIAIgQgACgCBCIGaiABRg0CIAAoAggiAA0ACwwCC0G8osAAKAIAIgBBACAAIAFNG0UEQEG8osAAIAE2AgALQcCiwABB/x82AgBBhKDAACADNgIAQYCgwAAgATYCAEGcoMAAQZCgwAA2AgBBpKDAAEGYoMAANgIAQZigwABBkKDAADYCAEGsoMAAQaCgwAA2AgBBoKDAAEGYoMAANgIAQbSgwABBqKDAADYCAEGooMAAQaCgwAA2AgBBvKDAAEGwoMAANgIAQbCgwABBqKDAADYCAEHEoMAAQbigwAA2AgBBuKDAAEGwoMAANgIAQcygwABBwKDAADYCAEHAoMAAQbigwAA2AgBB1KDAAEHIoMAANgIAQcigwABBwKDAADYCAEGMoMAAQQA2AgBB3KDAAEHQoMAANgIAQdCgwABByKDAADYCAEHYoMAAQdCgwAA2AgBB5KDAAEHYoMAANgIAQeCgwABB2KDAADYCAEHsoMAAQeCgwAA2AgBB6KDAAEHgoMAANgIAQfSgwABB6KDAADYCAEHwoMAAQeigwAA2AgBB/KDAAEHwoMAANgIAQfigwABB8KDAADYCAEGEocAAQfigwAA2AgBBgKHAAEH4oMAANgIAQYyhwABBgKHAADYCAEGIocAAQYChwAA2AgBBlKHAAEGIocAANgIAQZChwABBiKHAADYCAEGcocAAQZChwAA2AgBBpKHAAEGYocAANgIAQZihwABBkKHAADYCAEGsocAAQaChwAA2AgBBoKHAAEGYocAANgIAQbShwABBqKHAADYCAEGoocAAQaChwAA2AgBBvKHAAEGwocAANgIAQbChwABBqKHAADYCAEHEocAAQbihwAA2AgBBuKHAAEGwocAANgIAQcyhwABBwKHAADYCAEHAocAAQbihwAA2AgBB1KHAAEHIocAANgIAQcihwABBwKHAADYCAEHcocAAQdChwAA2AgBB0KHAAEHIocAANgIAQeShwABB2KHAADYCAEHYocAAQdChwAA2AgBB7KHAAEHgocAANgIAQeChwABB2KHAADYCAEH0ocAAQeihwAA2AgBB6KHAAEHgocAANgIAQfyhwABB8KHAADYCAEHwocAAQeihwAA2AgBBhKLAAEH4ocAANgIAQfihwABB8KHAADYCAEGMosAAQYCiwAA2AgBBgKLAAEH4ocAANgIAQZSiwABBiKLAADYCAEGIosAAQYCiwAA2AgBBrKLAACABNgIAQZCiwABBiKLAADYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCAAwHCyACIARJIAEgAk1yDQAgACgCDEUNAwtBvKLAAEG8osAAKAIAIgAgASAAIAFJGzYCACABIANqIQRBgKDAACEAAkACQANAIAQgACgCACIGRwRAIAAoAggiAA0BDAILCyAAKAIMRQ0BC0GAoMAAIQADQAJAIAIgACgCACIETwRAIAIgBCAAKAIEaiIGSQ0BCyAAKAIIIQAMAQsLQayiwAAgATYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCACACIAZBIGtBeHFBCGsiACAAIAJBEGpJGyIEQRs2AgRBgKDAACkCACEJIARBEGpBiKDAACkCADcCACAEIAk3AghBhKDAACADNgIAQYCgwAAgATYCAEGIoMAAIARBCGo2AgBBjKDAAEEANgIAIARBHGohAANAIABBBzYCACAAQQRqIgAg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QZyiwABBnKLAACgCACADcjYCAA8LAkACQCABIAQoAgAiAygCBEF4cUYEQCADIQIMAQsgAUEZIAJBAXZrQQAgAkEfRxt0IQUDQCADIAVBHXZBBHFqQRBqIgQoAgAiAkUNAiAFQQF0IQUgAiEDIAIoAgRBeHEgAUcNAAsLIAIoAggiASAANgIMIAIgADYCCCAAQQA2AhggACACNgIMIAAgATYCCA8LIAQgADYCACAAIAM2AhggACAANgIMIAAgADYCCAuBAgEFfyMAQYABayIEJAACfwJAAkAgASgCHCICQRBxRQRAIAJBIHENASAAIAEQDwwDC0H/ACECA0AgBCACIgNqIgUgAEEPcSICQTByIAJB1wBqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsMAQtB/wAhAgNAIAQgAiIDaiIFIABBD3EiAkEwciACQTdqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkMAQsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkLIARBgAFqJAALuQIAIAIEQCABIAJBiAFsaiECA0AgACAAKQMAIAEpAACFNwMAIAAgACkDCCABKQAIhTcDCCAAIAApAxAgASkAEIU3AxAgACAAKQMYIAEpABiFNwMYIAAgACkDICABKQAghTcDICAAIAApAyggASkAKIU3AyggACAAKQMwIAEpADCFNwMwIAAgACkDOCABKQA4hTcDOCAAIAApA0AgASkAQIU3A0AgACAAKQNIIAEpAEiFNwNIIAAgACkDUCABKQBQhTcDUCAAIAApA1ggASkAWIU3A1ggACAAKQNgIAEpAGCFNwNgIAAgACkDaCABKQBohTcDaCAAIAApA3AgASkAcIU3A3AgACAAKQN4IAEpAHiFNwN4IAAgACkDgAEgASkAgAGFNwOAASAAEAQgAUGIAWoiASACRw0ACwsLsAEBAn8jAEEgayIDJAAgASABIAJqIgJLBEBBAEEAECgAC0EIIAAoAgAiAUEBdCIEIAIgAiAESRsiAiACQQhNGyIEQQBIBEBBAEEAECgACyADIAEEfyADIAE2AhwgAyAAKAIENgIUQQEFQQALNgIYIANBCGogBCADQRRqEB0gAygCCEEBRgRAIAMoAgwgAygCEBAoAAsgAygCDCEBIAAgBDYCACAAIAE2AgQgA0EgaiQAC7ABAQR/IwBBIGsiASQAIAAoAgAiAkF/RgRAQQBBABAoAAtBCCACQQF0IgMgAkEBaiIEIAMgBEsbIgMgA0EITRsiA0EASARAQQBBABAoAAsgASACBH8gASACNgIcIAEgACgCBDYCFEEBBUEACzYCGCABQQhqIAMgAUEUahAdIAEoAghBAUYEQCABKAIMIAEoAhAQKAALIAEoAgwhAiAAIAM2AgAgACACNgIEIAFBIGokAAuOAQECfyABQRBPBEAgAEEAIABrQQNxIgNqIQIgAwRAA0AgAEEAOgAAIABBAWoiACACSQ0ACwsgAiABIANrIgFBfHEiA2ohACADQQBKBEADQCACQQA2AgAgAkEEaiICIABJDQALCyABQQNxIQELIAEEQCAAIAFqIQEDQCAAQQA6AAAgAEEBaiIAIAFJDQALCwtsAQN/AkACQCAAKAIAIgIEQCAAKAIEIgBBBGsoAgAiAUF4cSIDQQRBCCABQQNxIgEbIAJqSQ0BIAFBACADIAJBJ2pLGw0CIAAQBQsPC0H5ncAAQS5BqJ7AABAgAAtBuJ7AAEEuQeiewAAQIAALewEBfyMAQRBrIgMkAEH8nsAAQfyewAAoAgAiBEEBajYCAAJAIARBAEgNAAJAQciiwAAtAABFBEBBxKLAAEHEosAAKAIAQQFqNgIAQfiewAAoAgBBAE4NAQwCCyADQQhqIAAgARECAAALQciiwABBADoAACACRQ0AAAsAC2wCAX8BfiMAQTBrIgEkACABIAA2AgAgAUGAATYCBCABQQI2AgwgAUGAhsAANgIIIAFCAjcCFCABQoCAgIAwIgIgAUEEaq2ENwMoIAEgAiABrYQ3AyAgASABQSBqNgIQIAFBCGpB8IPAABAkAAtoAgF/AX4jAEEwayIDJAAgAyABNgIEIAMgADYCACADQQI2AgwgA0G4g8AANgIIIANCAjcCFCADQoCAgIAwIgQgA62ENwMoIAMgBCADQQRqrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtoAgF/AX4jAEEwayIDJAAgAyAANgIAIAMgATYCBCADQQI2AgwgA0HUhsAANgIIIANCAjcCFCADQoCAgIAwIgQgA0EEaq2ENwMoIAMgBCADrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtiAQF/AkACQCABBEAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpJDQEgAkEAIAMgAUEnaksbDQIgABAFCw8LQfmdwABBLkGonsAAECAAC0G4nsAAQS5B6J7AABAgAAtbAQJ/AkAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpPBEAgAkEAIAMgAUEnaksbDQEgABAFDwtB+Z3AAEEuQaiewAAQIAALQbiewABBLkHonsAAECAAC1gBAX8CfyACKAIEBEACQCACKAIIIgNFBEAMAQsgAigCACADQQEgARAHDAILC0HJosAALQAAGiABEAALIQIgACABNgIIIAAgAkEBIAIbNgIEIAAgAkU2AgALSAACQCABaUEBR0GAgICAeCABayAASXINACAABEBByaLAAC0AABoCfyABQQlPBEAgASAAEAoMAQsgABAACyIBRQ0BCyABDwsAC0EBAX8gAiAAKAIAIAAoAggiA2tLBEAgACADIAIQEyAAKAIIIQMLIAAoAgQgA2ogASACEA0aIAAgAiADajYCCEEAC0EBAX8jAEEgayIDJAAgA0EANgIQIANBATYCBCADQgQ3AgggAyABNgIcIAMgADYCGCADIANBGGo2AgAgAyACECQACzgAAkAgAkGAgMQARg0AIAAgAiABKAIQEQAARQ0AQQEPCyADRQRAQQAPCyAAIAMgBCABKAIMEQEACzwBAX9BASECAkAgACgCACABEBENACABKAIUQciCwABBAiABKAIYKAIMEQEADQAgACgCBCABEBEhAgsgAgstAAJAIANpQQFHQYCAgIB4IANrIAFJckUEQCAAIAEgAyACEAciAA0BCwALIAAL6gECAn8BfiMAQRBrIgIkACACQQE7AQwgAiABNgIIIAIgADYCBCMAQRBrIgEkACACQQRqIgApAgAhBCABIAA2AgwgASAENwIEIwBBEGsiACQAIAFBBGoiASgCACICKAIMIQMCQAJAAkACQCACKAIEDgIAAQILIAMNAUEBIQJBACEDDAILIAMNACACKAIAIgIoAgQhAyACKAIAIQIMAQsgAEGAgICAeDYCACAAIAE2AgwgAEEGIAEoAggiAC0ACCAALQAJEBcACyAAIAM2AgQgACACNgIAIABBByABKAIIIgAtAAggAC0A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AgAgBkEDdGoiACgCACAAKAIEIAIoAiQoAgwRAQBFDQELQQEMAQtBAAsgAkEwaiQACwsAIAAoAgAgARAPCwwAIAAgASkCADcDAAsJACAAQQA2AgALC/weAgBBgIDAAAtBRXJyb3IAAAAIAAAADAAAAAQAAAAJAAAACgAAAAsAAABzaGEzLXdhc20vc3JjL2xpYi5ycyAAEAAUAAAASQAAADMAQcyAwAALqR4BAAAADAAAAGEgRGlzcGxheSBpbXBsZW1lbnRhdGlvbiByZXR1cm5lZCBhbiBlcnJvciB1bmV4cGVjdGVkbHkvVXNlcnMvcnoucGFuLy5ydXN0dXAvdG9vbGNoYWlucy9zdGFibGUtYWFyY2g2NC1hcHBsZS1kYXJ3aW4vbGliL3J1c3RsaWIvc3JjL3J1c3QvbGlicmFyeS9hbGxvYy9zcmMvc3RyaW5nLnJziwAQAG0AAAB7CgAADgAAAGNhcGFjaXR5IG92ZXJmbG93AAAACAEQABEAAABhbGxvYy9zcmMvcmF3X3ZlYy5ycyQBEAAUAAAAGAAAAAUAAAAuLjAxMjM0NTY3ODlhYmNkZWZjYWxsZWQgYE9wdGlvbjo6dW53cmFwKClgIG9uIGEgYE5vbmVgIHZhbHVlaW5kZXggb3V0IG9mIGJvdW5kczogdGhlIGxlbiBpcyAgYnV0IHRoZSBpbmRleCBpcyAAhQEQACAAAAClARAAEgAAADogAAABAAAAAAAAAMgBEAACAAAAY29yZS9zcmMvZm10L251bS5ycwDcARAAEwAAAGYAAAAXAAAAMHgwMDAxMDIwMzA0MDUwNjA3MDgwOTEwMTExMjEzMTQxNTE2MTcxODE5MjAyMTIyMjMyNDI1MjYyNzI4MjkzMDMxMzIzMzM0MzUzNjM3MzgzOTQwNDE0MjQzNDQ0NTQ2NDc0ODQ5NTA1MTUyNTM1NDU1NTY1NzU4NTk2MDYxNjI2MzY0NjU2NjY3Njg2OTcwNzE3MjczNzQ3NTc2Nzc3ODc5ODA4MTgyODM4NDg1ODY4Nzg4ODk5MDkxOTI5Mzk0OTU5Njk3OTg5OXJhbmdlIHN0YXJ0IGluZGV4ICBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCAAAMoCEAASAAAA3AIQACIAAAByYW5nZSBlbmQgaW5kZXggEAMQABAA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";

  // src/inject/pow.ts
  var SUPPORTED_ALGORITHM = "DeepSeekHashV1";
  var wasmInstance = null;
  var textEncoder = new TextEncoder();
  async function loadWasm() {
    if (wasmInstance) return wasmInstance;
    const binary = Uint8Array.from(atob(WASM_BASE64), (c) => c.charCodeAt(0));
    const { instance } = await WebAssembly.instantiate(binary, {});
    wasmInstance = instance.exports;
    return wasmInstance;
  }
  function writeWasmString(wasm, value) {
    const bytes = textEncoder.encode(value);
    const ptr = wasm.__wbindgen_export_0(bytes.length, 1);
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  }
  function solvePowWithWasm(wasm, target, prefix, difficulty) {
    const retPtr = wasm.__wbindgen_add_to_stack_pointer(-16);
    const challengeAlloc = writeWasmString(wasm, target);
    const prefixAlloc = writeWasmString(wasm, prefix);
    try {
      wasm.wasm_solve(retPtr, challengeAlloc.ptr, challengeAlloc.len, prefixAlloc.ptr, prefixAlloc.len, difficulty);
      const view = new DataView(wasm.memory.buffer);
      const status = view.getInt32(retPtr, true);
      const answer = view.getFloat64(retPtr + 8, true);
      if (status !== 1 || !Number.isSafeInteger(answer) || answer < 0) {
        throw new Error(`No PoW solution found before difficulty ${difficulty}`);
      }
      return answer;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  async function createPowChallenge(headers, targetPath) {
    const resp = await fetch("/api/v0/chat/create_pow_challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ target_path: targetPath }),
      credentials: "include"
    });
    const respText = await resp.text();
    if (!resp.ok) throw new Error(`PoW challenge failed: ${resp.status} ${respText.slice(0, 200)}`);
    const data = JSON.parse(respText);
    const challenge = data?.data?.biz_data?.challenge ?? data?.data?.challenge ?? data?.challenge ?? data;
    if (!challenge?.challenge) throw new Error(`Invalid PoW challenge response: ${respText.slice(0, 300)}`);
    return {
      algorithm: String(challenge.algorithm),
      challenge: String(challenge.challenge),
      salt: String(challenge.salt),
      difficulty: Number(challenge.difficulty),
      signature: String(challenge.signature),
      expire_at: Number(challenge.expire_at ?? challenge.expireAt ?? 0),
      expire_after: Number(challenge.expire_after ?? challenge.expireAfter ?? 0)
    };
  }
  function base64EncodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  async function createPowHeaders(headers, targetPath = "/api/v0/chat/completion") {
    const challenge = await createPowChallenge(headers, targetPath);
    if (challenge.algorithm !== SUPPORTED_ALGORITHM) {
      throw new Error(`Unsupported PoW algorithm: ${challenge.algorithm}`);
    }
    const wasm = await loadWasm();
    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const answer = solvePowWithWasm(wasm, challenge.challenge.toLowerCase(), prefix, challenge.difficulty);
    const powAnswer = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature
    };
    return {
      "X-DS-PoW-Response": base64EncodeUtf8(JSON.stringify({ ...powAnswer, target_path: targetPath }))
    };
  }

  // src/inject/tool-card-ui.ts
  function escapeHtml(value) {
    const str = typeof value === "string" ? value : String(value ?? "");
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function isSafeImageUrl(url) {
    if (url.startsWith("data:image/")) return true;
    if (url.startsWith("https://")) return true;
    return false;
  }
  var CARD_STYLE = `
  .ds-studio-tools-container {
    margin: 12px 0;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
    font-size: 13px;
    background: #fff;
  }
  .ds-studio-tools-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    cursor: pointer;
    user-select: none;
    font-weight: 500;
    color: #374151;
  }
  .ds-studio-tools-header:hover { background: #f3f4f6; }
  .ds-studio-tools-arrow {
    display: inline-block;
    width: 16px;
    height: 16px;
    text-align: center;
    line-height: 16px;
    transition: transform 0.2s;
    color: #6b7280;
    font-size: 10px;
  }
  .ds-studio-tools-container.collapsed .ds-studio-tools-arrow { transform: rotate(-90deg); }
  .ds-studio-tools-container.collapsed .ds-studio-tools-body { display: none; }
  .ds-studio-tools-count {
    background: #e5e7eb;
    color: #4b5563;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
  }
  .ds-studio-tools-body { padding: 8px; }

  .ds-studio-tool-card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    margin: 6px 0;
    overflow: hidden;
    background: #fff;
  }
  .ds-studio-tool-card:first-child { margin-top: 0; }
  .ds-studio-tool-card:last-child { margin-bottom: 0; }
  .ds-studio-tool-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #fafafa;
    border-bottom: 1px solid #f0f0f0;
    font-weight: 500;
    color: #374151;
  }
  .ds-studio-tool-card-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
  }
  .ds-studio-tool-card-badge.ok { background: #dcfce7; color: #166534; }
  .ds-studio-tool-card-badge.err { background: #fee2e2; color: #991b1b; }
  .ds-studio-tool-card-badge.running { background: #dbeafe; color: #1e40af; }
  .ds-studio-tool-card-badge.terminated { background: #fef3c7; color: #92400e; }
  .ds-studio-tool-card-badge .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: currentColor;
  }
  .ds-studio-tool-card-badge.running .dot { animation: ds-pulse 1s infinite; }
  @keyframes ds-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .ds-studio-tool-card-name { font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; }
  .ds-studio-tool-card-duration { margin-left: auto; color: #9ca3af; font-size: 11px; }
  .ds-studio-tool-card-body { padding: 10px 12px; }
  .ds-studio-tool-card pre {
    margin: 0;
    padding: 8px 10px;
    background: #f9fafb;
    border-radius: 6px;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    color: #1f2937;
    line-height: 1.5;
    max-height: 400px;
    overflow-y: auto;
  }
  .ds-studio-tool-card-label {
    font-size: 11px;
    color: #6b7280;
    margin-bottom: 4px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .ds-studio-tool-card-section { margin-bottom: 8px; }
  .ds-studio-tool-card-section:last-child { margin-bottom: 0; }
  .ds-studio-tool-card-result-collapsed {
    position: relative;
  }
  .ds-studio-tool-card-result-collapsed pre {
    max-height: 120px;
    overflow: hidden;
  }
  .ds-studio-tool-card-result-collapsed::after {
    content: '';
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 40px;
    background: linear-gradient(transparent, #fff);
    pointer-events: none;
  }
  .ds-studio-tool-card-expand-btn {
    display: block;
    width: 100%;
    padding: 6px;
    margin-top: 6px;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    font-size: 11px;
    color: #6b7280;
    cursor: pointer;
    text-align: center;
  }
  .ds-studio-tool-card-expand-btn:hover { background: #e5e7eb; color: #374151; }
  .ds-studio-tool-card-images {
    margin-bottom: 8px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid #e5e7eb;
  }
  .ds-studio-tool-card-image {
    display: block;
    max-width: 100%;
    height: auto;
    cursor: zoom-in;
  }
`;
  var styleInjected = false;
  function ensureStyle() {
    if (styleInjected) return;
    const style = document.createElement("style");
    style.textContent = CARD_STYLE;
    const head = document.head ?? document.documentElement;
    head.appendChild(style);
    styleInjected = true;
  }
  function findLastAssistantMessage() {
    const studioNodes = document.querySelectorAll(".ds-sc-msg-assistant");
    if (studioNodes.length > 0) return studioNodes[studioNodes.length - 1];
    const selectors = [
      ".ds-assistant-message-main-content",
      '[class*="assistant-message"]',
      '[class*="message-item"]',
      ".message"
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) return nodes[nodes.length - 1];
    }
    return null;
  }
  function formatJson2(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }
  function formatResult(result2) {
    return formatToolResultText(result2);
  }
  function getOrCreateToolsContainer() {
    const container = findLastAssistantMessage();
    if (!container) return null;
    let toolsContainer = container.querySelector(".ds-studio-tools-container");
    if (toolsContainer) return toolsContainer;
    toolsContainer = document.createElement("div");
    toolsContainer.className = "ds-studio-tools-container";
    toolsContainer.innerHTML = `
    <div class="ds-studio-tools-header">
      <span class="ds-studio-tools-arrow">\u25BC</span>
      <span>\u5DF2\u8C03\u7528\u5DE5\u5177</span>
      <span class="ds-studio-tools-count">0</span>
    </div>
    <div class="ds-studio-tools-body"></div>
  `;
    const header = toolsContainer.querySelector(".ds-studio-tools-header");
    header.addEventListener("click", () => {
      toolsContainer.classList.toggle("collapsed");
    });
    container.insertBefore(toolsContainer, container.firstChild);
    return toolsContainer;
  }
  function updateToolsCount() {
    const container = findLastAssistantMessage();
    if (!container) return;
    const toolsContainer = container.querySelector(".ds-studio-tools-container");
    if (!toolsContainer) return;
    const cards = toolsContainer.querySelectorAll(".ds-studio-tool-card");
    const countEl = toolsContainer.querySelector(".ds-studio-tools-count");
    if (countEl) countEl.textContent = String(cards.length);
  }
  function buildCardHtml(data, _callId) {
    const failed = data.result ? data.result.isError === true || data.result.ok === false : false;
    const status = data.result ? failed ? "err" : "ok" : "running";
    const statusText = data.result ? failed ? "\u6267\u884C\u5931\u8D25" : "\u5DF2\u6267\u884C" : "\u6267\u884C\u4E2D";
    const terminated = !!data.result && data.result.terminate === true;
    const resultText = data.result ? formatResult(data.result) : "";
    const isLongResult = resultText.length > 2048;
    const imageUrls = [];
    if (data.result?.content) {
      for (const c of data.result.content) {
        if (c.type === "image_url" && c.image_url?.url && isSafeImageUrl(c.image_url.url)) {
          imageUrls.push(c.image_url.url);
        }
      }
    }
    const imagesHtml = imageUrls.length > 0 ? imageUrls.map((url) => `<img class="ds-studio-tool-card-image" src="${escapeHtml(url)}" alt="tool result image" />`).join("") : "";
    return `
    <div class="ds-studio-tool-card-header">
      <span class="ds-studio-tool-card-badge ${status}"><span class="dot"></span>${statusText}</span>
      ${terminated ? '<span class="ds-studio-tool-card-badge terminated"><span class="dot"></span>\u5DF2\u7EC8\u6B62\u7EED\u8DD1</span>' : ""}
      <span class="ds-studio-tool-card-name">${escapeHtml(data.toolName)}</span>
      ${data.durationMs ? `<span class="ds-studio-tool-card-duration">${data.durationMs}ms</span>` : ""}
    </div>
    <div class="ds-studio-tool-card-body">
      <div class="ds-studio-tool-card-section">
        <div class="ds-studio-tool-card-label">\u53C2\u6570</div>
        <pre>${escapeHtml(formatJson2(data.params))}</pre>
      </div>
      ${data.result ? `
      <div class="ds-studio-tool-card-section ${isLongResult && !imagesHtml ? "ds-studio-tool-card-result-collapsed" : ""}">
        <div class="ds-studio-tool-card-label">\u7ED3\u679C</div>
        ${imagesHtml ? `<div class="ds-studio-tool-card-images">${imagesHtml}</div>` : ""}
        <pre>${escapeHtml(resultText)}</pre>
        ${isLongResult && !imagesHtml ? '<button class="ds-studio-tool-card-expand-btn">\u5C55\u5F00\u5168\u90E8</button>' : ""}
      </div>
      ` : ""}
    </div>
  `;
  }
  function createToolCard(data, callId) {
    ensureStyle();
    const toolsContainer = getOrCreateToolsContainer();
    if (!toolsContainer) return null;
    const body = toolsContainer.querySelector(".ds-studio-tools-body");
    const card = document.createElement("div");
    card.className = "ds-studio-tool-card";
    card.dataset.callId = callId;
    card.dataset.toolName = data.toolName;
    card.innerHTML = buildCardHtml(data, callId);
    body.appendChild(card);
    updateToolsCount();
    return callId;
  }
  function updateToolCardByCallId(callId, data, result2, durationMs) {
    let card = document.querySelector(`.ds-studio-tool-card[data-call-id="${callId}"]`);
    if (!card) {
      const toolsContainer = getOrCreateToolsContainer();
      if (!toolsContainer) return;
      const body = toolsContainer.querySelector(".ds-studio-tools-body");
      card = document.createElement("div");
      card.className = "ds-studio-tool-card";
      card.dataset.callId = callId;
      card.dataset.toolName = data.toolName;
      body.appendChild(card);
      updateToolsCount();
    }
    const fullData = { ...data, result: result2, durationMs };
    card.innerHTML = buildCardHtml(fullData, callId);
    const expandBtn = card.querySelector(".ds-studio-tool-card-expand-btn");
    if (expandBtn) {
      expandBtn.addEventListener("click", () => {
        const section = expandBtn.closest(".ds-studio-tool-card-section");
        if (section) {
          section.classList.remove("ds-studio-tool-card-result-collapsed");
          expandBtn.remove();
        }
      });
    }
  }
  function stripRawToolTagsFromMessage() {
    const container = findLastAssistantMessage();
    if (!container) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const toRemove = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (/<(shell_exec|local_file_read|local_file_write|local_file_stat)>/.test(node.textContent ?? "")) {
        toRemove.push(node);
      }
    }
    for (const node of toRemove) {
      node.textContent = node.textContent?.replace(/<(shell_exec|local_file_read|local_file_write|local_file_stat)>[\s\S]*?<\/\1>/g, "") ?? "";
    }
  }

  // src/inject/step-flow-ui.ts
  var STEP_FLOW_STYLE_ID = "ds-studio-step-flow-css";
  var svgDataUri = (body, viewBox = "0 0 24 24") => `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor">${body}</svg>`
  )}")`;
  var ICON_GEAR = svgDataUri('<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62-.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>');
  var ICON_CHEVRON_DOWN = svgDataUri('<path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>');
  var ICON_CHEVRON_RIGHT = svgDataUri('<path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>');
  function injectStepFlowStyles() {
    if (document.getElementById(STEP_FLOW_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STEP_FLOW_STYLE_ID;
    style.textContent = `
    .ds-sf-container { position: fixed; bottom: 160px; left: 50%; transform: translateX(-50%); width: min(768px, 92vw); max-height: 240px; margin: 0; padding: 8px 14px; border-radius: 10px; background: #eef0ff; color: #1f2329; z-index: 2147483647; box-shadow: 0 2px 12px rgba(51,112,255,.12); overflow: hidden; display: flex; flex-direction: column; }
    /* v1.7\uFF1A\u6B65\u9AA4\u6D41\u4E3B\u4F53\u53EF\u6EDA\u52A8\uFF0C\u5BB9\u5668 max-height \u9650\u5236\u4E0D\u65E0\u9650\u589E\u9AD8\u6321\u4F4F\u5BF9\u8BDD\u5185\u5BB9 */
    .ds-sf-stream { flex: 1; min-height: 0; overflow-y: auto; }
    .ds-sf-status-line { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; line-height: 1.5; color: #646a73; }
    .ds-sf-status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #8f959e; }
    .ds-sf-container[data-phase="running"] .ds-sf-status-dot { background: #3370ff; animation: ds-sf-pulse 1.1s ease-in-out infinite; }
    .ds-sf-container[data-phase="complete"] .ds-sf-status-dot { background: #34a853; }
    .ds-sf-container[data-phase="error"] .ds-sf-status-dot { background: #e5484d; }
    @keyframes ds-sf-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
    .ds-sf-status-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ds-sf-container[data-phase="error"] .ds-sf-status-text { color: #e5484d; }
    .ds-sf-stop-btn { flex: none; padding: 2px 9px; font-size: 12px; border: 1px solid #e5484d; border-radius: 6px; background: transparent; color: #e5484d; cursor: pointer; }
    .ds-sf-stop-btn:hover { background: #fef0f0; }

    /* \u63A8\u7406\u7B14\u8BB0\uFF08\u6298\u53E0\uFF09 */
    .ds-sf-reasoning-note { margin: 4px 0; }
    .ds-sf-reasoning-note-toggle { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; color: #646a73; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-reasoning-note-icon { flex: none; width: 14px; height: 14px; background: currentColor; opacity: .6; mask-image: ${ICON_CHEVRON_RIGHT}; mask-size: contain; -webkit-mask-image: ${ICON_CHEVRON_RIGHT}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-reasoning-note-toggle[aria-expanded="true"] .ds-sf-reasoning-note-icon { transform: rotate(90deg); }
    .ds-sf-reasoning-note-title { flex: 1; }
    .ds-sf-reasoning-note-body { padding: 4px 0 4px 20px; font-size: 13px; line-height: 1.6; color: #646a73; white-space: pre-wrap; word-break: break-word; }

    /* \u6B65\u9AA4\u53D9\u8FF0\u6587\u672C */
    .ds-sf-step { margin: 4px 0; }
    .ds-sf-step-body { font-size: 14px; line-height: 1.7; color: #1f2329; word-break: break-word; }
    .ds-sf-step-body:empty { display: none; }

    /* \u5DE5\u5177\u5206\u7EC4 */
    .ds-sf-tool-group { margin: 4px 0; }
    .ds-sf-tool-group-toggle { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; color: #646a73; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-tool-group-icon { flex: none; width: 14px; height: 14px; background: currentColor; mask-image: ${ICON_GEAR}; mask-size: contain; -webkit-mask-image: ${ICON_GEAR}; -webkit-mask-size: contain; }
    .ds-sf-tool-group-title { flex: 1; }
    .ds-sf-tool-group-chevron { flex: none; width: 14px; height: 14px; background: currentColor; opacity: .6; mask-image: ${ICON_CHEVRON_DOWN}; mask-size: contain; -webkit-mask-image: ${ICON_CHEVRON_DOWN}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-tool-group[data-collapsed="true"] .ds-sf-tool-group-chevron { transform: rotate(-90deg); }
    .ds-sf-tool-group-items { padding-left: 20px; }
    .ds-sf-tool-group[data-collapsed="true"] .ds-sf-tool-group-items { display: none; }

    /* \u5DE5\u5177\u6761\u76EE */
    .ds-sf-tool-item { margin: 2px 0; }
    .ds-sf-tool-toggle { display: flex; align-items: center; gap: 6px; padding: 1px 0; font-size: 13px; color: #1f2329; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-tool-state-icon { flex: none; width: 12px; height: 12px; border-radius: 50%; background: #8f959e; }
    .ds-sf-tool-item[data-tool-status="pending"] .ds-sf-tool-state-icon { background: #3370ff; animation: ds-sf-pulse 1.1s ease-in-out infinite; }
    .ds-sf-tool-item[data-tool-status="ok"] .ds-sf-tool-state-icon { background: #34a853; }
    .ds-sf-tool-item[data-tool-status="err"] .ds-sf-tool-state-icon { background: #e5484d; }
    .ds-sf-tool-name { flex: none; font-weight: 500; }
    .ds-sf-tool-param { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8f959e; }
    .ds-sf-tool-state { flex: none; font-size: 12px; color: #8f959e; }
    .ds-sf-tool-item[data-tool-status="ok"] .ds-sf-tool-state { color: #34a853; }
    .ds-sf-tool-item[data-tool-status="err"] .ds-sf-tool-state { color: #e5484d; }
    .ds-sf-tool-chevron { flex: none; width: 12px; height: 12px; background: currentColor; opacity: .4; mask-image: ${ICON_CHEVRON_RIGHT}; mask-size: contain; -webkit-mask-image: ${ICON_CHEVRON_RIGHT}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-tool-toggle[aria-expanded="true"] .ds-sf-tool-chevron { transform: rotate(90deg); }
    .ds-sf-tool-summary { padding: 4px 0 4px 24px; font-size: 12px; line-height: 1.5; color: #646a73; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
  `;
    document.head.appendChild(style);
  }
  function summarizeParams2(params) {
    if (!params) return null;
    const keys = Object.keys(params);
    if (keys.length === 0) return null;
    const firstKey = keys[0];
    const firstVal = String(params[firstKey]).slice(0, 40);
    return `${firstKey}=${firstVal}`;
  }
  function createStepFlowContainer(onStop) {
    injectStepFlowStyles();
    const container = document.createElement("div");
    container.className = "ds-sf-container";
    container.setAttribute("data-phase", "starting");
    const statusLine = document.createElement("div");
    statusLine.className = "ds-sf-status-line";
    const dot = document.createElement("span");
    dot.className = "ds-sf-status-dot";
    const status = document.createElement("span");
    status.className = "ds-sf-status-text";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "\u6B63\u5728\u542F\u52A8\u2026";
    statusLine.appendChild(dot);
    statusLine.appendChild(status);
    if (onStop) {
      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.className = "ds-sf-stop-btn";
      stopBtn.textContent = "\u505C\u6B62";
      stopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onStop();
      });
      statusLine.appendChild(stopBtn);
    }
    const stream = document.createElement("div");
    stream.className = "ds-sf-stream";
    container.appendChild(statusLine);
    container.appendChild(stream);
    const state = {
      currentToolGroup: null,
      pendingRows: [],
      narrationMap: /* @__PURE__ */ new Map(),
      reasoningMap: /* @__PURE__ */ new Map(),
      stepCount: 0,
      toolCount: 0,
      startTime: Date.now()
    };
    function setPhase(phase, step, toolCount, elapsed) {
      container.setAttribute("data-phase", phase);
      if (phase === "running") {
        const s = step ?? state.stepCount;
        const tc = toolCount ?? state.toolCount;
        const el2 = elapsed ?? Math.round((Date.now() - state.startTime) / 1e3);
        status.textContent = `deepseek++ \u6267\u884C\u4E2D \xB7 \u7B2C${s + 1}\u6B65 \xB7 \u5DF2\u8C03\u7528${tc}\u6B21\u5DE5\u5177 \xB7 ${el2}s`;
      } else if (phase === "complete") {
        status.textContent = `\u5B8C\u6210 \xB7 ${state.stepCount}\u6B65 \xB7 ${state.toolCount}\u6B21\u5DE5\u5177 \xB7 ${Math.round((Date.now() - state.startTime) / 1e3)}s`;
      } else if (phase === "error") {
        status.textContent = `\u51FA\u9519 \xB7 ${state.stepCount}\u6B65 \xB7 ${state.toolCount}\u6B21\u5DE5\u5177`;
      } else if (phase === "paused") {
        status.textContent = `\u6682\u505C \xB7 ${state.stepCount}\u6B65 \xB7 ${state.toolCount}\u6B21\u5DE5\u5177`;
      } else {
        status.textContent = "\u6B63\u5728\u542F\u52A8\u2026";
      }
    }
    function followScroll() {
    }
    function createToolGroup(stepIndex) {
      const group = document.createElement("div");
      group.className = "ds-sf-tool-group";
      group.setAttribute("data-step-index", String(stepIndex));
      group.setAttribute("data-collapsed", "false");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ds-sf-tool-group-toggle";
      toggle.setAttribute("aria-expanded", "true");
      toggle.addEventListener("click", () => {
        group.setAttribute("data-user-toggled", "true");
        const collapsed = group.getAttribute("data-collapsed") === "true";
        group.setAttribute("data-collapsed", collapsed ? "false" : "true");
      });
      const icon2 = document.createElement("span");
      icon2.className = "ds-sf-tool-group-icon";
      const title = document.createElement("span");
      title.className = "ds-sf-tool-group-title";
      const chevron = document.createElement("span");
      chevron.className = "ds-sf-tool-group-chevron";
      toggle.appendChild(icon2);
      toggle.appendChild(title);
      toggle.appendChild(chevron);
      const items = document.createElement("div");
      items.className = "ds-sf-tool-group-items";
      group.appendChild(toggle);
      group.appendChild(items);
      return group;
    }
    function updateGroupCount(group) {
      const title = group.querySelector(".ds-sf-tool-group-title");
      if (!title) return;
      const count = group.querySelectorAll(".ds-sf-tool-item").length;
      title.textContent = `\u5DF2\u8C03\u7528${count}\u6B21\u5DE5\u5177`;
    }
    function addToolEntry(stepIndex, toolName, params) {
      const item = document.createElement("div");
      item.className = "ds-sf-tool-item";
      item.setAttribute("data-tool-status", "pending");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ds-sf-tool-toggle";
      toggle.setAttribute("aria-expanded", "false");
      const stateIcon = document.createElement("span");
      stateIcon.className = "ds-sf-tool-state-icon";
      const name = document.createElement("span");
      name.className = "ds-sf-tool-name";
      name.textContent = toolName;
      const param = document.createElement("span");
      param.className = "ds-sf-tool-param";
      const summary = summarizeParams2(params);
      param.textContent = summary ? `\xB7 ${summary}` : "";
      const stateLabel = document.createElement("span");
      stateLabel.className = "ds-sf-tool-state";
      stateLabel.textContent = "";
      const chevron = document.createElement("span");
      chevron.className = "ds-sf-tool-chevron";
      toggle.appendChild(stateIcon);
      toggle.appendChild(name);
      toggle.appendChild(param);
      toggle.appendChild(stateLabel);
      toggle.appendChild(chevron);
      const detail = document.createElement("div");
      detail.className = "ds-sf-tool-summary";
      detail.hidden = true;
      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
        detail.hidden = expanded;
      });
      item.appendChild(toggle);
      item.appendChild(detail);
      let group = state.currentToolGroup;
      const groupStep = group?.getAttribute("data-step-index");
      if (!group || group.parentElement !== stream || groupStep !== String(stepIndex)) {
        group = createToolGroup(stepIndex);
        stream.appendChild(group);
        state.currentToolGroup = group;
      }
      group.querySelector(".ds-sf-tool-group-items")?.appendChild(item);
      updateGroupCount(group);
      state.pendingRows.push(item);
      state.toolCount++;
      followScroll();
      return state.toolCount;
    }
    function resolveToolEntry(_stepIndex, ok, detail) {
      const row = state.pendingRows.shift();
      if (!row) return;
      row.setAttribute("data-tool-status", ok ? "ok" : "err");
      const stateLabel = row.querySelector(".ds-sf-tool-state");
      if (stateLabel) stateLabel.textContent = ok ? "OK" : "Error";
      const detailEl = row.querySelector(".ds-sf-tool-summary");
      if (detailEl && detail) {
        detailEl.textContent = detail.length > 4e3 ? detail.slice(0, 4e3) + "\n...[\u622A\u65AD]" : detail;
      }
      followScroll();
    }
    function addReasoningNote(stepIndex, text) {
      const existing = state.reasoningMap.get(stepIndex);
      if (existing) {
        const bodyEl = existing.querySelector(".ds-sf-reasoning-note-body");
        if (bodyEl && text != null && bodyEl.textContent !== text) {
          bodyEl.textContent = text;
          followScroll();
        }
        return;
      }
      const note = document.createElement("div");
      note.className = "ds-sf-reasoning-note";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ds-sf-reasoning-note-toggle";
      toggle.setAttribute("aria-expanded", "false");
      const icon2 = document.createElement("span");
      icon2.className = "ds-sf-reasoning-note-icon";
      const title = document.createElement("span");
      title.className = "ds-sf-reasoning-note-title";
      title.textContent = `\u5DF2\u601D\u8003 \xB7 \u7B2C${stepIndex + 1}\u6B65`;
      toggle.appendChild(icon2);
      toggle.appendChild(title);
      const body = document.createElement("div");
      body.className = "ds-sf-reasoning-note-body";
      body.hidden = true;
      body.textContent = text ?? "\u8BE5\u6B65\u9AA4\u7684\u601D\u8003\u8FC7\u7A0B\u672A\u4FDD\u7559";
      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
        body.hidden = expanded;
      });
      note.appendChild(toggle);
      note.appendChild(body);
      stream.appendChild(note);
      state.reasoningMap.set(stepIndex, note);
      followScroll();
    }
    function updateNarration(stepIndex, text) {
      let narration = state.narrationMap.get(stepIndex);
      if (!narration) {
        narration = document.createElement("div");
        narration.className = "ds-sf-step";
        narration.setAttribute("data-step-index", String(stepIndex));
        const body2 = document.createElement("div");
        body2.className = "ds-sf-step-body";
        narration.appendChild(body2);
        stream.appendChild(narration);
        state.narrationMap.set(stepIndex, narration);
        state.stepCount = Math.max(state.stepCount, stepIndex + 1);
      }
      const body = narration.querySelector(".ds-sf-step-body");
      if (body && body.textContent !== text) {
        body.textContent = text;
        followScroll();
      }
    }
    function finish(totalSteps, totalTools, _elapsed) {
      state.stepCount = totalSteps;
      state.toolCount = totalTools;
      stream.querySelectorAll(".ds-sf-tool-group").forEach((group) => {
        if (group.getAttribute("data-user-toggled") !== "true") {
          group.setAttribute("data-collapsed", "true");
        }
      });
      state.currentToolGroup = null;
      setPhase("complete");
    }
    function destroy() {
      container.remove();
      document.getElementById(STEP_FLOW_STYLE_ID)?.remove();
    }
    return {
      container,
      setPhase,
      addToolEntry,
      resolveToolEntry,
      addReasoningNote,
      updateNarration,
      finish,
      destroy
    };
  }

  // src/inject/render-code-runner.ts
  var RUNNABLE_LANGS = /* @__PURE__ */ new Set(["javascript", "js", "typescript", "ts", "python", "py"]);
  function isRunnableLanguage(lang) {
    return RUNNABLE_LANGS.has(lang.toLowerCase());
  }
  function normalizeLanguage(lang) {
    const lower = lang.toLowerCase();
    if (lower === "python" || lower === "py") return "python";
    if (lower === "typescript" || lower === "ts") return "typescript";
    return "javascript";
  }
  function addRunButtonToCodeBlock(preElement, code2, language, runner) {
    if (!isRunnableLanguage(language)) return;
    if (preElement.querySelector(".ds-code-run-btn")) return;
    const btn = document.createElement("button");
    btn.className = "ds-code-run-btn";
    btn.textContent = "\u8FD0\u884C";
    btn.style.cssText = "position:absolute;top:4px;right:8px;padding:2px 8px;font-size:12px;background:#3370ff;color:#fff;border:none;border-radius:4px;cursor:pointer;";
    btn.addEventListener("click", async () => {
      btn.textContent = "\u8FD0\u884C\u4E2D...";
      btn.disabled = true;
      try {
        const result2 = await runner(code2, normalizeLanguage(language));
        const output = document.createElement("div");
        output.style.cssText = "margin-top:8px;padding:8px;background:#f6f8fa;border-radius:4px;font-size:12px;white-space:pre-wrap;";
        if (result2.ok) {
          output.textContent = result2.stdout || "OK";
          if (result2.stderr) output.textContent += `
[stderr]
${result2.stderr}`;
        } else {
          output.textContent = `\u9519\u8BEF: ${result2.error ?? result2.stderr ?? "\u672A\u77E5\u9519\u8BEF"}`;
          output.style.color = "#e5484d";
        }
        preElement.parentElement?.appendChild(output);
      } catch (e) {
        btn.textContent = "\u5931\u8D25";
        btn.disabled = false;
        return;
      }
      btn.textContent = "\u5DF2\u8FD0\u884C";
    });
    preElement.style.position = "relative";
    preElement.appendChild(btn);
  }
  function hydrateCodeBlocks(container, runner) {
    const codeBlocks = container.querySelectorAll("pre");
    codeBlocks.forEach((pre) => {
      const code2 = pre.querySelector("code");
      if (!code2) return;
      const lang = code2.className.replace(/^language-/, "");
      addRunButtonToCodeBlock(pre, code2.textContent ?? "", lang, runner);
    });
  }

  // src/inject/main-world-interceptor.ts
  var RAW_TOOL_TAG_GLOBAL_RE = /<(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>[\s\S]*?<\/(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>/g;
  function stripRawToolTags(text) {
    return text.replace(RAW_TOOL_TAG_GLOBAL_RE, "");
  }
  var currentMemories = [];
  var currentMcpTools = [];
  var stepFlow = null;
  var stepFlowStep = 0;
  var stepFlowToolCount = 0;
  var stepFlowStartTime = 0;
  var stepReasoningAccum = "";
  function formatToolResultBlock(results) {
    const lines = results.map((p) => {
      const head = `[tool-result:${p.invocationName}]`;
      if (!p.ok) return `${head}
<error>${p.error ?? "unknown"}</error>`;
      if (p.result && typeof p.result === "object" && "stdout" in p.result) {
        const r = p.result;
        const stdout = typeof r.stdout === "string" ? r.stdout : "";
        const stderr = typeof r.stderr === "string" ? r.stderr : "";
        const exitCode = r.exitCode ?? "";
        const parts = [];
        if (stdout.trim()) parts.push(stdout.trimEnd());
        if (stderr.trim()) parts.push(`<stderr>
${stderr.trimEnd()}
</stderr>`);
        if (exitCode !== "" && exitCode !== 0) parts.push(`<exit-code>${exitCode}</exit-code>`);
        return `${head}
${parts.join("\n\n") || "(empty output)"}`;
      }
      const data = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? null);
      return `${head}
${data}`;
    });
    return `\u3010\u5DE5\u5177\u6267\u884C\u7ED3\u679C\u3011
${lines.join("\n\n")}`;
  }
  function reinjectIntoPrompt(prompt, results) {
    if (results.length === 0) return prompt;
    return `${prompt}

${formatToolResultBlock(results)}`;
  }
  function isDeepSeekChatEndpoint(url, method) {
    try {
      const base = globalThis.location?.href;
      const u = base ? new URL(url, base) : new URL(url);
      return u.hostname.endsWith("deepseek.com") && method.toUpperCase() === "POST" && u.pathname === "/api/v0/chat/completion";
    } catch {
      return false;
    }
  }
  function resolveUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
  }
  function methodOf(input, init) {
    if (init?.method) return String(init.method);
    if (typeof input !== "string" && !(input instanceof URL) && input.method) return input.method;
    return "GET";
  }
  var TOOL_CAPABILITY_MARKER = "[studio-tool-capability]";
  var TOOL_CAPABILITY_PROMPT = `${TOOL_CAPABILITY_MARKER}
## \u89D2\u8272
\u4F60\u662F DeepSeek Studio \u7684\u672C\u5730\u5DE5\u5177\u4EE3\u7406\uFF0C\u53EF\u4EE5\u64CD\u4F5C\u7528\u6237\u7535\u8111\u4E0A\u7684\u6587\u4EF6\u3001\u6267\u884C\u547D\u4EE4\u3001\u4FDD\u5B58\u957F\u671F\u8BB0\u5FC6\u3002

## \u5DE5\u5177\u8C03\u7528
\u4F60\u53EF\u4EE5\u901A\u8FC7\u8F93\u51FA\u76F4\u63A5 XML \u6807\u7B7E\u6765\u8C03\u7528\u5DE5\u5177\uFF0C\u6807\u7B7E\u4F53\u5185\u5FC5\u987B\u662F\u5408\u6CD5 JSON\uFF1A

<local_file_read>{"path":"E:/Users/name/file.txt"}</local_file_read>
<local_file_write>{"path":"E:/Users/name/file.txt","content":"\u8981\u5199\u5165\u7684\u6587\u672C"}</local_file_write>
<local_file_stat>{"path":"E:/Users/name"}</local_file_stat>
<shell_exec>{"command":"powershell -NoProfile -Command "Get-ChildItem -LiteralPath 'E:/Users/name' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 10""}</shell_exec>
<memory_save>{"type":"user","name":"\u7528\u6237\u89D2\u8272","content":"\u524D\u7AEF\u5F00\u53D1\u8005\uFF0C\u4E3B\u8981\u4F7F\u7528 React \u548C TypeScript","tags":["frontend","React"]}</memory_save>
<python_exec>{"code":"print('hello')"}</python_exec>

## \u89C4\u5219
- \u6807\u7B7E\u540D\u5FC5\u987B\u5339\u914D\u53EF\u7528\u5DE5\u5177\uFF1BJSON body \u5FC5\u987B\u662F\u5408\u6CD5 JSON\uFF08\u5B57\u7B26\u4E32\u7528\u53CC\u5F15\u53F7\uFF0C\u4E0D\u8981\u6709\u591A\u4F59\u9017\u53F7\u6216\u6CE8\u91CA\uFF09
- \u5DE5\u5177\u8C03\u7528\u653E\u5728\u6700\u7EC8\u56DE\u7B54\u6B63\u6587\u91CC\uFF0C\u4E0D\u8981\u653E\u5728\u601D\u8003/\u63A8\u7406\u533A\u57DF\uFF0C\u4E0D\u8981\u653E\u5728 Markdown \u4EE3\u7801\u5757\u91CC
- \u5DE5\u5177\u6807\u7B7E\u5FC5\u987B\u72EC\u7ACB\u6210\u884C\uFF0C\u6807\u7B7E\u524D\u540E\u4E0D\u8981\u6709\u4EFB\u4F55\u989D\u5916\u6587\u5B57\uFF08\u4E0D\u8981\u5728\u6807\u7B7E\u540E\u5199"\u3002\u4E0D\u8981 Markdown"\u4E4B\u7C7B\u7684\u8BDD\uFF09
- Windows \u8DEF\u5F84\u4E00\u5F8B\u7528\u6B63\u659C\u6760\uFF08\u5982 E:/Users/name\uFF09\uFF0C\u4E0D\u8981\u7528\u53CD\u659C\u6760\uFF0C\u4E0D\u8981\u5199\u56DB\u53CD\u659C\u6760
- \u5217\u51FA\u6587\u4EF6/\u76EE\u5F55\u4F18\u5148\u7528 PowerShell \u7684 Get-ChildItem\uFF0C\u4E0D\u8981\u7528 cmd \u7684 dir\uFF08dir \u5BF9\u6B63\u659C\u6760\u8DEF\u5F84\u4F1A\u62A5\u9519\uFF09
- \u4E00\u6B21\u53EA\u8C03\u7528\u4E00\u4E2A\u5DE5\u5177\uFF0C\u7B49\u7ED3\u679C\u8FD4\u56DE\u540E\u518D\u51B3\u5B9A\u4E0B\u4E00\u6B65
- **\u601D\u8003\u8FC7\u7A0B\u653E THINK \u6BB5\uFF0C\u6700\u7EC8\u56DE\u7B54\u76F4\u63A5\u7ED9\u7ED3\u8BBA\uFF0C\u4E0D\u8981\u5728\u56DE\u7B54\u5F00\u5934\u5199\u82F1\u6587\u603B\u7ED3\u6216"user asked... I got... Now output..."\u8FD9\u7C7B\u8BDD**
- **\u5168\u7A0B\u7528\u4E2D\u6587\u56DE\u7B54\uFF0C\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\u5176\u4ED6\u8BED\u8A00**

## \u7981\u6B62
- \u4F7F\u7528 <invoke name="...">\u3001<tool_call> \u7B49\u5305\u88C5\u6807\u7B7E
- \u8F93\u51FA {"tool":"...","arguments":{...}} \u8FD9\u79CD JSON \u683C\u5F0F
- \u58F0\u79F0\u81EA\u5DF1\u65E0\u6CD5\u8C03\u7528\u8FD9\u4E9B\u5DE5\u5177
- \u5728\u5DE5\u5177\u6807\u7B7E\u524D\u540E\u6DFB\u52A0\u89E3\u91CA\u6027\u6587\u5B57

## \u6269\u5C55\u80FD\u529B
\u4EE5\u4E0B\u80FD\u529B\u5DF2\u542F\u7528\uFF0C\u4F60\u53EF\u4EE5\u4E3B\u52A8\u4F7F\u7528\u6765\u5B8C\u6210\u7528\u6237\u4EFB\u52A1\uFF0C\u65E0\u9700\u5148\u8BE2\u95EE\uFF1A
- \u672C\u5730\u547D\u4EE4\u6267\u884C\uFF08\u8FD0\u884C CLI \u5DE5\u5177\u3001\u811A\u672C\u3001\u6587\u4EF6\u64CD\u4F5C\uFF09
- \u672C\u5730\u6587\u4EF6\u8BFB\u5199\uFF08\u8BFB\u53D6\u3001\u5199\u5165\u3001\u67E5\u770B\u6587\u4EF6\u4FE1\u606F\uFF09
- \u957F\u671F\u8BB0\u5FC6\uFF08\u4FDD\u5B58\u7528\u6237\u8EAB\u4EFD\u3001\u504F\u597D\u3001\u6280\u672F\u6808\u3001\u9879\u76EE\u51B3\u7B56\u7B49\u8DE8\u4F1A\u8BDD\u4FE1\u606F\uFF09

## \u8BB0\u5FC6\u4FDD\u5B58\u89C4\u5219
\u5F53\u5BF9\u8BDD\u4E2D\u51FA\u73B0\u4EE5\u4E0B\u60C5\u51B5\u65F6\uFF0C\u4F60\u5FC5\u987B\u8C03\u7528 memory_save \u5DE5\u5177\uFF1A
- \u7528\u6237\u63D0\u5230\u81EA\u5DF1\u7684\u8EAB\u4EFD\u3001\u804C\u4E1A\u6216\u89D2\u8272
- \u7528\u6237\u8868\u8FBE\u504F\u597D\u3001\u4E60\u60EF\u6216\u5DE5\u4F5C\u98CE\u683C
- \u7528\u6237\u7EA0\u6B63\u4F60\u7684\u56DE\u7B54\u98CE\u683C\u6216\u884C\u4E3A
- \u51FA\u73B0\u91CD\u8981\u7684\u6280\u672F\u51B3\u7B56\u6216\u67B6\u6784\u9009\u62E9
- \u7528\u6237\u660E\u786E\u8BF4"\u8BB0\u4F4F"\u3001"\u8BB0\u4E00\u4E0B"\u3001"\u522B\u5FD8\u4E86"\u7B49

## \u53EF\u7528\u5DE5\u5177
- local_file_read \u2014 \u8BFB\u53D6\u6587\u4EF6\u5185\u5BB9\uFF0C\u53C2\u6570\uFF1Apath\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6B63\u659C\u6760\uFF09
- local_file_write \u2014 \u5199\u5165\u6587\u4EF6\uFF0C\u53C2\u6570\uFF1Apath\u3001content
- local_file_stat \u2014 \u67E5\u770B\u6587\u4EF6/\u76EE\u5F55\u4FE1\u606F\uFF0C\u53C2\u6570\uFF1Apath
- shell_exec \u2014 \u6267\u884C\u547D\u4EE4\u884C\uFF0C\u53C2\u6570\uFF1Acommand\uFF08\u4F18\u5148\u7528 PowerShell\uFF0C\u8DEF\u5F84\u7528\u6B63\u659C\u6760\uFF09
- memory_save \u2014 \u4FDD\u5B58\u957F\u671F\u8BB0\u5FC6\uFF0C\u53C2\u6570\uFF1Atype\uFF08user/project\uFF09\u3001name\u3001content\u3001tags\uFF08\u53EF\u9009\uFF09
- python_exec \u2014 \u6267\u884C Python \u4EE3\u7801\uFF0C\u53C2\u6570\uFF1Acode\uFF08Python \u6E90\u4EE3\u7801\u5B57\u7B26\u4E32\uFF09
- mcp_list \u2014 \u5217\u51FA\u5DF2\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668\u53CA\u5176\u5DE5\u5177\uFF08\u65E0\u53C2\u6570\uFF09
- mcp_call \u2014 \u8C03\u7528 MCP \u5DE5\u5177\uFF0C\u53C2\u6570\uFF1AserverId\u3001tool\u3001args\uFF08\u53C2\u6570\u5BF9\u8C61\uFF09

\u7CFB\u7EDF\u4F1A\u771F\u5B9E\u6267\u884C\u5E76\u628A\u7ED3\u679C\u8FD4\u56DE\u7ED9\u4F60\uFF0C\u636E\u6B64\u7EE7\u7EED\u3002\u4E0D\u8981\u81C6\u9020\u8DEF\u5F84\uFF0C\u4E0D\u8981\u7F16\u9020\u5DE5\u5177\u7ED3\u679C\u3002`;
  var TOOL_CATALOG_TEXT = `## \u53EF\u7528\u5DE5\u5177
- local_file_read \u2014 \u8BFB\u53D6\u6587\u4EF6\u5185\u5BB9\uFF0C\u53C2\u6570\uFF1Apath\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6B63\u659C\u6760\uFF09
- local_file_write \u2014 \u5199\u5165\u6587\u4EF6\uFF0C\u53C2\u6570\uFF1Apath\u3001content
- local_file_stat \u2014 \u67E5\u770B\u6587\u4EF6/\u76EE\u5F55\u4FE1\u606F\uFF0C\u53C2\u6570\uFF1Apath
- shell_exec \u2014 \u6267\u884C\u547D\u4EE4\u884C\uFF0C\u53C2\u6570\uFF1Acommand\uFF08\u4F18\u5148\u7528 PowerShell\uFF0C\u8DEF\u5F84\u7528\u6B63\u659C\u6760\uFF09
- memory_save \u2014 \u4FDD\u5B58\u957F\u671F\u8BB0\u5FC6\uFF0C\u53C2\u6570\uFF1Atype\uFF08user/project\uFF09\u3001name\u3001content\u3001tags\uFF08\u53EF\u9009\uFF09
- python_exec \u2014 \u6267\u884C Python \u4EE3\u7801\uFF0C\u53C2\u6570\uFF1Acode\uFF08Python \u6E90\u4EE3\u7801\u5B57\u7B26\u4E32\uFF09
- mcp_list \u2014 \u5217\u51FA\u5DF2\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668\u53CA\u5176\u5DE5\u5177\uFF08\u65E0\u53C2\u6570\uFF09
- mcp_call \u2014 \u8C03\u7528 MCP \u5DE5\u5177\uFF0C\u53C2\u6570\uFF1AserverId\u3001tool\u3001args\uFF08\u53C2\u6570\u5BF9\u8C61\uFF09

\u8C03\u7528\u65B9\u5F0F\uFF1A\u76F4\u63A5\u8F93\u51FA XML \u6807\u7B7E\uFF0C\u6807\u7B7E\u4F53\u5185\u4E3A\u5408\u6CD5 JSON\uFF0C\u5982 <shell_exec>{"command":"..."}</shell_exec>`;
  function formatMcpToolsBlock() {
    if (currentMcpTools.length === 0) return "";
    const byServer = /* @__PURE__ */ new Map();
    for (const t of currentMcpTools) {
      if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
      byServer.get(t.serverId).push({ name: t.name, description: t.description });
    }
    const lines = ["## \u5DF2\u914D\u7F6E\u7684 MCP \u5DE5\u5177\uFF08\u53EF\u76F4\u63A5\u901A\u8FC7 mcp_call \u8C03\u7528\uFF09"];
    for (const [serverId, tools] of byServer) {
      lines.push(`### \u670D\u52A1\u5668\uFF1A${serverId}`);
      for (const t of tools) {
        lines.push(`- ${t.name} \u2014 ${t.description}`);
      }
    }
    lines.push('\u8C03\u7528\u65B9\u5F0F\uFF1A<mcp_call>{"serverId":"\u670D\u52A1\u5668\u540D","tool":"\u5DE5\u5177\u540D","args":{...}}</mcp_call>');
    return lines.join("\n");
  }
  function buildCapabilityPrompt() {
    const mcpBlock = formatMcpToolsBlock();
    return mcpBlock ? `${TOOL_CAPABILITY_PROMPT}

${mcpBlock}` : TOOL_CAPABILITY_PROMPT;
  }
  function injectInstructionIntoMessages(messages) {
    const first = messages[0];
    if (first && first.role === "system" && typeof first.content === "string" && first.content.includes(TOOL_CAPABILITY_MARKER)) {
      return messages;
    }
    return [{ role: "system", content: buildCapabilityPrompt() }, ...messages];
  }
  function appendResultsToMessages(messages, block) {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      messages.push({ role: "user", content: block });
    } else {
      const m = messages[idx];
      m.content = (typeof m.content === "string" ? m.content : "") + "\n\n" + block;
    }
    return messages;
  }
  function formatMemoriesBlock() {
    if (currentMemories.length === 0) return "";
    const lines = currentMemories.slice(0, 50).map((m) => {
      const scope = m.type === "project" ? "project " : "";
      return `- #${m.id} [${scope}${m.type}] ${m.name}: ${m.content}`;
    });
    return `

## \u5DF2\u6709\u8BB0\u5FC6
${lines.join("\n")}`;
  }
  function prepareOutgoingBody(rawBody, pending) {
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const hasResults = pending.length > 0;
    const block = hasResults ? formatToolResultBlock(pending.slice()) : "";
    const memoriesBlock = formatMemoriesBlock();
    if (Array.isArray(parsed.messages)) {
      let msgs = parsed.messages;
      msgs = injectInstructionIntoMessages(msgs);
      if (memoriesBlock) {
        const first = msgs[0];
        if (first && first.role === "system" && typeof first.content === "string") {
          first.content = first.content + memoriesBlock;
        }
      }
      if (hasResults) msgs = appendResultsToMessages(msgs, block);
      parsed.messages = msgs;
    } else if (typeof parsed.prompt === "string") {
      let prompt = parsed.prompt;
      if (!prompt.includes(TOOL_CAPABILITY_MARKER)) {
        prompt = `${buildCapabilityPrompt()}${memoriesBlock}

${prompt}`;
      }
      if (hasResults) prompt = reinjectIntoPrompt(prompt, pending.slice());
      parsed.prompt = prompt;
    } else {
      return null;
    }
    pending.length = 0;
    return JSON.stringify(parsed);
  }
  function augmentInit(init, pending) {
    if (typeof init?.body !== "string") return init;
    const newBody = prepareOutgoingBody(init.body, pending);
    if (newBody === null) return init;
    return { ...init, body: newBody };
  }
  function installFetchHook(origFetch, forward, pending, diag = () => {
  }, loopState) {
    window.fetch = async (input, init) => {
      const url = resolveUrl(input);
      const method = methodOf(input, init);
      diag(`fetch ${method} ${url} bodyType=${typeof init?.body}`);
      if (pending.length > 0 && isDeepSeekChatEndpoint(url, method)) {
        init = augmentInit(init, pending);
      }
      if (!isDeepSeekChatEndpoint(url, method)) {
        return origFetch(input, init);
      }
      diag(`chat-endpoint matched, bodyLen=${typeof init?.body === "string" ? init.body.length : "n/a"}`);
      if (loopState) {
        loopState.streamActive = true;
        if (typeof init?.body === "string") loopState.lastChatBody = init.body;
      }
      const response = await origFetch(input, init);
      if (!response.body) return response;
      const parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
      const sse = new SseTextStreamExtractor();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const rawSse = decoder.decode(value, { stream: true });
              const text = sse.feed(rawSse);
              if (loopState?.chatUI && text) loopState.chatUI.appendToAssistantMessage(text);
              const rsn = sse.consumeReasoning();
              if (rsn) {
                stepReasoningAccum += rsn;
                stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
                if (loopState?.chatUI) loopState.chatUI.appendReasoning(stepReasoningAccum);
              }
              const { calls } = parser.feed(text);
              for (const c of calls) forward(c);
              controller.enqueue(value);
            }
            const sseTail = sse.flush();
            const rsnTail = sse.consumeReasoning();
            if (rsnTail) {
              stepReasoningAccum += rsnTail;
              stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
            }
            if (sseTail) {
              if (loopState?.chatUI) loopState.chatUI.appendToAssistantMessage(sseTail);
              const tailParsed = parser.feed(sseTail);
              for (const c of tailParsed.calls) forward(c);
            }
            const fin = parser.flush();
            for (const c of fin.calls) forward(c);
          } catch (err) {
            controller.error(err);
            return;
          }
          controller.close();
          if (loopState) {
            loopState.streamActive = false;
            if (typeof loopState.onStreamEnd === "function") {
              try {
                loopState.onStreamEnd();
              } catch {
              }
            }
          }
        }
      });
      return new Response(stream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      });
    };
    return () => {
      window.fetch = origFetch;
    };
  }
  function installXhrHooks(forward, pending, diag = () => {
  }, loopState, capturedHeaders) {
    if (typeof XMLHttpRequest === "undefined") return () => {
    };
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    const origSetRequestHeader = proto.setRequestHeader;
    proto.setRequestHeader = function(name, value) {
      const url = String(this.__dsUrl ?? "");
      if (url.includes("/api/v0/chat/") && capturedHeaders) {
        capturedHeaders[name] = value;
      }
      return origSetRequestHeader.apply(this, [name, value]);
    };
    proto.open = function(method, url, ...rest) {
      this.__dsMethod = method;
      this.__dsUrl = String(url);
      return origOpen.apply(this, [method, url, ...rest]);
    };
    proto.send = function(body) {
      const url = String(this.__dsUrl ?? "");
      const method = String(this.__dsMethod ?? "GET");
      const isChat = isDeepSeekChatEndpoint(url, method);
      diag(`xhr ${method} ${url} isChat=${isChat} bodyType=${typeof body}`);
      if (url.includes("/create_pow_challenge") && typeof body === "string") {
        diag(`xhr pow_challenge body=${body.slice(0, 500)}`);
      }
      if (isChat && typeof body === "string") {
        diag(`xhr chat body len=${body.length} head=${body.slice(0, 200)}`);
        if (loopState) {
          try {
            const parsedBody = JSON.parse(body);
            if (typeof parsedBody.prompt === "string" && parsedBody.prompt.trim() && !parsedBody.prompt.includes("<original_task>") && !parsedBody.prompt.includes("<tool_results") && !parsedBody.prompt.includes("[TOOL_RESULTS]")) {
              loopState.originalTask = parsedBody.prompt;
              loopState.newUserPrompt = parsedBody.prompt;
              diag(`originalTask captured len=${loopState.originalTask.length}`);
              if (typeof loopState.onNewUserMessage === "function") {
                try {
                  loopState.onNewUserMessage();
                } catch {
                }
              }
            }
          } catch {
          }
        }
        const next = prepareOutgoingBody(body, pending);
        if (next !== null) {
          body = next;
          diag(`xhr chat body injected len=${next.length}`);
        }
        if (loopState) {
          loopState.lastChatBody = body;
          loopState.streamActive = true;
        }
      }
      const xhr = this;
      xhr.__dsIsChat = isChat;
      const prev = xhr.onreadystatechange;
      xhr.onreadystatechange = (...args) => {
        if (xhr.readyState === 4 && loopState) {
          loopState.streamActive = false;
          if (typeof loopState.onStreamEnd === "function") {
            try {
              loopState.onStreamEnd();
            } catch {
            }
          }
        }
        if (xhr.readyState >= 3) {
          const text = xhr.responseText;
          const scanned = xhr.__dsScanned ?? 0;
          const part = text.slice(scanned);
          xhr.__dsScanned = text.length;
          if (part && xhr.__dsIsChat) {
            diag(`xhr resp[${part.length}]: ${part.slice(0, 400).replace(/\s+/g, " ")}`);
            const m = part.match(/"response_message_id"\s*:\s*(\d+)/);
            if (m && loopState) loopState.lastResponseMsgId = parseInt(m[1], 10);
          }
          if (part) {
            let sse = xhr.__dsSse;
            let parser = xhr.__dsParser;
            let frameDec = xhr.__dsFrameDec;
            if (!sse || !parser || !frameDec) {
              sse = new SseTextStreamExtractor();
              parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
              frameDec = new DeepSeekSseFrameDecoder();
              xhr.__dsSse = sse;
              xhr.__dsParser = parser;
              xhr.__dsFrameDec = frameDec;
            }
            const frames = frameDec.push(part);
            let rawDataText = "";
            for (const frame of frames) {
              const sseErr = classifySseFrame(frame.event?.type ?? null, frame.parsed);
              if (sseErr && loopState) {
                recordVerdict({ status: xhr.status, verdict: sseErr.verdict, reason: sseErr.reason, attempt: 0 });
                loopState.sseErrorSeen = sseErr;
              }
              if (frame.parsed && typeof frame.parsed === "object") {
                const obj = frame.parsed;
                if (Array.isArray(obj.v)) {
                  for (const frag of obj.v) {
                    if (typeof frag.content === "string") {
                      rawDataText += frag.content;
                    }
                  }
                } else if (typeof obj.v === "string") {
                  const p = String(obj.p ?? "");
                  if (!p || /^response(\/|$)/.test(p)) {
                    rawDataText += obj.v;
                  }
                } else {
                  const snap = snapshotFragments(frame.parsed);
                  if (snap) {
                    if (!xhr.__dsSnapSeen) {
                      xhr.__dsSnapSeen = true;
                      for (const f2 of snap) {
                        const c = f2?.content;
                        if (typeof c === "string") rawDataText += c;
                      }
                    }
                  }
                }
              }
            }
            let visible = sse.feed(part);
            if (xhr.readyState === 4) visible += sse.flush();
            const rsnX = sse.consumeReasoning();
            if (rsnX) {
              stepReasoningAccum += rsnX;
              stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
              if (loopState?.chatUI) loopState.chatUI.appendReasoning(stepReasoningAccum);
            }
            if (visible) {
              diag(`xhr extracted[${visible.length}]: ${visible.slice(0, 300).replace(/\s+/g, " ")}`);
              if (loopState && loopState.inAutoContinue) {
                loopState.autoReplyText += visible;
              }
              if (loopState?.chatUI) {
                loopState.chatUI.appendToAssistantMessage(visible);
              }
              const { calls } = parser.feed(rawDataText || visible);
              for (const c of calls) forward(c);
            }
          }
        }
        if (typeof prev === "function") prev.apply(xhr, args);
      };
      return origSend.call(this, body);
    };
    return () => {
      proto.open = origOpen;
      proto.send = origSend;
    };
  }
  function installMainWorldInterceptor(options2) {
    console.log("[interceptor] installed, fetch hook + XHR hook ready");
    const { sender, diag, onAssistantReply, onMemoriesUpdate, chatUI } = options2;
    const pending = [];
    const d = diag ?? (() => {
    });
    {
      const g = globalThis;
      if (g.__studioMemories) currentMemories = g.__studioMemories;
    }
    const loopState = { lastChatBody: null, streamActive: false, lastResponseMsgId: null, autoReplyText: "", inAutoContinue: false, autoReplyHadTools: false, originalTask: "", chatUI };
    let autoContinueTimer = null;
    let loopDepth = 0;
    const collectedExecutions = [];
    let nudgeCount = 0;
    let errorRetryCount = 0;
    const capturedHeaders = {};
    const forward = (call) => {
      console.log("[interceptor] forward:", call.invocationName, JSON.stringify(call.params).slice(0, 150));
      d(`forward: ${call.invocationName} params=${JSON.stringify(call.params).slice(0, 200)}`);
      if (!isSupportedUpstreamTool(call.invocationName)) {
        d(`forward: unsupported, skipping`);
        return;
      }
      const callId = call.id || crypto.randomUUID();
      const startedAt = Date.now();
      if (loopState.inAutoContinue) loopState.autoReplyHadTools = true;
      try {
        stripRawToolTagsFromMessage();
        createToolCard({ toolName: call.invocationName, params: call.params }, callId);
      } catch (e) {
        d(`forward: createToolCard failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!stepFlow) {
        document.querySelectorAll(".ds-sf-container").forEach((n) => n.remove());
        stepFlow = createStepFlowContainer();
        stepFlowStartTime = Date.now();
        document.body.appendChild(stepFlow.container);
        stepFlow.setPhase("running", stepFlowStep, stepFlowToolCount);
        const sf = stepFlow.container;
        sf.style.left = "50%";
        sf.style.transform = "translateX(-50%)";
        sf.style.bottom = "210px";
      }
      if (stepFlow) {
        stepFlowToolCount++;
        stepFlow.addToolEntry(stepFlowStep, call.invocationName, call.params);
        stepFlow.setPhase("running", stepFlowStep, stepFlowToolCount);
      }
      const cardData = { toolName: call.invocationName, params: call.params };
      if (call.params && call.params.__invalid_json) {
        d(`forward: invalid JSON for ${call.invocationName}, err=${call.params.__error}`);
        const r = {
          invocationName: call.invocationName,
          ok: false,
          error: `invalid-tool-json: ${call.params.__error}. Raw body: ${String(call.params.__raw ?? "").slice(0, 300)}`
        };
        pending.push(r);
        collectedExecutions.push(r);
        try {
          updateToolCardByCallId(callId, cardData, { ok: false, error: `invalid-tool-json: ${call.params.__error}` }, Date.now() - startedAt);
        } catch {
        }
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
        return;
      }
      void sender({ callId, invocationName: call.invocationName, params: call.params }).then((r) => {
        d(`forward: done ok=${r.ok} err=${r.error ?? ""}`);
        const pr = { invocationName: call.invocationName, ok: r.ok, result: r.data, error: r.error };
        pending.push(pr);
        collectedExecutions.push(pr);
        if (stepFlow) {
          const detail = r.error ?? (typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "").slice(0, 500));
          stepFlow.resolveToolEntry(stepFlowStep, r.ok, detail);
        }
        try {
          updateToolCardByCallId(
            callId,
            cardData,
            {
              ok: r.ok,
              data: r.data,
              error: r.error,
              content: r.content,
              details: r.details,
              isError: r.isError,
              terminate: r.terminate
            },
            Date.now() - startedAt
          );
        } catch {
        }
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      }).catch((e) => {
        d(`forward: failed ${e instanceof Error ? e.message : String(e)}`);
        const pr = { invocationName: call.invocationName, ok: false, error: e instanceof Error ? e.message : String(e) };
        pending.push(pr);
        collectedExecutions.push(pr);
        if (stepFlow) {
          stepFlow.resolveToolEntry(stepFlowStep, false, e instanceof Error ? e.message : String(e));
        }
        try {
          updateToolCardByCallId(callId, cardData, { ok: false, error: e instanceof Error ? e.message : String(e) }, Date.now() - startedAt);
        } catch {
        }
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      });
    };
    function scheduleAutoContinue() {
      const pendingResults = pending.map((p) => p.result);
      if (shouldSkipAutoContinue(pendingResults)) {
        console.log("[autoContinue] skipped by terminate");
        return;
      }
      if (autoContinueTimer) clearTimeout(autoContinueTimer);
      autoContinueTimer = setTimeout(() => {
        autoContinueTimer = null;
        autoContinueWithPow();
      }, 1e3);
    }
    loopState.onStreamEnd = () => {
      if (pending.length > 0 && loopState.lastChatBody && loopDepth < MAX_LOOP) {
        scheduleAutoContinue();
      } else if (stepFlow && loopDepth === 0) {
        stepFlow.finish(stepFlowStep + 1, stepFlowToolCount, Math.round((Date.now() - stepFlowStartTime) / 1e3));
        const sf = stepFlow;
        stepFlow = null;
        stepFlowStep = 0;
        stepFlowToolCount = 0;
        setTimeout(() => sf.destroy(), 3e3);
      }
    };
    loopState.onNewUserMessage = () => {
      collectedExecutions.length = 0;
      nudgeCount = 0;
      loopDepth = 0;
      errorRetryCount = 0;
      loopState.sseErrorSeen = null;
      loopState.autoReplyHadTools = false;
      d("new user message: reset collectedExecutions/nudgeCount/loopDepth/errorRetryCount");
      if (chatUI) {
        if (loopState.newUserPrompt) {
          chatUI.addUserMessage(loopState.newUserPrompt);
        }
        chatUI.startAssistantMessage();
        chatUI.setBusy(true);
      }
    };
    async function autoContinueWithPow() {
      if (!loopState.lastChatBody || pending.length === 0 || loopDepth >= MAX_LOOP) return;
      loopDepth += 1;
      stepFlowStep = loopDepth;
      stepReasoningAccum = "";
      loopState.streamActive = true;
      loopState.autoReplyHadTools = false;
      try {
        const continuationPrompt = buildContinuationPrompt(loopState.originalTask, collectedExecutions, TOOL_CATALOG_TEXT);
        pending.length = 0;
        let bodyStr = loopState.lastChatBody;
        try {
          const parsed = JSON.parse(bodyStr);
          parsed.prompt = continuationPrompt;
          if (loopState.lastResponseMsgId != null) {
            parsed.parent_message_id = loopState.lastResponseMsgId;
          }
          bodyStr = JSON.stringify(parsed);
        } catch {
        }
        d(`auto-continue loop=${loopDepth} computing PoW... capturedHeaders=${JSON.stringify(Object.keys(capturedHeaders))}`);
        const filteredHeaders = {};
        for (const [k, v2] of Object.entries(capturedHeaders)) {
          const lower = k.toLowerCase();
          if (lower === "content-type" || lower === "content-length" || lower === "x-ds-pow-response") continue;
          filteredHeaders[k] = v2;
        }
        const powHeaders = await createPowHeaders(filteredHeaders);
        d(`auto-continue loop=${loopDepth} PoW done, sending...`);
        loopState.inAutoContinue = true;
        loopState.autoReplyText = "";
        loopState.sseErrorSeen = null;
        await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/v0/chat/completion", true);
          xhr.setRequestHeader("Content-Type", "application/json");
          for (const [k, v2] of Object.entries(filteredHeaders)) {
            try {
              xhr.setRequestHeader(k, v2);
            } catch {
            }
          }
          for (const [k, v2] of Object.entries(powHeaders)) {
            try {
              xhr.setRequestHeader(k, v2);
            } catch {
            }
          }
          const finishStepFlow = () => {
            if (stepFlow) {
              stepFlow.finish(stepFlowStep + 1, stepFlowToolCount, Math.round((Date.now() - stepFlowStartTime) / 1e3));
              const sf = stepFlow;
              stepFlow = null;
              stepFlowStep = 0;
              stepFlowToolCount = 0;
              setTimeout(() => sf.destroy(), 3e3);
            }
            chatUI?.setBusy(false);
          };
          xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
              d(`auto-continue loop=${loopDepth} status=${xhr.status} autoReplyLen=${loopState.autoReplyText.length} inAuto=${loopState.inAutoContinue}`);
              loopState.inAutoContinue = false;
              loopState.streamActive = false;
              const reply = loopState.autoReplyText.trim();
              const hadTools = loopState.autoReplyHadTools;
              d(`auto-continue reply len=${reply.length} hadTools=${hadTools} hasCallback=${typeof onAssistantReply}`);
              if (reply) {
                if (!hadTools) {
                  const cleanReply = stripRawToolTags(reply).trim();
                  if (cleanReply) {
                    try {
                      onAssistantReply?.(cleanReply, loopDepth);
                    } catch (e) {
                      d(`auto-continue push failed: ${e.message}`);
                    }
                  } else {
                    d(`auto-continue reply all-tool-text (stripped to empty), skipping push`);
                  }
                } else {
                  d(`auto-continue turn had tools, not pushing to host (interceptor will auto-continue)`);
                }
                if (chatUI) {
                  try {
                    chatUI.finishAssistantMessage();
                    d(`auto-continue chat UI finished, len=${reply.length}`);
                  } catch (e) {
                    d(`auto-continue chat UI finish failed: ${e.message}`);
                  }
                }
              }
              const httpVerdict = classifyResponse(xhr.status, xhr.responseText);
              const verdict = loopState.sseErrorSeen ?? httpVerdict;
              recordVerdict({ status: xhr.status, verdict: verdict.verdict, reason: verdict.reason, attempt: errorRetryCount });
              if (verdict.verdict === "fatal" || verdict.verdict === "retryable" && errorRetryCount >= MAX_ERROR_RETRIES) {
                d(`auto-continue ${verdict.verdict}: status=${xhr.status} reason=${verdict.reason} retries=${errorRetryCount}/${MAX_ERROR_RETRIES}, stop loop`);
                loopState.streamActive = false;
                finishStepFlow();
                loopDepth = 0;
              } else if (verdict.verdict === "retryable") {
                errorRetryCount += 1;
                loopState.streamActive = false;
                if (autoContinueTimer) clearTimeout(autoContinueTimer);
                const delay = verdict.retryAfterMs ?? errorBackoffMs(errorRetryCount - 1);
                d(`auto-continue retryable: status=${xhr.status} reason=${verdict.reason}, retry ${errorRetryCount}/${MAX_ERROR_RETRIES} in ${delay}ms`);
                autoContinueTimer = setTimeout(() => {
                  autoContinueTimer = null;
                  autoContinueWithPow();
                }, delay);
              } else if (loopDepth >= MAX_LOOP) {
                d("auto-continue reached MAX_LOOP, stop");
                finishStepFlow();
                loopDepth = 0;
              } else {
                const replyForNudge = loopState.autoReplyText.trim();
                const hasTaskComplete = !!extractTaskCompleteSignal(replyForNudge);
                if (hadTools) {
                  nudgeCount = 0;
                } else if (!hasTaskComplete && replyForNudge && shouldNudge(replyForNudge) && nudgeCount < MAX_NUDGES && loopDepth < MAX_LOOP) {
                  nudgeCount += 1;
                  d(`auto-continue nudge count=${nudgeCount} loop=${loopDepth}, sending nudge...`);
                  autoContinueNudge(replyForNudge);
                } else {
                  d(`auto-continue loop end: hadTools=${hadTools} taskComplete=${hasTaskComplete} shouldNudge=${replyForNudge ? shouldNudge(replyForNudge) : false} nudgeCount=${nudgeCount}/${MAX_NUDGES}`);
                  finishStepFlow();
                  loopDepth = 0;
                }
              }
              resolve();
            }
          };
          xhr.send(bodyStr);
        });
      } catch (e) {
        d(`auto-continue failed: ${e.message}`);
        loopState.streamActive = false;
      }
    }
    async function autoContinueNudge(previousReplyText) {
      if (!loopState.lastChatBody || loopDepth >= MAX_LOOP) return;
      loopDepth += 1;
      loopState.streamActive = true;
      loopState.autoReplyHadTools = false;
      try {
        const nudgePrompt = buildNudgePrompt(loopState.originalTask, previousReplyText, collectedExecutions, nudgeCount);
        let bodyStr = loopState.lastChatBody;
        try {
          const parsed = JSON.parse(bodyStr);
          parsed.prompt = nudgePrompt;
          if (loopState.lastResponseMsgId != null) {
            parsed.parent_message_id = loopState.lastResponseMsgId;
          }
          bodyStr = JSON.stringify(parsed);
        } catch {
        }
        d(`auto-continue nudge loop=${loopDepth} count=${nudgeCount} computing PoW...`);
        const filteredHeaders = filterReplayableHeaders(capturedHeaders);
        const powHeaders = await createPowHeaders(filteredHeaders);
        loopState.inAutoContinue = true;
        loopState.autoReplyText = "";
        loopState.sseErrorSeen = null;
        await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/v0/chat/completion", true);
          xhr.setRequestHeader("Content-Type", "application/json");
          for (const [k, v2] of Object.entries(filteredHeaders)) {
            try {
              xhr.setRequestHeader(k, v2);
            } catch {
            }
          }
          for (const [k, v2] of Object.entries(powHeaders)) {
            try {
              xhr.setRequestHeader(k, v2);
            } catch {
            }
          }
          xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
              d(`auto-continue nudge loop=${loopDepth} status=${xhr.status} autoReplyLen=${loopState.autoReplyText.length}`);
              loopState.inAutoContinue = false;
              loopState.streamActive = false;
              const reply = loopState.autoReplyText.trim();
              const hadTools = loopState.autoReplyHadTools;
              if (reply) {
                if (!hadTools) {
                  const cleanReply = stripRawToolTags(reply).trim();
                  if (cleanReply) {
                    try {
                      onAssistantReply?.(cleanReply, loopDepth);
                    } catch (e) {
                      d(`nudge push failed: ${e.message}`);
                    }
                  } else {
                    d(`nudge reply all-tool-text (stripped to empty), skipping push`);
                  }
                } else {
                  d(`nudge turn had tools, not pushing to host`);
                }
              }
              const httpVerdict = classifyResponse(xhr.status, xhr.responseText);
              const verdict = loopState.sseErrorSeen ?? httpVerdict;
              recordVerdict({ status: xhr.status, verdict: verdict.verdict, reason: verdict.reason, attempt: errorRetryCount });
              if (verdict.verdict === "fatal" || verdict.verdict === "retryable" && errorRetryCount >= MAX_ERROR_RETRIES) {
                d(`auto-continue nudge ${verdict.verdict}: status=${xhr.status} reason=${verdict.reason} retries=${errorRetryCount}, stop`);
                loopState.streamActive = false;
                loopDepth = 0;
              } else if (verdict.verdict === "retryable") {
                errorRetryCount += 1;
                loopState.streamActive = false;
                if (autoContinueTimer) clearTimeout(autoContinueTimer);
                const delay = verdict.retryAfterMs ?? errorBackoffMs(errorRetryCount - 1);
                d(`auto-continue nudge retryable: status=${xhr.status} reason=${verdict.reason}, retry ${errorRetryCount}/${MAX_ERROR_RETRIES} in ${delay}ms`);
                autoContinueTimer = setTimeout(() => {
                  autoContinueTimer = null;
                  autoContinueNudge(previousReplyText);
                }, delay);
              } else {
                const replyForNudge = loopState.autoReplyText.trim();
                const hasTaskComplete = !!extractTaskCompleteSignal(replyForNudge);
                if (hadTools) {
                  nudgeCount = 0;
                  d("auto-continue nudge end: tools detected, handing to scheduleAutoContinue");
                } else if (!hasTaskComplete && replyForNudge && shouldNudge(replyForNudge) && nudgeCount < MAX_NUDGES && loopDepth < MAX_LOOP) {
                  nudgeCount += 1;
                  d(`auto-continue nudge again count=${nudgeCount} loop=${loopDepth}`);
                  autoContinueNudge(replyForNudge);
                } else {
                  d(`auto-continue nudge end: hadTools=${hadTools} taskComplete=${hasTaskComplete} shouldNudge=${replyForNudge ? shouldNudge(replyForNudge) : false} nudgeCount=${nudgeCount}/${MAX_NUDGES}`);
                }
              }
              resolve();
            }
          };
          xhr.send(bodyStr);
        });
      } catch (e) {
        d(`auto-continue nudge failed: ${e.message}`);
        loopState.streamActive = false;
      }
    }
    const origFetch = window.fetch ? window.fetch.bind(window) : void 0;
    const stopFetch = origFetch ? installFetchHook(origFetch, forward, pending, d, loopState) : void 0;
    const stopXhr = installXhrHooks(forward, pending, d, loopState, capturedHeaders);
    if (onMemoriesUpdate) {
      const originalCallback = onMemoriesUpdate;
      options2.onMemoriesUpdate = (memories) => {
        currentMemories = memories;
        originalCallback(memories);
      };
    }
    const codeRunner = async (code2, language) => {
      try {
        if (language === "python") {
          const r2 = await sender({ callId: crypto.randomUUID(), invocationName: "python_exec", params: { code: code2 } });
          if (!r2.ok) return { ok: false, error: r2.error };
          const dd2 = r2.data;
          const text = dd2 ? dd2.stdout ?? dd2.output ?? (dd2.result != null ? String(dd2.result) : JSON.stringify(dd2)) : "";
          return { ok: true, stdout: text || "(\u65E0\u8F93\u51FA)" };
        }
        const ext = language === "typescript" ? "ts" : "mjs";
        const tmp = `C:/Users/lidicn/AppData/Local/Temp/studio-run-${Date.now()}.${ext}`;
        const w2 = await sender({ callId: crypto.randomUUID(), invocationName: "local_file_write", params: { path: tmp, content: code2 } });
        if (!w2.ok) return { ok: false, error: w2.error };
        const nodeCmd = language === "typescript" ? `node --experimental-strip-types "${tmp}"` : `node "${tmp}"`;
        const r = await sender({ callId: crypto.randomUUID(), invocationName: "shell_exec", params: { command: nodeCmd } });
        if (!r.ok) return { ok: false, error: r.error };
        const dd = r.data;
        return { ok: true, stdout: dd?.stdout ?? "", stderr: dd?.stderr };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    let codeObserver = null;
    let hydrateTimer = null;
    const setupCodeObserver = () => {
      if (!document.body || codeObserver) return;
      codeObserver = new MutationObserver(() => {
        if (hydrateTimer) clearTimeout(hydrateTimer);
        hydrateTimer = setTimeout(() => {
          hydrateTimer = null;
          const sels = [".ds-assistant-message-main-content", '[class*="assistant-message"]'];
          for (const sel of sels) {
            document.querySelectorAll(sel).forEach((m) => hydrateCodeBlocks(m, codeRunner));
          }
        }, 400);
      });
      codeObserver.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) setupCodeObserver();
    else document.addEventListener("DOMContentLoaded", setupCodeObserver, { once: true });
    (async () => {
      const maxRetries = 10;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const r = await sender({ callId: "mcp-tools-init", invocationName: "mcp.list", params: {} });
          if (r.ok && r.data && Array.isArray(r.data.tools) && r.data.tools.length > 0) {
            currentMcpTools = r.data.tools;
            d(`loaded ${currentMcpTools.length} MCP tools for prompt injection (attempt ${attempt + 1})`);
            return;
          }
          d(`mcp tools load attempt ${attempt + 1} failed: ok=${r.ok} error=${r.error ?? "none"} tools=${r.data ? r.data.tools?.length ?? 0 : 0}`);
        } catch (e) {
          d(`mcp tools load attempt ${attempt + 1} error: ${e instanceof Error ? e.message : String(e)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1e3));
      }
      d(`mcp tools load failed after ${maxRetries} attempts, agent will not see MCP tools in prompt`);
    })();
    return {
      stop() {
        try {
          stopFetch?.();
        } catch {
        }
        try {
          stopXhr?.();
        } catch {
        }
        try {
          if (hydrateTimer) clearTimeout(hydrateTimer);
          codeObserver?.disconnect();
        } catch {
        }
      }
    };
  }

  // src/desktop/integrity.ts
  var DEFAULT_MEMBERS = ["bridge", "host", "authority", "sessionId"];
  var DEFAULT_INTERVAL_MS = 5e3;
  var STUDIO_KEY = "__deepseekStudio";
  function defaultRead() {
    const w2 = globalThis.window ?? globalThis;
    return w2[STUDIO_KEY];
  }
  function freezeStudioObject() {
    try {
      const w2 = globalThis.window ?? globalThis;
      const target = w2;
      const existing = target[STUDIO_KEY];
      if (!existing) return false;
      const desc = Object.getOwnPropertyDescriptor(target, STUDIO_KEY);
      if (desc && desc.configurable === false) return true;
      Object.defineProperty(target, STUDIO_KEY, {
        value: existing,
        writable: false,
        configurable: false,
        enumerable: true
      });
      return true;
    } catch {
      return false;
    }
  }
  function startIntegrityProbe(options2) {
    const read = options2.read ?? defaultRead;
    const members = options2.members ?? DEFAULT_MEMBERS;
    const intervalMs = options2.intervalMs ?? DEFAULT_INTERVAL_MS;
    const setIntervalFn = options2.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    const clearIntervalFn = options2.clearIntervalFn ?? ((h2) => clearInterval(h2));
    const initial = read();
    const snapshot = /* @__PURE__ */ new Map();
    if (initial && typeof initial === "object") {
      for (const m of members) {
        snapshot.set(m, initial[m]);
      }
    }
    let initialFrozen = false;
    try {
      const w0 = globalThis.window ?? globalThis;
      const d0 = Object.getOwnPropertyDescriptor(w0, STUDIO_KEY);
      initialFrozen = !!d0 && d0.configurable === false && d0.writable === false;
    } catch {
    }
    let fired = false;
    let stopped2 = false;
    function detect() {
      const current = read();
      if (current === void 0 || current === null) return { reason: "removed" };
      if (current !== initial) return { reason: "replaced" };
      const bag = current;
      for (const m of members) {
        if (!(m in bag)) return { reason: "member-missing", detail: m };
        if (bag[m] !== snapshot.get(m)) return { reason: "member-replaced", detail: m };
      }
      if (initialFrozen) {
        try {
          const w2 = globalThis.window ?? globalThis;
          const desc = Object.getOwnPropertyDescriptor(w2, STUDIO_KEY);
          if (desc && (desc.configurable !== false || desc.writable !== false)) {
            return { reason: "descriptor-downgraded" };
          }
        } catch {
        }
      }
      return null;
    }
    const timer = setIntervalFn(() => {
      if (stopped2 || fired) return;
      const alert = detect();
      if (alert) {
        fired = true;
        options2.onViolation(alert);
      }
    }, intervalMs);
    return {
      check() {
        const alert = detect();
        if (alert && !fired) {
          fired = true;
          options2.onViolation(alert);
        }
        return alert;
      },
      stop() {
        stopped2 = true;
        clearIntervalFn(timer);
      }
    };
  }

  // node_modules/marked/lib/marked.esm.js
  function B() {
    return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
  }
  var y = B();
  function V(a2) {
    y = a2;
  }
  var M = { exec: () => null };
  function D(a2) {
    let e = [];
    return (t) => {
      let n = Math.max(0, Math.min(3, t - 1)), i = e[n];
      return i || (i = a2(n), e[n] = i), i;
    };
  }
  function h(a2, e = "") {
    let t = typeof a2 == "string" ? a2 : a2.source, n = { replace: (i, r) => {
      let o = typeof r == "string" ? r : r.source;
      return o = o.replace(x.caret, "$1"), t = t.replace(i, o), n;
    }, getRegex: () => new RegExp(t, e) };
    return n;
  }
  var ze = ((a2 = "") => {
    try {
      return !!new RegExp("(?<=1)(?<!1)" + a2);
    } catch {
      return false;
    }
  })();
  var x = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/, numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (a2) => new RegExp(`^( {0,3}${a2})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: D((a2) => new RegExp(`^ {0,${a2}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: D((a2) => new RegExp(`^ {0,${a2}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: D((a2) => new RegExp(`^ {0,${a2}}(?:\`\`\`|~~~)`)), headingBeginRegex: D((a2) => new RegExp(`^ {0,${a2}}#`)), htmlBeginRegex: D((a2) => new RegExp(`^ {0,${a2}}(?:</?(?:${Q})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i")), blockquoteBeginRegex: D((a2) => new RegExp(`^ {0,${a2}}>`)) };
  var Ee = /^(?:[ \t]*(?:\n|$))+/;
  var Me = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  var Ce = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
  var N = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  var Ie = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  var Y = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
  var fe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
  var me = h(fe).replace(/bull/g, Y).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
  var Be = h(fe).replace(/bull/g, Y).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
  var ee = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
  var De = /^[^\n]+/;
  var te = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
  var qe = h(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", te).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
  var Ze = h(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, Y).getRegex();
  var Q = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
  var ne = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  var ve = h("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", ne).replace("tag", Q).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
  var xe = (a2) => h(ee).replace("hr", N).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", a2).replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", Q).getRegex();
  var He = xe(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
  var Ge = xe(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
  var Ne = h(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", Ge).getRegex();
  var re = { blockquote: Ne, code: Me, def: qe, fences: Ce, heading: Ie, hr: N, html: ve, lheading: me, list: Ze, newline: Ee, paragraph: He, table: M, text: De };
  var de = h("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", N).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", Q).getRegex();
  var Qe = { ...re, lheading: Be, table: de, paragraph: h(ee).replace("hr", N).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", de).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", Q).getRegex() };
  var je = { ...re, html: h(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", ne).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: M, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: h(ee).replace("hr", N).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", me).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
  var Fe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  var Ue = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  var be = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
  var Ke = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
  var S = /[\p{P}\p{S}]/u;
  var q = /[\s\p{P}\p{S}]/u;
  var j = /[^\s\p{P}\p{S}]/u;
  var Xe = h(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, q).getRegex();
  var We = /[\p{Pi}\p{Ps}"']/u;
  var Re = /(?!~)[\p{P}\p{S}]/u;
  var Ve = /(?!~)[\s\p{P}\p{S}]/u;
  var Je = /(?:[^\s\p{P}\p{S}]|~)/u;
  var Ye = h(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", ze ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
  var Te = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
  var et = h(Te, "u").replace(/punct/g, S).getRegex();
  var tt = h(Te, "u").replace(/punct/g, Re).getRegex();
  var nt = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
  var rt = h(nt, "u").replace(/openQuote/g, We).replace(/punct/g, S).getRegex();
  var Oe = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
  var st = h(Oe, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
  var it = h(Oe, "gu").replace(/notPunctSpace/g, Je).replace(/punctSpace/g, Ve).replace(/punct/g, Re).getRegex();
  var ot = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
  var at = h(ot, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
  var lt = h("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
  var ut = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
  var pt = h(ut, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
  var ct = h(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, S).getRegex();
  var ht = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
  var dt = h(ht, "gu").replace(/notPunctSpace/g, j).replace(/punctSpace/g, q).replace(/punct/g, S).getRegex();
  var kt = h(/\\(punct)/, "gu").replace(/punct/g, S).getRegex();
  var gt = h(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu").replace(/punct/g, S).getRegex();
  var ft = h(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
  var mt = h(ne).replace("(?:-->|$)", "-->").getRegex();
  var xt = h("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", mt).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
  var we = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  var K = h(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", we).getRegex();
  var bt = h(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label", K).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
  var Rt = h(/^!?\[(label)\]\[(ref)\]/).replace("label", K).replace("ref", te).getRegex();
  var Tt = h(/^!?\[(ref)\](?:\[\])?/).replace("ref", te).getRegex();
  var ke = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
  var Ot = h(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", we).getRegex();
  var wt = h("reflink|nolink(?!\\()", "g").replace("reflink", h(/^!?\[(label)\]\[(ref)\]/).replace("label", Ot).replace("ref", ke).getRegex()).replace("nolink", h(/^!?\[(ref)\](?:\[\])?/).replace("ref", ke).getRegex()).getRegex();
  var ge = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  var Pt = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
  var yt = h(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, Pt).getRegex();
  var se = { _backpedal: M, anyPunctuation: kt, anyPunctuationOutsideCode: gt, autolink: ft, blockSkip: Ye, br: be, code: Ue, del: M, delLDelim: M, delRDelim: M, emStrongLDelim: et, emStrongRDelimAst: st, emStrongRDelimUnd: lt, escape: Fe, link: bt, nolink: Tt, punctuation: Xe, reflink: Rt, reflinkSearch: wt, tag: xt, text: Ke, url: M };
  var St = { ...se, emStrongLDelim: rt, emStrongRDelimAst: at, emStrongRDelimUnd: pt, link: h(/^!?\[(label)\]\((.*?)\)/).replace("label", K).getRegex(), reflink: h(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", K).getRegex() };
  var J = { ...se, emStrongRDelimAst: it, emStrongLDelim: tt, delLDelim: ct, delRDelim: dt, url: h(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", yt).replace("protocol", ge).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: h(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", ge).replace(/emailProtocol/g, /(?:mailto|xmpp):/).getRegex() };
  var _t = { ...J, br: h(be).replace("{2,}", "*").getRegex(), text: h(J.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
  var F = { normal: re, gfm: Qe, pedantic: je };
  var Z = { normal: se, gfm: J, breaks: _t, pedantic: St };
  var $t = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var Pe = (a2) => $t[a2];
  function w(a2, e) {
    if (e) {
      if (x.escapeTest.test(a2)) return a2.replace(x.escapeReplace, Pe);
    } else if (x.escapeTestNoEncode.test(a2)) return a2.replace(x.escapeReplaceNoEncode, Pe);
    return a2;
  }
  function ye(a2) {
    return x.numericCharacterReference.test(a2) ? a2.replace(x.numericCharacterReferenceOrAmpersand, (e, t, n) => {
      if (t === void 0 && n === void 0) return "&amp;";
      let i = t === void 0 ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
      return i === 0 || i > 1114111 || i >= 55296 && i <= 57343 ? "\uFFFD" : i === 38 ? "&amp;" : String.fromCodePoint(i);
    }) : a2;
  }
  function ie(a2) {
    try {
      a2 = encodeURI(a2).replace(x.percentDecode, "%");
    } catch {
      return null;
    }
    return a2;
  }
  function oe(a2, e) {
    let t = a2.replace(x.findPipe, (r, o, s) => {
      let l = false, u = o;
      for (; --u >= 0 && s[u] === "\\"; ) l = !l;
      return l ? "|" : " |";
    }), n = t.split(x.splitPipe), i = 0;
    if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
    else for (; n.length < e; ) n.push("");
    for (; i < n.length; i++) n[i] = n[i].trim().replace(x.slashPipe, "|");
    return n;
  }
  function A(a2, e, t) {
    let n = a2.length;
    if (n === 0) return "";
    let i = 0;
    for (; i < n; ) {
      let r = a2.charAt(n - i - 1);
      if (r === e && !t) i++;
      else if (r !== e && t) i++;
      else break;
    }
    return a2.slice(0, n - i);
  }
  function ae(a2) {
    let e = a2.split(`
`), t = e.length - 1;
    for (; t >= 0 && x.blankLine.test(e[t]); ) t--;
    return e.length - t <= 2 ? a2 : e.slice(0, t + 1).join(`
`);
  }
  function v(a2) {
    return a2.trim().toLowerCase().toUpperCase().toLowerCase();
  }
  function le(a2, e) {
    if (a2.indexOf(e[0]) === -1 && a2.indexOf(e[1]) === -1) return -1;
    let t = 0;
    for (let n = 0; n < a2.length; n++) if (a2[n] === "\\") n++;
    else if (a2[n] === e[0]) t++;
    else if (a2[n] === e[1] && (t--, t < 0)) return n;
    return t > 0 ? -2 : -1;
  }
  function X(a2, e = 0) {
    let t = e, n = "";
    for (let i of a2) if (i === "	") {
      let r = 4 - t % 4;
      n += " ".repeat(r), t += r;
    } else n += i, t++;
    return n;
  }
  function Se(a2, e, t, n, i) {
    let r = e.href, o = e.title || null, s = a2[1].replace(i.other.outputLinkReplace, "$1"), l = a2[0].charAt(0) === "!", u = n.state.inLink, c = n.state.linkEmitted, p = n.state.inRawBlock;
    n.state.inLink = true, n.state.linkEmitted = false;
    let d = n.inlineTokens(s), g = n.state.linkEmitted;
    if (n.state.linkEmitted = c, n.state.inLink = u, !l) {
      if (g) {
        n.state.inRawBlock = p;
        return;
      }
      n.state.linkEmitted = true;
    }
    return { type: l ? "image" : "link", raw: t, href: r, title: o, text: s, tokens: d };
  }
  function Lt(a2, e, t) {
    let n = a2.match(t.other.indentCodeCompensation);
    if (n === null) return e;
    let i = n[1];
    return e.split(`
`).map((r) => {
      let o = r.match(t.other.beginningSpace);
      if (o === null) return r;
      let [s] = o;
      return r.slice(Math.min(s.length, i.length));
    }).join(`
`);
  }
  function _e(a2, e, t, n) {
    if (!e.includes("<")) return false;
    for (let i = 0; i < e.length; i++) {
      if (e[i] === "\\") {
        i++;
        continue;
      }
      if (e[i] === "`") {
        let s = n.inline.code.exec(e.slice(i));
        if (s) {
          i += s[0].length - 1;
          continue;
        }
      }
      if (e[i] !== "<") continue;
      let r = a2.slice(t + i), o = n.inline.tag.exec(r) || n.inline.autolink.exec(r);
      if (o) {
        if (o[0].length > e.length - i) return true;
        i += o[0].length - 1;
      }
    }
    return false;
  }
  var _ = class {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "rules");
      __publicField(this, "lexer");
      this.options = e || y;
    }
    space(e) {
      let t = this.rules.block.newline.exec(e);
      if (t && t[0].length > 0) return { type: "space", raw: t[0] };
    }
    code(e) {
      let t = this.rules.block.code.exec(e);
      if (t) {
        let n = this.options.pedantic ? t[0] : ae(t[0]), i = n.replace(this.rules.other.codeRemoveIndent, "");
        return { type: "code", raw: n, codeBlockStyle: "indented", text: i };
      }
    }
    fences(e) {
      let t = this.rules.block.fences.exec(e);
      if (t) {
        let n = t[0], i = Lt(n, t[3] || "", this.rules);
        return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: i };
      }
    }
    heading(e) {
      let t = this.rules.block.heading.exec(e);
      if (t) {
        let n = t[2].trim();
        if (this.rules.other.endingHash.test(n)) {
          let i = A(n, "#");
          (this.options.pedantic || !i || this.rules.other.endingSpaceTabChar.test(i)) && (n = i.trim());
        }
        return { type: "heading", raw: A(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
      }
    }
    hr(e) {
      let t = this.rules.block.hr.exec(e);
      if (t) return { type: "hr", raw: A(t[0], `
`) };
    }
    blockquote(e) {
      let t = this.rules.block.blockquote.exec(e);
      if (t) {
        let n = A(t[0], `
`).split(`
`), i = "", r = "", o = [];
        for (; n.length > 0; ) {
          let s = false, l = [], u;
          for (u = 0; u < n.length; u++) if (this.rules.other.blockquoteStart.test(n[u])) l.push(n[u]), s = true;
          else if (!s) l.push(n[u]);
          else break;
          n = n.slice(u);
          let c = l.join(`
`), p = c.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
          i = i ? `${i}
${c}` : c, r = r ? `${r}
${p}` : p;
          let d = this.lexer.state.top;
          if (this.lexer.state.top = true, this.lexer.blockTokens(p, o, true), this.lexer.state.top = d, n.length === 0) break;
          let g = o.at(-1);
          if (g?.type === "code" || g?.type === "heading" || g?.type === "hr" || g?.type === "html") break;
          if (g?.type === "blockquote") {
            let k = g, P = n.join(`
`), R = k.raw + `
` + P.replace(this.rules.other.blockquoteSetextReplace2, ""), m = this.blockquote(R);
            o[o.length - 1] = m;
            let E = R.substring(m.raw.length).replace(/^\n/, ""), b = E ? E.split(`
`).length : 0, H = b ? n.slice(0, -b) : n;
            H.length > 0 && (i = `${i}
${H.join(`
`)}`), r = r.substring(0, r.length - k.text.length) + m.text;
            break;
          } else if (g?.type === "list") {
            let k = g, P = k.raw + `
` + n.join(`
`), R = this.list(P);
            o[o.length - 1] = R, i = i.substring(0, i.length - g.raw.length) + R.raw, r = r.substring(0, r.length - k.raw.length) + R.raw, n = P.substring(o.at(-1).raw.length).split(`
`);
            continue;
          }
        }
        return { type: "blockquote", raw: i, tokens: o, text: r };
      }
    }
    list(e) {
      let t = this.rules.block.list.exec(e);
      if (t) {
        let n = e, i = () => n.length - e.length, r = t[1].trim(), o = r.length > 1, s = { type: "list", raw: "", ordered: o, start: o ? +r.slice(0, -1) : "", loose: false, items: [] };
        r = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`, this.options.pedantic && (r = o ? r : "[*+-]");
        let l = this.rules.other.listItemRegex(r), u = false;
        for (; e; ) {
          let p = false, d = "";
          if (!(t = l.exec(e)) || this.rules.block.hr.test(e)) break;
          let g = i();
          e = e.substring(t[0].length);
          let k = t[2].split(`
`, 1)[0], P = t[1].length, R = this.options.pedantic ? X(k, P) : k.replace(this.rules.other.leadingSpaceTab, (W) => X(W, P)), m = e.split(`
`, 1)[0], E = !R.trim(), b = 0;
          if (this.options.pedantic ? (b = 2, d = R.trimStart()) : E ? b = P + 1 : (b = R.search(this.rules.other.nonSpaceChar), b = b > 4 ? 1 : b, d = R.slice(b), b += P), E && this.rules.other.blankLine.test(m) && (e = e.substring(m.length + 1), p = true), !p) {
            let W = this.rules.other.nextBulletRegex(b), ue = this.rules.other.hrRegex(b), pe = this.rules.other.fencesBeginRegex(b), ce = this.rules.other.headingBeginRegex(b), $e = this.rules.other.htmlBeginRegex(b), Le = this.rules.other.blockquoteBeginRegex(b);
            for (; e; ) {
              let he = e.split(`
`, 1)[0], G;
              if (m = he, this.options.pedantic ? (m = m.replace(this.rules.other.listReplaceNesting, "  "), G = m) : G = m.replace(this.rules.other.leadingSpaceTab, (Ae) => X(Ae)), pe.test(m) || ce.test(m) || $e.test(m) || Le.test(m) || W.test(m) || ue.test(m)) break;
              if (G.search(this.rules.other.nonSpaceChar) >= b || !m.trim()) d += `
` + G.slice(b);
              else {
                if (E || R.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || pe.test(R) || ce.test(R) || ue.test(R)) break;
                d += `
` + m;
              }
              E = !m.trim(), e = e.substring(he.length + 1), R = G.slice(b);
            }
          }
          let H = n.slice(g, i());
          s.loose || (u ? s.loose = true : this.rules.other.doubleBlankLine.test(H) && (u = true)), s.items.push({ type: "list_item", raw: H, task: !!this.options.gfm && this.rules.other.listIsTask.test(d), loose: false, text: d, tokens: [] });
        }
        let c = s.items.at(-1);
        if (c) c.raw = c.raw.trimEnd(), c.text = c.text.trimEnd();
        else return;
        s.raw = n.slice(0, i()).trimEnd();
        for (let p of s.items) if (this.lexer.state.top = false, p.tokens = this.lexer.blockTokens(p.text, []), !s.loose) {
          let d = p.tokens.filter((k) => k.type === "space"), g = d.length > 0 && d.some((k) => this.rules.other.anyLine.test(k.raw));
          s.loose = g;
        }
        for (let p of s.items) {
          let d = p.tokens[0];
          if (p.task && (d?.type === "text" || d?.type === "paragraph")) {
            p.text = p.text.replace(this.rules.other.listReplaceTask, ""), d.raw = d.raw.replace(this.rules.other.listReplaceTask, ""), d.text = d.text.replace(this.rules.other.listReplaceTask, "");
            for (let k = this.lexer.inlineQueue.length - 1; k >= 0; k--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[k].src)) {
              this.lexer.inlineQueue[k].src = this.lexer.inlineQueue[k].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
            let g = this.rules.other.listTaskCheckbox.exec(p.raw);
            if (g) {
              let k = { type: "checkbox", raw: g[0] + " ", checked: g[0] !== "[ ]" };
              p.checked = k.checked, s.loose ? p.tokens[0] && ["paragraph", "text"].includes(p.tokens[0].type) && "tokens" in p.tokens[0] && p.tokens[0].tokens ? (p.tokens[0].raw = k.raw + p.tokens[0].raw, p.tokens[0].text = k.raw + p.tokens[0].text, p.tokens[0].tokens.unshift(k)) : p.tokens.unshift({ type: "paragraph", raw: k.raw, text: k.raw, tokens: [k] }) : p.tokens.unshift(k);
            }
          } else p.task && (p.task = false);
        }
        if (s.loose) for (let p of s.items) {
          p.loose = true;
          for (let d of p.tokens) d.type === "text" && (d.type = "paragraph");
        }
        return s;
      }
    }
    html(e) {
      let t = this.rules.block.html.exec(e);
      if (t) {
        let n = ae(t[0]);
        return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
      }
    }
    def(e) {
      let t = this.rules.block.def.exec(e);
      if (t) {
        if (!this.rules.other.startAngleBracket.test(t[2]) && le(t[2], "()") !== -1) return;
        let n = v(t[1]).replace(this.rules.other.multipleSpaceGlobal, " "), i = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
        return { type: "def", tag: n, raw: A(t[0], `
`), href: i, title: r };
      }
    }
    table(e) {
      let t = this.rules.block.table.exec(e);
      if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
      let n = oe(t[1]), i = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], o = { type: "table", raw: A(t[0], `
`), header: [], align: [], rows: [] };
      if (n.length === i.length) {
        for (let s of i) this.rules.other.tableAlignRight.test(s) ? o.align.push("right") : this.rules.other.tableAlignCenter.test(s) ? o.align.push("center") : this.rules.other.tableAlignLeft.test(s) ? o.align.push("left") : o.align.push(null);
        for (let s = 0; s < n.length; s++) o.header.push({ text: n[s], tokens: this.lexer.inline(n[s]), header: true, align: o.align[s] });
        for (let s of r) o.rows.push(oe(s, o.header.length).map((l, u) => ({ text: l, tokens: this.lexer.inline(l), header: false, align: o.align[u] })));
        return o;
      }
    }
    lheading(e) {
      let t = this.rules.block.lheading.exec(e);
      if (t) {
        let n = t[1].trim();
        return { type: "heading", raw: A(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
      }
    }
    paragraph(e) {
      let t = this.rules.block.paragraph.exec(e);
      if (t) {
        let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
        return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
      }
    }
    text(e) {
      let t = this.rules.block.text.exec(e);
      if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
    }
    escape(e) {
      let t = this.rules.inline.escape.exec(e);
      if (t) return { type: "escape", raw: t[0], text: t[1] };
    }
    tag(e) {
      let t = this.rules.inline.tag.exec(e);
      if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
    }
    link(e) {
      if (this.lexer.state.linkParenPossible === false) return;
      let t = this.rules.inline.link.exec(e);
      if (t) {
        let n = t[0].charAt(0) === "!" ? 2 : 1;
        if (!this.options.pedantic && _e(e, t[1], n, this.rules)) return;
        let i = t[2].trim();
        if (!this.options.pedantic && this.rules.other.startAngleBracket.test(i)) {
          if (!this.rules.other.endAngleBracket.test(i)) return;
          let s = A(i.slice(0, -1), "\\");
          if ((i.length - s.length) % 2 === 0) return;
        } else {
          let s = le(t[2], "()");
          if (s === -2) return;
          if (s > -1) {
            let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + s;
            t[2] = t[2].substring(0, s), t[0] = t[0].substring(0, u).trim(), t[3] = "";
          }
        }
        let r = t[2], o = "";
        if (this.options.pedantic) {
          let s = this.rules.other.pedanticHrefTitle.exec(r);
          s && (r = s[1], o = s[3]);
        } else o = t[3] ? t[3].slice(1, -1) : "";
        return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(i) ? r = r.slice(1) : r = r.slice(1, -1)), Se(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: o && o.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
      }
    }
    reflink(e, t) {
      let n;
      if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
        let i = n[0].charAt(0) === "!" ? 2 : 1;
        if (!this.options.pedantic && _e(e, n[1], i, this.rules)) return;
        let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), o = t[v(r)];
        if (!o) {
          let s = n[0].charAt(0);
          return { type: "text", raw: s, text: s };
        }
        return Se(n, o, n[0], this.lexer, this.rules);
      }
    }
    emStrong(e, t, n = "") {
      let i = this.rules.inline.emStrongLDelim.exec(e);
      if (!i || !i[1] && !i[2] && !i[3] && !i[4] || i[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
      if (!(i[1] || i[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
        let o = [...i[0]].length - 1, s, l, u = o, c = 0, p = i[0][0], d = n === p, g = p === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
        for (g.lastIndex = 0, t = t.slice(-1 * e.length + o); (i = g.exec(t)) !== null; ) {
          if (s = i[1] || i[2] || i[3] || i[4] || i[5] || i[6], !s) continue;
          if (l = [...s].length, i[3] || i[4]) {
            u += l;
            continue;
          } else if (i[5] || i[6]) {
            if (o % 3 && !((o + l) % 3)) {
              c += l;
              continue;
            }
            if (d) break;
          }
          if (u -= l, u > 0) continue;
          l = Math.min(l, l + u + c);
          let k = [...i[0]][0].length, P = e.slice(0, o + i.index + k + l);
          if (Math.min(o, l) % 2) {
            let m = P.slice(1, -1);
            return { type: "em", raw: P, text: m, tokens: this.lexer.inlineTokens(m) };
          }
          let R = P.slice(2, -2);
          return { type: "strong", raw: P, text: R, tokens: this.lexer.inlineTokens(R) };
        }
      }
    }
    codespan(e) {
      let t = this.rules.inline.code.exec(e);
      if (t) {
        let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), i = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
        return i && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
      }
    }
    br(e) {
      let t = this.rules.inline.br.exec(e);
      if (t) return { type: "br", raw: t[0] };
    }
    del(e, t, n = "") {
      let i = this.rules.inline.delLDelim.exec(e);
      if (!i) return;
      if (!(i[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
        let o = [...i[0]].length - 1, s, l, u = o, c = this.rules.inline.delRDelim;
        for (c.lastIndex = 0, t = t.slice(-1 * e.length + o); (i = c.exec(t)) !== null; ) {
          if (s = i[1] || i[2] || i[3] || i[4] || i[5] || i[6], !s || (l = [...s].length, l !== o)) continue;
          if (i[3] || i[4]) {
            u += l;
            continue;
          }
          if (u -= l, u > 0) continue;
          l = Math.min(l, l + u);
          let p = [...i[0]][0].length, d = e.slice(0, o + i.index + p + l), g = d.slice(o, -o);
          return { type: "del", raw: d, text: g, tokens: this.lexer.inlineTokens(g) };
        }
      }
    }
    autolink(e) {
      let t = this.rules.inline.autolink.exec(e);
      if (t) {
        let n, i;
        return t[2] === "@" ? (n = t[1], i = "mailto:" + n) : (n = t[1], i = n), { type: "link", raw: t[0], text: n, href: i, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
      }
    }
    url(e) {
      let t;
      if (t = this.rules.inline.url.exec(e)) {
        let n, i;
        if (t[2] === "@") n = t[0], i = "mailto:" + n;
        else {
          let r;
          do
            r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
          while (r !== t[0]);
          n = t[0], t[1] === "www." ? i = "http://" + t[0] : i = t[0];
        }
        return { type: "link", raw: t[0], text: n, href: i, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
      }
    }
    inlineText(e) {
      let t = this.rules.inline.text.exec(e);
      if (t) {
        let n = this.lexer.state.inRawBlock;
        return { type: "text", raw: t[0], text: n ? t[0] : ye(t[0]), escaped: n };
      }
    }
  };
  var _a_instances, e_fn, _a;
  var T = (_a = class {
    constructor(e) {
      __privateAdd(this, _a_instances);
      __publicField(this, "tokens");
      __publicField(this, "options");
      __publicField(this, "state");
      __publicField(this, "inlineQueue");
      __publicField(this, "tokenizer");
      this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || y, this.options.tokenizer = this.options.tokenizer || new _(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
      let t = { other: x, block: F.normal, inline: Z.normal };
      this.options.pedantic ? (t.block = F.pedantic, t.inline = Z.pedantic) : this.options.gfm && (t.block = F.gfm, this.options.breaks ? t.inline = Z.breaks : t.inline = Z.gfm), this.tokenizer.rules = t;
    }
    static get rules() {
      return { block: F, inline: Z };
    }
    static lex(e, t) {
      return new _a(t).lex(e);
    }
    static lexInline(e, t) {
      return new _a(t).inlineTokens(e);
    }
    lex(e) {
      e = e.replace(x.carriageReturn, `
`), this.blockTokens(e, this.tokens);
      for (let t = 0; t < this.inlineQueue.length; t++) {
        let n = this.inlineQueue[t];
        this.inlineTokens(n.src, n.tokens);
      }
      return this.inlineQueue = [], this.tokens;
    }
    blockTokens(e, t = [], n = false) {
      this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(x.tabCharGlobal, "    ").replace(x.spaceLine, ""));
      let i = 1 / 0;
      for (; e; ) {
        if (e.length < i) i = e.length;
        else {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
        let r;
        if (this.options.extensions?.block?.some((s) => (r = s.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
        if (r = this.tokenizer.space(e)) {
          e = e.substring(r.raw.length);
          let s = t.at(-1);
          r.raw.length === 1 && s !== void 0 ? s.raw += `
` : t.push(r);
          continue;
        }
        if (r = this.tokenizer.code(e)) {
          e = e.substring(r.raw.length);
          let s = t.at(-1);
          s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.at(-1).src = s.text) : t.push(r);
          continue;
        }
        if (r = this.tokenizer.fences(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.heading(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.hr(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.blockquote(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.list(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.html(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.def(e)) {
          e = e.substring(r.raw.length);
          let s = t.at(-1);
          s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.raw, this.inlineQueue.at(-1).src = s.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
          continue;
        }
        if (r = this.tokenizer.table(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.lheading(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        let o = e;
        if (this.options.extensions?.startBlock) {
          let s = 1 / 0, l = e.slice(1), u;
          this.options.extensions.startBlock.forEach((c) => {
            u = c.call({ lexer: this }, l), typeof u == "number" && u >= 0 && (s = Math.min(s, u));
          }), s < 1 / 0 && s >= 0 && (o = e.substring(0, s + 1));
        }
        if (this.state.top && (r = this.tokenizer.paragraph(o))) {
          let s = t.at(-1);
          n && s?.type === "paragraph" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
          continue;
        }
        if (r = this.tokenizer.text(e)) {
          e = e.substring(r.raw.length);
          let s = t.at(-1);
          s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r);
          continue;
        }
        if (e) {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
      }
      return this.state.top = true, t;
    }
    inline(e, t = []) {
      return this.inlineQueue.push({ src: e, tokens: t }), t;
    }
    linkInText(e) {
      if (!e.includes("[")) return false;
      let t = this.tokenizer.rules.inline.link;
      for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip)) if (t.test(n[0]) && e.charAt(n.index - 1) !== "!") return true;
      for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
        let i = n[0], r = i.lastIndexOf("[");
        if (!(i.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, v(i.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(i.slice(1, r - 1)))) return true;
      }
      return false;
    }
    inlineTokens(e, t = []) {
      this.tokenizer.lexer = this;
      let n = this.state.linkParenPossible;
      this.state.linkParenPossible = n && e.includes(")");
      try {
        return __privateMethod(this, _a_instances, e_fn).call(this, e, t);
      } finally {
        this.state.linkParenPossible = n;
      }
    }
    infiniteLoopError(e) {
      let t = "Infinite loop on byte: " + e;
      if (this.options.silent) console.error(t);
      else throw new Error(t);
    }
  }, _a_instances = new WeakSet(), e_fn = function(e, t) {
    let n = e;
    if (this.tokens.links && e.includes("[")) {
      let s = this.tokenizer.rules.inline.reflinkSearch, l = (u) => {
        let c = u.lastIndexOf("[");
        if (!Object.hasOwn(this.tokens.links, v(u.slice(c + 1, -1)))) return u;
        if (c > 1 && u.charAt(0) !== "!") {
          let p = u.slice(1, c - 1);
          if (this.linkInText(p)) return "[" + p.replace(s, l) + "][" + "a".repeat(u.length - c - 2) + "]";
        }
        return "[" + "a".repeat(u.length - 2) + "]";
      };
      n = n.replace(s, l);
    }
    n = n.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (s, l, u) => u ? "+".repeat(s.length) : l ? l + s.slice(l.length, -l.length).replace(/`/g, "+") + l : s), n = n.replace(this.tokenizer.rules.inline.blockSkip, (s, l, u) => {
      let c = u ? u.length : 0;
      return s.slice(0, c) + "[" + "a".repeat(s.length - c - 2) + "]";
    }), n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let i = false, r = "", o = 1 / 0;
    for (; e; ) {
      if (e.length < o) o = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      i || (r = ""), i = false;
      let s;
      if (this.options.extensions?.inline?.some((u) => (s = u.call({ lexer: this }, e, t)) ? (e = e.substring(s.raw.length), t.push(s), true) : false)) continue;
      if (s = this.tokenizer.escape(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.tag(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.link(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(s.raw.length);
        let u = t.at(-1);
        s.type === "text" && u?.type === "text" ? (u.raw += s.raw, u.text += s.text) : t.push(s);
        continue;
      }
      if (s = this.tokenizer.emStrong(e, n, r)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.codespan(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.br(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.del(e, n, r)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (s = this.tokenizer.autolink(e)) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      if (!this.state.inLink && (s = this.tokenizer.url(e))) {
        e = e.substring(s.raw.length), t.push(s);
        continue;
      }
      let l = e;
      if (this.options.extensions?.startInline) {
        let u = 1 / 0, c = e.slice(1), p;
        this.options.extensions.startInline.forEach((d) => {
          p = d.call({ lexer: this }, c), typeof p == "number" && p >= 0 && (u = Math.min(u, p));
        }), u < 1 / 0 && u >= 0 && (l = e.substring(0, u + 1));
      }
      if (s = this.tokenizer.inlineText(l)) {
        e = e.substring(s.raw.length), s.raw.slice(-1) !== "_" && (r = s.raw.slice(-1)), i = true;
        let u = t.at(-1);
        u?.type === "text" ? (u.raw += s.raw, u.text += s.text) : t.push(s);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return t;
  }, _a);
  var $ = class {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "parser");
      this.options = e || y;
    }
    space(e) {
      return "";
    }
    code({ text: e, lang: t, escaped: n }) {
      let i = (t || "").match(x.notSpaceStart)?.[0], r = e ? e.replace(x.endingNewline, "") + `
` : "";
      return i ? '<pre><code class="language-' + w(i) + '">' + (n ? r : w(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : w(r, true)) + `</code></pre>
`;
    }
    blockquote({ tokens: e }) {
      return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
    }
    html({ text: e }) {
      return e;
    }
    def(e) {
      return "";
    }
    heading({ tokens: e, depth: t }) {
      return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
    }
    hr(e) {
      return `<hr>
`;
    }
    list(e) {
      let t = e.ordered, n = e.start, i = "";
      for (let s = 0; s < e.items.length; s++) {
        let l = e.items[s];
        i += this.listitem(l);
      }
      let r = t ? "ol" : "ul", o = t && n !== 1 ? ' start="' + n + '"' : "";
      return "<" + r + o + `>
` + i + "</" + r + `>
`;
    }
    listitem(e) {
      return `<li>${this.parser.parse(e.tokens)}</li>
`;
    }
    checkbox({ checked: e }) {
      return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
    }
    paragraph({ tokens: e }) {
      return `<p>${this.parser.parseInline(e)}</p>
`;
    }
    table(e) {
      let t = "", n = "";
      for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
      t += this.tablerow({ text: n });
      let i = "";
      for (let r = 0; r < e.rows.length; r++) {
        let o = e.rows[r];
        n = "";
        for (let s = 0; s < o.length; s++) n += this.tablecell(o[s]);
        i += this.tablerow({ text: n });
      }
      return i && (i = `<tbody>${i}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + i + `</table>
`;
    }
    tablerow({ text: e }) {
      return `<tr>
${e}</tr>
`;
    }
    tablecell(e) {
      let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
      return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
    }
    strong({ tokens: e }) {
      return `<strong>${this.parser.parseInline(e)}</strong>`;
    }
    em({ tokens: e }) {
      return `<em>${this.parser.parseInline(e)}</em>`;
    }
    codespan({ text: e }) {
      return `<code>${w(e, true)}</code>`;
    }
    br(e) {
      return "<br>";
    }
    del({ tokens: e }) {
      return `<del>${this.parser.parseInline(e)}</del>`;
    }
    link({ href: e, title: t, text: n, tokens: i, autolink: r }) {
      let o = r ? w(n, true) : this.parser.parseInline(i), s = ie(e);
      if (s === null) return o;
      e = w(s, r);
      let l = '<a href="' + e + '"';
      return t && (l += ' title="' + w(t) + '"'), l += ">" + o + "</a>", l;
    }
    image({ href: e, title: t, text: n, tokens: i }) {
      i && (n = this.parser.parseInline(i, this.parser.textRenderer));
      let r = ie(e);
      if (r === null) return w(n);
      e = r;
      let o = `<img src="${w(e)}" alt="${w(n)}"`;
      return t && (o += ` title="${w(t)}"`), o += ">", o;
    }
    text(e) {
      return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : w(e.text);
    }
  };
  var z = class {
    strong({ text: e }) {
      return e;
    }
    em({ text: e }) {
      return e;
    }
    codespan({ text: e }) {
      return e;
    }
    del({ text: e }) {
      return e;
    }
    html({ text: e }) {
      return e;
    }
    text({ text: e }) {
      return e;
    }
    link({ text: e }) {
      return "" + e;
    }
    image({ text: e }) {
      return "" + e;
    }
    br() {
      return "";
    }
    checkbox({ raw: e }) {
      return e;
    }
  };
  var O = class a {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "renderer");
      __publicField(this, "textRenderer");
      this.options = e || y, this.options.renderer = this.options.renderer || new $(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new z();
    }
    static parse(e, t) {
      return new a(t).parse(e);
    }
    static parseInline(e, t) {
      return new a(t).parseInline(e);
    }
    parse(e) {
      this.renderer.parser = this;
      let t = "";
      for (let n = 0; n < e.length; n++) {
        let i = e[n];
        if (this.options.extensions?.renderers?.[i.type]) {
          let o = i, s = this.options.extensions.renderers[o.type].call({ parser: this }, o);
          if (s !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(o.type)) {
            t += s || "";
            continue;
          }
        }
        let r = i;
        switch (r.type) {
          case "space": {
            t += this.renderer.space(r);
            break;
          }
          case "hr": {
            t += this.renderer.hr(r);
            break;
          }
          case "heading": {
            t += this.renderer.heading(r);
            break;
          }
          case "code": {
            t += this.renderer.code(r);
            break;
          }
          case "table": {
            t += this.renderer.table(r);
            break;
          }
          case "blockquote": {
            t += this.renderer.blockquote(r);
            break;
          }
          case "list": {
            t += this.renderer.list(r);
            break;
          }
          case "checkbox": {
            t += this.renderer.checkbox(r);
            break;
          }
          case "html": {
            t += this.renderer.html(r);
            break;
          }
          case "def": {
            t += this.renderer.def(r);
            break;
          }
          case "paragraph": {
            t += this.renderer.paragraph(r);
            break;
          }
          case "text": {
            t += this.renderer.text(r);
            break;
          }
          default: {
            let o = 'Token with "' + r.type + '" type was not found.';
            if (this.options.silent) return console.error(o), "";
            throw new Error(o);
          }
        }
      }
      return t;
    }
    parseInline(e, t = this.renderer) {
      this.renderer.parser = this;
      let n = "";
      for (let i = 0; i < e.length; i++) {
        let r = e[i];
        if (this.options.extensions?.renderers?.[r.type]) {
          let s = this.options.extensions.renderers[r.type].call({ parser: this }, r);
          if (s !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
            n += s || "";
            continue;
          }
        }
        let o = r;
        switch (o.type) {
          case "escape": {
            n += t.text(o);
            break;
          }
          case "html": {
            n += t.html(o);
            break;
          }
          case "link": {
            n += t.link(o);
            break;
          }
          case "image": {
            n += t.image(o);
            break;
          }
          case "checkbox": {
            n += t.checkbox(o);
            break;
          }
          case "strong": {
            n += t.strong(o);
            break;
          }
          case "em": {
            n += t.em(o);
            break;
          }
          case "codespan": {
            n += t.codespan(o);
            break;
          }
          case "br": {
            n += t.br(o);
            break;
          }
          case "del": {
            n += t.del(o);
            break;
          }
          case "text": {
            n += t.text(o);
            break;
          }
          default: {
            let s = 'Token with "' + o.type + '" type was not found.';
            if (this.options.silent) return console.error(s), "";
            throw new Error(s);
          }
        }
      }
      return n;
    }
  };
  var _a2;
  var L = (_a2 = class {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "block");
      this.options = e || y;
    }
    preprocess(e) {
      return e;
    }
    postprocess(e) {
      return e;
    }
    processAllTokens(e) {
      return e;
    }
    emStrongMask(e) {
      return e;
    }
    provideLexer(e = this.block) {
      return e ? T.lex : T.lexInline;
    }
    provideParser(e = this.block) {
      return e ? O.parse : O.parseInline;
    }
  }, __publicField(_a2, "passThroughHooks", /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"])), __publicField(_a2, "passThroughHooksRespectAsync", /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"])), _a2);
  function C(a2, e) {
    if (Array.isArray(e)) for (let t = 0; t < e.length; t++) a2.push(e[t]);
    else a2.push(e);
  }
  var U = class {
    constructor(...e) {
      __publicField(this, "defaults", B());
      __publicField(this, "options", this.setOptions);
      __publicField(this, "parse", this.parseMarkdown(true));
      __publicField(this, "parseInline", this.parseMarkdown(false));
      __publicField(this, "Parser", O);
      __publicField(this, "Renderer", $);
      __publicField(this, "TextRenderer", z);
      __publicField(this, "Lexer", T);
      __publicField(this, "Tokenizer", _);
      __publicField(this, "Hooks", L);
      this.use(...e);
    }
    walkTokens(e, t) {
      let n = [];
      for (let i of e) switch (C(n, t.call(this, i)), i.type) {
        case "table": {
          let r = i;
          for (let o of r.header) C(n, this.walkTokens(o.tokens, t));
          for (let o of r.rows) for (let s of o) C(n, this.walkTokens(s.tokens, t));
          break;
        }
        case "list": {
          let r = i;
          C(n, this.walkTokens(r.items, t));
          break;
        }
        default: {
          let r = i;
          this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((o) => {
            let s = r[o].flat(1 / 0);
            C(n, this.walkTokens(s, t));
          }) : r.tokens && C(n, this.walkTokens(r.tokens, t));
        }
      }
      return n;
    }
    use(...e) {
      let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
      return e.forEach((n) => {
        let i = { ...n };
        if (i.async = this.defaults.async || i.async || false, n.extensions && (n.extensions.forEach((r) => {
          if (!r.name) throw new Error("extension name required");
          if ("renderer" in r) {
            let o = t.renderers[r.name];
            o ? t.renderers[r.name] = function(...s) {
              let l = r.renderer.apply(this, s);
              return l === false && (l = o.apply(this, s)), l;
            } : t.renderers[r.name] = r.renderer;
          }
          if ("tokenizer" in r) {
            if (!r.level || r.level !== "block" && r.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
            let o = t[r.level];
            o ? o.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
          }
          "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
        }), i.extensions = t), n.renderer) {
          let r = this.defaults.renderer || new $(this.defaults);
          for (let o in n.renderer) {
            if (!(o in r)) throw new Error(`renderer '${o}' does not exist`);
            if (["options", "parser"].includes(o)) continue;
            let s = o, l = n.renderer[s], u = r[s];
            r[s] = (...c) => {
              let p = l.apply(r, c);
              return p === false && (p = u.apply(r, c)), p || "";
            };
          }
          i.renderer = r;
        }
        if (n.tokenizer) {
          let r = this.defaults.tokenizer || new _(this.defaults);
          for (let o in n.tokenizer) {
            if (!(o in r)) throw new Error(`tokenizer '${o}' does not exist`);
            if (["options", "rules", "lexer"].includes(o)) continue;
            let s = o, l = n.tokenizer[s], u = r[s];
            r[s] = (...c) => {
              let p = l.apply(r, c);
              return p === false && (p = u.apply(r, c)), p;
            };
          }
          i.tokenizer = r;
        }
        if (n.hooks) {
          let r = this.defaults.hooks || new L();
          for (let o in n.hooks) {
            if (!(o in r)) throw new Error(`hook '${o}' does not exist`);
            if (["options", "block"].includes(o)) continue;
            let s = o, l = n.hooks[s], u = r[s];
            L.passThroughHooks.has(o) ? r[s] = (c) => {
              if (this.defaults.async && L.passThroughHooksRespectAsync.has(o)) return (async () => {
                let d = await l.call(r, c);
                return u.call(r, d);
              })();
              let p = l.call(r, c);
              return u.call(r, p);
            } : r[s] = (...c) => {
              if (this.defaults.async) return (async () => {
                let d = await l.apply(r, c);
                return d === false && (d = await u.apply(r, c)), d;
              })();
              let p = l.apply(r, c);
              return p === false && (p = u.apply(r, c)), p;
            };
          }
          i.hooks = r;
        }
        if (n.walkTokens) {
          let r = this.defaults.walkTokens, o = n.walkTokens;
          i.walkTokens = function(s) {
            let l = [];
            return l.push(o.call(this, s)), r && C(l, r.call(this, s)), l;
          };
        }
        this.defaults = { ...this.defaults, ...i };
      }), this;
    }
    setOptions(e) {
      return this.defaults = { ...this.defaults, ...e }, this;
    }
    lexer(e, t) {
      return T.lex(e, t ?? this.defaults);
    }
    parser(e, t) {
      return O.parse(e, t ?? this.defaults);
    }
    parseMarkdown(e) {
      return (n, i) => {
        let r = { ...i }, o = { ...this.defaults, ...r }, s = this.onError(!!o.silent, !!o.async);
        if (this.defaults.async === true && r.async === false) return s(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
        if (typeof n > "u" || n === null) return s(new Error("marked(): input parameter is undefined or null"));
        if (typeof n != "string") return s(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
        if (o.hooks && (o.hooks.options = o, o.hooks.block = e), o.async) return (async () => {
          let l = o.hooks ? await o.hooks.preprocess(n) : n, c = await (o.hooks ? await o.hooks.provideLexer(e) : e ? T.lex : T.lexInline)(l, o), p = o.hooks ? await o.hooks.processAllTokens(c) : c;
          o.walkTokens && await Promise.all(this.walkTokens(p, o.walkTokens));
          let g = await (o.hooks ? await o.hooks.provideParser(e) : e ? O.parse : O.parseInline)(p, o);
          return o.hooks ? await o.hooks.postprocess(g) : g;
        })().catch(s);
        try {
          o.hooks && (n = o.hooks.preprocess(n));
          let u = (o.hooks ? o.hooks.provideLexer(e) : e ? T.lex : T.lexInline)(n, o);
          o.hooks && (u = o.hooks.processAllTokens(u)), o.walkTokens && this.walkTokens(u, o.walkTokens);
          let p = (o.hooks ? o.hooks.provideParser(e) : e ? O.parse : O.parseInline)(u, o);
          return o.hooks && (p = o.hooks.postprocess(p)), p;
        } catch (l) {
          return s(l);
        }
      };
    }
    onError(e, t) {
      return (n) => {
        if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
          let i = "<p>An error occurred:</p><pre>" + w(n.message + "", true) + "</pre>";
          return t ? Promise.resolve(i) : i;
        }
        if (t) return Promise.reject(n);
        throw n;
      };
    }
  };
  var I = new U();
  function f(a2, e) {
    return I.parse(a2, e);
  }
  f.options = f.setOptions = function(a2) {
    return I.setOptions(a2), f.defaults = I.defaults, V(f.defaults), f;
  };
  f.getDefaults = B;
  f.defaults = y;
  function At(...a2) {
    return I.use(...a2), f.defaults = I.defaults, V(f.defaults), f;
  }
  f.use = At;
  f.walkTokens = function(a2, e) {
    return I.walkTokens(a2, e);
  };
  f.parseInline = I.parseInline;
  f.Parser = O;
  f.parser = O.parse;
  f.Renderer = $;
  f.TextRenderer = z;
  f.Lexer = T;
  f.lexer = T.lex;
  f.Tokenizer = _;
  f.Hooks = L;
  f.parse = f;
  var Rn = f.options;
  var Tn = f.setOptions;
  var On = f.walkTokens;
  var wn = f.parseInline;
  var yn = O.parse;
  var Sn = T.lex;

  // src/inject/markdown.ts
  f.setOptions({ gfm: true, breaks: true });
  function renderMarkdown(text) {
    try {
      const src = String(text == null ? "" : text);
      if (!src) return "";
      const html = f.parse(src, { async: false });
      return html;
    } catch {
      return escapeHtml2(text);
    }
  }
  function escapeHtml2(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // src/ui/studio-chat-css.ts
  var STUDIO_CHAT_CSS = `
/* ===== overlay \u5BB9\u5668 ===== */
/* z-index \u5206\u5C42\uFF08v0.20\uFF09\uFF1A
 *   2147483647  consent \u5F39\u7A97\uFF08\u540C\u610F\u95F8\u95E8\uFF0C\u6700\u9AD8\uFF09
 *   2147483644-3646  StudioUI sidebar/\u9762\u677F\uFF08\u5DE5\u5177\u5165\u53E3\uFF0C\u53EF\u70B9\u51FB\uFF09
 *   2147483000  \u672C chat overlay\uFF08\u6D88\u606F\u6E32\u67D3\uFF0C\u53EA\u76D6 DeepSeek #root\uFF09
 * chat overlay \u4F4E\u4E8E sidebar\uFF0C\u786E\u4FDD\u6D6E\u52A8\u6309\u94AE/\u9762\u677F\u4E0D\u88AB\u767D\u677F\u76D6\u4F4F\u3002 */
.ds-studio-chat-container {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 280px;          /* \u9ED8\u8BA4\u503C\uFF0CmeasureComposerTop \u4F1A\u52A8\u6001\u8986\u76D6\u4E3A\u7CBE\u786E\u503C */
  z-index: 2147483000;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 15px;
  color: #1a1a2e;
  transition: opacity 0.15s ease;
}

/* ctrl+shift+h \u5207\u6362\u9690\u85CF\u6001\uFF08\u53C2\u8003 cuckoo-code \u5207\u6362\u5F0F\u53E0\u52A0\u5E03\u5C40\uFF09\uFF1A
 * \u9690\u85CF\u65F6\u5B8C\u5168\u79FB\u51FA\u89C6\u53E3\uFF0C\u539F\u7F51\u9875\u5168\u53EF\u89C1\u3001\u53EF\u4EA4\u4E92\u3002 */
.ds-studio-chat-container.ds-studio-chat-hidden {
  display: none !important;
}

/* \u63ED\u793A\u95E8\u63A7\uFF1Aoverlay \u521D\u59CB\u4E0D\u53EF\u89C1\uFF0C\u7B49 composer \u6D4B\u91CF\u7A33\u5B9A\uFF08\u843D\u5728\u89C6\u53E3\u4E0B\u534A\u533A\uFF09\u518D\u6DE1\u5165\u3002
 * \u907F\u514D"\u5148\u77EE\u540E\u6DA8"\u7684\u95EA\u70C1\u2014\u2014\u521D\u6B21\u52A0\u8F7D SPA \u672A\u6E32\u67D3\u65F6 textarea \u6D6E\u5728\u9AD8\u4F4D\uFF0C
 * overlay \u4F1A\u5148\u6309\u9519\u8BEF\u6D4B\u91CF\u6E32\u67D3\u6210\u77EE\u9762\u677F\uFF0C\u6E32\u67D3\u5B8C\u6210\u540E\u518D\u8DF3\u9AD8\uFF0C\u89C6\u89C9\u95EA\u70C1\u3002
 * pointer-events:none \u9632\u6B62 pending \u900F\u660E\u6001\u62E6\u622A DeepSeek \u767B\u5F55\u9875/\u8F93\u5165\u6846\u70B9\u51FB\u3002 */
.ds-studio-chat-container.ds-studio-chat-pending {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ===== \u6D88\u606F\u5217\u8868\uFF08\u6EDA\u52A8\u5BB9\u5668\uFF09===== */
.ds-sc-message-list {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scroll-behavior: smooth;
}

.ds-sc-message-list::-webkit-scrollbar { width: 8px; }
.ds-sc-message-list::-webkit-scrollbar-thumb { background: #d0d0d8; border-radius: 4px; }
.ds-sc-message-list::-webkit-scrollbar-thumb:hover { background: #b0b0bc; }

/* ===== \u6D88\u606F\u6C14\u6CE1 ===== */
.ds-sc-msg-user {
  align-self: flex-end;
  max-width: 78%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border-radius: 14px 14px 4px 14px;
  padding: 10px 15px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.ds-sc-msg-assistant {
  align-self: flex-start;
  max-width: 88%;
  background: #f6f7f9;
  border: 1px solid #e8e8ee;
  border-radius: 14px 14px 14px 4px;
  padding: 12px 16px;
  line-height: 1.7;
  word-break: break-word;
}

/* \u6D88\u606F\u5B9A\u4F4D\u4E0A\u4E0B\u6587\uFF08\u590D\u5236\u6309\u94AE\u7EDD\u5BF9\u5B9A\u4F4D\u951A\u70B9\uFF09 */
.ds-sc-msg-user, .ds-sc-msg-assistant { position: relative; }

/* v0.27\uFF1A\u591A\u53C2\u4E0E\u8005\u5934\u50CF + \u540D\u79F0\u6807\u7B7E */
.ds-sc-sender-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.ds-sc-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%;
  font-size: 11px; font-weight: 600; color: #fff;
  background: #4D6BFE; flex-shrink: 0;
}
.ds-sc-sender { font-size: 12px; color: #888; font-weight: 500; }

/* v0.27\uFF1A\u5B50 bot \u6C14\u6CE1\u7D2B\u8272\u8C03\uFF08\u4E0E\u4E3B bot \u84DD\u8272\u8C03\u533A\u5206\uFF09 */
.ds-sc-msg-sub-bot .ds-sc-avatar { background: #8b5cf6; }
.ds-sc-msg-sub-bot { border-left: 3px solid #8b5cf6; }
.ds-sc-msg-main-bot .ds-sc-avatar { background: #4D6BFE; }
.ds-sc-msg-main-bot { border-left: 3px solid #4D6BFE; }

/* \u6D88\u606F\u590D\u5236\u6309\u94AE\uFF1Ahover \u663E\u793A\uFF0C\u53F3\u4E0A\u89D2\u6D6E\u51FA */
.ds-sc-copy-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: #888;
  background: #fff;
  border: 1px solid #e0e0e8;
  border-radius: 6px;
  cursor: pointer;
  z-index: 2;
}
.ds-sc-copy-btn:hover { color: #4D6BFE; border-color: #4D6BFE; }
.ds-sc-msg-user:hover .ds-sc-copy-btn,
.ds-sc-msg-assistant:hover .ds-sc-copy-btn { display: flex; }
.ds-sc-msg-user .ds-sc-copy-btn { background: rgba(255,255,255,0.95); color: rgba(255,255,255,0.85); border-color: rgba(255,255,255,0.3); }
.ds-sc-msg-user .ds-sc-copy-btn:hover { color: #fff; }

/* ===== \u601D\u8003\u5757\uFF08\u53EF\u6298\u53E0\uFF09===== */
.ds-sc-think {
  border-left: 2px solid #d0d0d8;
  background: #f5f5f8;
  border-radius: 0 6px 6px 0;
  margin-bottom: 8px;
  overflow: hidden;
}
.ds-sc-think-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: #888;
  cursor: pointer;
  user-select: none;
}
.ds-sc-think-head:hover { color: #555; }
.ds-sc-think-caret {
  display: inline-block;
  transition: transform 0.15s ease;
  font-size: 10px;
}
.ds-sc-think.open .ds-sc-think-caret { transform: rotate(90deg); }
.ds-sc-think-body {
  display: none;
  padding: 4px 10px 8px;
  font-size: 13px;
  color: #666;
  white-space: pre-wrap;
  line-height: 1.6;
}
.ds-sc-think.open .ds-sc-think-body { display: block; }

/* \u6D41\u5F0F\u671F\u6587\u672C\u5BB9\u5668\uFF1Amarked \u751F\u6210 HTML\uFF0C\u7528 markdown \u6837\u5F0F */
.ds-sc-streaming { white-space: normal; }
.ds-sc-streaming p { margin: 0 0 8px; }
.ds-sc-streaming p:last-child { margin-bottom: 0; }

/* \u6D41\u5F0F\u5149\u6807\uFF08\u53C2\u8003 cuckoo streaming-cursor\uFF09 */
.ds-sc-cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  background: #4D6BFE;
  vertical-align: text-bottom;
  animation: ds-sc-blink 1s step-end infinite;
}
@keyframes ds-sc-blink { 50% { opacity: 0; } }

/* \u56DE\u5230\u5E95\u90E8\u6309\u94AE */
.ds-sc-scroll-btn {
  position: absolute;
  bottom: 48px;
  right: 20px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid #e0e0e8;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  cursor: pointer;
  z-index: 10;
  font-size: 16px;
  color: #666;
}
.ds-sc-scroll-btn.show { display: flex; }
.ds-sc-scroll-btn:hover { color: #4D6BFE; border-color: #4D6BFE; }

/* \u6D41\u7ED3\u675F\u540E\u7684 markdown \u6E32\u67D3\u5BB9\u5668 */
.ds-sc-markdown {
  white-space: normal;
}
.ds-sc-markdown p { margin: 0 0 8px; }
.ds-sc-markdown p:last-child { margin-bottom: 0; }
.ds-sc-markdown h1, .ds-sc-markdown h2, .ds-sc-markdown h3 {
  margin: 12px 0 6px;
  font-weight: 600;
  line-height: 1.4;
}
.ds-sc-markdown h1 { font-size: 1.4em; }
.ds-sc-markdown h2 { font-size: 1.25em; }
.ds-sc-markdown h3 { font-size: 1.1em; }
.ds-sc-markdown ul, .ds-sc-markdown ol { margin: 6px 0 8px; padding-left: 24px; }
.ds-sc-markdown li { margin: 2px 0; }
.ds-sc-markdown pre {
  background: #f0f0f5;
  border-radius: 8px;
  padding: 10px 13px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  margin: 8px 0;
}
.ds-sc-markdown code {
  background: #f0f0f5;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
}
.ds-sc-markdown pre code {
  background: none;
  padding: 0;
}
.ds-sc-markdown blockquote {
  border-left: 3px solid #4D6BFE;
  margin: 8px 0;
  padding: 4px 12px;
  color: #555;
}
.ds-sc-markdown a {
  color: #4D6BFE;
  text-decoration: none;
}
.ds-sc-markdown a:hover { text-decoration: underline; }

/* \u8868\u683C\uFF08marked GFM\uFF09 */
.ds-sc-markdown table, .ds-sc-streaming table {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
  display: block;
  overflow-x: auto;
}
.ds-sc-markdown th, .ds-sc-streaming th,
.ds-sc-markdown td, .ds-sc-streaming td {
  border: 1px solid #e0e0e8;
  padding: 6px 10px;
  text-align: left;
}
.ds-sc-markdown th, .ds-sc-streaming th {
  background: #f0f0f5;
  font-weight: 600;
}

/* \u4EFB\u52A1\u5217\u8868\uFF08GFM checkbox\uFF09 */
.ds-sc-markdown input[type="checkbox"], .ds-sc-streaming input[type="checkbox"] {
  margin-right: 6px;
}

/* \u4EE3\u7801\u5757\uFF1A\u76F8\u5BF9\u5B9A\u4F4D\u7ED9\u590D\u5236\u6309\u94AE + \u8BED\u8A00\u6807\u7B7E */
.ds-sc-markdown pre, .ds-sc-streaming pre {
  position: relative;
}
/* \u4EE3\u7801\u5757\u8BED\u8A00\u6807\u7B7E\uFF08\u53F3\u4E0A\u89D2\uFF0CJS \u52A8\u6001\u63D2\u5165 .ds-sc-code-lang\uFF09 */
.ds-sc-code-lang {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 11px;
  color: #999;
  background: rgba(255,255,255,0.6);
  padding: 1px 6px;
  border-radius: 4px;
  pointer-events: none;
}
/* \u4EE3\u7801\u5757\u590D\u5236\u6309\u94AE */
.ds-sc-code-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  display: none;
  padding: 1px 6px;
  font-size: 11px;
  color: #888;
  background: #fff;
  border: 1px solid #e0e0e8;
  border-radius: 4px;
  cursor: pointer;
}
.ds-sc-markdown pre:hover .ds-sc-code-copy,
.ds-sc-streaming pre:hover .ds-sc-code-copy { display: inline-block; }
.ds-sc-code-copy:hover { color: #4D6BFE; border-color: #4D6BFE; }

/* \u6D41\u5F0F\u671F\u4E5F\u590D\u7528 markdown \u7684\u8868\u683C/\u4EE3\u7801\u5757/\u5217\u8868\u6837\u5F0F */
.ds-sc-streaming table { border-collapse: collapse; margin: 8px 0; font-size: 13px; display: block; overflow-x: auto; }
.ds-sc-streaming th, .ds-sc-streaming td { border: 1px solid #e0e0e8; padding: 6px 10px; }
.ds-sc-streaming th { background: #f0f0f5; font-weight: 600; }
.ds-sc-streaming ul, .ds-sc-streaming ol { margin: 6px 0 8px; padding-left: 24px; }
.ds-sc-streaming li { margin: 2px 0; }
.ds-sc-streaming pre { background: #f0f0f5; border-radius: 8px; padding: 10px 13px; overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 8px 0; }
.ds-sc-streaming code { background: #f0f0f5; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; }
.ds-sc-streaming pre code { background: none; padding: 0; }
.ds-sc-streaming blockquote { border-left: 3px solid #4D6BFE; margin: 8px 0; padding: 4px 12px; color: #555; }
.ds-sc-streaming h1, .ds-sc-streaming h2, .ds-sc-streaming h3 { margin: 12px 0 6px; font-weight: 600; line-height: 1.4; }
.ds-sc-streaming h1 { font-size: 1.4em; }
.ds-sc-streaming h2 { font-size: 1.25em; }
.ds-sc-streaming h3 { font-size: 1.1em; }
.ds-sc-streaming a { color: #4D6BFE; text-decoration: none; }
.ds-sc-markdown a:hover { text-decoration: underline; }

/* \u601D\u8003\u524D\u7F00\u6298\u53E0\u5361\u7247 */
.ds-sc-thinking-preface {
  font-size: 12px;
  color: #888;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: #f5f5f5;
  border-radius: 6px;
  cursor: pointer;
}

/* ===== \u5DE5\u5177\u5361\u7247\u5BB9\u5668\uFF08\u590D\u7528 tool-card-ui \u7684 DOM\uFF09===== */
.ds-sc-msg-assistant .ds-studio-tools-container {
  margin-bottom: 8px;
}

/* ===== \u5E95\u90E8\u72B6\u6001\u680F ===== */
.ds-sc-status-bar {
  flex-shrink: 0;
  padding: 6px 16px;
  background: #f9f9fc;
  border-top: 1px solid #e8e8ee;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #888;
}
.ds-sc-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;
}
.ds-sc-status-dot.busy {
  background: #4D6BFE;
  animation: ds-sc-pulse 1.5s ease-in-out infinite;
}
.ds-sc-status-dot.done { background: #22c55e; }
.ds-sc-status-dot.error { background: #ef4444; }
@keyframes ds-sc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* v0.20 removed: hidden virtual-list rule */
/* \u66F4\u6FC0\u8FDB\uFF1A\u9690\u85CF #root \u4E0B\u6240\u6709\u975E composer \u7684\u76F4\u63A5\u5B50\u5143\u7D20\uFF08\u5907\u7528\uFF0C\u5B9E\u6D4B\u540E\u51B3\u5B9A\u662F\u5426\u542F\u7528\uFF09
#root > div > div:not(:last-child) {
  visibility: hidden !important;
  pointer-events: none !important;
}
*/
`;

  // src/ui/studio-chat-ui.ts
  var styleInjected2 = false;
  function injectChatStyles() {
    if (styleInjected2) return;
    const style = document.createElement("style");
    style.id = "ds-studio-chat-styles";
    style.textContent = STUDIO_CHAT_CSS;
    const head = document.head ?? document.documentElement;
    if (head) {
      head.appendChild(style);
      styleInjected2 = true;
    } else {
      const tryInject = () => {
        if (styleInjected2) return;
        const root = document.documentElement;
        if (root) {
          root.appendChild(style);
          styleInjected2 = true;
        }
      };
      document.addEventListener("DOMContentLoaded", tryInject, { once: true });
      const obs = new MutationObserver(() => {
        if (document.documentElement) {
          tryInject();
          obs.disconnect();
        }
      });
      obs.observe(document, { childList: true, subtree: true });
    }
  }
  function measureComposerTop() {
    let seed = null;
    const tas = document.querySelectorAll("textarea");
    for (const ta of tas) {
      if (ta.offsetWidth === 0 || ta.offsetHeight === 0) continue;
      const rect = ta.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 10) {
        seed = ta;
        break;
      }
    }
    if (!seed) {
      const editables = document.querySelectorAll('[contenteditable="true"]');
      for (const ed of editables) {
        const el2 = ed;
        if (el2.offsetWidth === 0 || el2.offsetHeight === 0) continue;
        const rect = el2.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 10) {
          seed = ed;
          break;
        }
      }
    }
    if (!seed) return null;
    let p = seed;
    for (let i = 0; i < 10 && p; i++) {
      const r = p.getBoundingClientRect();
      if (r.height > 120 && r.height < 400) {
        return Math.round(r.top);
      }
      p = p.parentElement;
    }
    return Math.round(seed.getBoundingClientRect().top);
  }
  function measureSidebarRight() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let best = 0;
    const all = document.body ? document.body.querySelectorAll(":scope > *") : [];
    for (const el2 of all) {
      const cls = typeof el2.className === "string" ? el2.className : "";
      if (cls.includes("studio-") || cls.includes("ds-studio") || cls.includes("ds-sc")) continue;
      if (el2.closest(".ds-studio-chat-container")) continue;
      const r = el2.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left <= 20 && r.height > vh * 0.5 && r.width <= vw * 0.25) {
        if (r.right > best) best = r.right;
      }
    }
    if (best === 0) {
      const root = document.querySelector("#root");
      if (root) {
        const descendants = root.querySelectorAll("*");
        let scanned = 0;
        for (const el2 of descendants) {
          if (scanned++ > 2e3) break;
          const cls = typeof el2.className === "string" ? el2.className : "";
          if (cls.includes("studio-") || cls.includes("ds-studio") || cls.includes("ds-sc")) continue;
          const r = el2.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.left <= 20 && r.height > vh * 0.5 && r.width <= vw * 0.25 && r.width > 0) {
            if (r.right > best) best = r.right;
          }
        }
      }
    }
    return Math.round(best);
  }
  function adjustOverlayLayout(container) {
    const composerTop = measureComposerTop();
    if (composerTop === null || composerTop <= 0) return;
    const vh = window.innerHeight;
    if (container.classList.contains("ds-studio-chat-pending")) {
      if (composerTop > vh * 0.4) {
        container.classList.remove("ds-studio-chat-pending");
        console.log("[studio-chat-ui] composer settled at", composerTop, "px, reveal overlay");
      } else {
        console.log("[studio-chat-ui] composer at", composerTop, "px (< vh*0.4=", Math.round(vh * 0.4), "), stay pending");
      }
    }
    const bottom = vh - composerTop + 8;
    const safeBottom = Math.max(120, Math.min(bottom, vh - 120));
    container.style.bottom = safeBottom + "px";
    const sidebarRight = measureSidebarRight();
    const safeLeft = sidebarRight > 0 ? sidebarRight + 8 : 0;
    container.style.left = safeLeft + "px";
    console.log("[studio-chat-ui] overlay layout: bottom=", safeBottom, "px (composerTop=", composerTop, "), left=", safeLeft, "px (sidebarRight=", sidebarRight, ")");
  }
  function createStudioChatUI() {
    injectChatStyles();
    const container = document.createElement("div");
    container.className = "ds-studio-chat-container ds-studio-chat-pending";
    console.log("[studio-chat-ui] createStudioChatUI start, injecting styles=", !styleInjected2);
    const messageList = document.createElement("div");
    messageList.className = "ds-sc-message-list";
    container.appendChild(messageList);
    const statusBar = document.createElement("div");
    statusBar.className = "ds-sc-status-bar";
    const statusDot = document.createElement("span");
    statusDot.className = "ds-sc-status-dot";
    const statusText = document.createElement("span");
    statusText.className = "ds-sc-status-text";
    statusText.textContent = "\u5C31\u7EEA";
    statusBar.appendChild(statusDot);
    statusBar.appendChild(statusText);
    container.appendChild(statusBar);
    const scrollBtn = document.createElement("div");
    scrollBtn.className = "ds-sc-scroll-btn";
    scrollBtn.textContent = "\u2193";
    scrollBtn.title = "\u56DE\u5230\u5E95\u90E8";
    container.appendChild(scrollBtn);
    let pinBottom = true;
    let suppressPin = false;
    function isNearBottom() {
      return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 90;
    }
    function updateScrollBtn() {
      if (!pinBottom && !isNearBottom()) scrollBtn.classList.add("show");
      else scrollBtn.classList.remove("show");
    }
    function scrollToBottom(force = false) {
      if (force || pinBottom) {
        suppressPin = true;
        messageList.scrollTop = messageList.scrollHeight;
        pinBottom = true;
        requestAnimationFrame(() => {
          suppressPin = false;
        });
      }
      updateScrollBtn();
    }
    messageList.addEventListener("scroll", () => {
      if (!suppressPin) pinBottom = isNearBottom();
      updateScrollBtn();
    });
    scrollBtn.addEventListener("click", () => {
      pinBottom = true;
      scrollToBottom(true);
    });
    let currentAssistant = null;
    let currentRawText = "";
    let currentReasoning = "";
    let thinkUserToggled = false;
    const welcome = document.createElement("div");
    welcome.style.cssText = "margin:auto;text-align:center;padding:40px 20px;color:#999;";
    welcome.innerHTML = '<div style="font-size:20px;font-weight:600;margin-bottom:8px;">DeepSeek Studio</div><div style="font-size:13px;line-height:1.8;">\u5728\u4E0B\u65B9\u8F93\u5165\u6846\u53D1\u9001\u6D88\u606F<br>\u5DE5\u5177\u8C03\u7528\u4E0E\u56DE\u590D\u5C06\u663E\u793A\u5728\u6B64\u5904</div><div style="font-size:12px;line-height:1.8;margin-top:12px;color:#aaa;">Ctrl+Shift+H \u5207\u6362\u663E\u793A/\u9690\u85CF</div>';
    messageList.appendChild(welcome);
    function attachCopy(msg2) {
      const btn = document.createElement("span");
      btn.className = "ds-sc-copy-btn";
      btn.textContent = "\u590D\u5236";
      btn.addEventListener("click", () => {
        const text = msg2.innerText.replace(/​/g, "");
        try {
          navigator.clipboard?.writeText(text);
        } catch {
        }
        btn.textContent = "\u5DF2\u590D\u5236";
        setTimeout(() => {
          btn.textContent = "\u590D\u5236";
        }, 1500);
      });
      msg2.appendChild(btn);
    }
    function enhanceCodeBlocks(scope) {
      const pres = scope.querySelectorAll("pre");
      for (const pre of pres) {
        if (pre.querySelector(".ds-sc-code-lang") || pre.querySelector(".ds-sc-code-copy")) continue;
        const code2 = pre.querySelector("code");
        if (!code2) continue;
        const cls = code2.className || "";
        const langMatch = cls.match(/language-(\w+)/);
        const lang = langMatch ? langMatch[1] : "";
        if (lang) {
          const tag = document.createElement("span");
          tag.className = "ds-sc-code-lang";
          tag.textContent = lang;
          pre.appendChild(tag);
        }
        const copyBtn = document.createElement("span");
        copyBtn.className = "ds-sc-code-copy";
        copyBtn.textContent = "\u590D\u5236";
        copyBtn.addEventListener("click", () => {
          const text = code2.textContent || "";
          try {
            navigator.clipboard?.writeText(text);
          } catch {
          }
          copyBtn.textContent = "\u5DF2\u590D\u5236";
          setTimeout(() => {
            copyBtn.textContent = "\u590D\u5236";
          }, 1500);
        });
        pre.appendChild(copyBtn);
      }
    }
    function addUserMessage(text) {
      const w2 = messageList.querySelector(':scope > [style*="margin:auto"]');
      if (w2) w2.remove();
      const msg2 = document.createElement("div");
      msg2.className = "ds-sc-msg-user";
      msg2.textContent = text;
      attachCopy(msg2);
      messageList.appendChild(msg2);
      scrollToBottom(true);
    }
    function startAssistantMessage(sender) {
      const w2 = messageList.querySelector(':scope > [style*="margin:auto"]');
      if (w2) w2.remove();
      const msg2 = document.createElement("div");
      const senderType = sender?.type ?? "main-bot";
      msg2.className = `ds-sc-msg-assistant ds-sc-msg-${senderType}`;
      const meta = document.createElement("div");
      meta.className = "ds-sc-sender-row";
      const avatar = document.createElement("span");
      avatar.className = "ds-sc-avatar";
      const senderName = sender?.name ?? "\u52A9\u624B";
      avatar.textContent = senderName.slice(0, 2);
      const label = document.createElement("span");
      label.className = "ds-sc-sender";
      label.textContent = senderName;
      meta.appendChild(avatar);
      meta.appendChild(label);
      msg2.appendChild(meta);
      const think = document.createElement("div");
      think.className = "ds-sc-think";
      think.style.display = "none";
      const thinkHead = document.createElement("div");
      thinkHead.className = "ds-sc-think-head";
      const thinkCaret = document.createElement("span");
      thinkCaret.className = "ds-sc-think-caret";
      thinkCaret.textContent = "\u25B6";
      const thinkLabel = document.createElement("span");
      thinkLabel.textContent = "\u601D\u8003\u4E2D\u2026";
      thinkHead.appendChild(thinkCaret);
      thinkHead.appendChild(thinkLabel);
      const thinkBody = document.createElement("div");
      thinkBody.className = "ds-sc-think-body";
      think.appendChild(thinkHead);
      think.appendChild(thinkBody);
      thinkHead.addEventListener("click", () => {
        think.classList.toggle("open");
        thinkUserToggled = true;
      });
      msg2.appendChild(think);
      const streaming = document.createElement("div");
      streaming.className = "ds-sc-streaming";
      msg2.appendChild(streaming);
      attachCopy(msg2);
      messageList.appendChild(msg2);
      currentAssistant = msg2;
      currentRawText = "";
      currentReasoning = "";
      thinkUserToggled = false;
      streamRenderTimer = null;
      scrollToBottom(true);
    }
    let streamRenderTimer = null;
    function scheduleStreamRender() {
      if (streamRenderTimer) return;
      streamRenderTimer = setTimeout(() => {
        streamRenderTimer = null;
        renderStreaming();
      }, 80);
    }
    function renderStreaming() {
      if (!currentAssistant) return;
      const streaming = currentAssistant.querySelector(".ds-sc-streaming");
      if (!streaming) return;
      if (currentRawText) {
        streaming.innerHTML = renderMarkdown(currentRawText) + '<span class="ds-sc-cursor"></span>';
        enhanceCodeBlocks(streaming);
      }
      scrollToBottom();
    }
    function appendToAssistantMessage(text) {
      if (!currentAssistant) startAssistantMessage();
      currentRawText += text;
      if (!thinkUserToggled && currentReasoning) {
        const think = currentAssistant.querySelector(".ds-sc-think");
        if (think) think.classList.remove("open");
      }
      scheduleStreamRender();
    }
    function appendReasoning(text) {
      if (!currentAssistant) startAssistantMessage();
      currentReasoning = text;
      const think = currentAssistant.querySelector(".ds-sc-think");
      if (!think) return;
      think.style.display = "";
      const body = think.querySelector(".ds-sc-think-body");
      const label = think.querySelector(".ds-sc-think-head > span:last-child");
      if (body) body.textContent = text;
      if (!currentRawText && !thinkUserToggled) {
        think.classList.add("open");
      }
      if (label) label.textContent = "\u5DF2\u601D\u8003\uFF08" + text.length + " \u5B57\uFF09";
      scrollToBottom();
    }
    function finishAssistantMessage() {
      if (!currentAssistant) return;
      if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
      }
      const streaming = currentAssistant.querySelector(".ds-sc-streaming");
      if (streaming && currentRawText) {
        const html = renderMarkdown(currentRawText);
        const markdownDiv = document.createElement("div");
        markdownDiv.className = "ds-sc-markdown";
        markdownDiv.innerHTML = html;
        enhanceCodeBlocks(markdownDiv);
        streaming.replaceWith(markdownDiv);
      }
      currentAssistant = null;
      currentRawText = "";
      currentReasoning = "";
      thinkUserToggled = false;
      scrollToBottom();
    }
    function setBusy(busy) {
      statusDot.className = busy ? "ds-sc-status-dot busy" : "ds-sc-status-dot done";
      statusText.textContent = busy ? "\u6267\u884C\u4E2D\u2026" : "\u5B8C\u6210";
    }
    function destroy() {
      bottomObserver.disconnect();
      if (streamRenderTimer) {
        clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
      }
      window.removeEventListener("resize", tryAdjust);
      window.removeEventListener("scroll", tryAdjust, { capture: true });
      window.removeEventListener("keydown", onToggleKey);
      container.remove();
      currentAssistant = null;
      currentRawText = "";
      currentReasoning = "";
      thinkUserToggled = false;
    }
    let visible = true;
    function toggle() {
      visible = !visible;
      if (visible) {
        container.classList.remove("ds-studio-chat-hidden");
      } else {
        container.classList.add("ds-studio-chat-hidden");
      }
      console.log("[studio-chat-ui] overlay", visible ? "shown" : "hidden");
      return visible;
    }
    function onToggleKey(e) {
      if (e.ctrlKey && e.shiftKey && (e.key === "h" || e.key === "H" || e.code === "KeyH")) {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onToggleKey);
    let rafPending = false;
    function tryAdjust() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        adjustOverlayLayout(container);
      });
    }
    const bottomObserver = new MutationObserver(() => {
      tryAdjust();
    });
    function startObserver() {
      try {
        if (document.body) {
          bottomObserver.observe(document.body, { childList: true, subtree: true });
        }
      } catch {
      }
    }
    tryAdjust();
    if (document.body) {
      startObserver();
    } else {
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    }
    setTimeout(tryAdjust, 500);
    setTimeout(tryAdjust, 1500);
    setTimeout(tryAdjust, 3e3);
    window.addEventListener("resize", tryAdjust);
    window.addEventListener("scroll", tryAdjust, { passive: true, capture: true });
    return {
      container,
      addUserMessage,
      startAssistantMessage,
      appendToAssistantMessage,
      appendReasoning,
      finishAssistantMessage,
      setBusy,
      toggle,
      destroy
    };
  }

  // src/ui/studio-ui-core.ts
  var EventBus = class {
    constructor() {
      __publicField(this, "handlers", /* @__PURE__ */ new Map());
    }
    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, /* @__PURE__ */ new Set());
      this.handlers.get(event).add(handler);
      return () => this.handlers.get(event)?.delete(handler);
    }
    emit(event, payload) {
      this.handlers.get(event)?.forEach((h2) => {
        try {
          h2(payload);
        } catch {
        }
      });
    }
  };
  var globalEvents = new EventBus();
  var globalState = {
    currentProject: null,
    workspaceRoot: null,
    policyMode: "full",
    localToolsEnabled: true,
    skills: [],
    mcpServers: [],
    memories: []
  };
  var hostBridge = null;
  function setHostBridge(bridge) {
    hostBridge = bridge;
  }
  async function callHostTool(invocationName, params) {
    if (!hostBridge) return { ok: false, error: "no-host-bridge" };
    const callId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return hostBridge.sendToolCall({ callId, invocationName, params });
  }
  var stylesInjected = false;
  function createShadowContainer(id) {
    if (!stylesInjected) {
      injectGlobalStyles();
      stylesInjected = true;
    }
    const container = document.createElement("div");
    container.id = id;
    container.className = "studio-ui-root";
    container.style.cssText = "display:block;pointer-events:none;";
    return { container, shadow: container };
  }
  function injectGlobalStyles() {
    const style = document.createElement("style");
    style.id = "studio-ui-global-styles";
    style.textContent = baseStyles;
    document.head.appendChild(style);
  }
  function injectStyles(_shadow, css) {
    let styleEl = document.getElementById("studio-ui-component-styles");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "studio-ui-component-styles";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent += "\n" + css;
  }
  function el(tag, props, children) {
    const element = document.createElement(tag);
    if (props?.className) element.className = props.className;
    if (props?.text) element.textContent = props.text;
    if (props?.html) element.innerHTML = props.html;
    if (props?.attrs) {
      for (const [k, v2] of Object.entries(props.attrs)) element.setAttribute(k, v2);
    }
    if (props?.style) {
      Object.assign(element.style, props.style);
    }
    if (children) {
      for (const child of children) element.appendChild(child);
    }
    return element;
  }
  function icon(pathData, size = 16) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }
  var Icons = {
    settings: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    folder: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
    plus: "M5 12h14 M12 5v14",
    search: "m21 21-4.3-4.3 M19 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
    chevronRight: "m9 18 6-6-6-6",
    chevronDown: "m6 9 6 6 6-6",
    x: "M18 6 6 18 M6 6l12 12",
    check: "M20 6 9 17l-5-5",
    play: "M6 3v18l15-9z",
    pause: "M6 4h4v16H6z M14 4h4v16h-4z",
    trash: "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z",
    refresh: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M3 21v-5h5",
    cpu: "M4 4h16v16H4z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M1 9h3 M1 15h3 M20 9h3 M20 15h3",
    zap: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
    message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2",
    puzzle: "M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z",
    book: "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20",
    file: "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z M14 2v6h6",
    terminal: "m4 17 6-6-6-6 M12 19h8",
    brain: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M12 5v13 M15 13a4.5 4.5 0 0 1-3-4 M9 13a4.5 4.5 0 0 0 3-4"
  };
  var baseStyles = `
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    color: #1a1a2e;
  }
  * { box-sizing: border-box; }
  .studio-ui-root > * { pointer-events: auto; }
  .studio-sidebar, .studio-right-sidebar, .studio-input-bar,
  .studio-modal-overlay, .studio-skills-overlay, .studio-right-toggle {
    pointer-events: auto;
  }
  .studio-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    background: #fff;
    color: #333;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
    user-select: none;
  }
  .studio-btn:hover { background: #f5f5f5; border-color: #ccc; }
  .studio-btn.primary { background: #4D6BFE; color: #fff; border-color: #4D6BFE; }
  .studio-btn.primary:hover { background: #3a58e8; }
  .studio-btn.danger { color: #e53935; border-color: #ffcdd2; }
  .studio-btn.danger:hover { background: #ffebee; }
  .studio-btn.sm { padding: 4px 8px; font-size: 12px; }
  .studio-input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  .studio-input:focus { border-color: #4D6BFE; }
  .studio-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2147483645;
  }
  .studio-modal {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    max-width: 90vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .studio-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #f0f0f0;
  }
  .studio-modal-title { font-size: 16px; font-weight: 600; margin: 0; }
  .studio-modal-body { padding: 20px; overflow-y: auto; flex: 1; }
  .studio-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #f0f0f0;
  }
  .studio-close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 4px;
    color: #666;
  }
  .studio-close-btn:hover { background: #f0f0f0; }
  .studio-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid #f0f0f0;
    margin-bottom: 16px;
  }
  .studio-tab {
    padding: 8px 16px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 13px;
    color: #666;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .studio-tab.active { color: #4D6BFE; border-bottom-color: #4D6BFE; font-weight: 500; }
  .studio-form-group { margin-bottom: 16px; }
  .studio-form-label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: #333; }
  .studio-form-hint { font-size: 12px; color: #999; margin-top: 4px; }
  .studio-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .studio-list-item:hover { background: #f5f7ff; }
  .studio-list-item.active { background: #eef1ff; }
  .studio-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
  }
  .studio-badge.success { background: #e8f5e9; color: #2e7d32; }
  .studio-badge.warning { background: #fff3e0; color: #e65100; }
  .studio-badge.error { background: #ffebee; color: #c62828; }
  .studio-badge.info { background: #e3f2fd; color: #1565c0; }
  .studio-switch {
    position: relative;
    width: 36px;
    height: 20px;
    background: #ccc;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .studio-switch.on { background: #4D6BFE; }
  .studio-switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .studio-switch.on::after { transform: translateX(16px); }
`;

  // src/ui/studio-sidebar.ts
  var sidebarStyles = `
  /* \u6D6E\u52A8\u89E6\u53D1\u6309\u94AE */
  .studio-fab {
    position: fixed;
    top: 12px;
    left: 12px;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: rgba(255,255,255,0.9);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(0,0,0,0.08);
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 2147483646;
    transition: all 0.2s ease;
    color: #4D6BFE;
    user-select: none;
  }
  .studio-fab:hover {
    background: #fff;
    box-shadow: 0 4px 12px rgba(77,107,254,0.2);
    transform: scale(1.05);
  }
  .studio-fab svg { width: 18px; height: 18px; }

  /* \u906E\u7F69\u5C42 */
  .studio-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.3);
    z-index: 2147483644;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease, visibility 0.2s ease;
  }
  .studio-overlay.visible {
    opacity: 1;
    visibility: visible;
  }

  /* \u4FA7\u8FB9\u680F\u9762\u677F */
  .studio-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    width: 260px;
    height: 100vh;
    background: #ffffff;
    border-right: 1px solid #e8e8e8;
    display: flex;
    flex-direction: column;
    z-index: 2147483645;
    pointer-events: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    color: #333;
    overflow: hidden;
    box-shadow: 4px 0 16px rgba(0,0,0,0.1);
    transform: translateX(-100%);
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .studio-sidebar.visible {
    transform: translateX(0);
  }
  .studio-sidebar-header {
    padding: 14px 16px;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .studio-logo {
    width: 30px;
    height: 30px;
    background: linear-gradient(135deg, #4D6BFE, #7B8FFF);
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    flex-shrink: 0;
  }
  .studio-logo-text { font-weight: 600; font-size: 15px; color: #1a1a2e; flex: 1; }
  .studio-close-btn {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: transparent; cursor: pointer;
    border-radius: 6px; color: #999; flex-shrink: 0;
    transition: all 0.15s;
  }
  .studio-close-btn:hover { background: #f5f5f5; color: #333; }
  .studio-close-btn svg { width: 16px; height: 16px; }

  .studio-nav-section {
    padding: 8px 0;
    border-bottom: 1px solid #f0f0f0;
    flex-shrink: 0;
  }
  .studio-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 16px;
    cursor: pointer;
    color: #555;
    transition: all 0.15s;
    user-select: none;
  }
  .studio-nav-item:hover { background: #f0f2ff; color: #4D6BFE; }
  .studio-nav-item svg { flex-shrink: 0; opacity: 0.7; width: 16px; height: 16px; }

  .studio-projects-section {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .studio-section-title {
    padding: 4px 16px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: #999;
    letter-spacing: 0.5px;
  }
  .studio-project-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    cursor: pointer;
    color: #555;
    transition: all 0.15s;
    border-left: 2px solid transparent;
    user-select: none;
  }
  .studio-project-item:hover { background: #f0f2ff; }
  .studio-project-item.active {
    background: #eef1ff;
    color: #4D6BFE;
    border-left-color: #4D6BFE;
    font-weight: 500;
  }
  .studio-project-item svg { width: 14px; height: 14px; flex-shrink: 0; }
  .studio-project-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-project-path { font-size: 11px; color: #aaa; padding: 0 16px 4px 42px; }

  .studio-sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .studio-user-avatar {
    width: 32px; height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 600; font-size: 13px; flex-shrink: 0;
  }
  .studio-user-info { flex: 1; min-width: 0; }
  .studio-user-name { font-weight: 500; font-size: 13px; color: #333; }
  .studio-user-plan { font-size: 11px; color: #999; }
  .studio-settings-btn {
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: transparent; cursor: pointer;
    border-radius: 6px; color: #666; flex-shrink: 0;
    transition: all 0.15s;
  }
  .studio-settings-btn:hover { background: #f0f0f0; color: #4D6BFE; }
  .studio-settings-btn svg { width: 18px; height: 18px; }

  .studio-new-project-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 16px; margin: 4px 8px;
    border: 1px dashed #d0d0d0; border-radius: 6px;
    background: transparent; cursor: pointer;
    color: #888; font-size: 12px; width: calc(100% - 16px);
    transition: all 0.15s;
  }
  .studio-new-project-btn:hover { border-color: #4D6BFE; color: #4D6BFE; background: #f8f9ff; }
  .studio-new-project-btn svg { width: 14px; height: 14px; }
`;
  function createSidebar() {
    const { container, shadow } = createShadowContainer("studio-sidebar-root");
    injectStyles(shadow, sidebarStyles);
    let isOpen = false;
    const fab = el("button", { className: "studio-fab", attrs: { title: "Studio \u9762\u677F" } }, [
      icon(Icons.folder, 18)
    ]);
    const overlay = el("div", { className: "studio-overlay" });
    const sidebar = el("div", { className: "studio-sidebar" });
    const header = el("div", { className: "studio-sidebar-header" }, [
      el("div", { className: "studio-logo", text: "S" }),
      el("span", { className: "studio-logo-text", text: "Studio" })
    ]);
    const closeBtn = el("button", { className: "studio-close-btn", attrs: { title: "\u5173\u95ED" } }, [icon(Icons.x, 16)]);
    header.appendChild(closeBtn);
    sidebar.appendChild(header);
    const navSection = el("div", { className: "studio-nav-section" });
    const navItems = [
      { icon: Icons.plus, label: "\u65B0\u5DE5\u4F5C\u4EFB\u52A1", action: () => {
        hide();
        globalEvents.emit("ui:new-task");
      } },
      { icon: Icons.clock, label: "\u5B9A\u65F6\u4EFB\u52A1", action: () => {
        hide();
        globalEvents.emit("ui:scheduled-tasks");
      } },
      { icon: Icons.puzzle, label: "\u63D2\u4EF6\xB7\u6280\u80FD\xB7\u4F19\u4F34", action: () => {
        hide();
        globalEvents.emit("ui:skills");
      } }
    ];
    for (const item of navItems) {
      const navItem = el("div", { className: "studio-nav-item" }, [
        icon(item.icon, 16),
        el("span", { text: item.label })
      ]);
      navItem.addEventListener("click", item.action);
      navSection.appendChild(navItem);
    }
    sidebar.appendChild(navSection);
    const projectsSection = el("div", { className: "studio-projects-section" });
    projectsSection.appendChild(el("div", { className: "studio-section-title", text: "\u9879\u76EE" }));
    const projectList = el("div", { className: "studio-project-list" });
    projectsSection.appendChild(projectList);
    const newProjectBtn = el("button", { className: "studio-new-project-btn" }, [
      icon(Icons.plus, 14),
      el("span", { text: "\u521B\u5EFA\u65B0\u9879\u76EE" })
    ]);
    newProjectBtn.addEventListener("click", () => {
      hide();
      globalEvents.emit("ui:new-project");
    });
    projectsSection.appendChild(newProjectBtn);
    sidebar.appendChild(projectsSection);
    const footer = el("div", { className: "studio-sidebar-footer" }, [
      el("div", { className: "studio-user-avatar", text: "U" }),
      el("div", { className: "studio-user-info" }, [
        el("div", { className: "studio-user-name", text: "\u7528\u6237" }),
        el("div", { className: "studio-user-plan", text: "Studio v1.0" })
      ])
    ]);
    const settingsBtn = el("button", { className: "studio-settings-btn" }, [icon(Icons.settings, 18)]);
    settingsBtn.addEventListener("click", () => {
      hide();
      globalEvents.emit("ui:settings");
    });
    footer.appendChild(settingsBtn);
    sidebar.appendChild(footer);
    shadow.appendChild(fab);
    shadow.appendChild(overlay);
    shadow.appendChild(sidebar);
    function show() {
      isOpen = true;
      sidebar.classList.add("visible");
      overlay.classList.add("visible");
    }
    function hide() {
      isOpen = false;
      sidebar.classList.remove("visible");
      overlay.classList.remove("visible");
    }
    function toggle() {
      if (isOpen) hide();
      else show();
    }
    fab.addEventListener("click", toggle);
    overlay.addEventListener("click", hide);
    closeBtn.addEventListener("click", hide);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen) hide();
    });
    function renderProjects(projects, currentId) {
      projectList.innerHTML = "";
      for (const p of projects) {
        const item = el("div", { className: `studio-project-item${p.id === currentId ? " active" : ""}` }, [
          icon(Icons.folder, 14),
          el("span", { className: "studio-project-name", text: p.name })
        ]);
        item.addEventListener("click", () => {
          globalState.currentProject = p.id;
          globalEvents.emit("ui:project-switched", p);
          renderProjects(projects, p.id);
          hide();
        });
        projectList.appendChild(item);
        if (p.path) {
          projectList.appendChild(el("div", { className: "studio-project-path", text: p.path }));
        }
      }
    }
    const defaultProjects = [
      { id: "deepseek-studio", name: "deepseek-studio", path: "E:\\NAS\\deepseek-studio" }
    ];
    renderProjects(defaultProjects, globalState.currentProject ?? "deepseek-studio");
    globalEvents.on("ui:projects-updated", (payload) => {
      const data = payload;
      renderProjects(data.projects, data.current);
    });
    return {
      container,
      show,
      hide,
      toggle
    };
  }

  // src/ui/studio-input-bar.ts
  var barStyles = `
  .studio-input-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 12px;
    color: #666;
    flex-wrap: nowrap;
    pointer-events: auto;
  }
  .studio-bar-item {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 14px;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
    border: 1px solid transparent;
  }
  .studio-bar-item:hover { background: #eef1ff; }
  .studio-bar-item.active { background: #e8edff; color: #4D6BFE; border-color: #c5d0ff; }
  .studio-bar-item svg { flex-shrink: 0; }
  .studio-bar-divider { width: 1px; height: 16px; background: #e0e0e0; margin: 0 2px; }
  .studio-bar-label { white-space: nowrap; }
  .studio-mode-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    padding: 4px;
    min-width: 140px;
    z-index: 100;
  }
  .studio-mode-option {
    padding: 8px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .studio-mode-option:hover { background: #f5f7ff; }
  .studio-mode-option.selected { color: #4D6BFE; font-weight: 500; }
`;
  function createInputBar() {
    const { container, shadow } = createShadowContainer("studio-input-bar-root");
    injectStyles(shadow, barStyles);
    const bar = el("div", { className: "studio-input-bar" });
    const localToggle = el("div", { className: "studio-bar-item active" }, [
      icon(Icons.cpu, 14),
      el("span", { className: "studio-bar-label", text: "\u672C\u5730\u7535\u8111" })
    ]);
    localToggle.addEventListener("click", () => {
      globalState.localToolsEnabled = !globalState.localToolsEnabled;
      localToggle.classList.toggle("active", globalState.localToolsEnabled);
      globalEvents.emit("ui:local-tools-toggled", globalState.localToolsEnabled);
    });
    bar.appendChild(localToggle);
    const projectBtn = el("div", { className: "studio-bar-item" }, [
      icon(Icons.folder, 14),
      el("span", { className: "studio-bar-label", text: globalState.currentProject ?? "\u9009\u62E9\u9879\u76EE" }),
      icon(Icons.chevronDown, 12)
    ]);
    projectBtn.addEventListener("click", () => globalEvents.emit("ui:project-picker"));
    bar.appendChild(projectBtn);
    bar.appendChild(el("div", { className: "studio-bar-divider" }));
    const modeLabels = { full: "\u5168\u90E8\u5141\u8BB8", auto: "\u81EA\u52A8\u5BA1\u6279", ask: "\u6BCF\u6B21\u8BE2\u95EE" };
    const modeBtn = el("div", { className: "studio-bar-item", style: { position: "relative" } }, [
      icon(Icons.check, 14),
      el("span", { className: "studio-bar-label", text: modeLabels[globalState.policyMode] ?? "\u5168\u90E8\u5141\u8BB8" }),
      icon(Icons.chevronDown, 12)
    ]);
    const modeDropdown = el("div", { className: "studio-mode-dropdown", style: { display: "none" } });
    for (const [mode, label] of Object.entries(modeLabels)) {
      const option = el("div", { className: `studio-mode-option${mode === globalState.policyMode ? " selected" : ""}` }, [
        mode === globalState.policyMode ? icon(Icons.check, 12) : el("span", { style: { width: "12px", display: "inline-block" } }),
        el("span", { text: label })
      ]);
      option.addEventListener("click", () => {
        globalState.policyMode = mode;
        modeBtn.querySelector(".studio-bar-label").textContent = label;
        modeDropdown.style.display = "none";
        globalEvents.emit("ui:policy-changed", mode);
        modeDropdown.querySelectorAll(".studio-mode-option").forEach((o) => o.classList.remove("selected"));
        option.classList.add("selected");
      });
      modeDropdown.appendChild(option);
    }
    modeBtn.appendChild(modeDropdown);
    modeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = modeDropdown.style.display !== "none";
      modeDropdown.style.display = isVisible ? "none" : "block";
    });
    document.addEventListener("click", () => {
      modeDropdown.style.display = "none";
    });
    bar.appendChild(modeBtn);
    bar.appendChild(el("div", { className: "studio-bar-divider" }));
    const skillsBtn = el("div", { className: "studio-bar-item" }, [
      icon(Icons.book, 14),
      el("span", { className: "studio-bar-label", text: "\u6280\u80FD" })
    ]);
    skillsBtn.addEventListener("click", () => globalEvents.emit("ui:skills-panel"));
    bar.appendChild(skillsBtn);
    const pluginsBtn = el("div", { className: "studio-bar-item" }, [
      icon(Icons.puzzle, 14),
      el("span", { className: "studio-bar-label", text: "\u63D2\u4EF6" })
    ]);
    pluginsBtn.addEventListener("click", () => globalEvents.emit("ui:plugins"));
    bar.appendChild(pluginsBtn);
    shadow.appendChild(bar);
    globalEvents.on("ui:project-switched", (payload) => {
      const p = payload;
      projectBtn.querySelector(".studio-bar-label").textContent = p.name;
    });
    return { container };
  }

  // src/ui/studio-settings-panel.ts
  var panelStyles = `
  .studio-settings-modal { width: 640px; }
  .studio-settings-tabs { display: flex; gap: 2px; border-bottom: 1px solid #f0f0f0; margin-bottom: 20px; }
  .studio-settings-tab {
    padding: 10px 16px; border: none; background: transparent; cursor: pointer;
    font-size: 13px; color: #666; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .studio-settings-tab.active { color: #4D6BFE; border-bottom-color: #4D6BFE; font-weight: 500; }
  .studio-tab-content { display: none; }
  .studio-tab-content.active { display: block; }
  .studio-info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f5f5f5; font-size: 13px; }
  .studio-info-label { color: #888; }
  .studio-info-value { color: #333; font-family: monospace; font-size: 12px; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
  .studio-workspace-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .studio-workspace-input { flex: 1; }
  .studio-policy-options { display: flex; flex-direction: column; gap: 8px; }
  .studio-policy-option {
    display: flex; align-items: flex-start; gap: 10px; padding: 12px;
    border: 1px solid #e8e8e8; border-radius: 8px; cursor: pointer; transition: all 0.15s;
  }
  .studio-policy-option:hover { border-color: #c5d0ff; background: #f8f9ff; }
  .studio-policy-option.selected { border-color: #4D6BFE; background: #f0f3ff; }
  .studio-policy-radio { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #ccc; margin-top: 1px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .studio-policy-option.selected .studio-policy-radio { border-color: #4D6BFE; }
  .studio-policy-option.selected .studio-policy-radio::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #4D6BFE; }
  .studio-policy-title { font-weight: 500; font-size: 13px; color: #333; margin-bottom: 2px; }
  .studio-policy-desc { font-size: 12px; color: #888; }
  .studio-mcp-server-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 8px;
  }
  .studio-mcp-server-info { flex: 1; min-width: 0; }
  .studio-mcp-server-name { font-weight: 500; font-size: 13px; color: #333; }
  .studio-mcp-server-cmd { font-size: 11px; color: #999; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-mcp-server-actions { display: flex; gap: 4px; }
  .studio-mcp-add-btn { width: 100%; padding: 10px; border: 1px dashed #d0d0d0; border-radius: 8px; background: transparent; cursor: pointer; color: #888; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .studio-mcp-add-btn:hover { border-color: #4D6BFE; color: #4D6BFE; }
  .studio-memory-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px; border-bottom: 1px solid #f5f5f5; }
  .studio-memory-type { flex-shrink: 0; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .studio-memory-type.user { background: #e3f2fd; color: #1565c0; }
  .studio-memory-type.project { background: #f3e5f5; color: #7b1fa2; }
  .studio-memory-content { flex: 1; min-width: 0; }
  .studio-memory-name { font-size: 13px; font-weight: 500; color: #333; margin-bottom: 2px; }
  .studio-memory-text { font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .studio-empty-state { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;
  function createSettingsPanel() {
    const { container, shadow } = createShadowContainer("studio-settings-root");
    injectStyles(shadow, panelStyles);
    let isOpen = false;
    const overlay = el("div", { className: "studio-modal-overlay", style: { display: "none" } });
    const modal = el("div", { className: "studio-modal studio-settings-modal" });
    const header = el("div", { className: "studio-modal-header" }, [
      el("h2", { className: "studio-modal-title", text: "Studio \u8BBE\u7F6E" })
    ]);
    const closeBtn = el("button", { className: "studio-close-btn" }, [icon(Icons.x, 18)]);
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    modal.appendChild(header);
    const body = el("div", { className: "studio-modal-body" });
    const tabs = el("div", { className: "studio-settings-tabs" });
    const tabDefs = [
      { id: "general", label: "\u901A\u7528" },
      { id: "workspace", label: "\u5DE5\u4F5C\u533A" },
      { id: "policy", label: "\u7B56\u7565" },
      { id: "mcp", label: "MCP" },
      { id: "skills", label: "\u6280\u80FD" },
      { id: "memory", label: "\u8BB0\u5FC6" },
      { id: "leverhub", label: "\u6295\u5582" }
    ];
    const tabContents = {};
    for (const tabDef of tabDefs) {
      const tabBtn = el("button", { className: `studio-settings-tab${tabDef.id === "general" ? " active" : ""}`, text: tabDef.label });
      tabBtn.addEventListener("click", () => {
        tabs.querySelectorAll(".studio-settings-tab").forEach((t) => t.classList.remove("active"));
        tabBtn.classList.add("active");
        Object.values(tabContents).forEach((c) => c.classList.remove("active"));
        tabContents[tabDef.id].classList.add("active");
      });
      tabs.appendChild(tabBtn);
    }
    body.appendChild(tabs);
    const generalTab = el("div", { className: "studio-tab-content active" });
    generalTab.innerHTML = `
    <div class="studio-info-row"><span class="studio-info-label">\u7248\u672C</span><span class="studio-info-value">v1.0.0</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u65E5\u5FD7\u8DEF\u5F84</span><span class="studio-info-value">E:\\NAS\\deepseek-studio\\tauri-real.log</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u914D\u7F6E\u8DEF\u5F84</span><span class="studio-info-value">~/.config/deepseek-studio/</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u5BBF\u4E3B\u7AEF\u53E3</span><span class="studio-info-value">8760</span></div>
  `;
    tabContents["general"] = generalTab;
    body.appendChild(generalTab);
    const workspaceTab = el("div", { className: "studio-tab-content" });
    const workspaceRow = el("div", { className: "studio-workspace-row" });
    const workspaceInput = el("input", { className: "studio-input studio-workspace-input", attrs: { value: globalState.workspaceRoot ?? "E:\\", placeholder: "\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\u8DEF\u5F84" } });
    const workspaceSaveBtn = el("button", { className: "studio-btn primary sm", text: "\u4FDD\u5B58" });
    workspaceSaveBtn.addEventListener("click", async () => {
      const result2 = await callHostTool("workspace.set", { root: workspaceInput.value });
      if (result2.ok) {
        globalState.workspaceRoot = workspaceInput.value;
        workspaceSaveBtn.textContent = "\u5DF2\u4FDD\u5B58";
        setTimeout(() => {
          workspaceSaveBtn.textContent = "\u4FDD\u5B58";
        }, 1500);
      }
    });
    workspaceRow.appendChild(workspaceInput);
    workspaceRow.appendChild(workspaceSaveBtn);
    workspaceTab.appendChild(workspaceRow);
    workspaceTab.appendChild(el("p", { className: "studio-form-hint", text: "\u5DE5\u4F5C\u533A\u662F\u5DE5\u5177\u64CD\u4F5C\u7684\u6839\u76EE\u5F55\u3002\u6587\u4EF6\u8BFB\u5199\u548C\u547D\u4EE4\u6267\u884C\u9ED8\u8BA4\u9650\u5236\u5728\u6B64\u76EE\u5F55\u5185\u3002" }));
    tabContents["workspace"] = workspaceTab;
    body.appendChild(workspaceTab);
    const policyTab = el("div", { className: "studio-tab-content" });
    const policyOptions = el("div", { className: "studio-policy-options" });
    const policyDefs = [
      { id: "full", title: "\u5168\u90E8\u5141\u8BB8", desc: "\u6240\u6709\u5DE5\u5177\u8C03\u7528\u81EA\u52A8\u6267\u884C\uFF0C\u65E0\u9700\u786E\u8BA4\u3002\u9002\u5408\u4FE1\u4EFB\u7684\u73AF\u5883\u3002" },
      { id: "auto", title: "\u81EA\u52A8\u5BA1\u6279", desc: "\u4F4E\u98CE\u9669\u64CD\u4F5C\u81EA\u52A8\u6267\u884C\uFF0C\u9AD8\u98CE\u9669\u64CD\u4F5C\u9700\u8981\u786E\u8BA4\u3002" },
      { id: "ask", title: "\u6BCF\u6B21\u8BE2\u95EE", desc: "\u6240\u6709\u5DE5\u5177\u8C03\u7528\u90FD\u9700\u8981\u624B\u52A8\u786E\u8BA4\u3002\u6700\u5B89\u5168\u4F46\u6700\u7E41\u7410\u3002" }
    ];
    for (const pDef of policyDefs) {
      const option = el("div", { className: `studio-policy-option${pDef.id === globalState.policyMode ? " selected" : ""}` });
      option.innerHTML = `<div class="studio-policy-radio"></div><div><div class="studio-policy-title">${pDef.title}</div><div class="studio-policy-desc">${pDef.desc}</div></div>`;
      option.addEventListener("click", async () => {
        policyOptions.querySelectorAll(".studio-policy-option").forEach((o) => o.classList.remove("selected"));
        option.classList.add("selected");
        globalState.policyMode = pDef.id;
        await callHostTool("policy.set", { mode: pDef.id });
      });
      policyOptions.appendChild(option);
    }
    policyTab.appendChild(policyOptions);
    tabContents["policy"] = policyTab;
    body.appendChild(policyTab);
    const mcpTab = el("div", { className: "studio-tab-content" });
    const mcpServerList = el("div", { className: "studio-mcp-server-list" });
    const mcpAddBtn = el("button", { className: "studio-mcp-add-btn" }, [icon(Icons.plus, 16), el("span", { text: "\u6DFB\u52A0 MCP \u670D\u52A1\u5668" })]);
    mcpAddBtn.addEventListener("click", () => globalEvents.emit("ui:mcp-add"));
    mcpTab.appendChild(mcpServerList);
    mcpTab.appendChild(mcpAddBtn);
    function renderMcpServers() {
      mcpServerList.innerHTML = "";
      if (globalState.mcpServers.length === 0) {
        mcpServerList.appendChild(el("div", { className: "studio-empty-state", text: "\u6682\u65E0\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668" }));
        return;
      }
      for (const serverId of globalState.mcpServers) {
        const item = el("div", { className: "studio-mcp-server-item" });
        item.innerHTML = `
        <div class="studio-mcp-server-info">
          <div class="studio-mcp-server-name">${serverId}</div>
          <div class="studio-mcp-server-cmd">stdio</div>
        </div>
        <div class="studio-mcp-server-actions"></div>
      `;
        const actions = item.querySelector(".studio-mcp-server-actions");
        const editBtn = el("button", { className: "studio-btn sm" }, [icon(Icons.edit, 12)]);
        editBtn.addEventListener("click", () => globalEvents.emit("ui:mcp-edit", serverId));
        const delBtn = el("button", { className: "studio-btn sm danger" }, [icon(Icons.trash, 12)]);
        delBtn.addEventListener("click", async () => {
          await callHostTool("mcp.remove", { serverId });
          globalState.mcpServers = globalState.mcpServers.filter((s) => s !== serverId);
          renderMcpServers();
        });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        mcpServerList.appendChild(item);
      }
    }
    renderMcpServers();
    tabContents["mcp"] = mcpTab;
    body.appendChild(mcpTab);
    const skillsTab = el("div", { className: "studio-tab-content" });
    const skillsDirRow = el("div", { className: "studio-workspace-row" });
    const skillsDirInput = el("input", { className: "studio-input studio-workspace-input", attrs: { value: "~/.config/deepseek-studio/skills/", placeholder: "\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84" } });
    const skillsScanBtn = el("button", { className: "studio-btn primary sm", text: "\u626B\u63CF" });
    skillsScanBtn.addEventListener("click", async () => {
      const result2 = await callHostTool("skill.list", {});
      if (result2.ok && result2.data) {
        const skills = result2.data.skills;
        globalState.skills = skills;
        renderSkillsList();
      }
    });
    skillsDirRow.appendChild(skillsDirInput);
    skillsDirRow.appendChild(skillsScanBtn);
    skillsTab.appendChild(skillsDirRow);
    const skillsList = el("div", { className: "studio-skills-list" });
    skillsTab.appendChild(skillsList);
    function renderSkillsList() {
      skillsList.innerHTML = "";
      if (globalState.skills.length === 0) {
        skillsList.appendChild(el("div", { className: "studio-empty-state", text: "\u6682\u65E0\u6280\u80FD\uFF0C\u70B9\u51FB\u626B\u63CF\u6309\u94AE\u626B\u63CF\u6280\u80FD\u76EE\u5F55" }));
        return;
      }
      for (const skill of globalState.skills) {
        const item = el("div", { className: "studio-mcp-server-item" });
        item.innerHTML = `
        <div class="studio-mcp-server-info">
          <div class="studio-mcp-server-name">${skill.name}</div>
          <div class="studio-mcp-server-cmd">${skill.description}</div>
        </div>
      `;
        skillsList.appendChild(item);
      }
    }
    renderSkillsList();
    tabContents["skills"] = skillsTab;
    body.appendChild(skillsTab);
    const memoryTab = el("div", { className: "studio-tab-content" });
    const memoryList = el("div", { className: "studio-memory-list" });
    memoryTab.appendChild(memoryList);
    function renderMemories() {
      memoryList.innerHTML = "";
      if (globalState.memories.length === 0) {
        memoryList.appendChild(el("div", { className: "studio-empty-state", text: "\u6682\u65E0\u4FDD\u5B58\u7684\u8BB0\u5FC6" }));
        return;
      }
      for (const mem of globalState.memories) {
        const item = el("div", { className: "studio-memory-item" });
        item.innerHTML = `
        <span class="studio-memory-type ${mem.type}">${mem.type}</span>
        <div class="studio-memory-content">
          <div class="studio-memory-name">${mem.name}</div>
          <div class="studio-memory-text">${mem.content}</div>
        </div>
      `;
        const delBtn = el("button", { className: "studio-btn sm danger" }, [icon(Icons.trash, 12)]);
        delBtn.addEventListener("click", async () => {
          await callHostTool("memory.delete", { id: mem.id });
          globalState.memories = globalState.memories.filter((m) => m.id !== mem.id);
          renderMemories();
        });
        item.appendChild(delBtn);
        memoryList.appendChild(item);
      }
    }
    renderMemories();
    tabContents["memory"] = memoryTab;
    body.appendChild(memoryTab);
    const leverTab = el("div", { className: "studio-tab-content" });
    leverTab.innerHTML = `
    <div class="studio-info-row"><span class="studio-info-label">\u670D\u52A1</span><span class="studio-info-value">http://127.0.0.1:8762</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u72B6\u6001</span><span class="studio-info-value" id="lh-status">\u68C0\u6D4B\u4E2D\u2026</span></div>
  `;
    const lhAppList = el("div", { className: "studio-memory-list", attrs: { style: "max-height:240px;overflow:auto;margin:12px 0" } });
    leverTab.appendChild(lhAppList);
    const lhRefresh = el("button", { className: "studio-btn sm", text: "\u5237\u65B0\u7533\u8BF7\u5355" });
    leverTab.appendChild(lhRefresh);
    async function loadLeverHub() {
      try {
        const h2 = await fetch("http://127.0.0.1:8762/healthz").then((r) => r.json());
        leverTab.querySelector("#lh-status").textContent = h2.ok ? "\u8FD0\u884C\u4E2D" : "\u5F02\u5E38";
        const data = await fetch("http://127.0.0.1:8762/v1/applications").then((r) => r.json());
        lhAppList.innerHTML = "";
        for (const app of data.applications.slice(0, 20)) {
          const row = el("div", { className: "studio-memory-item" });
          row.innerHTML = `<div class="studio-memory-content"><div class="studio-memory-name">${app.name}</div><div class="studio-memory-text">${Math.round(app.size / 10) / 100} KB</div></div>`;
          lhAppList.appendChild(row);
        }
      } catch {
        leverTab.querySelector("#lh-status").textContent = "\u672A\u542F\u52A8";
      }
    }
    lhRefresh.addEventListener("click", () => void loadLeverHub());
    tabContents["leverhub"] = leverTab;
    body.appendChild(leverTab);
    modal.appendChild(body);
    const footer = el("div", { className: "studio-modal-footer" });
    const doneBtn = el("button", { className: "studio-btn primary", text: "\u5B8C\u6210" });
    doneBtn.addEventListener("click", close);
    footer.appendChild(doneBtn);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    shadow.appendChild(overlay);
    function open() {
      isOpen = true;
      overlay.style.display = "flex";
      renderMcpServers();
      renderSkillsList();
      renderMemories();
      void loadLeverHub();
    }
    function close() {
      isOpen = false;
      overlay.style.display = "none";
    }
    globalEvents.on("ui:settings", () => {
      isOpen ? close() : open();
    });
    return { container, open, close };
  }

  // src/ui/studio-project-picker.ts
  var pickerStyles = `
  .studio-picker-modal { width: 520px; }
  .studio-picker-mode-toggle {
    display: flex; justify-content: center; gap: 0; margin-bottom: 20px;
  }
  .studio-picker-mode-btn {
    padding: 8px 24px; border: 1px solid #e0e0e0; background: #fff;
    cursor: pointer; font-size: 14px; color: #666; transition: all 0.15s;
  }
  .studio-picker-mode-btn:first-child { border-radius: 8px 0 0 8px; }
  .studio-picker-mode-btn:last-child { border-radius: 0 8px 8px 0; border-left: none; }
  .studio-picker-mode-btn.active { background: #4D6BFE; color: #fff; border-color: #4D6BFE; font-weight: 500; }
  .studio-picker-search { margin-bottom: 12px; position: relative; }
  .studio-picker-search input { padding-left: 36px; }
  .studio-picker-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #aaa; }
  .studio-picker-list { max-height: 300px; overflow-y: auto; margin-bottom: 12px; }
  .studio-picker-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-radius: 8px; cursor: pointer; transition: all 0.15s; margin-bottom: 4px;
  }
  .studio-picker-item:hover { background: #f5f7ff; }
  .studio-picker-item.active { background: #eef1ff; }
  .studio-picker-item-icon { flex-shrink: 0; color: #4D6BFE; }
  .studio-picker-item-info { flex: 1; min-width: 0; }
  .studio-picker-item-name { font-size: 14px; font-weight: 500; color: #333; }
  .studio-picker-item-path { font-size: 11px; color: #999; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-picker-item-check { color: #4D6BFE; flex-shrink: 0; }
  .studio-picker-actions { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #f0f0f0; padding-top: 12px; }
  .studio-picker-action-btn {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: none; background: transparent; cursor: pointer; border-radius: 8px;
    font-size: 13px; color: #555; transition: all 0.15s; text-align: left;
  }
  .studio-picker-action-btn:hover { background: #f5f7ff; color: #4D6BFE; }
  .studio-picker-empty { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;
  function createProjectPicker() {
    const { container, shadow } = createShadowContainer("studio-project-picker-root");
    injectStyles(shadow, pickerStyles);
    let isOpen = false;
    let searchQuery = "";
    const overlay = el("div", { className: "studio-modal-overlay", style: { display: "none" } });
    const modal = el("div", { className: "studio-modal studio-picker-modal" });
    const header = el("div", { className: "studio-modal-header" }, [
      el("h2", { className: "studio-modal-title", text: "\u9009\u62E9\u9879\u76EE" })
    ]);
    const closeBtn = el("button", { className: "studio-close-btn" }, [icon(Icons.x, 18)]);
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    modal.appendChild(header);
    const body = el("div", { className: "studio-modal-body" });
    const modeToggle = el("div", { className: "studio-picker-mode-toggle" });
    const chatBtn = el("button", { className: "studio-picker-mode-btn", text: "\u5BF9\u8BDD" });
    const workBtn = el("button", { className: "studio-picker-mode-btn active", text: "\u5DE5\u4F5C" });
    chatBtn.addEventListener("click", () => {
      chatBtn.classList.add("active");
      workBtn.classList.remove("active");
    });
    workBtn.addEventListener("click", () => {
      workBtn.classList.add("active");
      chatBtn.classList.remove("active");
    });
    modeToggle.appendChild(chatBtn);
    modeToggle.appendChild(workBtn);
    body.appendChild(modeToggle);
    const searchBox = el("div", { className: "studio-picker-search" });
    const searchIcon = el("span", { className: "studio-picker-search-icon" });
    searchIcon.appendChild(icon(Icons.search, 16));
    const searchInput = el("input", { className: "studio-input", attrs: { placeholder: "\u641C\u7D22\u9879\u76EE..." } });
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderProjectList();
    });
    searchBox.appendChild(searchIcon);
    searchBox.appendChild(searchInput);
    body.appendChild(searchBox);
    const projectList = el("div", { className: "studio-picker-list" });
    body.appendChild(projectList);
    const actions = el("div", { className: "studio-picker-actions" });
    const newProjectBtn = el("button", { className: "studio-picker-action-btn" }, [
      icon(Icons.plus, 16),
      el("span", { text: "\u521B\u5EFA\u65B0\u9879\u76EE" })
    ]);
    newProjectBtn.addEventListener("click", () => {
      close();
      globalEvents.emit("ui:new-project");
    });
    const fromFolderBtn = el("button", { className: "studio-picker-action-btn" }, [
      icon(Icons.folder, 16),
      el("span", { text: "\u901A\u8FC7\u672C\u5730\u6587\u4EF6\u5939\u521B\u5EFA\u9879\u76EE" })
    ]);
    fromFolderBtn.addEventListener("click", async () => {
      const result2 = await callHostTool("folder.pick", {});
      if (result2.ok && result2.data) {
        const folderPath = result2.data.path;
        const name = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? "\u65B0\u9879\u76EE";
        await callHostTool("project.create", { name, path: folderPath });
        globalEvents.emit("ui:project-created", { id: name, name, path: folderPath });
        close();
      }
    });
    actions.appendChild(newProjectBtn);
    actions.appendChild(fromFolderBtn);
    body.appendChild(actions);
    modal.appendChild(body);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    shadow.appendChild(overlay);
    let projects = [
      { id: "deepseek-studio", name: "deepseek-studio", path: "E:\\NAS\\deepseek-studio" }
    ];
    async function loadProjects() {
      try {
        const result2 = await callHostTool("project.list", {});
        if (result2.ok && result2.data) {
          projects = result2.data.projects;
        }
      } catch {
      }
      renderProjectList();
    }
    function renderProjectList() {
      projectList.innerHTML = "";
      const filtered = projects.filter(
        (p) => !searchQuery || p.name.toLowerCase().includes(searchQuery) || p.path.toLowerCase().includes(searchQuery)
      );
      if (filtered.length === 0) {
        projectList.appendChild(el("div", { className: "studio-picker-empty", text: searchQuery ? "\u6CA1\u6709\u5339\u914D\u7684\u9879\u76EE" : "\u6682\u65E0\u9879\u76EE" }));
        return;
      }
      for (const p of filtered) {
        const isActive = p.id === globalState.currentProject;
        const item = el("div", { className: `studio-picker-item${isActive ? " active" : ""}` });
        item.innerHTML = `
        <span class="studio-picker-item-icon"></span>
        <div class="studio-picker-item-info">
          <div class="studio-picker-item-name">${p.name}</div>
          <div class="studio-picker-item-path">${p.path}</div>
        </div>
      `;
        item.querySelector(".studio-picker-item-icon").appendChild(icon(Icons.folder, 18));
        if (isActive) {
          const check = el("span", { className: "studio-picker-item-check" });
          check.appendChild(icon(Icons.check, 16));
          item.appendChild(check);
        }
        item.addEventListener("click", () => {
          globalState.currentProject = p.id;
          globalEvents.emit("ui:project-switched", p);
          close();
        });
        projectList.appendChild(item);
      }
    }
    function open() {
      isOpen = true;
      overlay.style.display = "flex";
      searchQuery = "";
      searchInput.value = "";
      loadProjects();
    }
    function close() {
      isOpen = false;
      overlay.style.display = "none";
    }
    globalEvents.on("ui:project-picker", () => {
      isOpen ? close() : open();
    });
    globalEvents.on("ui:new-project", () => {
      isOpen ? close() : open();
    });
    return { container, open, close };
  }

  // src/ui/studio-skills-panel.ts
  var panelStyles2 = `
  .studio-skills-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.3);
    z-index: 2147483500; display: none;
  }
  .studio-skills-panel {
    position: fixed; top: 0; right: 0; width: 420px; height: 100vh;
    background: #fff; box-shadow: -4px 0 20px rgba(0,0,0,0.1);
    z-index: 2147483501; display: flex; flex-direction: column;
    transform: translateX(100%); transition: transform 0.25s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .studio-skills-panel.open { transform: translateX(0); }
  .studio-skills-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid #f0f0f0;
  }
  .studio-skills-title { font-size: 16px; font-weight: 600; color: #1a1a2e; margin: 0; }
  .studio-skills-body { flex: 1; overflow-y: auto; padding: 12px; }
  .studio-skills-search { margin-bottom: 12px; position: relative; }
  .studio-skills-search input { padding-left: 36px; }
  .studio-skills-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #aaa; }
  .studio-skill-card {
    border: 1px solid #e8e8e8; border-radius: 10px; margin-bottom: 8px;
    overflow: hidden; transition: all 0.15s;
  }
  .studio-skill-card:hover { border-color: #c5d0ff; }
  .studio-skill-card.expanded { border-color: #4D6BFE; }
  .studio-skill-header {
    display: flex; align-items: center; gap: 10px; padding: 12px; cursor: pointer;
  }
  .studio-skill-icon {
    width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;
  }
  .studio-skill-info { flex: 1; min-width: 0; }
  .studio-skill-name { font-size: 14px; font-weight: 500; color: #333; }
  .studio-skill-desc { font-size: 12px; color: #888; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-skill-toggle { flex-shrink: 0; }
  .studio-skill-detail {
    display: none; padding: 0 12px 12px; border-top: 1px solid #f0f0f0;
  }
  .studio-skill-card.expanded .studio-skill-detail { display: block; }
  .studio-skill-detail-content {
    margin-top: 12px; padding: 12px; background: #f8f9fc; border-radius: 8px;
    font-size: 12px; color: #555; line-height: 1.6; max-height: 200px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
  }
  .studio-skill-detail-actions { display: flex; gap: 8px; margin-top: 12px; }
  .studio-skills-footer {
    padding: 12px 20px; border-top: 1px solid #f0f0f0; display: flex; gap: 8px;
  }
  .studio-skills-footer .studio-btn { flex: 1; justify-content: center; }
  .studio-empty-state { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;
  function createSkillsPanel() {
    const { container, shadow } = createShadowContainer("studio-skills-panel-root");
    injectStyles(shadow, panelStyles2);
    let isOpen = false;
    let expandedSkillId = null;
    let searchQuery = "";
    const overlay = el("div", { className: "studio-skills-overlay" });
    const panel = el("div", { className: "studio-skills-panel" });
    const header = el("div", { className: "studio-skills-header" }, [
      el("h2", { className: "studio-skills-title", text: "\u6280\u80FD\u7BA1\u7406" })
    ]);
    const closeBtn = el("button", { className: "studio-close-btn" }, [icon(Icons.x, 18)]);
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = el("div", { className: "studio-skills-body" });
    const searchBox = el("div", { className: "studio-skills-search" });
    const searchIcon = el("span", { className: "studio-skills-search-icon" });
    searchIcon.appendChild(icon(Icons.search, 16));
    const searchInput = el("input", { className: "studio-input", attrs: { placeholder: "\u641C\u7D22\u6280\u80FD..." } });
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderSkills();
    });
    searchBox.appendChild(searchIcon);
    searchBox.appendChild(searchInput);
    body.appendChild(searchBox);
    const skillList = el("div", { className: "studio-skill-list" });
    body.appendChild(skillList);
    panel.appendChild(body);
    const footer = el("div", { className: "studio-skills-footer" });
    const refreshBtn = el("button", { className: "studio-btn" }, [icon(Icons.refresh, 14), el("span", { text: "\u5237\u65B0" })]);
    refreshBtn.addEventListener("click", loadSkills);
    const openDirBtn = el("button", { className: "studio-btn" }, [icon(Icons.folder, 14), el("span", { text: "\u6253\u5F00\u76EE\u5F55" })]);
    openDirBtn.addEventListener("click", async () => {
      await callHostTool("shell.exec", { command: 'explorer "%USERPROFILE%\\.config\\deepseek-studio\\skills"' });
    });
    footer.appendChild(refreshBtn);
    footer.appendChild(openDirBtn);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    shadow.appendChild(overlay);
    let skills = [];
    async function loadSkills() {
      try {
        const result2 = await callHostTool("skill.list", {});
        if (result2.ok && result2.data) {
          const list = result2.data.skills;
          skills = list.map((s) => ({ ...s, enabled: true }));
          globalState.skills = list;
        }
      } catch {
      }
      renderSkills();
    }
    async function loadSkillContent(skillId) {
      const skill = skills.find((s) => s.id === skillId);
      if (!skill) return "";
      if (skill.content) return skill.content;
      try {
        const result2 = await callHostTool("file.read", { path: skill.skillMdPath });
        if (result2.ok && result2.data) {
          skill.content = result2.data.content;
          return skill.content;
        }
      } catch {
      }
      return "\uFF08\u65E0\u6CD5\u52A0\u8F7D SKILL.md \u5185\u5BB9\uFF09";
    }
    function renderSkills() {
      skillList.innerHTML = "";
      const filtered = skills.filter(
        (s) => !searchQuery || s.name.toLowerCase().includes(searchQuery) || s.description.toLowerCase().includes(searchQuery)
      );
      if (filtered.length === 0) {
        skillList.appendChild(el("div", { className: "studio-empty-state", text: searchQuery ? "\u6CA1\u6709\u5339\u914D\u7684\u6280\u80FD" : "\u6682\u65E0\u6280\u80FD\uFF0C\u8BF7\u5728\u6280\u80FD\u76EE\u5F55\u4E2D\u6DFB\u52A0" }));
        return;
      }
      for (const skill of filtered) {
        const isExpanded = expandedSkillId === skill.id;
        const card = el("div", { className: `studio-skill-card${isExpanded ? " expanded" : ""}` });
        const cardHeader = el("div", { className: "studio-skill-header" });
        const skillIcon = el("div", { className: "studio-skill-icon" });
        skillIcon.appendChild(icon(Icons.book, 18));
        const skillInfo = el("div", { className: "studio-skill-info" });
        skillInfo.innerHTML = `<div class="studio-skill-name">${skill.name}</div><div class="studio-skill-desc">${skill.description}</div>`;
        const toggle = el("div", { className: `studio-switch${skill.enabled ? " on" : ""}` });
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          skill.enabled = !skill.enabled;
          toggle.classList.toggle("on", skill.enabled);
        });
        cardHeader.appendChild(skillIcon);
        cardHeader.appendChild(skillInfo);
        cardHeader.appendChild(toggle);
        cardHeader.addEventListener("click", async () => {
          expandedSkillId = isExpanded ? null : skill.id;
          renderSkills();
          if (!isExpanded) {
            await loadSkillContent(skill.id);
            const detailEl = card.querySelector(".studio-skill-detail-content");
            if (detailEl) detailEl.textContent = skill.content ?? "\u52A0\u8F7D\u4E2D...";
          }
        });
        card.appendChild(cardHeader);
        const detail = el("div", { className: "studio-skill-detail" });
        const detailContent = el("div", { className: "studio-skill-detail-content", text: isExpanded ? skill.content ?? "\u52A0\u8F7D\u4E2D..." : "" });
        detail.appendChild(detailContent);
        const detailActions = el("div", { className: "studio-skill-detail-actions" });
        const readFullBtn = el("button", { className: "studio-btn sm", text: "\u8BFB\u53D6\u5B8C\u6574\u5185\u5BB9" });
        readFullBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const content = await loadSkillContent(skill.id);
          detailContent.textContent = content;
        });
        detailActions.appendChild(readFullBtn);
        detail.appendChild(detailActions);
        card.appendChild(detail);
        skillList.appendChild(card);
      }
    }
    function open() {
      isOpen = true;
      overlay.style.display = "block";
      requestAnimationFrame(() => panel.classList.add("open"));
      searchQuery = "";
      searchInput.value = "";
      expandedSkillId = null;
      loadSkills();
    }
    function close() {
      isOpen = false;
      panel.classList.remove("open");
      setTimeout(() => {
        overlay.style.display = "none";
      }, 250);
    }
    globalEvents.on("ui:skills-panel", () => {
      isOpen ? close() : open();
    });
    globalEvents.on("ui:skills", () => {
      isOpen ? close() : open();
    });
    return { container, open, close };
  }

  // src/ui/studio-mcp-dialog.ts
  var dialogStyles = `
  .studio-mcp-dialog { width: 560px; }
  .studio-mcp-form { display: flex; flex-direction: column; gap: 16px; }
  .studio-mcp-row { display: flex; gap: 12px; }
  .studio-mcp-row .studio-form-group { flex: 1; }
  .studio-kv-list { display: flex; flex-direction: column; gap: 6px; }
  .studio-kv-row { display: flex; gap: 8px; align-items: center; }
  .studio-kv-row .studio-input { flex: 1; }
  .studio-kv-remove {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    border: 1px solid #e0e0e0; border-radius: 4px; background: #fff; cursor: pointer;
    color: #999; flex-shrink: 0; transition: all 0.15s;
  }
  .studio-kv-remove:hover { color: #e53935; border-color: #ffcdd2; background: #ffebee; }
  .studio-kv-add {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px;
    border: 1px dashed #d0d0d0; border-radius: 6px; background: transparent;
    cursor: pointer; color: #888; font-size: 12px; transition: all 0.15s;
  }
  .studio-kv-add:hover { border-color: #4D6BFE; color: #4D6BFE; }
  .studio-mcp-test-result {
    padding: 10px 12px; border-radius: 6px; font-size: 12px; margin-top: 8px;
    display: none;
  }
  .studio-mcp-test-result.success { display: block; background: #e8f5e9; color: #2e7d32; }
  .studio-mcp-test-result.error { display: block; background: #ffebee; color: #c62828; }
  .studio-mcp-test-result.loading { display: block; background: #e3f2fd; color: #1565c0; }
`;
  function createMcpConfigDialog() {
    const { container, shadow } = createShadowContainer("studio-mcp-dialog-root");
    injectStyles(shadow, dialogStyles);
    let editingServerId = null;
    let transportType = "stdio";
    const overlay = el("div", { className: "studio-modal-overlay", style: { display: "none" } });
    const modal = el("div", { className: "studio-modal studio-mcp-dialog" });
    const header = el("div", { className: "studio-modal-header" }, [
      el("h2", { className: "studio-modal-title", text: "\u6DFB\u52A0 MCP \u670D\u52A1\u5668" })
    ]);
    const closeBtn = el("button", { className: "studio-close-btn" }, [icon(Icons.x, 18)]);
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    modal.appendChild(header);
    const body = el("div", { className: "studio-modal-body" });
    const form = el("div", { className: "studio-mcp-form" });
    const nameGroup = el("div", { className: "studio-form-group" });
    nameGroup.appendChild(el("label", { className: "studio-form-label", text: "\u670D\u52A1\u5668\u540D\u79F0 *" }));
    const nameInput = el("input", { className: "studio-input", attrs: { placeholder: "\u5982\uFF1Afilesystem\u3001github" } });
    nameGroup.appendChild(nameInput);
    form.appendChild(nameGroup);
    const transportGroup = el("div", { className: "studio-form-group" });
    transportGroup.appendChild(el("label", { className: "studio-form-label", text: "\u4F20\u8F93\u7C7B\u578B" }));
    const transportSelect = el("select", { className: "studio-input" });
    for (const [value, label] of [["stdio", "stdio\uFF08\u672C\u5730\u8FDB\u7A0B\uFF09"], ["http", "HTTP"], ["sse", "SSE"]]) {
      const option = el("option", { attrs: { value }, text: label });
      transportSelect.appendChild(option);
    }
    transportSelect.addEventListener("change", () => {
      transportType = transportSelect.value;
      updateTransportFields();
    });
    transportGroup.appendChild(transportSelect);
    form.appendChild(transportGroup);
    const stdioFields = el("div", { style: { display: "block" } });
    const cmdGroup = el("div", { className: "studio-form-group" });
    cmdGroup.appendChild(el("label", { className: "studio-form-label", text: "\u542F\u52A8\u547D\u4EE4 *" }));
    const cmdInput = el("input", { className: "studio-input", attrs: { placeholder: "\u5982\uFF1Anpx\u3001python\u3001uvx" } });
    cmdGroup.appendChild(cmdInput);
    stdioFields.appendChild(cmdGroup);
    const argsGroup = el("div", { className: "studio-form-group" });
    argsGroup.appendChild(el("label", { className: "studio-form-label", text: "\u53C2\u6570" }));
    const argsList = el("div", { className: "studio-kv-list" });
    const addArgBtn = el("button", { className: "studio-kv-add" }, [icon(Icons.plus, 12), el("span", { text: "\u6DFB\u52A0\u53C2\u6570" })]);
    addArgBtn.addEventListener("click", () => addKvRow(argsList, "\u53C2\u6570\u503C"));
    argsGroup.appendChild(argsList);
    argsGroup.appendChild(addArgBtn);
    stdioFields.appendChild(argsGroup);
    form.appendChild(stdioFields);
    const httpFields = el("div", { style: { display: "none" } });
    const urlGroup = el("div", { className: "studio-form-group" });
    urlGroup.appendChild(el("label", { className: "studio-form-label", text: "\u670D\u52A1\u5668 URL *" }));
    const urlInput = el("input", { className: "studio-input", attrs: { placeholder: "https://mcp.example.com/mcp" } });
    urlGroup.appendChild(urlInput);
    httpFields.appendChild(urlGroup);
    form.appendChild(httpFields);
    const envGroup = el("div", { className: "studio-form-group" });
    envGroup.appendChild(el("label", { className: "studio-form-label", text: "\u73AF\u5883\u53D8\u91CF" }));
    const envList = el("div", { className: "studio-kv-list" });
    const addEnvBtn = el("button", { className: "studio-kv-add" }, [icon(Icons.plus, 12), el("span", { text: "\u6DFB\u52A0\u73AF\u5883\u53D8\u91CF" })]);
    addEnvBtn.addEventListener("click", () => addKvPairRow(envList, "\u53D8\u91CF\u540D", "\u53D8\u91CF\u503C"));
    envGroup.appendChild(envList);
    envGroup.appendChild(addEnvBtn);
    form.appendChild(envGroup);
    const headersGroup = el("div", { className: "studio-form-group", style: { display: "none" } });
    headersGroup.appendChild(el("label", { className: "studio-form-label", text: "\u81EA\u5B9A\u4E49 Headers" }));
    const headersList = el("div", { className: "studio-kv-list" });
    const addHeaderBtn = el("button", { className: "studio-kv-add" }, [icon(Icons.plus, 12), el("span", { text: "\u6DFB\u52A0 Header" })]);
    addHeaderBtn.addEventListener("click", () => addKvPairRow(headersList, "Header \u540D", "Header \u503C"));
    headersGroup.appendChild(headersList);
    headersGroup.appendChild(addHeaderBtn);
    form.appendChild(headersGroup);
    const testResult = el("div", { className: "studio-mcp-test-result" });
    form.appendChild(testResult);
    body.appendChild(form);
    modal.appendChild(body);
    const footer = el("div", { className: "studio-modal-footer" });
    const testBtn = el("button", { className: "studio-btn", text: "\u6D4B\u8BD5\u8FDE\u63A5" });
    testBtn.addEventListener("click", testConnection);
    const cancelBtn = el("button", { className: "studio-btn", text: "\u53D6\u6D88" });
    cancelBtn.addEventListener("click", close);
    const saveBtn = el("button", { className: "studio-btn primary", text: "\u4FDD\u5B58" });
    saveBtn.addEventListener("click", saveConfig);
    footer.appendChild(testBtn);
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    shadow.appendChild(overlay);
    function addKvRow(container2, placeholder) {
      const row = el("div", { className: "studio-kv-row" });
      const input = el("input", { className: "studio-input", attrs: { placeholder } });
      const removeBtn = el("button", { className: "studio-kv-remove" }, [icon(Icons.x, 12)]);
      removeBtn.addEventListener("click", () => row.remove());
      row.appendChild(input);
      row.appendChild(removeBtn);
      container2.appendChild(row);
    }
    function addKvPairRow(container2, placeholder1, placeholder2) {
      const row = el("div", { className: "studio-kv-row" });
      const input1 = el("input", { className: "studio-input", attrs: { placeholder: placeholder1 } });
      const input2 = el("input", { className: "studio-input", attrs: { placeholder: placeholder2 } });
      const removeBtn = el("button", { className: "studio-kv-remove" }, [icon(Icons.x, 12)]);
      removeBtn.addEventListener("click", () => row.remove());
      row.appendChild(input1);
      row.appendChild(input2);
      row.appendChild(removeBtn);
      container2.appendChild(row);
    }
    function updateTransportFields() {
      const isStdio = transportType === "stdio";
      stdioFields.style.display = isStdio ? "block" : "none";
      httpFields.style.display = isStdio ? "none" : "block";
      headersGroup.style.display = isStdio ? "none" : "block";
    }
    function collectConfig() {
      const name = nameInput.value.trim();
      if (!name) {
        testResult.className = "studio-mcp-test-result error";
        testResult.textContent = "\u8BF7\u8F93\u5165\u670D\u52A1\u5668\u540D\u79F0";
        return null;
      }
      const config = { name, transport: transportType };
      if (transportType === "stdio") {
        const command = cmdInput.value.trim();
        if (!command) {
          testResult.className = "studio-mcp-test-result error";
          testResult.textContent = "\u8BF7\u8F93\u5165\u542F\u52A8\u547D\u4EE4";
          return null;
        }
        config.command = command;
        const args = [];
        argsList.querySelectorAll("input").forEach((input) => {
          const val = input.value.trim();
          if (val) args.push(val);
        });
        config.args = args;
      } else {
        const url = urlInput.value.trim();
        if (!url) {
          testResult.className = "studio-mcp-test-result error";
          testResult.textContent = "\u8BF7\u8F93\u5165\u670D\u52A1\u5668 URL";
          return null;
        }
        config.url = url;
        const headers = {};
        headersList.querySelectorAll(".studio-kv-row").forEach((row) => {
          const inputs = row.querySelectorAll("input");
          const key = inputs[0].value.trim();
          const val = inputs[1].value.trim();
          if (key) headers[key] = val;
        });
        config.headers = headers;
      }
      const env = {};
      envList.querySelectorAll(".studio-kv-row").forEach((row) => {
        const inputs = row.querySelectorAll("input");
        const key = inputs[0].value.trim();
        const val = inputs[1].value.trim();
        if (key) env[key] = val;
      });
      config.env = env;
      return config;
    }
    async function testConnection() {
      const config = collectConfig();
      if (!config) return;
      testResult.className = "studio-mcp-test-result loading";
      testResult.textContent = "\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5...";
      try {
        const result2 = await callHostTool("mcp.test", { config });
        if (result2.ok) {
          testResult.className = "studio-mcp-test-result success";
          testResult.textContent = "\u8FDE\u63A5\u6210\u529F\uFF01";
        } else {
          testResult.className = "studio-mcp-test-result error";
          testResult.textContent = `\u8FDE\u63A5\u5931\u8D25\uFF1A${result2.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
        }
      } catch (e) {
        testResult.className = "studio-mcp-test-result error";
        testResult.textContent = `\u8FDE\u63A5\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`;
      }
    }
    async function saveConfig() {
      const config = collectConfig();
      if (!config) return;
      try {
        const result2 = await callHostTool("mcp.save", { serverId: editingServerId ?? config.name, config });
        if (result2.ok) {
          if (!globalState.mcpServers.includes(config.name)) {
            globalState.mcpServers.push(config.name);
          }
          globalEvents.emit("ui:mcp-saved", config);
          close();
        } else {
          testResult.className = "studio-mcp-test-result error";
          testResult.textContent = `\u4FDD\u5B58\u5931\u8D25\uFF1A${result2.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
        }
      } catch (e) {
        testResult.className = "studio-mcp-test-result error";
        testResult.textContent = `\u4FDD\u5B58\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`;
      }
    }
    function open(serverId) {
      editingServerId = serverId ?? null;
      header.querySelector(".studio-modal-title").textContent = serverId ? "\u7F16\u8F91 MCP \u670D\u52A1\u5668" : "\u6DFB\u52A0 MCP \u670D\u52A1\u5668";
      overlay.style.display = "flex";
      testResult.className = "studio-mcp-test-result";
      testResult.textContent = "";
      nameInput.value = serverId ?? "";
      cmdInput.value = "";
      urlInput.value = "";
      argsList.innerHTML = "";
      envList.innerHTML = "";
      headersList.innerHTML = "";
      transportType = "stdio";
      transportSelect.value = "stdio";
      updateTransportFields();
    }
    function close() {
      overlay.style.display = "none";
    }
    globalEvents.on("ui:mcp-add", () => open());
    globalEvents.on("ui:mcp-edit", (payload) => open(payload));
    return { container, open, close };
  }

  // src/ui/studio-right-sidebar.ts
  var sidebarStyles2 = `
  .studio-right-sidebar {
    position: fixed; top: 0; right: 0; width: 280px; height: 100vh;
    background: #fafbfc; border-left: 1px solid #e8e8e8;
    display: flex; flex-direction: column; z-index: 2147482000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px; color: #333;
    transform: translateX(100%); transition: transform 0.25s ease;
  }
  .studio-right-sidebar.open { transform: translateX(0); }
  .studio-right-toggle {
    position: fixed; top: 50%; right: 0; transform: translateY(-50%);
    width: 24px; height: 48px; background: #4D6BFE; border: none;
    border-radius: 8px 0 0 8px; cursor: pointer; z-index: 2147481999;
    display: flex; align-items: center; justify-content: center; color: #fff;
    transition: all 0.25s ease;
  }
  .studio-right-toggle:hover { background: #3a58e8; }
  .studio-right-sidebar.open ~ .studio-right-toggle { right: 280px; }
  .studio-right-header {
    padding: 12px 16px; border-bottom: 1px solid #f0f0f0;
    display: flex; align-items: center; justify-content: space-between;
  }
  .studio-right-title { font-weight: 600; font-size: 14px; color: #1a1a2e; }
  .studio-right-body { flex: 1; overflow-y: auto; }
  .studio-right-section { padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
  .studio-right-section-title {
    padding: 0 16px 8px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; color: #999; letter-spacing: 0.5px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .studio-right-section-count {
    background: #e8edff; color: #4D6BFE; padding: 1px 6px;
    border-radius: 8px; font-size: 10px; font-weight: 500;
  }
  .studio-right-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 16px;
    cursor: pointer; transition: background 0.15s;
  }
  .studio-right-item:hover { background: #f0f2ff; }
  .studio-right-item-icon { flex-shrink: 0; color: #666; }
  .studio-right-item-info { flex: 1; min-width: 0; }
  .studio-right-item-name { font-size: 12px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-right-item-meta { font-size: 10px; color: #999; margin-top: 1px; }
  .studio-right-empty { padding: 12px 16px; font-size: 12px; color: #bbb; }
  .studio-task-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 16px;
  }
  .studio-task-status {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    animation: pulse 1.5s infinite;
  }
  .studio-task-status.running { background: #4D6BFE; }
  .studio-task-status.done { background: #4caf50; animation: none; }
  .studio-task-status.error { background: #f44336; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .studio-task-name { flex: 1; font-size: 12px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-skill-tag {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 8px; background: #f0f2ff; border-radius: 10px;
    font-size: 11px; color: #4D6BFE; margin: 2px;
  }
  .studio-skills-tags { padding: 0 16px; display: flex; flex-wrap: wrap; gap: 4px; }
`;
  function createRightSidebar() {
    const { container, shadow } = createShadowContainer("studio-right-sidebar-root");
    injectStyles(shadow, sidebarStyles2);
    let isOpen = false;
    const artifacts = [];
    const tasks = [];
    const sidebar = el("div", { className: "studio-right-sidebar" });
    const header = el("div", { className: "studio-right-header" }, [
      el("span", { className: "studio-right-title", text: "\u5DE5\u4F5C\u53F0" })
    ]);
    const collapseBtn = el("button", { className: "studio-close-btn" }, [icon(Icons.chevronRight, 16)]);
    collapseBtn.addEventListener("click", hide);
    header.appendChild(collapseBtn);
    sidebar.appendChild(header);
    const body = el("div", { className: "studio-right-body" });
    const artifactSection = el("div", { className: "studio-right-section" });
    const artifactTitle = el("div", { className: "studio-right-section-title" });
    artifactTitle.innerHTML = `<span>\u5BF9\u8BDD\u4EA7\u7269</span><span class="studio-right-section-count" id="artifact-count">0</span>`;
    artifactSection.appendChild(artifactTitle);
    const artifactList = el("div", { className: "studio-artifact-list" });
    artifactSection.appendChild(artifactList);
    body.appendChild(artifactSection);
    const taskSection = el("div", { className: "studio-right-section" });
    const taskTitle = el("div", { className: "studio-right-section-title" });
    taskTitle.innerHTML = `<span>\u540E\u53F0\u4EFB\u52A1</span><span class="studio-right-section-count" id="task-count">0</span>`;
    taskSection.appendChild(taskTitle);
    const taskList = el("div", { className: "studio-task-list" });
    taskSection.appendChild(taskList);
    body.appendChild(taskSection);
    const skillSection = el("div", { className: "studio-right-section" });
    const skillTitle = el("div", { className: "studio-right-section-title" });
    skillTitle.innerHTML = `<span>\u5DF2\u542F\u7528\u6280\u80FD</span>`;
    skillSection.appendChild(skillTitle);
    const skillTags = el("div", { className: "studio-skills-tags" });
    skillSection.appendChild(skillTags);
    body.appendChild(skillSection);
    const auditSection = el("div", { className: "studio-right-section" });
    const auditTitle = el("div", { className: "studio-right-section-title" });
    auditTitle.innerHTML = `<span>\u5143\u5B9D\u5BA1\u8BA1</span><span id="audit-state-badge" style="background:#f0f0f0;color:#888;padding:1px 6px;border-radius:8px;font-size:10px">\u2014</span>`;
    auditSection.appendChild(auditTitle);
    const auditBodyEl = el("div", { attrs: { style: "padding:0 16px" } });
    auditBodyEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
      <span style="color:#888">\u8FDB\u5EA6</span><span id="audit-rounds" style="color:#333">\u2014</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
      <span style="color:#888">\u5DF2\u89C1\u8F6E\u6B21</span><span id="audit-seen" style="color:#666">\u2014</span>
    </div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin:8px 0">
      <button class="studio-btn sm" data-cmd="continue">\u7EE7\u7EED</button>
      <button class="studio-btn sm" data-cmd="pause">\u6682\u505C</button>
      <button class="studio-btn sm" data-cmd="stop">\u505C\u6B62</button>
      <button class="studio-btn sm" data-cmd="reset">\u91CD\u7F6E</button>
    </div>
    <div id="audit-log-toggle" style="font-size:11px;color:#4D6BFE;cursor:pointer;margin-bottom:4px">\u67E5\u770B\u6700\u8FD1\u65E5\u5FD7</div>
    <pre id="audit-log-box" style="display:none;max-height:140px;overflow:auto;background:#f7f7f8;border-radius:6px;padding:6px;font-size:10px;color:#646a73;white-space:pre-wrap;word-break:break-all"></pre>
  `;
    auditSection.appendChild(auditBodyEl);
    body.appendChild(auditSection);
    const recentSection = el("div", { className: "studio-right-section" });
    recentSection.appendChild(el("div", { className: "studio-right-section-title", text: "\u6700\u8FD1\u6587\u4EF6" }));
    const recentList = el("div", { className: "studio-recent-list" });
    recentSection.appendChild(recentList);
    body.appendChild(recentSection);
    sidebar.appendChild(body);
    shadow.appendChild(sidebar);
    const toggle = el("button", { className: "studio-right-toggle" });
    toggle.appendChild(icon(Icons.chevronRight, 14));
    toggle.addEventListener("click", () => {
      isOpen ? hide() : show();
    });
    function renderArtifacts() {
      artifactList.innerHTML = "";
      if (artifacts.length === 0) {
        artifactList.appendChild(el("div", { className: "studio-right-empty", text: "\u6682\u65E0\u4EA7\u7269" }));
        return;
      }
      for (const item of artifacts.slice(-10).reverse()) {
        const row = el("div", { className: "studio-right-item" });
        const iconEl = el("span", { className: "studio-right-item-icon" });
        iconEl.appendChild(icon(item.type === "folder" ? Icons.folder : Icons.file, 14));
        const info = el("div", { className: "studio-right-item-info" });
        info.innerHTML = `<div class="studio-right-item-name">${item.name}</div><div class="studio-right-item-meta">${item.modified}</div>`;
        row.appendChild(iconEl);
        row.appendChild(info);
        row.addEventListener("click", () => globalEvents.emit("ui:open-file", item.path));
        artifactList.appendChild(row);
      }
      artifactTitle.querySelector("#artifact-count").textContent = String(artifacts.length);
    }
    function renderTasks() {
      taskList.innerHTML = "";
      if (tasks.length === 0) {
        taskList.appendChild(el("div", { className: "studio-right-empty", text: "\u6682\u65E0\u4EFB\u52A1" }));
        return;
      }
      for (const task of tasks.slice(-10).reverse()) {
        const row = el("div", { className: "studio-task-item" });
        row.appendChild(el("span", { className: `studio-task-status ${task.status}` }));
        row.appendChild(el("span", { className: "studio-task-name", text: task.name }));
        taskList.appendChild(row);
      }
      taskTitle.querySelector("#task-count").textContent = String(tasks.length);
    }
    function renderSkills() {
      skillTags.innerHTML = "";
      if (globalState.skills.length === 0) {
        skillTags.appendChild(el("span", { className: "studio-right-empty", text: "\u6682\u65E0", style: { padding: "0" } }));
        return;
      }
      for (const skill of globalState.skills.slice(0, 8)) {
        const tag = el("span", { className: "studio-skill-tag" });
        tag.appendChild(icon(Icons.book, 10));
        tag.appendChild(el("span", { text: skill.name }));
        skillTags.appendChild(tag);
      }
    }
    function renderRecent() {
      recentList.innerHTML = "";
      if (artifacts.length === 0) {
        recentList.appendChild(el("div", { className: "studio-right-empty", text: "\u6682\u65E0\u6700\u8FD1\u6587\u4EF6" }));
        return;
      }
      for (const item of artifacts.slice(-5).reverse()) {
        const row = el("div", { className: "studio-right-item" });
        const iconEl = el("span", { className: "studio-right-item-icon" });
        iconEl.appendChild(icon(Icons.file, 12));
        row.appendChild(iconEl);
        row.appendChild(el("span", { className: "studio-right-item-name", text: item.name, style: { fontSize: "11px" } }));
        recentList.appendChild(row);
      }
    }
    async function renderAudit() {
      const badge = auditSection.querySelector("#audit-state-badge");
      const roundsEl = auditSection.querySelector("#audit-rounds");
      const seenEl = auditSection.querySelector("#audit-seen");
      try {
        const st2 = await fetch("http://127.0.0.1:8761/status").then((r) => {
          if (!r.ok) throw new Error("status " + r.status);
          return r.json();
        });
        const colors = {
          running: "#e6f4ea;color:#34a853",
          paused: "#fef7e0;color:#b06000",
          stopped: "#fce8e6;color:#e5484d",
          done: "#e6f4ea;color:#34a853",
          idle: "#f0f0f0;color:#888"
        };
        badge.textContent = st2.state;
        badge.style.cssText = `padding:1px 6px;border-radius:8px;font-size:10px;${colors[st2.state] ?? colors.idle}`;
        roundsEl.textContent = `${st2.rounds} / ${st2.target}`;
        const seen = Array.isArray(st2.seenRounds) ? st2.seenRounds : [];
        seenEl.textContent = seen.length ? seen.join(", ") : "\u65E0";
      } catch {
        badge.textContent = "\u672A\u542F\u52A8";
        badge.style.cssText = "padding:1px 6px;border-radius:8px;font-size:10px;#f0f0f0;color:#888";
        roundsEl.textContent = "\u2014";
        seenEl.textContent = "\u2014";
      }
    }
    auditBodyEl.querySelectorAll("button[data-cmd]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const command = btn.dataset.cmd;
        try {
          const r = await fetch("http://127.0.0.1:8761/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command })
          });
          if (!r.ok) throw new Error("cmd " + r.status);
          await renderAudit();
        } catch {
        }
      });
    });
    const logToggle = auditBodyEl.querySelector("#audit-log-toggle");
    const logBox = auditBodyEl.querySelector("#audit-log-box");
    logToggle.addEventListener("click", async () => {
      if (logBox.style.display !== "none") {
        logBox.style.display = "none";
        logToggle.textContent = "\u67E5\u770B\u6700\u8FD1\u65E5\u5FD7";
        return;
      }
      logBox.style.display = "block";
      logToggle.textContent = "\u6536\u8D77\u65E5\u5FD7";
      try {
        const r = await fetch("http://127.0.0.1:8761/v1/audit-log?lines=15");
        const data = await r.json();
        const lines = Array.isArray(data.lines) ? data.lines : [];
        logBox.textContent = lines.length ? lines.map((l) => {
          try {
            return JSON.stringify(JSON.parse(l));
          } catch {
            return l;
          }
        }).join("\n") : "\u6682\u65E0\u65E5\u5FD7";
      } catch {
        logBox.textContent = "\u5BA1\u8BA1\u5185\u6838\u672A\u8FD0\u884C";
      }
    });
    function show() {
      isOpen = true;
      sidebar.classList.add("open");
      toggle.querySelector("svg")?.remove();
      toggle.appendChild(icon(Icons.chevronRight, 14));
      renderArtifacts();
      renderTasks();
      renderSkills();
      renderRecent();
      void renderAudit();
    }
    function hide() {
      isOpen = false;
      sidebar.classList.remove("open");
    }
    function addArtifact(item) {
      artifacts.push(item);
      if (isOpen) {
        renderArtifacts();
        renderRecent();
      }
    }
    function addTask(task) {
      tasks.push(task);
      if (isOpen) renderTasks();
    }
    function updateTask(id, status) {
      const task = tasks.find((t) => t.id === id);
      if (task) {
        task.status = status;
        if (isOpen) renderTasks();
      }
    }
    globalEvents.on("ui:artifact-added", (payload) => addArtifact(payload));
    globalEvents.on("ui:task-added", (payload) => addTask(payload));
    globalEvents.on("ui:task-updated", (payload) => {
      const { id, status } = payload;
      updateTask(id, status);
    });
    globalEvents.on("ui:skills-updated", () => {
      if (isOpen) renderSkills();
    });
    return { container, toggle, show, hide, addArtifact, addTask, updateTask };
  }

  // src/ui/studio-chat-room.ts
  var BOT_COLORS = {
    "frontend-expert": { bg: "#22c55e", border: "#22c55e" },
    "backend-expert": { bg: "#f59e0b", border: "#f59e0b" },
    "audit-expert": { bg: "#8b5cf6", border: "#8b5cf6" },
    main: { bg: "#4D6BFE", border: "#4D6BFE" }
  };
  var DEFAULT_COLOR = { bg: "#6b7280", border: "#6b7280" };
  function createChatRoom(config) {
    const { container, shadow } = createShadowContainer("studio-chat-room-root");
    injectStyles(shadow, CHAT_ROOM_CSS);
    const fab = el("button", { className: "studio-chat-fab", attrs: { title: "\u804A\u5929\u5BA4" } }, [
      icon(Icons.message, 20)
    ]);
    const overlay = el("div", { className: "studio-chat-overlay" });
    const panel = el("div", { className: "studio-chat-panel" });
    const header = el("div", { className: "studio-chat-header" });
    const headerLeft = el("div", { className: "studio-chat-header-left" });
    const roomTitle = el("div", { className: "studio-chat-room-name", text: config.roomName });
    const memberChips = el("div", { className: "studio-chat-members" });
    const connDot = el("span", { className: "studio-chat-conn-dot" });
    const connText = el("span", { className: "studio-chat-conn-text", text: "\u8FDE\u63A5\u4E2D\u2026" });
    const connBox = el("div", { className: "studio-chat-conn" }, [connDot, connText]);
    const meetingChip = el("span", { className: "studio-chat-meeting-chip idle", text: "\u25CB \u672A\u5F00\u59CB" });
    headerLeft.appendChild(roomTitle);
    headerLeft.appendChild(memberChips);
    headerLeft.appendChild(meetingChip);
    headerLeft.appendChild(connBox);
    const closeBtn = el("button", { className: "studio-chat-close", attrs: { title: "\u5173\u95ED" } }, [
      icon(Icons.x, 18)
    ]);
    header.appendChild(headerLeft);
    header.appendChild(closeBtn);
    const messages = el("div", { className: "studio-chat-messages" });
    const welcome = el("div", { className: "studio-chat-welcome" });
    welcome.innerHTML = `<div class="studio-chat-welcome-title">\u804A\u5929\u5BA4 \xB7 ${config.roomName}</div><div class="studio-chat-welcome-sub">\u5728\u4E0B\u65B9\u8F93\u5165\u6D88\u606F\uFF0C\u7528 @all \u6216 @\u6210\u5458\u540D \u6307\u5B9A\u56DE\u590D\u8005</div>`;
    messages.appendChild(welcome);
    const composer = el("div", { className: "studio-chat-composer" });
    const input = document.createElement("textarea");
    input.className = "studio-chat-input";
    input.rows = 2;
    input.placeholder = `@all \u6216 @${config.members[0] ?? "\u6210\u5458"} \u2026\uFF08Enter \u53D1\u9001\uFF0CShift+Enter \u6362\u884C\uFF09`;
    const sendBtn = el("button", { className: "studio-chat-send", text: "\u53D1\u9001" });
    composer.appendChild(input);
    composer.appendChild(sendBtn);
    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(composer);
    shadow.appendChild(fab);
    shadow.appendChild(overlay);
    shadow.appendChild(panel);
    const allMembers = ["main", ...config.members];
    for (const m of allMembers) {
      const color = BOT_COLORS[m] ?? DEFAULT_COLOR;
      const chip = el("button", { className: "studio-chat-member-chip", text: "@" + m });
      chip.style.borderLeftColor = color.border;
      chip.addEventListener("click", () => {
        const insert = input.value.endsWith(" ") || input.value === "" ? `@${m} ` : ` @${m} `;
        input.value += insert;
        input.focus();
      });
      memberChips.appendChild(chip);
    }
    let ws2 = null;
    let connected = false;
    let roundInProgress = false;
    let reqSeq = 0;
    let reconnectTimer2 = null;
    let backoff2 = 500;
    const thinkingBots = /* @__PURE__ */ new Set();
    function connect() {
      const url = `${config.wsUrl}?token=${encodeURIComponent(config.token)}`;
      try {
        ws2 = new WebSocket(url);
      } catch (e) {
        console.error("[chat-room] WS construct failed", e);
        scheduleReconnect2();
        return;
      }
      ws2.onopen = () => {
        backoff2 = 500;
        connected = true;
        connDot.className = "studio-chat-conn-dot ok";
        connText.textContent = "\u5DF2\u8FDE\u63A5";
      };
      ws2.onclose = (ev) => {
        connected = false;
        ws2 = null;
        connDot.className = "studio-chat-conn-dot bad";
        connText.textContent = ev.code === 1008 ? "\u9274\u6743\u5931\u8D25\uFF08\u8BF7\u91CD\u542F\u5E94\u7528\uFF09" : "\u8FDE\u63A5\u65AD\u5F00\uFF0C\u91CD\u8BD5\u4E2D\u2026";
        if (ev.code !== 1008) scheduleReconnect2();
      };
      ws2.onerror = () => {
        try {
          ws2?.close();
        } catch {
        }
      };
      ws2.onmessage = (ev) => {
        let msg2;
        try {
          msg2 = JSON.parse(ev.data);
        } catch {
          return;
        }
        handleServerMessage(msg2);
      };
    }
    function scheduleReconnect2() {
      if (reconnectTimer2) return;
      const delay = backoff2;
      backoff2 = Math.min(backoff2 * 2, 1e4);
      reconnectTimer2 = setTimeout(() => {
        reconnectTimer2 = null;
        connect();
      }, delay);
    }
    function send2(payload) {
      if (ws2 && ws2.readyState === WebSocket.OPEN) {
        try {
          ws2.send(JSON.stringify(payload));
        } catch (e) {
          console.error("[chat-room] send failed", e);
        }
      }
    }
    function handleServerMessage(msg2) {
      const type = msg2.type;
      if (type === "state") {
        return;
      }
      if (type === "ack") {
        if (msg2.ok !== true && typeof msg2.error === "string") {
          appendStatus(`\u64CD\u4F5C\u5931\u8D25\uFF1A${msg2.error}`);
        }
        return;
      }
      if (type === "event") {
        const event = msg2.event;
        if (!event) return;
        handleEvent(event);
      }
      if (type === "chat-room-event") {
        const ev = msg2.event;
        if (!ev) return;
        handleStructuredEvent(ev);
      }
    }
    function handleEvent(event) {
      if (event.roomId !== void 0 && event.roomId !== config.roomId) return;
      const botId = event.botId ?? "main";
      switch (event.type) {
        case "user":
          thinkingBots.add(botId);
          break;
        case "status":
          if (config.members.includes(botId) || botId === "main") {
            thinkingBots.add(botId);
          }
          break;
        case "assistant":
          thinkingBots.delete(botId);
          break;
        case "done":
          thinkingBots.delete(botId);
          if (botId === "main" && roundInProgress) {
            roundInProgress = false;
            updateComposerState();
          }
          break;
        case "tool":
          break;
        case "error":
          thinkingBots.delete(botId);
          if (event.text) appendErrorMessage(botId, event.text);
          break;
      }
    }
    function handleStructuredEvent(ev) {
      if (ev.roomId !== config.roomId) return;
      switch (ev.kind) {
        case "chat-bot-reply": {
          const botId = ev.botId ?? "main";
          thinkingBots.delete(botId);
          appendBotMessage(botId, ev.content ?? "");
          break;
        }
        case "chat-summary": {
          if (ev.summary) appendSummary(ev.summary);
          break;
        }
        case "meeting-state": {
          updateMeetingChip(ev.status ?? "idle", ev.strategy ?? null);
          break;
        }
        case "round-complete": {
          if (roundInProgress) {
            roundInProgress = false;
            updateComposerState();
          }
          break;
        }
        case "task-progress": {
          appendTaskProgress(ev.slotId ?? "", ev.dimension ?? "", ev.taskStatus ?? "running", ev.message);
          break;
        }
        case "task-complete": {
          appendTaskComplete(ev.slotId ?? "", ev.dimension ?? "", ev.ok ?? false, ev.findingCount ?? 0, ev.error);
          break;
        }
        case "report-ready": {
          appendReportCard(ev.summaryPath ?? "", ev.subReports ?? []);
          break;
        }
      }
    }
    function updateMeetingChip(status, strategy) {
      meetingChip.className = `studio-chat-meeting-chip ${status}`;
      if (status === "active" && strategy) {
        const topics = strategy.focusTopics.length > 0 ? `\xB7 ${strategy.focusTopics.join("\u3001")}` : "";
        meetingChip.textContent = `\u25CF \u4F1A\u8BAE\u4E2D \xB7 \u9608\u503C ${strategy.minRoundsBeforeAutoSummary} \u8F6E ${topics}`;
      } else if (status === "closed") {
        meetingChip.textContent = "\u25CB \u5DF2\u6563\u4F1A";
      } else {
        meetingChip.textContent = "\u25CB \u672A\u5F00\u59CB";
      }
    }
    function removeWelcome() {
      const w2 = messages.querySelector(".studio-chat-welcome");
      if (w2) w2.remove();
    }
    function scrollToBottom() {
      messages.scrollTop = messages.scrollHeight;
    }
    function appendUserMessage(text) {
      removeWelcome();
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-user", text });
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function appendBotMessage(botId, text) {
      removeWelcome();
      const color = BOT_COLORS[botId] ?? DEFAULT_COLOR;
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-bot" });
      msg2.style.borderLeftColor = color.border;
      const meta = el("div", { className: "studio-chat-sender-row" });
      const avatar = el("span", { className: "studio-chat-avatar", text: botId.slice(0, 2) });
      avatar.style.background = color.bg;
      const name = el("span", { className: "studio-chat-sender", text: botId });
      meta.appendChild(avatar);
      meta.appendChild(name);
      msg2.appendChild(meta);
      const body = el("div", { className: "studio-chat-msg-body" });
      body.innerHTML = renderMarkdown(text);
      enhanceCodeBlocks(body);
      msg2.appendChild(body);
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function appendSummary(text) {
      removeWelcome();
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-summary" });
      const label = el("div", { className: "studio-chat-summary-label", text: "\u{1F4CB} \u672C\u8F6E\u6458\u8981" });
      msg2.appendChild(label);
      const body = el("div", { className: "studio-chat-msg-body" });
      body.innerHTML = renderMarkdown(text);
      enhanceCodeBlocks(body);
      msg2.appendChild(body);
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function appendErrorMessage(botId, text) {
      removeWelcome();
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-error" });
      msg2.textContent = `[${botId}] \u9519\u8BEF\uFF1A${text}`;
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function appendStatus(text) {
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-status", text });
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function appendTaskProgress(slotId, dimension, status, message) {
      removeWelcome();
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-task" });
      msg2.style.borderLeftColor = "#3b82f6";
      const label = el("div", { className: "studio-chat-summary-label", text: `\u{1F52C} \u5BA1\u8BA1\u4E2D \xB7 ${dimension}` });
      msg2.appendChild(label);
      const body = el("div", { className: "studio-chat-msg-body" });
      body.textContent = `\u69FD ${slotId} \xB7 ${status === "running" ? "\u6267\u884C\u4E2D" : "\u6B65\u8FDB"}${message ? " \xB7 " + message : ""}`;
      msg2.appendChild(body);
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function appendTaskComplete(slotId, dimension, ok, findingCount, error) {
      removeWelcome();
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-task" });
      msg2.style.borderLeftColor = ok ? "#22c55e" : "#ef4444";
      const icon2 = ok ? "\u2705" : "\u274C";
      const label = el("div", { className: "studio-chat-summary-label", text: `${icon2} \u5BA1\u8BA1\u5B8C\u6210 \xB7 ${dimension}` });
      msg2.appendChild(label);
      const body = el("div", { className: "studio-chat-msg-body" });
      if (ok) {
        body.textContent = `\u69FD ${slotId} \xB7 \u53D1\u73B0 ${findingCount} \u6761`;
      } else {
        body.textContent = `\u69FD ${slotId} \xB7 \u5931\u8D25${error ? "\uFF1A" + error : ""}`;
      }
      msg2.appendChild(body);
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function appendReportCard(summaryPath, subReports) {
      removeWelcome();
      const msg2 = el("div", { className: "studio-chat-msg studio-chat-msg-report" });
      msg2.style.borderLeftColor = "#6366f1";
      const label = el("div", { className: "studio-chat-summary-label", text: "\u{1F4CA} \u7EFC\u5408\u5BA1\u8BA1\u62A5\u544A" });
      msg2.appendChild(label);
      const body = el("div", { className: "studio-chat-msg-body" });
      const total = subReports.reduce((s, r) => s + r.findingCount, 0);
      const head = el("div", { text: `\u5171 ${subReports.length} \u4E2A\u7EF4\u5EA6 \xB7 ${total} \u6761\u53D1\u73B0` });
      head.style.fontWeight = "bold";
      head.style.marginBottom = "8px";
      body.appendChild(head);
      for (const r of subReports) {
        const row = el("div", { text: `\u2022 ${r.dimension}\uFF08${r.findingCount} \u6761\uFF09\uFF1A${r.summary}` });
        row.style.marginBottom = "4px";
        body.appendChild(row);
      }
      if (summaryPath) {
        const path = el("div", { text: `\u{1F4C4} \u62A5\u544A\u8DEF\u5F84\uFF1A${summaryPath}` });
        path.style.marginTop = "8px";
        path.style.fontSize = "0.85em";
        path.style.color = "#888";
        body.appendChild(path);
      }
      msg2.appendChild(body);
      messages.appendChild(msg2);
      scrollToBottom();
    }
    function enhanceCodeBlocks(scope) {
      const pres = scope.querySelectorAll("pre");
      for (const pre of pres) {
        if (pre.querySelector(".studio-chat-code-copy")) continue;
        const code2 = pre.querySelector("code");
        if (!code2) continue;
        const cls = code2.className || "";
        const langMatch = cls.match(/language-(\w+)/);
        if (langMatch) {
          const tag = el("span", { className: "studio-chat-code-lang", text: langMatch[1] });
          pre.appendChild(tag);
        }
        const copyBtn = el("span", { className: "studio-chat-code-copy", text: "\u590D\u5236" });
        copyBtn.addEventListener("click", () => {
          const t = code2.textContent || "";
          try {
            navigator.clipboard?.writeText(t);
          } catch {
          }
          copyBtn.textContent = "\u5DF2\u590D\u5236";
          setTimeout(() => {
            copyBtn.textContent = "\u590D\u5236";
          }, 1500);
        });
        pre.appendChild(copyBtn);
      }
    }
    function submitMessage() {
      const text = input.value.trim();
      if (!text || roundInProgress || !connected) return;
      input.value = "";
      appendUserMessage(text);
      roundInProgress = true;
      thinkingBots.clear();
      updateComposerState();
      const reqId = `cr${++reqSeq}`;
      send2({ type: "send", roomId: config.roomId, text, reqId });
    }
    function updateComposerState() {
      sendBtn.disabled = roundInProgress || !connected;
      sendBtn.textContent = roundInProgress ? "\u8FDB\u884C\u4E2D\u2026" : "\u53D1\u9001";
      input.disabled = roundInProgress;
      if (roundInProgress) {
        const indicator = el("div", { className: "studio-chat-round-indicator", text: "\u4E13\u5BB6\u8BA8\u8BBA\u4E2D\u2026" });
        messages.appendChild(indicator);
        scrollToBottom();
      } else {
        const ind = messages.querySelector(".studio-chat-round-indicator");
        if (ind) ind.remove();
      }
    }
    let isOpen = false;
    let escHandler = null;
    function show() {
      isOpen = true;
      overlay.classList.add("visible");
      panel.classList.add("visible");
      escHandler = (e) => {
        if (e.key === "Escape") hide();
      };
      window.addEventListener("keydown", escHandler);
      if (!ws2 && !connected) connect();
      setTimeout(() => input.focus(), 50);
    }
    function hide() {
      isOpen = false;
      overlay.classList.remove("visible");
      panel.classList.remove("visible");
      if (escHandler) {
        window.removeEventListener("keydown", escHandler);
        escHandler = null;
      }
    }
    function toggle() {
      if (isOpen) hide();
      else show();
    }
    fab.addEventListener("click", toggle);
    overlay.addEventListener("click", hide);
    closeBtn.addEventListener("click", hide);
    sendBtn.addEventListener("click", submitMessage);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitMessage();
      }
    });
    function destroy() {
      if (reconnectTimer2) {
        clearTimeout(reconnectTimer2);
        reconnectTimer2 = null;
      }
      if (escHandler) {
        window.removeEventListener("keydown", escHandler);
        escHandler = null;
      }
      if (ws2) {
        try {
          ws2.close();
        } catch {
        }
        ws2 = null;
      }
      container.remove();
    }
    return { container, show, hide, toggle, destroy };
  }
  var CHAT_ROOM_CSS = `
/* FAB\uFF08\u53F3\u4E0B\u89D2\uFF0C\u907F\u5F00\u5DE6\u4E0A\u89D2 sidebar FAB\uFF09 */
.studio-chat-fab {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border: none;
  box-shadow: 0 4px 14px rgba(77,107,254,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483646;
  transition: all 0.2s ease;
}
.studio-chat-fab:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 20px rgba(77,107,254,0.5);
}
.studio-chat-fab svg { width: 20px; height: 20px; }

/* \u906E\u7F69 */
.studio-chat-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  z-index: 2147483644;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
}
.studio-chat-overlay.visible {
  opacity: 1;
  visibility: visible;
}

/* \u9762\u677F */
.studio-chat-panel {
  position: fixed;
  bottom: 80px;
  right: 20px;
  width: min(560px, 92vw);
  height: min(680px, 82vh);
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  display: flex;
  flex-direction: column;
  z-index: 2147483645;
  overflow: hidden;
  transform: translateX(120%) scale(0.95);
  opacity: 0;
  visibility: hidden;
  transition: transform 0.25s ease, opacity 0.25s ease, visibility 0.25s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.studio-chat-panel.visible {
  transform: translateX(0) scale(1);
  opacity: 1;
  visibility: visible;
}

/* \u5934\u90E8 */
.studio-chat-header {
  flex-shrink: 0;
  padding: 12px 16px;
  background: #f8f9fc;
  border-bottom: 1px solid #e8e8ee;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.studio-chat-header-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.studio-chat-room-name {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a2e;
}
.studio-chat-members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.studio-chat-member-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid #e0e0e8;
  border-left: 3px solid #ccc;
  background: #fff;
  color: #666;
  cursor: pointer;
  transition: all 0.15s ease;
}
.studio-chat-member-chip:hover {
  background: #f0f0f5;
  color: #333;
}
.studio-chat-conn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #999;
}
.studio-chat-conn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ccc;
}
.studio-chat-conn-dot.ok { background: #22c55e; }
.studio-chat-conn-dot.bad { background: #ef4444; }
/* v0.29 \u4F1A\u8BAE\u72B6\u6001 chip */
.studio-chat-meeting-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 500;
  background: #f3f4f6;
  color: #6b7280;
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.studio-chat-meeting-chip.active {
  background: #dcfce7;
  color: #15803d;
}
.studio-chat-meeting-chip.closed {
  background: #f1f5f9;
  color: #94a3b8;
}
.studio-chat-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #999;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.studio-chat-close:hover { background: #e8e8ee; color: #555; }

/* \u6D88\u606F\u5217\u8868 */
.studio-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scroll-behavior: smooth;
}
.studio-chat-messages::-webkit-scrollbar { width: 7px; }
.studio-chat-messages::-webkit-scrollbar-thumb { background: #d0d0d8; border-radius: 4px; }

/* \u6B22\u8FCE\u5360\u4F4D */
.studio-chat-welcome {
  margin: auto;
  text-align: center;
  padding: 40px 20px;
  color: #aaa;
}
.studio-chat-welcome-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #888; }
.studio-chat-welcome-sub { font-size: 13px; line-height: 1.7; }

/* \u7528\u6237\u6D88\u606F */
.studio-chat-msg-user {
  align-self: flex-end;
  max-width: 78%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border-radius: 14px 14px 4px 14px;
  padding: 10px 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* bot \u6D88\u606F */
.studio-chat-msg-bot {
  align-self: flex-start;
  max-width: 88%;
  background: #f6f7f9;
  border: 1px solid #e8e8ee;
  border-left: 3px solid #4D6BFE;
  border-radius: 4px 14px 14px 4px;
  padding: 10px 14px;
  word-break: break-word;
}
.studio-chat-sender-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.studio-chat-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 50%;
  font-size: 10px; font-weight: 600; color: #fff;
  flex-shrink: 0;
}
.studio-chat-sender { font-size: 12px; color: #888; font-weight: 500; }

/* \u6458\u8981 */
.studio-chat-msg-summary {
  align-self: stretch;
  background: #fefce8;
  border: 1px solid #fde68a;
  border-left: 3px solid #f59e0b;
  border-radius: 8px;
  padding: 10px 14px;
  margin-top: 4px;
}
.studio-chat-summary-label {
  font-size: 12px;
  font-weight: 600;
  color: #92400e;
  margin-bottom: 6px;
}

/* \u9519\u8BEF */
.studio-chat-msg-error {
  align-self: center;
  max-width: 90%;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: #dc2626;
}

/* \u72B6\u6001\u63D0\u793A */
.studio-chat-msg-status {
  align-self: center;
  font-size: 12px;
  color: #999;
  padding: 4px 0;
}

/* \u8F6E\u6B21\u6307\u793A\u5668 */
.studio-chat-round-indicator {
  align-self: center;
  font-size: 12px;
  color: #4D6BFE;
  padding: 6px 14px;
  background: #eff4ff;
  border-radius: 12px;
  animation: studio-chat-pulse 1.5s ease-in-out infinite;
}
@keyframes studio-chat-pulse { 50% { opacity: 0.5; } }

/* \u6D88\u606F\u6B63\u6587\uFF08markdown\uFF09 */
.studio-chat-msg-body { font-size: 14px; line-height: 1.65; color: #1a1a2e; }
.studio-chat-msg-body p { margin: 0 0 8px; }
.studio-chat-msg-body p:last-child { margin-bottom: 0; }
.studio-chat-msg-body h1, .studio-chat-msg-body h2, .studio-chat-msg-body h3 {
  margin: 12px 0 6px; font-weight: 600; line-height: 1.4;
}
.studio-chat-msg-body h1 { font-size: 1.3em; }
.studio-chat-msg-body h2 { font-size: 1.2em; }
.studio-chat-msg-body h3 { font-size: 1.1em; }
.studio-chat-msg-body ul, .studio-chat-msg-body ol { margin: 6px 0 8px; padding-left: 22px; }
.studio-chat-msg-body li { margin: 2px 0; }
.studio-chat-msg-body pre {
  background: #f0f0f5; border-radius: 8px; padding: 10px 13px;
  overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 8px 0; position: relative;
}
.studio-chat-msg-body code {
  background: #f0f0f5; padding: 1px 5px; border-radius: 4px;
  font-size: 0.9em; font-family: 'SF Mono', 'Consolas', monospace;
}
.studio-chat-msg-body pre code { background: none; padding: 0; }
.studio-chat-msg-body blockquote { border-left: 3px solid #4D6BFE; margin: 8px 0; padding: 4px 12px; color: #555; }
.studio-chat-msg-body a { color: #4D6BFE; text-decoration: none; }
.studio-chat-msg-body a:hover { text-decoration: underline; }
.studio-chat-msg-body table { border-collapse: collapse; margin: 8px 0; font-size: 13px; display: block; overflow-x: auto; }
.studio-chat-msg-body th, .studio-chat-msg-body td { border: 1px solid #e0e0e8; padding: 6px 10px; text-align: left; }
.studio-chat-msg-body th { background: #f0f0f5; font-weight: 600; }

/* \u4EE3\u7801\u5757\u6807\u7B7E + \u590D\u5236 */
.studio-chat-code-lang {
  position: absolute; top: 4px; right: 4px;
  font-size: 11px; color: #999; background: rgba(255,255,255,0.6);
  padding: 1px 6px; border-radius: 4px; pointer-events: none;
}
.studio-chat-code-copy {
  position: absolute; top: 4px; right: 4px;
  display: none; padding: 1px 6px; font-size: 11px;
  color: #888; background: #fff; border: 1px solid #e0e0e8; border-radius: 4px; cursor: pointer;
}
.studio-chat-msg-body pre:hover .studio-chat-code-copy { display: inline-block; }
.studio-chat-code-copy:hover { color: #4D6BFE; border-color: #4D6BFE; }

/* \u8F93\u5165\u533A */
.studio-chat-composer {
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid #e8e8ee;
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.studio-chat-input {
  flex: 1;
  border: 1px solid #d8d8e0;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  max-height: 120px;
  outline: none;
  transition: border-color 0.15s ease;
  line-height: 1.5;
}
.studio-chat-input:focus { border-color: #4D6BFE; }
.studio-chat-input:disabled { background: #f5f5f8; color: #aaa; }
.studio-chat-send {
  flex-shrink: 0;
  padding: 8px 18px;
  border: none;
  border-radius: 10px;
  background: #4D6BFE;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.studio-chat-send:hover:not(:disabled) { background: #3a55d8; }
.studio-chat-send:disabled { background: #c0c0cc; cursor: not-allowed; }
`;

  // src/ui/studio-ui-install.ts
  function installStudioUI(options2) {
    console.log("[StudioUI] install start, document.body:", !!document.body);
    setHostBridge(options2.host);
    const containers = [];
    let sidebarHandle = null;
    let destroyed = false;
    function mount() {
      if (destroyed) return;
      if (!document.body) {
        console.log("[StudioUI] waiting for document.body...");
        document.addEventListener("DOMContentLoaded", mount, { once: true });
        return;
      }
      console.log("[StudioUI] mounting to document.body");
      if (options2.enableSidebar !== false) {
        try {
          sidebarHandle = createSidebar();
          document.body.appendChild(sidebarHandle.container);
          containers.push(sidebarHandle.container);
          console.log("[StudioUI] sidebar installed (collapsible floating panel)");
        } catch (e) {
          console.error("[StudioUI] sidebar failed:", e);
        }
      }
      if (options2.enableInputBar !== false) {
        try {
          const inputBar = createInputBar();
          let injected = injectIntoChatInput(inputBar.container);
          if (!injected) {
            console.log("[StudioUI] input bar not injected yet, waiting for DOM...");
            const observer = new MutationObserver(() => {
              if (inputBar.container.isConnected) {
                observer.disconnect();
                return;
              }
              const ok = injectIntoChatInput(inputBar.container);
              if (ok) {
                console.log("[StudioUI] input bar injected via MutationObserver");
                observer.disconnect();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => observer.disconnect(), 1e4);
          }
          setTimeout(() => {
            if (!inputBar.container.isConnected) {
              console.log("[StudioUI] input bar fallback to fixed positioning");
              inputBar.container.style.position = "fixed";
              inputBar.container.style.bottom = "115px";
              inputBar.container.style.left = "50%";
              inputBar.container.style.transform = "translateX(-50%)";
              inputBar.container.style.zIndex = "2147483646";
              inputBar.container.style.pointerEvents = "auto";
              inputBar.container.style.width = "min(600px, 80vw)";
              document.body.appendChild(inputBar.container);
            }
          }, 2e3);
          containers.push(inputBar.container);
          console.log("[StudioUI] input bar setup done");
        } catch (e) {
          console.error("[StudioUI] input bar failed:", e);
        }
      }
      try {
        const settingsPanel = createSettingsPanel();
        document.body.appendChild(settingsPanel.container);
        containers.push(settingsPanel.container);
        console.log("[StudioUI] settings panel installed");
      } catch (e) {
        console.error("[StudioUI] settings panel failed:", e);
      }
      try {
        const projectPicker = createProjectPicker();
        document.body.appendChild(projectPicker.container);
        containers.push(projectPicker.container);
        console.log("[StudioUI] project picker installed");
      } catch (e) {
        console.error("[StudioUI] project picker failed:", e);
      }
      try {
        const skillsPanel = createSkillsPanel();
        document.body.appendChild(skillsPanel.container);
        containers.push(skillsPanel.container);
        console.log("[StudioUI] skills panel installed");
      } catch (e) {
        console.error("[StudioUI] skills panel failed:", e);
      }
      try {
        const mcpDialog = createMcpConfigDialog();
        document.body.appendChild(mcpDialog.container);
        containers.push(mcpDialog.container);
        console.log("[StudioUI] mcp dialog installed");
      } catch (e) {
        console.error("[StudioUI] mcp dialog failed:", e);
      }
      try {
        const rightSidebar = createRightSidebar();
        document.body.appendChild(rightSidebar.container);
        document.body.appendChild(rightSidebar.toggle);
        containers.push(rightSidebar.container);
        containers.push(rightSidebar.toggle);
        console.log("[StudioUI] right sidebar installed");
      } catch (e) {
        console.error("[StudioUI] right sidebar failed:", e);
      }
      try {
        const chatCfg = globalThis.__studioChatConfig;
        if (chatCfg && chatCfg.token && chatCfg.roomId) {
          const chatRoom = createChatRoom(chatCfg);
          document.body.appendChild(chatRoom.container);
          containers.push(chatRoom.container);
          console.log("[StudioUI] chat room installed:", chatCfg.roomName);
        } else {
          console.warn("[StudioUI] chat room skipped: no __studioChatConfig (config.json missing chatRooms?)");
        }
      } catch (e) {
        console.error("[StudioUI] chat room failed:", e);
      }
      globalEvents.on("ui:new-task", () => {
        const candidates = [
          'button[aria-label="\u65B0\u5BF9\u8BDD"]',
          'button[title="\u65B0\u5BF9\u8BDD"]',
          'button[aria-label="New chat"]',
          'button[title="New chat"]',
          'a[href="/"]',
          ".new-chat",
          '[class*="new-chat"]',
          '[class*="newChat"]',
          "nav button:first-child"
        ];
        for (const sel of candidates) {
          const btn = document.querySelector(sel);
          if (btn) {
            btn.click();
            return;
          }
        }
        const textarea = document.querySelector("textarea");
        if (textarea) {
          textarea.value = "";
          textarea.focus();
        }
      });
      globalEvents.on("ui:scheduled-tasks", () => {
        console.log("[StudioUI] scheduled tasks not yet implemented");
      });
      console.log("[StudioUI] install complete, containers:", containers.length);
      (async () => {
        try {
          const mcpResult = await callHostTool("mcp.list", {});
          if (mcpResult.ok && mcpResult.data && Array.isArray(mcpResult.data.servers)) {
            globalState.mcpServers = [...mcpResult.data.servers];
            console.log("[StudioUI] loaded MCP servers:", globalState.mcpServers);
          }
        } catch (e) {
          console.warn("[StudioUI] load MCP servers failed:", e instanceof Error ? e.message : String(e));
        }
        try {
          const skillResult = await callHostTool("skill.list", {});
          if (skillResult.ok && skillResult.data && Array.isArray(skillResult.data.skills)) {
            globalState.skills = skillResult.data.skills;
            console.log("[StudioUI] loaded skills:", globalState.skills.length);
          }
        } catch (e) {
          console.warn("[StudioUI] load skills failed:", e instanceof Error ? e.message : String(e));
        }
      })();
      document.addEventListener("keydown", handleKeydown);
    }
    function handleKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        globalEvents.emit("ui:settings");
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        sidebarHandle?.toggle();
      }
    }
    mount();
    return {
      destroy: () => {
        destroyed = true;
        document.removeEventListener("keydown", handleKeydown);
        for (const c of containers) {
          c.remove();
        }
      },
      toggleSidebar: () => {
        sidebarHandle?.toggle();
      }
    };
  }
  function injectIntoChatInput(barContainer) {
    const toolbarSelectors = [
      // 完整路径（用户提供）
      "#root > div > div.c3ecdb44 > div._7780f2e > div > div.ds-virtual-list > div._871cbca > div.aaff8b8f > div > div > div.ec4f5d61 > div._58b31c9",
      // 简化路径
      "#root div.ec4f5d61 > div._58b31c9",
      "div.ec4f5d61 > div._58b31c9",
      "div.ec4f5d61 div._58b31c9",
      ".ec4f5d61 ._58b31c9"
    ];
    for (const selector of toolbarSelectors) {
      const toolbar2 = document.querySelector(selector);
      if (toolbar2 && !toolbar2.closest(".studio-ui-root")) {
        console.log("[StudioUI] inject: found toolbar via selector:", selector);
        barContainer.style.cssText = "display:flex;align-items:center;gap:2px;margin-right:4px;pointer-events:auto;flex-shrink:0;";
        toolbar2.insertBefore(barContainer, toolbar2.firstChild);
        return true;
      }
    }
    console.log("[StudioUI] inject: exact selectors not found, falling back to scan");
    const allDivs = document.querySelectorAll("div:not(.studio-ui-root div)");
    let toolbar = null;
    let bestScore = 0;
    for (const div of allDivs) {
      if (div.closest(".studio-ui-root")) continue;
      const style = window.getComputedStyle(div);
      if (style.display !== "flex") continue;
      const buttons = div.querySelectorAll("button");
      if (buttons.length < 2) continue;
      const rect = div.getBoundingClientRect();
      if (rect.bottom < window.innerHeight * 0.7) continue;
      const score = buttons.length * 10 + rect.bottom;
      if (score > bestScore) {
        bestScore = score;
        toolbar = div;
      }
    }
    if (toolbar) {
      console.log("[StudioUI] inject: found toolbar via scan, buttons:", toolbar.querySelectorAll("button").length, "bottom:", toolbar.getBoundingClientRect().bottom);
      barContainer.style.cssText = "display:flex;align-items:center;gap:2px;margin-right:4px;pointer-events:auto;flex-shrink:0;";
      toolbar.insertBefore(barContainer, toolbar.firstChild);
      return true;
    }
    console.log("[StudioUI] inject: no toolbar found");
    return false;
  }

  // src/desktop/entry.ts
  var DEFAULT_HOST_URL = "ws://127.0.0.1:8760/studio";
  function defaultCapabilities() {
    return [
      createEchoCapability(),
      createChatReadCapability(),
      createChatInsertCapability(),
      createChatSendCapability()
    ];
  }
  function dedupeById(caps) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const c of caps) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }
  function installStudio(options2 = {}) {
    const origin2 = globalThis.location?.origin ?? "https://chat.deepseek.com";
    const sessionId = options2.sessionId ?? crypto.randomUUID();
    const botId = options2.botId ?? globalThis.__studioBotId ?? "main";
    const capabilities2 = dedupeById([...defaultCapabilities(), ...options2.capabilities ?? []]);
    const executable = capabilities2;
    const host = createHostClient({
      url: options2.hostUrl ?? DEFAULT_HOST_URL,
      capabilities: executable,
      reportError: options2.reportError,
      botId
    });
    const bridge = installDirectBridge({ origin: origin2, sessionId, reportError: options2.reportError });
    bootstrapInjection({
      capabilities: capabilities2,
      originWhitelist: options2.originWhitelist,
      lifecycleFactory: options2.lifecycleFactory,
      strictInstallOrder: false
    });
    if (typeof globalThis.document !== "undefined") host.connect();
    const isBotWindow = botId !== "main";
    if (typeof globalThis.document !== "undefined") {
      let chatUI;
      if (!isBotWindow) {
        try {
          chatUI = createStudioChatUI();
          const mount = () => {
            try {
              document.body.appendChild(chatUI.container);
            } catch {
            }
          };
          if (document.body) {
            mount();
          } else {
            document.addEventListener("DOMContentLoaded", mount, { once: true });
          }
        } catch (err) {
          options2.reportError?.("failed to create studio chat UI", err);
        }
      }
      try {
        installMainWorldInterceptor({
          sender: (req) => host.sendToolCall(req),
          diag: (msg2) => host.log(`[interceptor] ${msg2}`),
          onAssistantReply: (text, loop) => host.assistantReply(text, loop),
          onMemoriesUpdate: (memories) => {
            globalThis.__studioMemories = memories;
          },
          chatUI
        });
      } catch (err) {
        options2.reportError?.("failed to install main-world interceptor", err);
      }
    }
    const target = globalThis.window ?? globalThis;
    target.__deepseekStudio = {
      origin: origin2,
      sessionId,
      bridge,
      authority: "resident-host",
      host
    };
    if (options2.freezeStudio === true) freezeStudioObject();
    if (typeof globalThis.document !== "undefined") {
      startIntegrityProbe({
        intervalMs: options2.integrityIntervalMs,
        onViolation: (alert) => {
          options2.reportError?.(`integrity violation: ${alert.reason}${alert.detail ? ` (${alert.detail})` : ""}`);
          host.reportIntegrity(alert);
        }
      });
    }
    if (!isBotWindow && typeof globalThis.document !== "undefined") {
      const mountStudioUI = () => {
        try {
          installStudioUI({
            host: {
              sendToolCall: (req) => host.sendToolCall(req),
              log: (t) => host.log(t)
            }
          });
          console.log("[StudioUI] installed");
        } catch (err) {
          console.error("[StudioUI] install failed", err);
        }
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mountStudioUI, { once: true });
      } else {
        mountStudioUI();
      }
    }
    return { bridge, origin: origin2, sessionId, host };
  }
  if (typeof globalThis.document !== "undefined" && typeof globalThis.WebSocket !== "undefined" && !globalThis.window?.__deepseekStudio) {
    try {
      installStudio();
    } catch (err) {
      console.error("[installStudio] auto-init failed", err);
    }
  }
})();
