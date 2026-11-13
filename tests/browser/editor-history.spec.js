#!/usr/bin/env node
'use strict';
/**
 * Batch 8B-3：草稿历史与安全恢复（真实 Chromium + 本地 HTTP Server + 真实 IndexedDB）
 *
 * 覆盖 jsdom 覆盖不到的部分：
 *   B1  真实 IndexedDB 写入与列表
 *   B2  相同内容去重（提示"未重复保存"）
 *   B3  自动快照节流（用显式时间戳走真实存储）
 *   B4  恢复：先备份 → 再覆盖；备份记录可在列表里看到
 *   B5  刷新后：历史仍在、草稿仍在
 *   B6  删除单条 / 清理当前文章
 *   B7  移动端 375：历史面板可操作、无横向溢出
 *   B8  多标签页：另一个标签页保存草稿时只提示，不覆盖
 *   B9  Service Worker：新 CACHE_VERSION 生效、旧缓存清理
 *   B10 工具栏 / 导出契约不回归
 *   B11 全程无 console error
 *
 * 用法：node tests/browser/editor-history.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const OLD_CACHE_VERSION = '2026-11-13-1';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + String(extra).slice(0, 120) + ')' : ''));
}

async function newContext(browser, viewport, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport, serviceWorkers: o.serviceWorkers || 'block' });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  return ctx;
}

async function openEditor(ctx, base, hash) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(base + PREFIX + '/index.html' + (hash || '#/editor'), { waitUntil: 'load' });
  await page.waitForSelector('#editorContent', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(300);
  return { page, errors };
}

const clickSel = (page, sel) => page.click(sel);

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
    // ---------------------------------------------------------------- B1/B2/B3 存储
    const ctx = await newContext(browser, { width: 1280, height: 800 });
    {
      const { page, errors } = await openEditor(ctx, base);
      check('B1 后端是真实 IndexedDB',
        (await page.evaluate(() => window.DraftHistory.stats().backend)) === 'idb',
        await page.evaluate(() => window.DraftHistory.stats().backend));
      check('B1 IndexedDB 可用', await page.evaluate(() => typeof indexedDB !== 'undefined'));

      await page.fill('#editorTitle', '历史真机测试');
      await page.fill('#editorContent', '# 第一版\n\n真实 IndexedDB。\n');
      await clickSel(page, 'button[onclick="saveHistoryVersion()"]');
      await page.waitForTimeout(400);

      check('B1 保存后计数徽标更新',
        (await page.textContent('#editorHistoryCount')).trim() === '1',
        await page.textContent('#editorHistoryCount'));

      await clickSel(page, 'button[onclick="toggleHistoryPanel()"]');
      await page.waitForTimeout(300);
      check('B1 面板列出 1 条', (await page.$$('#editorHistoryList .editor-history-item')).length === 1);
      check('B1 条目含时间/类型/标题',
        /手动/.test(await page.textContent('#editorHistoryList')) &&
        /历史真机测试/.test(await page.textContent('#editorHistoryList')));

      // 去重
      await clickSel(page, 'button[onclick="saveHistoryVersion()"]');
      await page.waitForTimeout(300);
      check('B2 相同内容不重复保存',
        /相同/.test(await page.textContent('#editorStatus')),
        await page.textContent('#editorStatus'));

      // B3 自动节流（显式时间戳，但走真实 IndexedDB）
      const auto = await page.evaluate(async () => {
        const DH = window.DraftHistory;
        const st = { title: 'auto', date: '2026-11-13', tags: ['t'], excerpt: '', content: '# auto 1\n' };
        const t0 = Date.now();
        const a = await DH.snapshot(DH.KINDS.AUTO, st, t0);
        const b = await DH.maybeAuto({ content: '# auto 2\n' }, t0 + 60 * 1000);
        const c = await DH.maybeAuto({ content: '# auto 3\n' }, t0 + 6 * 60 * 1000);
        return { a: a.saved, b: b.skipped, c: c.saved, count: (await DH.list()).length };
      });
      check('B3 自动快照写入成功', auto.a === true, JSON.stringify(auto));
      check('B3 5 分钟内被节流', auto.b === 'throttled', auto.b);
      check('B3 超过 5 分钟再次保存', auto.c === true, JSON.stringify(auto));

      check('B1 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    }

    // ---------------------------------------------------------------- B4 恢复
    {
      const { page, errors } = await openEditor(ctx, base);
      await page.waitForTimeout(300);
      await page.fill('#editorTitle', '要恢复的版本');
      await page.fill('#editorContent', '# 历史内容\n\n恢复我。\n');
      await clickSel(page, 'button[onclick="saveHistoryVersion()"]');
      await page.waitForTimeout(300);

      await page.fill('#editorTitle', '当前内容');
      await page.fill('#editorContent', '# 当前内容\n\n不要丢。\n');

      await clickSel(page, 'button[onclick="toggleHistoryPanel()"]');
      await page.waitForTimeout(300);
      // 选最新的"要恢复的版本"条目（标题匹配）
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#editorHistoryList .editor-history-item'));
        const hit = items.filter(li => /要恢复的版本/.test(li.textContent))[0] || items[0];
        hit.querySelector('[data-hist="preview"]').click();
      });
      await page.waitForTimeout(300);
      check('B4 预览面板打开', await page.isVisible('#editorHistoryPreview'));
      check('B4 diff 摘要显示字数变化',
        /字数/.test(await page.textContent('#editorHistoryDiff')),
        await page.textContent('#editorHistoryDiff'));

      await clickSel(page, '#editorHistoryPreview [data-hist="restore"]');
      await page.waitForTimeout(150);
      check('B4 恢复需要二次确认', await page.isVisible('#editorHistoryConfirm'));
      await clickSel(page, '#editorHistoryConfirm [data-hist="confirm-restore"]');
      await page.waitForTimeout(500);

      check('B4 恢复后标题被替换',
        (await page.inputValue('#editorTitle')) === '要恢复的版本',
        await page.inputValue('#editorTitle'));
      check('B4 恢复后正文被替换',
        (await page.inputValue('#editorContent')).indexOf('恢复我') !== -1,
        (await page.inputValue('#editorContent')).slice(0, 30));
      check('B4 状态栏说明尚未发布',
        /尚未导出|尚未发布/.test(await page.textContent('#editorStatus')) &&
        !/已上线/.test(await page.textContent('#editorStatus')),
        await page.textContent('#editorStatus'));

      const hasBackup = await page.evaluate(async () => {
        const rows = await window.DraftHistory.list();
        return rows.some(r => r.kind === 'restore-backup' && /不要丢/.test(r.content));
      });
      check('B4 恢复前保存了当前内容的安全快照', hasBackup === true);
      check('B4 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    }

    // ---------------------------------------------------------------- B5/B6 刷新 + 删除/清理
    {
      const { page, errors } = await openEditor(ctx, base);
      const before = await page.evaluate(async () => (await window.DraftHistory.list()).length);

      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#editorContent', { state: 'visible' });
      await page.waitForTimeout(500);

      const afterReload = await page.evaluate(async () => ({
        count: (await window.DraftHistory.list()).length,
        draft: window.localStorage.getItem('blog_draft')
      }));
      check('B5 刷新后历史仍在（IndexedDB 持久化）', afterReload.count >= before && afterReload.count > 0,
        before + '→' + afterReload.count);
      check('B5 刷新后草稿仍在', !!afterReload.draft && /恢复我|当前内容/.test(afterReload.draft));
      check('B5 刷新后计数器显示正确条数',
        (await page.textContent('#editorHistoryCount')).trim() === String(afterReload.count),
        await page.textContent('#editorHistoryCount'));

      // 删除单条
      await clickSel(page, 'button[onclick="toggleHistoryPanel()"]');
      await page.waitForTimeout(300);
      const beforeDel = (await page.$$('#editorHistoryList .editor-history-item')).length;
      await page.evaluate(() => {
        document.querySelector('#editorHistoryList [data-hist="delete"]').click();
      });
      await page.waitForTimeout(400);
      const afterDel = (await page.$$('#editorHistoryList .editor-history-item')).length;
      check('B6 删除单条生效', afterDel === beforeDel - 1, beforeDel + '→' + afterDel);

      await page.evaluate(() => {
        document.querySelector('#editorHistoryPanel [data-hist="clear"]').click();
      });
      await page.waitForTimeout(400);
      check('B6 清理当前文章历史', (await page.$$('#editorHistoryList .editor-history-item')).length === 0);
      check('B6 清理有明确提示', /已清理/.test(await page.textContent('#editorStatus')),
        await page.textContent('#editorStatus'));
      check('B6 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    }
    await ctx.close();

    // ---------------------------------------------------------------- B7 移动端
    {
      const mctx = await newContext(browser, { width: 375, height: 812 });
      const { page, errors } = await openEditor(mctx, base);
      await page.fill('#editorTitle', '移动端历史');
      await page.fill('#editorContent', '# 移动端\n\n历史面板。\n');
      await clickSel(page, 'button[onclick="saveHistoryVersion()"]');
      await page.waitForTimeout(300);
      await clickSel(page, 'button[onclick="toggleHistoryPanel()"]');
      await page.waitForTimeout(300);

      check('B7 375 宽下历史面板可见', await page.isVisible('#editorHistoryPanel'));
      const overflow = await page.evaluate(() =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      check('B7 375 宽无横向溢出', overflow <= 1, overflow);

      await page.evaluate(() => {
        document.querySelector('#editorHistoryList [data-hist="preview"]').click();
      });
      await page.waitForTimeout(250);
      check('B7 移动端可以预览历史版本', await page.isVisible('#editorHistoryBody'));
      const btnBox = await page.evaluate(() => {
        const b = document.querySelector('#editorHistoryPreview [data-hist="restore"]');
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      check('B7 恢复按钮触控尺寸足够', btnBox.h >= 32 && btnBox.w >= 60, btnBox.w + 'x' + btnBox.h);
      check('B7 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      await mctx.close();
    }

    // ---------------------------------------------------------------- B8 多标签页
    {
      const tctx = await newContext(browser, { width: 1280, height: 800 });
      const a = await openEditor(tctx, base);
      const b = await openEditor(tctx, base);

      await a.page.fill('#editorTitle', '标签页 A 的草稿');
      await a.page.fill('#editorContent', '# A\n');
      await a.page.click('button[onclick="saveDraft()"]');
      await a.page.waitForTimeout(500);

      const notice = await b.page.evaluate(() => {
        const el = document.getElementById('editorHistoryNotice');
        return el ? { hidden: el.hasAttribute('hidden'), text: el.textContent } : null;
      });
      check('B8 另一个标签页保存时给出提示', notice && !notice.hidden && /另一个标签页/.test(notice.text),
        notice && notice.text.slice(0, 40));
      check('B8 不自动覆盖本页内容', (await b.page.inputValue('#editorTitle')) === '',
        await b.page.inputValue('#editorTitle'));
      await tctx.close();
    }

    // ---------------------------------------------------------------- B9 SW
    {
      const sctx = await newContext(browser, { width: 1280, height: 800 }, { serviceWorkers: 'allow' });
      const page = await sctx.newPage();
      await page.goto(base + PREFIX + '/index.html', { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const caches = await page.evaluate(() => (window.caches ? caches.keys() : []));
      check('B9 使用当前 CACHE_VERSION', caches.some(n => n.indexOf(cacheVer) !== -1),
        caches.join(',') + ' / ' + cacheVer);
      check('B9 旧版本缓存已清理', !caches.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), caches.join(','));

      await page.goto(base + PREFIX + '/index.html#/editor', { waitUntil: 'load' });
      await page.waitForSelector('#editorContent', { state: 'visible' });
      await page.waitForTimeout(300);
      check('B9 SW 生效时编辑器可用', await page.isVisible('#editorToolbar'));
      await sctx.close();
    }

    // ---------------------------------------------------------------- B10 回归
    {
      const rctx = await newContext(browser, { width: 1280, height: 800 });
      const { page, errors } = await openEditor(rctx, base);
      await page.fill('#editorTitle', '回归检查');
      await page.fill('#editorTags', '测试');
      await page.fill('#editorContent', 'abc');
      await page.evaluate(() => {
        const ta = document.getElementById('editorContent');
        ta.focus();
        ta.setSelectionRange(0, 3);
      });
      await page.click('#editorToolbar [data-md="bold"]');
      check('B10 工具栏仍然可用', (await page.inputValue('#editorContent')) === '**abc**',
        await page.inputValue('#editorContent'));

      await page.keyboard.press('Control+z');
      await page.waitForTimeout(150);
      check('B10 原生撤销仍然可用', (await page.inputValue('#editorContent')) === 'abc',
        await page.inputValue('#editorContent'));

      const payload = await page.evaluate(() => {
        const p = window.buildExportPayload();
        return p.ok ? { keys: Object.keys(p.post).join(','), content: p.post.content } : { error: p.error };
      });
      check('B10 导出仍是六字段',
        payload.keys === 'id,title,date,tags,excerpt,content', payload.keys || payload.error);
      check('B10 无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      await rctx.close();
    }
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  await browser.close();
  server.close();
  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
