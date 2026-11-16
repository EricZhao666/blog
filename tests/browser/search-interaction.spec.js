#!/usr/bin/env node
'use strict';
/**
 * Batch 8C-2：真实 Chromium 下的搜索交互回归
 *
 * 覆盖：分类筛选与数量 / 排序 / 折叠 / ↑↓ Enter Esc / 中文输入法 /
 * 最近搜索历史与 localStorage 降级 / 局部刷新 / 数据源部分失败 /
 * 快速输入竞态 / 前进后退 / 375·390·768·1280 布局 / 深浅色 / XSS /
 * 稳定深链 / SW 缓存升级。
 *
 * 数据：公开产物 + 内存合成 papers.js Fixture（不访问私人 Zotero / Registry）。
 * 用法：node tests/browser/search-interaction.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const OLD_CACHE_VERSION = '2026-11-13-3';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function papersJs() {
  const papers = [
    { id: 'paper-b8c2-alpha', title: '机器人步态控制 Alpha', authors: 'Alpha Author', category: '双足机器人',
      abstract: '机器人步态与奖励函数摘要。', url: '', type: 'preprint', date: '2024-01-01' },
    { id: 'paper-b8c2-beta', title: '机器人感知 Beta', authors: 'Beta Author', category: '具身智能',
      abstract: '机器人感知摘要。', url: '', type: 'preprint', date: '2024-02-02' }
  ];
  const materials = [
    { id: 'lm-b8c2-001', name: '机器人资料一.pdf', category: 'ANSYS仿真', subcategory: '有限元分析',
      type: 'PDF', size: 10, sizeFormatted: '10 B' },
    { id: 'lm-b8c2-002', name: '机器人资料二.pdf', category: 'CAD建模', subcategory: '第一课',
      type: 'PDF', size: 20, sizeFormatted: '20 B' }
  ];
  return 'const PAPERS=' + JSON.stringify(papers) + ';\n' +
    'const PAPER_CATEGORIES={"双足机器人":{"count":1,"types":["preprint"]},"具身智能":{"count":1,"types":["preprint"]}};\n' +
    'const LEARNING_MATERIALS=' + JSON.stringify(materials) + ';\n' +
    'const LEARN_CATEGORIES={};\n';
}

async function session(browser, base, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1280, height: 800 },
    serviceWorkers: o.sw ? 'allow' : 'block'
  });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  if (o.brokenStorage) {
    await ctx.addInitScript(() => {
      const boom = () => { throw new Error('localStorage blocked by b8c2'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { boom(); } }
      });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible' });
  return { ctx, page, errors, dialogs };
}

async function search(page, text, waitMs) {
  await page.fill('#searchInput', text);
  await sleep(waitMs || 900);
  await page.waitForFunction(() => {
    const el = document.querySelector('.search-sources-summary');
    return el && el.textContent.indexOf('已加载 5/5 类') !== -1;
  }, null, { timeout: 15000 }).catch(() => {});
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

  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const cacheVer = (/CACHE_VERSION = '([^']+)'/.exec(swSrc) || [])[1];

  try {
    // ---------------------------------------------------------- A 筛选 / 排序 / 折叠 / 键盘 / 历史 / 深链
    {
      const s = await session(browser, base);
      const p = s.page;
      await search(p, '机器人');

      const init = await p.evaluate(() => ({
        active: document.querySelectorAll('#searchFilterBar [aria-pressed="true"]').length,
        activeKey: (document.querySelector('#searchFilterBar [aria-pressed="true"]') || {}).getAttribute
          ? document.querySelector('#searchFilterBar [aria-pressed="true"]').getAttribute('data-search-filter') : '',
        labels: Array.prototype.map.call(document.querySelectorAll('#searchFilterBar [data-search-filter]'), n => n.textContent),
        sections: Array.prototype.map.call(document.querySelectorAll('.search-section-title'), n => n.textContent),
        visiblePosts: document.querySelectorAll('.article-card[data-search-result]').length,
        total: (document.querySelector('.search-results-count') || {}).textContent || '',
        sort: (document.getElementById('searchSortSelect') || {}).value
      }));
      check('A1 默认「全部」且 aria-pressed 唯一', init.active === 1 && init.activeKey === 'all', init.activeKey);
      check('A2 五类筛选按钮与筛选前数量', init.labels.length === 5 &&
        init.labels.every(t => /\(\d+\)/.test(t)), init.labels.join(' | '));
      check('A3 四类结果分组均在', init.sections.length === 4, init.sections.join(' | '));
      check('A4 默认相关性排序', init.sort === 'relevance');
      check('A5 文章默认折叠为 6 条并显示可见/总数',
        init.visiblePosts === 6 && /显示 6 \/ 共 \d+/.test(await p.textContent('#app')), init.visiblePosts);
      const relBefore = await p.evaluate(() => Array.prototype.map.call(
        document.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
        n => n.getAttribute('href')));

      const hitsBefore = JSON.stringify(state.hits);
      const rootBefore = await p.evaluate(() => { window.__root = document.querySelector('[data-search-root]'); return true; });
      await p.click('[data-search-filter="paper"]');
      const filtered = await p.evaluate(() => ({
        sections: document.querySelectorAll('.search-section-title').length,
        posts: document.querySelectorAll('.article-card[data-search-result]').length,
        links: Array.prototype.map.call(document.querySelectorAll('.search-paper-item[data-search-result]'),
          n => n.getAttribute('data-href')),
        sameRoot: window.__root === document.querySelector('[data-search-root]')
      }));
      check('A6 切换分类立即生效且无重复条目',
        filtered.sections === 1 && filtered.posts === 0 && filtered.links.length === 2,
        filtered.links.join(' | '));
      check('A7 筛选不改变论文稳定深链',
        filtered.links.every(h => /target=paper-b8c2-/.test(h) && !/target=\d+(&|$)/.test(h)));
      check('A8 切换筛选只局部刷新结果区', filtered.sameRoot && rootBefore);
      check('A9 切换筛选不触发额外网络请求', JSON.stringify(state.hits) === hitsBefore);

      await p.click('[data-search-filter="material"]');
      const matLinks = await p.evaluate(() => Array.prototype.map.call(
        document.querySelectorAll('.search-paper-item[data-search-result]'), n => n.getAttribute('data-href')));
      check('A10 学习资料筛选保持持久 ID',
        matLinks.length === 2 && matLinks.every(h => /target=lm-b8c2-/.test(h)), matLinks.join(' | '));
      await p.click('[data-search-filter="all"]');

      await p.selectOption('#searchSortSelect', 'title');
      const titleOrder = await p.evaluate(() => Array.prototype.map.call(
        document.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
        n => n.getAttribute('href')));
      check('A11 标题排序改变了相关性顺序',
        titleOrder.length === 6 && titleOrder.join('|') !== relBefore.join('|'),
        titleOrder.slice(0, 3).join(','));
      await p.selectOption('#searchSortSelect', 'date');
      const dateHint = await p.textContent('#app');
      check('A12 最新优先明确说明仅文章生效',
        /只对有可靠发布日期的文章生效/.test(dateHint));
      await p.selectOption('#searchSortSelect', 'relevance');
      const relOrder = await p.evaluate(() => Array.prototype.map.call(
        document.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
        n => n.getAttribute('href')));
      const computed = await p.evaluate(() => window.collectSearchResults('机器人').groups.post.slice(0, 6)
        .map(r => '#/post/' + r.id));
      check('A13 切回相关性完全复用 B8C-1 的 score 顺序',
        relOrder.join('|') === computed.join('|'), relOrder.slice(0, 2).join(','));

      const expand = p.locator('[data-search-expand="post"]');
      check('A14 超过上限显示展开更多', await expand.count() === 1);
      await expand.click();
      const expanded = await p.evaluate(() => ({
        n: document.querySelectorAll('.article-card[data-search-result]').length,
        label: (document.querySelector('[data-search-expand="post"]') || {}).textContent || '',
        aria: (document.querySelector('[data-search-expand="post"]') || {}).getAttribute('aria-expanded')
      }));
      check('A15 展开显示全部且可折叠', expanded.n >= 7 && expanded.aria === 'true' &&
        /收起/.test(expanded.label), expanded.n + ' / ' + expanded.label);
      await p.locator('[data-search-expand="post"]').click();
      check('A16 折叠回到 6 条',
        (await p.locator('.article-card[data-search-result]').count()) === 6);

      // 键盘导航
      await p.focus('#searchInput');
      await p.keyboard.press('ArrowDown');
      const nav1 = await p.evaluate(() => {
        const a = document.querySelectorAll('.search-result-active');
        const i = document.getElementById('searchInput');
        return { n: a.length, href: a[0] && a[0].getAttribute('data-href'),
          aria: i.getAttribute('aria-activedescendant'), role: i.getAttribute('role'),
          selected: a[0] && a[0].getAttribute('aria-selected') };
      });
      check('A17 ↓ 选中第一条并同步 aria', nav1.n === 1 && nav1.selected === 'true' &&
        nav1.role === 'combobox' && nav1.aria === (await p.locator('.search-result-active').getAttribute('id')),
        nav1.href);
      await p.keyboard.press('ArrowDown');
      const nav2 = await p.locator('.search-result-active').getAttribute('data-href');
      check('A18 ↓ 移到下一条', nav2 !== nav1.href, nav2);
      await p.keyboard.press('ArrowUp');
      check('A19 ↑ 回到上一条',
        (await p.locator('.search-result-active').getAttribute('data-href')) === nav1.href);
      await p.keyboard.press('Escape');
      check('A20 Esc 有选中项时只退出选择',
        (await p.locator('.search-result-active').count()) === 0 &&
        (await p.inputValue('#searchInput')) === '机器人' &&
        (await p.getAttribute('#searchInput', 'aria-activedescendant')) === null);
      await p.keyboard.press('Escape');
      check('A21 无选中项时 Esc 清空搜索', (await p.inputValue('#searchInput')) === '');

      await search(p, '机器人');
      const ime = await p.evaluate(() => {
        const el = document.getElementById('searchInput');
        const before = document.querySelectorAll('.search-result-active').length;
        const mk = props => {
          const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
          Object.keys(props).forEach(k => Object.defineProperty(ev, k, { value: props[k], configurable: true }));
          el.dispatchEvent(ev);
        };
        mk({ isComposing: true });
        mk({ keyCode: 229 });
        mk({ ctrlKey: true });
        return { before: before, after: document.querySelectorAll('.search-result-active').length };
      });
      check('A22 输入法组合 / keyCode 229 / 系统快捷键不触发导航',
        ime.before === 0 && ime.after === 0, JSON.stringify(ime));
      await p.focus('#searchInput');
      await p.keyboard.press('ArrowDown');
      const chosen = await p.locator('.search-result-active').getAttribute('data-href');
      await p.keyboard.press('Enter');
      await sleep(350);
      check('A23 Enter 打开选中结果且与鼠标点击同一链接',
        p.url().indexOf(chosen.slice(1)) !== -1 || decodeURIComponent(p.url()).indexOf(chosen) !== -1,
        p.url() + ' / ' + chosen);

      await p.goBack();
      await sleep(450);
      check('A24 前进/后退恢复搜索上下文',
        (await p.inputValue('#searchInput')) === '机器人' &&
        /找到\s*\d+\s*条/.test(await p.textContent('#app')));

      await p.fill('#searchInput', '绝无此词XYZ');
      await sleep(700);
      const beforeEmpty = p.url();
      await p.focus('#searchInput');
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Enter');
      await sleep(250);
      check('A25 无可选结果时 Enter 不跳转', p.url() === beforeEmpty &&
        (await p.locator('.search-result-active').count()) === 0);

      // 历史（Enter 确认）：先清空前面导航产生的记录，得到确定起点
      if (await p.locator('[data-search-history-clear]').count()) {
        await p.click('[data-search-history-clear]');
      }
      await search(p, '机器人');
      await p.focus('#searchInput');
      await p.keyboard.press('Enter');
      await sleep(250);
      const hist = await p.evaluate(() => ({
        panel: !!document.getElementById('searchHistoryPanel'),
        text: (document.querySelector('.search-history-head') || {}).textContent || '',
        terms: Array.prototype.map.call(document.querySelectorAll('.search-history-term'), n => n.textContent),
        stored: JSON.parse(localStorage.getItem('blog.searchHistory.v1') || '[]')
      }));
      check('A26 确认搜索才记录历史并说明仅本地保存',
        hist.panel && /仅保存在此浏览器/.test(hist.text) && hist.stored[0] === '机器人',
        hist.stored.join('|'));
      await p.fill('#searchInput', '卡尔曼');
      await sleep(250);
      check('A27 逐字输入不保存历史',
        (await p.evaluate(() => JSON.parse(localStorage.getItem('blog.searchHistory.v1') || '[]')[0])) === '机器人');
      await p.focus('#searchInput');
      await p.keyboard.press('Enter');
      await sleep(200);
      check('A28 最近使用排最前且去重',
        (await p.evaluate(() => JSON.parse(localStorage.getItem('blog.searchHistory.v1') || '[]').join('|'))) === '卡尔曼|机器人');
      await p.click('[data-search-history-clear]');
      check('A29 一键清空且面板消失',
        !await p.locator('#searchHistoryPanel').count() &&
        (await p.evaluate(() => localStorage.getItem('blog.searchHistory.v1'))) === null);

      // XSS
      await p.fill('#searchInput', '<img src=x onerror=window.__xss=1>');
      await sleep(700);
      const xss = await p.evaluate(() => ({
        nodes: document.querySelectorAll('#app img, #app script, #app [onerror]').length,
        flag: !!window.__xss,
        html: document.getElementById('app').innerHTML
      }));
      check('A30 XSS：恶意查询不创建元素 / 不执行脚本',
        xss.nodes === 0 && !xss.flag && s.dialogs.length === 0 && xss.html.indexOf('<img') === -1);
      check('A31 XSS：输入被转义显示', xss.html.indexOf('&lt;img') !== -1);

      // 稳定深链点击
      await search(p, '机器人');
      const materialRow = p.locator('.search-paper-item[data-href*="kind=material"]').first();
      const mHref = await materialRow.getAttribute('data-href');
      await materialRow.click();
      await sleep(400);
      check('A32 点击资料仍用 Batch 7B-2 持久深链',
        mHref.indexOf('target=lm-b8c2-') !== -1 && p.url().indexOf('target=lm-b8c2-') !== -1,
        p.url());
      check('A33 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- B localStorage 不可用
    {
      const s = await session(browser, base, { brokenStorage: true });
      await search(s.page, '机器人');
      await s.page.focus('#searchInput');
      await s.page.keyboard.press('Enter');
      await sleep(300);
      const downgrade = await s.page.evaluate(() => ({
        hasResults: /找到\s*\d+\s*条/.test(document.getElementById('app').textContent),
        note: /无法写入本地存储/.test(document.getElementById('app').textContent),
        chips: document.querySelectorAll('[data-search-history]').length
      }));
      check('B1 localStorage 不可用时全站搜索仍正常', downgrade.hasResults);
      check('B2 明确提示降级且内存历史可用', downgrade.note && downgrade.chips >= 1);
      check('B3 无未捕获页面错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- C 部分失败 / 竞态 / 重试
    {
      state.faults['/js/papers.js'] = 500;
      const s = await session(browser, base);
      await s.page.fill('#searchInput', '机器人');
      await sleep(1100);
      const partial = await s.page.evaluate(() => ({
        text: document.getElementById('app').textContent,
        posts: document.querySelectorAll('.article-card[data-search-result]').length,
        retry: !!document.querySelector('[data-retry-search-source="papers"]')
      }));
      check('C1 单源失败不阻断其它类别',
        partial.posts > 0 && /论文 \/ 学习资料 ⚠ 加载失败/.test(partial.text), partial.posts);
      await s.page.click('[data-search-filter="paper"]');
      check('C2 数据未加载完成时筛选不显示最终零结果',
        /该分类的数据源尚未加载完成/.test(await s.page.textContent('#app')) &&
        !/没有找到相关内容/.test(await s.page.textContent('#app')));
      delete state.faults['/js/papers.js'];
      await s.page.click('[data-retry-search-source="papers"]');
      await sleep(900);
      check('C3 失败源重试后恢复',
        /论文 \/ 学习资料 ✓ 已加载/.test(await s.page.textContent('#app')) && partial.retry);
      check('C4 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- D 多视口 / 深色模式
    {
      const s = await session(browser, base, { viewport: { width: 375, height: 812 } });
      await search(s.page, '机器人');
      await s.page.focus('#searchInput');
      await s.page.keyboard.press('Enter');
      await sleep(250);
      for (const w of [375, 390, 768, 1280]) {
        await s.page.setViewportSize({ width: w, height: w <= 390 ? 812 : 800 });
        await sleep(180);
        const box = await s.page.evaluate(() => {
          const btn = document.querySelector('#searchFilterBar [data-search-filter]');
          const sel = document.getElementById('searchSortSelect');
          const hist = document.getElementById('searchHistoryPanel');
          const cs = el => el ? getComputedStyle(el) : null;
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
            selH: sel ? Math.round(sel.getBoundingClientRect().height) : 0,
            histPos: hist ? getComputedStyle(hist).position : 'none',
            histTop: hist ? Math.round(hist.getBoundingClientRect().top) : -1
          };
        });
        check('D' + w + ' 无横向溢出且控件可用',
          box.scrollWidth <= box.innerWidth + 1 && box.btnH >= 36 && box.selH >= 36 &&
          (w > 480 || box.btnH >= 40), JSON.stringify(box));
        check('D' + w + ' 历史面板在文档流内不遮挡内容',
          box.histPos !== 'fixed' && box.histPos !== 'absolute' && box.histTop >= 0,
          box.histPos + ' / ' + box.histTop);
      }
      await s.page.setViewportSize({ width: 390, height: 844 });
      await s.page.selectOption('#searchSortSelect', 'title');
      check('D-390 排序下拉框可正常使用',
        (await s.page.locator('#searchSortSelect').inputValue()) === 'title');
      const lightColor = await s.page.evaluate(() =>
        getComputedStyle(document.querySelector('#searchFilterBar [data-search-filter]')).color);
      await s.page.click('#themeToggle');
      const dark = await s.page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        color: getComputedStyle(document.querySelector('#searchFilterBar [data-search-filter]')).color,
        bg: getComputedStyle(document.querySelector('#searchFilterBar [data-search-filter]')).backgroundColor,
        activeBg: getComputedStyle(document.querySelector('#searchFilterBar [aria-pressed="true"]')).backgroundColor
      }));
      check('D-dark 深色模式下控件状态清晰',
        dark.theme === 'dark' && !!dark.color && dark.color !== 'rgba(0, 0, 0, 0)' &&
        !!dark.activeBg && dark.activeBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(dark));
      check('D-light 浅色模式同样可用', !!lightColor && lightColor !== 'rgba(0, 0, 0, 0)');
      check('D 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- E SW 缓存升级
    {
      const s = await session(browser, base, { sw: true, viewport: { width: 1280, height: 800 } });
      await sleep(1600);
      const caches = await s.page.evaluate(() => (window.caches ? caches.keys() : []));
      check('E1 CACHE_VERSION 已随 app.js / css 递增',
        !!cacheVer && cacheVer > OLD_CACHE_VERSION && cacheVer === '2026-11-16-1', cacheVer);
      check('E2 SW 使用当前缓存版本', caches.some(n => n.indexOf(cacheVer) !== -1), caches.join(','));
      check('E3 旧版本缓存已清理', !caches.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), caches.join(','));
      check('E4 SW 生效时搜索仍可用',
        await s.page.isVisible('#searchInput') && s.errors.length === 0,
        s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
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
