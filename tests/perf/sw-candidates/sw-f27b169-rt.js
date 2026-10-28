// Service Worker for blog offline support
// 策略（Batch 6B 起）：
//   - 首屏（app shell + style.css/app.js/data.js/user-posts.js/projects.js）：
//     网络优先，但超过 NAV_TIMEOUT_MS 就用同一版本缓存，并后台回填网络结果。
//     导航时只做一次决策，同一文档的首屏子资源沿用该决策，避免"新 HTML + 旧脚本"混版。
//   - 其他页面导航 / 静态笔记页：network-first（保证内容及时更新），失败回退缓存
//   - vendor / 静态资源：stale-while-revalidate（先快后新）
//   - 第三方（giscus 等）：不拦截
// 每次发布请递增 CACHE_VERSION。
const CACHE_VERSION = '2026-10-26-1';
// CACHE：安装期预缓存的核心资源（只随版本整体替换）
// CACHE_RT：运行期按需缓存（页面/数据/静态笔记页），带条数上限防止无限增长
const CACHE = 'blog-' + CACHE_VERSION;
const CACHE_RT = 'blog-rt-' + CACHE_VERSION;
const RUNTIME_CACHE_CAP = 120;

// 首屏资源必须"网络优先"的超时阈值：低于它在快速网络下仍然拿到最新版本，
// 高于它则先用缓存保证可交互（移动整形链路上，首页外壳约 170 ms、首屏脚本 300~1400 ms）。
const NAV_TIMEOUT_MS = 150;
// 一次导航的决策缓存时间：同一文档的子资源沿用导航时的决策
const NAV_MODE_TTL = 15000;

// 必需资源：缺任何一个都不能宣称"离线安装成功"。
// 这些文件缺失时页面根本跑不起来，所以安装失败比"装上一个残缺版本"更安全。
const REQUIRED_ASSETS = [
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/data.js',
  './vendor/marked.min.js',
  './vendor/purify.min.js'
];

// 可选资源：预缓存失败只降级（在线仍可用），不阻断安装
// 注意：不要重复列出 REQUIRED_ASSETS 里的文件 —— 早先 ./vendor/marked.min.js 同时出现在两处，
// 导致每次安装都多下载 39 903 B（实测冷启动服务端命中数多 1）。
const OPTIONAL_CORE = [
  './',
  './vendor/atom-one-light.min.css',
  './manifest.json',
  './icons/icon-192.png',
  './js/user-posts.js',
  './js/projects.js'
];

// 体积大的按需资源（笔记 101KB / 课程 15KB / 论文 42KB…）：
// 不进 install 阶段，避免 SW 安装被 1MB 下载拖慢；首次访问后由 warmOptionalAssets 补齐离线副本。
// 注意：./js/codefiles.js（380KB，仅 /code 路由使用）不在预取集合里 ——
// 它由 app.js 的路由懒加载在真正访问 /code 时拉取，随后经 network-first 分支进入运行期缓存。
const OPTIONAL_ASSETS = [
  './vendor/highlight.min.js',
  './js/courses.js',
  './js/course-notes.js',
  './js/note-slugs.js',
  './js/papers.js'
];

// 首屏资源（相对 scope）：首页渲染直接依赖，必须与外壳保持同一版本
const FIRST_SCREEN_ASSETS = [
  'css/style.css',
  'js/app.js',
  'js/data.js',
  'js/user-posts.js',
  'js/projects.js'
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

// 用缓存键（相对 URL 字符串，或静态笔记页的 Request）查缓存
function cacheUrl(key) {
  if (key && typeof key !== 'string' && key.url) return key.url;
  return new URL(key, self.location.href).href;
}

function matchKey(key) {
  const u = cacheUrl(key);
  return caches.match(u, { cacheName: CACHE_RT }).then(function (hit) {
    return hit || caches.match(u, { cacheName: CACHE });
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

// 首屏资源判定：返回用于缓存读写的相对 key，非首屏返回 null
function firstScreenKey(pathname) {
  let scope = '/';
  try { scope = new URL(self.registration.scope).pathname; } catch (e) {}
  if (pathname.indexOf(scope) !== 0) return null;
  const rel = pathname.slice(scope.length);
  return FIRST_SCREEN_ASSETS.indexOf(rel) === -1 ? null : rel;
}

// ---------------------------------------------------------------- 首屏策略
// 导航时只决策一次：网络在 NAV_TIMEOUT_MS 内给了外壳 → 本次文档全部走网络；
// 超时 → 本次文档全部用同版本缓存（并后台回填），从而不会出现混版。
const _navMode = new Map();

function setNavMode(clientId, mode) {
  if (!clientId) return;
  _navMode.set(clientId, { mode: mode, at: Date.now() });
  if (_navMode.size > 50) {
    const cut = Date.now() - NAV_MODE_TTL;
    _navMode.forEach(function (v, k) { if (v.at < cut) _navMode.delete(k); });
  }
}

function getNavMode(req) {
  if (!req.clientId) return null;
  const rec = _navMode.get(req.clientId);
  if (!rec) return null;
  if (Date.now() - rec.at > NAV_MODE_TTL) { _navMode.delete(req.clientId); return null; }
  return rec.mode;
}

// 网络优先（成功即回写缓存）
function networkFirst(req, key) {
  return fetch(req).then(function (resp) {
    if (resp && resp.ok) putRuntime(key, resp.clone());
    return resp;
  });
}

// 后台回填：命中过缓存的资源才回源，避免首次访问重复下载
function revalidateInBackground(req, key, e) {
  const task = matchKey(key).then(function (cached) {
    if (!cached) return null;
    return fetch(req).then(function (resp) {
      if (resp && resp.ok) return putRuntime(key, resp.clone());
      return null;
    }).catch(function () { return null; });
  });
  try { e.waitUntil(task); } catch (err) {}
  return task;
}

// 单个资源：网络优先 + 超时回退缓存（用于没有导航上下文的请求）
function timeoutFirst(req, key, e, onNetworkFail) {
  return new Promise(function (resolve) {
    let settled = false;
    const finish = function (r) {
      if (settled || !r) return;
      settled = true;
      resolve(r);
    };

    const net = fetch(req).then(function (resp) {
      if (resp && resp.ok) return putRuntime(key, resp.clone()).then(function () { return resp; });
      return resp;
    });

    const timer = setTimeout(function () {
      matchKey(key).then(function (cached) { if (cached) finish(cached); });
    }, NAV_TIMEOUT_MS);

    net.then(function (resp) {
      clearTimeout(timer);
      finish(resp);
    }).catch(function () {
      clearTimeout(timer);
      matchKey(key).then(function (cached) { finish(cached || onNetworkFail()); });
    });

    try { e.waitUntil(net.then(function () { return null; }).catch(function () { return null; })); } catch (err) {}
  });
}

// 应用外壳导航：先做一次版本决策，再决定本次文档的首屏子资源走网络还是缓存
function shellNavigate(req, e) {
  return new Promise(function (resolve) {
    let settled = false;
    const finish = function (resp, source) {
      if (settled) return;
      settled = true;
      // 顶层导航自身没有 clientId，e.resultingClientId 才是新文档的 client id，
      // 也就是后续首屏子资源请求里的 request.clientId。
      setNavMode(e.resultingClientId || req.clientId, source);
      resolve(resp);
    };

    const net = fetch(req).then(function (resp) {
      if (resp && resp.ok) return putRuntime('./index.html', resp.clone()).then(function () { return resp; });
      return resp;
    });

    const timer = setTimeout(function () {
      matchKey('./index.html').then(function (cached) { if (cached) finish(cached, 'cache'); });
    }, NAV_TIMEOUT_MS);

    net.then(function (resp) {
      clearTimeout(timer);
      finish(resp, 'network');
    }).catch(function () {
      clearTimeout(timer);
      matchKey('./index.html').then(function (cached) {
        finish(cached || offlineResponse(), 'cache');
      });
    });

    try { e.waitUntil(net.then(function () { return null; }).catch(function () { return null; })); } catch (err) {}
  });
}

function firstScreenResponse(req, key, e) {
  const mode = getNavMode(req);
  if (mode === 'cache') {
    // 与本次导航的外壳同版本：立刻给缓存，后台静默更新（下次导航生效）
    revalidateInBackground(req, key, e);
    return matchKey(key).then(function (cached) {
      return cached || networkFirst(req, key).catch(function () { return Response.error(); });
    });
  }
  if (mode === 'network') {
    return networkFirst(req, key).catch(function () {
      return matchKey(key).then(function (cached) { return cached || Response.error(); });
    });
  }
  // 没有导航上下文（例如直接打开子资源）：退回单资源超时策略
  return timeoutFirst(req, key, e, function () { return Response.error(); });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (!isSameOrigin(req.url)) return; // 第三方请求（giscus 等）直接走网络

  const url = new URL(req.url);

  // 1) 页面导航
  if (req.mode === 'navigate') {
    // 预取交给 waitUntil 跟踪：SW 被终止前浏览器会等它完成
    try { e.waitUntil(warmOptionalAssets()); } catch (err) { /* 老浏览器忽略 */ }
    if (isAppShell(url.pathname)) {
      e.respondWith(shellNavigate(req, e));
      return;
    }
    // 静态笔记页（notes/*.html）按自身 URL 缓存，否则离线打开首页会变成笔记页
    e.respondWith(
      fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          // 用 waitUntil 跟踪写缓存：否则 SW 可能在写入完成前被回收
          try { e.waitUntil(putRuntime(req, resp.clone())); } catch (err) {}
        }
        return resp;
      }).catch(function () {
        return matchAny(req).then(function (cached) {
          if (cached) return cached;
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

  // 3) 首屏资源：跟随本次导航的决策（网络优先 / 同版本缓存）
  const key = firstScreenKey(url.pathname);
  if (key) {
    e.respondWith(firstScreenResponse(req, key, e));
    return;
  }

  // 4) 其他同源资源（HTML/CSS/JS/数据）：network-first，失败回退缓存
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
