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
    let mutationTail = Promise.resolve();
    function enqueueMutation(op) {
      const run = mutationTail.then(() => op());
      mutationTail = run.then(
        () => void 0,
        () => void 0
      );
      return run;
    }
    return {
      name: deps.name,
      QUOTA_BYTES: deps.quotaBytes,
      get: (keys, callback) => runOperation(callback, () => getOperation(keys), deps.lastError),
      set: (entries, callback) => runOperation(callback, () => enqueueMutation(() => setOperation(entries)), deps.lastError),
      remove: (keys, callback) => runOperation(callback, () => enqueueMutation(() => removeOperation(keys)), deps.lastError),
      clear: (callback) => runOperation(callback, () => enqueueMutation(() => clearOperation()), deps.lastError),
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
    const storage = createChromeStorageShim({ localBackend: options.localBackend });
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
      assistantReply(text, loop) {
        send({ type: "assistant-reply", text, loop });
      },
      kvGet(key) {
        return new Promise((resolve, reject) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve(void 0);
            return;
          }
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => {
            pendingKv.delete(requestId);
            reject(new Error("kv-get timeout"));
          }, 3e4);
          pendingKv.set(requestId, { resolve: (v, err) => {
            clearTimeout(timer);
            err ? reject(new Error(err)) : resolve(v);
          } });
          send({ type: "kv-get", requestId, key });
        });
      },
      kvSet(key, value) {
        return new Promise((resolve, reject) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve();
            return;
          }
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => {
            pendingKv.delete(requestId);
            reject(new Error("kv-set timeout"));
          }, 3e4);
          pendingKv.set(requestId, { resolve: (_v, err) => {
            clearTimeout(timer);
            err ? reject(new Error(err)) : resolve();
          } });
          send({ type: "kv-set", requestId, key, value });
        });
      },
      kvRemove(key) {
        return new Promise((resolve, reject) => {
          if (!ws || ws.readyState !== OPEN) {
            resolve();
            return;
          }
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => {
            pendingKv.delete(requestId);
            reject(new Error("kv-remove timeout"));
          }, 3e4);
          pendingKv.set(requestId, { resolve: (_v, err) => {
            clearTimeout(timer);
            err ? reject(new Error(err)) : resolve();
          } });
          send({ type: "kv-remove", requestId, key });
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
          pendingEnvelope.set(envelope.requestId, { resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          } });
          send({ type: "runtime-envelope", envelope });
        });
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
          if (close && this.names.includes(close[1])) {
            i = lt + close[0].length;
          } else if (/^<\/?[a-zA-Z_][\w-]*$/.test(after) || /^<\/?$/.test(after)) {
            this.tail = input.slice(lt);
            break;
          } else {
            clean += "<";
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
      } catch (e) {
        params = { __invalid_json: true, __error: e instanceof Error ? e.message : String(e), __raw: body };
      }
      const id = typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return { id, invocationName: name, params, raw };
    }
  };

  // src/inject/sse-text-extractor.ts
  var SseTextStreamExtractor = class {
    constructor() {
      /** 尚未遇到换行的不完整行（跨 chunk 保留）。 */
      __publicField(this, "lineBuffer", "");
      /** 当前活跃 fragment 类型：THINK 时跳过单字符增量，RESPONSE 时保留。 */
      __publicField(this, "activeFragmentType", null);
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
    /** 解析一行 SSE，更新 fragment 类型状态，返回可见文本（THINK 段返回空串）。 */
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
          if (frag.type === "THINK") continue;
          if (typeof frag.content === "string") out += frag.content;
        }
        return out;
      }
      if (typeof obj.v === "string") {
        const p = String(obj.p ?? "");
        if (p && p !== "response/fragments/-1/content") return "";
        return this.activeFragmentType === "THINK" ? "" : obj.v;
      }
      if (Array.isArray(obj.v)) {
        let out = "";
        for (const item of obj.v) {
          if (!item || typeof item !== "object") continue;
          const frag = item;
          if (frag.type === "THINK") continue;
          if (typeof frag.content === "string") out += frag.content;
        }
        return out;
      }
      return "";
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
  };
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
  function legacyResultText(result) {
    if (result.error) return result.error;
    if (result.data == null) return "";
    if (typeof result.data === "object" && result.data !== null && "stdout" in result.data) {
      const d = result.data;
      const stdout = typeof d.stdout === "string" ? d.stdout : "";
      const stderr = typeof d.stderr === "string" ? d.stderr : "";
      const exitCode = d.exitCode;
      const cleanStderr = stderr.replace(/#< CLIXML[\s\S]*?<\/Objs>/g, "").replace(/System\.Management\.Automation\.[\s\S]*?Completed-1/g, "").replace(/\bCompleted-1\b/g, "").replace(/Preparing modules for first use\./g, "").trim();
      const parts = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (cleanStderr) parts.push(`[stderr]
${cleanStderr}`);
      if (!result.ok && exitCode !== void 0 && exitCode !== 0) {
        parts.push(`[exit-code] ${exitCode}`);
      }
      return parts.join("\n\n") || "(empty output)";
    }
    if (typeof result.data === "string") return result.data;
    return formatJson(result.data);
  }
  function formatToolResultText(result) {
    const contentText = joinContent(result.content);
    const base = contentText !== null ? contentText : legacyResultText(result);
    if (result.isError !== true) return base;
    return base ? `[\u9519\u8BEF] ${base}` : "[\u9519\u8BEF]";
  }
  function shouldSkipAutoContinue(results) {
    if (!Array.isArray(results) || results.length === 0) return false;
    return results.every((r) => !!r && r.terminate === true);
  }

  // src/inject/pow-wasm.ts
  var WASM_BASE64 = "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ADYCAEGEocAAQfigwAA2AgBBgKHAAEH4oMAANgIAQYyhwABBgKHAADYCAEGIocAAQYChwAA2AgBBlKHAAEGIocAANgIAQZChwABBiKHAADYCAEGcocAAQZChwAA2AgBBpKHAAEGYocAANgIAQZihwABBkKHAADYCAEGsocAAQaChwAA2AgBBoKHAAEGYocAANgIAQbShwABBqKHAADYCAEGoocAAQaChwAA2AgBBvKHAAEGwocAANgIAQbChwABBqKHAADYCAEHEocAAQbihwAA2AgBBuKHAAEGwocAANgIAQcyhwABBwKHAADYCAEHAocAAQbihwAA2AgBB1KHAAEHIocAANgIAQcihwABBwKHAADYCAEHcocAAQdChwAA2AgBB0KHAAEHIocAANgIAQeShwABB2KHAADYCAEHYocAAQdChwAA2AgBB7KHAAEHgocAANgIAQeChwABB2KHAADYCAEH0ocAAQeihwAA2AgBB6KHAAEHgocAANgIAQfyhwABB8KHAADYCAEHwocAAQeihwAA2AgBBhKLAAEH4ocAANgIAQfihwABB8KHAADYCAEGMosAAQYCiwAA2AgBBgKLAAEH4ocAANgIAQZSiwABBiKLAADYCAEGIosAAQYCiwAA2AgBBrKLAACABNgIAQZCiwABBiKLAADYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCAAwHCyACIARJIAEgAk1yDQAgACgCDEUNAwtBvKLAAEG8osAAKAIAIgAgASAAIAFJGzYCACABIANqIQRBgKDAACEAAkACQANAIAQgACgCACIGRwRAIAAoAggiAA0BDAILCyAAKAIMRQ0BC0GAoMAAIQADQAJAIAIgACgCACIETwRAIAIgBCAAKAIEaiIGSQ0BCyAAKAIIIQAMAQsLQayiwAAgATYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCACACIAZBIGtBeHFBCGsiACAAIAJBEGpJGyIEQRs2AgRBgKDAACkCACEJIARBEGpBiKDAACkCADcCACAEIAk3AghBhKDAACADNgIAQYCgwAAgATYCAEGIoMAAIARBCGo2AgBBjKDAAEEANgIAIARBHGohAANAIABBBzYCACAAQQRqIgAgBkkNAAsgAiAERg0GIAQgBCgCBEF+cTYCBCACIAQgAmsiAEEBcjYCBCAEIAA2AgAgAEGAAk8EQCACIAAQEAwHCyAAQfgBcUGQoMAAaiEBAn9BmKLAACgCACIEQQEgAEEDdnQiAHFFBEBBmKLAACAAIARyNgIAIAEMAQsgASgCCAshACABIAI2AgggACACNgIMIAIgATYCDCACIAA2AggMBgsgACABNgIAIAAgACgCBCADajYCBCABIAVBA3I2AgQgBkEPakF4cUEIayIDIAEgBWoiBGshBSADQayiwAAoAgBGDQMgA0GoosAAKAIARg0EIAMoAgQiAkEDcUEBRgRAIAMgAkF4cSIAEAsgACAFaiEFIAAgA2oiAygCBCECCyADIAJBfnE2AgQgBCAFQQFyNgIEIAQgBWogBTYCACAFQYACTwRAIAQgBRAQDAoLIAVB+AFxQZCgwABqIQACf0GYosAAKAIAIgJBASAFQQN2dCIDcUUEQEGYosAAIAIgA3I2AgAgAAwBCyAAKAIICyEFIAAgBDYCCCAFIAQ2AgwgBCAANgIMIAQgBTYCCAwJC0GkosAAIAAgBWsiATYCAEGsosAAQayiwAAoAgAiACAFaiICNgIAIAIgAUEBcjYCBCAAIAVBA3I2AgQgAEEIaiEDDAULQaiiwAAoAgAhAAJAIAEgBWsiAkEPTQRAQaiiwABBADYCAEGgosAAQQA2AgAgACABQQNyNgIEIAAgAWoiASABKAIEQQFyNgIEDAELQaCiwAAgAjYCAEGoosAAIAAgBWoiBDYCACAEIAJBAXI2AgQgACABaiACNgIAIAAgBUEDcjYCBAsgAEEIag8LIAAgAyAGajYCBEGsosAAQayiwAAoAgAiAEEPakF4cSIBQQhrIgI2AgBBpKLAAEGkosAAKAIAIANqIgQgACABa2pBCGoiATYCACACIAFBAXI2AgQgACAEakEoNgIEQbiiwABBgICAATYCAAwCC0GsosAAIAQ2AgBBpKLAAEGkosAAKAIAIAVqIgA2AgAgBCAAQQFyNgIEDAULQaiiwAAgBDYCAEGgosAAQaCiwAAoAgAgBWoiADYCACAEIABBAXI2AgQgACAEaiAANgIADAQLQQAhA0GkosAAKAIAIgAgBU0NAEGkosAAIAAgBWsiATYCAEGsosAAQayiwAAoAgAiACAFaiICNgIAIAIgAUEBcjYCBCAAIAVBA3I2AgQgAEEIag8LIAMPCyAAIAc2AhggAigCECIBBEAgACABNgIQIAEgADYCGAsgAigCFCIBRQ0AIAAgATYCFCABIAA2AhgLAkAgA0EQTwRAIAIgBUEDcjYCBCACIAVqIgEgA0EBcjYCBCABIANqIAM2AgAgA0GAAk8EQCABIAMQEAwCCyADQfgBcUGQoMAAaiEAAn9BmKLAACgCACIEQQEgA0EDdnQiA3FFBEBBmKLAACADIARyNgIAIAAMAQsgACgCCAshAyAAIAE2AgggAyABNgIMIAEgADYCDCABIAM2AggMAQsgAiADIAVqIgBBA3I2AgQgACACaiIAIAAoAgRBAXI2AgQLIAJBCGoPCyABQQhqC90VAw5/BX4BfCMAQZAJayIGJABBASEHAkACQAJAAkAgBZsgBWIgBUQAAAAAAAAAAGVyIAW9Qv///////////wCDQv/////////3/wBWIAVE////////P0NmcnINACAGQQhqQcgBEBUgBkEAOgDXAgJ+IAVEAAAAAAAAAABmIg0gBUQAAAAAAADwQ2NxBEAgBbEMAQtCAAshFSAGQdABaiEQAkAgBEGHAU0EQCAQIAMgBBANGiAGIAQ6ANcCDAELIAZBCGogAyAEQYgBbiIIEBIgBiAEIAhBiAFsIghrIgs6ANcCIBAgAyAIaiALEA0aCyACQQFxDQACQAJAIAJFBEBCASEUDAELQQAhB0HJosAALQAAGiACQQF2IggQACILBEAgBkEANgKwBSAGIAs2AqwFIAYgCDYCqAUgAkECayEMAkADQEEAIQoCQAJAAkACQCAHQQJqIggOAwIAAQALIAEgB2osAABBv39MDQkgB0F+Rg0CCyACIAhLBEAgASAHakECaiwAAEG/f0oNAgwJCyAHIAxGDQEgB0ECaiEKCyABIAIgByAKECcACyABIAcgASAHai0AAEErRiIKamoiDi0AACIPQTBrIgdBCk8EQEF/IA9BIHIiB0HXAGsiDyAPIAdB4QBrSRsiB0EPSw0CCyAKRQRAIA5BAWotAAAiDkEwayIKQQpPBEBBfyAOQSByIgpB1wBrIg4gDiAKQeEAa0kbIgpBD0sNAwsgB0EEdCAKciEHCyAGKAKoBSAJRgRAIAZBqAVqEBQgBigCrAUhCwsgCSALaiAHOgAAIAYgCUEBaiIJNgKwBSAIIgcgAkkNAAsgBigCqAUiCkGAgICAeEYNAyAGKQKsBSEUDAILIAYoAqgFIgdFDQICQCAGKAKsBSIIQQRrKAIAIglBeHEiCkEEQQggCUEDcSIJGyAHak8EQCAJQQAgCiAHQSdqSxsNASAIEAUMBAsMBgsMBgsACyAUpyEIAkBCfyAVQgAgDRsgBUT////////vQ2QbIhdQDQAgFEKAgICAcIMhGCAGQfAGaiEPIAZBoARqIRECQANAIAZB2AJqIAZBCGpByAEQDRogESAQQYgBEA0hDSAGQQA2AoQIIAZCgICAgBA3AvwHIAZBAzoAyAUgBkEgNgK4BSAGQQA2AsQFIAZBiIDAADYCwAUgBkEANgKwBSAGQQA2AqgFIAYgBkH8B2o2ArwFQRQhByAWIhRCkM4AWgRAIBQhFQNAIAZBiAhqIAdqIglBBGsgFUKQzgCAIhRC8LEDfiAVfKciC0H//wNxQeQAbiIMQQF0QYKEwABqLwAAOwAAIAlBAmsgDEGcf2wgC2pB//8DcUEBdEGChMAAai8AADsAACAHQQRrIQcgFUL/wdcvViAUIRUNAAsLAkAgFELjAFgEQCAUpyEJDAELIAdBAmsiByAGQYgIamogFKciC0H//wNxQeQAbiIJQZx/bCALakH//wNxQQF0QYKEwABqLwAAOwAACwJAIAlBCk8EQCAHQQJrIgcgBkGICGpqIAlBAXRBgoTAAGovAAA7AAAMAQsgB0EBayIHIAZBiAhqaiAJQTByOgAACwJAAn8CQAJAIAZBqAVqQQFBACAGQYgIaiAHakEUIAdrEAlFBEAgBigCgAghCSAGKAL8ByELIAYoAoQIIgdBiAEgBi0ApwUiDGsiDkkNASAMDQIgCQwDCyMAQUBqIgAkACAAQTc2AgwgAEHUgMAANgIIIABBxIDAADYCFCAAIAZBiAhqNgIQIABBAjYCHCAAQcyDwAA2AhggAEICNwIkIAAgAEEQaq1CgICAgBCENwM4IAAgAEEIaq1CgICAgCCENwMwIAAgAEEwajYCICAAQRhqQfiBwAAQJAALIAwgDWogCSAHEA0aIAYgByAMajoApwUMAgsgDCANaiAJIA4QDRogBkHYAmogDUEBEBIgByAOayEHIAkgDmoLIQwgDCAHQYgBbiIOQYgBbCISaiETIAdBiAFPBEAgBkHYAmogDCAOEBILIAYgByASayIHOgCnBSANIBMgBxANGgsgBkGoBWoiDCAGQdgCakHQAhANGiAGLQD3ByEHIAZBiAhqIg1BiAEQFSANIA8gBxANGiAHIA1qQQY6AAAgBkEAOgD3ByAGIAYtAI8JQYABcjoAjwkgBiAGKQOoBSAGKQOICIU3A6gFIAYgBikDsAUgBikDkAiFNwOwBSAGIAYpA7gFIAYpA5gIhTcDuAUgBiAGKQPABSAGKQOgCIU3A8AFIAYgBikDyAUgBikDqAiFNwPIBSAGIAYpA9AFIAYpA7AIhTcD0AUgBiAGKQPYBSAGKQO4CIU3A9gFIAYgBikD4AUgBikDwAiFNwPgBSAGIAYpA+gFIAYpA8gIhTcD6AUgBiAGKQPwBSAGKQPQCIU3A/AFIAYgBikD+AUgBikD2AiFNwP4BSAGIAYpA4AGIAYpA+AIhTcDgAYgBiAGKQOIBiAGKQPoCIU3A4gGIAYgBikDkAYgBikD8AiFNwOQBiAGIAYpA5gGIAYpA/gIhTcDmAYgBiAGKQOgBiAGKQOACYU3A6AGIAYgBikDqAYgBikDiAmFNwOoBiAMEAQCQAJAIBhCgICAgIAEUg0AIAYtAKgFIAgtAABHDQAgBi0AqQUgCC0AAUcNACAGLQCqBSAILQACRw0AIAYtAKsFIAgtAANHDQAgBi0ArAUgCC0ABEcNACAGLQCtBSAILQAFRw0AIAYtAK4FIAgtAAZHDQAgBi0ArwUgCC0AB0cNACAGLQCwBSAILQAIRw0AIAYtALEFIAgtAAlHDQAgBi0AsgUgCC0ACkcNACAGLQCzBSAILQALRw0AIAYtALQFIAgtAAxHDQAgBi0AtQUgCC0ADUcNACAGLQC2BSAILQAORw0AIAYtALcFIAgtAA9HDQAgBi0AuAUgCC0AEEcNACAGLQC5BSAILQARRw0AIAYtALoFIAgtABJHDQAgBi0AuwUgCC0AE0cNACAGLQC8BSAILQAURw0AIAYtAL0FIAgtABVHDQAgBi0AvgUgCC0AFkcNACAGLQC/BSAILQAXRw0AIAYtAMAFIAgtABhHDQAgBi0AwQUgCC0AGUcNACAGLQDCBSAILQAaRw0AIAYtAMMFIAgtABtHDQAgBi0AxAUgCC0AHEcNACAGLQDFBSAILQAdRw0AIAYtAMYFIAgtAB5HDQAgBi0AxwUgCC0AH0YNAQsgCwRAIAlBBGsoAgAiB0F4cSINQQRBCCAHQQNxIgcbIAtqSQ0IIAdBACANIAtBJ2pLGw0DIAkQBQsgFkIBfCIWIBdSDQEMAwsLIAsEQCAJIAsQHAsgFrohGUEAIQcgCkUNAyAIIAoQHAwDCwwFCyAKRQ0AIAhBBGsoAgAiB0F4cSIJQQRBCCAHQQNxIgcbIApqSQ0DIAdBACAJIApBJ2pLGw0EIAgQBQtBASEHCyAEBEAgA0EEaygCACIIQXhxIglBBEEIIAhBA3EiCBsgBGpJDQIgCEEAIAkgBEEnaksbDQMgAxAFCyACBEAgAUEEaygCACIDQXhxIgRBBEEIIANBA3EiAxsgAmpJDQIgA0EAIAQgAkEnaksbDQMgARAFCyAARAAAAAAAAAAAIBkgBxs5AwggACAHQQFzNgIAIAZBkAlqJAAPCyABIAIgByAIECcAC0H5ncAAQS5BqJ7AABAgAAtBuJ7AAEEuQeiewAAQIAALzAoBDH8gACgCBCEHIAAoAgAhAwJAAkACQCABKAIIQQFxRSIAIAEoAgAiBUVxRQRAAkAgAA0AIAMgB2ohCwJAIAEoAgwiCkUEQCADIQIMAQsgAyECA0AgAiIAIAtGDQICfyAAQQFqIAAsAAAiCUEATg0AGiAAQQJqIAlBYEkNABogAEEDaiAJQXBJDQAaIABBBGoLIgIgAGsgBmohBiAKIAhBAWoiCEcNAAsLIAIgC0YNACACLAAAGiAGIAcCfwJAIAZFDQAgBiAHSQRAIAMgBmosAABBv39KDQFBAAwCCyAGIAdGDQBBAAwBCyADCyIAGyEHIAAgAyAAGyEDCyAFRQ0DIAEoAgQhDSAHQRBPBEAgByADIANBA2pBfHEiBmsiCGoiCkEDcSEJQQAhACADIAZHBEAgCEF8TQRAQQAhBQNAIAAgAyAFaiICLAAAQb9/SmogAkEBaiwAAEG/f0pqIAJBAmosAABBv39KaiACQQNqLAAAQb9/SmohACAFQQRqIgUNAAsLIAMhAgNAIAAgAiwAAEG/f0pqIQAgAkEBaiECIAhBAWoiCA0ACwsCQCAJRQ0AIAYgCkF8cWoiAiwAAEG/f0ohBCAJQQFGDQAgBCACLAABQb9/SmohBCAJQQJGDQAgBCACLAACQb9/SmohBAsgCkECdiEFIAAgBGohBANAIAYhCiAFRQ0EQcABIAUgBUHAAU8bIgxBA3EhCCAMQQJ0IQtBACECIAVBBE8EQCAGIAtB8AdxaiEJIAYhAANAIAIgACgCACICQX9zQQd2IAJBBnZyQYGChAhxaiAAKAIEIgJBf3NBB3YgAkEGdnJBgYKECHFqIAAoAggiAkF/c0EHdiACQQZ2ckGBgoQIcWogACgCDCICQX9zQQd2IAJBBnZyQYGChAhxaiECIABBEGoiACAJRw0ACwsgBSAMayEFIAogC2ohBiACQQh2Qf+B/AdxIAJB/4H8B3FqQYGABGxBEHYgBGohBCAIRQ0ACyAKIAxB/AFxQQJ0aiICKAIAIgBBf3NBB3YgAEEGdnJBgYKECHEhACAIQQFGDQIgACACKAIEIgBBf3NBB3YgAEEGdnJBgYKECHFqIQAgCEECRg0CIAAgAigCCCIAQX9zQQd2IABBBnZyQYGChAhxaiEADAILIAdFBEAMAwsgB0EDcSECAn8gB0EESQRAQQAhAEEADAELIAMsAABBv39KIAMsAAFBv39KaiADLAACQb9/SmogAywAA0G/f0pqIgQgB0EMcSIAQQRGDQAaIAQgAywABEG/f0pqIAMsAAVBv39KaiADLAAGQb9/SmogAywAB0G/f0pqIgQgAEEIRg0AGiAEIAMsAAhBv39KaiADLAAJQb9/SmogAywACkG/f0pqIAMsAAtBv39KagshBCACRQ0CIAAgA2ohAANAIAQgACwAAEG/f0pqIQQgAEEBaiEAIAJBAWsiAg0ACwwCCwwCCyAAQQh2Qf+BHHEgAEH/gfwHcWpBgYAEbEEQdiAEaiEECwJAIAQgDUkEQCANIARrIQVBACEAAkACQAJAIAEtACBBAWsOAgABAgsgBSEAQQAhBQwBCyAFQQF2IQAgBUEBakEBdiEFCyAAQQFqIQAgASgCECECIAEoAhghBiABKAIUIQEDQCAAQQFrIgBFDQIgASACIAYoAhARAABFDQALQQEPCwwBCyABIAMgByAGKAIMEQEABEBBAQ8LQQAhAANAIAAgBUYEQEEADwsgAEEBaiEAIAEgAiAGKAIQEQAARQ0ACyAAQQFrIAVJDwsgASgCFCADIAcgASgCGCgCDBEBAAvXCwEKfyMAQTBrIgIkAEEBIQcCQCABKAIUIgVBJyABKAIYIgooAhAiCBEAAA0AAkACQAJAIAICfwJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgACgCACIBDigCAQEBAQEBAQEDBQEBBAEBAQEBAQEBAQEBAQEBAQEBAQEBCwEBAQEHAAsgAUHcAEYNBQsgAUH/BUsNBgwICyACQgA3AQogAkHc4AA7AQgMBgsgAkIANwEKIAJB3OgBOwEIDAULIAJCADcBCiACQdzkATsBCAwECyACQgA3AQogAkHc3AE7AQgMAwsgAkIANwEKIAJB3LgBOwEIDAILIAJCADcBCiACQdzOADsBCAwBCwJAQRFBACABQa+wBE8bIgAgAEEIciIDIAFBC3QiACADQQJ0QZSVwABqKAIAQQt0SRsiAyADQQRyIgMgA0ECdEGUlcAAaigCAEELdCAASxsiAyADQQJyIgMgA0ECdEGUlcAAaigCAEELdCAASxsiAyADQQFqIgMgA0ECdEGUlcAAaigCAEELdCAASxsiAyADQQFqIgMgA0ECdEGUlcAAaigCAEELdCAASxsiA0ECdEGUlcAAaigCAEELdCIEIABGIAAgBEtqIANqIgNBIU0EQCADQQJ0QZSVwABqIgQoAgBBFXYhAEHvBSEGAn8CQCADQSFGDQAgBCgCBEEVdiEGIAMNAEEADAELIANBAnRBkJXAAGooAgBB////AHELIQQCQCAGIABBf3NqRQ0AIAEgBGshC0HvBSAAIABB7wVNGyEJIAZBAWshA0EAIQQDQCAAIAlGDQMgBCAAQZyWwABqLQAAaiIEIAtLDQEgAyAAQQFqIgBHDQALIAMhAAsgAEEBcUUNAyACQSBqIgAgAUEPcUHKgsAAai0AADoAACACQQA6ABogAkEAOwEYIAIgAUEUdkHKgsAAai0AADoAGyACIAFBBHZBD3FByoLAAGotAAA6AB8gAiABQQh2QQ9xQcqCwABqLQAAOgAeIAIgAUEMdkEPcUHKgsAAai0AADoAHSACIAFBEHZBD3FByoLAAGotAAA6ABwgAUEBcmdBAnYiASACQRhqIgRqIgNB+wA6AAAgA0EBa0H1ADoAACAEIAFBAmsiAWpB3AA6AAAgAkH9ADoAISACQRBqIAAvAQA7AQAgAiACKQIYNwMIDAYLIANBIkH0lMAAEBkACyAJQe8FQYSVwAAQGQALQQAhAUECDAQLIAFBIEkNASABQf8ASQ0AIAFBgIAETwRAIAFBgIAISQRAIAFBqInAAEEsQYCKwABB0AFB0IvAAEHmAxAMRQ0DDAILIAFB/v//AHFBnvAKRiABQeD//wBxQeDNCkZyIAFBwO4Ka0F5SyABQbCdC2tBcUtyciABQfDXC2tBcEsgAUGA8AtrQd1sS3IgAUGAgAxrQZ10SyABQdCmDGtBektycnINAiABQYCCOGtBr8VUSw0CIAFB8IM4SQ0BDAILIAFBto/AAEEoQYaQwABBogJBqJLAAEGpAhAMRQ0BCyACIAE2AgwgAkGAAToACAwDCyACQSxqIgAgAUEPcUHKgsAAai0AADoAACACQQA6ACYgAkEAOwEkIAIgAUEUdkHKgsAAai0AADoAJyACIAFBBHZBD3FByoLAAGotAAA6ACsgAiABQQh2QQ9xQcqCwABqLQAAOgAqIAIgAUEMdkEPcUHKgsAAai0AADoAKSACIAFBEHZBD3FByoLAAGotAAA6ACggAUEBcmdBAnYiASACQSRqIgRqIgNB+wA6AAAgA0EBa0H1ADoAACAEIAFBAmsiAWpB3AA6AAAgAkH9ADoALSACQRBqIAAvAQA7AQAgAiACKQIkNwMIC0EKCyIAOgATIAIgAToAEiACLQAIQYABRw0BIAIoAgwhAQsgBSABIAgRAABFDQEMAgsgBSABQf8BcSIBIAJBCGpqIAAgAWsgCigCDBEBAA0BCyAFQScgCBEAACEHCyACQTBqJAAgBwuaCAItfgF/IAApA8ABIQ8gACkDmAEhGiAAKQNwIRAgACkDSCERIAApAyAhGyAAKQO4ASEcIAApA5ABIR0gACkDaCESIAApA0AhDSAAKQMYIQcgACkDsAEhEyAAKQOIASEUIAApA2AhFSAAKQM4IQggACkDECEEIAApA6gBIQ4gACkDgAEhFiAAKQNYIRcgACkDMCEJIAApAwghAyAAKQOgASEKIAApA3ghGCAAKQNQIRkgACkDKCELIAApAwAhDEEIIS4DQCAKIBggGSALIAyFhYWFIgEgEyAUIBUgBCAIhYWFhSICQgGJhSIFIAmFIA8gHCAdIBIgByANhYWFhSIGIAFCAYmFIgGFIS0gBSAOhUICiSIeIA0gDyAaIBAgESAbhYWFhSINQgGJIAKFIgKFQjeJIh8gBCAOIBYgFyADIAmFhYWFIg4gBkIBiYUiBIVCPokiIEJ/hYOFIQ8gDSAOQgGJhSIGIBiFQimJIiEgASAQhUIniSIiQn+FgyAfhSEOIAUgF4VCCokiIyACIByFQjiJIiQgBCAUhUIPiSIlQn+Fg4UhFCABIBuFQhuJIiYgIyAGIAuFQiSJIidCf4WDhSEYIAYgCoVCEokiCiAEIAiFQgaJIiggAyAFhUIBiSIpQn+Fg4UhECABIBqFQgiJIiogAiAShUIZiSIrQn+FgyAohSEXIAQgE4VCPYkiCCABIBGFQhSJIgMgAiAHhUIciSIHQn+Fg4UhESAFIBaFQi2JIgkgByAIQn+Fg4UhDSAGIBmFQgOJIgsgCCAJQn+Fg4UhCCAJIAtCf4WDIAOFIQkgCyADQn+FgyAHhSELIAIgHYVCFYkiAyAGIAyFIgUgLUIOiSIBQn+Fg4UhByAEIBWFQiuJIgwgASADQn+Fg4UhBEIsiSICIAMgDEJ/hYOFIQMgLkGQnMAAaikDACAMIAJCf4WDhSAFhSEMICcgJkJ/hYMgJIUiBiEaIAIgBUJ/hYMgAYUiBSEbICEgICAeQn+Fg4UiASEcICYgJEJ/hYMgJYUiAiEdICkgCkJ/hYMgKoUhEiAeICFCf4WDICKFIRMgCiAqQn+FgyArhSEVICcgJSAjQn+Fg4UhFiAiIB9Cf4WDICCFIQogKyAoQn+FgyAphSEZIC5BCGoiLkHAAUcNAAsgACAKNwOgASAAIBg3A3ggACAZNwNQIAAgCzcDKCAAIA43A6gBIAAgFjcDgAEgACAXNwNYIAAgCTcDMCAAIAM3AwggACATNwOwASAAIBQ3A4gBIAAgFTcDYCAAIAg3AzggACAENwMQIAAgATcDuAEgACACNwOQASAAIBI3A2ggACANNwNAIAAgBzcDGCAAIA83A8ABIAAgBjcDmAEgACAQNwNwIAAgETcDSCAAIAU3AyAgACAMNwMAC7AIAQV/IABBCGsiASAAQQRrKAIAIgNBeHEiAGohAgJAAkAgA0EBcQ0AIANBAnFFDQEgASgCACIDIABqIQAgASADayIBQaiiwAAoAgBGBEAgAigCBEEDcUEDRw0BQaCiwAAgADYCACACIAIoAgRBfnE2AgQgASAAQQFyNgIEIAIgADYCAA8LIAEgAxALCwJAAkACQAJAAkACQAJAIAIoAgQiA0ECcUUEQCACQayiwAAoAgBGDQIgAkGoosAAKAIARg0DIAIgA0F4cSICEAsgASAAIAJqIgBBAXI2AgQgACABaiAANgIAIAFBqKLAACgCAEcNAUGgosAAIAA2AgAPCyACIANBfnE2AgQgASAAQQFyNgIEIAAgAWogADYCAAsgAEGAAkkNAkEfIQIgAUIANwIQIABB////B00EQCAAQQYgAEEIdmciAmt2QQFxIAJBAXRrQT5qIQILIAEgAjYCHCACQQJ0QYCfwABqIQNBASACdCIEQZyiwAAoAgBxDQMgAyABNgIAIAEgAzYCGCABIAE2AgwgASABNgIIQZyiwABBnKLAACgCACAEcjYCAAwEC0GsosAAIAE2AgBBpKLAAEGkosAAKAIAIABqIgA2AgAgASAAQQFyNgIEQaiiwAAoAgAgAUYEQEGgosAAQQA2AgBBqKLAAEEANgIACyAAQbiiwAAoAgAiAk0NBUGsosAAKAIAIgBFDQVBpKLAACgCACIDQSlJDQRBgKDAACEBA0AgACABKAIAIgVPBEAgACAFIAEoAgRqSQ0GCyABKAIIIQEMAAsAC0GoosAAIAE2AgBBoKLAAEGgosAAKAIAIABqIgA2AgAgASAAQQFyNgIEIAAgAWogADYCAA8LIABB+AFxQZCgwABqIQICf0GYosAAKAIAIgNBASAAQQN2dCIAcUUEQEGYosAAIAAgA3I2AgAgAgwBCyACKAIICyEAIAIgATYCCCAAIAE2AgwgASACNgIMIAEgADYCCA8LAkACQCAAIAMoAgAiAygCBEF4cUYEQCADIQIMAQsgAEEZIAJBAXZrQQAgAkEfRxt0IQQDQCADIARBHXZBBHFqQRBqIgUoAgAiAkUNAiAEQQF0IQQgAiEDIAIoAgRBeHEgAEcNAAsLIAIoAggiACABNgIMIAIgATYCCCABQQA2AhggASACNgIMIAEgADYCCAwBCyAFIAE2AgAgASADNgIYIAEgATYCDCABIAE2AggLQQAhAUHAosAAQcCiwAAoAgBBAWsiADYCACAADQFBiKDAACgCACIABEADQCABQQFqIQEgACgCCCIADQALC0HAosAAQf8fIAEgAUH/H00bNgIADwtBiKDAACgCACIBBEADQCAEQQFqIQQgASgCCCIBDQALC0HAosAAQf8fIAQgBEH/H00bNgIAIAIgA08NAEG4osAAQX82AgALC8UHAQh/IwBB0AZrIgMkACADQQhqQcgBEBUgA0EAOgDXAiADQdABaiEGAkAgAkGHAU0EQCAGIAEgAhANGiADIAI6ANcCDAELIANBCGogASACQYgBbiIEEBIgAyACIARBiAFsIgRrIgU6ANcCIAYgASAEaiAFEA0aCyADQfgCaiIJIANBCGpB0AIQDRogAy0AxwUhBEEAIQYgA0HIBWoiBUGIARAVIAUgA0HABGogBBANGiAEIAVqQQY6AAAgA0GAA2oiBCAEKQMAIAMpA9AFhTcDACADQYgDaiIFIAUpAwAgAykD2AWFNwMAIANBkANqIgcgBykDACADKQPgBYU3AwAgA0EAOgDHBSADIAMtAM8GQYABcjoAzwYgAyADKQP4AiADKQPIBYU3A/gCIAMgAykDmAMgAykD6AWFNwOYAyADIAMpA6ADIAMpA/AFhTcDoAMgAyADKQOoAyADKQP4BYU3A6gDIAMgAykDsAMgAykDgAaFNwOwAyADIAMpA7gDIAMpA4gGhTcDuAMgAyADKQPAAyADKQOQBoU3A8ADIAMgAykDyAMgAykDmAaFNwPIAyADIAMpA9ADIAMpA6AGhTcD0AMgAyADKQPYAyADKQOoBoU3A9gDIAMgAykD4AMgAykDsAaFNwPgAyADIAMpA+gDIAMpA7gGhTcD6AMgAyADKQPwAyADKQPABoU3A/ADIAMgAykD+AMgAykDyAaFNwP4AyAJEAQgA0HwAmogBykDADcDACADQegCaiAFKQMANwMAIANB4AJqIAQpAwA3AwAgAyADKQP4AjcD2AIgA0EANgKAAyADQoCAgIAQNwL4AiADQdgCaiEHQQEhBQNAIActAAAiBEEPcSIIQQpJIQogBEEEdiIJQTByIAlB1wBqIARBoAFJGyEEIAMoAvgCIAZGBH8gA0H4AmoQFCADKAL8AgUgBQsgBmogBDoAACADIAZBAWoiBDYCgAMgAygC+AIgBEYEQCADQfgCahAUCyADKAL8AiIFIAZqQQFqIAhBMHIgCEHXAGogChs6AAAgAyAEQQFqIgQ2AoADIAdBAWohByAGQT5HIAQhBg0ACyADKAL4AiEGAkACQAJAIAIEQCABQQRrKAIAIgRBeHEiB0EEQQggBEEDcSIEGyACakkNASAEQQAgByACQSdqSxsNAiABEAULIAZBwQBPBEAgBSAGQQFBwAAQByIFRQ0DCyAAQcAANgIEIAAgBTYCACADQdAGaiQADwtB+Z3AAEEuQaiewAAQIAALQbiewABBLkHonsAAECALAAvTBgEFfwJAAkACQAJAAkAgAEEEayIFKAIAIgdBeHEiBEEEQQggB0EDcSIGGyABak8EQCAGQQAgAUEnaiIIIARJGw0BAkACQCACQQlPBEAgAiADEAoiAg0BQQAPC0EAIQIgA0HM/3tLDQFBECADQQtqQXhxIANBC0kbIQECQCAGRQRAIAFBgAJJIAQgAUEEcklyIAQgAWtBgYAIT3INAQwJCyAAQQhrIgYgBGohCAJAAkACQAJAIAEgBEsEQCAIQayiwAAoAgBGDQQgCEGoosAAKAIARg0CIAgoAgQiB0ECcQ0FIAdBeHEiByAEaiIEIAFJDQUgCCAHEAsgBCABayICQRBJDQEgBSABIAUoAgBBAXFyQQJyNgIAIAEgBmoiASACQQNyNgIEIAQgBmoiAyADKAIEQQFyNgIEIAEgAhAIDA0LIAQgAWsiAkEPSw0CDAwLIAUgBCAFKAIAQQFxckECcjYCACAEIAZqIgEgASgCBEEBcjYCBAwLC0GgosAAKAIAIARqIgQgAUkNAgJAIAQgAWsiA0EPTQRAIAUgB0EBcSAEckECcjYCACAEIAZqIgEgASgCBEEBcjYCBEEAIQNBACEBDAELIAUgASAHQQFxckECcjYCACABIAZqIgEgA0EBcjYCBCAEIAZqIgIgAzYCACACIAIoAgRBfnE2AgQLQaiiwAAgATYCAEGgosAAIAM2AgAMCgsgBSABIAdBAXFyQQJyNgIAIAEgBmoiASACQQNyNgIEIAggCCgCBEEBcjYCBCABIAIQCAwJC0GkosAAKAIAIARqIgQgAUsNBwsgAxAAIgFFDQEgASAAQXxBeCAFKAIAIgFBA3EbIAFBeHFqIgEgAyABIANJGxANIAAQBQ8LIAIgACABIAMgASADSRsQDRogBSgCACIDQXhxIgUgAUEEQQggA0EDcSIBG2pJDQMgAUEAIAUgCEsbDQQgABAFCyACDwtB+Z3AAEEuQaiewAAQIAALQbiewABBLkHonsAAECAAC0H5ncAAQS5BqJ7AABAgAAtBuJ7AAEEuQeiewAAQIAALIAUgASAHQQFxckECcjYCACABIAZqIgIgBCABayIBQQFyNgIEQaSiwAAgATYCAEGsosAAIAI2AgAgAA8LIAALqQYBBH8gACABaiECAkACQCAAKAIEIgNBAXENACADQQJxRQ0BIAAoAgAiAyABaiEBIAAgA2siAEGoosAAKAIARgRAIAIoAgRBA3FBA0cNAUGgosAAIAE2AgAgAiACKAIEQX5xNgIEIAAgAUEBcjYCBCACIAE2AgAMAgsgACADEAsLAkACQAJAIAIoAgQiA0ECcUUEQCACQayiwAAoAgBGDQIgAkGoosAAKAIARg0DIAIgA0F4cSIDEAsgACABIANqIgFBAXI2AgQgACABaiABNgIAIABBqKLAACgCAEcNAUGgosAAIAE2AgAPCyACIANBfnE2AgQgACABQQFyNgIEIAAgAWogATYCAAsgAUGAAk8EQEEfIQIgAEIANwIQIAFB////B00EQCABQQYgAUEIdmciA2t2QQFxIANBAXRrQT5qIQILIAAgAjYCHCACQQJ0QYCfwABqIQRBASACdCIDQZyiwAAoAgBxRQRAIAQgADYCACAAIAQ2AhggACAANgIMIAAgADYCCEGcosAAQZyiwAAoAgAgA3I2AgAPCwJAAkAgASAEKAIAIgMoAgRBeHFGBEAgAyECDAELIAFBGSACQQF2a0EAIAJBH0cbdCEFA0AgAyAFQR12QQRxakEQaiIEKAIAIgJFDQIgBUEBdCEFIAIhAyACKAIEQXhxIAFHDQALCyACKAIIIgEgADYCDCACIAA2AgggAEEANgIYIAAgAjYCDCAAIAE2AggPCyAEIAA2AgAgACADNgIYIAAgADYCDCAAIAA2AggPCyABQfgBcUGQoMAAaiEDAn9BmKLAACgCACICQQEgAUEDdnQiAXFFBEBBmKLAACABIAJyNgIAIAMMAQsgAygCCAshASADIAA2AgggASAANgIMIAAgAzYCDCAAIAE2AggPC0GsosAAIAA2AgBBpKLAAEGkosAAKAIAIAFqIgE2AgAgACABQQFyNgIEIABBqKLAACgCAEcNAUGgosAAQQA2AgBBqKLAAEEANgIADwtBqKLAACAANgIAQaCiwABBoKLAACgCACABaiIBNgIAIAAgAUEBcjYCBCAAIAFqIAE2AgALC8sEAQh/IAAoAhwiB0EBcSIKIARqIQYCQCAHQQRxRQRAQQAhAQwBCwJAIAJFBEAMAQsgAkEDcSIJRQ0AIAEhBQNAIAggBSwAAEG/f0pqIQggBUEBaiEFIAlBAWsiCQ0ACwsgBiAIaiEGC0ErQYCAxAAgChshCCAAKAIARQRAIAAoAhQiBSAAKAIYIgAgCCABIAIQIQRAQQEPCyAFIAMgBCAAKAIMEQEADwsCQAJAAkAgBiAAKAIEIglPBEAgACgCFCIFIAAoAhgiACAIIAEgAhAhRQ0BQQEPCyAHQQhxRQ0BIAAoAhAhCyAAQTA2AhAgAC0AICEMQQEhBSAAQQE6ACAgACgCFCIHIAAoAhgiCiAIIAEgAhAhDQIgCSAGa0EBaiEFAkADQCAFQQFrIgVFDQEgB0EwIAooAhARAABFDQALQQEPCyAHIAMgBCAKKAIMEQEABEBBAQ8LIAAgDDoAICAAIAs2AhBBAA8LIAUgAyAEIAAoAgwRAQAhBQwBCyAJIAZrIQYCQAJAAkAgAC0AICIFQQFrDgMAAQACCyAGIQVBACEGDAELIAZBAXYhBSAGQQFqQQF2IQYLIAVBAWohBSAAKAIQIQkgACgCGCEHIAAoAhQhAAJAA0AgBUEBayIFRQ0BIAAgCSAHKAIQEQAARQ0AC0EBDwtBASEFIAAgByAIIAEgAhAhDQAgACADIAQgBygCDBEBAA0AQQAhBQNAIAUgBkYEQEEADwsgBUEBaiEFIAAgCSAHKAIQEQAARQ0ACyAFQQFrIAZJDwsgBQvnAgEFfwJAQc3/e0EQIAAgAEEQTRsiAGsgAU0NACAAQRAgAUELakF4cSABQQtJGyIEakEMahAAIgJFDQAgAkEIayEBAkAgAEEBayIDIAJxRQRAIAEhAAwBCyACQQRrIgUoAgAiBkF4cSACIANqQQAgAGtxQQhrIgIgAEEAIAIgAWtBEE0baiIAIAFrIgJrIQMgBkEDcQRAIAAgAyAAKAIEQQFxckECcjYCBCAAIANqIgMgAygCBEEBcjYCBCAFIAIgBSgCAEEBcXJBAnI2AgAgASACaiIDIAMoAgRBAXI2AgQgASACEAgMAQsgASgCACEBIAAgAzYCBCAAIAEgAmo2AgALAkAgACgCBCIBQQNxRQ0AIAFBeHEiAiAEQRBqTQ0AIAAgBCABQQFxckECcjYCBCAAIARqIgEgAiAEayIEQQNyNgIEIAAgAmoiAiACKAIEQQFyNgIEIAEgBBAICyAAQQhqIQMLIAML8QIBBH8gACgCDCECAkACQCABQYACTwRAIAAoAhghAwJAAkAgACACRgRAIABBFEEQIAAoAhQiAhtqKAIAIgENAUEAIQIMAgsgACgCCCIBIAI2AgwgAiABNgIIDAELIABBFGogAEEQaiACGyEEA0AgBCEFIAEiAkEUaiACQRBqIAIoAhQiARshBCACQRRBECABG2ooAgAiAQ0ACyAFQQA2AgALIANFDQIgACAAKAIcQQJ0QYCfwABqIgEoAgBHBEAgA0EQQRQgAygCECAARhtqIAI2AgAgAkUNAwwCCyABIAI2AgAgAg0BQZyiwABBnKLAACgCAEF+IAAoAhx3cTYCAAwCCyAAKAIIIgAgAkcEQCAAIAI2AgwgAiAANgIIDwtBmKLAAEGYosAAKAIAQX4gAUEDdndxNgIADwsgAiADNgIYIAAoAhAiAQRAIAIgATYCECABIAI2AhgLIAAoAhQiAEUNACACIAA2AhQgACACNgIYCwuiAwEGfyABIAJBAXRqIQkgAEGA/gNxQQh2IQogAEH/AXEhDAJAAkACQAJAA0AgAUECaiELIAcgAS0AASICaiEIIAogAS0AACIBRwRAIAEgCksNBCAIIQcgCyIBIAlHDQEMBAsgByAISw0BIAQgCEkNAiADIAdqIQEDQCACRQRAIAghByALIgEgCUcNAgwFCyACQQFrIQIgAS0AACABQQFqIQEgDEcNAAsLQQAhAgwDCyAHIAhBmInAABAaAAsjAEEwayIAJAAgACAINgIAIAAgBDYCBCAAQQI2AgwgAEGghsAANgIIIABCAjcCFCAAIABBBGqtQoCAgIAwhDcDKCAAIACtQoCAgIAwhDcDICAAIABBIGo2AhAgAEEIakGYicAAECQACyAAQf//A3EhByAFIAZqIQNBASECA0AgBUEBaiEAAkAgBSwAACIBQQBOBEAgACEFDAELIAAgA0cEQCAFLQABIAFB/wBxQQh0ciEBIAVBAmohBQwBC0GIicAAECkACyAHIAFrIgdBAEgNASACQQFzIQIgAyAFRw0ACwsgAkEBcQu2AgEHfwJAIAJBEEkEQCAAIQMMAQsgAEEAIABrQQNxIgRqIQUgBARAIAAhAyABIQYDQCADIAYtAAA6AAAgBkEBaiEGIANBAWoiAyAFSQ0ACwsgBSACIARrIghBfHEiB2ohAwJAIAEgBGoiBEEDcQRAIAdBAEwNASAEQQN0IgJBGHEhCSAEQXxxIgZBBGohAUEAIAJrQRhxIQIgBigCACEGA0AgBSAGIAl2IAEoAgAiBiACdHI2AgAgAUEEaiEBIAVBBGoiBSADSQ0ACwwBCyAHQQBMDQAgBCEBA0AgBSABKAIANgIAIAFBBGohASAFQQRqIgUgA0kNAAsLIAhBA3EhAiAEIAdqIQELIAIEQCACIANqIQIDQCADIAEtAAA6AAAgAUEBaiEBIANBAWoiAyACSQ0ACwsgAAu/AgEDfyMAQRBrIgIkAAJAIAFBgAFPBEAgAkEANgIMAn8gAUGAEE8EQCABQYCABE8EQCACQQxqQQNyIQQgAiABQRJ2QfABcjoADCACIAFBBnZBP3FBgAFyOgAOIAIgAUEMdkE/cUGAAXI6AA1BBAwCCyACQQxqQQJyIQQgAiABQQx2QeABcjoADCACIAFBBnZBP3FBgAFyOgANQQMMAQsgAkEMakEBciEEIAIgAUEGdkHAAXI6AAxBAgshAyAEIAFBP3FBgAFyOgAAIAMgACgCACAAKAIIIgFrSwRAIAAgASADEBMgACgCCCEBCyAAKAIEIAFqIAJBDGogAxANGiAAIAEgA2o2AggMAQsgACgCCCIDIAAoAgBGBEAgABAUCyAAIANBAWo2AgggACgCBCADaiABOgAACyACQRBqJABBAAu7AgEGfyMAQRBrIgMkAEEKIQICQCAAQZDOAEkEQCAAIQQMAQsDQCADQQZqIAJqIgVBBGsgAEGQzgBuIgRB8LEDbCAAaiIGQf//A3FB5ABuIgdBAXRBgoTAAGovAAA7AAAgBUECayAHQZx/bCAGakH//wNxQQF0QYKEwABqLwAAOwAAIAJBBGshAiAAQf/B1y9LIAQhAA0ACwsCQCAEQeMATQRAIAQhAAwBCyACQQJrIgIgA0EGamogBEH//wNxQeQAbiIAQZx/bCAEakH//wNxQQF0QYKEwABqLwAAOwAACwJAIABBCk8EQCACQQJrIgIgA0EGamogAEEBdEGChMAAai8AADsAAAwBCyACQQFrIgIgA0EGamogAEEwcjoAAAsgAUEBQQAgA0EGaiACakEKIAJrEAkgA0EQaiQAC7oCAQR/QR8hAiAAQgA3AhAgAUH///8HTQRAIAFBBiABQQh2ZyIDa3ZBAXEgA0EBdGtBPmohAgsgACACNgIcIAJBAnRBgJ/AAGohBEEBIAJ0IgNBnKLAACgCAHFFBEAgBCAANgIAIAAgBDYCGCAAIAA2AgwgACAANgIIQZyiwABBnKLAACgCACADcjYCAA8LAkACQCABIAQoAgAiAygCBEF4cUYEQCADIQIMAQsgAUEZIAJBAXZrQQAgAkEfRxt0IQUDQCADIAVBHXZBBHFqQRBqIgQoAgAiAkUNAiAFQQF0IQUgAiEDIAIoAgRBeHEgAUcNAAsLIAIoAggiASAANgIMIAIgADYCCCAAQQA2AhggACACNgIMIAAgATYCCA8LIAQgADYCACAAIAM2AhggACAANgIMIAAgADYCCAuBAgEFfyMAQYABayIEJAACfwJAAkAgASgCHCICQRBxRQRAIAJBIHENASAAIAEQDwwDC0H/ACECA0AgBCACIgNqIgUgAEEPcSICQTByIAJB1wBqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsMAQtB/wAhAgNAIAQgAiIDaiIFIABBD3EiAkEwciACQTdqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkMAQsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkLIARBgAFqJAALuQIAIAIEQCABIAJBiAFsaiECA0AgACAAKQMAIAEpAACFNwMAIAAgACkDCCABKQAIhTcDCCAAIAApAxAgASkAEIU3AxAgACAAKQMYIAEpABiFNwMYIAAgACkDICABKQAghTcDICAAIAApAyggASkAKIU3AyggACAAKQMwIAEpADCFNwMwIAAgACkDOCABKQA4hTcDOCAAIAApA0AgASkAQIU3A0AgACAAKQNIIAEpAEiFNwNIIAAgACkDUCABKQBQhTcDUCAAIAApA1ggASkAWIU3A1ggACAAKQNgIAEpAGCFNwNgIAAgACkDaCABKQBohTcDaCAAIAApA3AgASkAcIU3A3AgACAAKQN4IAEpAHiFNwN4IAAgACkDgAEgASkAgAGFNwOAASAAEAQgAUGIAWoiASACRw0ACwsLsAEBAn8jAEEgayIDJAAgASABIAJqIgJLBEBBAEEAECgAC0EIIAAoAgAiAUEBdCIEIAIgAiAESRsiAiACQQhNGyIEQQBIBEBBAEEAECgACyADIAEEfyADIAE2AhwgAyAAKAIENgIUQQEFQQALNgIYIANBCGogBCADQRRqEB0gAygCCEEBRgRAIAMoAgwgAygCEBAoAAsgAygCDCEBIAAgBDYCACAAIAE2AgQgA0EgaiQAC7ABAQR/IwBBIGsiASQAIAAoAgAiAkF/RgRAQQBBABAoAAtBCCACQQF0IgMgAkEBaiIEIAMgBEsbIgMgA0EITRsiA0EASARAQQBBABAoAAsgASACBH8gASACNgIcIAEgACgCBDYCFEEBBUEACzYCGCABQQhqIAMgAUEUahAdIAEoAghBAUYEQCABKAIMIAEoAhAQKAALIAEoAgwhAiAAIAM2AgAgACACNgIEIAFBIGokAAuOAQECfyABQRBPBEAgAEEAIABrQQNxIgNqIQIgAwRAA0AgAEEAOgAAIABBAWoiACACSQ0ACwsgAiABIANrIgFBfHEiA2ohACADQQBKBEADQCACQQA2AgAgAkEEaiICIABJDQALCyABQQNxIQELIAEEQCAAIAFqIQEDQCAAQQA6AAAgAEEBaiIAIAFJDQALCwtsAQN/AkACQCAAKAIAIgIEQCAAKAIEIgBBBGsoAgAiAUF4cSIDQQRBCCABQQNxIgEbIAJqSQ0BIAFBACADIAJBJ2pLGw0CIAAQBQsPC0H5ncAAQS5BqJ7AABAgAAtBuJ7AAEEuQeiewAAQIAALewEBfyMAQRBrIgMkAEH8nsAAQfyewAAoAgAiBEEBajYCAAJAIARBAEgNAAJAQciiwAAtAABFBEBBxKLAAEHEosAAKAIAQQFqNgIAQfiewAAoAgBBAE4NAQwCCyADQQhqIAAgARECAAALQciiwABBADoAACACRQ0AAAsAC2wCAX8BfiMAQTBrIgEkACABIAA2AgAgAUGAATYCBCABQQI2AgwgAUGAhsAANgIIIAFCAjcCFCABQoCAgIAwIgIgAUEEaq2ENwMoIAEgAiABrYQ3AyAgASABQSBqNgIQIAFBCGpB8IPAABAkAAtoAgF/AX4jAEEwayIDJAAgAyABNgIEIAMgADYCACADQQI2AgwgA0G4g8AANgIIIANCAjcCFCADQoCAgIAwIgQgA62ENwMoIAMgBCADQQRqrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtoAgF/AX4jAEEwayIDJAAgAyAANgIAIAMgATYCBCADQQI2AgwgA0HUhsAANgIIIANCAjcCFCADQoCAgIAwIgQgA0EEaq2ENwMoIAMgBCADrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtiAQF/AkACQCABBEAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpJDQEgAkEAIAMgAUEnaksbDQIgABAFCw8LQfmdwABBLkGonsAAECAAC0G4nsAAQS5B6J7AABAgAAtbAQJ/AkAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpPBEAgAkEAIAMgAUEnaksbDQEgABAFDwtB+Z3AAEEuQaiewAAQIAALQbiewABBLkHonsAAECAAC1gBAX8CfyACKAIEBEACQCACKAIIIgNFBEAMAQsgAigCACADQQEgARAHDAILC0HJosAALQAAGiABEAALIQIgACABNgIIIAAgAkEBIAIbNgIEIAAgAkU2AgALSAACQCABaUEBR0GAgICAeCABayAASXINACAABEBByaLAAC0AABoCfyABQQlPBEAgASAAEAoMAQsgABAACyIBRQ0BCyABDwsAC0EBAX8gAiAAKAIAIAAoAggiA2tLBEAgACADIAIQEyAAKAIIIQMLIAAoAgQgA2ogASACEA0aIAAgAiADajYCCEEAC0EBAX8jAEEgayIDJAAgA0EANgIQIANBATYCBCADQgQ3AgggAyABNgIcIAMgADYCGCADIANBGGo2AgAgAyACECQACzgAAkAgAkGAgMQARg0AIAAgAiABKAIQEQAARQ0AQQEPCyADRQRAQQAPCyAAIAMgBCABKAIMEQEACzwBAX9BASECAkAgACgCACABEBENACABKAIUQciCwABBAiABKAIYKAIMEQEADQAgACgCBCABEBEhAgsgAgstAAJAIANpQQFHQYCAgIB4IANrIAFJckUEQCAAIAEgAyACEAciAA0BCwALIAAL6gECAn8BfiMAQRBrIgIkACACQQE7AQwgAiABNgIIIAIgADYCBCMAQRBrIgEkACACQQRqIgApAgAhBCABIAA2AgwgASAENwIEIwBBEGsiACQAIAFBBGoiASgCACICKAIMIQMCQAJAAkACQCACKAIEDgIAAQILIAMNAUEBIQJBACEDDAILIAMNACACKAIAIgIoAgQhAyACKAIAIQIMAQsgAEGAgICAeDYCACAAIAE2AgwgAEEGIAEoAggiAC0ACCAALQAJEBcACyAAIAM2AgQgACACNgIAIABBByABKAIIIgAtAAggAC0A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AgAgBkEDdGoiACgCACAAKAIEIAIoAiQoAgwRAQBFDQELQQEMAQtBAAsgAkEwaiQACwsAIAAoAgAgARAPCwwAIAAgASkCADcDAAsJACAAQQA2AgALC/weAgBBgIDAAAtBRXJyb3IAAAAIAAAADAAAAAQAAAAJAAAACgAAAAsAAABzaGEzLXdhc20vc3JjL2xpYi5ycyAAEAAUAAAASQAAADMAQcyAwAALqR4BAAAADAAAAGEgRGlzcGxheSBpbXBsZW1lbnRhdGlvbiByZXR1cm5lZCBhbiBlcnJvciB1bmV4cGVjdGVkbHkvVXNlcnMvcnoucGFuLy5ydXN0dXAvdG9vbGNoYWlucy9zdGFibGUtYWFyY2g2NC1hcHBsZS1kYXJ3aW4vbGliL3J1c3RsaWIvc3JjL3J1c3QvbGlicmFyeS9hbGxvYy9zcmMvc3RyaW5nLnJziwAQAG0AAAB7CgAADgAAAGNhcGFjaXR5IG92ZXJmbG93AAAACAEQABEAAABhbGxvYy9zcmMvcmF3X3ZlYy5ycyQBEAAUAAAAGAAAAAUAAAAuLjAxMjM0NTY3ODlhYmNkZWZjYWxsZWQgYE9wdGlvbjo6dW53cmFwKClgIG9uIGEgYE5vbmVgIHZhbHVlaW5kZXggb3V0IG9mIGJvdW5kczogdGhlIGxlbiBpcyAgYnV0IHRoZSBpbmRleCBpcyAAhQEQACAAAAClARAAEgAAADogAAABAAAAAAAAAMgBEAACAAAAY29yZS9zcmMvZm10L251bS5ycwDcARAAEwAAAGYAAAAXAAAAMHgwMDAxMDIwMzA0MDUwNjA3MDgwOTEwMTExMjEzMTQxNTE2MTcxODE5MjAyMTIyMjMyNDI1MjYyNzI4MjkzMDMxMzIzMzM0MzUzNjM3MzgzOTQwNDE0MjQzNDQ0NTQ2NDc0ODQ5NTA1MTUyNTM1NDU1NTY1NzU4NTk2MDYxNjI2MzY0NjU2NjY3Njg2OTcwNzE3MjczNzQ3NTc2Nzc3ODc5ODA4MTgyODM4NDg1ODY4Nzg4ODk5MDkxOTI5Mzk0OTU5Njk3OTg5OXJhbmdlIHN0YXJ0IGluZGV4ICBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCAAAMoCEAASAAAA3AIQACIAAAByYW5nZSBlbmQgaW5kZXggEAMQABAA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";

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
    document.head.appendChild(style);
    styleInjected = true;
  }
  function findLastAssistantMessage() {
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
  function formatResult(result) {
    return formatToolResultText(result);
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
    container.appendChild(toolsContainer);
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
        if (c.type === "image_url" && c.image_url?.url) {
          imageUrls.push(c.image_url.url);
        }
      }
    }
    const imagesHtml = imageUrls.length > 0 ? imageUrls.map((url) => `<img class="ds-studio-tool-card-image" src="${url}" alt="tool result image" />`).join("") : "";
    return `
    <div class="ds-studio-tool-card-header">
      <span class="ds-studio-tool-card-badge ${status}"><span class="dot"></span>${statusText}</span>
      ${terminated ? '<span class="ds-studio-tool-card-badge terminated"><span class="dot"></span>\u5DF2\u7EC8\u6B62\u7EED\u8DD1</span>' : ""}
      <span class="ds-studio-tool-card-name">${data.toolName}</span>
      ${data.durationMs ? `<span class="ds-studio-tool-card-duration">${data.durationMs}ms</span>` : ""}
    </div>
    <div class="ds-studio-tool-card-body">
      <div class="ds-studio-tool-card-section">
        <div class="ds-studio-tool-card-label">\u53C2\u6570</div>
        <pre>${formatJson2(data.params)}</pre>
      </div>
      ${data.result ? `
      <div class="ds-studio-tool-card-section ${isLongResult && !imagesHtml ? "ds-studio-tool-card-result-collapsed" : ""}">
        <div class="ds-studio-tool-card-label">\u7ED3\u679C</div>
        ${imagesHtml ? `<div class="ds-studio-tool-card-images">${imagesHtml}</div>` : ""}
        <pre>${resultText}</pre>
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
  function updateToolCardByCallId(callId, data, result, durationMs) {
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
    const fullData = { ...data, result, durationMs };
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
      this.handlers.get(event)?.forEach((h) => {
        try {
          h(payload);
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
      for (const [k, v] of Object.entries(props.attrs)) element.setAttribute(k, v);
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
    z-index: 2147483647;
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
      { id: "memory", label: "\u8BB0\u5FC6" }
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
      const result = await callHostTool("workspace.set", { root: workspaceInput.value });
      if (result.ok) {
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
      const result = await callHostTool("skill.list", {});
      if (result.ok && result.data) {
        const skills = result.data.skills;
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
      const result = await callHostTool("folder.pick", {});
      if (result.ok && result.data) {
        const folderPath = result.data.path;
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
        const result = await callHostTool("project.list", {});
        if (result.ok && result.data) {
          projects = result.data.projects;
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
        const result = await callHostTool("skill.list", {});
        if (result.ok && result.data) {
          const list = result.data.skills;
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
        const result = await callHostTool("file.read", { path: skill.skillMdPath });
        if (result.ok && result.data) {
          skill.content = result.data.content;
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
        const result = await callHostTool("mcp.test", { config });
        if (result.ok) {
          testResult.className = "studio-mcp-test-result success";
          testResult.textContent = "\u8FDE\u63A5\u6210\u529F\uFF01";
        } else {
          testResult.className = "studio-mcp-test-result error";
          testResult.textContent = `\u8FDE\u63A5\u5931\u8D25\uFF1A${result.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
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
        const result = await callHostTool("mcp.save", { serverId: editingServerId ?? config.name, config });
        if (result.ok) {
          if (!globalState.mcpServers.includes(config.name)) {
            globalState.mcpServers.push(config.name);
          }
          globalEvents.emit("ui:mcp-saved", config);
          close();
        } else {
          testResult.className = "studio-mcp-test-result error";
          testResult.textContent = `\u4FDD\u5B58\u5931\u8D25\uFF1A${result.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
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
    function show() {
      isOpen = true;
      sidebar.classList.add("open");
      toggle.querySelector("svg")?.remove();
      toggle.appendChild(icon(Icons.chevronRight, 14));
      renderArtifacts();
      renderTasks();
      renderSkills();
      renderRecent();
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

  // src/ui/studio-ui-install.ts
  function installStudioUI(options) {
    console.log("[StudioUI] install start, document.body:", !!document.body);
    setHostBridge(options.host);
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
      if (options.enableSidebar !== false) {
        try {
          sidebarHandle = createSidebar();
          document.body.appendChild(sidebarHandle.container);
          containers.push(sidebarHandle.container);
          console.log("[StudioUI] sidebar installed (collapsible floating panel)");
        } catch (e) {
          console.error("[StudioUI] sidebar failed:", e);
        }
      }
      if (options.enableInputBar !== false) {
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

  // src/inject/main-world-interceptor.ts
  var currentMemories = [];
  var currentMcpTools = [];
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
  function hasToolIntent(text) {
    if (!text) return false;
    return /(Studio Agent|工作区|智能体|读|写|读取|写入|查看|列出|打开|文件|目录|文件夹|执行|运行|命令|路径|mcp|电视|tv|设备|遥控|换台|频道|音量|关机|开机|app|应用|file|read|write|list|cat|ls|dir|command|shell|run|execute|path)/i.test(text);
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
    const intent = computeIntent(parsed);
    const hasResults = pending.length > 0;
    if (!intent && !hasResults) return null;
    const block = hasResults ? formatToolResultBlock(pending.slice()) : "";
    const memoriesBlock = formatMemoriesBlock();
    if (Array.isArray(parsed.messages)) {
      let msgs = parsed.messages;
      if (intent) msgs = injectInstructionIntoMessages(msgs);
      if (intent && memoriesBlock) {
        const first = msgs[0];
        if (first && first.role === "system" && typeof first.content === "string") {
          first.content = first.content + memoriesBlock;
        }
      }
      if (hasResults) msgs = appendResultsToMessages(msgs, block);
      parsed.messages = msgs;
    } else if (typeof parsed.prompt === "string") {
      let prompt = parsed.prompt;
      if (intent && !prompt.includes(TOOL_CAPABILITY_MARKER)) {
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
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const rawSse = decoder.decode(value, { stream: true });
              const text = sse.feed(rawSse);
              const { calls, clean } = parser.feed(text);
              for (const c of calls) forward(c);
              if (clean) controller.enqueue(encoder.encode(clean));
            }
            const sseTail = sse.flush();
            if (sseTail) {
              const tailParsed = parser.feed(sseTail);
              for (const c of tailParsed.calls) forward(c);
              if (tailParsed.clean) controller.enqueue(encoder.encode(tailParsed.clean));
            }
            const fin = parser.flush();
            for (const c of fin.calls) forward(c);
            if (fin.clean) controller.enqueue(encoder.encode(fin.clean));
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
            if (!sse || !parser) {
              sse = new SseTextStreamExtractor();
              parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
              xhr.__dsSse = sse;
              xhr.__dsParser = parser;
            }
            let visible = sse.feed(part);
            if (xhr.readyState === 4) visible += sse.flush();
            if (visible) {
              diag(`xhr extracted[${visible.length}]: ${visible.slice(0, 300).replace(/\s+/g, " ")}`);
              if (loopState && loopState.inAutoContinue) {
                loopState.autoReplyText += visible;
              }
              const { calls } = parser.feed(visible);
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
  function installMainWorldInterceptor(options) {
    const { sender, diag, onAssistantReply, onMemoriesUpdate } = options;
    const pending = [];
    const d = diag ?? (() => {
    });
    {
      const g = globalThis;
      if (g.__studioMemories) currentMemories = g.__studioMemories;
    }
    const loopState = { lastChatBody: null, streamActive: false, lastResponseMsgId: null, autoReplyText: "", inAutoContinue: false };
    let autoContinueTimer = null;
    let loopDepth = 0;
    const MAX_LOOP = 8;
    const capturedHeaders = {};
    const forward = (call) => {
      d(`forward: ${call.invocationName} params=${JSON.stringify(call.params).slice(0, 200)}`);
      if (!isSupportedUpstreamTool(call.invocationName)) {
        d(`forward: unsupported, skipping`);
        return;
      }
      const callId = call.id || crypto.randomUUID();
      const startedAt = Date.now();
      try {
        stripRawToolTagsFromMessage();
        createToolCard({ toolName: call.invocationName, params: call.params }, callId);
      } catch (e) {
        d(`forward: createToolCard failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const cardData = { toolName: call.invocationName, params: call.params };
      if (call.params && call.params.__invalid_json) {
        d(`forward: invalid JSON for ${call.invocationName}, err=${call.params.__error}`);
        pending.push({
          invocationName: call.invocationName,
          ok: false,
          error: `invalid-tool-json: ${call.params.__error}. Raw body: ${String(call.params.__raw ?? "").slice(0, 300)}`
        });
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
        pending.push({ invocationName: call.invocationName, ok: r.ok, result: r.data, error: r.error });
        try {
          updateToolCardByCallId(callId, cardData, { ok: r.ok, data: r.data, error: r.error }, Date.now() - startedAt);
        } catch {
        }
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      }).catch((e) => {
        d(`forward: failed ${e instanceof Error ? e.message : String(e)}`);
        pending.push({ invocationName: call.invocationName, ok: false, error: e instanceof Error ? e.message : String(e) });
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
      }
    };
    async function autoContinueWithPow() {
      if (!loopState.lastChatBody || pending.length === 0 || loopDepth >= MAX_LOOP) return;
      loopDepth += 1;
      loopState.streamActive = true;
      try {
        const toolResults = pending.map((p) => {
          if (p.ok && p.result && typeof p.result === "object" && "stdout" in p.result) {
            const r = p.result;
            const stdout = typeof r.stdout === "string" ? r.stdout : "";
            const stderr = typeof r.stderr === "string" ? r.stderr : "";
            let text = stdout.trimEnd();
            if (stderr.trim()) text += `

<stderr>
${stderr.trimEnd()}
</stderr>`;
            return `## ${p.invocationName}
${text || "(empty output)"}`;
          }
          const result = p.ok ? typeof p.result === "string" ? p.result : JSON.stringify(p.result, null, 2) : `ERROR: ${p.error}`;
          return `## ${p.invocationName}
${result}`;
        }).join("\n\n");
        const continuationPrompt = `[TOOL_RESULTS]
${toolResults}
[/TOOL_RESULTS]

\u5982\u679C\u7ED3\u679C\u5DF2\u7ECF\u8DB3\u591F\uFF0C\u8BF7\u8F93\u51FA\u6700\u7EC8\u7ED3\u8BBA\u3002\u53EA\u6709\u5F53\u786E\u5B9E\u9700\u8981\u66F4\u591A\u4FE1\u606F\u3001\u9A8C\u8BC1\u6216\u6587\u4EF6\u4FEE\u6539\u65F6\uFF0C\u624D\u7EE7\u7EED\u8C03\u7528\u5DE5\u5177\u3002`;
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
        for (const [k, v] of Object.entries(capturedHeaders)) {
          const lower = k.toLowerCase();
          if (lower === "content-type" || lower === "content-length" || lower === "x-ds-pow-response") continue;
          filteredHeaders[k] = v;
        }
        const powHeaders = await createPowHeaders(filteredHeaders);
        d(`auto-continue loop=${loopDepth} PoW done, sending...`);
        loopState.inAutoContinue = true;
        loopState.autoReplyText = "";
        await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/v0/chat/completion", true);
          xhr.setRequestHeader("Content-Type", "application/json");
          for (const [k, v] of Object.entries(filteredHeaders)) {
            try {
              xhr.setRequestHeader(k, v);
            } catch {
            }
          }
          for (const [k, v] of Object.entries(powHeaders)) {
            try {
              xhr.setRequestHeader(k, v);
            } catch {
            }
          }
          xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
              d(`auto-continue loop=${loopDepth} status=${xhr.status} autoReplyLen=${loopState.autoReplyText.length} inAuto=${loopState.inAutoContinue}`);
              loopState.inAutoContinue = false;
              loopState.streamActive = false;
              const reply = loopState.autoReplyText.trim();
              d(`auto-continue reply len=${reply.length} hasCallback=${typeof onAssistantReply}`);
              if (reply) {
                try {
                  onAssistantReply?.(reply, loopDepth);
                } catch (e) {
                  d(`auto-continue push failed: ${e.message}`);
                }
                try {
                  const nodes = document.querySelectorAll(".ds-assistant-message-main-content");
                  const last = nodes[nodes.length - 1];
                  if (last) {
                    const existingCards = Array.from(last.querySelectorAll(".ds-studio-tool-card"));
                    last.textContent = reply;
                    for (const card of existingCards) {
                      last.appendChild(card);
                    }
                    d(`auto-continue rendered to DOM, len=${reply.length}, cards preserved=${existingCards.length}`);
                  } else {
                    d("auto-continue render: no .ds-assistant-message-main-content found");
                  }
                } catch (e) {
                  d(`auto-continue render failed: ${e.message}`);
                }
              }
              if (xhr.status === 429 && loopDepth < MAX_LOOP) {
                d("auto-continue 429, retrying in 8s");
                loopState.streamActive = false;
                if (autoContinueTimer) clearTimeout(autoContinueTimer);
                autoContinueTimer = setTimeout(() => {
                  autoContinueTimer = null;
                  autoContinueWithPow();
                }, 8e3);
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
    const origFetch = window.fetch ? window.fetch.bind(window) : void 0;
    const stopFetch = origFetch ? installFetchHook(origFetch, forward, pending, d, loopState) : void 0;
    const stopXhr = installXhrHooks(forward, pending, d, loopState, capturedHeaders);
    if (onMemoriesUpdate) {
      const originalCallback = onMemoriesUpdate;
      options.onMemoriesUpdate = (memories) => {
        currentMemories = memories;
        originalCallback(memories);
      };
    }
    let studioUIHandle = null;
    try {
      studioUIHandle = installStudioUI({
        host: {
          sendToolCall: (req) => sender(req),
          log: (text) => d(`[ui] ${text}`)
        }
      });
    } catch (e) {
      d(`studio-ui install failed: ${e.message}`);
    }
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
          studioUIHandle?.destroy();
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
  function installStudio(options = {}) {
    const origin = globalThis.location?.origin ?? "https://chat.deepseek.com";
    const sessionId = options.sessionId ?? crypto.randomUUID();
    const capabilities = dedupeById([...defaultCapabilities(), ...options.capabilities ?? []]);
    const executable = capabilities;
    const host = createHostClient({
      url: options.hostUrl ?? DEFAULT_HOST_URL,
      capabilities: executable,
      reportError: options.reportError
    });
    const remoteKv = {
      async readAll() {
        return {};
      },
      async writeBatch(batch) {
        for (const [k, v] of Object.entries(batch.set)) await host.kvSet(k, v);
        for (const k of batch.remove) await host.kvRemove(k);
      }
    };
    const runtimeTransport = {
      post: (envelope) => host.sendEnvelope(envelope)
    };
    installChromeShims({ localBackend: remoteKv, transport: runtimeTransport });
    const bridge = installDirectBridge({ origin, sessionId, reportError: options.reportError });
    bootstrapInjection({
      capabilities,
      originWhitelist: options.originWhitelist,
      lifecycleFactory: options.lifecycleFactory,
      strictInstallOrder: false
    });
    if (typeof globalThis.document !== "undefined") host.connect();
    if (typeof globalThis.document !== "undefined") {
      try {
        installMainWorldInterceptor({
          sender: (req) => host.sendToolCall(req),
          diag: (msg) => host.log(`[interceptor] ${msg}`),
          onAssistantReply: (text, loop) => host.assistantReply(text, loop),
          onMemoriesUpdate: (memories) => {
            globalThis.__studioMemories = memories;
          }
        });
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
