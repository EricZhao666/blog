#!/usr/bin/env node
'use strict';
/**
 * Batch 6A：博客真实性能基线采集（只测量，不改业务代码）
 *
 * 用法：
 *   node tests/perf/perf.spec.js                       # 全部场景 × 桌面/移动 × 5 次
 *   node tests/perf/perf.spec.js --scenarios cold-home --configs mobile --repeat 3
 *   node tests/perf/perf.spec.js --out tests/perf/reports/baseline.json
 *
 * 参数：
 *   --scenarios a,b        cold-home | warm-home | long-post | search（默认全部）
 *   --configs a,b          desktop | mobile（默认全部）
 *   --repeat N             每种场景/配置的重复次数（默认 5）
 *   --out FILE             JSON 输出路径（默认 tests/perf/reports/baseline.json）
 *   --post ID              长文场景使用的文章 id（默认自动选取正文最长的文章）
 *   --keyword KW           搜索场景固定关键词（默认 SLAM）
 *   --keyword2 KW          搜索场景重复输入关键词（默认 学习）
 *   --channel NAME         浏览器通道（默认 chrome，可用 chromium）
 *   --port N               固定静态服务器端口（默认 8137）
 *   --proxy-port N         移动端整形代理端口（默认 8138）
 *   --quiet                不打印逐次进度
 *
 * 口径说明（详见 PERF_BASELINE.md）：
 *   - FCP / LCP / CLS / 长任务由页面内 PerformanceObserver 采集（实测）；
 *   - TBT 由长任务按 (duration - 50ms) 累加得到，窗口 = 导航开始 → load + 2s（计算值）；
 *   - JS 执行时间取 CDP Performance.getMetrics 的 ScriptDuration 增量（实测，主线程，不含 SW 进程）；
 *   - 请求数量与字节数取 Resource Timing（经 SW 返回的响应 transferSize 为 0，因此另记服务端命中数）；
 *   - 无法可靠采集的指标写 null 并登记到 unavailable，绝不填 0。
 *
 * 退出码：0 全部场景采集完成；1 部分场景失败/样本不足；2 环境不可用（无法启动浏览器等）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium, devices } = require('playwright');
const { createServer, listen } = require('../browser/helpers/server');
const { createShapingProxy, listen: listenProxy } = require('./net-throttle');
const { createProbe, listen: listenProbe } = require('./http-probe');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const HOME = PREFIX + '/';
const SETTLE_MS = 2500;        // load 之后继续观测的时长（覆盖 LCP / CLS / 长任务）
const TBT_TAIL_MS = 2000;      // TBT 近似窗口尾部
const SEARCH_STABLE_MS = 1200; // 搜索渲染稳定判定
const THIRD_PARTY_BLOCK = ['*giscus.app*'];

const ALL_SCENARIOS = ['cold-home', 'warm-home', 'long-post', 'post-lazy', 'search'];
const ALL_CONFIGS = ['desktop', 'mobile'];

// ---------------------------------------------------------------- 工具函数
const r2 = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);

function statsOf(values) {
  const v = values.filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null, spread: null, spreadPct: null, stdev: null };
  const n = v.length;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const variance = v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n;
  return {
    n,
    median: r2(median),
    min: r2(v[0]),
    max: r2(v[n - 1]),
    spread: r2(v[n - 1] - v[0]),
    spreadPct: median ? r2(((v[n - 1] - v[0]) / median) * 100) : null,
    stdev: r2(Math.sqrt(variance))
  };
}

function fileMeta(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return { path: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}

function gitMeta() {
  return {
    branch: git(['branch', '--show-current']),
    head: git(['rev-parse', 'HEAD']),
    headShort: git(['rev-parse', '--short', 'HEAD']),
    subject: git(['log', '-1', '--pretty=%s']),
    dirty: (git(['status', '--porcelain']) || '') !== ''
  };
}

function swMeta() {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const ver = /CACHE_VERSION\s*=\s*'([^']+)'/.exec(src);
  const cap = /RUNTIME_CACHE_CAP\s*=\s*(\d+)/.exec(src);
  return {
    cacheVersion: ver ? ver[1] : null,
    runtimeCacheCap: cap ? Number(cap[1]) : null,
    strategy: {
      navigate: 'network-first',
      vendor: 'stale-while-revalidate',
      otherSameOrigin: 'network-first',
      crossOrigin: 'bypass'
    }
  };
}

function longestPostId() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  const fn = new Function(src + '\nreturn { POSTS: POSTS, USER_POSTS: typeof USER_POSTS === "undefined" ? [] : USER_POSTS };');
  const { POSTS, USER_POSTS } = fn();
  const all = POSTS.concat(USER_POSTS || []);
  // Batch 6B-2 起正文在 data/posts/<id>.md，长度需要从正文文件读，保证新旧两版选中同一篇
  all.forEach((p) => {
    if (typeof p.content === 'string') return;
    const f = path.join(ROOT, 'data', 'posts', p.id + '.md');
    if (fs.existsSync(f)) p.content = fs.readFileSync(f, 'utf8');
  });
  const sorted = all.slice().sort((a, b) => (b.content || '').length - (a.content || '').length);
  return { id: sorted[0].id, title: sorted[0].title, contentChars: (sorted[0].content || '').length, totalPosts: all.length };
}

function parseArgs(argv) {
  const a = {
    scenarios: ALL_SCENARIOS.slice(),
    configs: ALL_CONFIGS.slice(),
    repeat: 5,
    out: path.join(__dirname, 'reports', 'baseline.json'),
    post: null,
    keyword: 'SLAM',
    keyword2: '学习',
    channel: process.env.PW_CHANNEL || 'chrome',
    port: Number(process.env.PERF_PORT || 8137),
    proxyPort: Number(process.env.PERF_PROXY_PORT || 8138),
    probePort: Number(process.env.PERF_PROBE_PORT || 8139),
    diagnostics: true,
    quiet: false,
    swConfig: null,
    swFile: null,
    searchThink: 0
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error('参数缺少取值: ' + k);
      return v;
    };
    switch (k) {
      case '--scenarios': a.scenarios = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--configs': a.configs = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--repeat': a.repeat = Math.max(1, Number(next())); break;
      case '--out': a.out = path.resolve(ROOT, next()); break;
      case '--post': a.post = next(); break;
      case '--keyword': a.keyword = next(); break;
      case '--keyword2': a.keyword2 = next(); break;
      case '--channel': a.channel = next(); break;
      case '--port': a.port = Number(next()); break;
      case '--proxy-port': a.proxyPort = Number(next()); break;
      case '--search-think': a.searchThink = Number(next()); break;
      case '--no-diagnostics': a.diagnostics = false; break;
      case '--sw-config': a.swConfig = parseSwConfig(next()); break;
      case '--sw-file': a.swFile = next(); break;
      case '--quiet': a.quiet = true; break;
      case '--help': case '-h': a.help = true; break;
      default: throw new Error('未知参数: ' + k);
    }
  }
  for (const s of a.scenarios) if (ALL_SCENARIOS.indexOf(s) === -1) throw new Error('未知场景: ' + s);
  for (const c of a.configs) if (ALL_CONFIGS.indexOf(c) === -1) throw new Error('未知配置: ' + c);
  return a;
}

const USAGE = [
  'node tests/perf/perf.spec.js [--scenarios cold-home,warm-home,long-post,search]',
  '                             [--configs desktop,mobile] [--repeat 5]',
  '                             [--out tests/perf/reports/baseline.json]',
  '                             [--post <id>] [--keyword SLAM] [--keyword2 学习]',
  '                             [--channel chrome] [--port 8137] [--proxy-port 8138]',
  '                             [--sw-config \'{"hotStart":"timeout"}\'] [--sw-file <path>]',
  '                             [--no-diagnostics] [--quiet]'
].join('\n');

// Batch 6B：候选 SW 由 sw-candidates/build.js 生成，只在测量期通过观测探针注入 /blog/sw.js
const { buildSwCandidate, parseSwConfig } = require('./sw-candidates/build');

// ---------------------------------------------------------------- 页面内观测脚本
// 用 addInitScript 注入，保证在所有页面脚本之前注册观察者（否则早于首帧的 FCP/LCP 会丢）
const INIT_SCRIPT = `(() => {
  if (window.__perf) return;
  const st = {
    lcp: null, lcpTag: null, lcpText: null,
    shifts: [], longTasks: [], observerErrors: [],
    controllerAtLoad: null, cacheNamesAtLoad: null, cachesAvailable: false
  };
  window.__perf = st;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        st.lcp = e.startTime;
        if (e.element) {
          st.lcpTag = e.element.tagName + (e.element.className ? '.' + String(e.element.className).split(' ')[0] : '');
          st.lcpText = (e.element.textContent || '').trim().slice(0, 40);
        }
        st.lcpSize = e.size;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) { st.observerErrors.push('lcp: ' + err.message); }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        st.shifts.push({ t: e.startTime, v: e.value });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (err) { st.observerErrors.push('cls: ' + err.message); }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) st.longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (err) {
    st.observerErrors.push('longtask(buffered): ' + err.message);
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) st.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask' });
    } catch (e2) { st.observerErrors.push('longtask: ' + e2.message); }
  }
  st.cachesAvailable = typeof caches !== 'undefined';
  // 首张文章卡片出现的时间：首页 LCP 只反映页头（6A §8.3），这个指标才代表"内容可见"
  st.firstCard = null;
  try {
    // 观察 documentElement：addInitScript 执行时 #app 还不存在，而 defer 脚本会在
    // DOMContentLoaded 之前就把首页渲染出来 —— 只等 DOMContentLoaded 会漏掉首屏渲染。
    const mo = new MutationObserver(() => {
      if (st.firstCard != null) return;
      if (document.querySelectorAll('#app .article-card').length > 5) {
        st.firstCard = Math.round(performance.now() * 100) / 100;
        mo.disconnect();
      }
    });
    mo.observe(document, { childList: true, subtree: true });
  } catch (err) {
    st.observerErrors.push('firstCard: ' + err.message);
  }
  window.addEventListener('load', () => {
    st.controllerAtLoad = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    if (st.cachesAvailable) {
      caches.keys().then((k) => { st.cacheNamesAtLoad = k; }).catch(() => {});
    }
  }, { once: true });
})();`;

// 采集一次导航后的完整现场（同步部分）
function pageSnapshotFn(opts) {
  const st = window.__perf || {};
  const navE = performance.getEntriesByType('navigation')[0] || null;
  const res = performance.getEntriesByType('resource').map((e) => ({
    url: e.name.indexOf(location.origin) === 0 ? e.name.slice(location.origin.length) : e.name,
    type: e.initiatorType || '',
    start: Math.round(e.startTime * 100) / 100,
    dur: Math.round(e.duration * 100) / 100,
    ttfb: Math.round((e.responseStart - e.startTime) * 100) / 100,
    transfer: e.transferSize || 0,
    encoded: e.encodedBodySize || 0
  }));

  // CLS：按 session window 规则（间隔 >1s 或窗口 >5s 切窗），取最大窗口值
  const shifts = (st.shifts || []).slice().sort((a, b) => a.t - b.t);
  const windows = [];
  let win = null;
  for (const s of shifts) {
    if (!win || s.t - win.last > 1000 || s.t - win.start > 5000) {
      win = { start: s.t, last: s.t, value: s.v };
      windows.push(win);
    } else {
      win.last = s.t;
      win.value += s.v;
    }
  }
  const clsMax = windows.reduce((m, w) => Math.max(m, w.value), 0);
  const clsRaw = shifts.reduce((s, x) => s + x.v, 0);

  const loadEnd = navE ? navE.loadEventEnd : 0;
  const tbtEnd = loadEnd + (opts && opts.tbtTail ? opts.tbtTail : 0);
  let tbt = 0, ltCount = 0, ltMax = 0, ltTotal = 0;
  const ltList = [];
  for (const t of st.longTasks || []) {
    ltList.push({ start: Math.round(t.start), dur: Math.round(t.dur) });
    if (t.start + t.dur > tbtEnd) continue;
    ltCount++;
    ltTotal += t.dur;
    ltMax = Math.max(ltMax, t.dur);
    tbt += Math.max(0, t.dur - 50);
  }

  const paints = {};
  performance.getEntriesByType('paint').forEach((e) => { paints[e.name] = e.startTime; });

  const app = document.getElementById('app');
  const body = document.querySelector('#app .article-detail-body');

  return {
    nav: navE ? {
      ttfb: Math.round((navE.responseStart - navE.startTime) * 100) / 100,
      dcl: Math.round((navE.domContentLoadedEventEnd - navE.startTime) * 100) / 100,
      load: Math.round((navE.loadEventEnd - navE.startTime) * 100) / 100,
      duration: Math.round(navE.duration * 100) / 100,
      transfer: navE.transferSize || 0,
      encoded: navE.encodedBodySize || 0,
      protocol: navE.nextHopProtocol || null
    } : null,
    paints: {
      fp: paints['first-paint'] == null ? null : Math.round(paints['first-paint'] * 100) / 100,
      fcp: paints['first-contentful-paint'] == null ? null : Math.round(paints['first-contentful-paint'] * 100) / 100
    },
    lcp: {
      value: st.lcp == null ? null : Math.round(st.lcp * 100) / 100,
      tag: st.lcpTag || null,
      text: st.lcpText || null,
      size: st.lcpSize == null ? null : Math.round(st.lcpSize)
    },
    cls: {
      value: Math.round(clsMax * 10000) / 10000,
      rawSum: Math.round(clsRaw * 10000) / 10000,
      windows: windows.length,
      shiftCount: shifts.length
    },
    longTasks: { count: ltCount, totalMs: Math.round(ltTotal), maxMs: Math.round(ltMax), tbtMs: Math.round(tbt), all: ltList },
    resources: res,
    dom: {
      nodes: document.getElementsByTagName('*').length,
      appChildren: app ? app.children.length : 0,
      hasArticleBody: !!body,
      articleBodyChars: body ? body.innerHTML.length : 0,
      articleHeadings: body ? body.querySelectorAll('h2,h3').length : 0,
      tocItems: document.querySelectorAll('#tocPanel .toc-link').length
    },
    sw: {
      controllerAtLoad: st.controllerAtLoad,
      cacheNamesAtLoad: st.cacheNamesAtLoad,
      cachesAvailable: !!st.cachesAvailable,
      observerErrors: st.observerErrors || []
    },
    firstCardMs: st.firstCard == null ? null : st.firstCard,
    title: document.title
  };
}

async function swStateFn() {
  const reg = await navigator.serviceWorker.getRegistration();
  return {
    controller: !!navigator.serviceWorker.controller,
    scope: reg ? reg.scope : null,
    active: !!(reg && reg.active),
    waiting: !!(reg && reg.waiting),
    installing: !!(reg && reg.installing),
    scriptURL: reg && reg.active ? reg.active.scriptURL : null
  };
}

async function cacheInventoryFn() {
  const names = await caches.keys();
  const out = {};
  for (const n of names) {
    const c = await caches.open(n);
    const keys = (await c.keys()).map((r) => new URL(r.url).pathname).sort();
    out[n] = keys;
  }
  return out;
}

// 等待 SW 接管（首次访问时 controller 由 clients.claim 补上）
async function waitControllerFn(timeoutMs) {
  const t0 = Date.now();
  let reg = null;
  while (Date.now() - t0 < timeoutMs) {
    try { reg = await navigator.serviceWorker.getRegistration(); } catch (e) { /* ignore */ }
    if (navigator.serviceWorker.controller) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    controlled: !!navigator.serviceWorker.controller,
    active: !!(reg && reg.active),
    waitedMs: Date.now() - t0
  };
}

// SPA 路由切换测量：hash 赋值 → #app DOM 更新 → 双 rAF 渲染
async function routeSwitchFn(hash) {
  const app = document.getElementById('app');
  if (!app) return { error: 'no #app' };
  const t0 = performance.now();
  let renderAt = null;
  const obs = new MutationObserver(() => { if (renderAt === null) renderAt = performance.now(); });
  obs.observe(app, { childList: true });
  location.hash = hash;
  const deadline = t0 + 20000;
  while (performance.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
    if (renderAt !== null) break;
  }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const paintAt = performance.now();
  obs.disconnect();
  const body = document.querySelector('#app .article-detail-body');
  return {
    renderMs: renderAt === null ? null : Math.round((renderAt - t0) * 100) / 100,
    paintMs: Math.round((paintAt - t0) * 100) / 100,
    hash: location.hash,
    hasArticleBody: !!body,
    articleBodyChars: body ? body.innerHTML.length : 0,
    headings: body ? body.querySelectorAll('h2,h3').length : 0,
    tocItems: document.querySelectorAll('#tocPanel .toc-link').length,
    appChildren: app.children.length
  };
}

// Batch 6B-2：从首页点进文章（SPA 路由，正文按需加载）→ 正文可读时刻
async function openPostFn(arg) {
  const t0 = performance.now();
  const app = document.getElementById('app');
  if (!app) return { ok: false, error: 'no #app' };
  let mutations = 0;
  const obs = new MutationObserver(() => { mutations++; });
  obs.observe(app, { childList: true, subtree: true });
  location.hash = '#/post/' + arg.id;

  const deadline = t0 + 30000;
  for (;;) {
    const body = document.querySelector('#app .article-detail-body');
    if (body && body.textContent.trim().length > 200) {
      const readableMs = Math.round((performance.now() - t0) * 100) / 100;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      obs.disconnect();
      return {
        ok: true,
        readableMs: readableMs,
        paintMs: Math.round((performance.now() - t0) * 100) / 100,
        chars: body.textContent.length,
        mutations: mutations
      };
    }
    if (performance.now() > deadline) {
      obs.disconnect();
      return { ok: false, error: 'timeout', readableMs: null, mutations: mutations };
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

// 搜索测量：一次完整的输入事件 → 结果渲染（含 180ms 防抖），返回首帧/最终帧时间
async function searchFn(arg) {
  const keyword = arg.keyword;
  const app = document.getElementById('app');
  const input = document.getElementById('searchInput');
  if (!app || !input) return { error: 'missing #app or #searchInput' };
  const resBefore = performance.getEntriesByType('resource').length;
  const st = window.__perf || {};
  const ltBefore = (st.longTasks || []).length;

  // 首次输入会触发 courses/papers/notes 懒加载：必须等到数据真正就绪并完成补渲染，
  // 否则会把「懒加载补齐」算到下一次输入头上。
  // 正文语料（Batch 6B-2 拆出来后是独立的 search-index.json）也算"数据到齐"的一部分：
  // 拆分前的版本 POSTS 自带 content，这里恒为 true，因此新旧两版可用同一套测量。
  const postBodiesReady = () => {
    try {
      return typeof POSTS === 'undefined' || POSTS.every(p => typeof p.content === 'string');
    } catch (e) {
      return false;
    }
  };
  const dataReady = () => {
    try {
      return typeof COURSES !== 'undefined' && typeof PAPERS !== 'undefined' &&
        typeof COURSE_NOTES !== 'undefined' && postBodiesReady();
    } catch (e) {
      return false;
    }
  };

  const marks = [];
  const obs = new MutationObserver(() => marks.push(performance.now()));
  obs.observe(app, { childList: true });

  input.focus();
  // 模拟"点了搜索框再想一下"：这段时间里聚焦预热（ensureSearchDocs）已在后台拉语料；
  // t0 从真正开始输入算起，因此结论是"思考时间能抵消多少"，而非把等待算进搜索耗时。
  if (arg.thinkMs) await new Promise(r => setTimeout(r, arg.thinkMs));
  const t0 = performance.now();
  input.value = keyword;
  input.dispatchEvent(new Event('input', { bubbles: true }));

  const deadline = t0 + 30000;
  const lazy = !!arg.expectLazy;
  let last = -1;
  let stableSince = 0;
  let lazyReady = !lazy || dataReady();
  while (performance.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
    if (marks.length && marks[marks.length - 1] !== last) {
      last = marks[marks.length - 1];
      stableSince = performance.now();
    }
    if (lazy && !lazyReady) {
      if (dataReady()) lazyReady = true;
      else { stableSince = performance.now(); continue; }
    }
    if (marks.length && performance.now() - stableSince > (lazy ? 900 : 1200)) break;
  }
  obs.disconnect();

  const newRes = performance.getEntriesByType('resource').slice(resBefore).map((e) => ({
    url: e.name.indexOf(location.origin) === 0 ? e.name.slice(location.origin.length) : e.name,
    dur: Math.round(e.duration * 100) / 100,
    transfer: e.transferSize || 0,
    encoded: e.encodedBodySize || 0
  }));
  const tasks = (st.longTasks || []).slice(ltBefore);
  const countEl = document.querySelector('#app .search-results-count');
  return {
    keyword: keyword,
    expectLazy: lazy,
    lazyDataReady: lazyReady,
    renderCount: marks.length,
    renderTimelineMs: marks.map(m => Math.round((m - t0) * 100) / 100),
    firstRenderMs: marks.length ? Math.round((marks[0] - t0) * 100) / 100 : null,
    finalRenderMs: marks.length ? Math.round((marks[marks.length - 1] - t0) * 100) / 100 : null,
    newResources: newRes,
    lazyBytes: newRes.reduce((s, r) => s + (r.encoded || 0), 0),
    resultText: countEl ? countEl.textContent.trim().slice(0, 60) : null,
    longTaskCount: tasks.length,
    longTaskMs: Math.round(tasks.reduce((s, t) => s + Math.max(0, t.dur - 50), 0))
  };
}

// ---------------------------------------------------------------- 诊断探针（瓶颈定位用）
// 在主测量结束后单独会话执行：只调用页面已有的全局函数（renderMarkdown / renderHome /
// renderGlobalSearch / renderPost / loadData），不修改业务代码，也不进入正式场景统计。
async function microFn(arg) {
  const round = (v) => Math.round(v * 100) / 100;
  function bench(fn, reps) {
    const t = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      fn();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    return { reps: reps, median: round(t[Math.floor(t.length / 2)]), min: round(t[0]), max: round(t[t.length - 1]) };
  }

  const out = { meta: {}, bench: {} };
  const posts = (typeof getAllPosts === 'function') ? getAllPosts() : [];
  const post = posts.find((p) => p.id === arg.postId) || posts[0] || null;
  out.meta = {
    posts: posts.length,
    postId: post ? post.id : null,
    postChars: post ? (post.content || '').length : 0,
    postsChars: posts.reduce((s, p) => s + (p.content || '').length, 0),
    renderMarkdownAvailable: typeof renderMarkdown === 'function',
    markedAvailable: typeof marked !== 'undefined',
    purifyAvailable: typeof DOMPurify !== 'undefined',
    sanitizeConfigAvailable: typeof SANITIZE_CONFIG !== 'undefined'
  };

  // Batch 6B-2：正文按需加载后，先取回正文，否则 renderPost 基准测到的是加载态
  if (post && typeof loadPostBody === 'function') {
    try { await loadPostBody(post.id); } catch (e) { out.meta.bodyLoadError = String(e && e.message); }
  }
  if (typeof renderHome === 'function') out.bench.renderHome = bench(() => renderHome(), 7);
  if (post && typeof renderPost === 'function') out.bench.renderPost = bench(() => renderPost(post.id), 7);
  if (post && typeof renderMarkdown === 'function') {
    out.bench.renderMarkdown = bench(() => renderMarkdown(post.content), 7);
  }
  if (post && typeof marked !== 'undefined') {
    out.bench.markedParse = bench(() => marked.parse(post.content), 7);
    let html = '';
    try { html = marked.parse(post.content); } catch (e) { /* ignore */ }
    out.meta.rawHtmlChars = html.length;
    if (typeof DOMPurify !== 'undefined') {
      const cfg = typeof SANITIZE_CONFIG !== 'undefined' ? SANITIZE_CONFIG : undefined;
      out.bench.domPurify = bench(() => DOMPurify.sanitize(html, cfg), 7);
    }
  }

  const app = document.getElementById('app');
  if (app && post && typeof renderPost === 'function') {
    const html = renderPost(post.id);
    out.bench.domAssign = bench(() => { app.innerHTML = html; }, 5);
    // 先让懒加载的高亮库就绪，避免把首次下载 highlight.min.js 的时间算进「DOM 更新 → 渲染」
    if (typeof ensureHighlight === 'function') {
      try { await ensureHighlight(); } catch (e) { /* ignore */ }
    }
    out.meta.hljsReady = typeof hljs !== 'undefined';
    out.meta.postDomNodes = app.getElementsByTagName('*').length;
    for (let pass = 1; pass <= 3; pass++) {
      const t0 = performance.now();
      app.innerHTML = html;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.bench['domAssignToFrame' + pass] = { reps: 1, median: round(performance.now() - t0) };
    }
  }

  if (typeof loadData === 'function') {
    try {
      await Promise.all([loadData('courses'), loadData('papers'), loadData('notes')]);
    } catch (e) {
      out.meta.dataLoadError = e.message;
    }
  }
  out.meta.courses = typeof COURSES !== 'undefined' ? COURSES.length : null;
  out.meta.papers = typeof PAPERS !== 'undefined' ? PAPERS.length : null;
  out.meta.notes = typeof COURSE_NOTES !== 'undefined' ? Object.keys(COURSE_NOTES).length : null;
  out.meta.notesChars = typeof COURSE_NOTES !== 'undefined'
    ? Object.keys(COURSE_NOTES).reduce((s, k) => s + ((COURSE_NOTES[k].summary || '') + (COURSE_NOTES[k].notes || '')).length, 0)
    : 0;

  for (const kw of arg.keywords) {
    if (typeof renderGlobalSearch !== 'function') continue;
    out.bench['renderGlobalSearch:' + kw] = bench(() => renderGlobalSearch(kw), 7);
    try {
      const html = renderGlobalSearch(kw);
      out.meta['searchHtmlChars:' + kw] = html.length;
      const m = /找到\s*(\d+)\s*条/.exec(html);
      out.meta['searchTotal:' + kw] = m ? Number(m[1]) : null;
    } catch (e) { /* ignore */ }
  }

  // 纯扫描成本（不含 HTML 构建），用于区分「数据扫描」与「DOM/渲染」开销
  out.bench.searchScanOnly = bench(() => {
    const q = arg.keywords[0].toLowerCase();
    let n = 0;
    for (const p of posts) {
      if ((p.title || '').toLowerCase().includes(q)) n++;
      if ((p.excerpt || '').toLowerCase().includes(q)) n++;
      if ((p.content || '').toLowerCase().includes(q)) n++;
      (p.tags || []).forEach((t) => { if (t.toLowerCase().includes(q)) n++; });
    }
    return n;
  }, 7);

  return out;
}

async function runDiagnostics(config, deps, opt) {
  const bag = { errors: [] };
  const ctx = await newContextFor(deps.browser, config, deps);
  let result;
  try {
    const page = await ctx.newPage();
    attachDiagnostics(page, bag);
    await attachCDP(page, config, bag);
    await warmUp(page, config, deps);
    result = await page.evaluate(microFn, { postId: opt.post.id, keywords: [opt.keyword, opt.keyword2] });
    result.ok = true;
  } catch (e) {
    result = { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 300) };
  }
  result.errors = bag.errors.slice(0, 10);
  result.giscusBlock = bag.giscusBlock || null;
  await ctx.close();
  return result;
}

// ---------------------------------------------------------------- 浏览器侧装配
function buildConfigs(args) {
  const pixel = devices['Pixel 7'];
  return {
    desktop: {
      id: 'desktop',
      label: '桌面 Chromium：1440×900 @1x，无 CPU 限速，直连本地服务器（无网络整形）',
      contextOptions: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        serviceWorkers: 'allow'
      },
      cpuThrottle: 1,
      network: null,
      useProxy: false,
      conditions: {
        viewport: '1440×900',
        deviceScaleFactor: 1,
        userAgent: '默认桌面 UA',
        cpuThrottle: '1x（无限速）',
        network: '本地回环 127.0.0.1，无延迟/带宽整形',
        emulation: '无移动设备模拟'
      }
    },
    mobile: {
      id: 'mobile',
      label: '移动 Chromium：Pixel 7 设备模拟 + CPU 4x + Lighthouse mobileSlow4G 等价网络整形',
      contextOptions: Object.assign({}, pixel, { serviceWorkers: 'allow' }),
      cpuThrottle: 4,
      network: { latencyMs: 150, downloadKbps: 1638.4, uploadKbps: 750 },
      useProxy: true,
      conditions: {
        viewport: pixel.viewport.width + '×' + pixel.viewport.height,
        deviceScaleFactor: pixel.deviceScaleFactor,
        userAgent: pixel.userAgent,
        cpuThrottle: '4x（CDP Emulation.setCPUThrottlingRate）',
        network: '下行 1638.4 kbps / 上行 750 kbps / 每请求首字节延迟 150ms（HTTP 层整形代理）',
        emulation: "Playwright devices['Pixel 7']（isMobile / hasTouch）"
      }
    }
  };
}

async function launchBrowser(channel) {
  const opts = { headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] };
  if (channel && channel !== 'chromium') opts.channel = channel;
  return chromium.launch(opts);
}

async function newContextFor(browser, config, deps) {
  const ctx = await browser.newContext(config.contextOptions);
  await ctx.addInitScript({ content: INIT_SCRIPT });
  return ctx;
}

async function attachCDP(page, config, bag) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (config.cpuThrottle > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: config.cpuThrottle });
  }
  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: THIRD_PARTY_BLOCK });
    bag.giscusBlock = 'cdp';
  } catch (e) {
    bag.giscusBlock = 'failed: ' + e.message.split('\n')[0];
  }
  return cdp;
}

function attachDiagnostics(page, bag) {
  page.on('pageerror', (e) => bag.errors.push({ type: 'pageerror', message: String(e.message || e).split('\n')[0].slice(0, 300) }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text().slice(0, 300);
    bag.errors.push({ type: 'console', text: text, thirdParty: /giscus/.test(text) });
  });
  page.on('requestfailed', (r) => {
    bag.errors.push({
      type: 'requestfailed',
      url: r.url(),
      reason: (r.failure() || {}).errorText || 'unknown',
      thirdParty: /giscus/.test(r.url())
    });
  });
}

const CDP_PICK = ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'Nodes', 'Documents'];

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const out = {};
  for (const m of metrics) {
    if (CDP_PICK.indexOf(m.name) !== -1) out[m.name] = m.value;
  }
  return out;
}

// CDP Performance.getMetrics 中只有这几项是「秒」，其余是计数
const CDP_DURATIONS = ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'];

function scaleAbsolute(post) {
  const out = {};
  for (const k of Object.keys(post)) {
    out[k] = CDP_DURATIONS.indexOf(k) !== -1 ? r2(post[k] * 1000) : post[k];
  }
  return out;
}

// 导航类的 CDP 指标口径：
//   - 渲染进程被重建（计数器归零）时，导航后的累计值就是本次导航的真实值 → absolute
//   - 同一进程内连续导航时，取两次快照的差值 → delta
// 判断依据：Documents / ScriptDuration / TaskDuration 相比导航前变小，说明进程已重建。
function resolveCdp(pre, post) {
  if (!post) return { basis: 'unavailable（未取到 CDP 快照）', values: null, delta: null, pre: pre || null };
  if (!pre) return { basis: 'absolute（全新渲染进程，累计值即本次导航）', values: scaleAbsolute(post), delta: null, pre: null };
  const restarted = post.Documents < pre.Documents
    || (post.ScriptDuration || 0) <= (pre.ScriptDuration || 0)
    || (post.TaskDuration || 0) <= (pre.TaskDuration || 0);
  if (restarted) {
    return { basis: 'absolute（导航后渲染进程已重建，累计值即本次导航）', values: scaleAbsolute(post), delta: null, pre: pre };
  }
  const values = {};
  for (const k of Object.keys(post)) {
    const raw = post[k] - (pre[k] || 0);
    values[k] = raw < 0 ? null : (CDP_DURATIONS.indexOf(k) !== -1 ? r2(raw * 1000) : raw);
  }
  return { basis: 'delta（同进程累加值相减）', values: values, delta: values, pre: pre };
}

function snapshotHits(state) {
  return Object.assign({}, state.hits);
}

function diffHits(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    const d = after[k] - (before[k] || 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

const REQUIRED_CACHE = [
  PREFIX + '/index.html',
  PREFIX + '/css/style.css',
  PREFIX + '/js/app.js',
  PREFIX + '/js/data.js',
  PREFIX + '/vendor/marked.min.js',
  PREFIX + '/vendor/purify.min.js'
];

// 等 SW 可选资源预取收敛：
//   1) 服务端命中数连续 1.2s 不变（不再有新请求）
//   2) 整形代理的下行队列排空（已在途的字节不会污染后续测量）
// 只按命中数判断是不够的：慢速链路下预取的字节会在命中数稳定后继续占用带宽数秒。
async function waitPrefetchSettle(state, maxMs, proxy) {
  const t0 = Date.now();
  const total = () => Object.keys(state.hits).reduce((s, k) => s + state.hits[k], 0);
  let last = total();
  let lastChange = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 200));
    const now = total();
    if (now !== last) { last = now; lastChange = Date.now(); continue; }
    if (!proxy || proxy.queuedMs() < 50) {
      if (Date.now() - lastChange > 1200) return Date.now() - t0;
    }
  }
  return Date.now() - t0;
}

// 路由内的懒加载（如 highlight.min.js）与整形队列都必须收敛后再开始下一次导航，
// 否则会把上一段路由的异步加载时间算进下一次导航的 TTFB。
async function settleLink(page, deps, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    let ready = true;
    try {
      ready = await page.evaluate(() => {
        const hasCode = !!document.querySelector('#app pre code');
        return !hasCode || typeof hljs !== 'undefined';
      });
    } catch (e) { ready = true; }
    const queued = deps.proxy ? deps.proxy.queuedMs() : 0;
    if (ready && queued < 50) return Date.now() - t0;
    await page.waitForTimeout(150);
  }
  return Date.now() - t0;
}

async function warmUp(page, config, deps) {
  const t0 = Date.now();
  await page.goto(config.baseUrl + HOME, { waitUntil: 'load', timeout: 60000 });
  const ctl = await page.evaluate(waitControllerFn, 20000);
  const settleMs = await waitPrefetchSettle(deps.state, 30000, deps.proxy);
  const inv = await page.evaluate(cacheInventoryFn);
  const coreName = Object.keys(inv).find(n => n.indexOf('blog-') === 0 && n.indexOf('blog-rt-') !== 0) || null;
  const coreKeys = coreName ? inv[coreName] : [];
  const missing = REQUIRED_CACHE.filter(p => coreKeys.indexOf(p) === -1);
  return {
    controlled: ctl.controlled,
    active: ctl.active,
    controllerWaitMs: ctl.waitedMs,
    coreCacheName: coreName,
    coreEntryCount: coreKeys.length,
    runtimeCacheName: Object.keys(inv).find(n => n.indexOf('blog-rt-') === 0) || null,
    missingRequired: missing,
    warmVerified: !!(ctl.controlled && missing.length === 0),
    prefetchSettleMs: settleMs,
    warmUpMs: Date.now() - t0,
    cache: compactCache(inv)
  };
}

function compactCache(inv) {
  const out = {};
  for (const name of Object.keys(inv)) {
    const keys = inv[name];
    out[name] = { count: keys.length, sample: keys.slice(0, 12) };
  }
  return out;
}

function deriveMetrics(scenario, snap, delta) {
  const nav = snap.nav || {};
  const m = {
    ttfbMs: nav.ttfb == null ? null : nav.ttfb,
    dclMs: nav.dcl == null ? null : nav.dcl,
    loadMs: nav.load == null ? null : nav.load,
    fcpMs: snap.paints.fcp,
    lcpMs: snap.lcp.value,
    firstCardMs: snap.firstCardMs,
    cls: snap.cls.value,
    longTaskCount: snap.longTasks.count,
    longTaskMaxMs: snap.longTasks.maxMs,
    tbtMs: snap.longTasks.tbtMs,
    requestCount: snap.resources.length + (snap.nav ? 1 : 0),
    transferBytes: snap.resources.reduce((s, r) => s + (r.transfer || 0), 0) + (nav.transfer || 0),
    encodedBytes: snap.resources.reduce((s, r) => s + (r.encoded || 0), 0) + (nav.encoded || 0)
  };
  if (delta) {
    m.scriptMs = delta.ScriptDuration == null ? null : delta.ScriptDuration;
    m.taskMs = delta.TaskDuration == null ? null : delta.TaskDuration;
    m.layoutMs = delta.LayoutDuration == null ? null : delta.LayoutDuration;
  }
  return m;
}

// 采集一次「导航类」样本
async function captureNavSample(ctx) {
  const { page, cdp, config, deps, bag, scenario, rep } = ctx;
  const snap = await page.evaluate(pageSnapshotFn, { tbtTail: TBT_TAIL_MS });
  const sw = await page.evaluate(swStateFn).catch(() => null);
  const inv = sw && sw.controller ? await page.evaluate(cacheInventoryFn).catch(() => null) : null;
  const post = await cdpMetrics(cdp).catch(() => null);
  const resolved = resolveCdp(ctx.pre, post);
  const hits = diffHits(ctx.hitsBefore, snapshotHits(deps.state));
  const metrics = deriveMetrics(scenario, snap, resolved.values);
  metrics.serverRequestCount = Object.keys(hits).reduce((s, k) => s + hits[k], 0);
  if (deps.probe && ctx.probeMark != null) {
    const recs = deps.probe.since(ctx.probeMark);
    metrics.networkBytes = recs.reduce((s, r) => s + r.bytes, 0);
    metrics.networkRequests = recs.length;
    // 后台校验/回填"最后一份响应结束"的时刻（相对导航开始）：用于区分"快是因为没下东西"与"快是因为并行"
    const ends = recs.map(r => r.end).filter(v => typeof v === 'number');
    metrics.networkLastEndMs = ends.length ? Math.max.apply(null, ends) - ctx.probeMark : null;
    // 只看首屏相关请求（外壳 + 5 个首屏资源）：这才是"本次文档的后台校验/回填完成时间"
    const fsRe = /(index\.html|style\.css|app\.js|data\.js|user-posts\.js|projects\.js)$/;
    const fsEnds = recs.filter(r => fsRe.test(r.path) && typeof r.end === 'number').map(r => r.end);
    metrics.firstScreenNetEndMs = fsEnds.length ? Math.max.apply(null, fsEnds) - ctx.probeMark : null;
  }
  if (inv) {
    metrics.swCacheEntries = Object.keys(inv).reduce((s, n) => s + inv[n].length, 0);
  }
  return {
    rep,
    scenario,
    config: config.id,
    startedAt: ctx.startedAt,
    ok: true,
    error: null,
    metrics,
    cdp: {
      basis: resolved.basis,
      raw: post,
      pre: resolved.pre,
      values: resolved.values
    },
    navigation: snap.nav,
    paints: snap.paints,
    lcp: snap.lcp,
    cls: snap.cls,
    longTasks: { count: snap.longTasks.count, maxMs: snap.longTasks.maxMs, tbtMs: snap.longTasks.tbtMs, all: snap.longTasks.all.slice(0, 20) },
    dom: snap.dom,
    sw: {
      controllerAtLoad: snap.sw.controllerAtLoad,
      cacheNamesAtLoad: snap.sw.cacheNamesAtLoad,
      controller: sw ? sw.controller : null,
      active: sw ? sw.active : null,
      scriptURL: sw ? sw.scriptURL : null,
      observerErrors: snap.sw.observerErrors
    },
    cache: inv ? compactCache(inv) : null,
    serverHits: hits,
    resources: snap.resources,
    title: snap.title,
    giscusBlock: bag.giscusBlock || null,
    errors: bag.errors.slice(0, 20)
  };
}

function failedSample(scenario, config, rep, err, bag) {
  return {
    rep,
    scenario,
    config: config.id,
    ok: false,
    error: String(err && err.message ? err.message : err).split('\n')[0].slice(0, 300),
    errors: bag && bag.errors ? bag.errors.slice(0, 20) : []
  };
}

// ---------------------------------------------------------------- 场景执行
async function runColdHome(config, deps, opt) {
  const samples = [];
  for (let rep = 1; rep <= opt.repeat; rep++) {
    const bag = { errors: [] };
    const startedAt = new Date().toISOString();
    const ctx = await newContextFor(deps.browser, config, deps);
    let sample;
    try {
      const page = await ctx.newPage();
      attachDiagnostics(page, bag);
      const cdp = await attachCDP(page, config, bag);
      const hitsBefore = snapshotHits(deps.state);
      const probeMark = deps.probe ? deps.probe.mark() : null;
      // 冷启动：全新 BrowserContext（无 HTTP 缓存、无 SW、无 CacheStorage）
      await page.goto(config.baseUrl + HOME, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(SETTLE_MS);
      sample = await captureNavSample({
        page, cdp, config, deps, bag, scenario: 'cold-home', rep,
        pre: null, hitsBefore, startedAt, probeMark
      });
      sample.extra = { freshContext: true, httpCache: '空（新 BrowserContext + 服务端 Cache-Control: no-store）' };
    } catch (e) {
      sample = failedSample('cold-home', config, rep, e, bag);
    }
    samples.push(sample);
    await ctx.close();
    if (!opt.quiet) console.log('    cold-home/' + config.id + ' rep ' + rep + '/' + opt.repeat + (sample.ok ? ' ok' : ' FAIL: ' + sample.error));
  }
  return { samples, cacheState: { mode: 'cold', serviceWorker: '首次注册（本页面加载期间未受 SW 控制）', browserCache: '空' } };
}

async function runWarmHome(config, deps, opt) {
  const samples = [];
  let cacheState = null;
  for (let rep = 1; rep <= opt.repeat; rep++) {
    const bag = { errors: [] };
    const startedAt = new Date().toISOString();
    const ctx = await newContextFor(deps.browser, config, deps);
    let sample;
    try {
      const page = await ctx.newPage();
      attachDiagnostics(page, bag);
      const cdp = await attachCDP(page, config, bag);
      // 预热：首页加载 + 等 SW 接管 + 等可选资源预取收敛
      const warm = await warmUp(page, config, deps);
      if (!cacheState) cacheState = warm;
      const hitsBefore = snapshotHits(deps.state);
      const pre = await cdpMetrics(cdp);
      const probeMark = deps.probe ? deps.probe.mark() : null;
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(SETTLE_MS);
      sample = await captureNavSample({
        page, cdp, config, deps, bag, scenario: 'warm-home', rep, pre, hitsBefore, startedAt, probeMark
      });
      sample.extra = {
        warmVerified: warm.warmVerified,
        warmUpMs: warm.warmUpMs,
        warmUpControllerWaitMs: warm.controllerWaitMs,
        prefetchSettleMs: warm.prefetchSettleMs,
        missingRequiredInCache: warm.missingRequired,
        reload: true
      };
    } catch (e) {
      sample = failedSample('warm-home', config, rep, e, bag);
    }
    samples.push(sample);
    await ctx.close();
    if (!opt.quiet) console.log('    warm-home/' + config.id + ' rep ' + rep + '/' + opt.repeat + (sample.ok ? ' ok warm=' + (sample.extra && sample.extra.warmVerified) : ' FAIL: ' + sample.error));
  }
  return {
    samples,
    cacheState: cacheState ? {
      mode: 'warm',
      serviceWorker: '已注册并接管（每次重复均使用全新 BrowserContext 重新预热）',
      warmVerified: cacheState.warmVerified,
      coreCacheName: cacheState.coreCacheName,
      coreEntryCount: cacheState.coreEntryCount,
      runtimeCacheName: cacheState.runtimeCacheName,
      missingRequired: cacheState.missingRequired,
      cache: cacheState.cache
    } : null
  };
}

async function runLongPost(config, deps, opt) {
  const samples = [];
  let cacheState = null;
  const postId = opt.post.id;
  const postUrl = config.baseUrl + PREFIX + '/#/post/' + postId;
  for (let rep = 1; rep <= opt.repeat; rep++) {
    const bag = { errors: [] };
    const startedAt = new Date().toISOString();
    const ctx = await newContextFor(deps.browser, config, deps);
    let sample;
    try {
      const page = await ctx.newPage();
      attachDiagnostics(page, bag);
      const cdp = await attachCDP(page, config, bag);
      const warm = await warmUp(page, config, deps);
      if (!cacheState) cacheState = warm;

      // 切到文章路由后整页重载：既保留暖缓存，又是真实的文档级加载（非 SPA 切换）
      await page.evaluate((h) => { location.hash = h; }, '#/post/' + postId);
      const routeSettleMs = await settleLink(page, deps, 6000);
      const hitsBefore = snapshotHits(deps.state);
      const pre = await cdpMetrics(cdp);
      const probeMark = deps.probe ? deps.probe.mark() : null;
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(SETTLE_MS);
      sample = await captureNavSample({
        page, cdp, config, deps, bag, scenario: 'long-post', rep, pre, hitsBefore, startedAt, probeMark
      });
      sample.extra = {
        postId,
        url: postUrl,
        warmVerified: warm.warmVerified,
        routeSettleMs,
        loadType: '文档级重载（暖 SW 缓存）'
      };

      // SPA 路由切换：首页 → 文章，文章 → 首页
      await page.evaluate((h) => { location.hash = h; }, '#/');
      await page.waitForTimeout(400);
      const preSwitch = await cdpMetrics(cdp);
      const homeToPost = await page.evaluate(routeSwitchFn, '#/post/' + postId);
      const postSwitch = await cdpMetrics(cdp);
      await page.waitForTimeout(600);
      const preBack = await cdpMetrics(cdp);
      const postToHome = await page.evaluate(routeSwitchFn, '#/');
      const postBack = await cdpMetrics(cdp);

      const switchCdp = resolveCdp(preSwitch, postSwitch);
      const backCdp = resolveCdp(preBack, postBack);
      sample.metrics.routeRenderMs = homeToPost.renderMs;
      sample.metrics.routePaintMs = homeToPost.paintMs;
      sample.metrics.routeBackRenderMs = postToHome.renderMs;
      sample.metrics.routeScriptMs = switchCdp.values ? switchCdp.values.ScriptDuration : null;
      sample.metrics.routeBackScriptMs = backCdp.values ? backCdp.values.ScriptDuration : null;
      sample.extra.routeSwitch = { homeToPost, postToHome };
    } catch (e) {
      sample = failedSample('long-post', config, rep, e, bag);
    }
    samples.push(sample);
    await ctx.close();
    if (!opt.quiet) console.log('    long-post/' + config.id + ' rep ' + rep + '/' + opt.repeat + (sample.ok ? ' ok' : ' FAIL: ' + sample.error));
  }
  return {
    samples,
    cacheState: cacheState ? {
      mode: 'warm',
      serviceWorker: '已注册并接管（预热后再整页重载文章页）',
      warmVerified: cacheState.warmVerified,
      coreCacheName: cacheState.coreCacheName,
      coreEntryCount: cacheState.coreEntryCount,
      missingRequired: cacheState.missingRequired
    } : null
  };
}

// Batch 6B-2：文章正文按需加载（首次打开 / 重复打开 / 离线重开）
async function runPostLazy(config, deps, opt) {
  const samples = [];
  let cacheState = null;
  const postId = opt.post.id;
  for (let rep = 1; rep <= opt.repeat; rep++) {
    const bag = { errors: [] };
    const startedAt = new Date().toISOString();
    const ctx = await newContextFor(deps.browser, config, deps);
    let sample;
    try {
      const page = await ctx.newPage();
      attachDiagnostics(page, bag);
      const cdp = await attachCDP(page, config, bag);
      const warm = await warmUp(page, config, deps);
      if (!cacheState) cacheState = warm;

      // 1) 首次打开：首页 → 文章（正文按需请求）
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForTimeout(300);
      const hitsBefore = snapshotHits(deps.state);
      const pre = await cdpMetrics(cdp);
      const probeMark = deps.probe ? deps.probe.mark() : null;
      const first = await page.evaluate(openPostFn, { id: postId });
      const mid = await cdpMetrics(cdp);
      const hitsFirst = diffHits(hitsBefore, snapshotHits(deps.state));

      // 2) 回首页再打开同一篇（正文已在内存 / 缓存里）
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForTimeout(400);
      const pre2 = await cdpMetrics(cdp);
      const repeat = await page.evaluate(openPostFn, { id: postId });
      const post2 = await cdpMetrics(cdp);

      // 3) 离线重开已缓存文章（文档级重载，正文必须来自缓存）
      await ctx.setOffline(true);
      const t0 = Date.now();
      let offlineLoad = null;
      try {
        const resp = await page.goto(config.baseUrl + PREFIX + '/#/post/' + postId, { waitUntil: 'load', timeout: 30000 });
        offlineLoad = resp ? resp.status() : 0;
      } catch (e) { offlineLoad = -1; }
      const offlineReadable = await page.waitForFunction(() => {
        const b = document.querySelector('#app .article-detail-body');
        return !!b && b.textContent.trim().length > 200;
      }, null, { timeout: 30000 }).then(() => true).catch(() => false);
      const offlineMs = Date.now() - t0;
      await ctx.setOffline(false);

      const bodyBytes = (deps.probe && probeMark != null)
        ? deps.probe.since(probeMark).filter(r => r.path.indexOf('/data/posts/') !== -1).reduce((s, r) => s + r.bytes, 0)
        : null;
      const d1 = resolveCdp(pre, mid).values;
      const d2 = resolveCdp(pre2, post2).values;

      sample = {
        rep,
        scenario: 'post-lazy',
        config: config.id,
        startedAt,
        ok: !!(first.ok && repeat.ok),
        error: first.error || repeat.error || null,
        metrics: {
          postFirstReadableMs: first.readableMs,
          postFirstPaintMs: first.paintMs,
          postFirstChars: first.chars,
          postRepeatReadableMs: repeat.readableMs,
          postRepeatPaintMs: repeat.paintMs,
          postBodyBytes: bodyBytes,
          postFirstScriptMs: d1 ? d1.ScriptDuration : null,
          postRepeatScriptMs: d2 ? d2.ScriptDuration : null,
          postServerRequests: Object.keys(hitsFirst).reduce((s, k) => s + hitsFirst[k], 0),
          offlinePostStatus: offlineLoad,
          offlinePostReadable: offlineReadable,
          offlinePostReadableMs: offlineMs
        },
        sw: { controller: true },
        serverHits: hitsFirst,
        post: { first, repeat },
        extra: { warmVerified: warm.warmVerified, postId, offlineReadable: offlineReadable },
        errors: bag.errors.slice(0, 20)
      };
    } catch (e) {
      sample = failedSample('post-lazy', config, rep, e, bag);
    }
    samples.push(sample);
    await ctx.close();
    if (!opt.quiet) {
      console.log('    post-lazy/' + config.id + ' rep ' + rep + '/' + opt.repeat + (sample.ok
        ? ' ok first=' + sample.metrics.postFirstReadableMs + 'ms repeat=' + sample.metrics.postRepeatReadableMs + 'ms offline=' + sample.metrics.offlinePostReadableMs + 'ms'
        : ' FAIL: ' + sample.error));
    }
  }
  return {
    samples,
    cacheState: cacheState ? {
      mode: 'warm',
      serviceWorker: '已注册并接管（预热后从首页点进文章）',
      warmVerified: cacheState.warmVerified,
      coreCacheName: cacheState.coreCacheName,
      coreEntryCount: cacheState.coreEntryCount,
      missingRequired: cacheState.missingRequired
    } : null
  };
}

async function runSearch(config, deps, opt) {
  const samples = [];
  let cacheState = null;
  for (let rep = 1; rep <= opt.repeat; rep++) {
    const bag = { errors: [] };
    const startedAt = new Date().toISOString();
    const ctx = await newContextFor(deps.browser, config, deps);
    let sample;
    try {
      const page = await ctx.newPage();
      attachDiagnostics(page, bag);
      const cdp = await attachCDP(page, config, bag);
      const warm = await warmUp(page, config, deps);
      if (!cacheState) cacheState = warm;
      const hitsBefore = snapshotHits(deps.state);
      const pre = await cdpMetrics(cdp);
      const probeMark = deps.probe ? deps.probe.mark() : null;

      const first = await page.evaluate(searchFn, { keyword: opt.keyword, expectLazy: true, thinkMs: opt.searchThink });
      const mid = await cdpMetrics(cdp);
      const repeat = await page.evaluate(searchFn, { keyword: opt.keyword2, expectLazy: false });
      const post = await cdpMetrics(cdp);
      const hits = diffHits(hitsBefore, snapshotHits(deps.state));
      const probeRecs = deps.probe && probeMark != null ? deps.probe.since(probeMark) : null;

      const dFirst = resolveCdp(pre, mid).values;
      const dAll = resolveCdp(pre, post).values;
      sample = {
        rep,
        scenario: 'search',
        config: config.id,
        startedAt,
        ok: !first.error && !repeat.error,
        error: first.error || repeat.error || null,
        metrics: {
          searchFirstRenderMs: first.firstRenderMs,
          searchFirstFinalMs: first.finalRenderMs,
          searchFirstRenderCount: first.renderCount,
          searchLazyBytes: first.lazyBytes,
          searchFirstLongTaskMs: first.longTaskMs,
          searchFirstScriptMs: dFirst ? dFirst.ScriptDuration : null,
          searchRepeatRenderMs: repeat.firstRenderMs,
          searchRepeatFinalMs: repeat.finalRenderMs,
          searchRepeatRenderCount: repeat.renderCount,
          searchRepeatLongTaskMs: repeat.longTaskMs,
          searchRepeatScriptMs: dAll && dFirst && dAll.ScriptDuration != null && dFirst.ScriptDuration != null
            ? r2(dAll.ScriptDuration - dFirst.ScriptDuration) : null,
          serverRequestCount: Object.keys(hits).reduce((s, k) => s + hits[k], 0),
          networkBytes: probeRecs ? probeRecs.reduce((s, r) => s + r.bytes, 0) : null
        },
        sw: { controller: true },
        cache: null,
        serverHits: hits,
        search: { first, repeat },
        extra: { warmVerified: warm.warmVerified, keywords: [opt.keyword, opt.keyword2], debounceMs: 180 },
        errors: bag.errors.slice(0, 20)
      };
    } catch (e) {
      sample = failedSample('search', config, rep, e, bag);
    }
    samples.push(sample);
    await ctx.close();
    if (!opt.quiet) console.log('    search/' + config.id + ' rep ' + rep + '/' + opt.repeat + (sample.ok ? ' ok' : ' FAIL: ' + sample.error));
  }
  return {
    samples,
    cacheState: cacheState ? {
      mode: 'warm',
      serviceWorker: '已注册并接管（首页预热后再输入关键词）',
      warmVerified: cacheState.warmVerified,
      coreCacheName: cacheState.coreCacheName,
      coreEntryCount: cacheState.coreEntryCount,
      missingRequired: cacheState.missingRequired
    } : null
  };
}

const RUNNERS = {
  'cold-home': runColdHome,
  'warm-home': runWarmHome,
  'long-post': runLongPost,
  'post-lazy': runPostLazy,
  'search': runSearch
};

const SCENARIO_META = {
  'cold-home': {
    label: 'A. 首页冷启动',
    description: '全新 BrowserContext 首次打开首页：HTTP 缓存为空、无 Service Worker 控制；测量到 load +2.5s。',
    url: HOME
  },
  'warm-home': {
    label: 'B. 首页热启动',
    description: '新 BrowserContext 内先完成 SW 安装与缓存预热（校验 CORE 必需资源齐全、预取已收敛），再整页 reload 测量。',
    url: HOME
  },
  'long-post': {
    label: 'C. 长文文章页 + SPA 路由切换',
    description: '预热后整页重载最长的一篇文章（Markdown + DOMPurify 渲染），并测量首页↔文章的 SPA 路由切换耗时。',
    url: '#/post/<id>'
  },
  'post-lazy': {
    label: 'E. 文章正文按需加载',
    description: '预热后从首页点进最长的一篇文章：首次打开触发正文请求，重复打开复用内存/缓存，最后离线重开同一篇。',
    url: '#/post/<id>'
  },
  'search': {
    label: 'D. 全局搜索首次/重复输入',
    description: '预热后输入固定关键词：首次输入会触发 courses/papers/notes 懒加载（6B-2 起还包括正文搜索语料），重复输入复用已加载数据。',
    url: HOME + ' + #searchInput'
  }
};

// ---------------------------------------------------------------- 汇总与输出
const METRIC_META = {
  ttfbMs: { label: 'TTFB', unit: 'ms', basis: 'measured' },
  fcpMs: { label: 'FCP', unit: 'ms', basis: 'measured' },
  lcpMs: { label: 'LCP', unit: 'ms', basis: 'measured' },
  firstCardMs: { label: '首张文章卡片可见（首页内容可见时间）', unit: 'ms', basis: 'measured' },
  cls: { label: 'CLS（session window 最大值）', unit: 'score', basis: 'measured' },
  dclMs: { label: 'DOMContentLoaded', unit: 'ms', basis: 'measured' },
  loadMs: { label: '页面加载完成 loadEventEnd', unit: 'ms', basis: 'measured' },
  scriptMs: { label: 'JS 执行时间（CDP ScriptDuration，主线程）', unit: 'ms', basis: 'measured' },
  taskMs: { label: '主线程任务总时长（CDP TaskDuration）', unit: 'ms', basis: 'measured' },
  layoutMs: { label: '布局耗时（CDP LayoutDuration）', unit: 'ms', basis: 'measured' },
  longTaskCount: { label: '长任务数量（>50ms）', unit: 'count', basis: 'measured' },
  longTaskMaxMs: { label: '最长长任务', unit: 'ms', basis: 'measured' },
  tbtMs: { label: 'TBT 近似（长任务阻塞时间，窗口=导航开始→load+2s）', unit: 'ms', basis: 'calculated' },
  requestCount: { label: '请求数量（Resource Timing）', unit: 'count', basis: 'measured' },
  transferBytes: { label: '资源传输字节（transferSize 合计）', unit: 'bytes', basis: 'measured' },
  encodedBytes: { label: '编码后体积（encodedBodySize 合计）', unit: 'bytes', basis: 'measured' },
  serverRequestCount: { label: '真实到达服务器的请求数（服务端计数）', unit: 'count', basis: 'measured' },
  networkBytes: { label: '导航窗口内网络传输字节（HTTP 层，含 SW 后台预取/后台校验）', unit: 'bytes', basis: 'measured' },
  networkRequests: { label: '导航窗口内到达服务器的请求数（HTTP 层）', unit: 'count', basis: 'measured' },
  swCacheEntries: { label: 'SW 缓存条目总数', unit: 'count', basis: 'measured' },
  routeRenderMs: { label: '路由切换：DOM 更新完成（首页→文章）', unit: 'ms', basis: 'measured' },
  routePaintMs: { label: '路由切换：渲染完成（首页→文章，双 rAF）', unit: 'ms', basis: 'measured' },
  routeBackRenderMs: { label: '路由切换：DOM 更新完成（文章→首页）', unit: 'ms', basis: 'measured' },
  routeScriptMs: { label: '路由切换 JS 执行（首页→文章）', unit: 'ms', basis: 'measured' },
  routeBackScriptMs: { label: '路由切换 JS 执行（文章→首页）', unit: 'ms', basis: 'measured' },
  searchFirstRenderMs: { label: '搜索首次输入：首个结果渲染（含 180ms 防抖）', unit: 'ms', basis: 'measured' },
  searchFirstFinalMs: { label: '搜索首次输入：懒加载补齐后最终渲染', unit: 'ms', basis: 'measured' },
  searchFirstRenderCount: { label: '搜索首次输入：DOM 重绘次数', unit: 'count', basis: 'measured' },
  searchLazyBytes: { label: '搜索首次输入：新增下载字节', unit: 'bytes', basis: 'measured' },
  searchFirstLongTaskMs: { label: '搜索首次输入：长任务阻塞时间', unit: 'ms', basis: 'calculated' },
  searchFirstScriptMs: { label: '搜索首次输入：JS 执行时间', unit: 'ms', basis: 'measured' },
  searchRepeatRenderMs: { label: '搜索重复输入：结果渲染（含 180ms 防抖）', unit: 'ms', basis: 'measured' },
  searchRepeatFinalMs: { label: '搜索重复输入：最终渲染稳定时间', unit: 'ms', basis: 'measured' },
  searchRepeatRenderCount: { label: '搜索重复输入：DOM 重绘次数', unit: 'count', basis: 'measured' },
  searchRepeatLongTaskMs: { label: '搜索重复输入：长任务阻塞时间', unit: 'ms', basis: 'calculated' },
  searchRepeatScriptMs: { label: '搜索重复输入：JS 执行时间', unit: 'ms', basis: 'measured' },
  postFirstReadableMs: { label: '首次打开文章：正文可读时间（SPA 切换起算）', unit: 'ms', basis: 'measured' },
  postFirstPaintMs: { label: '首次打开文章：正文绘制完成（双 rAF）', unit: 'ms', basis: 'measured' },
  postFirstChars: { label: '首次打开文章：正文可见字符数', unit: 'count', basis: 'measured' },
  postRepeatReadableMs: { label: '重复打开文章：正文可读时间', unit: 'ms', basis: 'measured' },
  postRepeatPaintMs: { label: '重复打开文章：正文绘制完成（双 rAF）', unit: 'ms', basis: 'measured' },
  postBodyBytes: { label: '首次打开文章：正文传输字节（data/posts/*.md）', unit: 'bytes', basis: 'measured' },
  postFirstScriptMs: { label: '首次打开文章：JS 执行时间', unit: 'ms', basis: 'measured' },
  postRepeatScriptMs: { label: '重复打开文章：JS 执行时间', unit: 'ms', basis: 'measured' },
  postServerRequests: { label: '首次打开文章：服务端请求数', unit: 'count', basis: 'measured' },
  offlinePostStatus: { label: '离线重开文章：文档状态码', unit: 'count', basis: 'measured' },
  offlinePostReadable: { label: '离线重开文章：正文是否可读', unit: 'bool', basis: 'measured' },
  offlinePostReadableMs: { label: '离线重开文章：正文可读时间', unit: 'ms', basis: 'measured' }
};

function summarize(samples) {
  const ok = samples.filter(s => s.ok && s.metrics);
  const keys = new Set();
  ok.forEach(s => Object.keys(s.metrics).forEach(k => keys.add(k)));
  const out = {};
  for (const k of [...keys].sort()) {
    const values = ok.map(s => s.metrics[k]);
    const st = statsOf(values);
    const meta = METRIC_META[k] || { label: k, unit: '', basis: 'measured' };
    out[k] = Object.assign({ label: meta.label, unit: meta.unit, basis: meta.basis }, st, {
      unavailable: st.n === 0
    });
  }
  return out;
}

const UNAVAILABLE_REASONS = {
  lcpMs: '浏览器未上报 LCP 候选（观察窗口内没有更大元素进入视口）',
  swCacheEntries: '采样时页面尚未被 SW 接管（冷启动期间 CacheStorage 安装仍在进行），无可读缓存条目',
  scriptMs: 'CDP Performance.getMetrics 在该渲染进程未取到可用增量',
  taskMs: 'CDP Performance.getMetrics 在该渲染进程未取到可用增量',
  layoutMs: 'CDP Performance.getMetrics 在该渲染进程未取到可用增量'
};

// 同一场景下，某个配置没有产出的指标也要显式登记为 UNAVAILABLE（不能静默消失或填 0）
function collectAllUnavailable(baseline) {
  const out = [];
  for (const scn of Object.keys(baseline.scenarios)) {
    const block = baseline.scenarios[scn];
    const configIds = Object.keys(block);
    const union = new Set();
    configIds.forEach(c => Object.keys(block[c].summary).forEach(k => union.add(k)));
    configIds.forEach(c => {
      for (const k of union) {
        if (block[c].summary[k]) continue;
        const meta = METRIC_META[k] || { label: k, unit: '', basis: 'measured' };
        block[c].summary[k] = {
          label: meta.label, unit: meta.unit, basis: meta.basis,
          n: 0, median: null, min: null, max: null, spread: null, spreadPct: null, stdev: null,
          unavailable: true, missing: true
        };
      }
    });
    configIds.forEach(c => {
      for (const k of Object.keys(block[c].summary)) {
        const s = block[c].summary[k];
        if (!s.unavailable) continue;
        out.push({
          scenario: scn,
          config: c,
          metric: k,
          label: s.label,
          reason: UNAVAILABLE_REASONS[k] || '该配置下所有样本均为 null（采集不可靠或事件未发生）'
        });
      }
    });
  }
  return out;
}

function calibration(baseline) {
  const get = (scn, cfg) => {
    const s = baseline.scenarios[scn] && baseline.scenarios[scn][cfg];
    if (!s) return null;
    const data = s.samples.find(x => x.ok && x.resources && x.resources.some(r => /js\/data\.js$/.test(r.url)));
    if (!data) return null;
    const entry = data.resources.find(r => /js\/data\.js$/.test(r.url));
    return { durMs: entry.dur, encoded: entry.encoded, scriptMs: data.metrics.scriptMs, loadMs: data.metrics.loadMs };
  };
  const d = get('cold-home', 'desktop');
  const m = get('cold-home', 'mobile');
  const expectedDataJsMs = Math.round((114583 / ((1638.4 * 1024) / 8)) * 1000);
  const out = {
    note: '用于判断限速/CPU 限速是否真的生效：对比同一次冷启动中 js/data.js 的传输耗时与 ScriptDuration',
    desktop: d,
    mobile: m,
    expected: { dataJsBytes: 114583, dataJsTransferMsAt1638kbps: expectedDataJsMs },
    networkShaping: {
      effective: !!(m && d && m.durMs > Math.max(300, d.durMs * 5)),
      basis: 'inferred（移动端 data.js 传输耗时 ≥ max(300ms, 桌面端 5 倍) 视为整形生效）'
    },
    cpuThrottling: {
      ratio: m && d && d.scriptMs ? r2(m.scriptMs / d.scriptMs) : null,
      effective: !!(m && d && d.scriptMs && m.scriptMs / d.scriptMs >= 2),
      basis: 'inferred（移动端 ScriptDuration / 桌面端 ScriptDuration ≥ 2 视为 4x CPU 限速生效）'
    }
  };
  return out;
}

function printSummary(baseline) {
  const keysByScenario = {
    'cold-home': ['fcpMs', 'lcpMs', 'firstCardMs', 'cls', 'loadMs', 'scriptMs', 'tbtMs', 'requestCount', 'encodedBytes', 'serverRequestCount'],
    'warm-home': ['fcpMs', 'lcpMs', 'cls', 'loadMs', 'scriptMs', 'tbtMs', 'requestCount', 'encodedBytes', 'serverRequestCount', 'networkBytes', 'swCacheEntries'],
    'long-post': ['fcpMs', 'lcpMs', 'loadMs', 'scriptMs', 'tbtMs', 'encodedBytes', 'routeRenderMs', 'routePaintMs', 'routeBackRenderMs'],
    'post-lazy': ['postFirstReadableMs', 'postFirstPaintMs', 'postBodyBytes', 'postServerRequests', 'postFirstScriptMs', 'postRepeatReadableMs', 'offlinePostReadableMs'],
    'search': ['searchFirstRenderMs', 'searchFirstFinalMs', 'searchLazyBytes', 'searchRepeatRenderMs', 'searchRepeatScriptMs']
  };
  console.log('\n===== 中位数（最小值 ~ 最大值） =====');
  for (const scn of Object.keys(baseline.scenarios)) {
    console.log('\n[' + scn + '] ' + SCENARIO_META[scn].label);
    for (const cfg of Object.keys(baseline.scenarios[scn])) {
      const s = baseline.scenarios[scn][cfg];
      const okCount = s.samples.filter(x => x.ok).length;
      console.log('  ' + cfg + '（有效 ' + okCount + '/' + s.samples.length + '）');
      for (const k of keysByScenario[scn] || []) {
        const m = s.summary[k];
        if (!m) continue;
        if (m.unavailable) { console.log('    ' + (METRIC_META[k] ? METRIC_META[k].label : k) + ': UNAVAILABLE'); continue; }
        console.log('    ' + (METRIC_META[k] ? METRIC_META[k].label : k) + ': '
          + m.median + '（' + m.min + ' ~ ' + m.max + '，波动 ' + m.spreadPct + '%）');
      }
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message + '\n\n' + USAGE);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }

  const t0 = Date.now();
  const autoPost = longestPostId();
  const post = args.post
    ? { id: args.post, title: '(手动指定)', contentChars: null, totalPosts: autoPost.totalPosts }
    : autoPost;

  const configs = buildConfigs(args);
  const selected = args.configs.map(c => configs[c]);

  // 固定测试服务器（复用 B4 的 sw.spec.js 静态服务器，不做任何修改）
  const { server, state } = createServer(ROOT, PREFIX);
  let staticPort;
  try {
    staticPort = await listen(server, args.port);
  } catch (e) {
    console.error('无法在端口 ' + args.port + ' 启动静态服务器: ' + e.message);
    return 2;
  }

  // Batch 6B：可选——把 /blog/sw.js 换成交付的候选脚本，并逐请求记账
  // 未指定时完全不启用，6A 的测量路径（直连 / 直连+整形）保持原样
  let swCandidate = null;
  let probe = null;
  let probePort = null;
  if (args.swConfig || args.swFile) {
    swCandidate = buildSwCandidate(args.swConfig, args.swFile);
    probe = createProbe({
      targetPort: staticPort,
      overrides: { [PREFIX + '/sw.js']: { body: swCandidate.source } }
    });
    try {
      probePort = await listenProbe(probe.server, args.probePort);
    } catch (e) {
      console.error('无法在端口 ' + args.probePort + ' 启动观测探针: ' + e.message);
      server.close();
      return 2;
    }
  }
  const upstreamPort = probePort || staticPort;

  // 移动端整形代理
  const shapingProxy = createShapingProxy({
    targetPort: upstreamPort,
    latencyMs: configs.mobile.network.latencyMs,
    downloadKbps: configs.mobile.network.downloadKbps
  });
  let proxyPort;
  try {
    proxyPort = await listenProxy(shapingProxy.server, args.proxyPort);
  } catch (e) {
    console.error('无法在端口 ' + args.proxyPort + ' 启动整形代理: ' + e.message);
    server.close();
    if (probe) probe.server.close();
    return 2;
  }

  for (const c of selected) {
    c.baseUrl = 'http://127.0.0.1:' + (c.useProxy ? proxyPort : upstreamPort);
    c.serverEndpoint = c.useProxy
      ? { via: 'HTTP 整形代理', port: proxyPort, upstreamPort: upstreamPort }
      : { via: probe ? '直连（经观测探针）' : '直连', port: upstreamPort };
  }

  let browser;
  try {
    browser = await launchBrowser(args.channel);
  } catch (e) {
    console.error('无法启动浏览器（' + args.channel + '）: ' + String(e.message).split('\n')[0]);
    console.error('提示：本地使用系统 Chrome（默认），或在 CI 中 npx playwright install chromium 后使用 --channel chromium');
    server.close();
    shapingProxy.server.close();
    return 2;
  }

  const hostInfo = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuModel: (os.cpus()[0] || {}).model || null,
    cpuCores: os.cpus().length,
    totalMemGB: r2(os.totalmem() / 1073741824),
    nodeVersion: process.version
  };

  console.log('== 环境 ==');
  console.log('  浏览器: ' + args.channel + ' ' + browser.version());
  console.log('  静态服务器: 127.0.0.1:' + staticPort + PREFIX + '/（tests/browser/helpers/server.js，未修改）');
  console.log('  整形代理: 127.0.0.1:' + proxyPort + '（下行 ' + configs.mobile.network.downloadKbps + ' kbps，首字节延迟 ' + configs.mobile.network.latencyMs + 'ms）');
  console.log('  主机: ' + hostInfo.cpuModel + ' / ' + hostInfo.cpuCores + ' 线程 / ' + hostInfo.totalMemGB + ' GB / ' + hostInfo.platform + ' ' + hostInfo.release);
  console.log('  长文场景文章: ' + post.id + '（' + (post.contentChars || '?') + ' 字符）');
  console.log('  搜索关键词: 首次「' + args.keyword + '」/ 重复「' + args.keyword2 + '」');
  console.log('  重复次数: ' + args.repeat + ' / 场景 / 配置');

  const deps = { browser, state, staticPort, proxyPort, probePort, proxy: shapingProxy, probe };
  const baseline = {
    meta: {
      batch: '6A',
      generator: 'tests/perf/perf.spec.js',
      generatedAt: new Date().toISOString(),
      durationSec: null,
      git: gitMeta(),
      resources: [fileMeta('index.html'), fileMeta('js/data.js'), fileMeta('js/app.js'), fileMeta('css/style.css'),
        fileMeta('vendor/marked.min.js'), fileMeta('vendor/purify.min.js'), fileMeta('sw.js')].filter(Boolean),
      sw: swMeta(),
      swCandidate: swCandidate ? {
        injected: true,
        sourcePath: swCandidate.sourcePath,
        config: swCandidate.config,
        bytes: swCandidate.bytes,
        sha256: swCandidate.sha256,
        note: '仓库 sw.js 未被修改：候选脚本只在测量链路的观测探针里替换 /blog/sw.js 的响应'
      } : { injected: false, note: '测量的是仓库当前 sw.js' },
      networkProbe: probe ? { enabled: true, port: probePort, metrics: 'networkBytes = 导航窗口内所有 HTTP 响应体字节（含 SW 后台预取/后台校验）' } : { enabled: false },
      browser: { channel: args.channel, version: browser.version(), headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] },
      host: hostInfo,
      server: {
        staticServer: 'tests/browser/helpers/server.js（未修改）',
        prefix: PREFIX,
        cacheControl: 'no-store（继承 B4 测试服务器行为，HTTP 缓存因此在桌面场景中不参与）',
        staticPort,
        shapingProxyPort: proxyPort,
        shapingProxy: { latencyMs: configs.mobile.network.latencyMs, downloadKbps: configs.mobile.network.downloadKbps }
      },
      controls: {
        settleMs: SETTLE_MS,
        tbtTailMs: TBT_TAIL_MS,
        searchStableMs: SEARCH_STABLE_MS,
        thirdPartyBlocked: THIRD_PARTY_BLOCK,
        thirdPartyReason: 'giscus 评论组件为跨域第三方资源，会引入不可复现的网络波动，测量中被 CDP 屏蔽',
        repetitions: args.repeat
      },
      metricMeta: METRIC_META,
      scenarioMeta: SCENARIO_META,
      post,
      keywords: { first: args.keyword, second: args.keyword2 },
      configs: {}
    },
    scenarios: {},
    unavailable: [],
    failures: []
  };

  for (const c of selected) {
    baseline.meta.configs[c.id] = {
      label: c.label,
      conditions: c.conditions,
      cpuThrottle: c.cpuThrottle,
      network: c.network,
      serverEndpoint: c.serverEndpoint,
      contextOptions: {
        viewport: c.contextOptions.viewport,
        deviceScaleFactor: c.contextOptions.deviceScaleFactor,
        isMobile: !!c.contextOptions.isMobile,
        hasTouch: !!c.contextOptions.hasTouch,
        userAgent: c.contextOptions.userAgent || null
      }
    };
  }

  try {
    for (const scn of args.scenarios) {
      baseline.scenarios[scn] = {};
      for (const cfg of selected) {
        console.log('\n-- ' + scn + ' / ' + cfg.id + ' --');
        const res = await RUNNERS[scn](cfg, deps, { repeat: args.repeat, quiet: args.quiet, post, keyword: args.keyword, keyword2: args.keyword2 });
        const summary = summarize(res.samples);
        baseline.scenarios[scn][cfg.id] = {
          label: SCENARIO_META[scn].label,
          description: SCENARIO_META[scn].description,
          url: scn === 'long-post' ? cfg.baseUrl + PREFIX + '/#/post/' + post.id : cfg.baseUrl + HOME,
          cacheState: res.cacheState,
          samples: res.samples,
          summary,
          validity: {
            requested: args.repeat,
            completed: res.samples.filter(s => s.ok).length,
            minRequired: Math.min(5, args.repeat)
          }
        };

        for (const s of res.samples) {
          if (!s.ok) baseline.failures.push({ scenario: scn, config: cfg.id, rep: s.rep, error: s.error });
        }
      }
    }

    if (args.diagnostics) {
      baseline.diagnostics = {
        note: '瓶颈定位用探针：独立会话中直接调用页面已有函数做微基准（7 次取中位数），不属于正式场景统计',
        configs: {}
      };
      for (const cfg of selected) {
        console.log('\n-- diagnostics / ' + cfg.id + ' --');
        const d = await runDiagnostics(cfg, deps, { post, keyword: args.keyword, keyword2: args.keyword2 });
        baseline.diagnostics.configs[cfg.id] = d;
        if (d.ok) {
          const b = d.bench;
          console.log('    renderHome ' + b.renderHome.median + 'ms | renderPost ' + (b.renderPost ? b.renderPost.median : 'n/a') + 'ms'
            + ' | renderMarkdown ' + (b.renderMarkdown ? b.renderMarkdown.median : 'n/a') + 'ms'
            + ' | DOMPurify ' + (b.domPurify ? b.domPurify.median : 'n/a') + 'ms'
            + ' | search(' + args.keyword + ') ' + (b['renderGlobalSearch:' + args.keyword] ? b['renderGlobalSearch:' + args.keyword].median : 'n/a') + 'ms');
        } else {
          console.log('    FAIL: ' + d.error);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
    shapingProxy.server.close();
    if (probe) probe.server.close();
  }

  baseline.unavailable = collectAllUnavailable(baseline);
  baseline.calibration = calibration(baseline);
  baseline.meta.durationSec = r2((Date.now() - t0) / 1000);

  const complete = args.scenarios.every(scn =>
    selected.every(cfg => {
      const s = baseline.scenarios[scn] && baseline.scenarios[scn][cfg.id];
      return s && s.validity.completed >= Math.min(5, args.repeat);
    }));
  baseline.meta.verdict = complete ? 'BATCH6A_READY' : 'PARTIAL';
  baseline.meta.verdictBasis = '每个场景/配置的有效样本数 ≥ min(5, repeat) 视为完成';

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(baseline, null, 2), 'utf8');

  printSummary(baseline);
  console.log('\n===== 结论 =====');
  console.log('  verdict: ' + baseline.meta.verdict);
  console.log('  耗时: ' + baseline.meta.durationSec + 's');
  console.log('  网络整形生效: ' + (baseline.calibration.networkShaping.effective ? 'YES' : 'NO/UNKNOWN'));
  console.log('  CPU 限速生效: ' + (baseline.calibration.cpuThrottling.effective ? 'YES（比值 ' + baseline.calibration.cpuThrottling.ratio + '）' : 'NO/UNKNOWN'));
  if (baseline.unavailable.length) {
    console.log('  UNAVAILABLE 指标: ' + baseline.unavailable.length + ' 项（详见 JSON unavailable）');
  }
  if (baseline.failures.length) {
    console.log('  失败样本: ' + baseline.failures.length);
    baseline.failures.slice(0, 5).forEach(f => console.log('    - ' + f.scenario + '/' + f.config + '#' + f.rep + ': ' + f.error));
  }
  console.log('  报告: ' + path.relative(ROOT, args.out));

  return complete ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error('PERF SPEC ERROR:', e);
  process.exitCode = 2;
});
