#!/usr/bin/env node
'use strict';
/**
 * Batch 8D-2A：真实 Chromium 下的 Markdown 图片放大查看器
 *
 * 覆盖：打开/关闭、Esc、焦点恢复、alt 说明、空 alt、加载失败、链接内图片保留、
 * 背景滚动锁定与恢复、XSS、路由切换、375/390/768/1280 布局、reduced-motion、
 * 不影响目录/进度/复制与编辑器本地预览、SW 缓存升级。
 *
 * 全部使用合成 Markdown Fixture，不修改正式文章。
 * 用法：node tests/browser/image-lightbox.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const OLD_CACHE_VERSION = '2026-11-16-2';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function svgDataUri(w, h, fill) {
  return 'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
    '<rect width="' + w + '" height="' + h + '" fill="' + fill + '"/></svg>'
  ).toString('base64');
}
const IMG_A = svgDataUri(480, 320, '#3b82f6');
const IMG_B = svgDataUri(120, 120, '#ef4444');

function article(base) {
  return [
    '# 图片合成文章', '',
    '## 第一节', '',
    '![示例说明](' + IMG_A + ')', '',
    '![](' + IMG_B + ')', '',
    '[![链接图](' + IMG_A + ')](https://example.com/page)', '',
    '![坏图](' + base + PREFIX + '/missing-image.png)', '',
    '![<img src=x onerror=window.__xss=1>](' + IMG_B + ')', '',
    '## 第二节', '',
    '```js', 'console.log(1);', '```', '',
    '## 第三节', '',
    '结尾正文。'
  ].join('\n');
}

async function session(browser, base, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1280, height: 900 },
    serviceWorkers: o.sw ? 'allow' : 'block'
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
  return { ctx, page, errors, dialogs };
}

async function mount(page, base, id) {
  const post = {
    id: id, title: '图片合成', date: '2026-11-16', tags: ['测试'],
    excerpt: '图片测试', content: article(base)
  };
  await page.evaluate((p) => {
    window.eval('USER_POSTS.push(' + JSON.stringify(p) + ');');
    window.eval("location.hash = '#/post/" + p.id + "'");
  }, post);
  await page.waitForSelector('.article-detail-body img.zoomable-image', { timeout: 15000 });
  await page.waitForTimeout(500);
}

function lightboxState(page) {
  return page.evaluate(() => {
    const d = document.getElementById('imageLightbox');
    const img = d && d.querySelector('.image-lightbox-img');
    const caption = d && d.querySelector('.image-lightbox-caption');
    const error = d && d.querySelector('.image-lightbox-error');
    const close = d && d.querySelector('.image-lightbox-close');
    const r = img ? img.getBoundingClientRect() : null;
    return {
      exists: !!d,
      open: d ? d.open === true || d.hasAttribute('open') : false,
      src: img ? img.getAttribute('src') : '',
      hidden: img ? img.hidden : null,
      caption: caption ? caption.textContent : '',
      captionHidden: caption ? caption.hidden : null,
      errorHidden: error ? error.hidden : null,
      closeW: close ? Math.round(close.getBoundingClientRect().width) : 0,
      rect: r ? { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) } : null,
      innerW: innerWidth, innerH: innerHeight,
      scrollLocked: getComputedStyle(document.documentElement).overflow === 'hidden',
      activeClass: document.activeElement ? document.activeElement.className : ''
    };
  });
}

(async () => {
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

  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const cacheVer = (/CACHE_VERSION = '([^']+)'/.exec(swSrc) || [])[1];

  try {
    // ---------------------------------------------------------- S1 桌面交互
    {
      const s = await session(browser, base);
      const p = s.page;
      await mount(p, base, 'b8d2a-desktop');

      const marked = await p.evaluate(() => ({
        all: document.querySelectorAll('.article-detail-body img').length,
        zoomable: document.querySelectorAll('.article-detail-body img.zoomable-image').length,
        linkImgs: document.querySelectorAll('.article-detail-body a img').length,
        linkZoomable: document.querySelectorAll('.article-detail-body a img.zoomable-image').length,
        linkHref: (document.querySelector('.article-detail-body a img') || {}).closest
          ? document.querySelector('.article-detail-body a img').closest('a').getAttribute('href') : ''
      }));
      check('L1 普通图片可放大、链接内图片不被拦截',
        marked.all >= 4 && marked.zoomable >= 3 && marked.linkImgs >= 1 &&
        marked.linkZoomable === 0 && marked.linkHref === 'https://example.com/page',
        JSON.stringify(marked));

      const first = p.locator('.article-detail-body img.zoomable-image').first();
      const firstAlt = await first.getAttribute('alt');
      await first.click();
      await p.waitForTimeout(250);
      let st = await lightboxState(p);
      check('L2 点击打开查看器并显示原图', st.open && st.src === IMG_A, st.src.slice(0, 32));
      check('L3 alt 作为说明显示', st.caption === '示例说明' && st.captionHidden === false, st.caption);
      check('L4 图片适应视口且保持宽高比',
        st.rect && st.rect.w <= st.innerW && st.rect.h <= st.innerH &&
        Math.abs(st.rect.w / st.rect.h - 480 / 320) < 0.06,
        JSON.stringify(st.rect));
      check('L5 打开时锁定背景滚动', st.scrollLocked);
      check('L6 打开后焦点在关闭按钮', /image-lightbox-close/.test(st.activeClass), st.activeClass);

      await p.locator('.image-lightbox-close').click();
      await p.waitForTimeout(250);
      st = await lightboxState(p);
      const focusBack = await p.evaluate(() => document.activeElement && document.activeElement.tagName === 'IMG');
      check('L7 关闭按钮关闭查看器', !st.open);
      check('L8 关闭后焦点回到原图片', focusBack);
      check('L9 关闭后恢复背景滚动', !st.scrollLocked);

      // 滚动位置恢复
      await p.evaluate(() => window.scrollTo(0, 520));
      await p.waitForTimeout(200);
      await first.click();
      await p.waitForTimeout(250);
      // 浏览器在 mousedown 聚焦图片时可能微调滚动；以"打开查看器时"的位置为基准
      const yAtOpen = await p.evaluate(() => Math.round(window.scrollY));
      await p.locator('.image-lightbox-close').click();
      await p.waitForTimeout(350);
      const afterScroll = await p.evaluate(() => ({
        y: Math.round(window.scrollY),
        max: Math.round(document.documentElement.scrollHeight - innerHeight),
        overflow: getComputedStyle(document.documentElement).overflow
      }));
      check('L10 关闭后恢复打开时的滚动位置',
        Math.abs(afterScroll.y - yAtOpen) <= 2,
        yAtOpen + ' -> ' + JSON.stringify(afterScroll));

      // Esc
      await first.click();
      await p.waitForTimeout(200);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
      st = await lightboxState(p);
      check('L11 Esc 关闭查看器', !st.open);
      check('L12 Esc 关闭后焦点回到原图片',
        await p.evaluate(() => document.activeElement && document.activeElement.tagName === 'IMG'));

      // 空 alt
      await p.locator('.article-detail-body img.zoomable-image').nth(1).click();
      await p.waitForTimeout(200);
      st = await lightboxState(p);
      check('L13 空 alt 不显示无意义说明', st.caption === '' && st.captionHidden === true);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(200);

      // 加载失败
      const broken = p.locator('.article-detail-body img[src*="missing-image"]').first();
      await broken.click();
      await p.waitForTimeout(700);
      st = await lightboxState(p);
      check('L14 图片加载失败显示明确提示', st.errorHidden === false && st.hidden === true,
        JSON.stringify({ errorHidden: st.errorHidden, hidden: st.hidden }));
      await p.keyboard.press('Escape');
      await p.waitForTimeout(200);

      // XSS
      const xssImg = p.locator('.article-detail-body img[alt*="onerror"]').first();
      await xssImg.click();
      await p.waitForTimeout(250);
      const xss = await p.evaluate(() => ({
        flag: !!window.__xss,
        captionText: document.querySelector('.image-lightbox-caption').textContent,
        captionHtml: document.querySelector('.image-lightbox-caption').innerHTML,
        imgs: document.querySelectorAll('#imageLightbox img').length
      }));
      check('L15 alt 中的 HTML 只作为文本且不执行',
        !xss.flag && xss.captionText.indexOf('<img') !== -1 &&
        xss.captionHtml.indexOf('<img') === -1 && xss.imgs === 1, JSON.stringify(xss));
      await p.keyboard.press('Escape');
      await p.waitForTimeout(200);

      // 不影响阅读工具
      const tools = await p.evaluate(() => ({
        toc: document.querySelectorAll('#tocPanel .toc-link').length,
        progress: !!document.getElementById('readingProgress'),
        copies: document.querySelectorAll('.copy-btn').length,
        lightboxCopies: document.querySelectorAll('#imageLightbox .copy-btn').length
      }));
      check('L16 不影响目录 / 阅读进度 / 代码复制',
        tools.toc >= 3 && tools.progress && tools.copies === 1 && tools.lightboxCopies === 0,
        JSON.stringify(tools));
      check('L17 无页面脚本错误', s.errors.length === 0 && s.dialogs.length === 0,
        s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- S2 移动端 / reduced-motion
    {
      const s = await session(browser, base, { viewport: { width: 390, height: 844 } });
      const p = s.page;
      await mount(p, base, 'b8d2a-mobile');

      for (const w of [375, 390, 768, 1280]) {
        await p.setViewportSize({ width: w, height: w <= 390 ? 812 : 900 });
        await p.waitForTimeout(200);
        await p.evaluate(() => window.scrollTo(0, 0));
        await p.locator('.article-detail-body img.zoomable-image').first().click();
        await p.waitForTimeout(300);
        const st = await lightboxState(p);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        check('M' + w + ' 打开后无全页横向溢出', overflow <= 1, overflow);
        check('M' + w + ' 图片在视口内且关闭按钮易点击',
          st.rect && st.rect.w <= st.innerW && st.rect.h <= st.innerH && st.closeW >= 40,
          JSON.stringify({ rect: st.rect, closeW: st.closeW }));
        await p.keyboard.press('Escape');
        await p.waitForTimeout(200);
      }

      await p.setViewportSize({ width: 390, height: 844 });
      await p.evaluate(() => window.scrollTo(0, 320));
      await p.waitForTimeout(150);
      const y0 = await p.evaluate(() => Math.round(window.scrollY));
      await p.emulateMedia({ reducedMotion: 'reduce' });
      await p.locator('.article-detail-body img.zoomable-image').first().click();
      await p.waitForTimeout(250);
      const rmState = await lightboxState(p);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
      const y1 = await p.evaluate(() => Math.round(window.scrollY));
      check('M-reduced 打开/关闭正常且滚动位置恢复',
        rmState.open && Math.abs(y1 - y0) <= 2, y0 + ' -> ' + y1);
      check('M-no-error 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- S3 路由切换 / 编辑器 / SW
    {
      const s = await session(browser, base, { sw: true, viewport: { width: 1280, height: 900 } });
      const p = s.page;
      await mount(p, base, 'b8d2a-route');
      await p.locator('.article-detail-body img.zoomable-image').first().click();
      await p.waitForTimeout(250);
      check('R1 路由切换前查看器已打开', (await lightboxState(p)).open);
      await p.evaluate(() => { window.eval("location.hash = '#/about'"); });
      await p.waitForTimeout(500);
      const afterRoute = await lightboxState(p);
      check('R2 路由切换后关闭并清理查看器',
        !afterRoute.open && !afterRoute.scrollLocked, JSON.stringify(afterRoute));

      await p.evaluate(() => { window.eval("location.hash = '#/editor'"); });
      await p.waitForSelector('#editorTitle', { state: 'visible', timeout: 10000 });
      const editor = await p.evaluate(() => ({
        preview: !!document.getElementById('editorPreview'),
        zoomable: document.querySelectorAll('#editorPreview img.zoomable-image').length,
        lightbox: !!document.getElementById('imageLightbox')
      }));
      check('R3 编辑器本地图片预览不被污染', editor.zoomable === 0 && editor.preview,
        JSON.stringify(editor));

      await sleep(1500);
      const caches = await p.evaluate(() => (window.caches ? caches.keys() : []));
      check('R4 CACHE_VERSION 已递增',
        !!cacheVer && cacheVer > OLD_CACHE_VERSION && cacheVer === '2026-11-17-1', cacheVer);
      check('R5 SW 使用当前缓存版本', caches.some(n => n.indexOf(cacheVer) !== -1), caches.join(','));
      check('R6 旧版本缓存已清理', !caches.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), caches.join(','));
      check('R7 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
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
