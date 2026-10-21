// Service Worker for blog offline support
// 策略：
//   - 页面导航 / 数据脚本：network-first（保证内容及时更新），失败回退缓存
//   - vendor / 静态资源：stale-while-revalidate（先快后新）
//   - 第三方（giscus 等）：不拦截
// 每次发布请递增 CACHE_VERSION。
const CACHE_VERSION = '2026-10-21-2';
const CACHE = 'blog-' + CACHE_VERSION;

// 预缓存核心资源（逐个缓存，单个失败不影响整体安装）
const CORE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './vendor/marked.min.js',
  './vendor/atom-one-light.min.css',
  './js/data.js',
  './js/user-posts.js',
  './js/projects.js',
  './js/app.js'
];

// 按需缓存的资源（体积大，首屏不需要；后台预缓存以便离线可用）
const OPTIONAL_ASSETS = [
  './vendor/highlight.min.js',
  './js/courses.js',
  './js/course-notes.js',
  './js/papers.js',
  './js/codefiles.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(
        CORE_ASSETS.concat(OPTIONAL_ASSETS).map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[SW] precache skipped:', url, err && err.message);
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('blog-') === 0 && k !== CACHE;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isSameOrigin(url) {
  return new URL(url, self.location.origin).origin === self.location.origin;
}

function isVendor(url) {
  return url.indexOf('/vendor/') !== -1;
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (!isSameOrigin(req.url)) return; // 第三方请求（giscus 等）直接走网络

  const url = new URL(req.url);

  // 1) 页面导航：network-first
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (resp) {
        const copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return resp;
      }).catch(function () {
        return caches.match('./index.html').then(function (cached) {
          return cached || caches.match('./');
        });
      })
    );
    return;
  }

  // 2) vendor 静态资源：stale-while-revalidate
  if (isVendor(url.pathname)) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        const network = fetch(req).then(function (resp) {
          const copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return resp;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
    return;
  }

  // 3) 其他同源资源（HTML/CSS/JS/数据）：network-first，失败回退缓存
  e.respondWith(
    fetch(req).then(function (resp) {
      const copy = resp.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return resp;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
