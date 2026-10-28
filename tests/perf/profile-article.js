#!/usr/bin/env node
'use strict';
/**
 * Batch 6C-2：文章渲染的 CPU Profile（CDP Profiler，采样 200µs）
 * 输出：按 self time 排序的 Top 函数 + 与 perf marks / long task 的对应关系。
 *
 * 用法：node tests/perf/profile-article.js [--site .] [--config mobile] [--out profile.json]
 */
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { createServer, listen } = require('../browser/helpers/server');
const { createShapingProxy, listen: listenProxy } = require('./net-throttle');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const POST = 'deep-learning-in-slam';

function args(argv) {
  const a = { site: '.', config: 'mobile', out: null, channel: process.env.PW_CHANNEL || 'chrome' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') a.site = argv[++i];
    else if (argv[i] === '--config') a.config = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--channel') a.channel = argv[++i];
  }
  return a;
}

(async () => {
  const opt = args(process.argv.slice(2));
  const mobile = opt.config === 'mobile';
  const dir = path.resolve(ROOT, opt.site);
  const { server, state } = createServer(dir, PREFIX);
  const port = await listen(server, 0);
  const proxy = createShapingProxy({ targetPort: port, latencyMs: 150, downloadKbps: 1638.4 });
  const proxyPort = await listenProxy(proxy.server, 0);
  const base = 'http://127.0.0.1:' + (mobile ? proxyPort : port) + PREFIX + '/';

  const browser = await chromium.launch(Object.assign({ headless: true }, opt.channel !== 'chromium' ? { channel: opt.channel } : {}));
  const ctx = await browser.newContext(mobile ? Object.assign({}, devices['Pixel 7']) : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*giscus.app*'] });
  if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const t0 = Date.now();
    while (reg && !navigator.serviceWorker.controller && Date.now() - t0 < 20000) {
      await new Promise(r => setTimeout(r, 50));
    }
  });
  await page.waitForTimeout(1200);

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await page.evaluate((id) => { location.hash = '#/post/' + id; }, POST);
  await page.waitForFunction(() => {
    const b = document.querySelector('#app .article-detail-body');
    return !!b && b.textContent.trim().length > 200;
  }, null, { timeout: 30000 });
  const readableMs = Date.now() - t0;
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(400);
  const { profile } = await cdp.send('Profiler.stop');

  // 聚合 self time：按调用树聚合每个节点的 hitCount * 采样间隔
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas || [];
  const samples = profile.samples || [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const cf = node.callFrame;
    const key = (cf.functionName || '(anonymous)') + ' @ ' + (cf.url ? cf.url.replace(/^.*\/blog\//, '') : '') + ':' + (cf.lineNumber + 1);
    const delta = (dt[i] || 200) / 1000;   // µs → ms
    self.set(key, (self.get(key) || 0) + delta);
  }
  const top = Array.from(self.entries()).sort((a, b) => b[1] - a[1]).slice(0, 14);
  const total = Array.from(self.values()).reduce((s, v) => s + v, 0);

  console.log('环境: ' + (mobile ? '移动 4× CPU + 整形' : '桌面') + ' | 正文可读 ' + readableMs + 'ms | profile 总采样时间 ' + Math.round(total) + 'ms');
  console.log('\nTop self time 函数：');
  top.forEach(([k, v]) => console.log('  ' + v.toFixed(1).padStart(8) + 'ms  ' + (100 * v / total).toFixed(1).padStart(5) + '%  ' + k));

  if (opt.out) {
    fs.writeFileSync(opt.out, JSON.stringify({ readableMs, totalMs: Math.round(total), top, profile }, null, 1));
    console.log('\n完整 profile 写入 ' + opt.out);
  }
  await browser.close();
  server.close();
  proxy.server.close();
})().catch(e => { console.error('PROFILE ERROR:', e && e.stack || e); process.exit(1); });
