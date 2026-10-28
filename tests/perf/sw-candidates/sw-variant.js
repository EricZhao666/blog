// Batch 6B：Service Worker 候选策略实验副本（不进生产，仅供 tests/perf 测量）
//
// 来源：sw.js @ a77bd07（2026-10-23-5）。相对生产 sw.js 的唯一差异是：
//   1) 顶部新增 CONFIG 块，用两个开关选择策略；
//   2) 预取集合/触发时机按 CONFIG.prefetch 决定；
//   3) 首屏资源（app shell + 首屏脚本样式）的响应策略按 CONFIG.hotStart 决定；
//   4) 新增 message 处理器，把当前生效的策略回给测量脚本（用于归因，不改变行为）。
// 其余逻辑（安装失败保护、离线兜底页、RT 缓存上限 120、skipWaiting/clients.claim、
// vendor SWR、静态笔记页 network-first）与生产版本逐行一致。
//
// 策略取值：
//   prefetch: 'immediate'（= 生产行为：activate 后立刻预取全部可选资源）
//             'deferred' （同样 6 个资源，但首次导航后延迟 N ms 再开始）
//             'selective'（只预取首页/搜索需要的 5 个，codefiles.js 交给 /code 路由按需加载）
//   hotStart: 'network-first'（= 生产行为）
//             'swr'          （先给缓存，后台校验更新）
//             'timeout'      （网络优先，超时 fallback 到缓存，网络结果继续回填；逐资源决策）
//             'consistent'   （同 timeout，但导航时只决策一次，首屏子资源沿用同一决策，避免混版）
const CONFIG = {
  prefetch: 'immediate',
  prefetchDelayMs: 4000,
  hotStart: 'network-first',
  hotStartTimeoutMs: 300
};

const CACHE_VERSION = '2026-10-23-5';
const CACHE = 'blog-' + CACHE_VERSION;
const CACHE_RT = 'blog-rt-' + CACHE_VERSION;
const RUNTIME_CACHE_CAP = 120;

const REQUIRED_ASSETS = [
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/data.js',
  './vendor/marked.min.js',
  './vendor/purify.min.js'
];

const OPTIONAL_CORE = [
  './',
  './vendor/marked.min.js',
  './vendor/atom-one-light.min.css',
  './manifest.json',
  './icons/icon-192.png',
  './js/user-posts.js',
  './js/projects.js'
];

const OPTIONAL_ASSETS = [
  './vendor/highlight.min.js',
  './js/courses.js',
  './js/course-notes.js',
  './js/note-slugs.js',
  './js/papers.js',
  './js/codefiles.js'
];

// 首屏「必须等网络」的资源：应用外壳 + 首页渲染直接依赖的样式与脚本。
const FIRST_SCREEN_ASSETS = [
  'css/style.css',
  'js/app.js',
  'js/data.js',
  'js/user-posts.js',
  'js/projects.js'
];

// 预取集合：selective 只去掉 codefiles.js（380 KB，仅 /code 路由使用）
const PREFETCH_SET = CONFIG.prefetch === 'selective'
  ? OPTIONAL_ASSETS.filter(function (u) { return u.indexOf('codefiles.js') === -1; })
  : OPTIONAL_ASSETS;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(REQUIRED_ASSETS.map(function (url) {
        return cache.add(url).catch(function (err) {
          throw new Error('required asset failed: ' + url + ' (' + (err && err.message) + ')');
        });
      })).then(function () {
        return Promise.all(OPTIONAL_CORE.map(function (url) {
          return cache.add(url).catch(function () {
            console.warn('[SW] optional precache skipped:', url);
          });
        }));
      });
    }).catch(function (err) {
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
      // 只有 immediate 在 activate 阶段预热；deferred 交给首次导航后的延迟任务
      if (CONFIG.prefetch === 'immediate' || CONFIG.prefetch === 'selective') {
        return warmOptionalAssets();
      }
      return null;
    })
  );
});

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

function warmOptionalAssets() {
  return caches.open(CACHE_RT).then(function (cache) {
    return Promise.all(PREFETCH_SET.map(function (url) {
      return cache.match(url).then(function (hit) {
        if (hit) return null;
        return cache.add(url).catch(function () { return null; });
      });
    }));
  }).catch(function () { return null; });
}

// 预取调度：immediate/selective 每次导航都会补（已有副本跳过）；
// deferred 不在这里做 —— 由页面在 load 之后延迟 postMessage('warm-optional') 触发。
function schedulePrefetch(e) {
  if (CONFIG.prefetch === 'deferred') return;
  try { e.waitUntil(warmOptionalAssets()); } catch (err) { /* 老浏览器忽略 */ }
}

function matchAny(req) {
  return caches.match(req, { cacheName: CACHE_RT }).then(function (hit) {
    return hit || caches.match(req, { cacheName: CACHE });
  });
}

// 用「相对 URL 字符串」做缓存键（导航外壳、首屏资源都走这里）；
// 静态笔记页传入的是 Request，直接取它的 url，避免 new URL(Request) 抛错。
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

// ---------------------------------------------------------------- 响应策略
// 网络优先（生产行为）：成功即回写缓存，失败回退缓存
function networkFirst(req, key) {
  return fetch(req).then(function (resp) {
    if (resp && resp.ok) putRuntime(key, resp.clone());
    return resp;
  });
}

// 先缓存后网络：命中即返回，同时后台校验更新（同一 promise 内完成回写，交给 waitUntil 跟踪）
function staleWhileRevalidate(req, key) {
  return matchKey(key).then(function (cached) {
    if (!cached) return networkFirst(req, key);
    return cached;
  });
}

function revalidateInBackground(req, key, e) {
  const task = matchKey(key).then(function (cached) {
    // 没有缓存副本时不额外发请求（否则首访会重复下载一次）
    if (!cached) return null;
    return fetch(req).then(function (resp) {
      if (resp && resp.ok) return putRuntime(key, resp.clone());
      return null;
    }).catch(function () { return null; });
  });
  try { e.waitUntil(task); } catch (err) {}
  return task;
}

// ---------------------------------------------------------------- 一致性模式（timeout + 导航决策）
// 问题：每个资源各自超时回退，可能出现「HTML 来自网络（新）+ 脚本来自缓存（旧）」的混版。
// 做法：导航时先做一次决策（网络是否在 N ms 内给出首页外壳），把结果按 clientId 记住；
//       同一文档的首屏子资源沿用同一次决策，因此要么全走网络，要么全走同版本缓存。
const NAV_MODE_TTL = 15000;
const _navMode = new Map();

// 导航请求本身的 clientId 为空（顶层导航没有发起方），必须用 e.resultingClientId
// —— 它才是「这次导航产生的新文档」的 client id，也就是后续子资源请求的 clientId。
function setNavMode(clientId, mode) {
  if (!clientId) return;
  _navMode.set(clientId, { mode: mode, at: Date.now() });
  if (_navMode.size > 50) {
    const cut = Date.now() - NAV_MODE_TTL;
    _navMode.forEach(function (v, k) { if (v.at < cut) _navMode.delete(k); });
  }
}

function getNavMode(req) {
  const rec = req.clientId ? _navMode.get(req.clientId) : null;
  if (!rec) return null;
  if (Date.now() - rec.at > NAV_MODE_TTL) { _navMode.delete(req.clientId); return null; }
  return rec.mode;
}

function navigateConsistent(req, key, shell, e) {
  return new Promise(function (resolve) {
    let settled = false;
    const finish = function (resp, source) {
      if (settled) return;
      settled = true;
      setNavMode(e.resultingClientId || req.clientId, source);
      resolve(resp);
    };

    const net = fetch(req).then(function (resp) {
      if (resp && resp.ok) return putRuntime(key, resp.clone()).then(function () { return resp; });
      return resp;
    });

    const timer = setTimeout(function () {
      matchKey(key).then(function (cached) { if (cached) finish(cached, 'cache'); });
    }, CONFIG.hotStartTimeoutMs);

    net.then(function (resp) { clearTimeout(timer); finish(resp, 'network'); })
      .catch(function () {
        clearTimeout(timer);
        matchKey(key).then(function (cached) {
          if (cached) return finish(cached, 'cache');
          finish(offlineResponse(), 'cache');
        });
      });

    try { e.waitUntil(net.then(function () { return null; }).catch(function () { return null; })); } catch (err) {}
  });
}

function assetConsistent(req, key, e) {
  const mode = getNavMode(req);
  if (mode === 'cache') {
    // 与本次导航的外壳保持同版本：立刻给缓存，后台静默更新（下次导航生效）
    revalidateInBackground(req, key, e);
    return matchKey(key).then(function (cached) { return cached || networkFirst(req, key); });
  }
  if (mode === 'network') {
    return networkFirst(req, key).catch(function () { return matchKey(key); });
  }
  // 没有导航上下文（例如页面首次打开时的并行请求）：退回单资源超时策略
  return timeoutFirst(req, key, e, function () { return Response.error(); });
}

// 网络优先 + 超时回退缓存：超时后先给旧副本，网络结果继续回填
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
    }, CONFIG.hotStartTimeoutMs);

    net.then(function (resp) {
      clearTimeout(timer);
      finish(resp);
    }).catch(function () {
      clearTimeout(timer);
      matchKey(key).then(function (cached) {
        if (cached) return finish(cached);
        finish(onNetworkFail());
      });
    });

    try { e.waitUntil(net.then(function () { return null; }).catch(function () { return null; })); } catch (err) {}
  });
}

function navigateNetworkFirst(req, key, shell, e) {
  return fetch(req).then(function (resp) {
    if (resp && resp.ok) putRuntime(key, resp.clone());
    return resp;
  }).catch(function () {
    return matchAny(req).then(function (cached) {
      if (cached) return cached;
      if (shell) return caches.match('./index.html');
      return offlineResponse();
    });
  });
}

function navigateResponse(req, key, shell, e) {
  if (CONFIG.hotStart === 'consistent') {
    return navigateConsistent(req, key, shell, e);
  }
  if (CONFIG.hotStart === 'swr') {
    revalidateInBackground(req, key, e);
    return staleWhileRevalidate(req, key).catch(function () {
      return shell ? caches.match('./index.html') : offlineResponse();
    });
  }
  if (CONFIG.hotStart === 'timeout') {
    return timeoutFirst(req, key, e, function () {
      return shell ? caches.match('./index.html') : offlineResponse();
    });
  }
  return navigateNetworkFirst(req, key, shell, e);
}

function assetResponse(req, key, e) {
  if (CONFIG.hotStart === 'consistent') {
    return assetConsistent(req, key, e);
  }
  if (CONFIG.hotStart === 'swr') {
    revalidateInBackground(req, key, e);
    return staleWhileRevalidate(req, key).catch(function () { return matchKey(key); });
  }
  if (CONFIG.hotStart === 'timeout') {
    return timeoutFirst(req, key, e, function () { return Response.error(); });
  }
  return networkFirst(req, key).catch(function () {
    return matchKey(key).then(function (cached) { return cached || Response.error(); });
  });
}

self.addEventListener('message', function (e) {
  const data = e.data || {};
  if (data.type === 'warm-optional') {
    // 页面侧触发的延迟预取：必须由页面在真正空闲时发起，
    // 因为 SW 本身在空闲事件之间会被浏览器终止（实测 setTimeout 方案会直接丢任务）。
    e.waitUntil(warmOptionalAssets());
    return;
  }
  if (data.type !== 'sw-variant-info') return;
  const reply = {
    type: 'sw-variant-info',
    config: CONFIG,
    caches: { core: CACHE, runtime: CACHE_RT },
    prefetchSet: PREFETCH_SET,
    firstScreenAssets: FIRST_SCREEN_ASSETS
  };
  if (e.ports && e.ports[0]) e.ports[0].postMessage(reply);
  else if (e.source) e.source.postMessage(reply);
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (!isSameOrigin(req.url)) return;

  const url = new URL(req.url);

  // 1) 页面导航
  if (req.mode === 'navigate') {
    schedulePrefetch(e);
    const shell = isAppShell(url.pathname);
    const key = shell ? './index.html' : req;
    e.respondWith(navigateResponse(req, key, shell, e));
    return;
  }

  // 2) vendor 静态资源：stale-while-revalidate（不变）
  if (isVendor(url.pathname)) {
    e.respondWith(
      matchAny(req).then(function (cached) {
        const network = fetch(req).then(function (resp) {
          if (resp && resp.ok) putRuntime(req, resp.clone());
          return resp;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
    return;
  }

  // 3) 首屏资源：按 hotStart 策略
  const key = firstScreenKey(url.pathname);
  if (key) {
    e.respondWith(assetResponse(req, key, e));
    return;
  }

  // 4) 其他同源资源（HTML/CSS/JS/数据）：network-first，失败回退缓存（不变）
  e.respondWith(
    fetch(req).then(function (resp) {
      if (resp && resp.ok) putRuntime(req, resp.clone());
      return resp;
    }).catch(function () {
      return matchAny(req).then(function (cached) {
        if (cached) return cached;
        return Response.error();
      });
    })
  );
});
