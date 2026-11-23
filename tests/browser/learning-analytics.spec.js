#!/usr/bin/env node
'use strict';
/**
 * Batch 9E：真实浏览器下的学习统计验收
 *
 * 覆盖：深链接与刷新、空库、指标与数据层一致、类型/方向/分类分布、指标跳转与已完成筛选、
 * 分类新建重命名删除、收藏与批量变更自动刷新、多标签同步、导入后更新、
 * 390/768/1440 与深浅色、键盘操作、IndexedDB 降级、未来版本只读、读取失败不保留旧结果、
 * 离线统计页、三引擎代表性场景。
 *
 * 用法：node tests/browser/learning-analytics.spec.js
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
  return { ctx, page, errors };
}

async function gotoStats(page) {
  await page.evaluate(() => { location.hash = '#/knowledge?tab=stats'; });
  await page.waitForFunction(() => location.hash.indexOf('#/knowledge?tab=stats') === 0, null, { timeout: 15000 });
  await page.waitForSelector('.km-an, .km-an-error', { timeout: 25000 });
  await sleep(250);
}

function readMetric(page, label) {
  return page.evaluate(function (l) {
    const cards = Array.from(document.querySelectorAll('.km-metric'));
    for (const c of cards) {
      const lab = c.querySelector('.km-metric-label');
      if (lab && lab.textContent.trim() === l) {
        const raw = (c.querySelector('.km-metric-value') || {}).textContent || '';
        return { value: Number(raw.replace(/[^\d.]/g, '')), href: c.getAttribute('href') || '', raw: raw.trim() };
      }
    }
    return null;
  }, label);
}

async function waitForMetric(page, label, expected, timeout) {
  try {
    await page.waitForFunction(function (arg) {
      const cards = Array.from(document.querySelectorAll('.km-metric'));
      for (const c of cards) {
        const lab = c.querySelector('.km-metric-label');
        if (lab && lab.textContent.trim() === arg.label) {
          const raw = (c.querySelector('.km-metric-value') || {}).textContent || '';
          return Number(raw.replace(/[^\d.]/g, '')) === arg.value;
        }
      }
      return false;
    }, { label: label, value: expected }, { timeout: timeout || 9000 });
    return true;
  } catch (e) { return false; }
}

function readBars(page, sectionTitle) {
  return page.evaluate(function (title) {
    const blocks = Array.from(document.querySelectorAll('.km-an-block'));
    const block = blocks.filter(function (b) {
      const h = b.querySelector('.km-an-title');
      return h && h.textContent.trim() === title;
    })[0];
    if (!block) return null;
    return Array.from(block.querySelectorAll('.km-bar-row')).map(function (row) {
      return {
        label: ((row.querySelector('.km-bar-label') || {}).textContent || '').trim(),
        value: ((row.querySelector('.km-bar-value') || {}).textContent || '').trim()
      };
    });
  }, sectionTitle);
}

function sectionText(page, sectionTitle) {
  return page.evaluate(function (title) {
    const blocks = Array.from(document.querySelectorAll('.km-an-block'));
    const block = blocks.filter(function (b) {
      const h = b.querySelector('.km-an-title');
      return h && h.textContent.trim() === title;
    })[0];
    return block ? (block.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }, sectionTitle);
}

// 通过产品 API 制造真实数据（不是测试替身）
async function seed(page) {
  await page.evaluate(async () => {
    await Knowledge.recordView('post', 'vla-model-intro', { title: 'VLA模型入门：从RT-1到OpenVLA' });
    await Knowledge.recordView('post', 'rl-from-mdp-to-ppo', { title: '强化学习入门：从MDP到PPO' });
    await Knowledge.setFlag('post', 'vla-model-intro', 'fav', true);
    await Knowledge.setFlag('course', '本科课程|机器人与自动化-(CS422)', 'later', true);
    await Knowledge.setReadState('post', 'rl-from-mdp-to-ppo', 'done');
    await Knowledge.flushProgress();
  });
  await sleep(300);
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
    // ---------------------------------------------------------------- A 空库与深链接
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    await p1.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 60000 });
    await p1.waitForSelector('.km-an, .km-an-error', { timeout: 25000 });
    await sleep(300);
    const shell = await p1.evaluate(() => ({
      title: document.title,
      view: (document.querySelector('.km-page') || {}).getAttribute ? document.querySelector('.km-page').getAttribute('data-km-view') : '',
      listTabs: document.querySelectorAll('.km-tab').length,
      statsTabs: document.querySelectorAll('.km-tab-ext').length,
      statsSelected: (document.querySelector('.km-tab-ext') || {}).getAttribute
        ? document.querySelector('.km-tab-ext').getAttribute('aria-selected') : '',
      catBar: document.querySelectorAll('#kmCatBar').length,
      bulkToggle: document.querySelectorAll('#kmBulkToggle').length,
      metrics: document.querySelectorAll('.km-metric').length
    }));
    check('L1.1 深链接 #/knowledge?tab=stats 直接渲染统计视图',
      shell.view === 'stats' && /学习统计/.test(shell.title), shell.view + ' / ' + shell.title);
    check('L1.2 列表 tab 仍是 4 个，统计入口单独渲染',
      shell.listTabs === 4 && shell.statsTabs === 1 && shell.statsSelected === 'true',
      shell.listTabs + '/' + shell.statsTabs + '/' + shell.statsSelected);
    check('L1.3 统计视图不渲染分类条与批量入口',
      shell.catBar === 0 && shell.bulkToggle === 0, shell.catBar + '/' + shell.bulkToggle);
    check('L1.4 六个总览指标卡', shell.metrics === 6, shell.metrics);

    await p1.reload({ waitUntil: 'load' });
    await p1.waitForSelector('.km-an', { timeout: 25000 });
    await sleep(300);
    const afterReload = await p1.evaluate(() => ({
      hash: location.hash,
      view: (document.querySelector('.km-page') || {}).getAttribute('data-km-view'),
      metrics: document.querySelectorAll('.km-metric').length
    }));
    check('L1.5 刷新后仍停留在统计视图（深链接可恢复）',
      afterReload.hash.indexOf('tab=stats') !== -1 && afterReload.view === 'stats' && afterReload.metrics === 6,
      JSON.stringify(afterReload));

    const emptyLead = await p1.locator('.km-an-lead').innerText();
    const emptyMetrics = await Promise.all(['已浏览内容', '收藏', '待读', '阅读中', '已完成']
      .map(l => readMetric(p1, l)));
    check('L2.1 空库给出明确空状态文案',
      /还没有任何知识记录/.test(emptyLead), emptyLead.slice(0, 40));
    check('L2.2 空库所有计数为 0',
      emptyMetrics.every(m => m && m.value === 0), JSON.stringify(emptyMetrics.map(m => m && m.value)));
    const emptyTypeText = await sectionText(p1, '内容类型分布');
    const emptyDirText = await sectionText(p1, '技术方向分布');
    const emptyCatText = await sectionText(p1, '收藏分类');
    check('L2.3 空库各分布给出空状态而不是空白区块',
      /还没有内容记录/.test(emptyTypeText) && /没有可归类|未分类/.test(emptyDirText) && /还没有收藏/.test(emptyCatText),
      emptyTypeText.slice(0, 20) + ' | ' + emptyDirText.slice(0, 20) + ' | ' + emptyCatText.slice(0, 20));
    check('L2.4 空库无未捕获异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');

    // ---------------------------------------------------------------- B 指标与数据层一致
    await seed(p1);
    await p1.evaluate(() => { location.hash = '#/'; });
    await p1.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
    await gotoStats(p1);
    const expected = await p1.evaluate(async () => {
      const rows = await Knowledge.list({});
      const seen = {};
      const uniq = rows.filter(function (r) {
        const k = r.type + ':' + r.refId;
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
      return {
        records: uniq.length,
        viewed: uniq.filter(r => r.lastSeenAt > 0).length,
        fav: uniq.filter(r => r.fav).length,
        later: uniq.filter(r => r.later).length,
        reading: uniq.filter(r => r.readState === 'reading').length,
        done: uniq.filter(r => r.readState === 'done').length,
        favLater: uniq.filter(r => r.fav && r.later).length,
        category: (await Knowledge.categories()).length
      };
    });
    const shown = {
      viewed: await readMetric(p1, '已浏览内容'),
      fav: await readMetric(p1, '收藏'),
      later: await readMetric(p1, '待读'),
      reading: await readMetric(p1, '阅读中'),
      done: await readMetric(p1, '已完成')
    };
    check('L3.1 已浏览数 = 数据层 lastSeenAt>0 去重数',
      shown.viewed.value === expected.viewed && expected.viewed === 2, shown.viewed.value + '/' + expected.viewed);
    check('L3.2 收藏 / 待读 / 已完成与数据层一致',
      shown.fav.value === expected.fav && shown.later.value === expected.later &&
      shown.done.value === expected.done && expected.fav === 1 && expected.later === 1 && expected.done === 1,
      [shown.fav.value, shown.later.value, shown.done.value].join('/') + ' vs ' + [expected.fav, expected.later, expected.done].join('/'));
    check('L3.3 阅读中为 0（没有 5%–95% 的进度）', shown.reading.value === expected.reading && expected.reading === 0);
    const rate = await readMetric(p1, '文章完成率');
    check('L3.4 完成率 = 已完成文章 / 已浏览文章（1/2 = 50%）', rate.value === 50, rate.raw);
    const overviewNote = await sectionText(p1, '总览');
    check('L3.5 总览说明收藏与待读可以重叠',
      /同时属于两者/.test(overviewNote) && /不能相加/.test(overviewNote), overviewNote.slice(0, 60));

    // ---------------------------------------------------------------- C 分布
    const typeBars = await readBars(p1, '内容类型分布');
    check('L4.1 内容类型分布按真实类型拆分',
      typeBars && typeBars.some(b => b.label === '文章' && /^2/.test(b.value)) &&
      typeBars.some(b => b.label === '课程' && /^1/.test(b.value)),
      JSON.stringify(typeBars));

    const dirBars = await readBars(p1, '技术方向分布');
    const roboticsBar = (dirBars || []).filter(b => b.label === '机器人与具身智能')[0];
    const aiBar = (dirBars || []).filter(b => b.label === '人工智能与机器学习')[0];
    check('L4.2 方向只按元数据归类：机器人方向 2 条',
      !!roboticsBar && /^2/.test(roboticsBar.value), JSON.stringify(dirBars));
    check('L4.3 一条内容可命中多个方向（AI 方向 2 条）',
      !!aiBar && /^2/.test(aiBar.value), JSON.stringify(dirBars));
    const dirSection = await sectionText(p1, '技术方向分布');
    check('L4.4 说明方向计数之和可以大于唯一内容数',
      /多/.test(dirSection) || /一条内容可属于多个方向/.test(dirSection), dirSection.slice(0, 80));

    const recentDirs = await readBars(p1, '最近接触的技术方向');
    check('L4.5 最近方向只统计 30 天窗口内浏览过的内容',
      (await sectionText(p1, '最近接触的技术方向')).indexOf('最近 30 天') !== -1 && Array.isArray(recentDirs),
      JSON.stringify(recentDirs));

    const catBars = await readBars(p1, '收藏分类');
    check('L4.6 收藏分类分布包含默认分类且计数为 1',
      catBars && catBars.some(b => b.label === '默认分类' && /^1/.test(b.value)), JSON.stringify(catBars));

    const recentText = await sectionText(p1, '最近浏览');
    check('L4.7 最近浏览包含真实标题且可点击',
      /VLA模型入门/.test(recentText) && (await p1.locator('.km-an-row-link').count()) >= 2,
      recentText.slice(0, 60));
    const recentHref = await p1.locator('.km-an-row-link').first().getAttribute('href');
    check('L4.8 最近浏览链接指向内容真实目标', /^#\/(post|course|paper|project)\//.test(recentHref || ''), recentHref);

    // ---------------------------------------------------------------- D 指标跳转与筛选
    const favHref = (await readMetric(p1, '收藏')).href;
    const doneHref = (await readMetric(p1, '已完成')).href;
    check('L5.1 收藏/待读/阅读中/已浏览指标链接到现有列表',
      /tab=favorites/.test(favHref) && /tab=readlater/.test((await readMetric(p1, '待读')).href) &&
      /tab=continue/.test((await readMetric(p1, '阅读中')).href) &&
      /tab=history/.test((await readMetric(p1, '已浏览内容')).href),
      favHref);
    check('L5.2 已完成链接到已完成筛选视图', /tab=history/.test(doneHref) && /state=done/.test(doneHref), doneHref);

    await p1.locator('.km-metric', { hasText: '收藏' }).first().click();
    await sleep(500);
    const favHash = await p1.evaluate(() => location.hash);
    const favItems = await p1.locator('#kmList .km-item').count();
    check('L5.3 点击收藏指标跳到收藏列表且能看到条目',
      /tab=favorites/.test(favHash) && favItems === 1, favHash + ' items=' + favItems);

    await gotoStats(p1);
    await p1.evaluate(() => { location.hash = '#/knowledge?tab=history&state=done'; });
    await p1.waitForFunction(() => location.hash.indexOf('state=done') !== -1, null, { timeout: 15000 });
    await sleep(700);
    const doneView = await p1.evaluate(() => ({
      items: document.querySelectorAll('#kmList .km-item').length,
      line: (document.getElementById('kmStats') || {}).textContent || ''
    }));
    check('L5.4 已完成筛选只显示 done 条目',
      doneView.items === 1 && /只看已完成/.test(doneView.line), JSON.stringify(doneView));
    const doneType = await p1.locator('#kmList .km-item-type').first().innerText();
    check('L5.5 已完成筛选包含跨类型内容类型标签', doneType.trim().length > 0, doneType);

    // ---------------------------------------------------------------- E 分类联动
    const catNew = await p1.evaluate(async () => {
      const r = await Knowledge.addCategory('待复习');
      if (!r.ok) return { ok: false, reason: r.reason };
      const key = 'post:vla-model-intro';
      const m = await Knowledge.assignCategory(key, r.category.id);
      return { ok: m.ok, id: r.category.id, name: r.category.name };
    });
    await sleep(400);
    await gotoStats(p1);
    const catBars2 = await readBars(p1, '收藏分类');
    check('L6.1 新建分类后统计分布立即出现该分类',
      catNew.ok && catBars2.some(b => b.label === '待复习' && /^1/.test(b.value)),
      JSON.stringify(catBars2));

    const renamed = await p1.evaluate(async id => {
      const r = await Knowledge.renameCategory(id, '重点复习');
      return { ok: r.ok };
    }, catNew.id);
    await sleep(300);
    await gotoStats(p1);
    const catBars3 = await readBars(p1, '收藏分类');
    check('L6.2 分类重命名后统计跟随新名称',
      renamed.ok && catBars3.some(b => b.label === '重点复习' && /^1/.test(b.value)),
      JSON.stringify(catBars3));

    const removed = await p1.evaluate(async id => {
      const r = await Knowledge.removeCategory(id);
      return { ok: r.ok };
    }, catNew.id);
    await sleep(300);
    await gotoStats(p1);
    const catBars4 = await readBars(p1, '收藏分类');
    check('L6.3 删除分类后归属回到默认分类',
      removed.ok && catBars4.some(b => b.label === '默认分类' && /^1/.test(b.value)) &&
      !catBars4.some(b => b.label === '重点复习'),
      JSON.stringify(catBars4));

    // ---------------------------------------------------------------- F 变更后自动刷新
    const beforeLater = (await readMetric(p1, '待读')).value;
    await p1.evaluate(async () => {
      await Knowledge.recordView('post', 'ml-fundamentals-overview', { title: '机器学习入门：从线性回归到深度学习' });
      await Knowledge.setFlag('post', 'ml-fundamentals-overview', 'later', true);
    });
    const laterGrew = await waitForMetric(p1, '待读', beforeLater + 1);
    check('L7.1 待读变更后统计页自动刷新（无需重新进入路由）', laterGrew, beforeLater + '->' + (beforeLater + 1));

    const beforeDone = (await readMetric(p1, '已完成')).value;
    await p1.evaluate(async () => {
      await Knowledge.bulk(['post:ml-fundamentals-overview'], 'read-done');
    });
    const doneGrew = await waitForMetric(p1, '已完成', beforeDone + 1);
    check('L7.2 批量标记已读后统计自动刷新', doneGrew, beforeDone + '->' + (beforeDone + 1));

    const beforeFav = (await readMetric(p1, '收藏')).value;
    await p1.evaluate(async () => {
      await Knowledge.setFlag('post', 'rl-from-mdp-to-ppo', 'fav', true);
    });
    const favGrew = await waitForMetric(p1, '收藏', beforeFav + 1);
    check('L7.3 收藏变更后统计自动刷新', favGrew, beforeFav + '->' + (beforeFav + 1));

    // 多标签页同步
    const tabB = await s1.ctx.newPage();
    await tabB.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 60000 });
    await tabB.waitForSelector('.km-an', { timeout: 25000 });
    await sleep(400);
    const bBefore = (await readMetric(tabB, '收藏')).value;
    await p1.evaluate(async () => {
      await Knowledge.setFlag('post', 'sim-to-real-gap', 'fav', true);
    });
    let synced = false;
    try {
      await tabB.waitForFunction(function (arg) {
        const cards = Array.from(document.querySelectorAll('.km-metric'));
        for (const c of cards) {
          const lab = c.querySelector('.km-metric-label');
          if (lab && lab.textContent.trim() === '收藏') {
            const raw = (c.querySelector('.km-metric-value') || {}).textContent || '';
            return Number(raw.replace(/[^\d.]/g, '')) === arg;
          }
        }
        return false;
      }, bBefore + 1, { timeout: 12000 });
      synced = true;
    } catch (e) { synced = false; }
    check('L8.1 其他标签页收藏后统计页自动同步', synced, bBefore + '->' + (bBefore + 1));
    await tabB.close();

    // 导入 → 统计更新
    const beforeImport = (await readMetric(p1, '已浏览内容')).value;
    const imported = await p1.evaluate(async () => {
      const payload = {
        app: 'ericzhao-blog', kind: 'knowledge', schemaVersion: 2, exportedAt: new Date().toISOString(),
        persistence: 'indexeddb', source: 'database', degraded: false, complete: true, warning: '',
        categories: [{ id: 'default', name: '默认分类', system: true }],
        records: [{
          key: 'post:deep-learning-in-slam', type: 'post', refId: 'deep-learning-in-slam', title: '深度学习在SLAM中的应用',
          fav: 1, favAt: Date.now(), favCat: 'default', later: 0, laterAt: 0,
          readState: 'none', progress: 0, firstSeenAt: Date.now() - 5000, lastSeenAt: Date.now() - 5000,
          doneAt: 0, updatedAt: Date.now()
        }]
      };
      const v = Knowledge.validateImport(payload, {});
      if (!v.ok) return { ok: false, errors: v.errors };
      const r = await Knowledge.applyImport(v.payload, { mode: 'merge', resolve: () => true });
      return { ok: r.ok, imported: r.imported };
    });
    const importGrew = await waitForMetric(p1, '已浏览内容', beforeImport + 1, 12000);
    check('L9.1 导入成功后统计立即更新',
      imported.ok && imported.imported === 1 && importGrew, JSON.stringify(imported));

    // ---------------------------------------------------------------- G 视口 / 主题 / 键盘
    const s2 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await seed(s2.page);
    await s2.page.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 60000 });
    await s2.page.waitForSelector('.km-an', { timeout: 25000 });
    await sleep(400);
    const mobile = await s2.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      theme: document.documentElement.getAttribute('data-theme'),
      metrics: document.querySelectorAll('.km-metric').length,
      bars: document.querySelectorAll('.km-bar-row').length,
      bg: getComputedStyle(document.body).backgroundColor
    }));
    check('L10.1 390px 深色主题无横向溢出',
      mobile.overflow && mobile.metrics === 6 && mobile.bars > 0, JSON.stringify(mobile));
    check('L10.2 深色主题确实生效（body 背景为深色）',
      mobile.theme === 'dark' && /rgb\((\d+), (\d+), (\d+)\)/.test(mobile.bg) &&
      (function () {
        const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(mobile.bg);
        return m && Number(m[1]) < 80;
      })(), mobile.theme + ' ' + mobile.bg);
    await s2.ctx.close();

    const s3 = await newSession(browser, base, { viewport: { width: 768, height: 1024 } });
    await s3.page.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 60000 });
    await s3.page.waitForSelector('.km-an', { timeout: 25000 });
    await sleep(300);
    const tablet = await s3.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      cols: getComputedStyle(document.querySelector('.km-metric-grid')).gridTemplateColumns.split(' ').length,
      metrics: document.querySelectorAll('.km-metric').length
    }));
    check('L10.3 768px 无溢出且指标卡为两列',
      tablet.overflow && tablet.cols === 2 && tablet.metrics === 6, JSON.stringify(tablet));

    // 键盘：tab 链接与指标卡都能用键盘激活
    await s3.page.locator('.km-tab-ext').focus();
    await s3.page.keyboard.press('Enter');
    await s3.page.waitForSelector('.km-an', { timeout: 25000 });
    await sleep(300);
    const kbHash = await s3.page.evaluate(() => location.hash);
    check('L11.1 统计入口可键盘激活', /tab=stats/.test(kbHash), kbHash);
    await s3.page.locator('.km-metric').nth(1).focus();
    await s3.page.keyboard.press('Enter');
    await sleep(600);
    const kbHash2 = await s3.page.evaluate(() => location.hash);
    check('L11.2 指标卡可键盘激活并跳转列表', /tab=favorites/.test(kbHash2), kbHash2);

    const s4 = await newSession(browser, base, { viewport: { width: 1440, height: 900 } });
    await s4.page.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 60000 });
    await s4.page.waitForSelector('.km-an', { timeout: 25000 });
    await sleep(300);
    const desktop = await s4.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      cols: getComputedStyle(document.querySelector('.km-metric-grid')).gridTemplateColumns.split(' ').length,
      heading: document.querySelectorAll('.km-an-title').length
    }));
    check('L10.4 1440px 无溢出且指标卡为多列',
      desktop.overflow && desktop.cols >= 3 && desktop.heading >= 7, JSON.stringify(desktop));
    await s4.ctx.close();

    // ---------------------------------------------------------------- H 降级 / 未来版本 / 读取失败
    const s5 = await newSession(browser, base, {
      initScript: () => { try { Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }); } catch (e) { } }
    });
    await s5.page.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 60000 });
    await s5.page.waitForSelector('.km-an, .km-an-error', { timeout: 25000 });
    await sleep(500);
    const degraded = await s5.page.evaluate(() => ({
      banner: document.querySelectorAll('.km-banner').length,
      rendered: document.querySelectorAll('.km-metric').length,
      scope: Array.from(document.querySelectorAll('.km-an-scope dd')).map(d => d.textContent).join(' '),
      errors: document.querySelectorAll('.km-an-error').length
    }));
    check('L12.1 IndexedDB 不可用仍只读渲染统计',
      degraded.rendered === 6 && degraded.errors === 0, JSON.stringify(degraded));
    check('L12.2 降级时显示持久化提示与口径说明',
      degraded.banner >= 1 && /内存降级/.test(degraded.scope), degraded.banner + ' / ' + degraded.scope.slice(0, 40));
    await s5.ctx.close();

    // 未来版本（schemaVersion = 3）：只读统计仍可用，写入被拒
    {
      const ctx = await browser.newContext({ serviceWorkers: 'block' });
      await ctx.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith('http://127.0.0.1')) return route.continue();
        return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
      });
      await ctx.route('**/js/app.js*', route => route.abort());
      const page = await ctx.newPage();
      await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
      const built = await page.evaluate(() => new Promise(resolve => {
        const req = indexedDB.open('blog-knowledge', 1);
        req.onupgradeneeded = function () {
          const db = req.result;
          if (!db.objectStoreNames.contains('records')) {
            const s = db.createObjectStore('records', { keyPath: 'key' });
            s.createIndex('by_type', 'type');
          }
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        };
        req.onerror = function () { resolve({ ok: false }); };
        req.onsuccess = function () {
          const db = req.result;
          const tx = db.transaction(['records', 'meta'], 'readwrite');
          tx.objectStore('records').put({
            key: 'post:future1', type: 'post', refId: 'future1', title: '未来版本库里的收藏',
            fav: 1, favAt: 1000, favCat: 'default', later: 0, laterAt: 0,
            readState: 'none', progress: 0, firstSeenAt: 900, lastSeenAt: 1000,
            doneAt: 0, updatedAt: 1000
          });
          tx.objectStore('meta').put({ k: 'schemaVersion', v: 3 });
          tx.oncomplete = function () { db.close(); resolve({ ok: true }); };
          tx.onerror = function () { resolve({ ok: false }); };
        };
      }));
      await ctx.unroute('**/js/app.js*');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.Knowledge && Knowledge.status().ready, null, { timeout: 20000 });
      await page.evaluate(() => { location.hash = '#/knowledge?tab=stats'; });
      await page.waitForSelector('.km-an, .km-an-error', { timeout: 25000 });
      await sleep(600);
      const future = await page.evaluate(async () => {
        const st = Knowledge.status();
        const w = await Knowledge.setFlag('post', 'future1', 'later', true);
        return {
          future: st.migration.future,
          blocked: !!Knowledge.writeBlockedReason(),
          writeResult: w === null,
          viewed: (document.querySelectorAll('.km-metric-value')[0] || {}).textContent,
          scope: ((document.querySelector('.km-an-scope') || {}).textContent || '').replace(/\s+/g, ' '),
          metrics: document.querySelectorAll('.km-metric').length,
          errors: document.querySelectorAll('.km-an-error').length
        };
      });
      check('L13.1 未来版本数据库迁移被识别（future=true）', built.ok === true && future.future === true,
        JSON.stringify({ built: built.ok, future: future.future }));
      check('L13.2 未来版本仍可只读查看统计',
        future.metrics === 6 && future.errors === 0 && Number(String(future.viewed).replace(/[^\d.]/g, '')) === 1,
        JSON.stringify({ metrics: future.metrics, viewed: future.viewed }));
      check('L13.3 统计页明确说明写入已停用',
        /只读限制/.test(future.scope) && /写入已停用/.test(future.scope) && /检测到版本 3/.test(future.scope) &&
        future.blocked === true && future.writeResult === true,
        JSON.stringify({ blocked: future.blocked, writeResult: future.writeResult, scope: future.scope.slice(0, 90) }));
      await ctx.close();
    }

    // 读取失败：不保留上一份结果
    {
      const s6 = await newSession(browser, base);
      await seed(s6.page);
      await gotoStats(s6.page);
      const beforeFail = await s6.page.locator('.km-metric').count();
      await s6.page.evaluate(async () => {
        Knowledge._injectBackend({
          kind: 'memory',
          get: () => Promise.resolve(null),
          getAll: () => Promise.reject(new Error('注入的读取失败')),
          mutate: () => Promise.resolve(null),
          getMeta: () => Promise.resolve(null),
          setMeta: () => Promise.resolve(),
          clear: () => Promise.resolve()
        });
      });
      await sleep(400);
      await s6.page.evaluate(() => { location.hash = '#/'; });
      await sleep(300);
      await gotoStats(s6.page);
      const failed = await s6.page.evaluate(() => ({
        error: document.querySelectorAll('.km-an-error').length,
        metrics: document.querySelectorAll('.km-metric').length,
        retry: document.querySelectorAll('#kmAnRetry').length,
        text: (document.querySelector('#kmList') || {}).textContent || ''
      }));
      check('L14.1 读取失败显示错误且不保留旧统计',
        beforeFail === 6 && failed.error === 1 && failed.metrics === 0,
        beforeFail + '->' + failed.metrics);
      check('L14.2 错误状态说明已停止显示上一次结果并提供重试',
        /已停止显示上一次的结果/.test(failed.text) && failed.retry === 1, failed.text.slice(0, 50));
      await s6.ctx.close();
    }

    // ---------------------------------------------------------------- I 离线
    {
      const s7 = await newSession(browser, base, { sw: true });
      await s7.page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
      await s7.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
      await seed(s7.page);
      await s7.page.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 60000 });
      await s7.page.waitForSelector('.km-an', { timeout: 25000 });
      await sleep(600);
      const onlineMetrics = await s7.page.locator('.km-metric').count();
      await s7.ctx.setOffline(true);
      let offlineOk = false, offlineMetrics = 0;
      try {
        await s7.page.goto(base + PREFIX + '/index.html#/knowledge?tab=stats', { waitUntil: 'load', timeout: 30000 });
        await s7.page.waitForSelector('.km-an, .km-an-error', { timeout: 20000 });
        await sleep(600);
        offlineMetrics = await s7.page.locator('.km-metric').count();
        offlineOk = offlineMetrics === 6;
      } catch (e) { offlineOk = false; }
      check('L15.1 离线仍可打开统计页并渲染指标',
        onlineMetrics === 6 && offlineOk, onlineMetrics + '/' + offlineMetrics);
      const offlineFav = offlineOk ? await readMetric(s7.page, '收藏') : null;
      check('L15.2 离线统计值来自本地记录而非空数据',
        !!offlineFav && offlineFav.value >= 1, offlineFav ? String(offlineFav.value) : 'n/a');
      await s7.ctx.setOffline(false);
      await s7.ctx.close();
    }

    // ---------------------------------------------------------------- J 三引擎代表性场景
    const engines = [
      { name: 'firefox', launcher: firefox },
      { name: 'webkit', launcher: webkit }
    ];
    for (const eng of engines) {
      let eb = null;
      try {
        eb = await eng.launcher.launch({ headless: true });
      } catch (e) {
        console.log('SKIP ' + eng.name + ' 不可用：' + String(e.message).split('\n')[0]);
        continue;
      }
      try {
        const ctx = await eb.newContext({ serviceWorkers: 'block', viewport: { width: 768, height: 1024 } });
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
          await Knowledge.recordView('post', 'slam-overview-filtering-to-graph', { title: 'SLAM技术全景：从滤波到图优化' });
          await Knowledge.setFlag('post', 'slam-overview-filtering-to-graph', 'fav', true);
        });
        await page.evaluate(() => { location.hash = '#/knowledge?tab=stats'; });
        await page.waitForSelector('.km-an, .km-an-error', { timeout: 25000 });
        await sleep(500);
        const r = await page.evaluate(() => ({
          metrics: document.querySelectorAll('.km-metric').length,
          bars: document.querySelectorAll('.km-bar-row').length,
          overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
          errors: document.querySelectorAll('.km-an-error').length
        }));
        check('L16.1 ' + eng.name + ' 渲染统计页（6 指标 + 分布）',
          r.metrics === 6 && r.bars > 0 && r.errors === 0, JSON.stringify(r));
        check('L16.2 ' + eng.name + ' 无横向溢出且无运行时异常',
          r.overflow && errs.length === 0, (errs.slice(0, 2).join(' | ') || 'none'));
        await ctx.close();
      } catch (e) {
        check('L16.1 ' + eng.name + ' 渲染统计页（6 指标 + 分布）', false, String(e.message).split('\n')[0]);
      } finally {
        await eb.close();
      }
    }

    check('L17 主流程无未捕获运行时异常', s1.errors.length === 0, s1.errors.slice(0, 3).join(' | ') || 'none');
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
