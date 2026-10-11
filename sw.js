/* P2K Service Worker
   规则（两条都很重要）：
   1) 页面导航「先问网络」——服务端更新了页面，刷新就一定拿到新版，不会卡在旧界面。
   2) 断网时回落到缓存——离线也要能打开页面（断网、服务重启都不能白屏）。
   其它静态资源走后缓存；接口（/api/）完全不拦。 */
const CACHE = 'p2k-static-20261011202609';
const SHELL = './index.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 预缓存「外壳」：断网时用它兜底，保证页面能打开
    await Promise.allSettled([
      cache.add(new Request(SHELL, { cache: 'reload' })),
      cache.add('./manifest.json'),
      cache.add('./assets/p2k-icon.svg'),
      // 离线也要能用 PDF 阅读器与钢琴发音，所以安装时就预缓存
      cache.add(new Request('./assets/pdfjs/pdf.min.mjs', { cache: 'reload' })),
      cache.add(new Request('./assets/pdfjs/pdf.worker.min.mjs', { cache: 'reload' })),
      cache.add(new Request('./assets/piano-samples.json', { cache: 'reload' })),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('p2k-static-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  /* stale-while-revalidate：
     先给缓存（打开即显示，不再等整页下载），同时后台拉最新版写回缓存。
     只有第一次打开（没有缓存）才会等待网络。 */
  const cache = await caches.open(CACHE);
  const cached = (await cache.match(SHELL)) || (await caches.match('./'));

  const refresh = fetch(request.url, { cache: 'no-store', credentials: 'same-origin' })
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(SHELL, fresh.clone());
      return fresh;
    })
    .catch(() => null);

  if (cached) return cached;            /* 有缓存：立刻返回，后台更新 */

  const fresh = await refresh;
  if (fresh && fresh.ok) return fresh;
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>谱键 P2K</title>'
    + '<body style="font-family:system-ui;padding:28px;background:#f6f8f3;color:#20352f">'
    + '<h2>离线中</h2><p>这台设备还没缓存到页面。请先联网打开一次，之后离线也能用。</p>'
    + '<p style="color:#6b7c75">如果在手机 App 里看到这页：App 内置的离线页面本来就在本机，'
    + '从 App 图标进入即可离线练习。</p></body>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/api/')) return;                 // 接口不拦

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // PDF.js / 钢琴采样：这些是模块与音频数据，必须「缓存优先」，
  // 断网时也要能用（离线看谱 + 离线发音）。
  if (/\/assets\/(pdfjs\/|piano-samples\.json)/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      let hit = await cache.match(request, { ignoreSearch: true });
      if (!hit) hit = await caches.match(request, { ignoreSearch: true });
      if (hit) {
        // 后台顺手更新一份，但本次先返回缓存，保证离线可用
        fetch(request).then((fresh) => {
          if (fresh && fresh.ok) cache.put(request, fresh.clone());
        }).catch(() => {});
        return hit;
      }
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (error) {
        const last = await cache.match(request, { ignoreSearch: true });
        if (last) return last;
        return new Response('', { status: 504, statusText: 'offline and not cached' });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      fetch(request).then((fresh) => {
        if (fresh && fresh.ok) caches.open(CACHE).then((c) => c.put(request, fresh.clone()));
      }).catch(() => {});
      return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && url.origin === location.origin) {
        caches.open(CACHE).then((c) => c.put(request, fresh.clone()));
      }
      return fresh;
    } catch (error) {
      const fallback = await caches.match(request);
      if (fallback) return fallback;
      throw error;
    }
  })());
});
