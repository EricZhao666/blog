#!/usr/bin/env node
'use strict';
/**
 * Batch 6C-2：文章渲染长任务与三个导航场景的测量
 *
 * 场景：
 *   A 稳定后重新进入：文章打开 → 空闲 2 s → 回首页 → 再进入同一篇
 *   B 渲染中立即重开：文章打开 → 300 ms → 文档级 reload（压力场景，非典型体验）
 *   C 连续切换文章：art1 → 80 ms → art2 → 80 ms → art3（验证不串页 + 长任务）
 *
 * 采集：首段可读（含双 rAF 绘制）、正文可读、长任务列表、C 版本的 perf marks。
 * B/C 两版交错执行（单数轮 B→C，双数轮 C→B）。
 *
 * 用法：
 *   node tests/perf/diag-render.js --sites tests/perf/tmp/site-B-c87b39b,. --config mobile --repeat 10
 */
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { createServer, listen } = require('../browser/helpers/server');
const { createShapingProxy, listen: listenProxy } = require('./net-throttle');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const POSTS = ['deep-learning-in-slam', 'rl-from-mdp-to-ppo', 'embodied-ai-notes'];

function args(argv) {
  const a = { sites: [], config: 'mobile', repeat: 10, out: null, channel: process.env.PW_CHANNEL || 'chrome' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--sites') a.sites = String(argv[++i]).split(',');
    else if (k === '--config') a.config = argv[++i];
    else if (k === '--repeat') a.repeat = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--channel') a.channel = argv[++i];
  }
  if (!a.sites.length) a.sites = ['.', '.'];
  return a;
}

const CONFIGS = {
  desktop: { contextOptions: { viewport: { width: 1440, height: 900 } }, cpu: 1, useProxy: false },
  mobile: { contextOptions: Object.assign({}, devices['Pixel 7']), cpu: 4, useProxy: true }
};

const INIT = `
window.__lt = [];
try {
  new PerformanceObserver(function (l) {
    l.getEntries().forEach(function (e) { window.__lt.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); });
  }).observe({ entryTypes: ['longtask'] });
} catch (e) {}
`;

const READABLE_FN = `(function () {
  var b = document.querySelector('#app .article-detail-body');
  if (!b) return { body: false, first: false, text: '' };
  var p = b.querySelector('p');
  var first = !!(p && p.textContent.trim().length > 10);
  return { body: b.textContent.trim().length > 200, first: first, text: b.textContent.trim().slice(0, 40) };
})()`;

async function waitController(page, ms = 25000) {
  return page.evaluate(async (limit) => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < limit) {
      if (navigator.serviceWorker.controller) return true;
      await new Promise(r => setTimeout(r, 40));
    }
    return false;
  }, ms);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sample(browser, site, cfg, scenario, rep) {
  const ctx = await browser.newContext(cfg.contextOptions);
  await ctx.addInitScript({ content: INIT });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*giscus.app*'] });   // 排除第三方评论
  if (cfg.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpu });

  const base = site.baseUrl + PREFIX + '/';
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await waitController(page);
  await sleep(1200);

  const longTasksBefore = await page.evaluate(() => (window.__lt || []).length);

  let m = { firstMs: null, bodyMs: null, extra: {} };
  const openArticle = (id) => page.evaluate((pid) => { location.hash = '#/post/' + pid; }, id);
  const waitFirst = async (timeout = 30000) => {
    const t0 = Date.now();
    const ok = await page.waitForFunction(
      () => { const b = document.querySelector('#app .article-detail-body'); const p = b && b.querySelector('p'); return !!(p && p.textContent.trim().length > 10); },
      null, { timeout, polling: 10 }
    ).then(() => true).catch(() => false);
    return ok ? Date.now() - t0 : null;
  };

  if (scenario === 'A') {
    await openArticle(POSTS[0]);
    await page.waitForFunction(() => { const b = document.querySelector('#app .article-detail-body'); return !!b && b.textContent.trim().length > 200; }, null, { timeout: 30000 });
    await sleep(2000);                                   // 稳定（渲染/高亮/目录都做完）
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(300);
    const t0 = Date.now();
    await openArticle(POSTS[0]);
    const first = await page.waitForFunction(() => { const b = document.querySelector('#app .article-detail-body'); const p = b && b.querySelector('p'); return !!(p && p.textContent.trim().length > 10); }, null, { timeout: 30000, polling: 10 }).then(() => true).catch(() => false);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    m.firstMs = first ? Date.now() - t0 : null;
    m.bodyMs = m.firstMs;
  } else if (scenario === 'B') {
    await openArticle(POSTS[0]);
    await page.waitForFunction(() => { const b = document.querySelector('#app .article-detail-body'); return !!b && b.textContent.trim().length > 200; }, null, { timeout: 30000 });
    await sleep(300);                                    // 正文刚渲染完就重开
    const t0 = Date.now();
    await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    const first = await page.waitForFunction(() => { const b = document.querySelector('#app .article-detail-body'); const p = b && b.querySelector('p'); return !!(p && p.textContent.trim().length > 10); }, null, { timeout: 30000, polling: 10 }).then(() => true).catch(() => false);
    m.firstMs = first ? Date.now() - t0 : null;
    m.bodyMs = m.firstMs;
  } else {
    const t0 = Date.now();
    await openArticle(POSTS[0]);
    await sleep(80);
    await openArticle(POSTS[1]);
    await sleep(80);
    await openArticle(POSTS[2]);
    const ok = await page.waitForFunction((expect) => {
      const b = document.querySelector('#app .article-detail-body');
      if (!b || b.textContent.trim().length < 200) return false;
      // 必须是第 3 篇（embodied-ai-notes）的内容，防止旧文章残留
      return b.textContent.indexOf(expect) !== -1;
    }, '具身智能', { timeout: 30000, polling: 10 }).then(() => true).catch(() => false);
    m.firstMs = ok ? Date.now() - t0 : null;
    m.bodyMs = m.firstMs;
    m.extra.expectedThird = ok;
  }

  const after = await page.evaluate(() => ({
    longTasks: (window.__lt || []).slice(),
    marks: performance.getEntriesByType('mark').filter(x => /^art:/.test(x.name)).map(x => ({ n: x.name, t: Math.round(x.startTime) })),
    text: (function () { const b = document.querySelector('#app .article-detail-body'); return b ? b.textContent.trim().slice(0, 30) : ''; })()
  }));
  const lt = after.longTasks.slice(longTasksBefore);
  const maxLt = lt.reduce((mx, x) => Math.max(mx, x.d), 0);
  const blocking = lt.reduce((s, x) => s + Math.max(0, x.d - 50), 0);

  await ctx.close();
  return {
    version: site.label, scenario, config: cfg.id, rep,
    firstMs: m.firstMs, bodyMs: m.bodyMs,
    maxLongTask: maxLt, blockingMs: blocking, longTasks: lt.slice(-6),
    marks: after.marks, extra: m.extra
  };
}

(async () => {
  const opt = args(process.argv.slice(2));
  const cfg = CONFIGS[opt.config];
  cfg.id = opt.config;
  const sites = [];
  for (let i = 0; i < opt.sites.length; i++) {
    const dir = path.resolve(ROOT, opt.sites[i]);
    const { server, state } = createServer(dir, PREFIX);
    const port = await listen(server, 0);
    const proxy = createShapingProxy({ targetPort: port, latencyMs: 150, downloadKbps: 1638.4 });
    const proxyPort = await listenProxy(proxy.server, 0);
    sites.push({ label: i === 0 ? 'B' : 'C', baseUrl: 'http://127.0.0.1:' + (cfg.useProxy ? proxyPort : port), server, proxy });
  }
  const browser = await chromium.launch(Object.assign({ headless: true }, opt.channel !== 'chromium' ? { channel: opt.channel } : {}));
  const samples = [];
  const labels = sites.map(s => s.label);
  for (const scenario of ['A', 'B', 'C']) {
    for (let rep = 1; rep <= opt.repeat; rep++) {
      const order = rep % 2 === 1 ? sites.slice() : sites.slice().reverse();
      for (const site of order) {
        const s = await sample(browser, site, cfg, scenario, rep);
        samples.push(s);
        console.log('  ' + scenario + ' ' + s.version + ' rep ' + rep + ' first=' + s.firstMs + 'ms maxLT=' + s.maxLongTask + 'ms block=' + s.blockingMs + 'ms');
      }
    }
  }
  const med = (arr) => { const v = arr.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const p90 = (arr) => { const v = arr.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.9))] : null; };
  const summary = {};
  for (const scenario of ['A', 'B', 'C']) {
    for (const label of labels) {
      const ss = samples.filter(s => s.scenario === scenario && s.version === label);
      summary[scenario + '/' + label] = {
        n: ss.length,
        firstMs: [med(ss.map(s => s.firstMs)), Math.min(...ss.map(s => s.firstMs || 1e9)), Math.max(...ss.map(s => s.firstMs || 0)), p90(ss.map(s => s.firstMs))],
        maxLongTask: med(ss.map(s => s.maxLongTask)),
        blockingMs: med(ss.map(s => s.blockingMs)),
        marks: (() => { const all = ss[0] && ss[0].marks; return all && all.length ? all : null; })()
      };
    }
  }
  console.log('\n== 汇总（' + opt.config + '）==');
  for (const k of Object.keys(summary)) {
    const s = summary[k];
    console.log(' ' + k + ' n=' + s.n + ' 首段可读 ' + s.firstMs[0] + ' [' + s.firstMs[1] + '~' + s.firstMs[2] + '] p90=' + s.firstMs[3]
      + ' | 最长任务 ' + s.maxLongTask + 'ms | 阻塞 ' + s.blockingMs + 'ms');
  }
  if (opt.out) {
    fs.writeFileSync(opt.out, JSON.stringify({ generatedAt: new Date().toISOString(), args: opt, summary, samples }, null, 1));
    console.log('写入 ' + opt.out);
  }
  await browser.close();
  for (const s of sites) { s.server.close(); s.proxy.server.close(); }
})().catch(e => { console.error('DIAG ERROR:', e && e.stack || e); process.exit(1); });
