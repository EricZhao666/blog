#!/usr/bin/env node
'use strict';
/**
 * Batch 6B-1.1：SW 版本一致性与边界行为验证（真实 Chromium + 合成版本化站点）
 *
 * 目的：6B-1 的"网络优先 + 150ms 超时回退 + 同一导航统一决策"必须满足：
 *   1) 同一页面不能混用不兼容版本（html / css / js / data 版本必须一致）；
 *   2) 后台回填不能破坏当前可用缓存；
 *   3) 最新内容最终可以被用户获取；
 *   4) 不会无限期持续返回旧内容；
 *   5) 慢网、离线、HTTP 错误要被正确区分。
 *
 * 合成站点（tests/browser/fixtures/swsite）里每个资源都带版本标记，
 * 页面把"本页实际用到的版本"汇总到 window.__versions，混版可以直接看到。
 *
 * 用法：
 *   node tests/browser/sw-consistency.spec.js
 *   PW_CHANNEL=chromium node tests/browser/sw-consistency.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createVersionServer, listen } = require('./helpers/version-server');

const ROOT = path.resolve(__dirname, '..', '..');
const SITE = path.join(__dirname, 'fixtures', 'swsite');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
// SW_FILE 可指向任一候选/历史快照，用于对同一批场景做对照（仓库 sw.js 不会被改动）
const SW_FILE = process.env.SW_FILE ? path.resolve(ROOT, process.env.SW_FILE) : path.join(ROOT, 'sw.js');
const SHOTS = path.join(__dirname, 'artifacts');
const EVIDENCE = path.join(SHOTS, 'sw-consistency.json');

let pass = 0, fail = 0;
const results = [];
const evidence = {};

function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, extra: extra === undefined ? null : extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function versionsOf(page) {
  return page.evaluate(() => ({
    versions: window.__versions || null,
    rendered: !!window.__rendered,
    dumped: !!window.__versionsDumped,
    swError: window.__swError || null,
    title: document.title,
    offlinePage: document.body ? document.body.getAttribute('data-offline') === '1' : false,
    bodyText: document.body ? document.body.innerText.slice(0, 80) : ''
  }));
}

const VER_KEYS = ['html', 'css', 'js', 'data', 'user', 'projects'];

function allSame(v) {
  if (!v) return false;
  const vals = VER_KEYS.map(k => v[k]);
  return vals.every(x => x && x === vals[0]);
}

// 允许个别资源缺失（例如注入 500），但已加载的资源必须来自同一版本
function notMixed(v) {
  if (!v) return false;
  const present = VER_KEYS.map(k => v[k]).filter(x => x);
  if (present.length < 3) return false;            // 至少 html/css/js 要到
  return new Set(present).size === 1;
}

function verSummary(v) {
  if (!v) return 'null';
  return VER_KEYS.map(k => k + '=' + v[k]).join(',');
}

async function waitController(page, timeout = 20000) {
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

async function warm(page, base) {
  await page.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
  const controlled = await waitController(page);
  await page.waitForTimeout(900);   // 等预取/安装收敛
  return controlled;
}

async function readAfter(page, action, opts) {
  const options = opts || {};
  const startedAt = Date.now();
  let status = 0;
  try {
    const resp = await action();
    status = resp ? resp.status() : 0;
  } catch (e) {
    return {
      status: -1,
      error: String(e.message || e).split('\n')[0],
      versions: null, rendered: false, offlinePage: false, dumped: false,
      bodyText: 'navigation failed: ' + String(e.message || e).split('\n')[0].slice(0, 80)
    };
  }
  if (!options.expectNoContent) {
    await page.waitForFunction(() => window.__versionsDumped === true, null, { timeout: 30000 }).catch(() => {});
  }
  const info = await versionsOf(page);
  info.status = status;
  info.elapsedMs = Date.now() - startedAt;
  return info;
}

const reload = page => readAfter(page, () => page.reload({ waitUntil: 'load', timeout: 60000 }));
const goto = (page, url) => readAfter(page, () => page.goto(url, { waitUntil: 'load', timeout: 60000 }));

async function cacheNames(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) {
      const c = await caches.open(n);
      out[n] = (await c.keys()).map(r => new URL(r.url).pathname).sort();
    }
    return out;
  });
}

async function assetTimings(page) {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .filter(e => /\/(js|css)\//.test(e.name))
    .map(e => ({
      path: new URL(e.name).pathname.replace('/blog', ''),
      dur: Math.round(e.duration),
      transfer: e.transferSize || 0
    })));
}

const FIRST_SCREEN_PATHS = ['/css/style.css', '/js/app.js', '/js/data.js', '/js/user-posts.js', '/js/projects.js'];

// 判断"首屏资源是否来自 SW 缓存"的硬证据：服务端命中计数。
// 注意不能用 transferSize —— 经 SW 返回的响应 transferSize 恒为 0，无论 SW 是从缓存读还是回源；
// 也不能只看计时 —— 机器负载会把 220ms 放大到 330ms。只有"这些路径一次都没有到达服务器"才是真证据。
function snapshotHits(state) {
  const out = {};
  FIRST_SCREEN_PATHS.forEach(p => { out[p] = state.hits[p] || 0; });
  return out;
}

function hitsDelta(before, state) {
  const out = {};
  FIRST_SCREEN_PATHS.forEach(p => { out[p] = (state.hits[p] || 0) - (before[p] || 0); });
  return out;
}

function allZero(delta) {
  return FIRST_SCREEN_PATHS.every(p => delta[p] === 0);
}

async function cachedFirstScreen(page) {
  const t = await assetTimings(page);
  const fs = t.filter(x => /(style\.css|app\.js|data\.js|user-posts\.js|projects\.js)$/.test(x.path));
  return { count: fs.length, timings: fs };
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, state } = createVersionServer({ siteDir: SITE, swPath: SW_FILE, prefix: PREFIX });
  const port = await listen(server, 0);
  const base = 'http://127.0.0.1:' + port;

  const launchOpts = { headless: true };
  if (CHANNEL !== 'chromium') launchOpts.channel = CHANNEL;
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    console.error('无法启动浏览器（' + CHANNEL + '）：' + String(e.message).split('\n')[0]);
    server.close();
    process.exit(2);
  }
  console.log('浏览器: ' + CHANNEL + ' ' + browser.version());
  console.log('合成站点: tests/browser/fixtures/swsite，被测 SW: ' + path.relative(ROOT, SW_FILE).replace(/\\/g, '/'));

  const swSrc = fs.readFileSync(SW_FILE, 'utf8');
  const cacheVer = (/CACHE_VERSION = '([^']+)'/.exec(swSrc) || [])[1];
  console.log('被测 SW CACHE_VERSION: ' + cacheVer);

  function reset(over) {
    state.version = 1;
    state.swTag = null;
    state.latencyMs = 0;
    state.pathLatency = {};
    state.faults = {};
    state.hits = {};
    state.bytes = {};
    Object.assign(state, over || {});
  }

  const newCtx = () => browser.newContext({ serviceWorkers: 'allow' });

  try {
    // ---------------------------------------------------------------- T1 首次导航（无缓存）
    {
      reset();
      const ctx = await newCtx();
      const page = await ctx.newPage();
      const controlled = await warm(page, base);
      const v = await versionsOf(page);
      check('T1 首访受 SW 控制', controlled);
      check('T1 首访渲染成功', v.rendered, v.title);
      check('T1 首访版本自洽', allSame(v.versions), verSummary(v.versions));
      evidence.T1 = { versions: v.versions, controlled };
      const caches = await cacheNames(page);
      evidence.T1.caches = Object.keys(caches).map(k => k + ':' + caches[k].length);
      await ctx.close();
    }

    // ---------------------------------------------------------------- T2 有缓存 + 发布新版本 + 慢链路
    let cachePageCtx = null;
    let cachePage = null;
    let t2 = null;
    {
      reset({ version: 1 });
      cachePageCtx = await newCtx();
      cachePage = await cachePageCtx.newPage();
      await warm(cachePage, base);

      state.version = 2;
      state.latencyMs = 800;
      const hitsBefore = snapshotHits(state);
      const t0 = Date.now();
      t2 = await reload(cachePage);
      t2.elapsedMs = Date.now() - t0;
      const t2Hits = hitsDelta(hitsBefore, state);
      const t2c = await cachedFirstScreen(cachePage);
      t2.timings = t2c.timings;
      check('T2 慢链路 + 有缓存：页面可渲染', t2.rendered, t2.status + ' / ' + t2.elapsedMs + 'ms');
      check('T2 慢链路 + 有缓存：同页不混版', allSame(t2.versions), verSummary(t2.versions));
      check('T2 五份首屏资源都没有回源（服务端命中 0）', allZero(t2Hits), JSON.stringify(t2Hits));
      check('T2 慢链路走缓存（load 明显快于 800ms 网络）', t2.elapsedMs < 600, t2.elapsedMs + 'ms');
      evidence.T2 = { versions: t2.versions, elapsedMs: t2.elapsedMs, firstScreenHits: t2Hits, timings: t2.timings };
    }

    // ---------------------------------------------------------------- T3 后台回填期间连续刷新
    {
      const rounds = [];
      for (let i = 0; i < 3; i++) {
        const r = await reload(cachePage);
        rounds.push({ versions: r.versions, consistent: allSame(r.versions), elapsedMs: r.elapsedMs, status: r.status });
        await sleep(400);
      }
      const bad = rounds.filter(r => !r.consistent);
      check('T3 后台回填期间每次刷新都版本自洽', bad.length === 0,
        bad.length ? JSON.stringify(bad.map(b => b.versions)) : '3/3 自洽');

      await cachePage.waitForTimeout(3500);      // 等后台回填完成
      const final = await reload(cachePage);
      check('T3 最新内容最终可达（收敛到 v2）',
        allSame(final.versions) && final.versions && final.versions.html === '2', verSummary(final.versions));
      evidence.T3 = { rounds, final: { versions: final.versions, status: final.status } };
    }

    // ---------------------------------------------------------------- T4 快链路发布新版本（刷新即更新）
    {
      state.version = 3;
      state.latencyMs = 0;
      state.pathLatency = {};
      const r = await reload(cachePage);
      check('T4 快链路刷新立即拿到新版本', allSame(r.versions) && r.versions && r.versions.js === '3',
        verSummary(r.versions));
      evidence.T4 = { versions: r.versions };
      await cachePageCtx.close();
    }

    // ---------------------------------------------------------------- T5 真实形状：外壳快、data.js 慢
    {
      reset({ version: 2 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);

      state.version = 3;
      state.pathLatency = {
        '/index.html': 250,
        '/css/style.css': 400,
        '/js/app.js': 600,
        '/js/data.js': 2000,
        '/js/user-posts.js': 300,
        '/js/projects.js': 300
      };
      const a = await reload(page);
      await sleep(700);                       // 外壳/app 已回填，data.js 仍在途中
      const b = await reload(page);
      await sleep(3500);
      const c = await reload(page);
      check('T5 第 1 次导航版本自洽', allSame(a.versions), verSummary(a.versions));
      check('T5 回填窗口内再刷新仍自洽', allSame(b.versions), verSummary(b.versions));
      check('T5 最终收敛到 v3', allSame(c.versions) && c.versions && c.versions.html === '3', verSummary(c.versions));
      evidence.T5 = { first: a.versions, midUpdate: b.versions, final: c.versions };
      await ctx.close();
    }

    // ---------------------------------------------------------------- T6 部分资源失败
    {
      reset({ version: 1 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);

      state.version = 2;
      state.latencyMs = 600;
      state.faults = { '/js/data.js': 500 };
      const a = await reload(page);
      state.faults = {};
      await page.waitForTimeout(3000);
      state.latencyMs = 600;
      const b = await reload(page);
      check('T6 单资源 500 时页面不崩（仍可渲染）', a.rendered, a.status + ' / ' + verSummary(a.versions));
      check('T6 单资源 500 时不产生混版（缺失资源单独记）', notMixed(a.versions), verSummary(a.versions));
      check('T6 故障恢复后最终拿到完整新版本', allSame(b.versions) && b.versions && b.versions.html === '2',
        verSummary(b.versions));
      evidence.T6 = { duringFault: a.versions, afterRecovery: b.versions };
      await ctx.close();
    }

    // ---------------------------------------------------------------- T7 离线（有缓存）
    {
      reset({ version: 1 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);
      await ctx.setOffline(true);
      const r = await reload(page);
      check('T7 离线刷新首页可用', r.status === 200 && r.rendered && !r.offlinePage, r.status + ' / ' + r.title);
      check('T7 离线页面版本自洽', allSame(r.versions), verSummary(r.versions));
      evidence.T7 = { versions: r.versions, status: r.status };
      await ctx.setOffline(false);
      await ctx.close();
    }

    // ---------------------------------------------------------------- T8 离线且无缓存
    {
      reset();
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);
      await page.evaluate(async () => {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
      });
      await ctx.setOffline(true);
      const r = await goto(page, base + PREFIX + '/');
      check('T8 无缓存离线时给出明确离线页', r.offlinePage === true, r.status + ' / ' + r.bodyText.replace(/\n/g, ' '));
      evidence.T8 = { offlinePage: r.offlinePage, status: r.status, text: r.bodyText };
      await ctx.setOffline(false);
      await ctx.close();
    }

    // ---------------------------------------------------------------- T9 SW 被终止后重启
    {
      reset({ version: 1 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await sleep(300);

      state.version = 2;
      state.latencyMs = 800;
      const r = await reload(page);
      check('T9 SW 重启后刷新版本自洽', allSame(r.versions), verSummary(r.versions));

      // SW 重启后，重启后的导航会重新决策；同一文档内的首屏资源必须仍取该文档对应版本
      const probe = await page.evaluate(async () => {
        const t0 = performance.now();
        try {
          const resp = await fetch('./js/data.js', { cache: 'no-store' });
          const text = await resp.text();
          const m = /DATA_VER = '(\d+)'/.exec(text);
          return { ok: resp.ok, ms: Math.round(performance.now() - t0), ver: m ? m[1] : null };
        } catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), ver: null }; }
      });
      check('T9 SW 重启后同文档首屏资源仍与文档版本一致',
        probe.ok && probe.ver === r.versions.html, JSON.stringify(probe) + ' doc=' + r.versions.html);
      evidence.T9 = { versions: r.versions, probe };
      await ctx.close();
    }

    // ---------------------------------------------------------------- T10 双标签页版本更新
    {
      reset({ version: 1 });
      const ctx = await newCtx();
      const t1 = await ctx.newPage();
      await warm(t1, base);
      const names1 = Object.keys(await cacheNames(t1));

      state.version = 2;
      state.swTag = 't2';
      const t2 = await ctx.newPage();
      await warm(t2, base);
      await sleep(2500);
      const names2 = Object.keys(await cacheNames(t1));
      check('T10 新版本 SW 安装并生效', names2.some(n => n.endsWith('-t2')), names2.join(','));
      check('T10 旧版本缓存被清理', names1.every(n => names2.indexOf(n) === -1),
        '旧=' + names1.join(',') + ' 现=' + names2.join(','));
      const r1 = await reload(t1);
      const r2 = await reload(t2);
      check('T10 老标签页刷新后版本自洽', allSame(r1.versions), verSummary(r1.versions));
      check('T10 新标签页版本自洽且为新版本',
        allSame(r2.versions) && r2.versions && r2.versions.html === '2', verSummary(r2.versions));
      evidence.T10 = { names1, names2, tab1: r1.versions, tab2: r2.versions };
      await ctx.close();
    }

    // ---------------------------------------------------------------- T12 延迟档位（300ms / 2000ms）
    {
      reset({ version: 1 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);

      state.version = 2;
      state.latencyMs = 300;                 // 高于 150ms 阈值：应走缓存
      const h300 = snapshotHits(state);
      const a = await reload(page);
      const aHits = hitsDelta(h300, state);
      check('T12 300ms 延迟：同页不混版', allSame(a.versions), verSummary(a.versions));
      check('T12 300ms 延迟：首屏资源没有回源（服务端命中 0）', allZero(aHits),
        a.elapsedMs + 'ms / ' + JSON.stringify(aHits));

      await page.waitForTimeout(1200);        // 等 300ms 的网络结果完成过期判定
      state.latencyMs = 2000;                // 极慢链路：已判定过期 → 网络优先
      const b = await reload(page);
      check('T12 2000ms 延迟：不混版且拿到新版本',
        allSame(b.versions) && b.versions && b.versions.html === '2', verSummary(b.versions) + ' / ' + b.elapsedMs + 'ms');
      evidence.T12 = { at300: a.versions, at300ms: a.elapsedMs, at2000: b.versions, at2000ms: b.elapsedMs };
      await ctx.close();
    }

    // ---------------------------------------------------------------- T13 首次导航：无缓存 + 慢链路
    {
      reset({ version: 1, latencyMs: 1200 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      const t0 = Date.now();
      await page.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__versionsDumped === true, null, { timeout: 30000 }).catch(() => {});
      const v = await versionsOf(page);
      const elapsed = Date.now() - t0;
      check('T13 无缓存 + 慢链路：首访仍能完成（没有用空白缓存顶替）', v.rendered, elapsed + 'ms');
      check('T13 无缓存 + 慢链路：首访版本自洽', allSame(v.versions), verSummary(v.versions));
      evidence.T13 = { versions: v.versions, elapsedMs: elapsed };
      await ctx.close();
    }

    // ---------------------------------------------------------------- T14 SW 更新后离线仍可用
    {
      reset({ version: 1 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);
      state.version = 2;
      state.swTag = 't3';
      await page.reload({ waitUntil: 'load' });      // 触发新 SW 安装
      await waitController(page);
      await sleep(2500);
      await ctx.setOffline(true);
      const r = await reload(page);
      check('T14 SW 换代后离线仍可打开首页', r.status === 200 && r.rendered && !r.offlinePage,
        r.status + ' / ' + r.title);
      check('T14 SW 换代后离线页面版本自洽', allSame(r.versions), verSummary(r.versions));
      evidence.T14 = { versions: r.versions, status: r.status };
      await ctx.setOffline(false);
      await ctx.close();
    }

    // ---------------------------------------------------------------- T11 HTTP 错误 vs 缓存
    {
      reset({ version: 1 });
      const ctx = await newCtx();
      const page = await ctx.newPage();
      await warm(page, base);

      // 快链路：5xx 应原样返回，不被缓存掩盖
      state.faults = { '/index.html': 500 };
      state.latencyMs = 0;
      const fast = await readAfter(page, () => page.reload({ waitUntil: 'load', timeout: 60000 }), { expectNoContent: true });
      check('T11 快链路 5xx 原样返回（不被缓存掩盖）', fast.status === 500, 'status=' + fast.status);

      // 慢链路：超时先给缓存（记录为已知的容错行为），但不能把 5xx 写进缓存
      state.latencyMs = 800;
      const slow = await reload(page);
      state.faults = {};
      state.latencyMs = 0;
      const after = await reload(page);
      check('T11 慢链路 5xx 时用有效缓存兜底', slow.status === 200 && allSame(slow.versions), slow.status + ' / ' + verSummary(slow.versions));
      check('T11 5xx 未被写入缓存（恢复后仍拿到正常页面）', after.status === 200 && allSame(after.versions),
        after.status + ' / ' + verSummary(after.versions));
      evidence.T11 = { fastStatus: fast.status, slowVersions: slow.versions, after: after.versions };
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  fs.writeFileSync(EVIDENCE, JSON.stringify({ results, evidence, meta: { channel: CHANNEL, cacheVersion: cacheVer, generatedAt: new Date().toISOString() } }, null, 2), 'utf8');

  const failed = results.filter(r => !r.ok);
  console.log('\n共 ' + results.length + ' 项，PASS ' + pass + '，FAIL ' + fail);
  console.log('证据: ' + path.relative(ROOT, EVIDENCE));
  if (failed.length) console.log('失败项：\n  - ' + failed.map(f => f.name + (f.extra ? '  (' + f.extra + ')' : '')).join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SPEC ERROR:', e); process.exit(1); });
