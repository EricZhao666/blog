#!/usr/bin/env node
'use strict';
/**
 * Batch 7A-01：静态笔记页移动端导航（真实 Chromium + 本地 HTTP Server）
 *
 * 背景：notes/ 下的静态页由 gen_notes_pages.js 预渲染，长期没有移动端菜单按钮，
 *       而 css/style.css 在 <=768px 时把 .nav 隐藏（只有 .nav.open 才显示），
 *       于是手机上无法从静态笔记页跳到首页/课程/论文/代码。
 *
 * 本用例只跑仓库真实产物（node gen_notes_pages.js 的生成结果），通过本地
 * HTTP Server 挂在 /blog/ 子路径下，覆盖：
 *   1) 4 个视口（375/390/768/1280）× 索引页 / 普通笔记 / 长文笔记 / 直接 URL；
 *   2) 汉堡菜单展开、收起、Esc、点击外部、点击链接跳转；
 *   3) 键盘可达性与焦点样式；
 *   4) 深色模式；
 *   5) 无横向溢出、console 无新增异常。
 *
 * 用法：
 *   node tests/browser/mobile-notes.spec.js
 *   PW_CHANNEL=chromium node tests/browser/mobile-notes.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const NOTES = path.join(ROOT, 'notes');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const SHOTS = path.join(__dirname, 'artifacts');
const EVIDENCE = path.join(SHOTS, 'mobile-notes.json');

let pass = 0, fail = 0;
const results = [];
const evidence = {};

function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, extra: extra === undefined ? null : extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const VIEWPORTS = [
  { name: '375x812', width: 375, height: 812 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1280x800', width: 1280, height: 800 }
];

// 长文笔记：取实际体积最大的静态页，确保正文足够长、菜单覆盖影响可观察
function pickLongestNote() {
  const files = fs.readdirSync(NOTES).filter(f => f.endsWith('.html') && f !== 'index.html');
  const sized = files.map(f => ({ f, size: fs.statSync(path.join(NOTES, f)).size }))
    .sort((a, b) => b.size - a.size);
  return sized[0] ? sized[0].f : 'materials.html';
}

const PAGES = () => ([
  { key: 'index', name: '静态笔记首页', rel: 'notes/index.html' },
  { key: 'note', name: '普通笔记页', rel: 'notes/' + (fs.existsSync(path.join(NOTES, 'materials.html')) ? 'materials.html' : 'cs422.html') },
  { key: 'long', name: '长文笔记页', rel: 'notes/' + pickLongestNote() }
]);

async function newSession(browser, viewport, opts) {
  const options = opts || {};
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  if (options.dark) {
    await ctx.addInitScript(() => {
      try { localStorage.setItem('theme', 'dark'); } catch (e) {}
    });
  }
  // 只允许本地服务端请求：避免 CI 上访问 giscus / 任何第三方导致抖动
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 180));
  });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e.message).slice(0, 180)));
  return { ctx, page, errors };
}

async function menuState(page) {
  return page.evaluate(() => {
    const nav = document.getElementById('siteNav') || document.querySelector('.nav');
    const btn = document.getElementById('menuToggle');
    const navStyle = nav ? getComputedStyle(nav) : null;
    const rect = nav ? nav.getBoundingClientRect() : null;
    return {
      hasBtn: !!btn,
      hasNav: !!nav,
      btnVisible: btn ? !!(btn.offsetWidth || btn.offsetHeight) : false,
      btnLabel: btn ? btn.getAttribute('aria-label') : null,
      expanded: btn ? btn.getAttribute('aria-expanded') : null,
      controls: btn ? btn.getAttribute('aria-controls') : null,
      navId: nav ? nav.id : null,
      open: nav ? nav.classList.contains('open') : null,
      navVisible: navStyle ? (navStyle.visibility !== 'hidden' && navStyle.display !== 'none') : false,
      navTop: rect ? Math.round(rect.top) : null,
      navBottom: rect ? Math.round(rect.bottom) : null,
      navHeight: rect ? Math.round(rect.height) : null,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      themeToggleVisible: (function () {
        const t = document.getElementById('themeToggle');
        return !!t && !!(t.offsetWidth || t.offsetHeight);
      })(),
      logoVisible: (function () {
        const l = document.querySelector('.logo');
        return !!l && !!(l.offsetWidth || l.offsetHeight);
      })(),
      skipLink: !!document.querySelector('.skip-link'),
      articleTitle: (function () {
        const h = document.querySelector('.article-detail-title');
        return h ? h.textContent.trim().slice(0, 40) : null;
      })(),
      theme: document.documentElement.getAttribute('data-theme')
    };
  });
}

// 找一个位于正文、且不是链接/按钮的坐标：用于验证"点击菜单外部关闭"
async function clickPointOutsideNav(page, navBottom) {
  const point = await page.evaluate((bottom) => {
    const bad = (el) => !el || el.closest('a,button,input,textarea,select,.nav');
    const xs = [Math.round(window.innerWidth / 2), 12, window.innerWidth - 12];
    const startY = Math.max(bottom + 12, 80);
    for (let y = startY; y < window.innerHeight - 8; y += 10) {
      for (const x of xs) {
        const el = document.elementFromPoint(x, y);
        if (el && !bad(el)) return { x, y, tag: el.tagName };
      }
    }
    return null;
  }, navBottom);
  if (!point) return null;
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(260);   // 等收起过渡结束
  return point;
}

async function focusMenuButtonByTab(page) {
  // 真实键盘 Tab 遍历：同时验证焦点顺序与 :focus-visible 样式
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement ? document.activeElement.id : '');
    if (id === 'menuToggle') return true;
  }
  return false;
}

async function gotoPage(page, base, rel) {
  await page.goto(base + PREFIX + '/' + rel, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(150);
}

// 菜单有 0.2s 的 transform/opacity 过渡：点击后等过渡结束再断言，
// 否则读到的是过渡起点（既不是缺陷也无法稳定复现）
async function toggle(page) {
  await page.click('#menuToggle');
  await page.waitForTimeout(260);
}

async function runScenario(label, fn) {
  try {
    await fn();
  } catch (e) {
    check(label + ' 执行未抛异常', false, String(e.message || e).split('\n')[0].slice(0, 200));
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server } = createServer(ROOT, PREFIX);
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
  console.log('被测站点: 仓库根目录，挂载于 ' + base + PREFIX + '/');
  console.log('长文笔记页: notes/' + pickLongestNote());

  const pages = PAGES();

  try {
    // ---------------------------------------------------------------- 1. 四视口基础布局
    for (const vp of VIEWPORTS) {
      for (const p of pages) {
        await runScenario(vp.name + ' / ' + p.name, async () => {
          const { ctx, page, errors } = await newSession(browser, { width: vp.width, height: vp.height });
          await gotoPage(page, base, p.rel);
          const s = await menuState(page);
          const tag = vp.name + ' ' + p.name;
          const mobile = vp.width <= 768;

          check(tag + ' 页面正常渲染', !!s.articleTitle, s.articleTitle);
          check(tag + ' 无横向溢出', s.overflowX <= 1, 'overflowX=' + s.overflowX);
          check(tag + ' 汉堡按钮存在', s.hasBtn);
          if (s.hasBtn) {
            check(tag + ' 菜单按钮 aria-label', !!s.btnLabel, s.btnLabel);
            check(tag + ' 菜单按钮 aria-controls 指向导航', s.controls && s.controls === s.navId, s.controls + '/' + s.navId);
          }
          if (mobile) {
            check(tag + ' 窄屏显示汉堡按钮', s.btnVisible);
            check(tag + ' 窄屏默认收起导航', !s.navVisible && s.open === false, 'open=' + s.open + ' visible=' + s.navVisible);
            check(tag + ' 窄屏 aria-expanded=false', s.expanded === 'false', s.expanded);
          } else {
            check(tag + ' 宽屏隐藏汉堡按钮', !s.btnVisible);
            check(tag + ' 宽屏导航直接可见', s.navVisible);
          }
          check(tag + ' 主题切换按钮可见', s.themeToggleVisible);
          check(tag + ' Logo 可见', s.logoVisible);
          check(tag + ' skip-link 存在', s.skipLink);
          check(tag + ' console 无异常', errors.length === 0, errors.slice(0, 2).join(' | '));

          evidence[vp.name + '|' + p.rel] = {
            state: s, errors,
            screenshot: null
          };
          if (mobile) {
            const shot = 'batch7a-' + vp.name + '-' + p.key + '-closed.png';
            await page.screenshot({ path: path.join(SHOTS, shot), fullPage: false });
            evidence[vp.name + '|' + p.rel].screenshot = shot;
          }
          await ctx.close();
        });
      }
    }

    // ---------------------------------------------------------------- 2. 展开 / 收起 / Esc / 外部点击
    for (const vp of VIEWPORTS.filter(v => v.width <= 768)) {
      await runScenario(vp.name + ' 菜单交互', async () => {
        const { ctx, page, errors } = await newSession(browser, { width: vp.width, height: vp.height });
        await gotoPage(page, base, 'notes/index.html');
        const tag = vp.name;

        await toggle(page);
        let s = await menuState(page);
        check(tag + ' 点击后展开导航', s.open === true && s.navVisible);
        check(tag + ' 展开后 aria-expanded=true', s.expanded === 'true', s.expanded);
        check(tag + ' 面板不超出视口底部', s.navBottom !== null && s.navBottom <= s.innerHeight + 1,
          s.navTop + '→' + s.navBottom + ' / vh=' + s.innerHeight);
        check(tag + ' 面板不占满整屏（正文仍可见）', s.navHeight < Math.round(s.innerHeight * 0.6),
          'h=' + s.navHeight + ' / vh=' + s.innerHeight);
        check(tag + ' 展开后依旧无横向溢出', s.overflowX <= 1, 'overflowX=' + s.overflowX);
        await page.screenshot({ path: path.join(SHOTS, 'batch7a-' + vp.name + '-open.png') });
        evidence['open|' + vp.name] = s;

        await toggle(page);
        s = await menuState(page);
        check(tag + ' 再次点击收起', s.open === false && !s.navVisible && s.expanded === 'false', s.expanded);

        // Esc 关闭并把焦点还给按钮
        await toggle(page);
        await page.keyboard.press('Escape');
        s = await menuState(page);
        const active = await page.evaluate(() => document.activeElement ? document.activeElement.id : '');
        check(tag + ' Esc 关闭菜单', s.open === false && s.expanded === 'false');
        check(tag + ' Esc 后焦点回到菜单按钮', active === 'menuToggle', active);

        // 点击菜单外部关闭
        await toggle(page);
        const before = await menuState(page);
        const point = await clickPointOutsideNav(page, before.navBottom);
        s = await menuState(page);
        check(tag + ' 点击正文区域关闭菜单', !!point && s.open === false && s.expanded === 'false',
          point ? ('click@' + point.x + ',' + point.y) : 'no point');
        check(tag + ' 关闭后正文可点击', s.open === false);

        check(tag + ' 交互过程 console 无异常', errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
      });
    }

    // ---------------------------------------------------------------- 3. 键盘与焦点样式
    {
      await runScenario('键盘操作', async () => {
        const { ctx, page, errors } = await newSession(browser, { width: 390, height: 844 });
        await gotoPage(page, base, 'notes/materials.html');
        check('键盘 可直接 Tab 到菜单按钮', await focusMenuButtonByTab(page));
        const focusStyle = await page.evaluate(() => {
          const cs = getComputedStyle(document.activeElement);
          return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
        });
        check('键盘 焦点有可见轮廓', focusStyle.style === 'solid' && parseFloat(focusStyle.width) >= 2,
          JSON.stringify(focusStyle));

        await page.keyboard.press('Enter');
        let s = await menuState(page);
        check('键盘 Enter 打开菜单', s.open === true && s.expanded === 'true');
        await page.keyboard.press('Enter');
        s = await menuState(page);
        check('键盘 Enter 再次关闭菜单', s.open === false && s.expanded === 'false');
        await page.keyboard.press('Space');
        s = await menuState(page);
        check('键盘 Space 打开菜单', s.open === true && s.expanded === 'true');
        await page.keyboard.press('Escape');
        s = await menuState(page);
        check('键盘 Esc 关闭菜单', s.open === false);
        check('键盘 过程 console 无异常', errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
      });
    }

    // ---------------------------------------------------------------- 4. 768 / 769 断点切换
    {
      await runScenario('断点切换', async () => {
        const { ctx, page, errors } = await newSession(browser, { width: 768, height: 1024 });
        await gotoPage(page, base, 'notes/index.html');

        let s = await menuState(page);
        check('断点 768px 菜单按钮可见', s.btnVisible);
        await toggle(page);
        s = await menuState(page);
        check('断点 768px 已展开', s.open === true && s.expanded === 'true');

        await page.setViewportSize({ width: 769, height: 1024 });
        await page.waitForTimeout(300);
        s = await menuState(page);
        check('断点 768→769 按钮隐藏', !s.btnVisible);
        check('断点 768→769 导航内联可见', s.navVisible);
        check('断点 768→769 残留 open 状态已清理', s.open === false && s.expanded === 'false',
          'open=' + s.open + ' expanded=' + s.expanded);
        check('断点 769px 无横向溢出', s.overflowX <= 1, 'overflowX=' + s.overflowX);

        await page.setViewportSize({ width: 768, height: 1024 });
        await page.waitForTimeout(400);   // 反向也要等 visibility 过渡结束
        s = await menuState(page);
        check('断点 769→768 回到收起状态', s.btnVisible && !s.navVisible && s.open === false && s.expanded === 'false');
        check('断点 过程 console 无异常', errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
      });
    }

    // ---------------------------------------------------------------- 5. 深色模式
    for (const vp of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
      await runScenario('深色模式 ' + vp.width, async () => {
        const { ctx, page, errors } = await newSession(browser, { width: vp.width, height: vp.height }, { dark: true });
        await gotoPage(page, base, 'notes/index.html');
        const tag = '深色 ' + vp.width + 'px';
        let s = await menuState(page);
        check(tag + ' 主题为 dark', s.theme === 'dark', s.theme);
        const colors = await page.evaluate(() => ({
          header: getComputedStyle(document.querySelector('.site-header')).backgroundColor,
          nav: getComputedStyle(document.querySelector('.nav')).backgroundColor,
          body: getComputedStyle(document.body).backgroundColor
        }));
        check(tag + ' 头部为深色底', colors.header === 'rgb(22, 24, 29)', colors.header);
        check(tag + ' 页面底色为深色', colors.body === 'rgb(15, 17, 21)', colors.body);
        if (vp.width <= 768) {
          await toggle(page);
          s = await menuState(page);
          check(tag + ' 菜单可展开', s.open === true);
          check(tag + ' 菜单面板为深色底', colors.nav === 'rgb(26, 29, 35)', colors.nav);
          await page.screenshot({ path: path.join(SHOTS, 'batch7a-dark-375-open.png') });
        }
        check(tag + ' console 无异常', errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
      });
    }

    // ---------------------------------------------------------------- 6. 主题切换按钮未被破坏
    {
      await runScenario('主题切换', async () => {
        const { ctx, page } = await newSession(browser, { width: 375, height: 812 });
        await gotoPage(page, base, 'notes/materials.html');
        const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        await page.click('#themeToggle');
        const after = await page.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          stored: localStorage.getItem('theme'),
          label: document.getElementById('themeToggle').getAttribute('aria-label')
        }));
        check('主题切换 由浅色切到深色', (before === 'light' || before === null) && after.theme === 'dark',
          String(before) + '→' + after.theme);
        check('主题切换 已写入 localStorage', after.stored === 'dark', after.stored);
        check('主题切换 aria-label 同步', /浅色/.test(after.label || ''), after.label);
        await ctx.close();
      });
    }

    // ---------------------------------------------------------------- 7. 导航跳转（菜单链接）
    {
      await runScenario('静态页导航', async () => {
        const { ctx, page, errors } = await newSession(browser, { width: 375, height: 812 });
        await gotoPage(page, base, 'notes/index.html');
        await toggle(page);
        await page.click('#siteNav a[href$="#/courses"]');
        await page.waitForFunction(() => location.hash === '#/courses', null, { timeout: 20000 });
        await page.waitForFunction(() => {
          const app = document.getElementById('app');
          return !!app && app.querySelectorAll('.course-card').length > 0;
        }, null, { timeout: 20000 }).catch(() => {});
        const nav1 = await page.evaluate(() => ({
          hash: location.hash,
          path: location.pathname,
          title: document.title,
          cards: document.querySelectorAll('#app .course-card').length
        }));
        check('导航 静态页 → 课程列表', nav1.hash === '#/courses' && nav1.path === '/blog/', JSON.stringify(nav1));
        check('导航 课程列表已渲染', nav1.cards > 0, nav1.cards + ' 门');
        check('导航 标题已更新', /课程/.test(nav1.title), nav1.title);

        // 静态笔记页 → 首页
        await gotoPage(page, base, 'notes/materials.html');
        await toggle(page);
        await page.click('#siteNav a[href$="#/"]');
        await page.waitForFunction(() => location.hash === '#/',
          null, { timeout: 20000 }).catch(() => {});
        await page.waitForFunction(() => {
          const app = document.getElementById('app');
          return !!app && app.querySelectorAll('a[href^="#/post/"]').length > 0;
        }, null, { timeout: 20000 }).catch(() => {});
        const nav2 = await page.evaluate(() => ({
          hash: location.hash,
          posts: document.querySelectorAll('#app a[href^="#/post/"]').length
        }));
        check('导航 静态页 → 首页', nav2.hash === '#/' && nav2.posts > 0, JSON.stringify(nav2));
        check('导航 过程 console 无异常', errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
      });
    }

    // ---------------------------------------------------------------- 8. 直接 URL 冷启动
    {
      await runScenario('直接 URL 访问', async () => {
        const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
        await ctx.route('**/*', route => {
          const url = route.request().url();
          if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
          return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
        const target = base + PREFIX + '/notes/' + pickLongestNote();
        await page.goto(target, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(200);
        const s = await menuState(page);
        check('直连 长文页可独立访问', s.articleTitle !== null && s.articleTitle.length > 0, s.articleTitle);
        check('直连 菜单按钮可用', s.hasBtn && s.btnVisible && s.expanded === 'false');
        await toggle(page);
        const s2 = await menuState(page);
        check('直连 菜单可展开', s2.open === true && s2.navVisible);
        check('直连 无横向溢出', s2.overflowX <= 1, 'overflowX=' + s2.overflowX);
        const bodyText = await page.evaluate(() => document.querySelector('.article-detail-body').textContent.length);
        check('直连 正文完整', bodyText > 1000, bodyText);
        check('直连 无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
      });
    }
    // ---------------------------------------------------------------- 9. 主站 SPA 菜单跨断点
    // 静态页与主站在 css/style.css 里共用同一套 .nav / .nav.open：
    // 主站若缺少 .open 复位，放大到桌面再缩回手机时菜单会莫名其妙地展开。
    {
      await runScenario('主站 SPA 菜单', async () => {
        const { ctx, page, errors } = await newSession(browser, { width: 375, height: 812 });
        await page.goto(base + PREFIX + '/#/', { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction(() => {
          const app = document.getElementById('app');
          return !!app && app.querySelectorAll('a[href^="#/post/"]').length > 0;
        }, null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(200);

        let s = await menuState(page);
        check('SPA 375px 菜单按钮可见', s.btnVisible && s.hasBtn);
        check('SPA 375px 默认收起', s.open === false && s.expanded === 'false',
          'open=' + s.open + ' expanded=' + s.expanded);
        check('SPA 375px 无横向溢出', s.overflowX <= 1, 'overflowX=' + s.overflowX);

        await toggle(page);
        s = await menuState(page);
        check('SPA 375px 点击展开', s.open === true && s.expanded === 'true' && s.navVisible);

        await page.keyboard.press('Escape');
        s = await menuState(page);
        const active = await page.evaluate(() => document.activeElement ? document.activeElement.id : '');
        check('SPA Esc 关闭菜单', s.open === false && s.expanded === 'false');
        check('SPA Esc 后焦点回到菜单按钮', active === 'menuToggle', active);

        await toggle(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForTimeout(400);
        s = await menuState(page);
        check('SPA 375→1280 按钮隐藏', !s.btnVisible);
        check('SPA 375→1280 残留 open 状态已清理', s.open === false && s.expanded === 'false',
          'open=' + s.open + ' expanded=' + s.expanded);
        check('SPA 1280px 导航内联可见', s.navVisible);

        await page.setViewportSize({ width: 375, height: 812 });
        await page.waitForTimeout(400);
        s = await menuState(page);
        check('SPA 1280→375 回到收起状态', s.btnVisible && s.open === false && !s.navVisible && s.expanded === 'false',
          'open=' + s.open + ' visible=' + s.navVisible);
        check('SPA 跨断点 console 无异常', errors.length === 0, errors.slice(0, 2).join(' | '));
        await ctx.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
  }

  fs.writeFileSync(EVIDENCE, JSON.stringify({
    results, evidence,
    meta: { channel: CHANNEL, viewports: VIEWPORTS.map(v => v.name), generatedAt: new Date().toISOString() }
  }, null, 2), 'utf8');

  const failed = results.filter(r => !r.ok);
  console.log('\n共 ' + results.length + ' 项，PASS ' + pass + '，FAIL ' + fail);
  console.log('证据: ' + path.relative(ROOT, EVIDENCE));
  if (failed.length) {
    console.log('失败项：\n  - ' + failed.map(f => f.name + (f.extra ? '  (' + f.extra + ')' : '')).join('\n  - '));
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SPEC ERROR:', e); process.exit(1); });
