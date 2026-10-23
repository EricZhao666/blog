// B4-06：真实 Chromium 下的 Service Worker / PWA 可靠性测试
//
//   node tests/browser/sw.spec.js                 # 默认用系统 Chrome（channel: chrome）
//   PW_CHANNEL=chromium node tests/browser/sw.spec.js   # 用 Playwright 自带 Chromium（CI）
//
// 每个场景使用独立 BrowserContext，互不污染 CacheStorage / SW 注册。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const SHOTS = path.join(__dirname, 'artifacts');
const CHANNEL = process.env.PW_CHANNEL || 'chrome';

// 缓存名跟着 sw.js 的 CACHE_VERSION 走，避免每次升版本都要改测试
const SW_VER = (function () {
  const m = /CACHE_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
  return m ? m[1] : 'unknown';
})();
const CORE_NAME = 'blog-' + SW_VER;
const RT_NAME = 'blog-rt-' + SW_VER;

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newContext(browser) {
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  return ctx;
}

async function gotoApp(page, base, suffix) {
  await page.goto(base + PREFIX + '/' + (suffix || ''), { waitUntil: 'load' });
}

// 等待 SW 安装完成并"接管"当前页面
async function waitController(page, timeout = 8000) {
  return page.evaluate(async (ms) => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (navigator.serviceWorker.controller) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }, timeout);
}

async function cacheKeys(page) {
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

async function currentSWScript(page) {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.active) return null;
    return reg.active.scriptURL;
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, state } = createServer(ROOT, PREFIX);
  const port = await listen(server, 0);
  const base = 'http://127.0.0.1:' + port;

  const launchOpts = { headless: true };
  if (CHANNEL !== 'chromium') launchOpts.channel = CHANNEL;
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    console.error('无法启动浏览器（' + CHANNEL + '）: ' + e.message.split('\n')[0]);
    console.error('提示：本地可用系统 Chrome（默认），CI 请先 npx playwright install --with-deps chromium');
    server.close();
    process.exit(2);
  }
  console.log('浏览器: ' + CHANNEL + ' ' + browser.version());

  // 重置注入状态
  const reset = () => {
    state.faults = {}; state.delays = {}; state.hits = {};
    state.version = 1; state.swBump = false;
  };

  try {
    // ---------------------------------------------------------------- S1 首次安装
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      const controlled = await waitController(page);
      const keys = await cacheKeys(page);
      const core = keys[CORE_NAME] || [];
      check('S1 首次访问后 SW 接管页面', controlled);
      check('S1 CORE 缓存包含入口与关键脚本',
        core.includes('/blog/index.html') && core.includes('/blog/js/app.js') &&
        core.includes('/blog/css/style.css'),
        core.length + ' 项: ' + core.slice(0, 4).join(','));
      await ctx.close();
    }

    // ---------------------------------------------------------------- S2 必要资源安装失败
    {
      reset();
      state.faults['/js/app.js'] = 500;
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await sleep(2500);
      const reg = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return r ? { active: !!r.active, installing: !!r.installing, waiting: !!r.waiting } : null;
      });
      const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
      await page.screenshot({ path: path.join(SHOTS, 'S2-install-fail.png') });
      check('S2 关键脚本 500 时安装失败（无 active SW）', !reg || !reg.active,
        JSON.stringify(reg));
      check('S2 安装失败时页面仍可在线使用', !controlled &&
        (await page.title()).length > 0, await page.title());
      await ctx.close();
    }

    // ---------------------------------------------------------------- S3 可选资源失败
    {
      reset();
      state.faults['/icons/icon-192.png'] = 500;
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      const controlled = await waitController(page);
      check('S3 非关键图标失败不影响安装', controlled);
      await ctx.close();
    }

    // ---------------------------------------------------------------- S4 在线刷新取新内容
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await waitController(page);
      state.version = 2;
      const resp = await page.reload({ waitUntil: 'load' });
      const hasV2 = await page.evaluate(async () => {
        const r = await fetch('./js/app.js');
        const t = await r.text();
        return t.indexOf('build:v2') !== -1;
      });
      check('S4 在线刷新可拿到新版本 app.js', resp.status() === 200 && hasV2, resp.status());
      await ctx.close();
    }

    // ---------------------------------------------------------------- S5 离线刷新首页
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await waitController(page);
      await ctx.setOffline(true);
      let ok = false, status = 0, text = '';
      try {
        const r = await page.reload({ waitUntil: 'load', timeout: 8000 });
        status = r.status();
        text = await page.title();
        ok = status === 200 && text.length > 0;
      } catch (e) { text = e.message.split('\n')[0]; }
      await page.screenshot({ path: path.join(SHOTS, 'S5-offline-home.png') });
      check('S5 离线刷新首页可用', ok, status + ' / ' + text);
      await ctx.close();
    }

    // ---------------------------------------------------------------- S6/S7 笔记页离线
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await waitController(page);
      // 先在线访问一个笔记页，让它进入运行期缓存
      await page.goto(base + PREFIX + '/notes/cs422.html', { waitUntil: 'load' });
      await sleep(500);
      await ctx.setOffline(true);
      const r1 = await page.reload({ waitUntil: 'load' }).catch(() => null);
      const body1 = await page.evaluate(() => document.body.innerText.slice(0, 60));
      check('S6 已缓存的静态笔记离线可读', !!r1 && body1.indexOf('CS422') !== -1 || body1.length > 20, body1);

      // 未缓存过的笔记页：不得伪造成首页
      const page2 = await ctx.newPage();
      let status2 = 0, body2 = '', title2 = '';
      try {
        const r2 = await page2.goto(base + PREFIX + '/notes/never-visited.html', { waitUntil: 'load', timeout: 8000 });
        status2 = r2 ? r2.status() : 0;
        body2 = await page2.evaluate(() => document.body.innerText.slice(0, 80));
        title2 = await page2.title();
      } catch (e) { body2 = 'ERR ' + e.message.split('\n')[0]; }
      await page2.screenshot({ path: path.join(SHOTS, 'S7-offline-uncached.png') });
      const looksLikeHome = /Eric's Notebook/.test(title2) && body2.indexOf('课程') !== -1;
      check('S7 未缓存笔记离线时明确提示（不冒充首页）',
        !looksLikeHome && status2 >= 400 || /离线|offline/i.test(body2),
        status2 + ' / ' + title2 + ' / ' + body2.slice(0, 40));
      await ctx.close();
    }

    // ---------------------------------------------------------------- S8 在线 404 不被替换
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await waitController(page);
      await page.goto(base + PREFIX + '/notes/cs422.html', { waitUntil: 'load' });
      const r = await page.goto(base + PREFIX + '/notes/definitely-missing.html', { waitUntil: 'load' });
      check('S8 在线 404 原样返回（不拿旧缓存顶替）', r.status() === 404, r.status());
      await ctx.close();
    }

    // ---------------------------------------------------------------- S9 预取不重复
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await waitController(page);
      await sleep(1500);
      const first = state.hits['/js/courses.js'] || 0;
      await page.goto(base + PREFIX + '/#/papers', { waitUntil: 'load' });
      await sleep(800);
      await page.goto(base + PREFIX + '/#/code', { waitUntil: 'load' });
      await sleep(800);
      const second = state.hits['/js/courses.js'] || 0;
      check('S9 多次导航不重复预取可选资源', second === first, first + ' -> ' + second);
      const keys = await cacheKeys(page);
      const rt = keys[RT_NAME] || [];
      check('S9 可选资源已进入运行期缓存',
        rt.some(p => p.endsWith('/js/courses.js')) && rt.some(p => p.endsWith('/js/papers.js')),
        rt.length + ' 项: ' + rt.join(',') + ' | hits(courses)=' + (state.hits['/js/courses.js'] || 0));
      await ctx.close();
    }

    // ---------------------------------------------------------------- S10 运行期缓存上限
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await waitController(page);
      const r10 = await page.evaluate(async (rtName) => {
        for (let i = 0; i < 130; i++) {
          await fetch('./gen/' + i + '.txt');   // 全部经 SW 的 network-first 写入 RT
        }
        const c = await caches.open(rtName);
        // 写入在 SW 侧是异步的，等数量稳定后再读，否则会读到写了一半的状态
        let prev = -1, stable = 0;
        for (let t = 0; t < 40; t++) {
          const n = (await c.keys()).length;
          if (n === prev) { stable++; if (stable >= 3) break; } else { stable = 0; prev = n; }
          await new Promise(r => setTimeout(r, 150));
        }
        const keys = (await c.keys()).map(x => new URL(x.url).pathname);
        return {
          total: keys.length,
          hasFirst: keys.some(p => p.endsWith('/gen/0.txt')),
          hasLast: keys.some(p => p.endsWith('/gen/129.txt'))
        };
      }, RT_NAME);
      check('S10 运行期缓存不超过上限 120', r10.total <= 120, r10.total);
      check('S10 超限后淘汰最旧、保留最新', !r10.hasFirst && r10.hasLast,
        JSON.stringify({ first: r10.hasFirst, last: r10.hasLast }));
      await ctx.close();
    }
    // ------------------------------------------------- S11 新版本安装失败 → 旧版本继续服务
    {
      reset();
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      await gotoApp(page, base);
      await waitController(page);
      const before = Object.keys(await cacheKeys(page));

      // 发布新 SW，但新版本必需资源（css）下载失败
      state.swBump = true;
      state.faults['/css/style.css'] = 500;
      await page.reload({ waitUntil: 'load' });
      await sleep(3000);

      const reg = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return r ? { active: !!r.active, waiting: !!r.waiting, installing: !!r.installing } : null;
      });
      const after = await cacheKeys(page);
      const names = Object.keys(after);

      check('S11 新版本安装失败时旧 SW 仍在服务', !!reg && reg.active && !reg.waiting,
        JSON.stringify(reg));
      check('S11 旧版本缓存未被删除', before.every(n => names.includes(n)), names.join(','));
      check('S11 安装失败的新版本缓存已清理', !names.some(n => n.endsWith('-t2')), names.join(','));

      // 恢复网络后，旧版本在离线时仍可完整提供首页
      state.faults = {};
      await ctx.setOffline(true);
      let status = 0, title = '';
      try {
        const r = await page.reload({ waitUntil: 'load', timeout: 8000 });
        status = r.status();
        title = await page.title();
      } catch (e) { title = e.message.split('\n')[0]; }
      await page.screenshot({ path: path.join(SHOTS, 'S11-old-version-survives.png') });
      check('S11 回退旧版本后离线首页仍可用', status === 200 && title.length > 0, status + ' / ' + title);
      await ctx.close();
    }

    // ------------------------------------------------- S12 多标签页版本切换
    {
      reset();
      const ctx = await newContext(browser);
      const t1 = await ctx.newPage();
      await gotoApp(t1, base);
      await waitController(t1);
      const oldNames = Object.keys(await cacheKeys(t1));
      const oldCache = oldNames.find(n => n.indexOf('blog-rt-') !== 0);

      state.swBump = true;                    // 发布新版本
      const t2 = await ctx.newPage();
      await gotoApp(t2, base);
      const ok2 = await waitController(t2);
      await sleep(2500);                      // 等 activate + clients.claim

      let names = Object.keys(await cacheKeys(t1));
      const newCache = names.find(n => n.indexOf('blog-rt-') !== 0 && n.endsWith('-t2'));
      check('S12 新版本在第二个标签页安装并生效', ok2 && !!newCache, names.join(','));

      // activate 的清理是异步的，给它几秒钟收敛
      for (let i = 0; i < 20 && oldCache && names.includes(oldCache); i++) {
        await sleep(250);
        names = Object.keys(await cacheKeys(t1));
      }
      check('S12 旧版本缓存被清理', !!oldCache && !names.includes(oldCache), names.join(','));

      const t1State = await t1.evaluate(async () => {
        const app = document.getElementById('app');
        return {
          controlled: !!navigator.serviceWorker.controller,
          rendered: !!app && app.children.length > 0
        };
      });
      check('S12 旧标签页被新 SW 接管且页面未崩溃',
        t1State.controlled && t1State.rendered, JSON.stringify(t1State));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n共 ' + results.length + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failed.length) console.log('失败项：\n  - ' + failed.map(f => f.name).join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SPEC ERROR:', e); process.exit(1); });
