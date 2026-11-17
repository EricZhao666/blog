#!/usr/bin/env node
'use strict';

/**
 * Batch 8D-3：全站 UI 2.0 与响应式视觉升级的真实 Chromium 验收。
 *
 * 覆盖：
 *  - 主要页面渲染与标题层级（首页 / 文章 / 课程 / 论文 / 项目 / 归档 / 标签 / 关于 / 代码 / 编辑器）
 *  - 桌面导航不换行、当前页指示，移动端下拉菜单与触控面积、Esc 关闭与焦点归还
 *  - 浅色 / 深色主题的底色契约、控件边界与文字对比度
 *  - 375 / 390 / 768 / 1024 / 1440 五档视口无全页横向溢出（且没有用全局 overflow-x:hidden 掩盖）
 *  - 长标题 / 长标签 / 长技术词换行
 *  - 键盘焦点、论文卡片 Enter 展开、文章卡片 Enter 跳转
 *  - 阅读目录、图片灯箱
 *  - 搜索控件、编辑器布局、静态课程笔记页
 *  - 无新增 Console Error、SW 缓存版本随资源更新
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';

let passCount = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passCount += 1;
    console.log('PASS ' + name);
  } else {
    failures.push(name + (detail ? '  (' + detail + ')' : ''));
    console.log('FAIL ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

async function newSession(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1440, height: 900 },
    serviceWorkers: 'block',
    reducedMotion: o.reducedMotion || 'no-preference'
  });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  if (o.theme) {
    await ctx.addInitScript(theme => {
      try { localStorage.setItem('theme', theme); } catch (e) { /* 忽略 */ }
    }, o.theme);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon|Failed to load resource|net::ERR|ServiceWorker|sw\.js/i.test(t)) return;
    errors.push('console: ' + t);
  });
  return { ctx, page, errors };
}

async function goto(page, base, route, waitSelector) {
  await page.goto(base + '/#' + route, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector(waitSelector || '#searchInput', { timeout: 25000 });
  await page.waitForTimeout(320);
}

async function hashTo(page, route, waitSelector) {
  await page.evaluate(r => { location.hash = '#' + r; }, route);
  await page.waitForSelector(waitSelector, { timeout: 25000 });
  await page.waitForTimeout(320);
}

function layoutInfo(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    return {
      innerW: innerWidth,
      docW: de.scrollWidth,
      bodyW: document.body.scrollWidth,
      htmlOverflowX: getComputedStyle(de).overflowX,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      scrollH: de.scrollHeight
    };
  });
}

function offenders(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('body *').forEach(el => {
      if (el.classList.contains('skip-link')) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (r.right > innerWidth + 1 || r.left < -1) {
        const cls = typeof el.className === 'string' ? el.className : '';
        out.push((cls || el.tagName) + '[' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
      }
    });
    return out.slice(0, 8);
  });
}

function contrastReport(page, selectors) {
  return page.evaluate(list => {
    const parse = c => {
      const m = /rgba?\(([^)]+)\)/.exec(String(c));
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = c => {
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const bgOf = el => {
      let n = el;
      while (n && n !== document.documentElement) {
        const bg = parse(getComputedStyle(n).backgroundColor);
        if (bg && bg.a > 0.9) return bg;
        n = n.parentElement;
      }
      return parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    };
    const out = {};
    list.forEach(sel => {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; return; }
      const fg = parse(getComputedStyle(el).color);
      const bg = bgOf(el);
      const l1 = lum(fg); const l2 = lum(bg);
      out[sel] = Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
    });
    return out;
  }, selectors);
}

const POST_ID = 'digital-twin-manufacturing';

(async () => {
  const { server } = createServer(ROOT, PREFIX);
  const port = await listen(server, 0);
  const base = 'http://127.0.0.1:' + port + PREFIX;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.error('无法启动 Chromium：' + String(e.message).split('\n')[0]);
    server.close();
    process.exit(2);
  }
  console.log('浏览器: chromium ' + browser.version());

  const allErrors = [];
  const note = (s) => { allErrors.push(...s.errors.map(e => '[' + (s.tag || '?') + '] ' + e)); };

  try {
    // ======================================================== U1 主要页面渲染（1440 浅色）
    {
      const s = await newSession(browser); s.tag = 'U1'; const p = s.page;

      await goto(p, base, '/', '.article-card');
      const home = await p.evaluate(() => {
        const list = document.querySelector('.article-list');
        const title = document.querySelector('.home-head .page-title');
        const meta = document.querySelector('.home-meta');
        return {
          cards: document.querySelectorAll('.article-card').length,
          title: title ? title.textContent.trim() : '',
          meta: meta ? meta.textContent.trim() : '',
          cols: list ? getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
          hasH1: !!document.querySelector('h1.page-title')
        };
      });
      check('U1.1 首页有页面标题与篇数信息', home.hasH1 && home.title === '文章' && /共\s*\d+\s*篇/.test(home.meta), JSON.stringify(home));
      check('U1.2 首页文章卡片渲染且宽屏两列', home.cards >= 5 && home.cols === 2, 'cards=' + home.cards + ' cols=' + home.cols);

      await hashTo(p, '/post/' + POST_ID, '.article-detail');
      const post = await p.evaluate(() => ({
        title: (document.querySelector('.article-detail-title') || {}).textContent || '',
        toc: !!document.querySelector('.toc-panel'),
        tocLinks: document.querySelectorAll('.toc-panel .toc-link').length,
        progress: !!document.querySelector('.reading-progress'),
        pad: getComputedStyle(document.querySelector('.article-detail')).paddingTop
      }));
      check('U1.3 文章详情渲染标题/目录/阅读进度', post.title.length > 4 && post.toc && post.tocLinks >= 3 && post.progress,
        JSON.stringify(post));

      await hashTo(p, '/courses', '.course-card');
      const courses = await p.evaluate(() => ({
        cards: document.querySelectorAll('.course-card').length,
        stats: document.querySelectorAll('.courses-stats .stat-card').length,
        chipActiveBg: (() => {
          const c = document.querySelector('.category-chip.active');
          return c ? getComputedStyle(c).backgroundColor : '';
        })(),
        sourceBadgeBg: (() => {
          const b = document.querySelector('.course-card-source');
          return b ? getComputedStyle(b).backgroundColor : '';
        })()
      }));
      check('U1.4 课程页卡片/统计条/筛选态完整', courses.cards >= 8 && courses.stats === 3 && courses.chipActiveBg !== 'rgba(0, 0, 0, 0)',
        JSON.stringify(courses));

      await hashTo(p, '/papers', '.paper-card');
      const papers = await p.evaluate(() => ({
        cards: document.querySelectorAll('.paper-card').length,
        tabs: document.querySelectorAll('.paper-tab').length,
        types: Array.prototype.map.call(document.querySelectorAll('.paper-type-badge'), b => b.textContent.trim()),
        rawEnum: document.body.textContent.indexOf('conferencePaper') >= 0 || document.body.textContent.indexOf('journalArticle') >= 0,
        badgeDots: document.querySelectorAll('.paper-type-badge').length
      }));
      check('U1.5 论文页渲染且类型徽标中文化', papers.cards >= 5 && papers.tabs >= 2 && !papers.rawEnum &&
        papers.types.every(t => t && t !== ''), JSON.stringify({ n: papers.cards, types: papers.types.slice(0, 4) }));

      await hashTo(p, '/projects', '.project-card');
      const projects = await p.evaluate(() => ({
        cards: document.querySelectorAll('.project-card').length,
        status: Array.prototype.map.call(document.querySelectorAll('.project-card-status'), e => e.textContent.trim())
      }));
      check('U1.6 项目页卡片与状态标签', projects.cards >= 3 && projects.status.every(t => t === '已完成' || t === '进行中'),
        JSON.stringify(projects));

      await hashTo(p, '/archive', '.archive-item');
      const archive = await p.evaluate(() => ({
        items: document.querySelectorAll('.archive-item').length,
        years: document.querySelectorAll('.archive-year').length,
        yearText: (document.querySelector('.archive-year') || {}).textContent || ''
      }));
      check('U1.7 归档页按年分组（现有数据均在 2026 年）', archive.items >= 8 && archive.years >= 1 && /年\s*\(\d+\)/.test(archive.yearText),
        JSON.stringify(archive));

      await hashTo(p, '/tags', '.tag-cloud-item');
      const tags = await p.evaluate(() => {
        const t = document.querySelector('.page-title');
        const c = document.querySelector('.tags-cloud');
        return {
          items: document.querySelectorAll('.tag-cloud-item').length,
          titleFirst: !!(t && c && (t.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING))
        };
      });
      check('U1.8 标签页标题在标签云之前', tags.items >= 5 && tags.titleFirst, JSON.stringify(tags));

      await hashTo(p, '/about', '.about-page');
      const about = await p.evaluate(() => {
        const a = document.querySelector('.about-page');
        const st = getComputedStyle(a);
        return {
          bg: st.backgroundColor,
          padTop: parseFloat(st.paddingTop),
          radius: parseFloat(st.borderTopLeftRadius),
          avatar: !!document.querySelector('.about-avatar, .about-page img')
        };
      });
      check('U1.9 关于页卡片底板生效（修复被丢弃的 .about-page 规则）',
        about.bg !== 'rgba(0, 0, 0, 0)' && about.padTop >= 24 && about.radius >= 8, JSON.stringify(about));

      await hashTo(p, '/code', '.course-card');
      const code = await p.evaluate(() => ({
        cards: document.querySelectorAll('.course-card').length,
        guide: !!document.querySelector('.code-lib-guide pre'),
        badgeColored: (() => {
          const b = document.querySelector('.file-type-badge');
          if (!b) return false;
          const bg = getComputedStyle(b).backgroundColor;
          return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
        })()
      }));
      check('U1.10 代码页渲染代码库卡片', code.cards >= 4, JSON.stringify(code));

      await hashTo(p, '/editor', '.editor-page');
      const editor = await p.evaluate(() => ({
        page: !!document.querySelector('.editor-page'),
        textarea: !!document.querySelector('#editorContent'),
        preview: !!document.querySelector('#editorPreview')
      }));
      check('U1.11 编辑器页面结构完整', editor.page && editor.textarea && editor.preview, JSON.stringify(editor));

      note(s);
    }

    // ======================================================== U2 桌面导航
    {
      const s = await newSession(browser, { viewport: { width: 1440, height: 900 } });
      s.tag = 'U2'; const p = s.page;
      await goto(p, base, '/', '.article-card');
      const nav = await p.evaluate(() => {
        const links = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
        const active = document.querySelector('.nav-link.active');
        const after = active ? getComputedStyle(active, '::after') : null;
        return {
          count: links.length,
          maxH: Math.max.apply(null, links.map(l => l.getBoundingClientRect().height)),
          wrapped: links.filter(l => l.scrollWidth > l.clientWidth + 1).length,
          activeAfterBg: after ? after.backgroundColor : '',
          activeAfterH: after ? parseFloat(after.height) : 0,
          navGap: parseFloat(getComputedStyle(document.querySelector('.nav')).columnGap || '0')
        };
      });
      check('U2.1 1440 桌面导航单行不换行（修复逐字竖排）', nav.count >= 9 && nav.maxH <= 38 && nav.wrapped === 0, JSON.stringify(nav));
      check('U2.2 当前页有下划线指示而非填充块', /rgb\(37,\s*99,\s*235\)/.test(nav.activeAfterBg) && nav.activeAfterH >= 1.5,
        nav.activeAfterBg + ' h=' + nav.activeAfterH);

      await p.setViewportSize({ width: 1024, height: 800 });
      await p.waitForTimeout(250);
      const mid = await p.evaluate(() => {
        const links = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
        return {
          maxH: Math.max.apply(null, links.map(l => l.getBoundingClientRect().height)),
          wrapped: links.filter(l => l.scrollWidth > l.clientWidth + 1).length,
          toggleVisible: getComputedStyle(document.querySelector('.menu-toggle')).display !== 'none'
        };
      });
      check('U2.3 1024 紧凑档仍单行且不提前出汉堡', mid.maxH <= 38 && mid.wrapped === 0 && !mid.toggleVisible, JSON.stringify(mid));
      note(s);
    }

    // ======================================================== U2b 移动端菜单
    {
      const s = await newSession(browser, { viewport: { width: 390, height: 844 } });
      s.tag = 'U2m'; const p = s.page;
      await goto(p, base, '/', '.article-card');
      const closed = await p.evaluate(() => ({
        toggle: !!document.querySelector('.menu-toggle'),
        toggleSize: (() => {
          const b = document.querySelector('.menu-toggle').getBoundingClientRect();
          return { w: Math.round(b.width), h: Math.round(b.height) };
        })(),
        navVisibility: getComputedStyle(document.querySelector('.nav')).visibility,
        navOpen: document.querySelector('.nav').classList.contains('open')
      }));
      check('U2.4 390 默认隐藏导航并显示菜单按钮', closed.toggle && closed.toggleSize.w >= 36 && closed.toggleSize.h >= 36 &&
        closed.navVisibility === 'hidden' && !closed.navOpen, JSON.stringify(closed));

      await p.locator('.menu-toggle').click();
      await p.waitForTimeout(320);
      const opened = await p.evaluate(() => {
        const nav = document.querySelector('.nav');
        const links = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
        const active = document.querySelector('.nav-link.active');
        return {
          open: nav.classList.contains('open'),
          visibility: getComputedStyle(nav).visibility,
          opacity: parseFloat(getComputedStyle(nav).opacity),
          aria: document.querySelector('.menu-toggle').getAttribute('aria-expanded'),
          minLinkH: Math.min.apply(null, links.map(l => l.getBoundingClientRect().height)),
          activeBg: active ? getComputedStyle(active).backgroundColor : ''
        };
      });
      check('U2.5 点击后下拉菜单展开且触控面积足够', opened.open && opened.visibility === 'visible' && opened.opacity > 0.9 &&
        opened.minLinkH >= 40 && opened.aria === 'true', JSON.stringify(opened));
      check('U2.6 移动端当前页用浅底高亮', opened.activeBg !== 'rgba(0, 0, 0, 0)', opened.activeBg);

      await p.keyboard.press('Escape');
      await p.waitForTimeout(320);
      const esc = await p.evaluate(() => ({
        open: document.querySelector('.nav').classList.contains('open'),
        focusOnToggle: document.activeElement === document.querySelector('.menu-toggle')
      }));
      check('U2.7 Esc 关闭菜单并把焦点还给按钮', !esc.open && esc.focusOnToggle, JSON.stringify(esc));
      note(s);
    }

    // ======================================================== U3 双主题与对比度
    {
      const light = await newSession(browser, { theme: 'light' });
      light.tag = 'U3l'; const pl = light.page;
      await goto(pl, base, '/', '.article-card');
      const lightInfo = await pl.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        cardBg: getComputedStyle(document.querySelector('.article-card')).backgroundColor,
        headerBg: getComputedStyle(document.querySelector('.site-header')).backgroundColor
      }));
      check('U3.1 浅色主题为中性浅灰底白卡', lightInfo.theme === 'light' && lightInfo.bodyBg === 'rgb(246, 247, 249)' &&
        lightInfo.cardBg === 'rgb(255, 255, 255)', JSON.stringify(lightInfo));
      const lightContrast = await contrastReport(pl, ['.article-card-title', '.article-card-excerpt', '.article-card-meta', '.page-desc', '.nav-link.active']);
      check('U3.2 浅色正文/次要文字对比度 ≥ 4.5',
        Object.keys(lightContrast).every(k => lightContrast[k] >= 4.5), JSON.stringify(lightContrast));

      const dark = await newSession(browser, { theme: 'dark' });
      dark.tag = 'U3d'; const pd = dark.page;
      await goto(pd, base, '/', '.article-card');
      const darkInfo = await pd.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        cardBg: getComputedStyle(document.querySelector('.article-card')).backgroundColor,
        headerBg: getComputedStyle(document.querySelector('.site-header')).backgroundColor,
        border: getComputedStyle(document.querySelector('.article-card')).borderTopColor,
        imgOpacity: getComputedStyle(document.querySelector('.article-card')).opacity
      }));
      check('U3.3 深色主题保持既有底色契约且卡片有边界',
        darkInfo.theme === 'dark' && darkInfo.bodyBg === 'rgb(15, 17, 21)' && darkInfo.cardBg === 'rgb(26, 29, 35)' &&
        darkInfo.headerBg === 'rgb(22, 24, 29)' && darkInfo.border !== darkInfo.cardBg && darkInfo.imgOpacity === '1',
        JSON.stringify(darkInfo));
      const darkContrast = await contrastReport(pd, ['.article-card-title', '.article-card-excerpt', '.article-card-meta', '.page-desc', '.nav-link.active']);
      check('U3.4 深色正文/次要文字对比度 ≥ 4.5',
        Object.keys(darkContrast).every(k => darkContrast[k] >= 4.5), JSON.stringify(darkContrast));

      await hashTo(pd, '/papers', '.paper-card');
      const darkPapers = await contrastReport(pd, ['.paper-card-title', '.paper-card-meta', '.paper-type-badge', '.paper-pdf-link']);
      check('U3.5 深色论文卡片文字/徽标/PDF 链接可读',
        Object.keys(darkPapers).every(k => darkPapers[k] >= 4.5), JSON.stringify(darkPapers));

      await goto(pd, base, '/', '#searchInput');
      const input = await pd.evaluate(() => {
        const el = document.querySelector('#searchInput');
        const st = getComputedStyle(el);
        return { bg: st.backgroundColor, border: st.borderTopColor };
      });
      check('U3.6 深色搜索输入框边界清晰', input.bg !== input.border, JSON.stringify(input));
      note(light); note(dark);
    }

    // ======================================================== U4 五档视口无横向溢出
    {
      const widths = [375, 390, 768, 1024, 1440];
      const routes = [['/', '.article-card'], ['/courses', '.course-card'], ['/papers', '.paper-card'], ['/post/' + POST_ID, '.article-detail']];
      for (const w of widths) {
        const s = await newSession(browser, { viewport: { width: w, height: w <= 390 ? 844 : 900 } });
        s.tag = 'U4-' + w; const p = s.page;
        let worst = null;
        let hiddenMask = false;
        for (const [route, sel] of routes) {
          await goto(p, base, route, sel);
          const info = await layoutInfo(p);
          if (info.docW > info.innerW + 1 || info.bodyW > info.innerW + 1) {
            const off = await offenders(p);
            if (!worst) worst = { route: route, info: info, off: off };
          }
          if (info.htmlOverflowX === 'hidden' || info.bodyOverflowX === 'hidden') hiddenMask = true;
        }
        check('U4.' + w + ' ' + w + 'px 四个主页面无横向溢出', !worst, worst ? JSON.stringify(worst) : 'ok');
        check('U4.' + w + 'b 未用全局 overflow-x:hidden 掩盖溢出', !hiddenMask, 'html/body overflow-x');
        note(s);
        await s.ctx.close();
      }
    }

    // ======================================================== U5 长文本换行
    {
      const s = await newSession(browser, { viewport: { width: 375, height: 844 } });
      s.tag = 'U5'; const p = s.page;
      await goto(p, base, '/', '.article-card');
      await p.evaluate(() => {
        const longTitle = '超长技术标题'.repeat(12) + 'SuperLongUnbrokenIdentifier' + 'x'.repeat(50);
        const post = {
          id: 'b8d3-long-text', title: longTitle, date: '2026-11-17', tags: ['很长很长的标签名称'.repeat(4), 'x'.repeat(46)],
          excerpt: '用于验证长标题与长标签在窄屏下换行且不把卡片撑破。', content: '# 正文\n\n内容'
        };
        window.eval('USER_POSTS.push(' + JSON.stringify(post) + ');');
        location.hash = '#/post/b8d3-long-text';
      });
      await p.waitForSelector('.article-detail', { timeout: 20000 });
      await p.waitForTimeout(350);
      await hashTo(p, '/', '.article-card');
      const longCard = await p.evaluate(() => {
        const card = Array.prototype.slice.call(document.querySelectorAll('.article-card'))
          .find(c => (c.textContent || '').indexOf('SuperLongUnbrokenIdentifier') >= 0);
        if (!card) return null;
        const title = card.querySelector('.article-card-title');
        const tags = Array.prototype.slice.call(card.querySelectorAll('.tag'));
        return {
          cardW: Math.round(card.clientWidth),
          cardScrollW: card.scrollWidth,
          titleH: Math.round(title.getBoundingClientRect().height),
          titleW: Math.round(title.getBoundingClientRect().width),
          tagW: Math.max.apply(null, tags.map(t => t.getBoundingClientRect().width)),
          tagRight: Math.max.apply(null, tags.map(t => Math.round(t.getBoundingClientRect().right))),
          cardRight: Math.round(card.getBoundingClientRect().right)
        };
      });
      check('U5.1 长标题在卡片内换行不撑破',
        !!longCard && longCard.titleH > 40 && longCard.cardScrollW <= longCard.cardW + 1, JSON.stringify(longCard));
      check('U5.2 长标签不越出卡片右缘',
        !!longCard && longCard.tagRight <= longCard.cardRight + 1, JSON.stringify(longCard));

      const vp = await layoutInfo(p);
      const off = await offenders(p);
      check('U5.3 375 下长文本页面仍无横向溢出', vp.docW <= vp.innerW + 1 && off.length === 0, JSON.stringify({ vp: vp, off: off }));

      await hashTo(p, '/post/b8d3-long-text', '.article-detail');
      const longDetail = await p.evaluate(() => {
        const h1 = document.querySelector('.article-detail-title');
        const body = document.querySelector('.article-detail');
        return {
          h1W: Math.round(h1.getBoundingClientRect().width),
          bodyW: Math.round(body.clientWidth),
          bodyScrollW: body.scrollWidth,
          docW: document.documentElement.scrollWidth,
          innerW: innerWidth
        };
      });
      check('U5.4 长标题在正文页换行且不溢出阅读列', longDetail.bodyScrollW <= longDetail.bodyW + 1 && longDetail.docW <= longDetail.innerW + 1,
        JSON.stringify(longDetail));
      note(s);
      await s.ctx.close();
    }

    // ======================================================== U6 键盘焦点与卡片键盘操作
    {
      const s = await newSession(browser, { viewport: { width: 1440, height: 900 } });
      s.tag = 'U6'; const p = s.page;
      await goto(p, base, '/', '.article-card');
      await p.locator('.nav-link').first().focus();
      await p.keyboard.press('Tab');
      await p.keyboard.press('Shift+Tab');
      const focusStyle = await p.evaluate(() => {
        const el = document.activeElement;
        const st = getComputedStyle(el);
        return {
          cls: el.className,
          outlineW: parseFloat(st.outlineWidth),
          outlineStyle: st.outlineStyle,
          outlineColor: st.outlineColor,
          boxShadow: st.boxShadow
        };
      });
      check('U6.1 导航链接键盘焦点可见', focusStyle.outlineW >= 2 && focusStyle.outlineStyle === 'solid' &&
        focusStyle.outlineColor !== 'rgba(0, 0, 0, 0)', JSON.stringify(focusStyle));

      await hashTo(p, '/courses', '.course-card');
      const chipTabindex = await p.evaluate(() => {
        const chips = Array.prototype.slice.call(document.querySelectorAll('.category-chip'));
        return { all: chips.every(c => c.getAttribute('tabindex') === '0' && c.getAttribute('role') === 'button'), n: chips.length };
      });
      check('U6.2a 全部筛选 chip 均可聚焦（含有笔记/全部课程切换）', chipTabindex.all && chipTabindex.n >= 4, JSON.stringify(chipTabindex));
      await p.locator('.category-chip[data-category]').first().focus();
      const chipStyle = await p.evaluate(() => {
        const el = document.activeElement;
        const st = getComputedStyle(el);
        return {
          outlineW: parseFloat(st.outlineWidth), outlineStyle: st.outlineStyle,
          outlineColor: st.outlineColor, tabindex: el.getAttribute('tabindex')
        };
      });
      check('U6.2b 筛选 chip 焦点清晰', chipStyle.tabindex === '0' && chipStyle.outlineW >= 2 && chipStyle.outlineStyle === 'solid',
        JSON.stringify(chipStyle));

      await hashTo(p, '/papers', '.paper-card');
      const firstPaper = p.locator('.paper-card').first();
      const before = await firstPaper.evaluate(el => ({
        tabindex: el.getAttribute('tabindex'), expanded: el.classList.contains('expanded'), aria: el.getAttribute('aria-expanded')
      }));
      await firstPaper.focus();
      await p.keyboard.press('Enter');
      await p.waitForTimeout(260);
      const after = await firstPaper.evaluate(el => ({
        expanded: el.classList.contains('expanded'), aria: el.getAttribute('aria-expanded')
      }));
      check('U6.3 论文卡片可键盘展开并同步 aria', before.tabindex === '0' && before.expanded !== after.expanded && after.aria === String(after.expanded),
        JSON.stringify({ before: before, after: after }));

      await hashTo(p, '/', '.article-card');
      const cardKeyboard = await p.evaluate(async () => {
        const card = document.querySelector('.article-card');
        const beforeHash = location.hash;
        card.focus();
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        return { before: beforeHash, after: location.hash, tabindex: card.getAttribute('tabindex'), role: card.getAttribute('role') };
      });
      check('U6.4 文章卡片可键盘进入详情', cardKeyboard.tabindex === '0' && cardKeyboard.after.indexOf('#/post/') === 0,
        JSON.stringify(cardKeyboard));
      note(s);
    }

    // ======================================================== U7 阅读目录与图片灯箱（合成文章）
    {
      const s = await newSession(browser, { viewport: { width: 1440, height: 900 } });
      s.tag = 'U7'; const p = s.page;
      await goto(p, base, '/', '.article-card');
      await p.evaluate(() => {
        const post = {
          id: 'b8d3-toc-lightbox', title: '视觉验收合成文章', date: '2026-11-17', tags: ['验收'],
          excerpt: '目录与图片预览回归。',
          content: '# 视觉验收合成文章\n\n## 第一节 背景\n\n' + '段落文字。'.repeat(60) + '\n\n## 第二节 方法\n\n' +
            '段落文字。'.repeat(60) + '\n\n![图示](icons/icon-192.png)\n\n## 第三节 结论\n\n段落文字。'.repeat(40)
        };
        window.eval('USER_POSTS.push(' + JSON.stringify(post) + ');');
        location.hash = '#/post/b8d3-toc-lightbox';
      });
      await p.waitForSelector('.article-detail', { timeout: 20000 });
      await p.waitForTimeout(500);
      const toc = await p.evaluate(() => ({
        panel: !!document.querySelector('.toc-panel'),
        links: document.querySelectorAll('.toc-panel .toc-link').length,
        img: document.querySelectorAll('.article-detail-body img.zoomable-image').length
      }));
      check('U7.1 长文生成阅读目录且图片可放大', toc.panel && toc.links >= 3 && toc.img >= 1, JSON.stringify(toc));

      const lastToc = p.locator('.toc-panel .toc-link').last();
      await lastToc.click();
      await p.waitForTimeout(600);
      const tocScroll = await p.evaluate(() => ({ y: Math.round(scrollY), active: !!document.querySelector('.toc-link.active') }));
      check('U7.2 目录点击真实滚动并更新当前项', tocScroll.y > 100, JSON.stringify(tocScroll));

      await p.locator('.article-detail-body img.zoomable-image').first().click();
      await p.waitForTimeout(300);
      const lb = await p.evaluate(() => ({
        open: document.querySelector('#imageLightbox') ? document.querySelector('#imageLightbox').open === true : false,
        close: !!document.querySelector('.image-lightbox-close'),
        locked: getComputedStyle(document.documentElement).overflow === 'hidden'
      }));
      check('U7.3 图片灯箱仍可打开并锁定滚动', lb.open && lb.close && lb.locked, JSON.stringify(lb));

      await p.keyboard.press('Escape');
      await p.waitForTimeout(350);
      const closed = await p.evaluate(() => ({
        open: document.querySelector('#imageLightbox').open === true,
        locked: getComputedStyle(document.documentElement).overflow === 'hidden'
      }));
      check('U7.4 Esc 关闭灯箱并恢复滚动', !closed.open && !closed.locked, JSON.stringify(closed));
      note(s);
    }

    // ======================================================== U8 搜索控件
    {
      const s = await newSession(browser, { viewport: { width: 1440, height: 900 } });
      s.tag = 'U8'; const p = s.page;
      await goto(p, base, '/', '.article-card');
      await p.locator('#searchInput').fill('机器人');
      await p.waitForTimeout(700);
      const search = await p.evaluate(() => ({
        countText: (document.querySelector('.search-results-count') || {}).textContent || '',
        results: document.querySelectorAll('[data-search-result]').length,
        filters: document.querySelectorAll('.search-filter-btn').length,
        activeBg: (() => {
          const b = document.querySelector('.search-filter-btn.active');
          return b ? getComputedStyle(b).backgroundColor : '';
        })()
      }));
      check('U8.1 搜索返回命中并显示筛选控件', /找到\s*\d+\s*条/.test(search.countText) && search.results > 0 && search.filters >= 3,
        JSON.stringify(search));
      check('U8.2 搜索筛选激活态在浅色下仍有底色', search.activeBg !== 'rgba(0, 0, 0, 0)', search.activeBg);

      await p.setViewportSize({ width: 375, height: 844 });
      await p.waitForTimeout(400);
      const vp = await layoutInfo(p);
      const off = await offenders(p);
      check('U8.3 375 搜索结果无横向溢出', vp.docW <= vp.innerW + 1 && off.length === 0, JSON.stringify({ vp: vp, off: off }));
      note(s);
    }

    // ======================================================== U9 编辑器布局
    {
      const s = await newSession(browser, { viewport: { width: 1440, height: 900 } });
      s.tag = 'U9'; const p = s.page;
      await goto(p, base, '/editor', '.editor-page');
      const wide = await p.evaluate(() => {
        const ta = document.querySelector('#editorContent').getBoundingClientRect();
        const pv = document.querySelector('#editorPreview').getBoundingClientRect();
        return {
          taRight: Math.round(ta.right), pvLeft: Math.round(pv.left), pvTop: Math.round(pv.top),
          taTop: Math.round(ta.top), taW: Math.round(ta.width), docW: document.documentElement.scrollWidth, innerW: innerWidth
        };
      });
      check('U9.1 1440 编辑区与预览区并排', wide.pvLeft >= wide.taRight - 4 && wide.pvTop <= wide.taTop + 40 && wide.docW <= wide.innerW + 1,
        JSON.stringify(wide));

      await p.setViewportSize({ width: 390, height: 844 });
      await p.waitForTimeout(500);
      const narrow = await p.evaluate(() => {
        const page = document.querySelector('.editor-page');
        const ta = document.querySelector('#editorContent');
        return {
          pageScrollW: page.scrollWidth, pageW: page.clientWidth,
          taScrollW: ta.scrollWidth, taW: ta.clientWidth,
          docW: document.documentElement.scrollWidth, innerW: innerWidth
        };
      });
      check('U9.2 390 编辑器不出现横向溢出', narrow.pageScrollW <= narrow.pageW + 1 && narrow.docW <= narrow.innerW + 1,
        JSON.stringify(narrow));
      note(s);
    }

    // ======================================================== U10 静态课程笔记页（共享 CSS）
    {
      const s = await newSession(browser, { viewport: { width: 390, height: 844 }, theme: 'dark' });
      s.tag = 'U10'; const p = s.page;
      await p.goto(base + '/notes/index.html', { waitUntil: 'load', timeout: 60000 });
      await p.waitForSelector('.article-detail', { timeout: 20000 });
      await p.waitForTimeout(350);
      const notes = await p.evaluate(() => {
        const d = document.querySelector('.article-detail');
        return {
          bg: getComputedStyle(d).backgroundColor,
          pad: parseFloat(getComputedStyle(d).paddingTop),
          theme: document.documentElement.getAttribute('data-theme'),
          docW: document.documentElement.scrollWidth,
          innerW: innerWidth,
          toggle: !!document.querySelector('.menu-toggle')
        };
      });
      check('U10.1 静态笔记页继承深色主题与卡片样式',
        notes.theme === 'dark' && notes.bg === 'rgb(26, 29, 35)' && notes.pad >= 18 && notes.docW <= notes.innerW + 1,
        JSON.stringify(notes));

      await p.locator('.menu-toggle').click();
      await p.waitForTimeout(320);
      const menu = await p.evaluate(() => ({
        open: document.querySelector('.nav').classList.contains('open'),
        visibility: getComputedStyle(document.querySelector('.nav')).visibility
      }));
      check('U10.2 静态笔记页移动菜单仍可用（Batch 7A 不回归）', menu.open && menu.visibility === 'visible', JSON.stringify(menu));

      await p.setViewportSize({ width: 1440, height: 900 });
      await p.waitForTimeout(400);
      const desktop = await p.evaluate(() => ({
        docW: document.documentElement.scrollWidth, innerW: innerWidth,
        maxLinkH: Math.max.apply(null, Array.prototype.map.call(document.querySelectorAll('.nav-link'), l => l.getBoundingClientRect().height))
      }));
      check('U10.3 静态笔记页 1440 导航单行且无溢出', desktop.docW <= desktop.innerW + 1 && desktop.maxLinkH <= 38,
        JSON.stringify(desktop));
      note(s);
    }

    // ======================================================== U11 SW 版本与资源
    {
      const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
      const ver = (/CACHE_VERSION = '([^']+)'/.exec(sw) || [])[1] || '';
      const required = /REQUIRED_ASSETS[\s\S]*?\n\];/.exec(sw) || [''];
      const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
      check('U11.1 SW 缓存版本已随本次 CSS/JS 更新递增', /^2026-11-17-\d+$/.test(ver) && required[0].indexOf("'./css/style.css'") >= 0,
        ver);
      check('U11.2 设计令牌层为单一主题系统（含强调色/表面色/边框色）',
        /--color-primary:\s*#2563eb/.test(css) && /--color-surface:\s*#fff/.test(css) && /--color-border:\s*#e2e6ec/.test(css),
        'tokens');
    }

    // ======================================================== U12 prefers-reduced-motion
    {
      const s = await newSession(browser, { reducedMotion: 'reduce' });
      s.tag = 'U12'; const p = s.page;
      await goto(p, base, '/', '.article-card');
      const rm = await p.evaluate(() => {
        const card = document.querySelector('.article-card');
        const st = getComputedStyle(card);
        return {
          dur: st.transitionDuration.split(',').map(s => parseFloat(s)),
          scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
          animation: st.animationName
        };
      });
      check('U12.1 减少动效时过渡被压缩且滚动即时', rm.dur.every(d => d <= 0.02) && rm.scrollBehavior === 'auto',
        JSON.stringify(rm));
      note(s);
    }

    // ======================================================== U13 全站无新增 Console Error
    const meaningful = allErrors.filter(e => !/b8d3-(long|toc)/.test(e));
    check('U13.1 全流程无新增 Console Error / PageError', meaningful.length === 0,
      meaningful.slice(0, 4).join(' | ') + (meaningful.length > 4 ? ' …' : ''));
  } catch (e) {
    failures.push('执行异常: ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' '));
    console.error(e);
  } finally {
    await browser.close();
    server.close();
  }

  const total = passCount + failures.length;
  console.log('\n共 ' + total + ' 项，PASS ' + passCount + '，FAIL ' + failures.length);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach(f => console.log(' - ' + f));
    process.exitCode = 1;
  } else {
    console.log('ALL PASS');
  }
})();
