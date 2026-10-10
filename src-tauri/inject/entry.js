"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/bridge/envelope.ts
  var DEEPSEEK_CONTENT_RUNTIME_COMMANDS = /* @__PURE__ */ new Set([
    "bridge_invoke",
    "kv_get",
    "kv_set",
    "kv_remove",
    "kv_list",
    "tool_execute",
    "tool_cancel",
    "agent_turn",
    "agent_cancel",
    "capability_start",
    "capability_stop",
    "ping",
    "pong"
  ]);
  function createRuntimeBoundaryErrorResponse(_requestId, code, message) {
    return {
      ok: false,
      error: { code, message }
    };
  }
  function decodeRuntimeMessageEnvelope(raw) {
    if (raw === null || typeof raw !== "object") return null;
    const rec = raw;
    if (typeof rec.command !== "string") return null;
    if (typeof rec.requestId !== "string") return null;
    return {
      command: rec.command,
      requestId: rec.requestId,
      payload: rec.payload === void 0 ? null : rec.payload
    };
  }
  function authorizeRuntimeMessage(envelope) {
    return DEEPSEEK_CONTENT_RUNTIME_COMMANDS.has(envelope.command);
  }
  function isPlainRuntimeRecord(value) {
    if (value === null || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
  }

  // src/bridge/runtime.ts
  var NO_RESPONSE = Symbol("no-response");
  var DEFAULT_TIMEOUT_MS = 3e4;
  function createRuntimeLastErrorController() {
    let current;
    return {
      set(error) {
        current = error;
      },
      get() {
        return current;
      },
      clear() {
        current = void 0;
      }
    };
  }
  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        () => {
          clearTimeout(timer);
          resolve(fallback);
        }
      );
    });
  }
  function createRuntimeBridge(options) {
    const listeners = [...options.listeners ?? []];
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const lastError = options.lastError ?? createRuntimeLastErrorController();
    async function dispatch(envelope, sender, timeoutMs2) {
      let responded = false;
      let settle;
      const sendResponsePromise = new Promise((res) => {
        settle = res;
      });
      const sendResponse = (value) => {
        if (!responded) {
          responded = true;
          settle(value);
        }
      };
      for (const listener of listeners) {
        const raw = listener(envelope, sender, sendResponse);
        if (raw === true) {
          const value = await withTimeout(sendResponsePromise, timeoutMs2, NO_RESPONSE);
          if (value !== NO_RESPONSE) return value;
        } else if (raw instanceof Promise) {
          const value = await withTimeout(Promise.resolve(raw), timeoutMs2, NO_RESPONSE);
          if (value !== NO_RESPONSE) return value;
        }
      }
      return NO_RESPONSE;
    }
    return {
      addListener(listener) {
        if (!listeners.includes(listener)) listeners.push(listener);
      },
      removeListener(listener) {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      },
      async post(envelope, sender = {}) {
        return options.transport.post(envelope, sender);
      },
      async handle(envelope, sender = {}) {
        if (!authorizeRuntimeMessage(envelope)) {
          const code = "UNAUTHORIZED";
          lastError.set({ message: `command not authorized: ${envelope.command}` });
          return createRuntimeBoundaryErrorResponse(envelope.requestId, code, lastError.get().message);
        }
        const value = await dispatch(envelope, sender, timeoutMs);
        if (value === NO_RESPONSE) return createRuntimeBoundaryErrorResponse(envelope.requestId, "DISPATCH_TIMEOUT", "no receiver responded");
        return value;
      },
      lastError
    };
  }

  // src/bridge/storage.ts
  var QUOTA_BYTES = 10485760;
  var StorageBridgeError = class extends Error {
    constructor(code, message) {
      super(message);
      __publicField(this, "code");
      this.name = "StorageBridgeError";
      this.code = code;
    }
  };
  function utf8ByteLength(value) {
    return new TextEncoder().encode(value).length;
  }
  function cloneStorageValue(value, path = "value") {
    return cloneValue(value, path, /* @__PURE__ */ new Set());
  }
  function cloneValue(value, path, ancestors) {
    if (value === null) return null;
    const valueType = typeof value;
    if (valueType === "boolean" || valueType === "string") return value;
    if (valueType === "number") {
      if (!Number.isFinite(value)) {
        throw new StorageBridgeError("DATA_CLONE", `Storage value at ${path} is not a finite number.`);
      }
      return value;
    }
    if (valueType === "undefined") {
      throw new StorageBridgeError("DATA_CLONE", `Storage value at ${path} is undefined.`);
    }
    if (valueType === "function" || valueType === "symbol" || valueType === "bigint") {
      throw new StorageBridgeError(
        "DATA_CLONE",
        `Storage value at ${path} is not JSON-serializable (${valueType}).`
      );
    }
    const objectValue = value;
    if (ancestors.has(objectValue)) {
      throw new StorageBridgeError("DATA_CLONE", `Storage value at ${path} is circular.`);
    }
    ancestors.add(objectValue);
    try {
      if (Array.isArray(value)) {
        return value.map((item, index) => cloneValue(item, `${path}[${index}]`, ancestors));
      }
      if (!isPlainRuntimeRecord(value)) {
        throw new StorageBridgeError(
          "DATA_CLONE",
          `Storage value at ${path} must be a plain object or an array.`
        );
      }
      const out = {};
      for (const key of Object.keys(value)) {
        out[key] = cloneValue(value[key], `${path}.${key}`, ancestors);
      }
      return out;
    } finally {
      ancestors.delete(objectValue);
    }
  }
  function createMemoryStorageKvBackend(initial = {}) {
    const data = { ...initial };
    return {
      async readAll() {
        return { ...data };
      },
      async writeBatch(batch) {
        for (const key of batch.remove) delete data[key];
        for (const [key, value] of Object.entries(batch.set)) data[key] = value;
      },
      snapshot() {
        return { ...data };
      }
    };
  }
  function bytesInUseOf(data) {
    if (Object.keys(data).length === 0) return 0;
    return utf8ByteLength(JSON.stringify(data));
  }
  function sameJsonValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function normalizeKeyList(keys) {
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) {
      for (const key of keys) {
        if (typeof key !== "string") {
          throw new StorageBridgeError("INVALID_KEYS", "Storage keys must be strings.");
        }
      }
      return [...keys];
    }
    throw new StorageBridgeError("INVALID_KEYS", "Storage keys must be a string or an array of strings.");
  }
  function runOperation(callback, operation, lastError) {
    if (callback === void 0) return operation();
    void operation().then(
      (value) => {
        callback(value);
      },
      (error) => {
        lastError?.set({ message: error instanceof Error ? error.message : String(error) });
        callback(void 0);
      }
    );
    return void 0;
  }
  function createStorageArea(deps) {
    const items = /* @__PURE__ */ new Map();
    let loadPromise = null;
    function ensureLoaded() {
      if (deps.backend === null) return Promise.resolve();
      if (loadPromise === null) {
        loadPromise = deps.backend.readAll().then((loaded) => {
          for (const [key, value] of Object.entries(loaded ?? {})) {
            if (value !== void 0) items.set(key, value);
          }
        });
      }
      return loadPromise;
    }
    async function commit(next, changes, batch) {
      const bytes = bytesInUseOf(Object.fromEntries(next));
      if (bytes > deps.quotaBytes) {
        throw new StorageBridgeError(
          "QUOTA_BYTES",
          `Storage area ${deps.name} would exceed QUOTA_BYTES (${deps.quotaBytes}).`
        );
      }
      if (deps.backend !== null && (Object.keys(batch.set).length > 0 || batch.remove.length > 0)) {
        try {
          await deps.backend.writeBatch(batch);
        } catch (error) {
          throw new StorageBridgeError(
            "KV_PERSIST_FAILED",
            `Storage area ${deps.name} failed to persist: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      items.clear();
      for (const [key, value] of next) items.set(key, value);
      if (Object.keys(changes).length > 0) deps.emit(changes, deps.name);
    }
    async function getOperation(keys) {
      await ensureLoaded();
      const result = {};
      if (keys === void 0 || keys === null) {
        for (const [key, value] of items) result[key] = value;
        return result;
      }
      if (typeof keys === "string") {
        if (items.has(keys)) result[keys] = items.get(keys);
        return result;
      }
      if (Array.isArray(keys)) {
        for (const key of normalizeKeyList(keys)) {
          if (items.has(key)) result[key] = items.get(key);
        }
        return result;
      }
      if (isPlainRuntimeRecord(keys)) {
        for (const [key, fallback] of Object.entries(keys)) {
          result[key] = items.has(key) ? items.get(key) : fallback;
        }
        return result;
      }
      throw new StorageBridgeError(
        "INVALID_KEYS",
        "storage.get keys must be a string, an array of strings, or a defaults object."
      );
    }
    async function setOperation(entries) {
      await ensureLoaded();
      if (!isPlainRuntimeRecord(entries)) {
        throw new StorageBridgeError("INVALID_KEYS", "storage.set expects a plain object.");
      }
      const cloned = {};
      for (const [key, value] of Object.entries(entries)) {
        cloned[key] = cloneStorageValue(value, `set.${key}`);
      }
      const next = new Map(items);
      const changes = {};
      for (const [key, value] of Object.entries(cloned)) {
        const previous = items.has(key) ? items.get(key) : void 0;
        next.set(key, value);
        if (!sameJsonValue(previous, value)) {
          changes[key] = { oldValue: previous, newValue: value };
        }
      }
      await commit(next, changes, { set: cloned, remove: [] });
    }
    async function removeOperation(keys) {
      await ensureLoaded();
      const list = normalizeKeyList(keys);
      const next = new Map(items);
      const changes = {};
      const removed = [];
      for (const key of list) {
        if (!items.has(key)) continue;
        const previous = items.get(key);
        next.delete(key);
        removed.push(key);
        changes[key] = { oldValue: previous, newValue: void 0 };
      }
      await commit(next, changes, { set: {}, remove: removed });
    }
    async function clearOperation() {
      await ensureLoaded();
      const changes = {};
      const removed = [];
      for (const [key, value] of items) {
        changes[key] = { oldValue: value, newValue: void 0 };
        removed.push(key);
      }
      await commit(/* @__PURE__ */ new Map(), changes, { set: {}, remove: removed });
    }
    async function getBytesInUseOperation(keys) {
      await ensureLoaded();
      if (keys === void 0 || keys === null) return bytesInUseOf(Object.fromEntries(items));
      const data = {};
      for (const key of normalizeKeyList(keys)) {
        if (items.has(key)) data[key] = items.get(key);
      }
      return bytesInUseOf(data);
    }
    return {
      name: deps.name,
      QUOTA_BYTES: deps.quotaBytes,
      get: (keys, callback) => runOperation(callback, () => getOperation(keys), deps.lastError),
      set: (entries, callback) => runOperation(callback, () => setOperation(entries), deps.lastError),
      remove: (keys, callback) => runOperation(callback, () => removeOperation(keys), deps.lastError),
      clear: (callback) => runOperation(callback, () => clearOperation(), deps.lastError),
      getBytesInUse: (keys, callback) => runOperation(callback, () => getBytesInUseOperation(keys), deps.lastError)
    };
  }
  function createChromeStorageShim(options = {}) {
    const quotaBytes = options.quotaBytes ?? QUOTA_BYTES;
    const listeners = [];
    const emitter = {
      addListener(listener) {
        if (typeof listener !== "function") {
          throw new TypeError("storage.onChanged listener must be a function.");
        }
        if (!listeners.includes(listener)) listeners.push(listener);
      },
      removeListener(listener) {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      hasListener(listener) {
        return listeners.includes(listener);
      },
      emit(changes, areaName) {
        for (const listener of [...listeners]) {
          try {
            listener(changes, areaName);
          } catch {
          }
        }
      }
    };
    const local = createStorageArea({
      name: "local",
      backend: options.localBackend ?? createMemoryStorageKvBackend(),
      quotaBytes,
      emit: emitter.emit,
      lastError: options.lastError
    });
    const session = createStorageArea({
      name: "session",
      backend: null,
      quotaBytes,
      emit: emitter.emit,
      lastError: options.lastError
    });
    return {
      local,
      session,
      onChanged: {
        addListener: emitter.addListener,
        removeListener: emitter.removeListener,
        hasListener: emitter.hasListener
      }
    };
  }

  // src/bridge/index.ts
  var STUDIO_EXTENSION_ID = "deepseek-studio";
  function noopTransport() {
    return { post: () => Promise.reject(new Error("chrome.runtime unavailable: no host transport installed")) };
  }
  function installChromeShims(options = {}) {
    const transport = options.transport ?? noopTransport();
    const bridge = createRuntimeBridge({ transport });
    const storage = createChromeStorageShim();
    const id = options.extensionId ?? STUDIO_EXTENSION_ID;
    const runtime = {
      id,
      getURL: (path) => `chrome-extension://${id}/${path.replace(/^\//, "")}`,
      getManifest: () => ({ manifest_version: 3, name: "DeepSeek++ Studio", version: "0.2.0" }),
      get lastError() {
        return bridge.lastError.get();
      },
      sendMessage: (message, callback) => {
        const envelope = decodeRuntimeMessageEnvelope(message) ?? { command: "bridge_invoke", requestId: crypto.randomUUID(), payload: message };
        const promise = bridge.post(envelope);
        if (callback) promise.then(callback, () => callback(void 0));
        return promise;
      },
      onMessage: {
        addListener: (fn) => {
          bridge.addListener((env, sender, sendResponse) => fn(env.payload, sender, sendResponse));
        },
        removeListener: () => {
        }
      }
    };
    globalThis.chrome = { runtime, storage };
  }

  // src/inject/direct-target.ts
  var buses = /* @__PURE__ */ new Map();
  function busFor(origin) {
    let bus = buses.get(origin);
    if (!bus) {
      bus = new EventTarget();
      buses.set(origin, bus);
    }
    return bus;
  }
  function createDirectTarget(origin) {
    const bus = busFor(origin);
    const wrapped = /* @__PURE__ */ new WeakMap();
    const self = {
      origin,
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
        ev.detail = { data, origin, source, ports };
        bus.dispatchEvent(ev);
      }
    };
    return self;
  }

  // src/inject/direct-port.ts
  function createDirectMessagePort(options) {
    const { target, sessionId, reportError } = options;
    const handlers = /* @__PURE__ */ new Set();
    const listener = (event) => {
      const data = event.data;
      if (!data || data.__session !== sessionId) return;
      if (data.__payload) {
        for (const h of [...handlers]) {
          try {
            h(data.__payload);
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
      onMessage(h) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close() {
        target.removeEventListener("message", listener);
        handlers.clear();
      }
    };
  }

  // src/inject/direct-bridge.ts
  function createDirectBridge(options) {
    const { target, sessionId, reportError } = options;
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
  function installDirectBridge(options) {
    const target = options.target ?? createDirectTarget(options.origin);
    const content = createDirectBridge({ target, sessionId: options.sessionId, reportError: options.reportError });
    const injected = createDirectBridge({ target, sessionId: options.sessionId, reportError: options.reportError });
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
  function normalizeOrigin(origin) {
    if (!origin) return "";
    return origin.trim().toLowerCase();
  }
  function isAllowedOrigin(locationOrigin2, whitelist = DEFAULT_ORIGIN_WHITELIST) {
    const origin = normalizeOrigin(locationOrigin2);
    if (!origin) return false;
    return whitelist.map(normalizeOrigin).includes(origin);
  }

  // src/inject/navigation.ts
  function createNavigationObserver(options = {}) {
    const enabled = options.reinjectOnRouteChange ?? false;
    const max = options.maxReinjections ?? 8;
    let count = 0;
    let stopped = false;
    const history = globalThis.history;
    const trigger = () => {
      if (stopped || !enabled) return;
      if (count >= max) {
        options.onLimit?.(count);
        return;
      }
      count += 1;
      options.onReinject?.();
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
        stopped = false;
      },
      stop() {
        stopped = true;
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
      cancelAnimationFrame: (f) => clearTimeout(f),
      ownRoot: (r) => r,
      ownPort: (r) => r,
      snapshot: () => ({ total: 0, byKind: {} })
    };
  }
  function createLocalContentLifecycle(options) {
    const caps = options.capabilities;
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
  var replaceContentDocumentLifecycle = async (options) => createLocalContentLifecycle({ capabilities: options.capabilities });

  // src/inject/loader.ts
  var SYMBOL_KEY = "deepseek-studio.injection-loader";
  var registry = /* @__PURE__ */ new Map();
  function locationOrigin() {
    return globalThis.location?.origin;
  }
  async function defaultLifecycleFactory(options) {
    return replaceContentDocumentLifecycle(options);
  }
  function createInjector(options) {
    const whitelist = options.originWhitelist ?? DEFAULT_ORIGIN_WHITELIST;
    const factory = options.lifecycleFactory ?? defaultLifecycleFactory;
    const navigation = createNavigationObserver({
      reinjectOnRouteChange: options.reinjectOnRouteChange,
      maxReinjections: options.maxReinjections,
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
      if (!ok && options.strictInstallOrder) {
        status = "failed";
        return false;
      }
      if (!ok) console.warn('[injection-loader] readyState !== "loading"; proceeding (fail-open)');
      return true;
    }
    async function startLifecycle() {
      try {
        lifecycle = await factory({
          capabilities: options.capabilities,
          onError: (error, _capabilityId) => {
            status = "failed";
            options.onStartupError?.(error);
          }
        });
        await lifecycle.start();
        status = "running";
      } catch (error) {
        status = "failed";
        options.onStartupError?.(error);
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
  function bootstrapInjection(options) {
    const sym = Symbol.for(SYMBOL_KEY);
    const existing = registry.get(sym);
    if (existing) return existing.install();
    const injector = createInjector(options);
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
  function setInputValue(el, value) {
    const fireInput = () => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      fireInput();
      return true;
    }
    if (el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      fireInput();
      return true;
    }
    if (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute("contenteditable") === "true")) {
      el.textContent = value;
      fireInput();
      return true;
    }
    return false;
  }
  function pressEnter(el) {
    const init = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  }
  function clickElement(el) {
    if (el instanceof HTMLElement) {
      el.click();
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
  function inferRole(el) {
    const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
    const head = (el.textContent ?? "").slice(0, 48);
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
        const el = queryFirst(doc, INPUT_SELECTORS);
        if (!el) return { ok: false, error: "input-not-found" };
        if (!setInputValue(el, text)) return { ok: false, error: "input-not-writable" };
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
        const legacy = input ? null : queryFirst(doc, LEGACY_SEND_SELECTORS);
        if (legacy && clickElement(legacy)) return { ok: true, data: { sent: true, via: "legacy-button" } };
        if (input) {
          pressEnter(input);
          return { ok: true, data: { sent: true, via: "enter-key" } };
        }
        return { ok: false, error: "send-button-not-found" };
      }
    };
  }

  // src/ui/consent.ts
  var STYLE_ID = "ds-consent-style";
  var CSS = `
.ds-consent-overlay {
  position: fixed; inset: 0; z-index: 2147483646;
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
    for (const it of items) {
      const b = doc.createElement("span");
      b.className = "ds-consent-badge";
      b.dataset.level = it.level;
      b.textContent = it.text;
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
    return entries.map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const shown = s.length > 32 ? `${s.slice(0, 32)}\u2026` : s;
      return `${k}: ${shown}`;
    }).join("\uFF1B");
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
    const pendingToolCalls = /* @__PURE__ */ new Map();
    function send(msg) {
      if (ws && ws.readyState === OPEN) {
        try {
          ws.send(JSON.stringify(msg));
        } catch (e) {
          options.reportError?.("host-client send failed", e);
        }
      }
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
          p.resolve({ ok: msg.ok, data: msg.data, error: msg.error });
        }
      }
    }
    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
      } catch {
        return;
      }
      handle(msg);
    }
    function connectWs() {
      if (stopped) return;
      const make = options.wsFactory ?? ((url) => new globalThis.WebSocket(url));
      const socket = make(options.url);
      ws = socket;
      socket.onopen = () => {
        backoff = 500;
        send({ type: "hello", origin, sessionId: crypto.randomUUID() });
      };
      socket.onmessage = (ev) => onMessage(ev.data);
      socket.onclose = () => {
        ws = null;
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
      setTimeout(connectWs, delay);
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
          send({ type: "tool-call", callId: req.callId, invocationName: req.invocationName, params: req.params });
        });
      },
      connect() {
        stopped = false;
        connectWs();
      },
      log(text) {
        send({ type: "log", text });
      },
      disconnect() {
        stopped = true;
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
        const lt = input.indexOf("<", i);
        if (lt === -1) {
          clean += input.slice(i);
          break;
        }
        clean += input.slice(i, lt);
        const after = input.slice(lt);
        const open = after.match(/^<([a-zA-Z_][\w-]*)>/);
        if (open && this.names.includes(open[1])) {
          const name = open[1];
          const openEnd = lt + open[0].length;
          const closeTag = `</${name}>`;
          const closeIdx = input.indexOf(closeTag, openEnd);
          if (closeIdx === -1) {
            this.tail = input.slice(lt);
            break;
          }
          const body = input.slice(openEnd, closeIdx);
          const rawBlock = input.slice(lt, closeIdx + closeTag.length);
          calls.push(this.make(name, body, rawBlock));
          i = closeIdx + closeTag.length;
        } else {
          const close = after.match(/^<\/([a-zA-Z_][\w-]*)>/);
          if (close) {
            i = lt + close[0].length;
          } else {
            i = lt + 1;
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
      } catch {
        params = {};
      }
      const id = typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return { id, invocationName: name, params, raw };
    }
  };

  // src/shared/tool-contract.ts
  var UPSTREAM_TO_STUDIO = {
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
      adapt: (p) => ({ path: typeof p.path === "string" ? p.path : "" })
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
    }
  };
  var SUPPORTED_INVOCATION_NAMES = Object.keys(UPSTREAM_TO_STUDIO);
  function isSupportedUpstreamTool(invocationName) {
    return Object.prototype.hasOwnProperty.call(UPSTREAM_TO_STUDIO, invocationName);
  }

  // src/inject/main-world-interceptor.ts
  function formatToolResultBlock(results) {
    const lines = results.map((p) => {
      const head = `[tool-result:${p.invocationName}]`;
      if (!p.ok) return `${head}
<error>${p.error ?? "unknown"}</error>`;
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
      return u.hostname.endsWith("chat.deepseek.com") && method.toUpperCase() === "POST";
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
\u4F60\u662F DeepSeek Studio \u7684\u672C\u5730\u5DE5\u5177\u4EE3\u7406\u3002\u5F53\u7528\u6237\u660E\u786E\u8981\u6C42\u8BFB\u53D6\u3001\u5199\u5165\u3001\u5217\u51FA\u6587\u4EF6\u6216\u6267\u884C\u547D\u4EE4\u65F6\uFF0C\u7528\u4E0B\u9762\u7684 XML \u6807\u7B7E\u53D1\u8D77\u4E00\u6B21\u5DE5\u5177\u8C03\u7528\uFF08\u6807\u7B7E\u4F53\u5FC5\u987B\u662F\u4E25\u683C JSON\uFF0C\u952E\u7528\u53CC\u5F15\u53F7\uFF09\uFF1A
<local_file_read>{"path":"\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84"}</local_file_read>
<local_file_write>{"path":"\u7EDD\u5BF9\u8DEF\u5F84","content":"\u8981\u5199\u5165\u7684\u6587\u672C\u5185\u5BB9"}</local_file_write>
<local_file_stat>{"path":"\u7EDD\u5BF9\u8DEF\u5F84"}</local_file_stat>
<shell_exec>{"command":"\u8981\u5728\u672C\u673A\u6267\u884C\u7684\u547D\u4EE4\u884C"}</shell_exec>
\u4EC5\u5728\u7528\u6237\u663E\u5F0F\u8981\u6C42\u65F6\u624D\u8C03\u7528\uFF0C\u4E0D\u8981\u81C6\u9020\u8DEF\u5F84\u3002\u7CFB\u7EDF\u4F1A\u771F\u5B9E\u6267\u884C\u5E76\u628A\u7ED3\u679C\u653E\u8FDB\u4E0B\u4E00\u6761\u6D88\u606F\uFF0C\u4F60\u636E\u6B64\u7EE7\u7EED\u56DE\u7B54\uFF0C\u4E0D\u8981\u81EA\u884C\u7F16\u9020\u5DE5\u5177\u7ED3\u679C\u3002`;
  function hasToolIntent(text) {
    if (!text) return false;
    return /(Studio Agent|工作区|智能体|读|写|读取|写入|查看|列出|打开|文件|目录|文件夹|执行|运行|命令|路径|file|read|write|list|cat|ls|dir|command|shell|run|execute|path)/i.test(text);
  }
  function computeIntent(parsed) {
    if (typeof parsed.prompt === "string") return hasToolIntent(parsed.prompt);
    if (Array.isArray(parsed.messages)) {
      for (let i = parsed.messages.length - 1; i >= 0; i--) {
        const m = parsed.messages[i];
        if (m.role === "user" && typeof m.content === "string") return hasToolIntent(m.content);
      }
    }
    return false;
  }
  function injectInstructionIntoMessages(messages) {
    const first = messages[0];
    if (first && first.role === "system" && typeof first.content === "string" && first.content.includes(TOOL_CAPABILITY_MARKER)) {
      return messages;
    }
    return [{ role: "system", content: TOOL_CAPABILITY_PROMPT }, ...messages];
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
  function prepareOutgoingBody(rawBody, pending) {
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const intent = computeIntent(parsed);
    const hasResults = pending.length > 0;
    if (!intent && !hasResults) return null;
    const block = hasResults ? formatToolResultBlock(pending.slice()) : "";
    if (Array.isArray(parsed.messages)) {
      let msgs = parsed.messages;
      if (intent) msgs = injectInstructionIntoMessages(msgs);
      if (hasResults) msgs = appendResultsToMessages(msgs, block);
      parsed.messages = msgs;
    } else if (typeof parsed.prompt === "string") {
      let prompt = parsed.prompt;
      if (intent && !prompt.includes(TOOL_CAPABILITY_MARKER)) {
        prompt = `${TOOL_CAPABILITY_PROMPT}

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
  }) {
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
      const response = await origFetch(input, init);
      if (!response.body) return response;
      const parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              const { calls, clean } = parser.feed(text);
              for (const c of calls) forward(c);
              if (clean) controller.enqueue(encoder.encode(clean));
            }
            const fin = parser.flush();
            for (const c of fin.calls) forward(c);
            if (fin.clean) controller.enqueue(encoder.encode(fin.clean));
          } catch (err) {
            controller.error(err);
            return;
          }
          controller.close();
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
  }) {
    if (typeof XMLHttpRequest === "undefined") return () => {
    };
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
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
      if (isChat && typeof body === "string") {
        diag(`xhr chat body len=${body.length} head=${body.slice(0, 200)}`);
        const next = prepareOutgoingBody(body, pending);
        if (next !== null) {
          body = next;
          diag(`xhr chat body injected len=${next.length}`);
        }
      }
      const xhr = this;
      const prev = xhr.onreadystatechange;
      xhr.onreadystatechange = function(...args) {
        if (xhr.readyState >= 3) {
          const text = xhr.responseText;
          const scanned = xhr.__dsScanned ?? 0;
          const part = text.slice(scanned);
          xhr.__dsScanned = text.length;
          if (part) {
            let parser = xhr.__dsParser;
            if (!parser) {
              parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
              xhr.__dsParser = parser;
            }
            const { calls } = parser.feed(part);
            for (const c of calls) forward(c);
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
  function installMainWorldInterceptor(sender, diag) {
    const pending = [];
    const d = diag ?? (() => {
    });
    const forward = (call) => {
      if (!isSupportedUpstreamTool(call.invocationName)) {
        return;
      }
      const callId = call.id || crypto.randomUUID();
      void sender({ callId, invocationName: call.invocationName, params: call.params }).then((r) => {
        pending.push({ invocationName: call.invocationName, ok: r.ok, result: r.data, error: r.error });
      }).catch((e) => {
        pending.push({ invocationName: call.invocationName, ok: false, error: e instanceof Error ? e.message : String(e) });
      });
    };
    const origFetch = window.fetch ? window.fetch.bind(window) : void 0;
    const stopFetch = origFetch ? installFetchHook(origFetch, forward, pending, d) : void 0;
    const stopXhr = installXhrHooks(forward, pending, d);
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
      }
    };
  }

  // src/desktop/integrity.ts
  var DEFAULT_MEMBERS = ["bridge", "host", "authority", "sessionId"];
  var DEFAULT_INTERVAL_MS = 5e3;
  var STUDIO_KEY = "__deepseekStudio";
  function defaultRead() {
    const w = globalThis.window ?? globalThis;
    return w[STUDIO_KEY];
  }
  function freezeStudioObject() {
    try {
      const w = globalThis.window ?? globalThis;
      const target = w;
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
  function startIntegrityProbe(options) {
    const read = options.read ?? defaultRead;
    const members = options.members ?? DEFAULT_MEMBERS;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));
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
    let stopped = false;
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
          const w = globalThis.window ?? globalThis;
          const desc = Object.getOwnPropertyDescriptor(w, STUDIO_KEY);
          if (desc && (desc.configurable !== false || desc.writable !== false)) {
            return { reason: "descriptor-downgraded" };
          }
        } catch {
        }
      }
      return null;
    }
    const timer = setIntervalFn(() => {
      if (stopped || fired) return;
      const alert = detect();
      if (alert) {
        fired = true;
        options.onViolation(alert);
      }
    }, intervalMs);
    return {
      check() {
        const alert = detect();
        if (alert && !fired) {
          fired = true;
          options.onViolation(alert);
        }
        return alert;
      },
      stop() {
        stopped = true;
        clearIntervalFn(timer);
      }
    };
  }

  // src/desktop/entry.ts
  var DEFAULT_HOST_URL = "ws://127.0.0.1:8756/studio";
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
  function installStudio(options = {}) {
    const origin = globalThis.location?.origin ?? "https://chat.deepseek.com";
    const sessionId = options.sessionId ?? crypto.randomUUID();
    installChromeShims();
    const bridge = installDirectBridge({ origin, sessionId, reportError: options.reportError });
    const capabilities = dedupeById([...defaultCapabilities(), ...options.capabilities ?? []]);
    bootstrapInjection({
      capabilities,
      originWhitelist: options.originWhitelist,
      lifecycleFactory: options.lifecycleFactory,
      strictInstallOrder: false
    });
    const executable = capabilities;
    const host = createHostClient({
      url: options.hostUrl ?? DEFAULT_HOST_URL,
      capabilities: executable,
      reportError: options.reportError
    });
    if (typeof globalThis.document !== "undefined") host.connect();
    if (typeof globalThis.document !== "undefined") {
      try {
        installMainWorldInterceptor(
          (req) => host.sendToolCall(req),
          (msg) => host.log(`[interceptor] ${msg}`)
        );
      } catch (err) {
        options.reportError?.("failed to install main-world interceptor", err);
      }
    }
    const target = globalThis.window ?? globalThis;
    target.__deepseekStudio = {
      origin,
      sessionId,
      bridge,
      authority: "resident-host",
      host
    };
    if (options.freezeStudio === true) freezeStudioObject();
    if (typeof globalThis.document !== "undefined") {
      startIntegrityProbe({
        intervalMs: options.integrityIntervalMs,
        onViolation: (alert) => {
          options.reportError?.(`integrity violation: ${alert.reason}${alert.detail ? ` (${alert.detail})` : ""}`);
          host.reportIntegrity(alert);
        }
      });
    }
    return { bridge, origin, sessionId, host };
  }
  if (typeof globalThis.document !== "undefined" && typeof globalThis.WebSocket !== "undefined" && !globalThis.window?.__deepseekStudio) {
    try {
      installStudio();
    } catch (err) {
      console.error("[installStudio] auto-init failed", err);
    }
  }
})();
