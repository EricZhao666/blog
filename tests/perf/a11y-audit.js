#!/usr/bin/env node
'use strict';
/**
 * Batch 8D-4：全站无障碍审计采集（只测量，不改业务代码）
 *
 * 用真实 Chromium 逐页执行 DOM/计算样式检查，输出各页问题计数与样本，
 * 用于优化前后的"无障碍问题数量"对比。不替代 WCAG 人工检查，
 * 结论口径为"可自动检测的子集"，报告中如实标注。
 *
 * 用法：
 *   node tests/perf/a11y-audit.js --out tests/perf/reports/batch8d4-a11y-before.json
 *   node tests/perf/a11y-audit.js --only home,post
 *
 * 检查项（可自动检测的子集）：
 *   A1 文档 title / lang / viewport
 *   A2 H1 唯一性 + 标题层级跳级
 *   A3 landmark（main/nav/header/footer）+ skip link
 *   A4 图片缺 alt（内容图）
 *   A5 链接/按钮无可访问名称（含 icon-only）
 *   A6 表单控件缺关联标签
 *   A7 文本对比度 < 4.5:1（大字 < 3:1），计算样式近似（渐变/图片背景不计入）
 *   A8 键盘焦点指示不可见（Tab 后 outline/box-shadow 均无）
 *   A9 触控目标 < 24×24（WCAG 2.5.8）
 *   A10 有动画但无 prefers-reduced-motion 覆盖
 *   A11 可展开控件（menu/filter/chip）缺 aria-expanded/aria-pressed
 *
 * 退出码：0 完成；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer, listen } = require('../browser/helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const SETTLE_MS = 1200;

function parseArgs(argv) {
  const a = { out: path.join(__dirname, 'reports', 'batch8d4-a11y.json'), only: null, keyword: 'SLAM' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = path.resolve(ROOT, argv[++i]);
    else if (argv[i] === '--only') a.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--keyword') a.keyword = argv[++i];
  }
  return a;
}

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
  return sorted[0] ? sorted[0].id : null;
}

// ---------------------------------------------------------------- 页面内审计脚本
const AUDIT_FN = `(() => {
  const out = {};
  const VIS = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = Array.from(document.querySelectorAll('body *'));

  // A1
  out.title = document.title || '';
  out.lang = document.documentElement.getAttribute('lang') || '';
  out.hasViewportMeta = !!document.querySelector('meta[name="viewport"]');

  // A2 标题
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(VIS);
  out.headingList = headings.map(h => h.tagName + ':' + (h.textContent || '').trim().slice(0, 30));
  out.h1Count = headings.filter(h => h.tagName === 'H1').length;
  let skip = [];
  let prev = 0;
  for (const h of headings) {
    const lv = Number(h.tagName[1]);
    if (prev && lv - prev > 1) skip.push({ from: 'h' + prev, to: 'h' + lv, text: (h.textContent || '').trim().slice(0, 30) });
    prev = lv;
  }
  out.headingSkips = skip;

  // A3 landmarks + skip link
  out.landmarks = {
    main: !!document.querySelector('main'),
    nav: !!document.querySelector('nav, [role="navigation"]'),
    header: !!document.querySelector('header, [role="banner"]'),
    footer: !!document.querySelector('footer, [role="contentinfo"]')
  };
  const skipLink = Array.from(document.querySelectorAll('a')).find(a => {
    const t = (a.textContent || '').trim();
    const cls = String(a.className || '');
    return /跳(过|到|转)|skip/i.test(t + ' ' + cls) && (a.getAttribute('href') || '').charAt(0) === '#';
  });
  out.hasSkipLink = !!skipLink;

  // A4 图片 alt（排除装饰性空 alt；缺属性才算问题）
  const imgs = Array.from(document.querySelectorAll('img'));
  out.imgCount = imgs.length;
  out.imgMissingAlt = imgs.filter(i => !i.hasAttribute('alt')).map(i => i.getAttribute('src') || '(src)').slice(0, 10);

  // A5 链接/按钮可访问名称
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label') || '';
    const labelBy = el.getAttribute('aria-labelledby');
    let ref = '';
    if (labelBy) {
      ref = labelBy.split(/\\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
    }
    const title = el.getAttribute('title') || '';
    const text = (el.textContent || '').trim();
    const imgAlt = el.querySelector('img[alt]') ? el.querySelector('img[alt]').getAttribute('alt') : '';
    return (aria || ref || title || imgAlt || text).trim();
  };
  const clickables = Array.from(document.querySelectorAll('a[href], button, [role="button"]')).filter(VIS);
  out.unnamedControls = clickables.filter(el => !nameOf(el)).map(el => {
    return { tag: el.tagName, cls: String(el.className || '').slice(0, 40), html: el.outerHTML.slice(0, 120) };
  }).slice(0, 15);

  // A6 表单控件标签
  const fields = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea, select')).filter(VIS);
  out.unlabeledFields = fields.filter(f => {
    const id = f.id;
    const lbl = id && document.querySelector('label[for="' + id + '"]');
    return !(f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || lbl || f.getAttribute('title'));
  }).map(f => ({ tag: f.tagName, id: f.id || '', name: f.name || '', type: f.getAttribute('type') || '' }));

  // A7 对比度（计算样式近似）
  const parseColor = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const effBg = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.9) return c;
      n = n.parentElement;
    }
    return parseColor(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const textEls = all.filter(el => {
    if (!VIS(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const direct = Array.from(el.childNodes).some(n => n.nodeType === 3 && (n.textContent || '').trim());
    return direct;
  });
  const contrastFails = [];
  const contrastChecked = Math.min(textEls.length, 600);
  for (const el of textEls.slice(0, 600)) {
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bg = effBg(el);
    if (!bg) continue;
    const fs = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = fs >= 24 || (fs >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < need) {
      contrastFails.push({
        tag: el.tagName, cls: String(el.className || '').slice(0, 40),
        color: cs.color, bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
        fontSize: cs.fontSize, ratio: Math.round(r * 100) / 100, need
      });
    }
  }
  out.contrastChecked = contrastChecked;
  out.contrastFailCount = contrastFails.length;
  out.contrastFails = contrastFails.slice(0, 15);
  out.contrastBasis = '计算样式近似：不含渐变/图片背景，不覆盖 ::before/::after 伪元素';

  // A8 键盘焦点指示（结构性检查：样式表里是否有 :focus/:focus-visible 指示）
  let focusRules = 0;
  try {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of Array.from(rules)) {
        const t = r.selectorText || (r.cssText || '');
        if (/:focus/.test(t)) focusRules++;
      }
    }
  } catch (e) { /* ignore */ }
  out.focusStyleRules = focusRules;
  out.focusIndicatorEnabled = focusRules > 0;

  // A9 触控目标（WCAG 2.5.8 最小 24×24，含 6.2.4 建议的常用 44px 参考另计）
  const MIN = 24;
  const targets = Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="checkbox"], input[type="radio"], select')).filter(VIS);
  const small = [];
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN - 0.5 || r.height < MIN - 0.5) {
      small.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  out.smallTouchTargets = small.slice(0, 15);
  out.smallTouchTargetCount = small.length;

  // A10 动画 vs prefers-reduced-motion
  let hasAnimation = false, hasReducedMotionBlock = false;
  try {
    const walk = (rules) => {
      for (const r of Array.from(rules)) {
        if (r.cssRules) { walk(r.cssRules); continue; }
        const t = r.cssText || '';
        if (/animation\\s*:|animation-name|transition\\s*:/.test(t) && !/:focus/.test(r.selectorText || '')) hasAnimation = true;
      }
    };
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of Array.from(rules)) {
        if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) hasReducedMotionBlock = true;
      }
      walk(rules);
    }
  } catch (e) { /* ignore */ }
  out.hasAnimation = hasAnimation;
  out.hasReducedMotionBlock = hasReducedMotionBlock;

  // A11 可展开控件状态
  const toggles = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [aria-expanded]')).filter(VIS);
  out.expandablesMissingState = toggles.filter(el => {
    const hint = String(el.className || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.id || '');
    const looksToggle = /menu|toggle|filter|chip|collapse|expand|light/i.test(hint);
    if (!looksToggle) return false;
    return !(el.hasAttribute('aria-expanded') || el.hasAttribute('aria-pressed'));
  }).map(el => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 40), id: el.id || '' })).slice(0, 10);

  // 汇总问题计数
  out.issueCount =
    (out.h1Count === 0 ? 1 : 0) +
    (out.h1Count > 1 ? 1 : 0) +
    out.headingSkips.length +
    (out.landmarks.main ? 0 : 1) +
    (out.hasSkipLink ? 0 : 1) +
    out.imgMissingAlt.length +
    out.unnamedControls.length +
    out.unlabeledFields.length +
    out.contrastFailCount +
    (out.focusIndicatorEnabled ? 0 : 1) +
    out.smallTouchTargetCount +
    (out.hasAnimation && !out.hasReducedMotionBlock ? 1 : 0) +
    out.expandablesMissingState.length;
  return out;
})()`;

// ---------------------------------------------------------------- 场景定义
const SCENARIOS = {
  home: { label: '首页', url: PREFIX + '/', nav: true },
  post: { label: '文章详情', url: null, hash: null, nav: true },
  courses: { label: '课程页', url: null, hash: '#/courses', nav: true },
  papers: { label: '论文与学习资料', url: null, hash: '#/papers', nav: true },
  search: { label: '搜索页', url: null, hash: null, nav: true, search: true },
  editor: { label: '编辑器', url: null, hash: '#/editor', nav: true },
  noteStatic: { label: '静态课程笔记页', url: null, note: true, nav: true }
};

async function openScenario(page, key, args, postId, noteId) {
  const sc = SCENARIOS[key];
  let url = sc.url || (PREFIX + '/');
  if (sc.note) url = PREFIX + '/notes/' + noteId;
  await page.goto('http://127.0.0.1:' + args.port + url, { waitUntil: 'load', timeout: 60000 });
  if (sc.hash) {
    await page.evaluate((h) => { location.hash = h; }, sc.hash);
  }
  if (sc.search) {
    await page.focus('#searchInput');
    await page.keyboard.type(args.keyword, { delay: 20 });
  }
  await page.waitForTimeout(SETTLE_MS + (sc.search ? 600 : 0));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const postId = longestPostId();
  const noteId = pickStaticNote();
  SCENARIOS.post.hash = '#/post/' + postId;
  SCENARIOS.post.url = PREFIX + '/#/post/' + postId;
  SCENARIOS.noteStatic.url = PREFIX + '/notes/' + noteId;

  const keys = args.only || Object.keys(SCENARIOS);
  for (const k of keys) if (!SCENARIOS[k]) { console.error('未知场景: ' + k); return 2; }

  const { server, state } = createServer(ROOT, PREFIX);
  let port;
  try {
    port = await listen(server, 8231);
  } catch (e) {
    console.error('无法启动静态服务器: ' + e.message);
    return 2;
  }
  args.port = port;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.error('无法启动 Chromium: ' + e.message);
    server.close();
    return 2;
  }

  const result = {
    meta: {
      generator: 'tests/perf/a11y-audit.js',
      generatedAt: new Date().toISOString(),
      basis: '真实 Chromium DOM/计算样式检查（可自动检测的 WCAG 2.2 AA 子集），viewport 1440×900 @1x',
      postId,
      noteId,
      keyword: args.keyword,
      checks: ['title/lang/viewport', 'h1唯一+层级跳级', 'landmark+skip-link', 'img alt', '控件可访问名称', '表单标签', '对比度(近似)', '焦点指示样式存在性', '触控目标24px', 'reduced-motion 覆盖', '展开控件状态']
    },
    pages: {},
    summary: null
  };

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));

  try {
    for (const key of keys) {
      const sc = SCENARIOS[key];
      console.log('-- ' + key + '（' + sc.label + '）--');
      try {
        await openScenario(page, key, args, postId, noteId);
        const audit = await page.evaluate(AUDIT_FN);
        audit.ok = true;
        result.pages[key] = audit;
        console.log('   issues=' + audit.issueCount
          + ' contrast=' + audit.contrastFailCount + '/' + audit.contrastChecked
          + ' unnamed=' + audit.unnamedControls.length
          + ' smallTargets=' + audit.smallTouchTargetCount
          + ' h1=' + audit.h1Count + ' skipLink=' + audit.hasSkipLink);
      } catch (e) {
        result.pages[key] = { ok: false, error: String(e.message || e).slice(0, 300) };
        console.log('   FAIL: ' + result.pages[key].error);
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }

  result.errors = errors.slice(0, 10);
  const okPages = Object.keys(result.pages).filter(k => result.pages[k].ok);
  result.summary = {
    pagesTotal: keys.length,
    pagesOk: okPages.length,
    issueCountTotal: okPages.reduce((s, k) => s + (result.pages[k].issueCount || 0), 0),
    perPage: Object.fromEntries(okPages.map(k => [k, result.pages[k].issueCount]))
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8');
  console.log('\nsummary: ' + JSON.stringify(result.summary));
  console.log('报告: ' + path.relative(ROOT, args.out));
  return result.summary.pagesOk === keys.length ? 0 : 1;
}

main().then((c) => { process.exitCode = c; }).catch((e) => { console.error('A11Y AUDIT ERROR:', e); process.exitCode = 2; });
