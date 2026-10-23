// Service Worker for blog offline support
// 策略：
//   - 页面导航 / 数据脚本：network-first（保证内容及时更新），失败回退缓存
//   - vendor / 静态资源：stale-while-revalidate（先快后新）
//   - 第三方（giscus 等）：不拦截
// 每次发布请递增 CACHE_VERSION。
const CACHE_VERSION = '2026-10-23-4';
// CACHE：安装期预缓存的核心资源（只随版本整体替换）
// CACHE_RT：运行期按需缓存（页面/数据/静态笔记页），带条数上限防止无限增长
const CACHE = 'blog-' + CACHE_VERSION;
const CACHE_RT = 'blog-rt-' + CACHE_VERSION;
const RUNTIME_CACHE_CAP = 120;

// 必需资源：缺任何一个都不能宣称"离线安装成功"。
// 这些文件缺失时页面根本跑不起来，所以安装失败比"装上一个残缺版本"更安全。
const REQUIRED_ASSETS = [
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/data.js'
];

// 可选资源：预缓存失败只降级（在线仍可用），不阻断安装
const OPTIONAL_CORE = [
  './',
  './vendor/marked.min.js',
  './vendor/atom-one-light.min.css',
  './manifest.json',
  './icons/icon-192.png',
  './js/user-posts.js',
  './js/projects.js'
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
      // 1) 必需资源：任一失败 → 整个 install 失败 → 浏览器保留旧 SW 继续服务
      return Promise.all(REQUIRED_ASSETS.map(function (url) {
        return cache.add(url).catch(function (err) {
          throw new Error('required asset failed: ' + url + ' (' + (err && err.message) + ')');
        });
      })).then(function () {
        // 2) 可选资源：失败只告警，不阻断安装
        return Promise.all(OPTIONAL_CORE.map(function (url) {
          return cache.add(url).catch(function () {
            console.warn('[SW] optional precache skipped:', url);
          });
        }));
      });
    }).catch(function (err) {
      // 半成品缓存直接丢掉，避免下次复用时出现"有缓存但缺关键文件"的假象
      console.error('[SW] install failed, keep previous version:', err && err.message);
      return caches.delete(CACHE).then(function () { throw err; });
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
    }).then(function () {
      // 首次安装时首屏请求还没被 SW 接管，navigate 分支拿不到，
      // 所以预热必须在 activate 阶段补一次（已有副本会被跳过）。
      return warmOptionalAssets();
    })
  );
});

// 运行期缓存写入：带条数上限，超限删掉最旧的条目。
// 用串行队列写，否则并发 put 会各自看到"未超限"的旧计数，最终超出上限。
let _rtWriteQueue = Promise.resolve();
function putRuntime(req, response) {
  _rtWriteQueue = _rtWriteQueue.then(function () {
    return _putRuntime(req, response);
  }).catch(function () {});
  return _rtWriteQueue;
}

function _putRuntime(req, response) {
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
// 返回 Promise，由调用方用 e.waitUntil 跟踪，避免 SW 被提前终止导致预取半途而废。
// 已有副本就跳过：SW 频繁重启时不会反复下载同一批文件。
function warmOptionalAssets() {
  return caches.open(CACHE_RT).then(function (cache) {
    return Promise.all(OPTIONAL_ASSETS.map(function (url) {
      return cache.match(url).then(function (hit) {
        if (hit) return null;
        return cache.add(url).catch(function () { return null; });
      });
    }));
  }).catch(function () { return null; });
}

// 统一的缓存查找顺序：运行期缓存（较新）优先，其次安装期缓存，
// 避免同一 URL 在 CORE 里有旧副本时总是命中旧内容。
function matchAny(req) {
  return caches.match(req, { cacheName: CACHE_RT }).then(function (hit) {
    return hit || caches.match(req, { cacheName: CACHE });
  });
}

// 离线兜底页：用于"没缓存过的页面"。绝不能拿首页顶替，否则会显示成别的页面。
function offlineResponse() {
  return new Response(
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>当前离线</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;' +
    'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#f8f9fb;color:#1e293b}main{text-align:center;padding:24px}a{color:#2563eb}</style>' +
    '</head><body data-offline="1"><main><h1>当前离线</h1>' +
    '<p>这个页面还没有离线副本，联网后重试。</p><p><a href="./">返回首页</a></p></main></body></html>',
    { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
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
    // 预取交给 waitUntil 跟踪：SW 被终止前浏览器会等它完成
    try { e.waitUntil(warmOptionalAssets()); } catch (err) { /* 老浏览器忽略 */ }
    const cachedKey = isAppShell(url.pathname) ? './index.html' : req;
    e.respondWith(
      fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          // 用 waitUntil 跟踪写缓存：否则 SW 可能在写入完成前被回收
          try { e.waitUntil(putRuntime(cachedKey, resp.clone())); } catch (err) {}
        }
        return resp;
      }).catch(function () {
        return matchAny(req).then(function (cached) {
          if (cached) return cached;
          // 只有 SPA 入口才回退到 index.html；其它页面给明确的离线提示
          if (isAppShell(url.pathname)) return caches.match('./index.html');
          return offlineResponse();
        });
      })
    );
    return;
  }

  // 2) vendor 静态资源：stale-while-revalidate
  if (isVendor(url.pathname)) {
    e.respondWith(
      matchAny(req).then(function (cached) {
        const network = fetch(req).then(function (resp) {
          if (resp && resp.ok) {
            try { e.waitUntil(putRuntime(req, resp.clone())); } catch (err) {}
          }
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
      if (resp && resp.ok) {
        try { e.waitUntil(putRuntime(req, resp.clone())); } catch (err) {}
      }
      return resp;
    }).catch(function () {
      return matchAny(req).then(function (cached) {
        if (cached) return cached;
        return Response.error();
      });
    })
  );
});
