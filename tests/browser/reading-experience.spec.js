#!/usr/bin/env node
'use strict';
/**
 * Batch 8D-1：真实 Chromium 下的文章阅读体验回归
 *
 * 覆盖：目录生成/定位/滚动高亮/移动端折叠、正文阅读进度、代码复制成功与失败降级、
 * 长代码与表格局部滚动、动态高度重算、键盘与 reduced-motion、XSS、
 * 375/390/768/1280/1440 布局、搜索/编辑器/深链不回归、SW 缓存升级。
 *
 * 全部使用合成 Markdown Fixture，不修改正式文章数据。
 * 用法：node tests/browser/reading-experience.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const OLD_CACHE_VERSION = '2026-11-16-1';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function longMd() {
  const parts = ['# 合成长文', '', '开篇正文。', ''];
  for (let i = 1; i <= 7; i++) {
    parts.push('## 第 ' + i + ' 节', '', '这是第 ' + i + ' 节正文。' + '内容'.repeat(40), '');
    if (i === 2) {
      parts.push('```js', "const veryLongLine = '" + 'x'.repeat(320) + "';", 'console.log(veryLongLine);', '```', '');
    }
    if (i === 3) {
      const header = [];
      const row = [];
      for (let c = 0; c < 8; c++) {
        header.push('长表头列' + c + '说明');
        row.push('很长的单元格内容列' + c + '测试');
      }
      parts.push('| ' + header.join(' | ') + ' |',
        '| ' + header.map(() => '---').join(' | ') + ' |');
      for (let r = 0; r < 4; r++) parts.push('| ' + row.join(' | ') + ' |');
      parts.push('');
    }
    if (i === 4) parts.push('### 4.1 子节', '', '子节内容。', '');
  }
  return parts.join('\n');
}
const SHORT_MD = '# 合成短文\n\n## 唯一小节\n\n短文内容。\n';
const SECOND_MD = '# 第二篇合成文\n\n## 甲\n\n内容。\n\n## 乙\n\n内容。\n\n## 丙\n\n内容。\n';
const XSS_MD = '# 安全测试\n\n## 标题 &lt;script&gt;window.__xss=1&lt;/script&gt;\n\n内容。\n\n' +
  '## 第二个标题\n\n内容。\n\n## 第三个标题\n\n内容。\n';

function mkPost(id, content) {
  return { id: id, title: '阅读合成 ' + id, date: '2026-11-16', tags: ['测试'], excerpt: '合成测试', content: content };
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
  if (o.brokenClipboard) {
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      } catch (e) { /* 忽略 */ }
      const patch = () => { try { document.execCommand = function () { return false; }; } catch (e) { /* 忽略 */ } };
      patch();
      document.addEventListener('DOMContentLoaded', patch);
    });
  }
  if (o.clipboardPermission) {
    try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }); }
    catch (e) { /* 旧版 Playwright 可能不支持 */ }
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

async function mount(page, post) {
  await page.evaluate((p) => {
    window.eval('USER_POSTS.push(' + JSON.stringify(p) + ');');
    window.eval("location.hash = '#/post/" + p.id + "'");
  }, post);
  await page.waitForSelector('.article-detail-body', { timeout: 15000 });
  await page.waitForTimeout(650);
}

function progressOf(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('#readingProgress i');
    return bar ? Math.round(parseFloat(bar.style.width || '0')) : -1;
  });
}

async function scrollToBodyEnd(page) {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    const b = document.querySelector('.article-detail-body');
    const r = b.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, r.bottom + window.scrollY - innerHeight));
  });
  await page.waitForTimeout(350);
}

(async () => {
  const { server, state } = createServer(ROOT, PREFIX);
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
    // ---------------------------------------------------------- S1 桌面长文
    {
      const s = await session(browser, base, { clipboardPermission: true });
      const p = s.page;
      await mount(p, mkPost('b8d1-long', longMd()));

      const toc = await p.evaluate(() => ({
        count: document.querySelectorAll('#tocPanel .toc-link').length,
        order: Array.prototype.map.call(document.querySelectorAll('#tocPanel .toc-link'),
          n => ({ t: n.textContent.trim(), h3: n.classList.contains('toc-h3') })),
        heads: Array.prototype.map.call(document.querySelectorAll('.article-detail-body h2, .article-detail-body h3'),
          n => ({ t: n.textContent.trim(), tag: n.tagName, id: n.id })),
        active: document.querySelectorAll('#tocPanel .toc-link.active').length,
        aria: (document.querySelector('#tocPanel .toc-link.active') || {}).getAttribute
          ? document.querySelector('#tocPanel .toc-link.active').getAttribute('aria-current') : ''
      }));
      check('R1 目录与正文 H2/H3 一一对应', toc.count === toc.heads.length && toc.count === 8,
        toc.count + '/' + toc.heads.length);
      check('R2 目录顺序/文本/层级一致', toc.order.every(function (x, i) {
        return x.t === toc.heads[i].t && x.h3 === (toc.heads[i].tag === 'H3');
      }), toc.order.map(x => x.t).join(' | '));
      check('R3 进入页面立即高亮一项', toc.active === 1 && toc.aria === 'true', toc.aria);

      const link = p.locator('#tocPanel .toc-link').nth(3);
      const targetId = await link.getAttribute('data-target');
      await link.click();
      await p.waitForFunction((id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 64;
        const top = el.getBoundingClientRect().top;
        return top >= header - 4 && top <= header + 80;
      }, targetId, { timeout: 6000 }).catch(() => {});
      const pos = await p.evaluate((id) => {
        const el = document.getElementById(id);
        const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 64;
        return { top: Math.round(el.getBoundingClientRect().top), header: header };
      }, targetId);
      check('R4 点击目录定位准确且不被固定导航遮挡',
        pos.top >= pos.header - 4 && pos.top <= pos.header + 90, JSON.stringify(pos));

      await p.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, 0);
      });
      await p.waitForTimeout(220);
      await p.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await p.waitForTimeout(450);
      const bottomDiag = await p.evaluate(() => {
        const s = window.eval('_readingState');
        const a = document.querySelector('#tocPanel .toc-link.active');
        return {
          active: a ? Number(a.getAttribute('data-toc-index')) : -1,
          scrollY: Math.round(window.scrollY),
          maxScroll: Math.round(document.documentElement.scrollHeight - innerHeight),
          probe: Math.round(window.scrollY + s.headerOffset),
          headTops: s.headTops.map(Math.round),
          bodyTop: Math.round(s.bodyTop),
          bodyH: Math.round(s.bodyHeight)
        };
      });
      // 阅读探针在视口顶部附近：文末时最后几节可能仍在视口下半部，高亮应与探针一致
      const expectedBottom = Math.max(0,
        bottomDiag.headTops.filter(t => t <= bottomDiag.probe).length - 1);
      check('R5 文末高亮与阅读探针位置一致',
        bottomDiag.active === expectedBottom, JSON.stringify(bottomDiag));

      // 中间位置：高亮必须与"探针位置"对应的章节一致
      await p.evaluate(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        window.scrollTo(0, Math.floor(max * 0.55));
      });
      await p.waitForTimeout(300);
      const midDiag = await p.evaluate(() => {
        const s = window.eval('_readingState');
        const hs = Array.prototype.slice.call(
          document.querySelectorAll('.article-detail-body h2, .article-detail-body h3'));
        const probe = window.scrollY + s.headerOffset;
        const expected = hs.filter(h => h.getBoundingClientRect().top + window.scrollY <= probe).length - 1;
        const a = document.querySelector('#tocPanel .toc-link.active');
        return {
          active: a ? Number(a.getAttribute('data-toc-index')) : -1,
          expected: Math.max(0, expected),
          scrollY: Math.round(window.scrollY)
        };
      });
      check('R5b 中间滚动位置的高亮与章节一致',
        midDiag.active === midDiag.expected, JSON.stringify(midDiag));

      await scrollToBodyEnd(p);
      const atBodyEnd = await progressOf(p);
      const bodyDiag = await p.evaluate(() => {
        const s = window.eval('_readingState');
        const body = document.querySelector('.article-detail-body');
        return {
          w: document.querySelector('#readingProgress i').style.width,
          scrollY: Math.round(window.scrollY),
          bodyTop: Math.round(s.bodyTop), bodyH: Math.round(s.bodyHeight),
          vh: window.innerHeight,
          end: Math.round(s.bodyTop + s.bodyHeight - window.innerHeight),
          realBottom: Math.round(body.getBoundingClientRect().bottom + window.scrollY)
        };
      });
      check('R6 正文底部进度为 100%', atBodyEnd === 100, JSON.stringify(bodyDiag));
      await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await p.waitForTimeout(250);
      const atPageEnd = await progressOf(p);
      check('R7 评论区 / 页脚不延长正文进度（仍 100%）', atPageEnd === 100, atPageEnd + '%');
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(200);
      const atTop = await progressOf(p);
      check('R8 回到顶部进度回到 0%', atTop === 0, atTop + '%');

      // 动态高度：图片 / 代码块高度变化后重算
      await scrollToBodyEnd(p);
      check('R9 插入内容前正文底部为 100%', (await progressOf(p)) === 100);
      await p.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'b8d1-dynamic-block';
        d.style.height = '1200px';
        document.querySelector('.article-detail-body').appendChild(d);
      });
      await p.waitForTimeout(350);
      const afterGrow = await progressOf(p);
      check('R10 正文变长后进度及时重算（< 100%）', afterGrow < 100 && afterGrow >= 0, afterGrow + '%');
      await p.evaluate(() => {
        const d = document.getElementById('b8d1-dynamic-block');
        if (d) d.remove();
      });
      await p.waitForTimeout(350);
      check('R11 内容移除后进度恢复 100%', (await progressOf(p)) === 100);

      // 复制成功
      const copyBtn = p.locator('.copy-btn').first();
      await copyBtn.click();
      await p.waitForTimeout(180);
      const copyText = await copyBtn.textContent();
      let clipboard = '';
      try { clipboard = await p.evaluate(() => navigator.clipboard.readText()); } catch (e) { clipboard = ''; }
      check('R12 复制成功才显示已复制', /已复制/.test(copyText) && clipboard.indexOf('veryLongLine') !== -1,
        copyText + ' / ' + clipboard.slice(0, 24));

      // 长代码 / 表格局部滚动
      const layout = await p.evaluate(() => {
        const code = document.querySelector('.article-detail-body pre code');
        const wrap = document.querySelector('.markdown-body .table-scroll');
        const table = document.querySelector('.markdown-body .table-scroll table');
        const td = table ? table.querySelector('td') : null;
        return {
          codeScroll: code ? code.scrollWidth - code.clientWidth : 0,
          tableWrap: !!wrap,
          tableScroll: wrap ? wrap.scrollWidth - wrap.clientWidth : 0,
          tableW: table ? Math.round(table.getBoundingClientRect().width) : 0,
          tableScrollW: table ? table.scrollWidth : 0,
          wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0,
          cols: table ? table.querySelectorAll('thead th').length : 0,
          whiteSpace: td ? getComputedStyle(td).whiteSpace : '',
          tableWidthCss: table ? getComputedStyle(table).width : '',
          overflow: document.documentElement.scrollWidth - innerWidth
        };
      });
      check('R13 长代码行可局部横向滚动', layout.codeScroll > 1, layout.codeScroll);
      check('R14 表格被局部滚动容器包裹且可滚动',
        layout.tableWrap && layout.tableScroll > 1, JSON.stringify(layout));
      check('R15 长代码与宽表格不造成全页横向溢出', layout.overflow <= 1, layout.overflow);

      check('R16 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- S2 复制失败降级
    {
      const s = await session(browser, base, { brokenClipboard: true });
      await mount(s.page, mkPost('b8d1-copyfail', longMd()));
      const btn = s.page.locator('.copy-btn').first();
      await btn.click();
      await s.page.waitForTimeout(220);
      const txt = await btn.textContent();
      check('R17 Clipboard 与备用命令均失败时明确报错，不假报成功',
        txt === '复制失败' && txt.indexOf('已复制') === -1, txt);
      check('R18 复制失败不影响代码原文', await s.page.evaluate(() =>
        document.querySelector('.article-detail-body pre code').textContent.indexOf('veryLongLine') !== -1));
      check('R19 无未捕获页面错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- S3 移动端 / 多视口 / 键盘 / reduced-motion
    {
      const s = await session(browser, base, { viewport: { width: 390, height: 844 } });
      const p = s.page;
      await mount(p, mkPost('b8d1-mobile', longMd()));

      for (const w of [375, 390, 768, 1280, 1440]) {
        await p.setViewportSize({ width: w, height: w <= 390 ? 812 : 900 });
        await p.waitForTimeout(220);
        const info = await p.evaluate(() => {
          const mob = document.getElementById('tocMobile');
          const panel = document.getElementById('tocPanel');
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            mobileVisible: !!mob && getComputedStyle(mob).display !== 'none',
            panelVisible: !!panel && getComputedStyle(panel).display !== 'none'
          };
        });
        check('V' + w + ' 无全页横向溢出', info.overflow <= 1, info.overflow);
        check('V' + w + ' 目录入口正确', w < 1280
          ? (info.mobileVisible && !info.panelVisible)
          : info.panelVisible, JSON.stringify(info));
      }

      await p.setViewportSize({ width: 390, height: 844 });
      await p.waitForTimeout(200);
      await p.locator('#tocMobile > summary').click();
      await p.waitForTimeout(150);
      const open1 = await p.evaluate(() => ({
        open: document.getElementById('tocMobile').open,
        aria: document.querySelector('#tocMobile > summary').getAttribute('aria-expanded')
      }));
      check('M1 移动端目录可展开且 aria-expanded 同步', open1.open === true && open1.aria === 'true',
        JSON.stringify(open1));
      await p.locator('#tocMobile .toc-link').nth(2).click();
      await p.waitForTimeout(800);
      const open2 = await p.evaluate(() => document.getElementById('tocMobile').open);
      check('M2 点击目录项后自动收起', open2 === false);
      await p.locator('#tocMobile > summary').click();
      await p.waitForTimeout(120);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(180);
      check('M3 Esc 关闭移动端目录',
        (await p.evaluate(() => document.getElementById('tocMobile').open)) === false);

      // 键盘打开桌面目录项
      await p.setViewportSize({ width: 1280, height: 900 });
      await p.waitForTimeout(250);
      const keyLink = p.locator('#tocPanel .toc-link').nth(2);
      const keyTarget = await keyLink.getAttribute('data-target');
      await keyLink.focus();
      await p.keyboard.press('Enter');
      await p.waitForTimeout(900);
      const keyPos = await p.evaluate((id) => {
        const el = document.getElementById(id);
        const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 64;
        return { top: Math.round(el.getBoundingClientRect().top), header: header };
      }, keyTarget);
      check('M4 键盘 Enter 可触发目录跳转',
        keyPos.top >= keyPos.header - 4 && keyPos.top <= keyPos.header + 120, JSON.stringify(keyPos));

      // reduced-motion：即时滚动
      await p.emulateMedia({ reducedMotion: 'reduce' });
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(150);
      const rmLink = p.locator('#tocPanel .toc-link').nth(5);
      const rmTarget = await rmLink.getAttribute('data-target');
      await rmLink.click();
      await p.waitForTimeout(200);
      const rmPos = await p.evaluate((id) => {
        const el = document.getElementById(id);
        const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 64;
        return { top: Math.round(el.getBoundingClientRect().top), header: header };
      }, rmTarget);
      check('M5 prefers-reduced-motion 下即时滚动到位',
        rmPos.top >= rmPos.header - 4 && rmPos.top <= rmPos.header + 80, JSON.stringify(rmPos));

      check('M6 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- S4 切换 / 短文章 / XSS / 回归 / SW
    {
      const s = await session(browser, base);
      const p = s.page;

      await mount(p, mkPost('b8d1-first', longMd()));
      await mount(p, mkPost('b8d1-second', SECOND_MD));
      const switched = await p.evaluate(() => ({
        panels: document.querySelectorAll('#tocPanel').length,
        mobiles: document.querySelectorAll('#tocMobile').length,
        texts: Array.prototype.map.call(document.querySelectorAll('#tocPanel .toc-link'), n => n.textContent.trim()),
        bars: document.querySelectorAll('#readingProgress').length
      }));
      check('R20 切换文章后旧目录被清理且只保留新目录',
        switched.panels === 1 && switched.mobiles === 1 && switched.bars === 1 &&
        switched.texts.length === 3 && switched.texts[0] === '甲', JSON.stringify(switched));

      await mount(p, mkPost('b8d1-short', SHORT_MD));
      const shortInfo = await p.evaluate(() => ({
        toc: !!document.getElementById('tocPanel'),
        mobile: !!document.getElementById('tocMobile'),
        bar: !!document.getElementById('readingProgress'),
        width: (document.querySelector('#readingProgress i') || { style: {} }).style.width
      }));
      check('R21 少于三个标题不生成目录但保留进度条',
        !shortInfo.toc && !shortInfo.mobile && shortInfo.bar, JSON.stringify(shortInfo));

      await mount(p, mkPost('b8d1-xss', XSS_MD));
      const xss = await p.evaluate(() => ({
        scripts: document.querySelectorAll('#tocPanel script').length,
        flag: !!window.__xss,
        hasText: document.getElementById('tocPanel').textContent.indexOf('<script>') !== -1
      }));
      check('R22 恶意标题在目录中被转义且不执行',
        xss.scripts === 0 && !xss.flag && xss.hasText && s.dialogs.length === 0, JSON.stringify(xss));

      // 搜索 / 编辑器 / 深链回归
      await p.evaluate(() => { window.eval("location.hash = '#/'"); });
      await p.waitForTimeout(350);
      await p.fill('#searchInput', '机器人');
      await p.waitForTimeout(900);
      check('R23 搜索功能不回归', /找到\s*\d+\s*条/.test(await p.textContent('#app')));

      await p.evaluate(() => { window.eval("location.hash = '#/editor'"); });
      await p.waitForSelector('#editorTitle', { state: 'visible', timeout: 10000 });
      check('R24 编辑器不回归', await p.isVisible('#editorContent'));

      await p.evaluate(() => { window.eval("location.hash = '#/papers'"); });
      await p.waitForTimeout(1200);
      const paperId = await p.evaluate(() => window.eval('typeof PAPERS !== "undefined" && PAPERS[0] ? PAPERS[0].id : ""'));
      if (paperId) {
        await p.evaluate((id) => { window.eval("location.hash = '#/papers?kind=paper&target=" + encodeURIComponent(id) + "'"); }, paperId);
        await p.waitForTimeout(700);
        check('R25 Batch 7B 深链不回归',
          (await p.evaluate(() => location.hash)).indexOf('target=' + encodeURIComponent(paperId)) !== -1);
      } else {
        check('R25 Batch 7B 深链不回归', false, 'PAPERS 未加载');
      }
      check('R26 无页面脚本错误', s.errors.length === 0, s.errors.slice(0, 2).join(' | '));
      await s.ctx.close();
    }

    // ---------------------------------------------------------- S5 SW 缓存升级
    {
      const s = await session(browser, base, { sw: true, viewport: { width: 1280, height: 900 } });
      await sleep(1800);
      const caches = await s.page.evaluate(() => (window.caches ? caches.keys() : []));
      check('S1 CACHE_VERSION 已递增',
        !!cacheVer && cacheVer > OLD_CACHE_VERSION && cacheVer > '2026-11-16-2', cacheVer);
      check('S2 SW 使用当前缓存版本', caches.some(n => n.indexOf(cacheVer) !== -1), caches.join(','));
      check('S3 旧版本缓存已清理', !caches.some(n => n.indexOf(OLD_CACHE_VERSION) !== -1), caches.join(','));
      check('S4 SW 生效时页面仍可用', await s.page.isVisible('#searchInput') && s.errors.length === 0);
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
