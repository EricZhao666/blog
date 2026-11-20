#!/usr/bin/env node
'use strict';
/**
 * Batch 9B-1：真实 Chromium 下的"相关阅读"验收
 *
 * 覆盖：区块渲染（3–5 项）/ 类型-标题-理由 / 链接可跳转 / 与知识管理按钮兼容
 * （不重复注册、点击不触发卡片导航）/ 课程页同分类推荐 / 快速路由切换 /
 * 元数据加载失败降级 / 手机与深色主题 / 离线降级 / 无运行时异常。
 *
 * 用法：node tests/browser/related-content.spec.js
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
  if (o.blockCourses) await ctx.route('**/js/courses.js*', route => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible', timeout: 30000 });
  return { ctx, page, errors };
}

// 打开指定文章并等待相关阅读区块填充完成
async function openPost(page, id) {
  await page.evaluate(x => { location.hash = '#/post/' + x; }, id);
  await page.waitForSelector('.article-detail-body', { timeout: 20000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-related]');
    if (!s) return false;
    return s.getAttribute('data-related-filled') === '1' || s.hidden === true;
  }, null, { timeout: 20000 });
  await sleep(200);
}

async function readRelated(page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-related]');
    if (!box) return { exists: false };
    const items = Array.from(box.querySelectorAll('.related-reading-item')).map(li => {
      const a = li.querySelector('.related-card-title');
      const reason = li.querySelector('.related-reason');
      const type = li.querySelector('.related-type');
      return {
        title: a ? a.textContent : '',
        href: a ? a.getAttribute('href') : '',
        reason: reason ? reason.textContent : '',
        type: type ? type.textContent : '',
        kmButtons: li.querySelectorAll('[data-km-toggle]').length
      };
    });
    return {
      exists: true,
      hidden: box.hidden,
      source: box.getAttribute('data-related'),
      count: items.length,
      items: items,
      html: box.innerHTML
    };
  });
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
    // R1 文章详情页的相关阅读区块
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    await openPost(p1, 'vla-model-intro');
    const r1 = await readRelated(p1);
    check('R1.1 文章详情页渲染"相关阅读"区块', r1.exists && r1.hidden === false &&
      r1.source === 'post:vla-model-intro', JSON.stringify({ hidden: r1.hidden, src: r1.source }));
    check('R1.2 有效推荐数量在 1–5 之间（不足不硬凑）', r1.count >= 1 && r1.count <= 5, 'count=' + r1.count);
    check('R1.3 每项都含类型 / 标题 / 理由',
      r1.items.every(i => i.type && i.title && i.reason), JSON.stringify(r1.items[0] || {}));
    check('R1.4 推荐链接都是站内真实路由',
      r1.items.every(i => /^#\/(post\/|course\/|codelib\/|papers\?kind=(paper|material)&target=)/.test(i.href)),
      r1.items.map(i => i.href).join(' | '));
    check('R1.5 不推荐当前文章自身', r1.items.every(i => i.href !== '#/post/vla-model-intro'),
      r1.items.map(i => i.href).join(' | '));
    check('R1.6 显式关联（正文链接的代码库）排在首位',
      r1.items[0] && r1.items[0].reason.indexOf('正文已关联此内容') !== -1,
      r1.items[0] && r1.items[0].reason);

    // R2 与知识管理按钮兼容
    check('R2.1 推荐卡片复用现有收藏/待读按钮（每卡 2 个）',
      r1.items.every(i => i.kmButtons === 2), r1.items.map(i => i.kmButtons).join(','));
    const targetHref = r1.items[0].href;
    const hashBefore = await p1.evaluate(() => location.hash);
    await p1.locator('.related-reading-item [data-km-toggle="fav"]').first().click();
    await sleep(350);
    const afterFav = await p1.evaluate(() => location.hash);
    const pressed = await p1.locator('.related-reading-item [data-km-toggle="fav"]').first().getAttribute('aria-pressed');
    check('R2.2 点击收藏不触发卡片跳转', afterFav === hashBefore, hashBefore + ' -> ' + afterFav);
    check('R2.3 收藏状态即时同步（aria-pressed=true）', pressed === 'true', pressed);

    // R2.4 点击标题正常跳转
    await p1.locator('.related-reading-item .related-card-title').first().click();
    await p1.waitForFunction(() => location.hash.indexOf('#/post/') === 0 || location.hash.indexOf('#/course/') === 0 ||
      location.hash.indexOf('#/codelib/') === 0 || location.hash.indexOf('#/papers?') === 0, null, { timeout: 15000 });
    const landed = await p1.evaluate(() => location.hash);
    check('R2.4 点击推荐标题能跳到目标路由', landed === targetHref, targetHref + ' / ' + landed);

    // R3 快速路由切换：推荐必须跟随当前内容，不残留上一篇的结果
    await p1.evaluate(() => { location.hash = '#/post/slam-overview-filtering-to-graph'; });
    await p1.evaluate(() => { location.hash = '#/post/rl-from-mdp-to-ppo'; });
    await openPost(p1, 'rl-from-mdp-to-ppo');
    const r3 = await readRelated(p1);
    check('R3.1 快速切换后挂载点属于当前文章', r3.source === 'post:rl-from-mdp-to-ppo', r3.source);
    check('R3.2 快速切换后理由与当前文章一致（同系列强化学习）',
      r3.items.some(i => i.reason.indexOf('强化学习系列') !== -1),
      r3.items.map(i => i.reason).join(' | ').slice(0, 120));
    check('R3.3 不残留上一篇的推荐标题',
      r3.html.indexOf('SLAM技术全景') === -1, '');

    // R4 课程详情页：同分类推荐
    await p1.evaluate(() => { location.hash = '#/course/' + encodeURIComponent('本科课程|机器人与自动化-(CS422)'); });
    await p1.waitForSelector('.course-detail', { timeout: 20000 });
    await p1.waitForFunction(() => {
      const s = document.querySelector('[data-related]');
      return !!s && (s.getAttribute('data-related-filled') === '1' || s.hidden === true);
    }, null, { timeout: 20000 });
    const r4 = await readRelated(p1);
    check('R4.1 课程详情页渲染相关阅读', r4.exists && r4.hidden === false && r4.count >= 1,
      JSON.stringify({ count: r4.count, src: r4.source }));
    check('R4.2 课程页推荐使用课程真实路由且同分类',
      r4.items.every(i => i.href.indexOf('#/course/') === 0) &&
      r4.items.some(i => i.reason.indexOf('同分类') !== -1),
      r4.items.map(i => i.reason).join(' | ').slice(0, 120));

    check('R4.3 全流程无未处理运行时异常', s1.errors.length === 0, s1.errors.slice(0, 3).join(' | ') || 'none');
    await s1.ctx.close();

    // R5 元数据加载失败：文章内推荐仍可用，页面不报错
    const s2 = await newSession(browser, base, { blockCourses: true });
    const p2 = s2.page;
    await openPost(p2, 'embodied-ai-notes');
    const r5 = await readRelated(p2);
    check('R5.1 课程元数据加载失败时仍渲染文章间推荐',
      r5.exists && r5.count >= 1 && r5.items.every(i => i.href.indexOf('#/course/') !== 0),
      JSON.stringify({ count: r5.count }));
    check('R5.2 加载失败不产生未捕获异常', s2.errors.length === 0, s2.errors.slice(0, 2).join(' | ') || 'none');
    check('R5.3 正文与操作条不受影响',
      await p2.locator('.article-detail-body').isVisible() &&
      await p2.locator('.km-actions [data-km-toggle="fav"]').first().isVisible(), '');
    await s2.ctx.close();

    // R6 移动端 + 深色主题
    const s3 = await newSession(browser, base, { viewport: { width: 390, height: 780 }, colorScheme: 'dark' });
    const p3 = s3.page;
    await openPost(p3, 'industrial-protocols-notes');
    const r6 = await p3.evaluate(() => {
      const box = document.querySelector('[data-related]');
      if (!box) return null;
      const rect = box.getBoundingClientRect();
      const title = box.querySelector('.related-card-title');
      return {
        width: rect.width,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        color: title ? getComputedStyle(title).color : '',
        bg: getComputedStyle(document.body).backgroundColor,
        count: box.querySelectorAll('.related-reading-item').length
      };
    });
    check('R6.1 手机视口无横向溢出', r6 && r6.overflow <= 1 && r6.width > 0, JSON.stringify(r6));
    check('R6.2 深色主题下区块可见且文字有对比', r6 && r6.count >= 1 && r6.color !== r6.bg, JSON.stringify({ c: r6 && r6.color, bg: r6 && r6.bg }));
    await s3.ctx.close();

    // R7 离线降级：SW 控制下离线打开已访问过的文章，推荐仍渲染
    const s4 = await newSession(browser, base, { sw: true });
    const p4 = s4.page;
    let swReady = false;
    try {
      await p4.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 25000 });
      swReady = true;
    } catch (e) { swReady = false; }
    await openPost(p4, 'robot-grasping-survey');
    await sleep(800);
    const postHash = await p4.evaluate(() => location.hash);
    await s4.ctx.setOffline(true);
    let offlineOk = false;
    try {
      await p4.goto(base + PREFIX + '/index.html' + postHash, { waitUntil: 'load', timeout: 30000 });
      await p4.waitForSelector('.article-detail-body', { timeout: 20000 });
      await sleep(800);
      offlineOk = true;
    } catch (e) { offlineOk = false; }
    const r7 = offlineOk ? await readRelated(p4) : { exists: false };
    check('R7.1 离线打开文章仍渲染相关阅读', swReady && offlineOk && r7.exists && r7.count >= 1,
      JSON.stringify({ swReady, offlineOk, count: r7.count }));
    await s4.ctx.setOffline(false);
    await s4.ctx.close();
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
