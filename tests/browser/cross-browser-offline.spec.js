#!/usr/bin/env node
'use strict';
/**
 * Batch 8E-4：Service Worker 离线可靠性与历史风险定向验证（Phase D + E）
 *
 * Phase D：注册/控制、离线首页与文章、未缓存降级、网络恢复、版本切换、
 *          新版本安装失败回退、多标签升级、IndexedDB/CacheStorage 不可用降级。
 * Phase E：B8E1-003（snapshotReady 失败态在 SW 生命周期内不可自愈）定向复现。
 *
 * 不使用 CDP；全部通过 Playwright 公共 API + 本地 HTTP 故障注入完成，
 * 因此可在 Chromium / Firefox / WebKit 走同一套场景。
 *
 * 用法：
 *   node tests/browser/cross-browser-offline.spec.js
 *   node tests/browser/cross-browser-offline.spec.js --engines=firefox
 *   node tests/browser/cross-browser-offline.spec.js --scenario=E
 *
 * 退出码：0 通过；1 有 FAIL；2 有引擎 BLOCKED。
 * 说明：状态等待全部有界；某项在引擎自动化环境不可用时记 SKIP，不记 PASS。
 */
const fs = require('fs');
const path = require('path');
const { createServer, listen } = require('./helpers/server');
const {
  ROOT, PREFIX, parseArgs, runEngines, blockExternal, launchEngine, sleep
} = require('./helpers/cross-browser');

const args = parseArgs(process.argv.slice(2));
const SPEC = 'cross-browser-offline';
const SW_VERSION = (/CACHE_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')) || [])[1];
const CACHE_NAME = 'blog-' + SW_VERSION;

let state = null;
let BASE = '';
// 引擎无关的“网络不可达”：Playwright 的 setOffline 在 Firefox 会直接让导航失败
// （NS_ERROR_OFFLINE，SW 来不及兜底），因此改为让本地服务器对全部路径立即断流，
// 这样被打断的是 SW 内部的 fetch，缓存回退路径与真实断网一致。
let networkDown = false;
let liveFaults = {};

function installNetworkSwitch() {
  state.faults = new Proxy(liveFaults, {
    get: function (t, k) { return networkDown ? 'abort' : t[k]; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}

function setNetworkDown(flag) { networkDown = !!flag; }

async function newSession(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: o.sw === false ? 'block' : 'allow'
  });
  await blockExternal(ctx);
  if (o.initScript) await ctx.addInitScript(o.initScript);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });
  return { ctx: ctx, page: page, errors: errors };
}

async function gotoHome(page) {
  await page.goto(BASE + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible', timeout: 30000 });
}

// 有界等待 SW 激活并接管当前页面（不使用固定 sleep 当断言）
async function waitSwActive(page) {
  await page.evaluate(function () {
    return Promise.race([
      navigator.serviceWorker.ready.then(function (r) { return !!r.active; }),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('serviceWorker.ready 超时')); }, 20000); })
    ]);
  });
  await page.waitForFunction(function () { return !!navigator.serviceWorker.controller; },
    null, { timeout: 20000 });
  return page.evaluate(function () {
    return navigator.serviceWorker.getRegistration().then(function (r) {
      return {
        active: !!r.active,
        script: r.active ? r.active.scriptURL : '',
        controlled: !!navigator.serviceWorker.controller
      };
    });
  });
}

function cacheInfo(page) {
  return page.evaluate(function () {
    return caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        return caches.open(n).then(function (c) {
          return c.keys().then(function (reqs) {
            return { name: n, urls: reqs.map(function (r) { return r.url; }) };
          });
        });
      }));
    });
  });
}

function cacheUrls(info, name) {
  const hit = info.filter(function (c) { return c.name === name; })[0];
  return hit ? hit.urls : [];
}

function hasUrl(urls, suffix) {
  return urls.some(function (u) { return u.indexOf(suffix) !== -1; });
}

async function measureReload(page) {
  const t0 = Date.now();
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  return Date.now() - t0;
}

// ---------------------------------------------------------------- Phase D
async function scenarioD(env) {
  const r = env.reporter;

  // D1/D2：首次在线访问、注册、安装、激活、接管、核心缓存
  const s = await newSession(env.browser);
  await gotoHome(s.page);
  const sw = await waitSwActive(s.page);
  r.check('D1', '首次在线访问完成 SW 注册与接管', sw.active && sw.controlled && /\/blog\/sw\.js$/.test(sw.script),
    JSON.stringify(sw));

  const info = await cacheInfo(s.page);
  const core = cacheUrls(info, CACHE_NAME);
  r.check('D2', '安装期缓存包含外壳与首屏资源',
    hasUrl(core, '/index.html') && hasUrl(core, '/js/app.js') && hasUrl(core, '/css/style.css'),
    'cache=' + CACHE_NAME + ' entries=' + core.length);

  // D3：离线访问已缓存首页
  setNetworkDown(true);
  try {
    await s.page.reload({ waitUntil: 'load', timeout: 60000 });
    await s.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    const posts = await s.page.locator('#app a[href^="#/post/"]').count();
    r.check('D3', '离线访问已缓存首页', posts > 0, 'post_links=' + posts);
  } catch (e) {
    r.fail('D3', '离线访问已缓存首页', 'reload 失败: ' + e.message);
  }

  // D4：离线读取已缓存文章
  setNetworkDown(false);
  await s.page.reload({ waitUntil: 'load', timeout: 60000 });
  await s.page.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
  await s.page.locator('#app a[href^="#/post/"]').first().click();
  await s.page.waitForSelector('.article-detail-body', { timeout: 20000 });
  const onlineLen = await s.page.evaluate(function () {
    return (document.querySelector('.article-detail-body') || {}).innerText.length;
  });
  setNetworkDown(true);
  try {
    await s.page.reload({ waitUntil: 'load', timeout: 60000 });
    await s.page.waitForSelector('.article-detail-body', { timeout: 20000 });
    const offlineLen = await s.page.evaluate(function () {
      return (document.querySelector('.article-detail-body') || {}).innerText.length;
    });
    r.check('D4', '离线读取已缓存文章', offlineLen > 100 && Math.abs(offlineLen - onlineLen) < onlineLen * 0.2,
      'online=' + onlineLen + ' offline=' + offlineLen);
  } catch (e) {
    r.fail('D4', '离线读取已缓存文章', 'offline reload 失败: ' + e.message);
  }
  setNetworkDown(false);
  await s.ctx.close();

  // D5：尚未缓存资源的合理降级（离线兜底页，不能拿首页顶替）
  // 使用仓库中不存在的同源路径，确保“从未被缓存”这一前提不受预取与 query 匹配差异影响；
  // 联网时它应当是 404，离线时必须走明确兜底页而不是拿首页顶替。
  const uncachedUrl = BASE + PREFIX + '/notes/b8e4-never-cached.html';
  const d5 = await newSession(env.browser);
  await gotoHome(d5.page);
  await waitSwActive(d5.page);
  const d5info = await cacheInfo(d5.page);
  const d5cached = d5info.some(function (c) {
    return c.urls.some(function (u) { return u.indexOf('b8e4-never-cached') !== -1; });
  });
  r.check('D5', '目标资源离线前确实未缓存', !d5cached, 'cached=' + d5cached);
  setNetworkDown(true);
  const hitsBefore = state.hits['/notes/b8e4-never-cached.html'] || 0;
  try {
    const resp = await d5.page.goto(uncachedUrl, { waitUntil: 'load', timeout: 30000 }).catch(function (e) {
      return { navError: e.message.split('\n')[0] };
    });
    const hitsAfter = state.hits['/notes/b8e4-never-cached.html'] || 0;
    const offlinePage = await d5.page.evaluate(function () {
      return {
        flag: document.body.getAttribute('data-offline') || '',
        title: document.title || '',
        chars: (document.body.innerText || '').length,
        controlled: !!navigator.serviceWorker.controller
      };
    });
    let fromSw = 'n/a';
    try { fromSw = resp && resp.fromServiceWorker ? String(resp.fromServiceWorker()) : 'n/a'; } catch (e) { fromSw = 'err'; }
    r.check('D5', '未缓存页面离线时走明确兜底页',
      !!resp && !resp.navError && resp.status() === 503 && offlinePage.flag === '1',
      'status=' + (resp && resp.status ? resp.status() : 'nav-error') +
      ' fromSW=' + fromSw + ' serverHits=' + hitsBefore + '->' + hitsAfter +
      ' ' + JSON.stringify(offlinePage));
  } catch (e) {
    r.fail('D5', '未缓存页面离线时走明确兜底页', '导航异常: ' + e.message);
  }
  setNetworkDown(false);
  await d5.ctx.close();

  // D6：网络恢复后可继续访问
  const d6 = await newSession(env.browser);
  await gotoHome(d6.page);
  await waitSwActive(d6.page);
  setNetworkDown(true);
  await d6.page.waitForTimeout(300);
  setNetworkDown(false);
  try {
    await d6.page.reload({ waitUntil: 'load', timeout: 60000 });
    await d6.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    r.pass('D6', '网络恢复后重新访问正常');
  } catch (e) {
    r.fail('D6', '网络恢复后重新访问正常', e.message);
  }
  await d6.ctx.close();

  // D7：新版本发布后的缓存切换（改写 CACHE_VERSION，不动生产文件）
  // 版本切换对“同源历史状态”敏感：使用独立浏览器实例隔离前序离线/断流场景的残留连接。
  const fresh7 = await launchEngine(env.engine);
  const d7 = await newSession(fresh7.browser);
  await gotoHome(d7.page);
  await waitSwActive(d7.page);
  await d7.page.evaluate(function () {
    window.__ctrlChanges = 0;
    navigator.serviceWorker.addEventListener('controllerchange', function () { window.__ctrlChanges++; });
  });
  state.swBump = true;
  await d7.page.evaluate(function () {
    return navigator.serviceWorker.getRegistration().then(function (r) { return r.update(); });
  });
  let switched = false;
  try {
    await d7.page.waitForFunction(function (oldCache) {
      return caches.keys().then(function (keys) {
        return keys.some(function (k) { return k.indexOf(oldCache) === 0 && k !== oldCache; });
      });
    }, CACHE_NAME, { timeout: 30000 });
    switched = true;
  } catch (e) { switched = false; }
  // 新缓存出现在 install 阶段，旧缓存清理发生在 activate：分开做有界等待，避免竞态误判
  let cleaned = false;
  let cleanupErr = '';
  let cleanupWaitMs = 0;
  if (switched) {
    // 手动有界轮询：避免 waitForFunction 对 Promise 断言的引擎差异
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      try {
        const st = await d7.page.evaluate(function (oldNames) {
          return navigator.serviceWorker.getRegistration().then(function (reg) {
            return caches.keys().then(function (keys) {
              return {
                busy: !!(reg && (reg.installing || reg.waiting)),
                hasOld: [oldNames.core, oldNames.runtime].some(function (n) { return keys.indexOf(n) !== -1; })
              };
            });
          });
        }, { core: CACHE_NAME, runtime: 'blog-rt-' + SW_VERSION });
        // 旧缓存清理发生在 activate：旧缓存消失即可证明新版本已接管
        if (!st.hasOld) { cleaned = true; break; }
      } catch (e) {
        cleanupErr = (e.message || String(e)).split('\n')[0];
      }
      await sleep(500);
    }
    cleanupWaitMs = Date.now() - t0;
  }
  const reg7 = await d7.page.evaluate(function () {
    return navigator.serviceWorker.getRegistration().then(function (r) {
      return {
        active: r.active ? r.active.scriptURL : '',
        waiting: !!r.waiting,
        installing: !!r.installing,
        ctrlChanges: window.__ctrlChanges || 0
      };
    });
  }).catch(function () { return {}; });
  const info7 = await cacheInfo(d7.page);
  const names7 = info7.map(function (c) { return c.name; });
  r.check('D7', '新版本 SW 激活并切换缓存版本', switched && names7.some(function (n) { return n.indexOf('-t2') > 0; }),
    names7.join(',') || 'no-new-cache');
  r.check('D7', '新版本激活后旧版本缓存被清理',
    switched && cleaned && names7.indexOf(CACHE_NAME) === -1 && names7.indexOf('blog-rt-' + SW_VERSION) === -1,
    'caches=' + names7.join(',') + ' reg=' + JSON.stringify(reg7) +
    ' waitMs=' + cleanupWaitMs + (cleanupErr ? ' waitErr=' + cleanupErr : ''));
  try {
    await d7.page.reload({ waitUntil: 'load', timeout: 60000 });
    await d7.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    r.pass('D7', '版本切换后页面仍可正常使用');
  } catch (e) {
    r.fail('D7', '版本切换后页面仍可正常使用', e.message);
  }
  state.swBump = false;
  await d7.ctx.close();
  await fresh7.browser.close();

  // D8：新版本安装失败时旧版继续服务
  const d8 = await newSession(env.browser);
  await gotoHome(d8.page);
  await waitSwActive(d8.page);
  const before8 = (await cacheInfo(d8.page)).map(function (c) { return c.name; });
  state.swBump = true;
  state.faults['/js/app.js'] = 500;
  await d8.page.evaluate(function () {
    return navigator.serviceWorker.getRegistration().then(function (r) { return r.update(); });
  });
  await d8.page.waitForTimeout(5000);
  const info8 = await cacheInfo(d8.page);
  const names8 = info8.map(function (c) { return c.name; });
  r.check('D8', '新版本安装失败时不产生半成品缓存',
    names8.indexOf(CACHE_NAME) >= 0 && !names8.some(function (n) { return n.indexOf('-t2') > 0; }),
    'before=' + before8.join(',') + ' after=' + names8.join(','));
  const active8 = await d8.page.evaluate(function () {
    return navigator.serviceWorker.getRegistration().then(function (r) {
      return r && r.active ? r.active.scriptURL : '';
    });
  });
  r.check('D8', '旧版本 SW 仍为激活状态', /\/blog\/sw\.js$/.test(active8 || ''), active8 || 'none');
  state.swBump = false;
  delete state.faults['/js/app.js'];
  setNetworkDown(true);
  try {
    await d8.page.reload({ waitUntil: 'load', timeout: 60000 });
    await d8.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    r.pass('D8', '安装失败后离线仍由旧版本兜底');
  } catch (e) {
    r.fail('D8', '安装失败后离线仍由旧版本兜底', e.message);
  }
  setNetworkDown(false);
  await d8.ctx.close();

  // D9：多标签页升级基本行为（同样使用独立浏览器实例）
  const fresh9 = await launchEngine(env.engine);
  const d9 = await newSession(fresh9.browser);
  await gotoHome(d9.page);
  await waitSwActive(d9.page);
  const tab2 = await d9.ctx.newPage();
  await tab2.goto(BASE + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await tab2.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
  state.swBump = true;
  await d9.page.evaluate(function () {
    return navigator.serviceWorker.getRegistration().then(function (r) { return r.update(); });
  });
  let multi = false;
  try {
    await d9.page.waitForFunction(function (oldCache) {
      return caches.keys().then(function (keys) {
        return keys.some(function (k) { return k.indexOf(oldCache) === 0 && k !== oldCache; });
      });
    }, CACHE_NAME, { timeout: 30000 });
    multi = true;
  } catch (e) { multi = false; }
  const ctrl = await Promise.all([d9.page, tab2].map(function (p) {
    return p.evaluate(function () { return !!navigator.serviceWorker.controller; });
  }));
  r.check('D9', '多标签页升级后均保持受控', multi && ctrl[0] && ctrl[1], 'updated=' + multi + ' ctrl=' + ctrl.join('/'));
  try {
    await Promise.all([d9.page.reload({ waitUntil: 'load', timeout: 60000 }),
      tab2.reload({ waitUntil: 'load', timeout: 60000 })]);
    r.pass('D9', '多标签页升级后均能正常刷新');
  } catch (e) {
    r.fail('D9', '多标签页升级后均能正常刷新', e.message);
  }
  state.swBump = false;
  await d9.ctx.close();
  await fresh9.browser.close();

  // D10：IndexedDB / CacheStorage 不可用时的基本页面降级
  const d10 = await newSession(env.browser, {
    sw: false,
    initScript: function () {
      try {
        Object.defineProperty(window, 'indexedDB', { configurable: true, get: function () { return undefined; } });
      } catch (e) { /* 忽略 */ }
      try {
        Object.defineProperty(window, 'caches', { configurable: true, get: function () { return undefined; } });
      } catch (e) { /* 忽略 */ }
    }
  });
  try {
    await gotoHome(d10.page);
    const posts = await d10.page.locator('#app a[href^="#/post/"]').count();
    await d10.page.evaluate(function () { location.hash = '#/editor'; });
    await d10.page.waitForSelector('#editorContent', { state: 'visible', timeout: 20000 });
    await d10.page.fill('#editorContent', '# 降级草稿\n\nIndexedDB 不可用时仍可编辑。');
    await d10.page.fill('#editorTitle', '降级草稿');
    let saved = false;
    try {
      await d10.page.waitForFunction(function () {
        try { return (localStorage.getItem('blog_draft') || '').indexOf('降级草稿') >= 0; } catch (e) { return false; }
      }, null, { timeout: 8000 });
      saved = true;
    } catch (e) { saved = false; }
    r.check('D10', '存储不可用时首页与编辑器仍可用', posts > 0 && saved,
      'post_links=' + posts + ' draft=' + saved);
  } catch (e) {
    r.fail('D10', '存储不可用时首页与编辑器仍可用', e.message);
  }
  await d10.ctx.close();
}

// ---------------------------------------------------------------- Phase E
// B8E4-001 / B8E1-003：snapshotReady 的失败态必须在同一 SW 生命周期内可自愈。
// 观测手段（引擎无关）：
//   - 给 /index.html 注入 600ms 延迟；
//   - 快照可用时 shellNavigate 在 NAV_TIMEOUT_MS(150ms) 后就交付快照 → 导航 < 450ms；
//   - 快照不可用时只能等网络 → 导航 ≥ 600ms。
function timeBand(ms) { return ms < 450 ? 'cache-mode' : 'network-mode'; }

async function scenarioE(env) {
  const r = env.reporter;
  const probeUrl = '/js/projects.js';      // 属于 FIRST_SCREEN_ASSETS，但不在 REQUIRED_ASSETS

  // 状态判据：cache-mode 下首屏资源由安装期快照直接返回，不会产生网络请求；
  // network-mode 下这些资源必须走网络。比单纯计时更不受系统负载影响。
  function assetHits() {
    return ['/css/style.css', '/js/app.js', '/js/data.js'].reduce(function (a, k) {
      return a + (state.hits[k] || 0);
    }, 0);
  }

  // E0：基线（快照完整时应当命中快照）
  const base = await newSession(env.browser);
  try {
    await gotoHome(base.page);
    await waitSwActive(base.page);
    const info0 = await cacheInfo(base.page);
    const core0 = cacheUrls(info0, CACHE_NAME);
    r.check('E0', '基线：安装期快照完整', hasUrl(core0, probeUrl), 'entries=' + core0.length);
    state.delays['/index.html'] = 600;
    const h0 = assetHits();
    const d0 = await measureReload(base.page);
    const hits0 = assetHits() - h0;
    r.check('E0', '基线：快照可用时不产生首屏资源网络请求', hits0 === 0,
      'assetHits=' + hits0 + ' ' + d0 + 'ms (' + timeBand(d0) + ')');
  } catch (e) {
    r.fail('E0', '基线：快照可用时导航走 cache-mode', e.message);
  } finally {
    state.delays['/index.html'] = 0;
    await base.ctx.close();
  }

  // E1：异常注入 → 第一次受控导航判定失败 → 解除异常 → 是否自愈
  const s = await newSession(env.browser);
  try {
    await gotoHome(s.page);
    await waitSwActive(s.page);

    const removed = await s.page.evaluate(function (cacheName) {
      return caches.open(cacheName).then(function (c) {
        return c.keys().then(function (reqs) {
          const target = reqs.filter(function (req) { return req.url.indexOf('/js/projects.js') !== -1; })[0];
          if (!target) return false;
          return c.delete(target).then(function () { return true; });
        });
      });
    }, CACHE_NAME);
    r.check('E1', '异常注入：从安装期快照移除首屏资源', removed, probeUrl);

    state.delays['/index.html'] = 600;
    const h1 = assetHits();
    const d1 = await measureReload(s.page);
    await s.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    const hits1 = assetHits() - h1;
    r.check('E1', '快照不完整时导航降级为 network-mode', hits1 > 0,
      'assetHits=' + hits1 + ' ' + d1 + 'ms (' + timeBand(d1) + ')');

    // 解除异常：把资源重新写回同一个安装期缓存
    const restored = await s.page.evaluate(function (argsObj) {
      return caches.open(argsObj.cache).then(function (c) {
        return fetch(argsObj.url, { cache: 'no-store' }).then(function (resp) {
          if (!resp || !resp.ok) return false;
          return c.put(new Request(argsObj.url), resp).then(function () { return true; });
        });
      });
    }, { cache: CACHE_NAME, url: BASE + PREFIX + probeUrl });
    r.check('E1', '异常解除：首屏资源已回写快照', restored, 'cache=' + CACHE_NAME);

    const complete = await cacheInfo(s.page);
    const core1 = cacheUrls(complete, CACHE_NAME);
    const completeNow = ['/index.html', '/css/style.css', '/js/app.js', '/js/data.js',
      '/js/user-posts.js', '/js/projects.js'].every(function (k) { return hasUrl(core1, k); });
    r.check('E1', '异常解除后快照条目完整', completeNow, 'entries=' + core1.length);

    // 自愈判据（状态优先）：恢复资源后，下一次导航应重新命中安装期快照，
    // 因此首屏资源不应再产生网络请求；计时仅作为辅助证据（系统负载可能影响）。
    const h2 = assetHits();
    const d2 = await measureReload(s.page);
    await s.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    const hits2 = assetHits() - h2;
    const band2 = timeBand(d2);

    // 修复后的正确行为：恢复全部首屏资源后，下一次导航重新命中快照。
    r.check('E1', '异常解除后下一次导航重新使用快照模式（自愈）',
      hits2 === 0,
      'assetHits=' + hits2 + ' ' + d2 + 'ms (' + band2 + ')');

    // 离线兜底是否仍可用
    state.delays['/index.html'] = 0;
    setNetworkDown(true);
    try {
      await s.page.reload({ waitUntil: 'load', timeout: 60000 });
      await s.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
      const posts = await s.page.locator('#app a[href^="#/post/"]').count();
      r.check('E1', '自愈前后离线导航仍由快照兜底', posts > 0, 'post_links=' + posts);
    } catch (e) {
      r.fail('E1', '失败态下离线导航仍由快照兜底', e.message);
    }
    setNetworkDown(false);
    r.check('E1', '复现过程无未处理运行时异常', s.errors.length === 0,
      s.errors.slice(0, 3).join(' | ') || 'none');
  } catch (e) {
    r.fail('E1', 'B8E1-003 定向复现', e.message);
  } finally {
    state.delays['/index.html'] = 0;
    await s.ctx.close();
  }
}

const SCENARIOS = { D: scenarioD, E: scenarioE };

(async function main() {
  const server = createServer(ROOT, PREFIX);
  state = server.state;
  installNetworkSwitch();
  const port = await listen(server.server, 0);
  BASE = 'http://127.0.0.1:' + port;
  console.log('SERVER ' + BASE + PREFIX + ' sw=' + SW_VERSION);

  const names = args.scenario ? [args.scenario] : Object.keys(SCENARIOS);
  const unknown = names.filter(function (n) { return !SCENARIOS[n]; });
  if (unknown.length) {
    console.error('未知场景: ' + unknown.join(', '));
    process.exit(1);
  }

  const code = await runEngines({
    specName: SPEC,
    args: args,
    run: async function (env) {
      for (const name of names) {
        try {
          await SCENARIOS[name](env);
        } catch (err) {
          env.reporter.fail(name, '场景执行异常', (err && err.message ? err.message : String(err)));
        }
        // 每轮场景后复位故障注入，避免跨引擎污染（保留 Proxy 断网开关，不能整体替换）
        state.swBump = false;
        Object.keys(liveFaults).forEach(function (k) { delete liveFaults[k]; });
        state.delays = {};
        networkDown = false;
      }
    }
  });
  try { server.server.close(); } catch (e) { /* 忽略 */ }
  process.exit(code);
})().catch(function (err) {
  console.error('FATAL ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
