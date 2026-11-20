#!/usr/bin/env node
'use strict';
/**
 * Batch 9A-1：真实 Chromium 下的个人知识中心验收
 *
 * 覆盖：收藏/待读/取消、卡片操作不导航、四个 tab、刷新保留、继续阅读与恢复、
 * 删除历史、深链接特殊字符课程 ID、搜索结果个人操作、移动端、深浅色、键盘、多标签、离线。
 * 用法：node tests/browser/knowledge-center.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium } = require('playwright');
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
  return { ctx, page, errors };
}

async function openFirstPost(page) {
  await page.locator('#app a[href^="#/post/"]').first().click();
  await page.waitForSelector('.article-detail-body', { timeout: 20000 });
  await page.waitForSelector('.km-actions [data-km-toggle="fav"]', { timeout: 15000 });
  await sleep(250);
  return page.evaluate(() => location.hash);
}

async function gotoKnowledge(page, tab) {
  await page.evaluate(t => { location.hash = '#/knowledge?tab=' + t; }, tab);
  await page.waitForFunction(() => location.hash.indexOf('#/knowledge') === 0, null, { timeout: 15000 });
  await page.waitForSelector('#kmList', { timeout: 15000 });
  await sleep(400);
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
    // K1 收藏 → aria-pressed → 刷新保留
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    await openFirstPost(p1);
    const favBtn = p1.locator('.km-actions [data-km-toggle="fav"]').first();
    check('K1.1 详情页渲染收藏/待读操作条', await favBtn.isVisible());
    await favBtn.click();
    await sleep(300);
    const pressed1 = await favBtn.getAttribute('aria-pressed');
    await p1.reload({ waitUntil: 'load' });
    await p1.waitForSelector('.km-actions [data-km-toggle="fav"]', { timeout: 20000 });
    await sleep(400);
    const pressed2 = await p1.locator('.km-actions [data-km-toggle="fav"]').first().getAttribute('aria-pressed');
    check('K1.2 收藏状态切换并在刷新后保留', pressed1 === 'true' && pressed2 === 'true', pressed1 + '/' + pressed2);

    // K1.3 键盘 f 切换
    await p1.click('.article-detail-title');
    await p1.keyboard.press('f');
    await sleep(400);
    const pressed3 = await p1.locator('.km-actions [data-km-toggle="fav"]').first().getAttribute('aria-pressed');
    check('K1.3 键盘 f 可切换收藏', pressed3 === 'false', pressed3);

    // K2 知识页四个 tab + 收藏列表
    await gotoKnowledge(p1, 'favorites');
    const stats = await p1.locator('#kmStats').innerText();
    check('K2.1 知识页统计行可读', /收藏 \d+/.test(stats), stats);
    const tabs = await p1.locator('.km-tab').count();
    check('K2.2 四个管理 tab', tabs === 4, tabs);
    check('K2.3 收藏 tab 空状态（已取消收藏）', (await p1.locator('.km-empty').count()) === 1);

    // K3 待读 → tab 出现
    await p1.evaluate(() => { location.hash = '#/'; });
    await p1.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
    await openFirstPost(p1);
    await p1.locator('.km-actions [data-km-toggle="later"]').first().click();
    await sleep(400);
    await gotoKnowledge(p1, 'readlater');
    const laterItems = await p1.locator('.km-item').count();
    check('K3 待读加入后出现在待读 tab', laterItems >= 1, 'items=' + laterItems);

    // K4 浏览历史 + 删除历史
    await p1.evaluate(() => { location.hash = '#/'; });
    await p1.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
    await p1.locator('#app a[href^="#/post/"]').nth(1).click();
    await p1.waitForSelector('.article-detail-body', { timeout: 20000 });
    await sleep(500);
    await gotoKnowledge(p1, 'history');
    const histBefore = await p1.locator('.km-item').count();
    check('K4.1 浏览历史记录出现', histBefore >= 2, 'items=' + histBefore);
    await p1.locator('[data-km-remove="history"]').first().click();
    await sleep(600);
    const histAfter = await p1.locator('.km-item').count();
    const roomEmpty = (await p1.locator('.km-empty').count()) === 1;
    check('K4.2 删除历史后条目减少', histAfter < histBefore || roomEmpty, histBefore + '->' + histAfter);

    // K5 继续阅读：滚动后离开，出现并恢复位置
    await p1.evaluate(() => { location.hash = '#/'; });
    await p1.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
    await openFirstPost(p1);
    await p1.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
    await sleep(700);
    await p1.evaluate(() => { location.hash = '#/knowledge?tab=continue'; });
    await p1.waitForSelector('#kmList', { timeout: 15000 });
    await sleep(800);
    const contItems = await p1.locator('.km-item').count();
    check('K5.1 继续阅读出现', contItems >= 1, 'items=' + contItems);
    if (contItems) {
      await p1.locator('[data-km-resume]').first().click();
      await p1.waitForSelector('.article-detail-body', { timeout: 20000 });
      await sleep(900);
      const scrollY = await p1.evaluate(() => window.scrollY);
      check('K5.2 继续阅读恢复滚动位置', scrollY > 100, 'scrollY=' + Math.round(scrollY));
    } else {
      check('K5.2 继续阅读恢复滚动位置', false, 'no-item');
    }

    // K6 卡片操作不触发导航（首页卡片）
    await p1.evaluate(() => { location.hash = '#/'; });
    await p1.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
    await sleep(600);
    const cardBtn = p1.locator('#app [data-href^="#/post/"] [data-km-toggle="fav"]').first();
    const hasCardBtn = (await cardBtn.count()) > 0;
    if (hasCardBtn) {
      await cardBtn.click();
      await sleep(400);
      const hash = await p1.evaluate(() => location.hash);
      check('K6 卡片操作不引起错误导航', hash === '#/' || hash === '', 'hash=' + hash);
      await cardBtn.click();
      await sleep(200);
    } else {
      check('K6 卡片操作不引起错误导航', false, '未渲染卡片操作');
    }

    // K7 搜索结果个人操作
    await p1.fill('#searchInput', '模型');
    await sleep(700);
    const searchBtn = p1.locator('[data-search-result] [data-km-toggle="fav"]').first();
    const hasSearchBtn = (await searchBtn.count()) > 0;
    if (hasSearchBtn) {
      await searchBtn.click();
      await sleep(300);
      const hash = await p1.evaluate(() => location.hash);
      check('K7 搜索结果个人操作可用且不跳转', hash.indexOf('#/knowledge') !== 0 && hash.indexOf('#/post/') !== 0, 'hash=' + hash);
    } else {
      check('K7 搜索结果个人操作可用且不跳转', false, '未渲染搜索结果操作');
    }

    // K8 深链接：含中文/空格/竖线的课程 ID
    const courseId = await p1.evaluate(() => {
      const list = (typeof COURSES !== 'undefined' ? COURSES : []);
      const withNotes = list.find(c => typeof COURSE_NOTES !== 'undefined' && COURSE_NOTES[c.id]);
      return withNotes ? withNotes.id : (list[0] || {}).id || '';
    });
    if (courseId) {
      await p1.goto(base + PREFIX + '/index.html#/course/' + encodeURIComponent(courseId), { waitUntil: 'load', timeout: 60000 });
      await p1.waitForSelector('.course-detail-header', { timeout: 20000 });
      await p1.waitForSelector('.km-actions [data-km-toggle="fav"]', { timeout: 15000 });
      await p1.locator('.km-actions [data-km-toggle="fav"]').first().click();
      await sleep(400);
      await gotoKnowledge(p1, 'favorites');
      const courseRows = await p1.locator('.km-item-type').allInnerTexts();
      check('K8 特殊字符课程深链接可收藏并展示', courseRows.indexOf('课程') !== -1, courseId + ' / ' + courseRows.join(','));
    } else {
      check('K8 特殊字符课程深链接可收藏并展示', false, 'no-course');
    }

    // K9 导出结构
    const dump = await p1.evaluate(() => {
      return new Promise(resolve => {
        let captured = null;
        const orig = window.__downloadText;
        window.__downloadText = (text, name) => { captured = { text, name }; };
        document.getElementById('kmExport').click();
        setTimeout(() => {
          window.__downloadText = orig;
          if (!captured) return resolve({ ok: false });
          try {
            const data = JSON.parse(captured.text);
            resolve({ ok: true, kind: data.kind, version: data.schemaVersion, n: data.records.length, name: captured.name });
          } catch (e) { resolve({ ok: false, reason: e.message }); }
        }, 800);
      });
    });
    check('K9 JSON 导出包含 kind/schemaVersion/records', dump.ok && dump.kind === 'knowledge' && dump.version === 1 && dump.n >= 1 && /\.json$/.test(dump.name),
      JSON.stringify(dump));

    // K10 多标签同步
    const tab2 = await s1.ctx.newPage();
    await tab2.goto(base + PREFIX + '/index.html#/knowledge?tab=favorites', { waitUntil: 'load', timeout: 60000 });
    await tab2.waitForSelector('#kmList', { timeout: 20000 });
    await sleep(600);
    const before2 = await tab2.locator('.km-item').count();
    await p1.evaluate(() => { location.hash = '#/'; });
    await p1.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
    await openFirstPost(p1);
    await p1.locator('.km-actions [data-km-toggle="later"]').first().click();
    await sleep(300);
    await p1.locator('.km-actions [data-km-toggle="fav"]').first().click();
    await sleep(1200);
    const after2 = await tab2.locator('.km-item').count();
    check('K10 多标签页收藏同步', after2 > before2, before2 + '->' + after2);
    await tab2.close();

    // K11 移动端与深色（独立上下文，先产生一条收藏）
    const s3 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await openFirstPost(s3.page);
    await s3.page.locator('.km-actions [data-km-toggle="fav"]').first().click();
    await sleep(500);
    await gotoKnowledge(s3.page, 'favorites');
    const mobile = await s3.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      theme: document.documentElement.getAttribute('data-theme'),
      items: document.querySelectorAll('.km-item').length,
      tabsVisible: getComputedStyle(document.querySelector('.km-tabs')).display !== 'none'
    }));
    check('K11.1 移动端无横向溢出且 tab 可用', mobile.overflow && mobile.tabsVisible, JSON.stringify(mobile));
    check('K11.2 深色主题下知识页有内容', mobile.theme === 'dark' && mobile.items > 0, mobile.theme + '/' + mobile.items);
    await s3.ctx.close();

    // K12 存储不可用降级提示
    const s4 = await newSession(browser, base, {
      initScript: () => { try { Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }); } catch (e) { } }
    });
    await gotoKnowledge(s4.page, 'favorites');
    const banner = await s4.page.locator('.km-banner').count();
    check('K12 持久化不可用时显示降级提示', banner >= 1, 'banner=' + banner);
    await s4.ctx.close();

    // K13 离线访问知识中心（同一记录离线可读）
    const s5 = await newSession(browser, base, { sw: true });
    await s5.page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await s5.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 25000 });
    await s5.page.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
    await openFirstPost(s5.page);
    await s5.page.locator('.km-actions [data-km-toggle="fav"]').first().click();
    await sleep(500);
    await s5.ctx.setOffline(true);
    try {
      await s5.page.goto(base + PREFIX + '/index.html#/knowledge?tab=favorites', { waitUntil: 'load', timeout: 30000 });
      await s5.page.waitForSelector('#kmList', { timeout: 15000 });
      await sleep(600);
      const offlineItems = await s5.page.locator('.km-item').count();
      check('K13 离线可读取已保存的个人记录', offlineItems >= 1, 'items=' + offlineItems);
    } catch (e) {
      check('K13 离线可读取已保存的个人记录', false, e.message.split('\n')[0]);
    }
    await s5.ctx.setOffline(false);
    await s5.ctx.close();

    // K14 页面级错误
    check('K14 全流程无未处理运行时异常', s1.errors.length === 0, s1.errors.slice(0, 3).join(' | ') || 'none');
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
