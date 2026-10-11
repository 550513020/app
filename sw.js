/* P2K Service Worker
   规则（两条都很重要）：
   1) 页面导航「先问网络」——服务端更新了页面，刷新就一定拿到新版，不会卡在旧界面。
   2) 断网时回落到缓存——离线也要能打开页面（断网、服务重启都不能白屏）。
   其它静态资源走后缓存；接口（/api/）完全不拦。 */
const CACHE = 'p2k-static-20261011205938';
const SHELL = './index.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 预缓存「外壳」：断网时用它兜底，保证页面能打开
    await Promise.allSettled([
      cache.add(new Request(SHELL, { cache: 'reload' })),
      // 手机版另存一份：离线重载 ?mode=app 时必须能拿到带参数的页面，
      // 否则会回落到电脑版外壳，手机界面（#phoneLibrary）就不出现了。
      cache.add(new Request('./index.html?mode=app', { cache: 'reload' })),
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
  /* stale-while-revalidate，且页面按「路径」匹配（不要求查询参数完全一致）。
     离线时打开的可能是 index.html?mode=app&offline=1，
     而预缓存的是 index.html?mode=app —— 精确匹配会落空并回落到电脑版外壳，
     手机界面就不出现了。 */
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);
  const full = url.origin + url.pathname + url.search;
  const isApp = /[?&]mode=app/.test(url.search);

  async function lookup() {
    let hit = await cache.match(full);
    if (hit) return hit;
    /* 同路径、忽略查询串：能命中 ?mode=app 那份 */
    hit = await cache.match(url.pathname, { ignoreSearch: true });
    if (hit) return hit;
    hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    return cache.match(SHELL);
  }

  const cached = await lookup();

  const refresh = fetch(request.url, { cache: 'no-store', credentials: 'same-origin' })
    .then((fresh) => {
      if (fresh && fresh.ok) {
        cache.put(full, fresh.clone());
        /* 手机版再存一份规范地址，供其它参数组合回落 */
        if (isApp) cache.put(url.origin + url.pathname + '?mode=app', fresh.clone());
        if (!url.search) cache.put(SHELL, fresh.clone());
      }
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
      /* 多级匹配：请求原样 → 忽略查询串 → 按 pathname 逐个比对。
         最后一级能兜住「URL 带参数 / Accept 头不同」导致的匹配失败，
         否则离线时 PDF.js 取不到，PDF 就渲染不出来。 */
      async function findCached() {
        let hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
        hit = await caches.match(request, { ignoreSearch: true });
        if (hit) return hit;
        const keys = await cache.keys();
        const target = url.pathname;
        for (const key of keys) {
          try {
            if (new URL(key.url).pathname === target) return cache.match(key);
          } catch (e) { /* 忽略非法 URL */ }
        }
        return null;
      }
      let hit = await findCached();
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
        const last = await findCached();
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
