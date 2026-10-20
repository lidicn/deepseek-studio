// DeepSeek Studio 工作台 Service Worker（P2）
//
// 缓存策略（有意设计，别改）：
//   /agent.css、/agent.js  → cache-first：静态壳，离线可开
//   /agent                 → network-only：HTML 内嵌真实 API 令牌，禁止落盘
//   /agent.webmanifest、图标 → cache-first：不含敏感信息
//   其余                    → network-only，不拦截
//
// 令牌安全：/agent 的响应头是 Cache-Control: no-store（server.ts），
// 这里再显式 network-only 双保险——SW 缓存一次就等于把令牌写进磁盘。

const CACHE = 'ds-studio-shell-v1';

const SHELL_ASSETS = [
  '/agent.css',
  '/agent.js',
  '/agent.webmanifest',
  '/agent-icon-192.png',
  '/agent-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // /agent：含令牌，绝不缓存。
  if (path === '/agent') return;

  if (path === '/agent.css' || path === '/agent.js') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match('/agent.css'))),
    );
    return;
  }

  if (path === '/agent.webmanifest' || path.startsWith('/agent-icon-')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
  }
});
