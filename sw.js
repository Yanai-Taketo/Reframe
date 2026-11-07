const VERSION = '1.5.4';
const CACHE = 'reframe-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/store.js',
  './js/camera.js',
  './js/compare.js',
  './js/meta.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];
/* キャッシュするのは上の一覧にあるファイルだけ。クエリ文字列は無視してパスで管理する */
const ASSET_PATHS = new Set(ASSETS.map(u => new URL(u, self.location.href).pathname));
const INDEX = new URL('./index.html', self.location.href).pathname;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('reframe-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 新しい版への切り替えは、利用者が「再読み込み」を選んだときに行う */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/* キャッシュがあればすぐ返し、裏で取り直して次回に備える */
function staleWhileRevalidate(path) {
  return caches.match(path).then(cached => {
    const network = fetch(new Request(path, { cache: 'no-cache' })).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(path, copy));
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(INDEX));
    return;
  }
  if (!ASSET_PATHS.has(url.pathname)) return;
  event.respondWith(staleWhileRevalidate(url.pathname));
});
