#!/usr/bin/env node
'use strict';
/**
 * Batch 9F：真实浏览器下的个性化首页验收
 *
 * 覆盖：个人模块渲染与顺序、继续阅读恢复、搜索与模块交替、设置面板键盘与焦点、
 * 模块隐藏/恢复/预设、多标签同步、快速路由切换、失效内容、读取失败降级、
 * 统计脚本缺失、三档视口与深浅色、离线、三引擎代表性场景。
 *
 * 用法：node tests/browser/home-experience.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newSession(browser, base, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1440, height: 900 },
    serviceWorkers: o.sw ? 'allow' : 'block',
    colorScheme: o.colorScheme || 'light'
  });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  if (o.initScript) await ctx.addInitScript(o.initScript);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible', timeout: 30000 });
  await waitHome(page);
  return { ctx, page, errors };
}

async function waitHome(page, timeout) {
  // 空状态容器没有高度：用 attached 判断存在性，再等 data-home-state 落定
  await page.waitForSelector('#homePersonal', { state: 'attached', timeout: timeout || 25000 });
  await page.waitForFunction(() => {
    const h = document.getElementById('homePersonal');
    return !!h && h.getAttribute('data-home-state') !== 'loading';
  }, null, { timeout: timeout || 25000 });
  await sleep(200);
}

async function seed(page) {
  await page.evaluate(async () => {
    await Knowledge.recordView('post', 'vla-model-intro', { title: 'VLA模型入门：从RT-1到OpenVLA' });
    await Knowledge.recordView('post', 'rl-from-mdp-to-ppo', { title: '强化学习入门：从MDP到PPO' });
    await Knowledge.recordView('post', 'slam-overview-filtering-to-graph', { title: 'SLAM技术全景：从滤波到图优化' });
    await Knowledge.saveProgress('post', 'vla-model-intro', 0.45);
    await Knowledge.setFlag('post', 'rl-from-mdp-to-ppo', 'fav', true);
    await Knowledge.setFlag('course', '本科课程|机器人与自动化-(CS422)', 'later', true);
    await Knowledge.setReadState('post', 'slam-overview-filtering-to-graph', 'done');
  });
  await sleep(700);
}

function blocks(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#homePersonal [data-home-block]'))
    .map(el => el.getAttribute('data-home-block')));
}

(async function main() {
  const server = createServer(ROOT, PREFIX);
  const port = await listen(server.server, 0);
  const base = 'http://127.0.0.1:' + port;
  let browser;
  try {
    browser = await chromium.launch(Object.assign({ headless: true }, CHANNEL !== 'chromium' ? { channel: CHANNEL } : {}));
  } catch (e) {
    console.error('无法启动浏览器（' + CHANNEL + '）：' + String(e.message).split('\n')[0]);
    server.server.close();
    process.exit(2);
  }
  console.log('浏览器: ' + CHANNEL + ' ' + browser.version());

  try {
    // ---------------------------------------------------------------- H1 无数据 → 有数据
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    const emptyState = await p1.evaluate(() => ({
      state: document.getElementById('homePersonal').getAttribute('data-home-state'),
      blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
      cards: document.querySelectorAll('#app .article-card').length,
      prefsBtn: !!document.getElementById('homePrefsBtn')
    }));
    check('H1.1 无个人记录时不渲染模块且首页完整',
      emptyState.state === 'empty' && emptyState.blocks === 0 && emptyState.cards > 5 && emptyState.prefsBtn,
      JSON.stringify(emptyState));

    await seed(p1);
    await p1.waitForSelector('#homePersonal [data-home-block="continue"]', { timeout: 20000 });
    const order = await blocks(p1);
    check('H1.2 有数据后按默认顺序渲染四个模块',
      JSON.stringify(order) === JSON.stringify(['continue', 'recent', 'favorites', 'directions']),
      order.join(','));
    check('H1.3 统计脚本按需加载后方向区有结果',
      (await p1.waitForFunction(() => {
        const b = document.querySelector('[data-home-block="directions"]');
        return !!b && b.querySelectorAll('.hp-dir').length > 0;
      }, null, { timeout: 20000 }).then(() => true).catch(() => false)),
      'dirs');
    const dirText = await p1.locator('[data-home-block="directions"]').innerText();
    check('H1.4 方向区说明多归属且不宣称唯一总数',
      /可大于唯一内容数/.test(dirText), dirText.replace(/\s+/g, ' ').slice(0, 70));

    // ---------------------------------------------------------------- H2 继续阅读恢复
    const resume = p1.locator('[data-home-block="continue"] [data-km-resume]').first();
    await resume.click();
    await p1.waitForSelector('.article-detail-body', { timeout: 20000 });
    await sleep(1200);
    const resumed = await p1.evaluate(() => ({
      hash: location.hash,
      scrollY: window.scrollY,
      hasPersonal: !!document.getElementById('homePersonal')
    }));
    check('H2.1 继续阅读跳到真实文章并恢复进度',
      /^#\/post\//.test(resumed.hash) && resumed.scrollY > 100 && !resumed.hasPersonal,
      JSON.stringify(resumed));

    await p1.evaluate(() => { location.hash = '#/'; });
    await waitHome(p1);
    check('H2.2 返回首页后个人模块重新渲染',
      (await blocks(p1)).length === 4 && (await p1.locator('#app .article-card').count()) > 5);

    // ---------------------------------------------------------------- H3 搜索交替
    await p1.fill('#searchInput', '机器人');
    await p1.waitForSelector('#app [data-search-root]', { timeout: 20000 });
    await sleep(500);
    const searching = await p1.evaluate(() => ({
      personal: !!document.getElementById('homePersonal'),
      results: document.querySelectorAll('#app [data-search-result], #app .article-card').length
    }));
    check('H3.1 输入搜索词后只显示结果，不渲染个人模块',
      searching.personal === false && searching.results > 0, JSON.stringify(searching));
    await p1.fill('#searchInput', '');
    await p1.waitForSelector('#homePersonal', { state: 'attached', timeout: 20000 });
    await waitHome(p1);
    check('H3.2 清空搜索词后个人模块与文章列表同时恢复',
      (await blocks(p1)).length === 4 && (await p1.locator('#app .article-card').count()) > 5);

    // ---------------------------------------------------------------- H4 设置面板与键盘
    await p1.locator('#homePrefsBtn').focus();
    await p1.keyboard.press('Enter');
    await p1.waitForSelector('#homePrefsPanel:not([hidden])', { timeout: 10000 });
    const panelState = await p1.evaluate(() => ({
      expanded: document.getElementById('homePrefsBtn').getAttribute('aria-expanded'),
      boxes: document.querySelectorAll('#homePrefsPanel [data-home-module]').length,
      presets: document.querySelectorAll('#homePrefsPanel [data-home-preset]').length,
      focused: document.activeElement && document.activeElement.id
    }));
    check('H4.1 设置入口可键盘打开并暴露 4 个开关 + 3 个预设',
      panelState.expanded === 'true' && panelState.boxes === 4 && panelState.presets === 3,
      JSON.stringify(panelState));

    const box = p1.locator('#homePrefsPanel [data-home-module="recent"]');
    await box.focus();
    await p1.keyboard.press('Space');
    await sleep(600);
    const afterHide = await p1.evaluate(() => ({
      blocks: Array.from(document.querySelectorAll('#homePersonal [data-home-block]')).map(el => el.getAttribute('data-home-block')),
      focused: document.activeElement && document.activeElement.getAttribute('data-home-module'),
      status: (document.getElementById('homePrefsStatus') || {}).textContent || '',
      stored: localStorage.getItem('blog.home.prefs.v1')
    }));
    check('H4.2 空格隐藏模块且焦点留在该复选框',
      afterHide.blocks.indexOf('recent') === -1 && afterHide.focused === 'recent',
      JSON.stringify({ blocks: afterHide.blocks, focus: afterHide.focused }));
    check('H4.3 隐藏写入偏好并给出状态提示',
      /"hidden":\["recent"\]/.test(afterHide.stored || '') && /已隐藏/.test(afterHide.status),
      (afterHide.stored || '').slice(0, 50));

    await p1.locator('#homePrefsPanel [data-home-preset="reading"]').click();
    await sleep(600);
    const readingOrder = await blocks(p1);
    // recent 在上一步被隐藏，预设顺序去掉它之后应为 continue → directions → favorites
    check('H4.4 预设顺序（阅读优先）立即生效',
      readingOrder.join(',') === 'continue,directions,favorites', readingOrder.join(','));

    await p1.keyboard.press('Escape');
    await sleep(200);
    const closed = await p1.evaluate(() => ({
      hidden: document.getElementById('homePrefsPanel').hidden,
      expanded: document.getElementById('homePrefsBtn').getAttribute('aria-expanded'),
      focus: document.activeElement && document.activeElement.id
    }));
    check('H4.5 Escape 关闭面板并把焦点还给入口',
      closed.hidden === true && closed.expanded === 'false' && closed.focus === 'homePrefsBtn',
      JSON.stringify(closed));

    // 刷新后偏好保留
    await p1.reload({ waitUntil: 'load' });
    await waitHome(p1);
    const afterReload = await blocks(p1);
    check('H4.6 刷新后偏好仍然生效',
      afterReload.join(',') === 'continue,directions,favorites', afterReload.join(','));

    await p1.locator('#homePrefsBtn').click();
    await p1.waitForSelector('#homePrefsPanel:not([hidden])', { timeout: 10000 });
    await p1.locator('#homePrefsPanel [data-home-reset]').click();
    await sleep(700);
    const restored = await blocks(p1);
    check('H4.7 恢复默认布局还原顺序与显示',
      JSON.stringify(restored) === JSON.stringify(['continue', 'recent', 'favorites', 'directions']),
      restored.join(','));
    await p1.keyboard.press('Escape');

    // ---------------------------------------------------------------- H5 失效内容
    await p1.evaluate(() => Knowledge.setFlag('post', 'b9f-missing-browser', 'fav', true, { title: '已删除的合成内容' }));
    await p1.waitForFunction(() => !!document.querySelector('[data-home-block="favorites"] .hp-row-broken'), null, { timeout: 15000 })
      .then(() => true).catch(() => false);
    const broken = await p1.evaluate(() => {
      const row = document.querySelector('[data-home-block="favorites"] .hp-row-broken');
      return row ? { text: row.textContent, links: row.querySelectorAll('a').length } : null;
    });
    check('H5.1 失效内容有提示且不生成链接',
      !!broken && /内容已删除/.test(broken.text) && broken.links === 0, JSON.stringify(broken));

    // ---------------------------------------------------------------- H6 多标签同步
    const tabB = await s1.ctx.newPage();
    await tabB.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
    await waitHome(tabB);
    const favBefore = await tabB.locator('.hp-chip', { hasText: '收藏' }).innerText();
    await p1.evaluate(() => Knowledge.setFlag('post', 'sim-to-real-gap', 'fav', true));
    let synced = false;
    try {
      await tabB.waitForFunction(prev => {
        const chips = Array.from(document.querySelectorAll('.hp-chip'));
        const chip = chips.filter(c => c.textContent.indexOf('收藏') === 0)[0];
        return !!chip && chip.textContent !== prev;
      }, favBefore, { timeout: 12000 });
      synced = true;
    } catch (e) { synced = false; }
    check('H6.1 另一标签页收藏后首页模块自动同步', synced, favBefore);
    await tabB.close();

    // ---------------------------------------------------------------- H7 快速路由切换
    const rapid = await p1.evaluate(async () => {
      const hops = ['#/', '#/post/vla-model-intro', '#/', '#/knowledge?tab=stats', '#/', '#/projects', '#/'];
      for (const h of hops) {
        location.hash = h;
        await new Promise(r => setTimeout(r, 40));
      }
      return location.hash;
    });
    await waitHome(p1, 25000);
    const afterRapid = await p1.evaluate(() => ({
      hash: location.hash,
      personal: !!document.getElementById('homePersonal'),
      blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
      stray: document.querySelectorAll('#app .hp-block').length - document.querySelectorAll('#homePersonal .hp-block').length,
      cards: document.querySelectorAll('#app .article-card').length
    }));
    check('H7.1 快速连续切换后回到首页且模块不重复、不串页',
      rapid === '#/' && afterRapid.personal && afterRapid.blocks >= 3 && afterRapid.stray === 0 && afterRapid.cards > 5,
      JSON.stringify(afterRapid));

    // ---------------------------------------------------------------- H8 读取失败
    const cardsBefore = await p1.locator('#app .article-card').count();
    await p1.evaluate(() => {
      window.__origSnapshot = Knowledge.snapshot;
      Knowledge.snapshot = function () { return Promise.reject(new Error('注入读取失败')); };
      homeRefreshPersonal();
    });
    await p1.waitForSelector('#homePersonal[data-home-state="error"]', { timeout: 15000 });
    const failed = await p1.evaluate(() => ({
      blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
      retry: !!document.querySelector('#homePersonal [data-home-retry]'),
      cards: document.querySelectorAll('#app .article-card').length
    }));
    check('H8.1 读取失败只降级个人模块，文章列表不受影响',
      failed.blocks === 0 && failed.retry && failed.cards === cardsBefore,
      JSON.stringify(failed));
    await p1.evaluate(() => { Knowledge.snapshot = window.__origSnapshot; });
    await p1.locator('#homePersonal [data-home-retry]').click();
    await waitHome(p1);
    check('H8.2 重试后模块恢复', (await blocks(p1)).length >= 3);

    check('H9 主流程无未捕获异常', s1.errors.length === 0, s1.errors.slice(0, 3).join(' | ') || 'none');

    // ---------------------------------------------------------------- H10 视口 / 主题
    const s2 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await seed(s2.page);
    await waitHome(s2.page);
    const mobile = await s2.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      theme: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
      blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
      cards: document.querySelectorAll('#app .article-card').length,
      btnWidth: Math.round(document.getElementById('homePrefsBtn').getBoundingClientRect().width)
    }));
    check('H10.1 390px 深色下无横向溢出且模块/文章都在',
      mobile.overflow && mobile.theme === 'dark' && mobile.blocks >= 3 && mobile.cards > 5,
      JSON.stringify(mobile));
    const darkBg = /rgb\((\d+), (\d+), (\d+)\)/.exec(mobile.bg);
    check('H10.2 深色主题实际生效', darkBg && Number(darkBg[1]) < 80, mobile.bg);
    await s2.ctx.close();

    const s3 = await newSession(browser, base, { viewport: { width: 768, height: 1024 } });
    await seed(s3.page);
    await waitHome(s3.page);
    const tablet = await s3.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
      cols: getComputedStyle(document.querySelector('.article-list')).gridTemplateColumns.split(' ').length
    }));
    check('H10.3 768px 无溢出且文章列表保持单列',
      tablet.overflow && tablet.blocks >= 3 && tablet.cols === 1, JSON.stringify(tablet));
    await s3.ctx.close();

    const s4 = await newSession(browser, base, { viewport: { width: 1440, height: 900 } });
    await seed(s4.page);
    await waitHome(s4.page);
    const desktop = await s4.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
      cols: getComputedStyle(document.querySelector('.article-list')).gridTemplateColumns.split(' ').length
    }));
    check('H10.4 1440px 无溢出且文章列表两列',
      desktop.overflow && desktop.blocks >= 3 && desktop.cols === 2, JSON.stringify(desktop));
    await s4.ctx.close();

    // ---------------------------------------------------------------- H11 降级 / 离线
    const s5 = await newSession(browser, base, {
      initScript: () => { try { Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }); } catch (e) { } }
    });
    await s5.page.evaluate(async () => {
      await Knowledge.recordView('post', 'vla-model-intro', { title: '内存模式记录' });
      await Knowledge.setFlag('post', 'vla-model-intro', 'fav', true);
      homeRefreshPersonal();
    });
    await s5.page.waitForSelector('#homePersonal [data-home-block="favorites"]', { timeout: 15000 });
    const degraded = await s5.page.evaluate(() => ({
      blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
      cards: document.querySelectorAll('#app .article-card').length,
      degraded: Knowledge.status().degraded
    }));
    check('H11.1 IndexedDB 不可用时模块仍可用（内存）且文章列表完整',
      degraded.blocks >= 2 && degraded.cards > 5 && degraded.degraded === true, JSON.stringify(degraded));
    await s5.ctx.close();

    // 统计脚本加载失败：其它模块仍然可用
    const s6 = await newSession(browser, base);
    await s6.ctx.route('**/js/learning-stats.js*', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'blocked' }));
    await seed(s6.page);
    await s6.page.waitForSelector('#homePersonal [data-home-block="directions"]', { timeout: 15000 });
    await sleep(1200);
    const noStats = await s6.page.evaluate(() => {
      const d = document.querySelector('[data-home-block="directions"]');
      return {
        text: d ? d.textContent : '',
        other: document.querySelectorAll('#homePersonal [data-home-block]').length,
        cards: document.querySelectorAll('#app .article-card').length
      };
    });
    check('H11.2 统计脚本失败只影响方向区',
      /方向统计暂时不可用/.test(noStats.text) && noStats.other >= 3 && noStats.cards > 5,
      noStats.text.replace(/\s+/g, ' ').slice(0, 50));
    await s6.ctx.close();

    // 离线：SW 接管后再次访问首页
    const s7 = await newSession(browser, base, { sw: true });
    await s7.page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await s7.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await seed(s7.page);
    await s7.page.waitForSelector('#homePersonal [data-home-block="favorites"]', { timeout: 15000 });
    await sleep(800);
    await s7.ctx.setOffline(true);
    let offlineOk = false;
    let offlineState = null;
    try {
      await s7.page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 30000 });
      await s7.page.waitForSelector('#homePersonal', { state: 'attached', timeout: 20000 });
      await sleep(900);
      offlineState = await s7.page.evaluate(() => ({
        state: document.getElementById('homePersonal').getAttribute('data-home-state'),
        blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
        cards: document.querySelectorAll('#app .article-card').length
      }));
      offlineOk = offlineState.cards > 5 && offlineState.blocks >= 2;
    } catch (e) { offlineOk = false; }
    check('H11.3 离线再次访问首页：文章与个人模块都可用',
      offlineOk, JSON.stringify(offlineState));
    await s7.ctx.setOffline(false);
    await s7.ctx.close();

    // ---------------------------------------------------------------- H12 三引擎
    for (const eng of [{ name: 'firefox', launcher: firefox }, { name: 'webkit', launcher: webkit }]) {
      let eb = null;
      try {
        eb = await eng.launcher.launch({ headless: true });
      } catch (e) {
        console.log('SKIP ' + eng.name + ' 不可用：' + String(e.message).split('\n')[0]);
        continue;
      }
      try {
        const ctx = await eb.newContext({ viewport: { width: 768, height: 1024 }, serviceWorkers: 'block' });
        await ctx.route('**/*', route => {
          const u = route.request().url();
          if (u.startsWith('http://127.0.0.1') || u.startsWith('data:')) return route.continue();
          return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
        });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(e.message));
        await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
        await page.waitForSelector('#searchInput', { state: 'visible', timeout: 30000 });
        await page.evaluate(async () => {
          await Knowledge.recordView('post', 'slam-overview-filtering-to-graph', { title: 'SLAM技术全景' });
          await Knowledge.setFlag('post', 'slam-overview-filtering-to-graph', 'fav', true);
        });
        await page.waitForSelector('#homePersonal [data-home-block="favorites"]', { timeout: 25000 });
        const r = await page.evaluate(() => ({
          blocks: document.querySelectorAll('#homePersonal [data-home-block]').length,
          cards: document.querySelectorAll('#app .article-card').length,
          overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
        }));
        check('H12.1 ' + eng.name + ' 首页渲染个人模块且不溢出',
          r.blocks >= 2 && r.cards > 5 && r.overflow, JSON.stringify(r));
        check('H12.2 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('H12.1 ' + eng.name + ' 首页渲染个人模块且不溢出', false, String(e.message).split('\n')[0]);
      } finally {
        await eb.close();
      }
    }

    await s1.ctx.close();
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  await browser.close();
  server.server.close();
  process.exit(fail ? 1 : 0);
})();
