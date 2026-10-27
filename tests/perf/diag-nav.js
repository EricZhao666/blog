#!/usr/bin/env node
'use strict';
/**
 * Batch 6C-1：文档级打开文章的分阶段诊断（真实 Chromium + CDP + SW 侧时间戳）
 *
 * 目的：把「导航 → 可读」拆成 9 个阶段，定位 B/C 差异到底发生在哪一段：
 *   1 导航发起 → 2 SW 收到 fetch → 3 SW 决策（timer / 命中）→ 4 文档 TTFB
 *   5 文档完成（loadingFinished）→ 6 DOMContentLoaded / load
 *   7 正文 .md 请求 → 8 文章可读（.article-detail-body）
 *   9 首屏资源开始时间（判断"外壳迟到"还是"资源迟到"）
 *
 * 用法：
 *   node tests/perf/diag-nav.js --sites tests/perf/tmp/site-B-c87b39b,. --repeat 10 --settle 300
 *   node tests/perf/diag-nav.js --sites .,. --only C --repeat 5 --settle 1500   # 只测一个、改 settle
 *
 * 输出：JSON（--out）+ 控制台分阶段中位数。两个站点交错执行，抵消机器漂移。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, devices } = require('playwright');
const { createSwitchServer, listen } = require('../browser/helpers/switch-server');
const { createShapingProxy, listen: listenProxy } = require('./net-throttle');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';

function parseArgs(argv) {
  const a = { sites: [], repeat: 10, settle: 300, out: null, only: null, channel: process.env.PW_CHANNEL || 'chrome', blockGiscus: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--sites') a.sites = String(argv[++i]).split(',');
    else if (k === '--repeat') a.repeat = Number(argv[++i]);
    else if (k === '--settle') a.settle = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--only') a.only = argv[++i];
    else if (k === '--channel') a.channel = argv[++i];
    else if (k === '--block-giscus') a.blockGiscus = true;
  }
  if (!a.sites.length) a.sites = ['.', '.'];
  return a;
}

// 给 SW 注入三行日志（start / timer / finish），B 与 C 用同样的注入方式，保证可比
function instrumentSw(file) {
  let s = fs.readFileSync(file, 'utf8');
  const before = s;
  s = s.replace('function shellNavigate(req, e) {\n  return new Promise(function (resolve) {',
    "function shellNavigate(req, e) {\n  return new Promise(function (resolve) {\n    const __t0 = Date.now();\n    console.log('[sw] shell start');");
  s = s.replace(/const finish = function \(resp, source\) \{\n(\s*)if \(settled\) return;\n\s*settled = true;/,
    (m, ind) => m + "\n" + ind + "console.log('[sw] finish ' + source + ' +' + (Date.now() - __t0));");
  s = s.replace('const timer = setTimeout(function () {',
    "const timer = setTimeout(function () {\n      console.log('[sw] timer +' + (Date.now() - __t0));");
  if (s === before) throw new Error('SW 注入锚点未命中: ' + file);
  const tmp = path.join(os.tmpdir(), 'diag-sw-' + Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(tmp, s);
  return tmp;
}

const ARTICLE_ID = 'deep-learning-in-slam';

async function waitController(page, timeout = 25000) {
  return page.evaluate(async (ms) => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (navigator.serviceWorker.controller) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }, timeout);
}

async function runSample(browser, ctxInfo, order, rep, opt) {
  const { base, proxyBase, state } = ctxInfo;
  const ctx = await browser.newContext(Object.assign({}, devices['Pixel 7'], { serviceWorkers: 'allow' }));
  // 收集 SW 侧日志（带墙钟时间）
  const swLogs = [];
  ctx.on('serviceworker', (w) => {
    w.on('console', (m) => swLogs.push({ at: Date.now(), text: m.text().slice(0, 120) }));
  });
  await ctx.addInitScript({ content: "window.__lt=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt.push({s:Math.round(e.startTime),d:Math.round(e.duration)})})}).observe({entryTypes:['longtask']})}catch(e){}" });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  if (opt.blockGiscus) {
    await cdp.send('Network.setBlockedURLs', { urls: ['*giscus.app*'] });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const net = {};   // requestId → {url, type, sent, ttfb, done}
  cdp.on('Network.requestWillBeSent', (e) => {
    net[e.requestId] = { url: e.request.url, type: e.type, sent: e.timestamp * 1000 };
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = net[e.requestId];
    if (r) { r.ttfb = e.timestamp * 1000; r.status = e.response.status; }
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = net[e.requestId];
    if (r) r.done = e.timestamp * 1000;
  });

  // 用整形代理访问（与 perf.spec 的移动端一致）
  await page.goto(proxyBase + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
  await waitController(page);
  await page.waitForTimeout(1500);                 // 让首访预取收敛，避免干扰下一段

  // SPA 打开同一篇（预热正文 + 高亮），再按 settle 等待
  const hitsBefore = Object.assign({}, state.hits);
  await page.evaluate((id) => { location.hash = '#/post/' + id; }, ARTICLE_ID);
  await page.waitForFunction(() => {
    const b = document.querySelector('#app .article-detail-body');
    return !!b && b.textContent.trim().length > 200;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(opt.settle);

  // 重开前：记录上一页是否仍被长任务占着
  const beforeReload = await page.evaluate(async () => {
    const t0 = performance.now();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      rAFMs: Math.round(performance.now() - t0),
      now: Math.round(performance.now()),
      longTasks: (window.__lt || []).slice(-8)
    };
  });

  // 文档级重开
  const wallStart = Date.now();
  const beforeIds = new Set(Object.keys(net));
  const reloadPromise = page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const b = document.querySelector('#app .article-detail-body');
    return !!b && b.textContent.trim().length > 200;
  }, null, { timeout: 30000 }).catch(() => {});
  const readableMs = Date.now() - wallStart;
  await reloadPromise.catch(() => {});
  await page.waitForTimeout(300);

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const res = performance.getEntriesByType('resource').map(r => ({
      path: new URL(r.name).pathname.replace('/blog', ''),
      start: Math.round(r.startTime), dur: Math.round(r.duration), transfer: r.transferSize || 0
    }));
    return {
      timeOrigin: performance.timeOrigin,
      ttfb: n.responseStart, responseEnd: n.responseEnd, domInteractive: n.domInteractive,
      dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, fcp: fcp ? fcp.startTime : null, resources: res
    };
  });

  const docReq = Object.values(net).filter(r => !beforeIds.has(Object.keys(net).find(k => net[k] === r)) && r.type === 'Document').pop()
    || Object.values(net).filter(r => r.type === 'Document').pop();
  const hits = {};
  Object.keys(state.hits).forEach((k) => { const d = (state.hits[k] || 0) - (hitsBefore[k] || 0); if (d) hits[k] = d; });

  await ctx.close();
  return {
    version: ctxInfo.label, order, rep,
    readableMs,
    beforeReload,
    nav,
    doc: docReq ? { url: docReq.url, status: docReq.status, ttfbFromOrigin: Math.round(docReq.ttfb - nav.timeOrigin), doneFromOrigin: Math.round(docReq.done - nav.timeOrigin) } : null,
    sw: swLogs.map(x => ({ at: Math.round(x.at - nav.timeOrigin), text: x.text })),
    hits,
    resources: nav.resources
  };
}

(async () => {
  const opt = parseArgs(process.argv.slice(2));
  const labels = ['B', 'C'];
  const sites = opt.sites.map((p) => path.resolve(ROOT, p));
  const swFiles = sites.map((dir) => instrumentSw(path.join(dir, 'sw.js')));
  const contexts = [];
  const browser = await chromium.launch(Object.assign({ headless: true }, opt.channel !== 'chromium' ? { channel: opt.channel } : {}));

  for (let i = 0; i < sites.length; i++) {
    const { server, state } = createSwitchServer({ roots: [sites[i]], prefix: PREFIX });
    const port = await listen(server, 0);
    const staticBase = 'http://127.0.0.1:' + port;
    // 用 switch-server 的 override 提供注入了日志的 sw.js
    state.override = {};
    const proxy = createShapingProxy({ targetPort: port, latencyMs: 150, downloadKbps: 1638.4 });
    const proxyPort = await listenProxy(proxy.server, 0);
    // 覆盖 /blog/sw.js
    const origHandler = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (decodeURIComponent(req.url.split('?')[0]) === PREFIX + '/sw.js') {
        const body = fs.readFileSync(swFiles[i]);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
        return res.end(body);
      }
      origHandler(req, res);
    });
    contexts.push({ label: labels[i] || ('S' + i), base: staticBase, proxyBase: 'http://127.0.0.1:' + proxyPort, state, server, proxy });
  }

  const samples = [];
  const picks = opt.only ? contexts.filter(c => c.label === opt.only) : contexts;
  for (let rep = 1; rep <= opt.repeat; rep++) {
    const order = rep % 2 === 1 ? picks.slice() : picks.slice().reverse();   // 交错，抵消顺序效应
    for (const c of order) {
      const s = await runSample(browser, c, samples.length + 1, rep, opt);
      samples.push(s);
      console.log('  ' + s.version + ' rep ' + rep + ' readable=' + s.readableMs + 'ms ttfb=' + (s.doc ? s.doc.ttfbFromOrigin : '?') + 'ms load=' + Math.round(s.nav.load) + 'ms');
    }
  }

  const med = (arr) => { const v = arr.filter(x => typeof x === 'number' && !isNaN(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const summary = {};
  for (const c of picks) {
    const ss = samples.filter(s => s.version === c.label);
    const st = (f) => med(ss.map(f));
    summary[c.label] = {
      n: ss.length,
      readableMs: [st(s => s.readableMs), Math.min(...ss.map(s => s.readableMs)), Math.max(...ss.map(s => s.readableMs))],
      docTtfb: st(s => s.doc && s.doc.ttfbFromOrigin),
      docDone: st(s => s.doc && s.doc.doneFromOrigin),
      dcl: st(s => s.nav.dcl), load: st(s => s.nav.load), fcp: st(s => s.nav.fcp),
      firstAssetStart: st(s => Math.min.apply(null, s.resources.filter(r => /\.(css|js)$/.test(r.path)).map(r => r.start))),
      bodyReq: st(s => (s.resources.find(r => /\/data\/posts\//.test(r.path)) || {}).dur),
      highlightHits: st(s => s.hits['/vendor/highlight.min.js'] || 0),
      swFinish: st(s => { const f = s.sw.find(x => /finish/.test(x.text)); return f ? f.at : null; }),
      split: ss.map(s => s.readableMs).sort((a, b) => a - b)
    };
  }

  console.log('\n== 分阶段中位数（ms） ==');
  for (const k of Object.keys(summary)) {
    const s = summary[k];
    console.log(' ' + k + ' n=' + s.n
      + ' | readable ' + s.readableMs[0] + ' [' + s.readableMs[1] + '~' + s.readableMs[2] + ']'
      + ' | docTTFB ' + s.docTtfb + ' docDone ' + s.docDone
      + ' | 首个css/js ' + s.firstAssetStart
      + ' | fcp ' + s.fcp + ' dcl ' + s.dcl + ' load ' + s.load
      + ' | 正文请求 ' + s.bodyReq + 'ms | highlight 命中 ' + s.highlightHits);
    console.log('    分裂: ' + s.split.join(', '));
  }

  if (opt.out) {
    fs.writeFileSync(opt.out, JSON.stringify({ generatedAt: new Date().toISOString(), args: opt, summary, samples }, null, 1));
    console.log('\n写入 ' + opt.out);
  }
  await browser.close();
  for (const c of contexts) { c.server.close(); c.proxy.server.close(); }
})().catch((e) => { console.error('DIAG ERROR:', e && e.stack || e); process.exit(1); });
