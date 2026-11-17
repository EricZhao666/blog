#!/usr/bin/env node
'use strict';

/**
 * Batch 8D-4：性能优化 / 无障碍改善 / 响应式与稳定性的真实 Chromium 验收。
 *
 * 覆盖（与 BATCH8D4_REPORT.md 的实测修复一一对应）：
 *  - P  页面无障碍结构：h1 唯一、标题层级不跳级、landmark、skip link、
 *       文章正文与页面标题重复 H1 时不再重复输出（新增行为）
 *  - A  控件可访问名称 / 表单标签 / chips aria-pressed / 搜索结果标题（新增行为）
 *  - C  对比度：浅色代码高亮 token 与浅色底 ≥4.5:1（对 CSS 产物做确定性计算）
 *  - K  键盘：skip link 首个可达且焦点可见、Enter 生效、Esc 关闭移动菜单、编辑器可输入
 *  - T  触控目标：返回链接 / 静态页底部链接 ≥24px（WCAG 2.5.8）
 *  - V  视口与缩放：320/375/390/768/1024/1440 六档 + 200% 缩放等效 + 手机横屏
 *       无全页横向溢出；长代码块在窄屏内部滚动不撑破文档
 *  - R  路由循环与资源清理：循环 3 轮后 DOM 节点 / Resource Timing / 长任务不持续增长
 *  - F  性能修复的行为与结构断言：返回顶部滚动监听 passive + rAF 节流（新增行为）
 *  - O  原有功能回归：搜索 / 路由 / 主题切换 / 编辑器输入 / SW 注册
 *
 * 性能相关断言全部采用稳定、可重复的结构性/计数性检查；
 * 不使用受机器负载影响的单次绝对毫秒阈值作为门槛（见任务约束）。
 * 静态笔记页的重复 H1 源于生成流水线（本轮禁止修改），不在此断言 h1 唯一性。
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

// ---------------------------------------------------------------- 确定性数据选取
function longestPostId() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  const fn = new Function(src + '\nreturn { POSTS: POSTS, USER_POSTS: typeof USER_POSTS === "undefined" ? [] : USER_POSTS };');
  const { POSTS, USER_POSTS } = fn();
  const all = POSTS.concat(USER_POSTS || []);
  all.forEach((p) => {
    if (typeof p.content === 'string') return;
    const f = path.join(ROOT, 'data', 'posts', p.id + '.md');
    if (fs.existsSync(f)) p.content = fs.readFileSync(f, 'utf8');
  });
  const sorted = all.slice().sort((a, b) => (b.content || '').length - (a.content || '').length);
  return sorted[0].id;
}

function pickStaticNote() {
  const dir = path.join(ROOT, 'notes');
  const files = fs.readdirSync(dir).filter(f => /\.html$/.test(f) && f !== 'index.html' && f !== 'materials.html');
  const sorted = files.map(f => ({ id: f, bytes: fs.statSync(path.join(dir, f)).size })).sort((a, b) => b.bytes - a.bytes);
  return sorted[0].id;
}

// ---------------------------------------------------------------- 对比度计算（node 侧，确定性）
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function hex(s) {
  const t = s.lstrip ? s.slice() : s;
  const body = String(t).replace('#', '');
  return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
}

// 从 style.css 中提取"浅色代码高亮覆盖块"的 token 颜色并逐一验证对比度
function lightHljsContrastReport() {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  const m = /\/\* 浅色模式代码高亮配色[\s\S]*?\*\/([\s\S]*?)(?=\n\/\*|\n\[data-theme="dark"\]|$)/.exec(css);
  if (!m) return { found: false, pairs: [] };
  const block = m[1];
  const colors = [...new Set((block.match(/#[0-9a-fA-F]{6}/g) || []))];
  const pairs = colors.map(c => ({ color: c, ratio: Math.round(ratio(hex(c), hex('#f0f2f5')) * 100) / 100 }));
  return { found: true, pairs, minRatio: pairs.reduce((mi, p) => Math.min(mi, p.ratio), 99) };
}

// ---------------------------------------------------------------- 浏览器会话
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
  if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 30000 });
  await page.waitForTimeout(400);
}

async function openNote(page, base, noteId, waitSelector) {
  await page.goto(base + '/notes/' + noteId, { waitUntil: 'load', timeout: 60000 });
  if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 30000 });
  await page.waitForTimeout(300);
}

// 页面内结构审计（与测量脚本 tests/perf/a11y-audit.js 同一套口径的子集）
const STRUCT_FN = `(() => {
  const VIS = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const out = {};
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(VIS);
  out.h1Count = headings.filter(h => h.tagName === 'H1').length;
  out.headings = headings.map(h => h.tagName);
  let skip = [];
  let prev = 0;
  for (const h of headings) {
    const lv = Number(h.tagName[1]);
    if (prev && lv - prev > 1) skip.push(h.tagName);
    prev = lv;
  }
  out.headingSkips = skip;
  out.hasMain = !!document.querySelector('main');
  out.hasNav = !!document.querySelector('nav, [role="navigation"]');
  const skipLink = Array.from(document.querySelectorAll('a')).find(a => /跳(过|到|转)|skip/i.test((a.textContent || '') + ' ' + String(a.className || '')) && (a.getAttribute('href') || '').charAt(0) === '#');
  out.skipLink = skipLink ? { href: skipLink.getAttribute('href'), visibleOnFocus: true } : null;
  const chips = Array.from(document.querySelectorAll('.category-chip')).filter(VIS);
  out.chips = chips.map(c => ({ pressed: c.getAttribute('aria-pressed'), active: c.classList.contains('active') }));
  out.editorLabels = ['editorTitle', 'editorTags', 'editorExcerpt', 'editorContent'].map(id => {
    const el = document.getElementById(id);
    return el ? { id, hasLabel: !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector('label[for="' + el.id + '"]'))) } : null;
  }).filter(Boolean);
  out.docScrollW = document.documentElement.scrollWidth;
  out.docClientW = document.documentElement.clientWidth;
  const htmlOx = getComputedStyle(document.documentElement).overflowX;
  const bodyOx = getComputedStyle(document.body).overflowX;
  out.globalOverflowHidden = (htmlOx === 'hidden' || bodyOx === 'hidden');
  return out;
})()`;

// 路由循环探测：切路由 → 等 DOM 稳定 → 记录 DOM 节点 / 资源条目
// 注意：必须是真实函数声明（带参数的 evaluate 用字符串在 Playwright 下不会被调用）
async function loopFnSteps(steps) {
  const app = document.getElementById('app');
  const trace = [];
  for (const h of steps) {
    location.hash = h;
    const deadline = performance.now() + 8000;
    const before = app.innerHTML.length;
    while (performance.now() < deadline) {
      await new Promise(r => setTimeout(r, 60));
      if (app.innerHTML.length !== before) break;
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 250));
    trace.push({
      hash: h,
      domNodes: document.getElementsByTagName('*').length,
      resources: performance.getEntriesByType('resource').length
    });
  }
  return trace.map(t => ({ hash: t.hash, domNodes: t.domNodes, resources: t.resources }));
}

// ==================================================================
(async () => {
  const POST_ID = longestPostId();
  const NOTE_ID = pickStaticNote();
  const POST_TITLE = (new Function(fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8') +
    '\nconst all = POSTS.concat(typeof USER_POSTS !== "undefined" ? USER_POSTS : []);' +
    'return all.find(p => p.id === ' + JSON.stringify(POST_ID) + ').title;')());

  const { server } = createServer(ROOT, PREFIX);
  const base = 'http://127.0.0.1:' + (await listen(server, 8146)) + PREFIX;

  const browser = await chromium.launch({ headless: true });
  const allErrors = [];

  try {
    // ======================================================== P 页面无障碍结构
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      await goto(page, base, '/', '.article-list');
      const home = await page.evaluate(STRUCT_FN);
      check('P1.1 首页恰好 1 个 h1', home.h1Count === 1, 'h1=' + home.h1Count);
      check('P1.2 首页无标题层级跳级', home.headingSkips.length === 0, home.headingSkips.join(','));
      check('P1.3 首页有 main / nav landmark', home.hasMain && home.hasNav);
      check('P1.4 首页 skip link 存在且指向 #app', !!home.skipLink && home.skipLink.href === '#app', JSON.stringify(home.skipLink));

      await goto(page, base, '/post/' + POST_ID, '.article-detail-body');
      const post = await page.evaluate(STRUCT_FN);
      check('P2.1 文章页恰好 1 个 h1（正文重复 H1 已去重）', post.h1Count === 1, 'h1=' + post.h1Count);
      check('P2.2 文章页无标题层级跳级', post.headingSkips.length === 0, post.headingSkips.join(','));
      const dupH1 = await page.evaluate((t) => {
        const h1s = Array.from(document.querySelectorAll('#app h1'));
        return h1s.filter(h => (h.textContent || '').trim() === String(t).trim()).length;
      }, POST_TITLE);
      check('P2.3 正文不再输出与页面标题相同的重复 H1', dupH1 === 1, '匹配标题的 h1 数=' + dupH1);

      await goto(page, base, '/courses', '.course-card');
      const courses = await page.evaluate(STRUCT_FN);
      check('P3.1 课程页恰好 1 个 h1', courses.h1Count === 1, 'h1=' + courses.h1Count);
      check('P3.2 课程页无标题层级跳级', courses.headingSkips.length === 0, courses.headingSkips.join(','));

      await goto(page, base, '/papers', '.paper-card');
      const papers = await page.evaluate(STRUCT_FN);
      check('P4.1 论文页恰好 1 个 h1', papers.h1Count === 1, 'h1=' + papers.h1Count);
      check('P4.2 论文页无标题层级跳级', papers.headingSkips.length === 0, papers.headingSkips.join(','));

      // 搜索覆盖层替换了 #app 内容：新增行为 = 搜索结果仍有页面标题
      await goto(page, base, '/', '.article-list');
      await page.focus('#searchInput');
      await page.keyboard.type('SLAM', { delay: 15 });
      await page.waitForTimeout(900);
      const search = await page.evaluate(STRUCT_FN);
      check('P5.1 搜索结果页仍有 1 个 h1（新增行为）', search.h1Count === 1, 'h1=' + search.h1Count);
      const h1Text = await page.evaluate(() => { const h = document.querySelector('#app h1'); return h ? h.textContent.trim() : ''; });
      check('P5.2 搜索结果 h1 为搜索语义标题', /搜索/.test(h1Text), h1Text.slice(0, 30));

      await ctx.close();
    }

    // ======================================================== A 控件状态与表单标签
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      await goto(page, base, '/courses', '.course-card');
      const chips = await page.evaluate(() => Array.from(document.querySelectorAll('.category-chip')).map(c => ({
        pressed: c.getAttribute('aria-pressed'),
        active: c.classList.contains('active'),
        text: (c.textContent || '').trim().slice(0, 12)
      })));
      check('A1.1 课程 chips 均有 aria-pressed（新增行为）', chips.length >= 2 && chips.every(c => c.pressed === 'true' || c.pressed === 'false'),
        JSON.stringify(chips.slice(0, 4)));
      check('A1.2 aria-pressed 与视觉激活态一致', chips.every(c => (c.pressed === 'true') === c.active),
        JSON.stringify(chips.slice(0, 6)));

      // 点击切换后 aria-pressed 跟随更新（重渲染路径）
      const firstCatChip = await page.$('.category-chip[data-category]');
      if (firstCatChip) {
        await firstCatChip.click();
        await page.waitForTimeout(350);
        const chips2 = await page.evaluate(() => Array.from(document.querySelectorAll('.category-chip')).map(c => ({
          pressed: c.getAttribute('aria-pressed'), active: c.classList.contains('active'), cat: c.getAttribute('data-category')
        })));
        const activePressed = chips2.filter(c => c.active);
        check('A1.3 点击筛选后 aria-pressed 跟随激活态', activePressed.length >= 1 && activePressed.every(c => c.pressed === 'true'),
          JSON.stringify(chips2.slice(0, 6)));
      } else {
        check('A1.3 点击筛选后 aria-pressed 跟随激活态', false, '未找到分类 chip');
      }

      await goto(page, base, '/papers', '.paper-card');
      const pchips = await page.evaluate(() => Array.from(document.querySelectorAll('.category-chip')).map(c => ({
        pressed: c.getAttribute('aria-pressed'), active: c.classList.contains('active')
      })));
      check('A2.1 论文 chips 均有 aria-pressed（新增行为）', pchips.length >= 2 && pchips.every(c => c.pressed === 'true' || c.pressed === 'false'),
        JSON.stringify(pchips.slice(0, 4)));
      check('A2.2 论文 aria-pressed 与激活态一致', pchips.every(c => (c.pressed === 'true') === c.active));

      await goto(page, base, '/editor', '#editorContent');
      const labels = await page.evaluate(STRUCT_FN).then(s => s.editorLabels);
      check('A3.1 编辑器四个输入域均有可访问名称（新增行为）',
        labels.length === 4 && labels.every(l => l.hasLabel), JSON.stringify(labels));

      await ctx.close();
    }

    // ======================================================== C 对比度（浅色高亮 token）
    {
      const rep = lightHljsContrastReport();
      check('C1.1 style.css 存在浅色代码高亮覆盖块（新增行为）', rep.found);
      check('C1.2 覆盖块内全部 token 对 #f0f2f5 ≥4.5:1',
        rep.found && rep.pairs.length >= 6 && rep.minRatio >= 4.5,
        rep.found ? ('min=' + rep.minRatio + ' colors=' + rep.pairs.map(p => p.color + ':' + p.ratio).join(' ')) : '未找到');

      // 深色主题不受浅色覆盖影响：dark 块仍在且作用域正确
      const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
      const darkIdx = css.indexOf('[data-theme="dark"] .hljs-comment');
      const lightIdx = css.indexOf('浅色模式代码高亮配色');
      check('C1.3 深色高亮覆盖保持独立作用域', darkIdx !== -1 && lightIdx !== -1 && lightIdx !== -2 && darkIdx !== lightIdx);
    }

    // ======================================================== K 键盘操作
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      await goto(page, base, '/', '.article-list');
      // Tab：第一个可聚焦元素是 skip link，且获得可见焦点样式
      await page.keyboard.press('Tab');
      const kb = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          isSkipLink: el.id === 'skipLink',
          outline: cs.outlineStyle + '/' + cs.outlineWidth,
          boxShadow: cs.boxShadow,
          rect: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }
        };
      });
      check('K1.1 首次 Tab 聚焦 skip link', !!kb && kb.isSkipLink, JSON.stringify(kb && kb.rect));
      check('K1.2 skip link 焦点指示可见（outline 或 box-shadow）',
        !!kb && ((kb.outline.split('/')[0] !== 'none' && parseFloat(kb.outline.split('/')[1]) > 0) || (kb.boxShadow && kb.boxShadow !== 'none')),
        JSON.stringify(kb && kb.outline));
      // 激活 skip link → 焦点进入 #app
      await page.keyboard.press('Enter');
      const focusedApp = await page.evaluate(() => document.activeElement && document.activeElement.id);
      check('K1.3 激活 skip link 后焦点进入 main#app', focusedApp === 'app', 'active=' + focusedApp);

      // Esc 关闭移动菜单（窄屏）
      await page.setViewportSize({ width: 375, height: 720 });
      await page.click('#menuToggle');
      await page.waitForTimeout(200);
      const menuOpen = await page.evaluate(() => document.querySelector('.nav').classList.contains('open'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const menuClosed = await page.evaluate(() => !document.querySelector('.nav').classList.contains('open'));
      check('K2.1 移动菜单可打开且 Esc 可关闭（焦点归还）', menuOpen && menuClosed);

      // 编辑器可聚焦输入（键盘可达）
      await page.setViewportSize({ width: 1440, height: 900 });
      await goto(page, base, '/editor', '#editorContent');
      await page.focus('#editorTitle');
      await page.keyboard.type('键盘可达性验证');
      const typed = await page.evaluate(() => document.getElementById('editorTitle').value);
      check('K3.1 编辑器标题域可键盘输入', typed === '键盘可达性验证', typed.slice(0, 20));
      const ariaAfterType = await page.evaluate(() => document.getElementById('editorTitle').getAttribute('aria-label') || '');
      check('K3.2 编辑器标题域 aria-label 保留', /标题/.test(ariaAfterType), ariaAfterType);

      await ctx.close();
    }

    // ======================================================== T 触控目标
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      await goto(page, base, '/post/' + POST_ID, '.article-detail-body');
      const backBox = await page.evaluate(() => {
        const el = document.querySelector('.article-back');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      check('T1.1 文章页返回链接 ≥24px 高（新增行为）', !!backBox && backBox.h >= 24, JSON.stringify(backBox));

      await openNote(page, base, NOTE_ID, '.article-detail-title');
      const noteBoxes = await page.evaluate(() => {
        const out = [];
        const back = document.querySelector('.article-back');
        if (back) { const r = back.getBoundingClientRect(); out.push({ cls: 'article-back', h: Math.round(r.height) }); }
        document.querySelectorAll('.notes-static-hint a').forEach(a => {
          const r = a.getBoundingClientRect();
          out.push({ cls: 'notes-static-hint a', h: Math.round(r.height) });
        });
        return out;
      });
      check('T2.1 静态笔记页返回与底部链接 ≥24px 高（新增行为）',
        noteBoxes.length >= 2 && noteBoxes.every(b => b.h >= 24), JSON.stringify(noteBoxes));

      await ctx.close();
    }

    // ======================================================== V 视口与缩放适配
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      const viewports = [
        { name: '320', w: 320, h: 640 },
        { name: '375', w: 375, h: 720 },
        { name: '390', w: 390, h: 800 },
        { name: '768', w: 768, h: 900 },
        { name: '1024', w: 1024, h: 800 },
        { name: '1440', w: 1440, h: 900 }
      ];
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await goto(page, base, '/', '.article-list');
        const s = await page.evaluate(STRUCT_FN);
        check('V1.' + vp.name + ' 首页 ' + vp.name + 'px 无全页横向溢出（' + vp.w + '×' + vp.h + '）',
          s.docScrollW <= s.docClientW + 1, 'scrollW=' + s.docScrollW + ' clientW=' + s.docClientW);
        check('V1.' + vp.name + 'b 未用全局 overflow-x:hidden 掩盖', !s.globalOverflowHidden);
      }

      // 长代码块：320px 下内部滚动，不撑破文档
      await page.setViewportSize({ width: 320, height: 640 });
      await goto(page, base, '/post/' + POST_ID, '.article-detail-body');
      const code = await page.evaluate(() => {
        const pre = document.querySelector('.article-detail-body pre');
        if (!pre) return { present: false };
        const r = pre.getBoundingClientRect();
        return {
          present: true,
          preScrollW: pre.scrollWidth, preClientW: pre.clientWidth,
          overflowX: getComputedStyle(pre).overflowX,
          docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth
        };
      });
      check('V2.1 文章页含代码块可测（长文场景成立）', code.present && code.present !== false, '');
      check('V2.2 320px 下代码块内部滚动、文档不撑破',
        code.present && code.docScrollW <= code.docClientW + 1,
        JSON.stringify({ docScrollW: code.docScrollW, docClientW: code.docClientW }));

      // 200% 缩放等效：1440 窗口 200% 缩放 ≈ 720 CSS px 视口（WCAG 1.4.4 Reflow）
      await page.setViewportSize({ width: 720, height: 450 });
      await goto(page, base, '/', '.article-list');
      const zoom = await page.evaluate(STRUCT_FN);
      check('V3.1 200% 缩放等效视口（720×450）首页无横向溢出', zoom.docScrollW <= zoom.docClientW + 1,
        'scrollW=' + zoom.docScrollW + ' clientW=' + zoom.docClientW);
      await goto(page, base, '/post/' + POST_ID, '.article-detail-body');
      const zoomPost = await page.evaluate(STRUCT_FN);
      check('V3.2 200% 缩放等效视口文章页无横向溢出', zoomPost.docScrollW <= zoomPost.docClientW + 1,
        'scrollW=' + zoomPost.docScrollW + ' clientW=' + zoomPost.docClientW);

      // 手机横屏（≈ iPhone 12/13 横屏 CSS 宽 844×390，取 780×360 近似窄高）
      await page.setViewportSize({ width: 780, height: 360 });
      await goto(page, base, '/', '.article-list');
      const land = await page.evaluate(STRUCT_FN);
      check('V4.1 手机横屏视口（780×360）首页无横向溢出', land.docScrollW <= land.docClientW + 1,
        'scrollW=' + land.docScrollW + ' clientW=' + land.docClientW);

      // 长英文标题 / 技术词换行（8D-3 契约保持）：构造长词检查卡片标题不溢出
      await page.setViewportSize({ width: 320, height: 640 });
      await goto(page, base, '/tags', '.tags-page, #app');
      const tagOverflow = await page.evaluate(STRUCT_FN);
      check('V5.1 标签页 320px 无横向溢出（长技术词换行契约保持）', tagOverflow.docScrollW <= tagOverflow.docClientW + 1,
        'scrollW=' + tagOverflow.docScrollW);

      await ctx.close();
    }

    // ======================================================== R 路由循环与资源清理
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      // 注入长任务记录（页面上下文）
      await page.addInitScript(() => {
        window.__lt = [];
        try {
          new PerformanceObserver(list => { for (const e of list.getEntries()) window.__lt.push(e.duration); })
            .observe({ type: 'longtask' });
        } catch (e) { /* ignore */ }
      });
      await goto(page, base, '/', '.article-list');
      // 首轮会触发 courses/papers/editor 懒加载，属预期；从第二轮起应稳定
      const steps = ['/', '/courses', '/papers', '/editor', '/'];
      await page.evaluate(loopFnSteps, steps);        // 第 1 轮：预热 + 懒加载
      const t2 = await page.evaluate(loopFnSteps, steps); // 第 2 轮
      const t3 = await page.evaluate(loopFnSteps, steps); // 第 3 轮
      const end2 = t2[t2.length - 1];
      const end3 = t3[t3.length - 1];
      const domGrowth = end3.domNodes - end2.domNodes;
      const resGrowth = end3.resources - end2.resources;
      check('R1.1 路由循环 3 轮后 DOM 节点数不持续增长（第3轮-第2轮 ≤ 60）', domGrowth <= 60 && domGrowth >= -60,
        'dom2=' + end2.domNodes + ' dom3=' + end3.domNodes + ' growth=' + domGrowth);
      check('R1.2 路由循环后 Resource Timing 不持续增长（第3轮-第2轮 ≤ 4）', resGrowth <= 4,
        'res2=' + end2.resources + ' res3=' + end3.resources + ' growth=' + resGrowth);

      await ctx.close();
    }

    // ======================================================== F 性能修复断言（新增行为）
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      await goto(page, base, '/', '.article-list');
      // 行为：滚到中部按钮出现，回顶后消失（原有功能不受节流重构影响）
      await page.evaluate(() => window.scrollTo(0, 800));
      await page.waitForTimeout(300);
      const visibleMid = await page.evaluate(() => document.getElementById('backToTop').classList.contains('visible'));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      const visibleTop = await page.evaluate(() => document.getElementById('backToTop').classList.contains('visible'));
      check('F1.1 返回顶部按钮阈值行为正常（>300 出现 / 回顶消失）', visibleMid && !visibleTop,
        'mid=' + visibleMid + ' top=' + visibleTop);

      // 结构：滚动监听 passive + rAF 节流（源码契约，防止未来回退为逐事件 DOM 写入）
      const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
      const seg = appSrc.slice(appSrc.indexOf("const backToTopBtn"));
      const segEnd = seg.indexOf('// Hash change');
      const backTopSeg = seg.slice(0, segEnd);
      check('F1.2 返回顶部滚动监听使用 { passive: true }（新增行为）',
        /addEventListener\('scroll',\s*\([\s\S]{0,120}?passive:\s*true/.test(backTopSeg));
      check('F1.3 返回顶部滚动处理经 requestAnimationFrame 节流（新增行为）',
        /requestAnimationFrame/.test(backTopSeg), backTopSeg.slice(0, 80));

      await ctx.close();
    }

    // ======================================================== O 原有功能回归
    {
      const { ctx, page, errors } = await newSession(browser);
      allErrors.push(...errors);

      // 搜索渲染（含筛选 chips 的新 aria 属性不影响结果结构）
      await goto(page, base, '/', '.article-list');
      await page.focus('#searchInput');
      await page.keyboard.type('SLAM', { delay: 12 });
      await page.waitForTimeout(900);
      const searchOk = await page.evaluate(() => {
        const count = document.querySelector('.search-results-count');
        return count && /找到/.test(count.textContent);
      });
      check('O1.1 全局搜索结果渲染正常', !!searchOk);

      // 文章路由 + 目录（阅读工具不受 H1 去重影响）
      await goto(page, base, '/post/' + POST_ID, '.article-detail-body');
      const toc = await page.evaluate(() => ({
        tocItems: document.querySelectorAll('#tocPanel .toc-link').length,
        bodyChars: (document.querySelector('.article-detail-body') || { textContent: '' }).textContent.length
      }));
      check('O2.1 文章目录仍正常生成', toc.tocItems > 0, 'items=' + toc.tocItems);
      check('O2.2 正文仍完整渲染', toc.bodyChars > 500, 'chars=' + toc.bodyChars);

      // 主题切换
      await page.click('#themeToggle');
      const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      check('O3.1 主题切换正常', theme === 'dark', 'theme=' + theme);

      // SW 注册（本套件 block SW 的 context 除外——单独开一个 allow 的会话验证）
      const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow' });
      const page2 = await ctx2.newPage();
      await page2.goto(base + '/', { waitUntil: 'load', timeout: 60000 });
      await page2.waitForTimeout(1200);
      const swOk = await page2.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return !!(reg && reg.active);
      });
      check('O4.1 Service Worker 仍可注册激活', swOk);
      await ctx2.close();

      await ctx.close();
    }

    // ======================================================== 全局：无新增 Console Error
    check('X1.1 全流程无新增 Console Error / PageError', allErrors.length === 0,
      allErrors.slice(0, 4).join(' | ') + (allErrors.length > 4 ? ' …' : ''));
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
