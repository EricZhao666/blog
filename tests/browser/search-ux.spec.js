#!/usr/bin/env node
'use strict';
/**
 * Batch 8C-1：真实 Chromium 下的全站搜索 2.0 体验回归
 *
 * 覆盖：四类命中 / 标题高亮 / 摘要与正文片段 / 作者与资料类别 / XSS /
 * 稳定深链 / 前进后退 / 快速输入竞态 / 中文输入法 / 数据源失败重试 /
 * 移动端无横向溢出 / 首屏与搜索计算性能。
 *
 * 数据：公开产物 + 内存合成 papers.js Fixture（不访问私人 Zotero / Registry）。
 * 用法：node tests/browser/search-ux.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
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

// 论文 / 学习资料合成数据：稳定持久 ID + 恶意字符串，绝不依赖真实 Zotero 库
function papersJs() {
  const papers = [
    { id: 'paper-ux-alpha', title: '机器人步态控制 Alpha', authors: 'Alpha Author', category: '双足机器人',
      abstract: '机器人步态与势函数奖励的摘要内容，用于验证论文摘要搜索与片段展示。',
      url: '', type: 'preprint', date: '2024-01-01' },
    { id: 'paper-ux-beta', title: '<img src=x onerror=window.__xss=1> 特殊标题', authors: 'Beta Author',
      category: '未分类', abstract: '特殊摘要内容', url: '', type: 'preprint', date: '2024-02-02' }
  ];
  const materials = [
    { id: 'lm-ux-0001', name: '机器人资料.pdf', category: 'ANSYS仿真', subcategory: '有限元分析',
      type: 'PDF', size: 10, sizeFormatted: '10 B' },
    { id: 'lm-ux-0002', name: '特殊字符 <b>资料</b>.pdf', category: 'CAD建模', subcategory: '第一课',
      type: 'PDF', size: 20, sizeFormatted: '20 B' }
  ];
  return 'const PAPERS=' + JSON.stringify(papers) + ';\n' +
    'const PAPER_CATEGORIES={"双足机器人":{"count":1,"types":["preprint"]},"未分类":{"count":1,"types":["preprint"]}};\n' +
    'const LEARNING_MATERIALS=' + JSON.stringify(materials) + ';\n' +
    'const LEARN_CATEGORIES={};\n';
}

async function session(browser, base, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1280, height: 800 },
    serviceWorkers: 'block'
  });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible' });
  const timing = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n ? Math.round(n.domContentLoadedEventEnd) : -1;
  });
  return { ctx, page, errors, dialogs, timing };
}

async function search(page, text, waitMs) {
  await page.fill('#searchInput', text);
  await sleep(waitMs || 800);
}

(async () => {
  const { server, state } = createServer(ROOT, PREFIX);
  state.overrides['/js/papers.js'] = papersJs();
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

  try {
    // ---------------------------------------------------------- U1–U5 展示与四类命中
    {
      const s = await session(browser, base);
      await search(s.page, '机器人', 1100);
      const probe = await s.page.evaluate(() => ({
        sections: Array.prototype.map.call(document.querySelectorAll('.search-section-title'), n => n.textContent),
        titleMarks: document.querySelectorAll('#app .article-card-title mark.search-hit, #app .search-item-title mark.search-hit').length,
        snippets: document.querySelectorAll('#app .search-item-snippet').length,
        snippetHtml: (document.querySelector('#app .search-item-snippet') || {}).innerHTML || '',
        authors: Array.prototype.map.call(document.querySelectorAll('#app .search-paper-item .search-item-sub'), n => n.textContent),
        count: (document.querySelector('.search-results-count') || {}).textContent || '',
        sources: (document.querySelector('.search-sources-summary') || {}).textContent || ''
      }));
      const joined = probe.sections.join('|');
      check('U1 四类数据源都返回结果',
        /文章/.test(joined) && /课程/.test(joined) && /论文/.test(joined) && /学习资料/.test(joined), joined);
      check('U2 命中标题被高亮', probe.titleMarks >= 1, probe.titleMarks);
      check('U3 显示摘要 / 正文命中片段',
        probe.snippets >= 1 && /<mark/.test(probe.snippetHtml), probe.snippets);
      check('U4 论文显示作者与摘要片段',
        probe.authors.some(t => t.indexOf('Alpha Author') !== -1),
        probe.authors.slice(0, 3).join(' | '));
      check('U5 学习资料显示资料类别',
        probe.authors.some(t => /ANSYS仿真|有限元分析|CAD建模/.test(t)),
        probe.authors.slice(0, 4).join(' | '));
      check('U1b 明确列出已加载数据源', /已加载\s*5\/5\s*类/.test(probe.sources), probe.sources);
      check('U14 首屏 DCL 无明显回归', s.timing >= 0 && s.timing < 4000, s.timing + 'ms');
      const calc = await s.page.evaluate(() => {
        const t0 = performance.now();
        for (let i = 0; i < 100; i++) window.collectSearchResults('机器人');
        return Math.round(performance.now() - t0);
      });
      check('U14b 100 次搜索计算无明显卡顿（< 800ms）', calc < 800, calc + 'ms');
      check('U15 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- U6 XSS（查询与结果数据都净化）
    {
      const s = await session(browser, base);
      await search(s.page, '<img src=x onerror=window.__xss=1>', 800);
      const evil = await s.page.evaluate(() => ({
        nodes: document.querySelectorAll('#app img, #app script, #app [onerror]').length,
        xss: !!window.__xss,
        html: document.getElementById('app').innerHTML,
        count: (document.querySelector('.search-results-count') || {}).textContent || ''
      }));
      check('U6 恶意查询不创建元素 / 不执行脚本',
        evil.nodes === 0 && !evil.xss && s.dialogs.length === 0 && evil.html.indexOf('<img') === -1,
        'nodes=' + evil.nodes + ' dialogs=' + s.dialogs.length);
      check('U6 恶意查询被转义后显示', evil.count.indexOf('<img') !== -1 && evil.html.indexOf('&lt;img') !== -1);

      await search(s.page, '特殊', 700);
      const dataEvil = await s.page.evaluate(() => ({
        nodes: document.querySelectorAll('#app img, #app [onerror]').length,
        xss: !!window.__xss,
        html: document.getElementById('app').innerHTML
      }));
      check('U6b 结果数据里的恶意标题也被净化',
        dataEvil.nodes === 0 && !dataEvil.xss && dataEvil.html.indexOf('&lt;img') !== -1,
        'nodes=' + dataEvil.nodes);
      check('U6c 高亮仍使用安全 mark',
        (await s.page.locator('#app mark.search-hit').count()) >= 1 &&
        (await s.page.locator('#app mark.search-hit img').count()) === 0);
      await s.ctx.close();
    }

    // ---------------------------------------------------------- U7/U8 稳定深链
    {
      const s = await session(browser, base);
      await search(s.page, '机器人', 1000);
      const hrefs = await s.page.evaluate(() => Array.prototype.map.call(
        document.querySelectorAll('.search-paper-item[data-href]'), n => n.getAttribute('data-href')));
      const targets = hrefs.map(h => {
        const m = /target=([^&]+)/.exec(h || '');
        return m ? decodeURIComponent(m[1]) : '';
      }).filter(Boolean);
      check('U8 深链目标全部是持久 ID / 稳定键',
        hrefs.length > 0 && targets.every(t => !/^\d+$/.test(t)) &&
        targets.some(t => t.indexOf('lm-ux-') === 0), targets.slice(0, 4).join(' | '));

      const material = s.page.locator('.search-paper-item[data-href*="kind=material"]').filter({ hasText: '机器人资料' }).first();
      const mHref = await material.getAttribute('data-href');
      await material.click();
      await sleep(450);
      check('U7 点击资料进入 Batch 7B-2 稳定深链',
        mHref.indexOf('target=lm-ux-0001') !== -1 && s.page.url().indexOf('target=lm-ux-0001') !== -1,
        s.page.url());

      await s.page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
      await search(s.page, '机器人', 900);
      const paper = s.page.locator('.search-paper-item[data-href*="kind=paper"]').filter({ hasText: '机器人步态控制' }).first();
      const pHref = await paper.getAttribute('data-href');
      await paper.click();
      await sleep(450);
      check('U7b 点击论文进入持久 ID 深链',
        pHref.indexOf('target=paper-ux-alpha') !== -1 && s.page.url().indexOf('target=paper-ux-alpha') !== -1,
        s.page.url());
      await s.ctx.close();
    }

    // ---------------------------------------------------------- U9 前进 / 后退
    {
      const s = await session(browser, base);
      await search(s.page, '机器人', 900);
      await s.page.evaluate(() => { location.hash = '#/about'; });
      await sleep(350);
      check('U9 主动离开首页清空输入框', (await s.page.inputValue('#searchInput')) === '');
      await s.page.goBack();
      await sleep(600);
      check('U9 后退恢复搜索关键词', (await s.page.inputValue('#searchInput')) === '机器人');
      check('U9 后退恢复搜索结果',
        /找到\s*\d+\s*条/.test(await s.page.textContent('#app')));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- U10 快速输入竞态
    {
      state.delays['/data/search-index.json'] = 700;
      const s = await session(browser, base);
      await s.page.fill('#searchInput', '机器人');
      await sleep(70);
      await s.page.fill('#searchInput', '最终查询词XYZ');
      await sleep(1300);
      const q = await s.page.getAttribute('[data-search-root]', 'data-query');
      check('U10 只显示最新查询对应的结果',
        decodeURIComponent(q) === '最终查询词XYZ' &&
        (await s.page.textContent('#app')).indexOf('最终查询词XYZ') !== -1,
        q);
      check('U10 输入框保留最新输入', (await s.page.inputValue('#searchInput')) === '最终查询词XYZ');
      await s.ctx.close();
      delete state.delays['/data/search-index.json'];
    }

    // ---------------------------------------------------------- U11 中文输入法
    {
      const s = await session(browser, base);
      await search(s.page, '机器人', 900);
      const before = await s.page.evaluate(() => {
        const el = document.getElementById('searchInput');
        window.__imeNode = el;
        const q = document.querySelector('[data-search-root]').getAttribute('data-query');
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = '机器';
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return q;
      });
      await sleep(420);
      const during = await s.page.evaluate(() => ({
        same: window.__imeNode === document.getElementById('searchInput'),
        q: document.querySelector('[data-search-root]').getAttribute('data-query'),
        val: document.getElementById('searchInput').value
      }));
      check('U11 组合期间不重绘、输入框不被重建',
        during.same && during.q === before && during.val === '机器',
        JSON.stringify(during));
      await s.page.evaluate(() => {
        const el = document.getElementById('searchInput');
        el.value = '机器人控制';
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      await sleep(500);
      const after = await s.page.getAttribute('[data-search-root]', 'data-query');
      check('U11 组合结束后更新为最终查询', decodeURIComponent(after) === '机器人控制', after);
      await s.ctx.close();
    }

    // ---------------------------------------------------------- U12 数据源失败与重试
    {
      state.faults['/js/papers.js'] = 500;
      const s = await session(browser, base);
      await search(s.page, '机器人', 900);
      const failed = await s.page.evaluate(() => ({
        text: (document.querySelector('.search-sources-status') || {}).textContent || '',
        retry: !!document.querySelector('[data-retry-search-source="papers"]'),
        posts: document.querySelectorAll('#app .article-card').length
      }));
      check('U12 单源失败仍有其它类别结果', failed.posts > 0, failed.posts);
      check('U12 状态条标出失败并提供重试',
        /论文 \/ 学习资料 ⚠ 加载失败/.test(failed.text) && failed.retry, failed.text.slice(0, 80));
      delete state.faults['/js/papers.js'];
      await s.page.click('[data-retry-search-source="papers"]');
      await sleep(900);
      const recovered = await s.page.evaluate(() => ({
        text: (document.querySelector('.search-sources-status') || {}).textContent || '',
        papers: document.querySelectorAll('#app .search-paper-item').length
      }));
      check('U12 重试后数据源恢复',
        /论文 \/ 学习资料 ✓ 已加载/.test(recovered.text) && recovered.papers > 0,
        recovered.text.slice(0, 90));
      check('U12 无未捕获页面错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- U13 移动端无横向溢出
    {
      const s = await session(browser, base, { viewport: { width: 390, height: 844 } });
      await search(s.page, '机器人', 1000);
      const box = await s.page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        badges: document.querySelectorAll('.search-source-badge').length,
        snippets: document.querySelectorAll('.search-item-snippet').length
      }));
      check('U13 移动端无横向溢出', box.scrollWidth <= box.innerWidth + 1,
        box.scrollWidth + ' / ' + box.innerWidth);
      check('U13 状态条与片段在窄屏正常渲染', box.badges === 5 && box.snippets >= 1,
        'badges=' + box.badges + ' snippets=' + box.snippets);
      await s.ctx.close();
    }

    // ---------------------------------------------------------- U15 SW 缓存版本已升级
    {
      const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
      const ver = (/CACHE_VERSION = '([^']+)'/.exec(swSrc) || [])[1];
      check('U15 app.js / css 修改后 CACHE_VERSION 已递增',
        !!ver && ver > '2026-11-13-3' && /\.\/js\/app\.js/.test(swSrc) && /\.\/css\/style\.css/.test(swSrc), ver);
    }

    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
    if (failures.length) console.log('失败项：' + failures.join(' / '));
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
