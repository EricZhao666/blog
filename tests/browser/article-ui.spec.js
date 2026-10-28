#!/usr/bin/env node
'use strict';
/**
 * Batch 6D：文章 UI 验收（真实 Chromium）
 * 覆盖：文章目录、代码复制、阅读进度、快速切换不串页、移动端可读。
 *
 * 用法：node tests/browser/article-ui.spec.js
 * 退出码：0 通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const { chromium, devices } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const POST_A = 'deep-learning-in-slam';
const POST_B = 'embodied-ai-notes';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitController(page, ms = 20000) {
  return page.evaluate(async (limit) => {
    const t0 = Date.now();
    while (Date.now() - t0 < limit) {
      if (navigator.serviceWorker.controller) return true;
      await new Promise(r => setTimeout(r, 40));
    }
    return false;
  }, ms);
}

async function openArticle(page, id) {
  await page.evaluate((pid) => { location.hash = '#/post/' + pid; }, id);
  await page.waitForFunction(() => {
    const b = document.querySelector('#app .article-detail-body');
    return !!b && b.textContent.trim().length > 200;
  }, null, { timeout: 30000 });
  await sleep(600);                     // 等延后的增强（TOC/复制/进度/高亮）落地
}

async function run(browser, base, label, contextOptions, expectMobile) {
  const ctx = await browser.newContext(contextOptions);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 100)));
  await page.goto(base + PREFIX + '/', { waitUntil: 'load', timeout: 60000 });
  await waitController(page);

  await openArticle(page, POST_A);

  const ui = await page.evaluate(() => {
    const toc = document.getElementById('tocPanel');
    const links = toc ? toc.querySelectorAll('a').length : 0;
    const copies = document.querySelectorAll('.copy-btn').length;
    const progress = document.querySelector('[class*="progress"], [id*="progress"]');
    const tocToggle = document.querySelector('[id*="toc"][class*="toggle"], [class*="toc-toggle"]');
    return {
      toc: !!toc, tocLinks: links, copies: copies,
      progress: !!progress,
      progressWidth: progress ? (progress.style.width || getComputedStyle(progress).width) : null,
      tocToggle: !!tocToggle,
      highlighted: document.querySelectorAll('.hljs, [data-highlighted="yes"]').length
    };
  });
  check(label + ' 文章目录已生成', ui.toc && ui.tocLinks >= 3, 'links=' + ui.tocLinks);
  check(label + ' 代码块有复制按钮', ui.copies >= 1, 'buttons=' + ui.copies);
  check(label + ' 代码已高亮', ui.highlighted >= 1, 'blocks=' + ui.highlighted);
  check(label + ' 阅读进度元素存在', ui.progress, ui.progressWidth);

  if (ui.copies >= 1) {
    const copyState = await page.evaluate(async () => {
      const btn = document.querySelector('.copy-btn');
      btn.click();
      await new Promise(r => setTimeout(r, 200));
      return btn.textContent.trim();
    });
    check(label + ' 点击复制有反馈', /复制成功|已复制|✓|copied/i.test(copyState), copyState);
  }

  // 滚动后进度条应该变化：进度是"轨道 + 内层填充"，要读内层的 inline width
  const readProgress = () => page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll('[class*="progress"], [id*="progress"]'));
    const widths = [];
    roots.forEach((el) => {
      if (el.style && el.style.width) widths.push(el.style.width);
      el.querySelectorAll('*').forEach((c) => { if (c.style && c.style.width) widths.push(c.style.width); });
    });
    return widths.length ? widths.join('|') : null;
  });
  const before = await readProgress();
  await page.evaluate(() => window.scrollTo(0, Math.max(200, document.body.scrollHeight / 2)));
  await sleep(400);
  const after = await readProgress();
  // 初始未滚动时进度条可能没有 inline width（视为 0%），只要滚动后出现且数值不同即通过
  check(label + ' 滚动后阅读进度更新', after !== null && after !== before, before + ' -> ' + after);

  // 快速切换：A -> B 立即切，最终必须是 B
  await page.evaluate((ids) => { location.hash = '#/post/' + ids.a; }, { a: POST_A });
  await sleep(80);
  await page.evaluate((ids) => { location.hash = '#/post/' + ids.b; }, { b: POST_B });
  const switched = await page.waitForFunction(() => {
    const b = document.querySelector('#app .article-detail-body');
    return !!b && b.textContent.indexOf('具身智能') !== -1;
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  const leaked = await page.evaluate(() => {
    const t = document.getElementById('app').textContent;
    return t.indexOf('深度学习在SLAM') !== -1 || t.indexOf('深度学习在 SLAM') !== -1;
  });
  check(label + ' 快速切换后显示的是第二篇', switched && !leaked, switched ? (leaked ? '残留上一篇' : 'ok') : 'timeout');

  check(label + ' 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

(async () => {
  const { server } = createServer(ROOT, PREFIX);
  const port = await listen(server, 0);
  const base = 'http://127.0.0.1:' + port;
  let browser;
  try {
    browser = await chromium.launch(Object.assign({ headless: true }, CHANNEL !== 'chromium' ? { channel: CHANNEL } : {}));
  } catch (e) {
    console.error('无法启动浏览器: ' + String(e.message).split('\n')[0]);
    server.close();
    process.exit(2);
  }
  console.log('浏览器: ' + CHANNEL + ' ' + browser.version());
  try {
    await run(browser, base, '桌面', { viewport: { width: 1440, height: 900 } }, false);
    await run(browser, base, '移动', Object.assign({}, devices['Pixel 7']), true);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})();
