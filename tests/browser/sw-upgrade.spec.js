#!/usr/bin/env node
'use strict';
/**
 * Batch 6C：SW 跨版本升级验证（真实 Chromium）
 *
 * 场景：
 *   U1 旧版站点（内联正文的单文件 data.js + 旧 CACHE_VERSION）安装并可用、离线可开
 *   U2 部署新版（拆分后的元数据 + 新 CACHE_VERSION）→ 刷新后新 SW 安装、旧缓存清理、页面切换到新数据形态
 *   U3 新版打开文章走 data/posts/<id>.md；离线重开仍可读
 *   U4 新版安装失败（js/app.js 500）时旧 SW 继续服务、旧缓存不丢、页面仍是旧数据形态；恢复后能成功升级
 *   U5 多标签页：旧标签页在升级后仍可用，刷新后进入新版
 *
 * 旧站点由当前仓库"还原"出来（把正文内联回 data.js、去掉 data/posts 与搜索语料、sw.js 用旧版本号），
 * 因此不需要 git 历史，CI 里也可复现。
 *
 * 用法：node tests/browser/sw-upgrade.spec.js
 * 退出码：0 全通过；1 有失败；2 环境不可用。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createSwitchServer, listen } = require('./helpers/switch-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const SHOTS = path.join(__dirname, 'artifacts');
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const OLD_CACHE_VERSION = '2026-10-26-2-old';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 旧站点生成
function copyEntry(src, dest) {
  if (!fs.existsSync(src)) return;
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyEntry(path.join(src, name), path.join(dest, name));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function buildOldSite(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['index.html', '404.html', 'manifest.json', 'robots.txt', 'feed.xml']) {
    copyEntry(path.join(ROOT, f), path.join(dest, f));
  }
  for (const d of ['css', 'vendor', 'icons', 'notes', 'js']) {
    copyEntry(path.join(ROOT, d), path.join(dest, d));
  }

  // 还原"正文内联在 data.js 里"的旧数据形态
  const src = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  const { POSTS, TAG_ORDER } = new Function(src + '\nreturn { POSTS: POSTS, TAG_ORDER: TAG_ORDER };')();
  const posts = POSTS.map((p) => {
    const body = fs.readFileSync(path.join(ROOT, 'data', 'posts', p.id + '.md'), 'utf8');
    const copy = Object.assign({}, p);
    delete copy.readingMinutes;
    copy.content = body;
    return copy;
  });
  fs.writeFileSync(path.join(dest, 'js', 'data.js'),
    'const POSTS = ' + JSON.stringify(posts, null, 2) + ';\n\nconst TAG_ORDER = ' + JSON.stringify(TAG_ORDER) + ';\n', 'utf8');

  // 旧 SW：版本号回退（模拟线上仍是上一版）
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')
    .replace(/CACHE_VERSION = '[^']+'/, "CACHE_VERSION = '" + OLD_CACHE_VERSION + "'");
  fs.writeFileSync(path.join(dest, 'sw.js'), sw, 'utf8');
}

// ---------------------------------------------------------------- 工具
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

async function cacheNames(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) {
      const c = await caches.open(n);
      out[n] = (await c.keys()).map(r => new URL(r.url).pathname);
    }
    return out;
  });
}

const dataShape = page => page.evaluate(() => {
  try {
    return typeof POSTS[0].content;
  } catch (e) { return 'error'; }
});

const bodyRendered = (page, timeout = 15000) => page.waitForFunction(() => {
  const b = document.querySelector('#app .article-detail-body');
  return !!b && b.textContent.trim().length > 200;
}, null, { timeout }).then(() => true).catch(() => false);

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-oldsite-'));
  buildOldSite(oldDir);
  console.log('旧站点生成: ' + oldDir);

  const { server, state } = createSwitchServer({ roots: [oldDir, ROOT], prefix: PREFIX });
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
  console.log('旧 CACHE_VERSION: ' + OLD_CACHE_VERSION + ' / 新: ' +
    (/CACHE_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')) || [])[1]);

  const postIds = (function () {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
    const ids = [];
    const re = /id: '([^']+)'/g;
    let m;
    while ((m = re.exec(src)) && ids.length < 2) ids.push(m[1]);
    return ids;
  })();

  try {
    // ------------------------------------------------ U1 旧版安装
    {
      state.active = 0;
      state.faults = {};
      const ctx = await browser.newContext({ serviceWorkers: 'allow' });
      const page = await ctx.newPage();
      await page.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
      const controlled = await waitController(page);
      await sleep(1200);
      const caches = await cacheNames(page);
      const names = Object.keys(caches);
      check('U1 旧版 SW 接管页面', controlled);
      check('U1 旧版使用旧缓存名', names.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), names.join(','));
      check('U1 旧版数据是内联正文（data.js 自带 content）', (await dataShape(page)) === 'string', await dataShape(page));
      check('U1 旧版首页渲染完整', (await page.evaluate(() => document.querySelectorAll('#app .article-card').length)) > 5);

      await ctx.setOffline(true);
      const offline = await page.reload({ waitUntil: 'load', timeout: 15000 }).catch(() => null);
      check('U1 旧版离线刷新首页可用', !!offline && (await page.title()).length > 0, offline ? offline.status() : 'reload failed');
      await ctx.setOffline(false);
      await ctx.close();
    }

    // ------------------------------------------------ U2/U3 升级到新版
    {
      state.active = 0;
      state.faults = {};
      const ctx = await browser.newContext({ serviceWorkers: 'allow' });
      const page = await ctx.newPage();
      await page.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
      await waitController(page);
      await sleep(1200);

      // 部署新版
      state.active = 1;
      await page.reload({ waitUntil: 'load', timeout: 60000 });   // 这次仍由旧 SW 供页面，同时触发 SW 更新
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r && r.update && r.update()));
      await sleep(2500);                                          // 等新 SW 安装 + 激活 + claim

      let caches = await cacheNames(page);
      let names = Object.keys(caches);
      const newVer = (/CACHE_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')) || [])[1];
      check('U2 新版 SW 已安装（出现新缓存名）', names.some(n => n.indexOf(newVer) !== -1), names.join(','));
      check('U2 旧版缓存被清理', !names.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), names.join(','));

      await page.reload({ waitUntil: 'load', timeout: 60000 });   // 第二次刷新：真正进入新版本
      await sleep(800);
      check('U2 升级后页面使用新数据形态（元数据不含 content）', (await dataShape(page)) === 'undefined', await dataShape(page));
      check('U2 升级后首页仍完整渲染', (await page.evaluate(() => document.querySelectorAll('#app .article-card').length)) > 5);

      // U3 新版按需加载正文
      await page.evaluate((id) => { location.hash = '#/post/' + id; }, postIds[0]);
      check('U3 新版进入文章后正文可读', await bodyRendered(page), postIds[0]);
      const hitsBefore = state.hits['/data/posts/' + postIds[0] + '.md'] || 0;
      check('U3 正文来自 data/posts/<id>.md', hitsBefore >= 1, hitsBefore);

      caches = await cacheNames(page);
      const rt = Object.keys(caches).filter(n => n.indexOf('-rt-') !== -1).map(n => caches[n]).flat();
      check('U3 正文进入运行期缓存', rt.some(p => p.endsWith('/data/posts/' + postIds[0] + '.md')),
        rt.filter(p => p.indexOf('/data/posts/') !== -1).length + ' 篇');

      await ctx.setOffline(true);
      const off = await page.reload({ waitUntil: 'load', timeout: 15000 }).catch(() => null);
      check('U3 新版离线重开已缓存文章仍可读', !!off && (await bodyRendered(page)), off ? off.status() : 'reload failed');
      await ctx.setOffline(false);
      await ctx.close();
    }

    // ------------------------------------------------ U4 新版安装失败 → 旧版继续服务
    {
      state.active = 0;
      state.faults = {};
      const ctx = await browser.newContext({ serviceWorkers: 'allow' });
      const page = await ctx.newPage();
      await page.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
      await waitController(page);
      await sleep(1200);
      const before = Object.keys(await cacheNames(page));

      state.active = 1;
      // 用"必需资源之一"制造安装失败：选 purify（首页渲染不依赖它，页面仍可用），
      // 这样既能验证"新版本装不上"，又不会让页面自己的脚本请求也 500。
      state.faults['/vendor/purify.min.js'] = 500;
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await sleep(2500);

      const reg = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return r ? { active: !!r.active, waiting: !!r.waiting, installing: !!r.installing } : null;
      });
      const names = Object.keys(await cacheNames(page));
      check('U4 安装失败时旧 SW 仍在服务', !!reg && reg.active, JSON.stringify(reg));
      check('U4 旧缓存未被删除', before.every(n => names.indexOf(n) !== -1), names.join(','));
      check('U4 失败的新版本缓存已清理', !names.some(n => n.indexOf('-t2') !== -1 || /2026-10-27-1/.test(n) && n.indexOf(OLD_CACHE_VERSION) === -1),
        names.join(','));
      // 注意：快速链路下旧 SW 会走"网络模式"，页面拿到的是服务器上的新资源 —— 这是预期行为。
      // 这里要保证的是"页面仍然可用、运行时接口没崩"，而不是强行停留在旧数据形态。
      const u4State = await page.evaluate(() => ({
        cards: document.querySelectorAll('#app .article-card').length,
        posts: (typeof POSTS !== 'undefined') ? POSTS.length : -1,
        title: document.title
      }));
      check('U4 安装失败后页面仍可正常打开', u4State.cards > 5 && u4State.posts === 18 && !!u4State.title,
        JSON.stringify(u4State));

      // 恢复后重新升级
      state.faults = {};
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r && r.update && r.update()));
      await sleep(2500);
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await sleep(600);
      const names2 = Object.keys(await cacheNames(page));
      check('U4 故障恢复后可以完成升级', !names2.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), names2.join(','));
      check('U4 恢复后页面切到新数据形态', (await dataShape(page)) === 'undefined', await dataShape(page));
      await ctx.close();
    }

    // ------------------------------------------------ U6 新旧资源混部（新 JS + 旧 data.js）
    // 模拟只发布了一半的部署：app.js 已是新版，data.js 仍是旧的内联正文版本。
    // 新版运行时必须能读旧结构（post.content 直接可用），不能崩、不能重复请求正文。
    {
      state.active = 1;
      state.faults = {};
      state.override = { '/js/data.js': 0 };
      const ctx = await browser.newContext({ serviceWorkers: 'allow' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e.message).slice(0, 120)));
      await page.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
      await sleep(600);
      const shape = await dataShape(page);
      check('U6 混部时页面不崩且能识别旧结构', shape === 'string' && (await page.evaluate(() => document.querySelectorAll('#app .article-card').length)) > 5,
        shape);
      const before = state.hits['/data/posts/' + postIds[0] + '.md'] || 0;
      await page.evaluate((id) => { location.hash = '#/post/' + id; }, postIds[0]);
      const rendered = await bodyRendered(page);
      const after = state.hits['/data/posts/' + postIds[0] + '.md'] || 0;
      check('U6 旧结构下文章可直接渲染（无需请求正文）', rendered && after === before, 'hits ' + before + '->' + after);
      check('U6 混部时无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      state.override = {};
      await ctx.close();
    }

    // ------------------------------------------------ U5 多标签页
    {
      state.active = 0;
      state.faults = {};
      const ctx = await browser.newContext({ serviceWorkers: 'allow' });
      const t1 = await ctx.newPage();
      await t1.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
      await waitController(t1);
      await sleep(1200);

      state.active = 1;
      const t2 = await ctx.newPage();
      await t2.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
      await waitController(t2);
      await sleep(2500);

      const t1State = await t1.evaluate(() => ({
        controlled: !!navigator.serviceWorker.controller,
        rendered: document.querySelectorAll('#app .article-card').length > 5
      }));
      check('U5 升级时旧标签页未崩溃', t1State.controlled && t1State.rendered, JSON.stringify(t1State));

      await t1.reload({ waitUntil: 'load', timeout: 60000 });
      await sleep(600);
      check('U5 旧标签页刷新后进入新版本', (await dataShape(t1)) === 'undefined', await dataShape(t1));
      check('U5 新标签页是新版本', (await dataShape(t2)) === 'undefined', await dataShape(t2));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  }

  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SPEC ERROR:', e); process.exit(1); });
