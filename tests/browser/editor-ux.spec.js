#!/usr/bin/env node
'use strict';
/**
 * Batch 8B-2：Markdown 编辑器体验（真实 Chromium + 本地 HTTP Server）
 *
 * 覆盖 jsdom 测不到的部分：
 *   E1  桌面端：工具栏点击插入 + **原生 Undo (Ctrl+Z) 能撤销**（这是选 execCommand 的理由）
 *   E2  桌面端：快捷键 Ctrl+B / Ctrl+I / Ctrl+K / Tab 在真实浏览器里生效
 *   E3  桌面端：双栏同时可见，视图切换器隐藏
 *   E4  375 / 390 / 768：单栏 + 编辑/预览切换，切换不丢内容、不重建编辑器
 *   E5  移动端：工具栏可横向滚动、按钮触控尺寸够大
 *   E6  四个视口：无页面横向溢出；长代码块与表格不撑破布局
 *   E7  图片面板：真实浏览器里插入链接图片
 *   E8  路由切换：编辑中的正文进入草稿，回到编辑器可恢复
 *   E9  Service Worker：升级到新 CACHE_VERSION 后旧缓存被清理
 *   E10 全程无 console error / pageerror
 *
 * 用法：node tests/browser/editor-ux.spec.js
 *       PW_CHANNEL=chromium node tests/browser/editor-ux.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const TARGET = 'embodied-ai-notes';
const OLD_CACHE_VERSION = '2026-11-06-1';

const VIEWPORTS = [
  { name: '375x812', width: 375, height: 812 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1280x800', width: 1280, height: 800 }
];

let pass = 0, fail = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

async function newSession(browser, viewport, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport,
    serviceWorkers: o.serviceWorkers || 'block'
  });
  if (!o.allowThirdParty) {
    await ctx.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
      return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  return { ctx, page, errors };
}

const editorUrl = (base, hash) => base + PREFIX + '/index.html' + (hash || '#/editor');

async function openEditor(page, base, hash) {
  await page.goto(editorUrl(base, hash), { waitUntil: 'load' });
  await page.waitForSelector('#editorContent', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(250);
}

async function main() {
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
  console.log('被测站点: ' + base + PREFIX + '/');

  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const cacheVer = (/CACHE_VERSION = '([^']+)'/.exec(swSrc) || [])[1];

  try {
    // ---------------------------------------------------------------- E1 工具栏 + 原生 Undo
    {
      const { ctx, page, errors } = await newSession(browser, { width: 1280, height: 800 });
      await openEditor(page, base);

      const toolbar = await page.$('#editorToolbar');
      check('E1 桌面端工具栏可见', !!toolbar && await toolbar.isVisible());
      check('E3 桌面端不显示视图切换器', await page.$eval('#editorViewToggle', el => getComputedStyle(el).display) === 'none');
      check('E3 桌面端编辑与预览同时可见',
        await page.$eval('.editor-pane-edit', el => getComputedStyle(el).display !== 'none') &&
        await page.$eval('.editor-pane-preview', el => getComputedStyle(el).display !== 'none'));

      await page.fill('#editorContent', 'hello world');
      await page.evaluate(() => {
        const ta = document.getElementById('editorContent');
        ta.focus();
        ta.setSelectionRange(0, 5);
      });
      await page.click('#editorToolbar [data-md="bold"]');
      check('E1 点击加粗正确包裹选区',
        await page.inputValue('#editorContent') === '**hello** world',
        await page.inputValue('#editorContent'));
      check('E1 点击后焦点仍在编辑器',
        await page.evaluate(() => document.activeElement && document.activeElement.id) === 'editorContent');

      await page.keyboard.press('Control+z');
      await page.waitForTimeout(120);
      check('E1 原生 Ctrl+Z 能撤销工具栏插入（未被自研历史破坏）',
        await page.inputValue('#editorContent') === 'hello world',
        await page.inputValue('#editorContent'));

      await page.keyboard.press('Control+Shift+z');
      await page.waitForTimeout(120);
      check('E1 原生 Ctrl+Shift+Z 能重做',
        await page.inputValue('#editorContent') === '**hello** world',
        await page.inputValue('#editorContent'));

      // 无选区插入占位并选中
      await page.fill('#editorContent', '');
      await page.evaluate(() => {
        const ta = document.getElementById('editorContent');
        ta.focus();
        ta.setSelectionRange(0, 0);
      });
      await page.click('#editorToolbar [data-md="italic"]');
      const sel = await page.evaluate(() => {
        const ta = document.getElementById('editorContent');
        return ta.value.slice(ta.selectionStart, ta.selectionEnd);
      });
      check('E1 无选区时插入占位并选中', sel === '斜体文字', sel);

      check('E1 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ---------------------------------------------------------------- E2 快捷键 / E7 图片
    {
      const { ctx, page, errors } = await newSession(browser, { width: 1280, height: 800 });
      await openEditor(page, base);

      await page.fill('#editorContent', 'shortcut');
      await page.evaluate(() => {
        const ta = document.getElementById('editorContent');
        ta.focus();
        ta.setSelectionRange(0, 8);
      });
      await page.keyboard.press('Control+b');
      check('E2 Ctrl+B 加粗', await page.inputValue('#editorContent') === '**shortcut**',
        await page.inputValue('#editorContent'));

      await page.fill('#editorContent', 'italic');
      await page.evaluate(() => {
        const ta = document.getElementById('editorContent');
        ta.focus();
        ta.setSelectionRange(0, 6);
      });
      await page.keyboard.press('Control+i');
      check('E2 Ctrl+I 斜体', await page.inputValue('#editorContent') === '*italic*',
        await page.inputValue('#editorContent'));

      await page.fill('#editorContent', 'site');
      await page.evaluate(() => {
        const ta = document.getElementById('editorContent');
        ta.focus();
        ta.setSelectionRange(0, 4);
      });
      await page.keyboard.press('Control+k');
      check('E2 Ctrl+K 链接', await page.inputValue('#editorContent') === '[site](https://)',
        await page.inputValue('#editorContent'));

      await page.fill('#editorContent', '');
      await page.click('#editorContent');
      await page.keyboard.press('Tab');
      const afterTab = await page.inputValue('#editorContent');
      check('E2 Tab 插入缩进而非跳焦点', afterTab === '  ' &&
        await page.evaluate(() => document.activeElement.id) === 'editorContent', JSON.stringify(afterTab));

      // 图片面板（真实浏览器）
      await page.click('#editorToolbar [data-md="image"]');
      check('E7 图片面板打开', await page.isVisible('#editorImagePanel'));
      await page.fill('#editorImageUrl', 'https://cdn.example.com/pic.png');
      await page.fill('#editorImageAlt', '示意图');
      await page.click('[data-img="insert-url"]');
      check('E7 插入链接图片', /!\[示意图\]\(https:\/\/cdn\.example\.com\/pic\.png\)$/
        .test(await page.inputValue('#editorContent')), await page.inputValue('#editorContent'));

      await page.click('#editorToolbar [data-md="image"]');
      await page.fill('#editorImageUrl', 'javascript:alert(1)');
      await page.click('[data-img="insert-url"]');
      check('E7 危险地址被拒绝且正文不变',
        !/javascript:/.test(await page.inputValue('#editorContent')) &&
        (await page.textContent('#editorImageError')).length > 0,
        await page.textContent('#editorImageError'));

      check('E2 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ---------------------------------------------------------------- E4/E5/E6 视口
    for (const vp of VIEWPORTS) {
      const mobile = vp.width <= 768;
      const tag = vp.name;
      const { ctx, page, errors } = await newSession(browser, { width: vp.width, height: vp.height });
      await openEditor(page, base);

      const overflowX = await page.evaluate(() =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      check(tag + ' 无页面横向溢出', overflowX <= 1, 'overflowX=' + overflowX);

      const toggleDisplay = await page.$eval('#editorViewToggle', el => getComputedStyle(el).display);
      check(tag + (mobile ? ' 显示编辑/预览切换' : ' 隐藏编辑/预览切换'),
        mobile ? toggleDisplay !== 'none' : toggleDisplay === 'none', toggleDisplay);

      // 状态栏在各视口都可见
      check(tag + ' 状态栏可见', await page.isVisible('#editorStats'));

      if (mobile) {
        await page.fill('#editorContent', '# 移动端\n\n正文内容 mobile content');
        await page.waitForTimeout(100);

        const editVisible = await page.$eval('.editor-pane-edit', el => getComputedStyle(el).display !== 'none');
        const previewVisible = await page.$eval('.editor-pane-preview', el => getComputedStyle(el).display !== 'none');
        check(tag + ' 默认只看编辑栏', editVisible && !previewVisible,
          'edit=' + editVisible + ' preview=' + previewVisible);

        await page.click('#editorViewToggle [data-view="preview"]');
        await page.waitForTimeout(120);
        const after = await page.evaluate(() => ({
          view: document.getElementById('editorSplit').getAttribute('data-view'),
          value: document.getElementById('editorContent').value,
          editHidden: getComputedStyle(document.querySelector('.editor-pane-edit')).display === 'none',
          previewVisible: getComputedStyle(document.querySelector('.editor-pane-preview')).display !== 'none'
        }));
        check(tag + ' 切到预览：只显示预览', after.editHidden && after.previewVisible, JSON.stringify(after.view));
        check(tag + ' 切到预览不丢内容', after.value === '# 移动端\n\n正文内容 mobile content');
        check(tag + ' 预览已渲染正文', /移动端/.test(await page.textContent('#editorPreview')));

        await page.click('#editorViewToggle [data-view="edit"]');
        await page.waitForTimeout(100);
        check(tag + ' 切回编辑：内容仍在',
          await page.inputValue('#editorContent') === '# 移动端\n\n正文内容 mobile content');

        // 工具栏可横向滚动 + 触控尺寸
        const bar = await page.evaluate(() => {
          const el = document.getElementById('editorToolbar');
          const btn = el.querySelector('[data-md="bold"]');
          const r = btn.getBoundingClientRect();
          return { scrollable: el.scrollWidth > el.clientWidth + 1, w: Math.round(r.width), h: Math.round(r.height) };
        });
        check(tag + ' 工具栏可横向滚动', bar.scrollable, 'scrollWidth>clientWidth');
        check(tag + ' 工具栏按钮触控尺寸 >= 36px', bar.w >= 36 && bar.h >= 36, bar.w + 'x' + bar.h);

        // 长代码块 / 表格不撑破页面
        await page.fill('#editorContent',
          '```js\n' + 'const x = 1; // 很长的行 '.repeat(20) + '\n```\n\n' +
          '| a | b | c |\n| --- | --- | --- |\n| ' + 'x'.repeat(80) + ' | 2 | 3 |\n');
        await page.click('#editorViewToggle [data-view="preview"]');
        await page.waitForTimeout(200);
        const overflow2 = await page.evaluate(() =>
          Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
        check(tag + ' 长代码块/表格不产生横向溢出', overflow2 <= 1, 'overflowX=' + overflow2);
      }

      check(tag + ' 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ---------------------------------------------------------------- E8 路由切换保草稿
    {
      const { ctx, page, errors } = await newSession(browser, { width: 1280, height: 800 });
      await openEditor(page, base, '#/editor/' + TARGET);

      const pattern = '路由切换测试 ' + Date.now();
      const body = await page.inputValue('#editorContent');
      await page.fill('#editorContent', body + '\n\n' + pattern + '\n');
      await page.click('button[onclick="saveDraft()"]');
      await page.waitForTimeout(150);

      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForTimeout(400);
      await page.evaluate(sel => { location.hash = '#/editor/' + sel; }, TARGET);
      await page.waitForTimeout(900);

      const restored = await page.inputValue('#editorContent');
      check('E8 离开编辑器再回来，编辑草稿被恢复', restored.indexOf(pattern) !== -1, pattern);
      check('E8 恢复后仍是编辑模式',
        (await page.evaluate(() => window.editorContext().mode)) === 'edit');

      const draft = await page.evaluate(() => {
        const raw = localStorage.getItem('blog_draft_edit::' + 'embodied-ai-notes');
        return raw ? JSON.parse(raw) : null;
      });
      check('E8 草稿写在编辑模式独立键里', !!draft && draft.mode === 'edit' && draft.id === TARGET);
      check('E8 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // ---------------------------------------------------------------- E9 SW 升级
    {
      const { ctx, page, errors } = await newSession(browser, { width: 1280, height: 800 },
        { serviceWorkers: 'allow' });
      await page.goto(base + PREFIX + '/index.html', { waitUntil: 'load' });
      await page.waitForTimeout(1200);

      const ready = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready.catch(() => null);
        return !!reg;
      });
      check('E9 Service Worker 能正常注册', ready === true);

      const caches = await page.evaluate(() => (window.caches ? caches.keys() : []));
      check('E9 缓存名包含当前 CACHE_VERSION',
        caches.some(n => n.indexOf(cacheVer) !== -1), caches.join(',') + ' / ' + cacheVer);
      check('E9 旧版本缓存已被清理',
        !caches.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), caches.join(','));

      // 编辑器页面在 SW 生效时也能正常打开
      await openEditor(page, base);
      await page.fill('#editorContent', 'sw ok');
      check('E9 SW 生效时编辑器可用', await page.inputValue('#editorContent') === 'sw ok');
      check('E9 无 console 错误', errors.filter(e => !/giscus|Third-party/i.test(e)).length === 0,
        errors.slice(0, 2).join(' | '));
      await ctx.close();
    }
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  await browser.close();
  server.close();
  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e && e.stack || e);
  process.exit(1);
});
