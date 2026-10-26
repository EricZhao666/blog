#!/usr/bin/env node
'use strict';
/**
 * Batch 6B · 实验 A：后台预取策略对照测量（真实 Chromium）
 *
 * 被测变量只有一个：Service Worker 首访后的可选资源预取策略。
 *   1) baseline   —— 生产行为：activate 后立刻预取 6 个可选资源（含 380 KB 的 codefiles.js）
 *   2) deferred   —— 同样的 6 个资源，但首次导航后延迟 N ms 再开始
 *   3) selective  —— 只预取首页/搜索需要的 5 个，codefiles.js 交给 /code 路由按需加载
 *
 * 与 6A 的关系：沿用同一台机器、同一 Chrome、同一个 tests/browser/helpers/server.js
 * （未修改）、同样的移动端整形参数（1638.4 kbps / 150 ms）。新增的是一层
 * tests/perf/http-probe.js，用于在 HTTP 层逐请求记账，并在不改仓库 sw.js 的前提下
 * 注入候选 SW（独立测试副本）。所有候选都走同一条链路，因此横向可比。
 *
 * 关键口径（防止「把预取推出采样窗口」冒充省流量）：
 *   - 采样窗口 = 导航开始 → +15 s（固定，不看预取是否结束）；
 *   - totalBytesInWindow = 窗口内所有 HTTP 响应体字节（含 SW 后台预取、含重复请求）；
 *   - prefetchDoneMs = 6 个可选资源里最后一个响应结束的时刻；超过窗口记 null 并写 overWindow=true。
 *
 * 用法：
 *   node tests/perf/sw-net.spec.js --variants baseline,deferred,selective \
 *        --configs desktop,mobile --repeat 5 --out tests/perf/reports/batch6b/expA-prefetch.json
 *
 * 退出码：0 全部候选都拿到 ≥min(5,repeat) 个有效样本；1 样本不足；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { chromium, devices } = require('playwright');
const { createServer, listen } = require('../browser/helpers/server');
const { createProbe, listen: listenProbe } = require('./http-probe');
const { createShapingProxy, listen: listenProxy } = require('./net-throttle');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const HOME = PREFIX + '/';
const VARIANT_SRC = path.join(__dirname, 'sw-candidates', 'sw-variant.js');
const OPTIONAL_ASSETS = [
  'vendor/highlight.min.js', 'js/courses.js', 'js/course-notes.js',
  'js/note-slugs.js', 'js/papers.js', 'js/codefiles.js'
];
const FIRST_SCREEN = ['css/style.css', 'js/app.js', 'js/data.js', 'js/user-posts.js', 'js/projects.js'];

const VARIANTS = {
  baseline: { label: 'A1 现状：activate 后立即预取 6 个可选资源', config: { prefetch: 'immediate' }, pageScheduleMs: null },
  deferred: {
    label: 'A2 延后：load 之后 4000 ms 由页面触发预取同样 6 个资源',
    config: { prefetch: 'deferred', prefetchDelayMs: 4000 },
    pageScheduleMs: 4000
  },
  selective: { label: 'A3 选择性：首页只预取 5 个，codefiles.js 随 /code 路由加载', config: { prefetch: 'selective' }, pageScheduleMs: null }
};

// 延后预取必须由页面发起：SW 在空闲事件之间会被终止，sleep 型 promise 会被直接丢弃
function pageScheduleScript(delayMs) {
  return '(() => {' +
    'function ping() {' +
    '  var c = navigator.serviceWorker && navigator.serviceWorker.controller;' +
    '  if (c) { c.postMessage({ type: "warm-optional" }); return; }' +
    '  setTimeout(ping, 250);' +
    '}' +
    'window.addEventListener("load", function () { setTimeout(ping, ' + delayMs + '); }, { once: true });' +
    '})();';
}

const r2 = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);

function statsOf(values) {
  const v = values.filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null, spread: null, spreadPct: null };
  const n = v.length;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return {
    n,
    median: r2(median),
    min: r2(v[0]),
    max: r2(v[n - 1]),
    spread: r2(v[n - 1] - v[0]),
    spreadPct: median ? r2(((v[n - 1] - v[0]) / median) * 100) : null
  };
}

function parseArgs(argv) {
  const a = {
    variants: Object.keys(VARIANTS),
    configs: ['desktop', 'mobile'],
    repeat: 5,
    windowMs: 15000,
    out: path.join(__dirname, 'reports', 'batch6b', 'expA-prefetch.json'),
    channel: process.env.PW_CHANNEL || 'chrome',
    port: 8137,
    probePort: 8139,
    proxyPort: 8138,
    quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error('参数缺少取值: ' + k);
      return v;
    };
    switch (k) {
      case '--variants': a.variants = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--configs': a.configs = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--repeat': a.repeat = Math.max(1, Number(next())); break;
      case '--window': a.windowMs = Number(next()); break;
      case '--out': a.out = path.resolve(ROOT, next()); break;
      case '--channel': a.channel = next(); break;
      case '--port': a.port = Number(next()); break;
      case '--probe-port': a.probePort = Number(next()); break;
      case '--proxy-port': a.proxyPort = Number(next()); break;
      case '--quiet': a.quiet = true; break;
      default: throw new Error('未知参数: ' + k);
    }
  }
  for (const v of a.variants) if (!VARIANTS[v]) throw new Error('未知候选: ' + v);
  return a;
}

// ---------------------------------------------------------------- 候选 SW 生成
function buildVariantSource(name) {
  const src = fs.readFileSync(VARIANT_SRC, 'utf8');
  const cfg = VARIANTS[name].config;
  const merged = Object.assign({ prefetch: 'immediate', prefetchDelayMs: 4000, hotStart: 'network-first', hotStartTimeoutMs: 300 }, cfg);
  const block = 'const CONFIG = ' + JSON.stringify(merged, null, 2).replace(/\n/g, '\n') + ';\n';
  const out = src.replace(/const CONFIG = \{[\s\S]*?\n\};\n/, block);
  if (out === src) throw new Error('候选 CONFIG 替换失败: ' + name);
  return { source: out, config: merged, sha256: crypto.createHash('sha256').update(out).digest('hex').slice(0, 16) };
}

// ---------------------------------------------------------------- 页面内观测
const INIT_SCRIPT = `(() => {
  if (window.__perf) return;
  const st = { lcp: null, lcpTag: null, shifts: [], longTasks: [], controllerAtLoad: null, cacheNamesAtLoad: null };
  window.__perf = st;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        st.lcp = e.startTime;
        if (e.element) st.lcpTag = e.element.tagName + (e.element.className ? '.' + String(e.element.className).split(' ')[0] : '');
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) { st.lcpError = err.message; }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) st.shifts.push({ t: e.startTime, v: e.value });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (err) { st.clsError = err.message; }
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) st.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  } catch (err) { /* ignore */ }
  window.addEventListener('load', () => {
    st.controllerAtLoad = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    if (typeof caches !== 'undefined') caches.keys().then(k => { st.cacheNamesAtLoad = k; }).catch(() => {});
  }, { once: true });
})();`;

async function snapshotFn() {
  const st = window.__perf || {};
  const nav = performance.getEntriesByType('navigation')[0] || null;
  const res = performance.getEntriesByType('resource').map((e) => ({
    url: e.name.indexOf(location.origin) === 0 ? e.name.slice(location.origin.length) : e.name,
    start: Math.round(e.startTime * 100) / 100,
    end: Math.round((e.startTime + e.duration) * 100) / 100,
    dur: Math.round(e.duration * 100) / 100,
    encoded: e.encodedBodySize || 0,
    transfer: e.transferSize || 0
  }));
  const paints = {};
  performance.getEntriesByType('paint').forEach((e) => { paints[e.name] = e.startTime; });
  const shifts = (st.shifts || []).slice().sort((a, b) => a.t - b.t);
  let win = null; const wins = [];
  for (const s of shifts) {
    if (!win || s.t - win.last > 1000 || s.t - win.start > 5000) { win = { start: s.t, last: s.t, value: s.v }; wins.push(win); }
    else { win.last = s.t; win.value += s.v; }
  }
  return {
    nav: nav ? {
      ttfb: Math.round((nav.responseStart - nav.startTime) * 100) / 100,
      dcl: Math.round((nav.domContentLoadedEventEnd - nav.startTime) * 100) / 100,
      load: Math.round((nav.loadEventEnd - nav.startTime) * 100) / 100
    } : null,
    paints: { fcp: paints['first-contentful-paint'] == null ? null : Math.round(paints['first-contentful-paint'] * 100) / 100 },
    lcp: st.lcp == null ? null : Math.round(st.lcp * 100) / 100,
    lcpTag: st.lcpTag || null,
    cls: Math.round(wins.reduce((m, w) => Math.max(m, w.value), 0) * 10000) / 10000,
    longTaskMax: (st.longTasks || []).reduce((m, d) => Math.max(m, d), 0),
    controllerAtLoad: st.controllerAtLoad,
    cacheNamesAtLoad: st.cacheNamesAtLoad,
    resources: res,
    domNodes: document.getElementsByTagName('*').length,
    title: document.title
  };
}

async function cacheInventoryFn() {
  const names = await caches.keys();
  const out = {};
  for (const n of names) {
    const c = await caches.open(n);
    out[n] = (await c.keys()).map(r => new URL(r.url).pathname).sort();
  }
  return out;
}

// 向 SW 询问它实际生效的策略（归因用）
async function variantInfoFn() {
  const reg = await navigator.serviceWorker.getRegistration();
  const worker = navigator.serviceWorker.controller || (reg && (reg.active || reg.installing || reg.waiting));
  if (!worker) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (ev) => { clearTimeout(timer); resolve(ev.data); };
    try { worker.postMessage({ type: 'sw-variant-info' }, [ch.port2]); } catch (e) { clearTimeout(timer); resolve(null); }
  });
}

async function waitControllerFn(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (navigator.serviceWorker.controller) return Date.now() - t0;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

// 离线可用性探针：不改变缓存，只读
async function offlineProbeFn(assets) {
  const out = { ready: true, assets: {} };
  for (const a of assets) {
    try {
      const resp = await fetch('./' + a, { cache: 'no-store' });
      out.assets[a] = { ok: !!resp.ok, status: resp.status };
    } catch (e) {
      out.assets[a] = { ok: false, status: 0, error: String(e.message || e).split('\n')[0].slice(0, 80) };
    }
  }
  const g = {};
  for (const k of ['COURSES', 'PAPERS', 'COURSE_NOTES', 'CODE_LIBS']) {
    try { g[k] = eval('typeof ' + k) !== 'undefined'; } catch (e) { g[k] = false; }
  }
  out.globals = g;
  return out;
}

// ---------------------------------------------------------------- 浏览器装配
function buildConfigs(args) {
  const pixel = devices['Pixel 7'];
  return {
    desktop: {
      id: 'desktop',
      contextOptions: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, serviceWorkers: 'allow' },
      cpuThrottle: 1,
      useProxy: false,
      label: '桌面 Chromium 1440×900 @1x，无 CPU 限速，直连（→ 观测探针 → 静态服务器）'
    },
    mobile: {
      id: 'mobile',
      contextOptions: Object.assign({}, pixel, { serviceWorkers: 'allow' }),
      cpuThrottle: 4,
      useProxy: true,
      label: 'Pixel 7 设备模拟 + CPU 4x + 下行 1638.4 kbps / 首字节 150 ms（→ 整形 → 观测探针 → 服务器）'
    }
  };
}

async function attachCDP(page, config) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (config.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: config.cpuThrottle });
  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['*giscus.app*'] });
  } catch (e) { /* ignore */ }
  return cdp;
}

// ---------------------------------------------------------------- 单轮测量
async function runRep(browser, config, deps, variant, rep, opt) {
  const startedAt = new Date().toISOString();
  const ctx = await browser.newContext(config.contextOptions);
  await ctx.addInitScript({ content: INIT_SCRIPT });
  const scheduleMs = VARIANTS[variant] && VARIANTS[variant].pageScheduleMs;
  if (scheduleMs) await ctx.addInitScript({ content: pageScheduleScript(scheduleMs) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push({ type: 'pageerror', message: String(e.message || e).slice(0, 200) }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ type: 'console', text: m.text().slice(0, 200) }); });
  const cdp = await attachCDP(page, config);

  const sample = { rep, variant, config: config.id, startedAt, ok: true, error: null };
  try {
    const mark = deps.probe.mark();          // 探针时间轴上的导航起点
    await page.goto(config.baseUrl + HOME, { waitUntil: 'load', timeout: 60000 });
    const ctlMs = await page.evaluate(waitControllerFn, 25000);

    // 固定窗口：从导航开始算 15 s，不因为预取提前结束而缩短
    // （否则「把预取推迟到窗口外」会被误算成省流量）
    for (;;) {
      const left = opt.windowMs - (deps.probe.mark() - mark);
      if (left <= 0) break;
      await page.waitForTimeout(Math.min(left, 500));
    }

    const snap = await page.evaluate(snapshotFn);
    const inv = await page.evaluate(cacheInventoryFn).catch(() => null);
    const info = await page.evaluate(variantInfoFn).catch(() => null);
    const records = deps.probe.since(mark);

    // 逐请求统计（HTTP 层：含 SW 发起的预取与后台校验）
    const perPath = {};
    for (const r of records) {
      const p = r.path.indexOf(PREFIX + '/') === 0 ? r.path.slice(PREFIX.length + 1) : r.path;
      perPath[p] = perPath[p] || { count: 0, bytes: 0, lastEnd: null };
      perPath[p].count++;
      perPath[p].bytes += r.bytes;
      if (r.end != null) perPath[p].lastEnd = Math.max(perPath[p].lastEnd || 0, r.end - mark);
    }
    const totalBytes = records.reduce((s, r) => s + r.bytes, 0);
    const dupes = Object.keys(perPath).filter(p => perPath[p].count > 1)
      .map(p => ({ path: p, count: perPath[p].count }));
    const optionalSeen = OPTIONAL_ASSETS.filter(a => perPath[a] || perPath['./' + a]);
    const optionalEnds = optionalSeen.map(a => (perPath[a] || perPath['./' + a]).lastEnd).filter(v => v != null);
    const prefetchDoneMs = optionalEnds.length ? Math.max.apply(null, optionalEnds) : null;

    // 前台资源完成时间：页面 Resource Timing 里最晚结束的条目
    const fgEnds = snap.resources.map(r => r.end).filter(v => typeof v === 'number');
    const foregroundDoneMs = fgEnds.length ? Math.max.apply(null, fgEnds) : null;
    const foregroundBytes = snap.resources.reduce((s, r) => s + (r.encoded || 0), 0);

    sample.metrics = {
      ttfbMs: snap.nav ? snap.nav.ttfb : null,
      fcpMs: snap.paints.fcp,
      lcpMs: snap.lcp,
      dclMs: snap.nav ? snap.nav.dcl : null,
      loadMs: snap.nav ? snap.nav.load : null,
      foregroundDoneMs: foregroundDoneMs,
      foregroundBytes: foregroundBytes,
      totalBytesInWindow: totalBytes,
      optionalPrefetchBytes: optionalSeen.reduce((s, a) => s + (perPath[a] || perPath['./' + a]).bytes, 0),
      prefetchDoneMs: prefetchDoneMs,
      prefetchOverWindow: prefetchDoneMs == null ? null : prefetchDoneMs > opt.windowMs,
      serverRequestCount: records.length,
      duplicateRequestExtra: dupes.reduce((s, d) => s + (d.count - 1), 0),
      swControlMs: ctlMs,
      cacheEntries: inv ? Object.keys(inv).reduce((s, n) => s + inv[n].length, 0) : null,
      longTaskMaxMs: snap.longTaskMax,
      cls: snap.cls,
      domNodes: snap.domNodes
    };
    sample.perPath = perPath;
    sample.duplicates = dupes;
    sample.optionalAssetsFetched = optionalSeen;
    sample.cache = inv;
    sample.variantInfo = info;
    sample.snap = { nav: snap.nav, paints: snap.paints, lcp: snap.lcp, lcpTag: snap.lcpTag, controllerAtLoad: snap.controllerAtLoad, cacheNamesAtLoad: snap.cacheNamesAtLoad, title: snap.title };
    sample.records = records.map(r => ({ path: r.path, start: Math.round(r.start - mark), end: r.end == null ? null : Math.round(r.end - mark), status: r.status, bytes: r.bytes }));

    // 离线探针：窗口结束后再切离线，避免影响窗口内字节
    await ctx.setOffline(true);
    let homeStatus = 0, homeTitle = '';
    try {
      const resp = await page.reload({ waitUntil: 'load', timeout: 20000 });
      homeStatus = resp ? resp.status() : 0;
      homeTitle = await page.title();
    } catch (e) {
      sample.offlineError = String(e.message || e).split('\n')[0].slice(0, 160);
    }
    const offline = await page.evaluate(offlineProbeFn, OPTIONAL_ASSETS.concat(['notes/cs422.html'])).catch(() => null);
    sample.offline = {
      homeStatus,
      homeTitle,
      homeOk: homeStatus === 200 && !!homeTitle,
      assets: offline ? offline.assets : null,
      globals: offline ? offline.globals : null
    };
  } catch (e) {
    sample.ok = false;
    sample.error = String(e && e.message ? e.message : e).split('\n')[0].slice(0, 300);
  }
  sample.errors = errors.slice(0, 10);
  await ctx.close();
  return sample;
}

const METRIC_KEYS = [
  ['ttfbMs', 'TTFB', 'ms'], ['fcpMs', 'FCP', 'ms'], ['lcpMs', 'LCP', 'ms'],
  ['dclMs', 'DOMContentLoaded', 'ms'], ['loadMs', '页面 load', 'ms'],
  ['foregroundDoneMs', '前台资源完成时间', 'ms'],
  ['foregroundBytes', '前台编码字节', 'B'],
  ['totalBytesInWindow', '首访窗口总传输字节（含预取）', 'B'],
  ['optionalPrefetchBytes', '可选资源预取字节', 'B'],
  ['prefetchDoneMs', '预取完成时间', 'ms'],
  ['serverRequestCount', '到达服务器请求数', 'count'],
  ['duplicateRequestExtra', '重复请求数（多出首次的部分）', 'count'],
  ['swControlMs', 'SW 接管耗时', 'ms'],
  ['cacheEntries', 'SW 缓存条目', 'count'],
  ['longTaskMaxMs', '最长长任务', 'ms'], ['cls', 'CLS', 'score']
];

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }

  const variants = {};
  for (const v of args.variants) variants[v] = buildVariantSource(v);

  const { server, state } = createServer(ROOT, PREFIX);
  let staticPort;
  try { staticPort = await listen(server, args.port); } catch (e) { console.error('静态服务器端口被占用: ' + e.message); return 2; }

  const probe = createProbe({ targetPort: staticPort });
  let probePort;
  try { probePort = await listenProbe(probe.server, args.probePort); } catch (e) { console.error('探针端口被占用: ' + e.message); server.close(); return 2; }

  const shaping = createShapingProxy({ targetPort: probePort, latencyMs: 150, downloadKbps: 1638.4 });
  let proxyPort;
  try { proxyPort = await listenProxy(shaping.server, args.proxyPort); } catch (e) { console.error('整形端口被占用: ' + e.message); server.close(); probe.server.close(); return 2; }

  const configs = buildConfigs(args);
  for (const id of args.configs) {
    if (!configs[id]) { console.error('未知配置: ' + id); return 2; }
    configs[id].baseUrl = 'http://127.0.0.1:' + (configs[id].useProxy ? proxyPort : probePort);
  }

  let browser;
  try {
    const opts = { headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] };
    if (args.channel && args.channel !== 'chromium') opts.channel = args.channel;
    browser = await chromium.launch(opts);
  } catch (e) {
    console.error('无法启动浏览器: ' + String(e.message).split('\n')[0]);
    server.close(); probe.server.close(); shaping.server.close();
    return 2;
  }

  const out = {
    meta: {
      batch: '6B-A',
      generator: 'tests/perf/sw-net.spec.js',
      generatedAt: new Date().toISOString(),
      variantSource: path.relative(ROOT, VARIANT_SRC).replace(/\\/g, '/'),
      variants: {},
      browser: { channel: args.channel, version: browser.version(), headless: true },
      host: { platform: process.platform, release: os.release(), cpuModel: (os.cpus()[0] || {}).model, cpuCores: os.cpus().length, node: process.version },
      windowMs: args.windowMs,
      repeat: args.repeat,
      server: { static: 'tests/browser/helpers/server.js（未修改）', probePort, staticPort, shapingProxyPort: proxyPort, shaping: { latencyMs: 150, downloadKbps: 1638.4 } },
      note: '所有候选都经 观测探针 → 静态服务器 的同一条链路；移动端在探针之前再加整形代理。桌面对照组同样经过探针，保证横向可比。'
    },
    variants: {},
    failures: []
  };

  for (const name of args.variants) {
    out.meta.variants[name] = { label: VARIANTS[name].label, config: variants[name].config, swSha256: variants[name].sha256, swBytes: Buffer.byteLength(variants[name].source) };
  }

  try {
    for (const name of args.variants) {
      // 切换候选：只改探针对 /blog/sw.js 的响应内容，链路与端口保持不变
      probe.setOverride(PREFIX + '/sw.js', variants[name].source);

      const perConfig = {};
      for (const id of args.configs) {
        const config = configs[id];
        const samples = [];
        console.log('\n== ' + name + ' / ' + id + ' ==');
        for (let rep = 1; rep <= args.repeat; rep++) {
          state.hits = {};
          const sample = await runRep(browser, config, { probe }, name, rep, { windowMs: args.windowMs });
          samples.push(sample);
          if (!sample.ok) out.failures.push({ variant: name, config: id, rep, error: sample.error });
          if (!args.quiet) {
            console.log('  rep ' + rep + '/' + args.repeat + (sample.ok
              ? ' load=' + sample.metrics.loadMs + 'ms fcp=' + sample.metrics.fcpMs + 'ms bytes=' + sample.metrics.totalBytesInWindow + ' prefetchDone=' + sample.metrics.prefetchDoneMs + 'ms srv=' + sample.metrics.serverRequestCount + ' offlineHome=' + (sample.offline.homeOk ? 'ok' : 'FAIL')
              : ' FAIL: ' + sample.error));
          }
        }
        const summary = {};
        for (const [key, label, unit] of METRIC_KEYS) {
          const st = statsOf(samples.filter(s => s.ok).map(s => s.metrics[key]));
          summary[key] = Object.assign({ label, unit }, st, { unavailable: st.n === 0 });
        }
        const offlineOk = samples.filter(s => s.ok && s.offline && s.offline.homeOk).length;
        const assetAvail = {};
        for (const a of OPTIONAL_ASSETS) {
          assetAvail[a] = samples.filter(s => s.ok && s.offline && s.offline.assets && s.offline.assets[a] && s.offline.assets[a].ok).length;
        }
        perConfig[id] = {
          label: config.label,
          samples,
          summary,
          offline: { samples: samples.length, homeOk: offlineOk, assetAvailable: assetAvail },
          validity: { requested: args.repeat, completed: samples.filter(s => s.ok).length }
        };
      }
      out.variants[name] = perConfig;
    }
  } finally {
    await browser.close();
    server.close();
    probe.server.close();
    shaping.server.close();
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2), 'utf8');

  // 控制台对照表
  console.log('\n===== 实验 A 对照（中位数） =====');
  for (const id of args.configs) {
    console.log('\n[' + id + ']');
    const cols = args.variants;
    const keys = ['fcpMs', 'lcpMs', 'loadMs', 'foregroundDoneMs', 'totalBytesInWindow', 'prefetchDoneMs', 'serverRequestCount', 'duplicateRequestExtra', 'swControlMs'];
    console.log('  ' + 'metric'.padEnd(24) + cols.map(c => c.padStart(14)).join(''));
    for (const k of keys) {
      const label = (METRIC_KEYS.find(m => m[0] === k) || [k, k])[1];
      const row = cols.map(c => {
        const s = out.variants[c][id].summary[k];
        return (s.median == null ? 'n/a' : String(s.median)).padStart(14);
      });
      console.log('  ' + label.padEnd(24) + row.join(''));
    }
    console.log('  offline home ok: ' + cols.map(c => c + '=' + out.variants[c][id].offline.homeOk + '/' + out.variants[c][id].samples.length).join('  '));
    console.log('  codefiles.js offline: ' + cols.map(c => c + '=' + out.variants[c][id].offline.assetAvailable['js/codefiles.js'] + '/' + out.variants[c][id].samples.length).join('  '));
  }

  const complete = args.variants.every(v => args.configs.every(c =>
    out.variants[v][c].validity.completed >= Math.min(5, args.repeat)));
  console.log('\n样本完整性: ' + (complete ? 'OK' : 'INCOMPLETE'));
  console.log('报告: ' + path.relative(ROOT, args.out));
  return complete ? 0 : 1;
}

main().then(code => { process.exitCode = code; }).catch(e => { console.error('SW-NET SPEC ERROR:', e); process.exitCode = 2; });
