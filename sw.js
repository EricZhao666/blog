// Service Worker for blog offline support
// 策略：
//   - 页面导航 / 数据脚本：network-first（保证内容及时更新），失败回退缓存
//   - vendor / 静态资源：stale-while-revalidate（先快后新）
//   - 第三方（giscus 等）：不拦截
// 每次发布请递增 CACHE_VERSION。
const CACHE_VERSION = '2026-10-23-2';
// CACHE：安装期预缓存的核心资源（只随版本整体替换）
// CACHE_RT：运行期按需缓存（页面/数据/静态笔记页），带条数上限防止无限增长
const CACHE = 'blog-' + CACHE_VERSION;
const CACHE_RT = 'blog-rt-' + CACHE_VERSION;
const RUNTIME_CACHE_CAP = 120;

// 预缓存核心资源（逐个缓存，单个失败不影响整体安装）
const CORE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './vendor/marked.min.js',
  './vendor/atom-one-light.min.css',
  './manifest.json',
  './icons/icon-192.png',
  './js/data.js',
  './js/user-posts.js',
  './js/projects.js',
  './js/app.js'
];

// 体积大的按需资源（课程 382KB / 代码库 380KB / 笔记 101KB…）：
// 不进 install 阶段，避免 SW 安装被 1MB 下载拖慢；首次访问后由 warmOptionalAssets 补齐离线副本。
const OPTIONAL_ASSETS = [
  './vendor/highlight.min.js',
  './js/courses.js',
  './js/course-notes.js',
  './js/note-slugs.js',
  './js/papers.js',
  './js/codefiles.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(
        CORE_ASSETS.map(function (url) {
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
        return k.indexOf('blog-') === 0 && k !== CACHE && k !== CACHE_RT;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// 运行期缓存写入：带条数上限，超限删掉最旧的条目
function putRuntime(req, response) {
  return caches.open(CACHE_RT).then(function (c) {
    return c.put(req, response).then(function () {
      return c.keys();
    }).then(function (keys) {
      if (keys.length <= RUNTIME_CACHE_CAP) return;
      const overflow = keys.length - RUNTIME_CACHE_CAP;
      return Promise.all(keys.slice(0, overflow).map(function (k) {
        return c.delete(k);
      }));
    });
  }).catch(function () {});
}

// 首次导航后预取可选数据脚本，补齐离线可用性（不在 install 阶段做）
let _optionalWarmed = false;
function warmOptionalAssets() {
  if (_optionalWarmed) return;
  _optionalWarmed = true;
  caches.open(CACHE_RT).then(function (cache) {
    OPTIONAL_ASSETS.forEach(function (url) {
      cache.add(url).catch(function () {});
    });
  }).catch(function () {});
}

function isSameOrigin(url) {
  return new URL(url, self.location.origin).origin === self.location.origin;
}

function isVendor(url) {
  return url.indexOf('/vendor/') !== -1;
}

// 是否为单页应用入口（站点根目录或根 index.html）
function isAppShell(pathname) {
  let scope = '/';
  try { scope = new URL(self.registration.scope).pathname; } catch (e) {}
  return pathname === '/' || pathname === '/index.html' ||
    pathname === scope || pathname === scope + 'index.html';
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (!isSameOrigin(req.url)) return; // 第三方请求（giscus 等）直接走网络

  const url = new URL(req.url);

  // 1) 页面导航：network-first
  //    只有单页应用的入口（目录根 / index.html）才回写 index.html 缓存；
  //    静态笔记页（notes/*.html）按自身 URL 缓存，否则离线打开首页会变成笔记页。
  if (req.mode === 'navigate') {
    warmOptionalAssets();
    const cachedKey = isAppShell(url.pathname) ? './index.html' : req;
    e.respondWith(
      fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          putRuntime(cachedKey, resp.clone());
        }
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (cached) {
          if (cached) return cached;
          return caches.match('./index.html');
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
          if (resp && resp.ok) putRuntime(req, resp.clone());
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
      if (resp && resp.ok) putRuntime(req, resp.clone());
      return resp;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        return Response.error();
      });
    })
  );
});
