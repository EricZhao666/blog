#!/usr/bin/env node
'use strict';
/**
 * Batch 7A-02：课程页 SEO 元数据（真实 Chromium + 本地 HTTP Server）
 *
 * 复现的缺陷：
 *   冷启动直接访问 #/course/:id 时，router 在笔记映射（js/note-slugs.js）到位前
 *   就调用 updateMetaForRoute()，canonical / og:url 落到站点根；
 *   loadData('notes') 的异步回调只重渲染正文，从不重新计算元数据，
 *   于是整次访问期间 canonical 都是错的。
 *
 * 覆盖：
 *   T1 冷启动 + note-slugs.js 延迟 → 映射到位后元数据必须更新
 *   T2 异步加载期间快速切到另一门课 → 不得串页
 *   T3 异步加载期间回到首页 → 旧 Promise 不得覆盖新页面元数据
 *   T4 映射脚本 404 → 回退到站点根，不产生错误 canonical
 *   T5 无静态笔记的课程 → 保持既定回退规则
 *   T6 静态 HTML（服务器原始响应，不执行 JS）的 canonical / og:url / JSON-LD
 *   T7 静态产物与生成器输出一致（14 页 + 索引 + sitemap + 映射表）
 *   T8 深色模式不影响元数据
 *   T9 多门课程冷启动 canonical 唯一且带 /blog/ 子路径
 *
 * 边界说明：
 *   - SPA 的 meta 由 JS 更新，搜索引擎是否采用取决于爬虫是否执行 JS；
 *     这里只验证"JS 更新的结果正确"，不宣称等效于静态 HTML。
 *   - notes/<slug>.html 是服务器直接返回的静态 HTML，其 canonical / og:url /
 *     JSON-LD 在源码里，T6 用原始响应字节做校验。
 *
 * 用法：
 *   node tests/browser/course-seo.spec.js
 *   PW_CHANNEL=chromium node tests/browser/course-seo.spec.js
 * 退出码：0 全部通过；1 有失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const SITE = 'https://ericzhao666.github.io/blog/';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const SHOTS = path.join(__dirname, 'artifacts');
const EVIDENCE = path.join(SHOTS, 'course-seo.json');

let pass = 0, fail = 0;
const results = [];
const evidence = {};

function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else fail++;
  results.push({ name, ok, extra: extra === undefined ? null : extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 从生成的映射表里取课程 id → 静态页相对路径（node 侧，作为断言基准）
function readNotePages() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'note-slugs.js'), 'utf8');
  const map = {};
  const re = /"([^"]+)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) map[m[1]] = m[2];
  return map;
}

const NOTE_PAGES = readNotePages();
// 选一门有笔记的课程做主线（按 id 排序取第一个，稳定可复现）
const COURSE_WITH_NOTES = Object.keys(NOTE_PAGES).sort()[0];
const COURSE_WITH_NOTES_2 = Object.keys(NOTE_PAGES).sort()[1];

function metaOf(page) {
  return page.evaluate(() => {
    const attr = (sel, name) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute(name) : null;
    };
    return {
      title: document.title,
      description: attr('meta[name="description"]', 'content'),
      canonical: attr('link[rel="canonical"]', 'href'),
      canonicalCount: document.querySelectorAll('link[rel="canonical"]').length,
      ogTitle: attr('meta[property="og:title"]', 'content'),
      ogDesc: attr('meta[property="og:description"]', 'content'),
      ogUrl: attr('meta[property="og:url"]', 'content'),
      theme: document.documentElement.getAttribute('data-theme'),
      hash: location.hash
    };
  });
}

function courseUrl(base, id) {
  return base + PREFIX + '/#/course/' + encodeURIComponent(id);
}

async function newPage(browser, opts) {
  const options = opts || {};
  const ctx = await browser.newContext({
    viewport: options.viewport || { width: 1280, height: 800 },
    serviceWorkers: 'block'   // SEO 断言与 SW 缓存无关，屏蔽后时序可复现
  });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 180)));
  return { ctx, page, pageErrors };
}

async function waitMidState(page) {
  // 中间态：课程笔记正文已到，映射表还在路上
  return page.waitForFunction(() => {
    const hasNotes = typeof COURSE_NOTES !== 'undefined';
    const hasMap = typeof NOTE_PAGES !== 'undefined';
    return hasNotes && !hasMap;
  }, null, { timeout: 20000 });
}

async function waitMap(page) {
  return page.waitForFunction(() => typeof NOTE_PAGES !== 'undefined', null, { timeout: 20000 });
}

async function waitCanonical(page, expected, timeout) {
  try {
    await page.waitForFunction(exp => {
      const el = document.querySelector('link[rel="canonical"]');
      return !!el && el.getAttribute('href') === exp;
    }, expected, { timeout: timeout || 8000 });
    return true;
  } catch (e) {
    return false;
  }
}

async function runScenario(label, fn) {
  try {
    await fn();
  } catch (e) {
    check(label + ' 执行未抛异常', false, String(e.message || e).split('\n')[0].slice(0, 200));
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
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
  console.log('主用例课程: ' + COURSE_WITH_NOTES + ' → ' + NOTE_PAGES[COURSE_WITH_NOTES]);

  function reset(over) {
    state.version = 1;
    state.swBump = false;
    state.faults = {};
    state.delays = {};
    state.hits = {};
    Object.assign(state, over || {});
  }

  try {
    // ---------------------------------------------------------------- T1 冷启动 + 映射延迟
    await runScenario('T1 冷启动', async () => {
      reset({ delays: { '/js/note-slugs.js': 2500 } });
      const { ctx, page, pageErrors } = await newPage(browser);
      const expectedCanonical = SITE + NOTE_PAGES[COURSE_WITH_NOTES];
      await page.goto(courseUrl(base, COURSE_WITH_NOTES), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitMidState(page);
      const mid = await metaOf(page);
      const courseTitle = await page.evaluate(id => {
        const c = COURSES.find(x => x.id === id);
        return c ? c.name : null;
      }, COURSE_WITH_NOTES);

      check('T1 映射未到位时标题已是课程标题', mid.title === courseTitle + ' 课程笔记 · Eric\'s Notebook', mid.title);
      check('T1 映射未到位时 canonical 回落站点根', mid.canonical === SITE, mid.canonical);
      check('T1 映射未到位时 canonical 不重复', mid.canonicalCount === 1, mid.canonicalCount);
      evidence.T1mid = { meta: mid, courseTitle };

      await waitMap(page);
      const ok = await waitCanonical(page, expectedCanonical, 10000);
      const final = await metaOf(page);
      check('T1 映射到位后 canonical 指向静态笔记页', ok && final.canonical === expectedCanonical,
        'expect=' + expectedCanonical + ' actual=' + final.canonical);
      check('T1 映射到位后 og:url 与 canonical 一致', final.ogUrl === expectedCanonical, final.ogUrl);
      check('T1 映射到位后 og:title 与标题一致', final.ogTitle === final.title, final.ogTitle);
      check('T1 标题仍为课程标题', final.title === courseTitle + ' 课程笔记 · Eric\'s Notebook', final.title);
      check('T1 canonical 唯一', final.canonicalCount === 1, final.canonicalCount);
      check('T1 canonical 带 /blog/ 子路径', final.canonical.indexOf(SITE) === 0 && final.canonical.indexOf('/blog/blog/') === -1,
        final.canonical);
      check('T1 无脚本异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      evidence.T1final = final;
      await ctx.close();
    });

    // ---------------------------------------------------------------- T2 加载期间切到另一门课
    await runScenario('T2 路由竞态', async () => {
      reset({ delays: { '/js/course-notes.js': 800, '/js/note-slugs.js': 2200 } });
      const { ctx, page, pageErrors } = await newPage(browser);
      await page.goto(courseUrl(base, COURSE_WITH_NOTES), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(350);
      const second = await page.evaluate(id => { location.hash = '#/course/' + encodeURIComponent(id); return location.hash; }, COURSE_WITH_NOTES_2);
      await waitMap(page);
      await sleep(800);
      const meta = await metaOf(page);
      const expectB = SITE + NOTE_PAGES[COURSE_WITH_NOTES_2];
      const expectBTitle = await page.evaluate(id => {
        const c = COURSES.find(x => x.id === id);
        return c ? c.name + ' 课程笔记 · Eric\'s Notebook' : null;
      }, COURSE_WITH_NOTES_2);
      check('T2 元数据属于新课程（B）', meta.canonical === expectB, 'expect=' + expectB + ' actual=' + meta.canonical);
      check('T2 标题属于新课程（B）', meta.title === expectBTitle, meta.title);
      check('T2 og:url 未被旧课程覆盖', meta.ogUrl === expectB, meta.ogUrl);
      check('T2 canonical 唯一', meta.canonicalCount === 1, meta.canonicalCount);
      check('T2 路由停在 B', meta.hash === '#/course/' + encodeURIComponent(COURSE_WITH_NOTES_2), meta.hash);
      check('T2 无脚本异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      evidence.T2 = { second, meta };
      await ctx.close();
    });

    // ---------------------------------------------------------------- T3 加载期间回首页
    await runScenario('T3 回首页竞态', async () => {
      reset({ delays: { '/js/note-slugs.js': 2000 } });
      const { ctx, page, pageErrors } = await newPage(browser);
      await page.goto(courseUrl(base, COURSE_WITH_NOTES), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(300);
      await page.evaluate(() => { location.hash = '#/'; });
      await page.waitForFunction(() => document.title === "Eric's Notebook", null, { timeout: 15000 }).catch(() => {});
      await sleep(2200);
      const meta = await metaOf(page);
      check('T3 首页标题未被旧 Promise 覆盖', meta.title === "Eric's Notebook", meta.title);
      check('T3 首页 canonical 回到站点根', meta.canonical === SITE, meta.canonical);
      check('T3 canonical 唯一', meta.canonicalCount === 1, meta.canonicalCount);
      check('T3 无脚本异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      evidence.T3 = meta;
      await ctx.close();
    });

    // ---------------------------------------------------------------- T4 映射脚本 404
    await runScenario('T4 映射加载失败', async () => {
      reset({ faults: { '/js/note-slugs.js': 404 } });
      const { ctx, page, pageErrors } = await newPage(browser);
      await page.goto(courseUrl(base, COURSE_WITH_NOTES), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => typeof COURSE_NOTES !== 'undefined', null, { timeout: 20000 });
      await sleep(1200);
      const meta = await metaOf(page);
      const courseTitle = await page.evaluate(id => {
        const c = COURSES.find(x => x.id === id);
        return c ? c.name : null;
      }, COURSE_WITH_NOTES);
      check('T4 映射 404 时 canonical 回退站点根', meta.canonical === SITE, meta.canonical);
      check('T4 映射 404 时 og:url 回退站点根', meta.ogUrl === SITE, meta.ogUrl);
      check('T4 映射 404 时不产生假的静态页 canonical',
        meta.canonical.indexOf('/notes/') === -1, meta.canonical);
      check('T4 标题仍为课程标题', meta.title === courseTitle + ' 课程笔记 · Eric\'s Notebook', meta.title);
      check('T4 canonical 唯一', meta.canonicalCount === 1, meta.canonicalCount);
      check('T4 无脚本异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      evidence.T4 = meta;
      await ctx.close();
    });

    // ---------------------------------------------------------------- T5 无静态笔记的课程
    await runScenario('T5 无静态映射课程', async () => {
      reset();
      const { ctx, page } = await newPage(browser);
      await page.goto(base + PREFIX + '/#/courses', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitMap(page);
      const target = await page.evaluate(() => {
        const maps = NOTE_PAGES || {};
        const c = COURSES.find(x => !maps[x.id]);
        return c ? { id: c.id, name: c.name } : null;
      });
      if (!target) {
        check('T5 存在无静态笔记的课程（数据前置）', false, '全部课程都有静态页，用例前提失效');
        await ctx.close();
        return;
      }
      await page.goto(courseUrl(base, target.id), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(id => {
        const c = (typeof COURSES !== 'undefined' ? COURSES : []).find(x => x.id === id);
        return !!c;
      }, target.id, { timeout: 20000 });
      await sleep(600);
      const meta = await metaOf(page);
      check('T5 无映射课程 canonical 回落站点根', meta.canonical === SITE, meta.canonical);
      check('T5 无映射课程标题正确', meta.title === target.name + ' 课程笔记 · Eric\'s Notebook', meta.title);
      check('T5 无映射课程 canonical 唯一', meta.canonicalCount === 1, meta.canonicalCount);
      evidence.T5 = { target, meta };
      await ctx.close();
    });

    // ---------------------------------------------------------------- T6 静态 HTML 原始响应
    await runScenario('T6 静态 HTML SEO', async () => {
      reset();
      const { ctx, page } = await newPage(browser);
      const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
      const files = fs.readdirSync(path.join(ROOT, 'notes')).filter(f => f.endsWith('.html')).sort();
      const pages = files.filter(f => f !== 'index.html');

      check('T6 静态笔记数量为 14', pages.length === 14, pages.length);

      const bad = [];
      for (const f of files) {
        const relPath = 'notes/' + f;
        const expect = SITE + (f === 'index.html' ? 'notes/' : relPath);
        const resp = await page.request.get(base + PREFIX + '/' + relPath);
        const html = await resp.text();
        if (resp.status() !== 200) { bad.push(relPath + ':status=' + resp.status()); continue; }

        const canonical = (html.match(/<link rel="canonical" href="([^"]+)">/g) || []);
        const ogUrl = (html.match(/<meta property="og:url" content="([^"]+)">/) || [])[1];
        const ogTitle = (html.match(/<meta property="og:title" content="([^"]+)">/) || [])[1];
        const desc = (html.match(/<meta name="description" content="([^"]+)">/) || [])[1];
        const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
        const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];

        if (canonical.length !== 1) bad.push(relPath + ':canonical 数量=' + canonical.length);
        if (canonical.length === 1 && canonical[0].indexOf('href="' + expect + '"') === -1) bad.push(relPath + ':canonical=' + canonical[0]);
        if (ogUrl !== expect) bad.push(relPath + ':og:url=' + ogUrl);
        if (!title || !ogTitle || !desc) bad.push(relPath + ':缺少 title/og:title/description');
        if (!sitemap.includes(expect)) bad.push(relPath + ':sitemap 缺失');
        if (f !== 'index.html') {
          if (!ld) {
            bad.push(relPath + ':缺少 JSON-LD');
          } else {
            let data = null;
            try { data = JSON.parse(ld); } catch (e) { bad.push(relPath + ':JSON-LD 解析失败'); }
            if (data) {
              if (data['@type'] !== 'Article') bad.push(relPath + ':JSON-LD 类型错误');
              if (data.mainEntityOfPage !== expect) bad.push(relPath + ':JSON-LD mainEntityOfPage=' + data.mainEntityOfPage);
              if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.dateModified || ''))) bad.push(relPath + ':JSON-LD dateModified 非法');
              if (ld.indexOf('<') !== -1) bad.push(relPath + ':JSON-LD 含原始尖括号');
            }
          }
        } else if (!sitemap.includes(SITE + 'notes/')) {
          bad.push('notes/index.html:sitemap 缺失');
        }
      }
      check('T6 14 页 + 索引的静态 SEO 全部正确', bad.length === 0, bad.slice(0, 4).join(' | '));
      evidence.T6 = { files: files.length, bad };
      await ctx.close();
    });

    // ---------------------------------------------------------------- T7 产物与生成器一致
    await runScenario('T7 生成器一致性', async () => {
      const sample = fs.readFileSync(path.join(ROOT, 'notes', 'index.html'), 'utf8');
      const pageFile = fs.readdirSync(path.join(ROOT, 'notes')).filter(f => f.endsWith('.html') && f !== 'index.html')[0];
      const pageSrc = fs.readFileSync(path.join(ROOT, 'notes', pageFile), 'utf8');
      const date = (pageSrc.match(/"dateModified":"(\d{4}-\d{2}-\d{2})"/) || [])[1];
      check('T7 能确定生成器固定日期', !!date && sample.length > 0, date);

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7a_gen_'));
      let genOk = true, genErr = '';
      try {
        execFileSync(process.execPath, [path.join(ROOT, 'gen_notes_pages.js'), '--out-dir', tmp, '--now', date],
          { cwd: ROOT, stdio: 'pipe' });
      } catch (e) {
        genOk = false;
        genErr = String(e.stderr || e.message).slice(0, 200);
      }
      check('T7 生成器可重复执行', genOk, genErr);

      if (genOk) {
        const diff = [];
        const files = fs.readdirSync(path.join(ROOT, 'notes')).filter(f => f.endsWith('.html'));
        for (const f of files) {
          const a = sha256(path.join(ROOT, 'notes', f));
          const b = sha256(path.join(tmp, 'notes', f));
          if (a !== b) diff.push('notes/' + f);
        }
        for (const rel of ['js/note-slugs.js', 'sitemap.xml']) {
          if (sha256(path.join(ROOT, rel)) !== sha256(path.join(tmp, rel))) diff.push(rel);
        }
        check('T7 仓库产物与生成器输出一致（15 页 + sitemap + 映射）', diff.length === 0, diff.slice(0, 4).join(' | '));
        evidence.T7 = { date, files: files.length, diff };
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // ---------------------------------------------------------------- T8 深色模式无回归
    await runScenario('T8 深色模式', async () => {
      reset();
      const { ctx, page } = await newPage(browser);
      await page.goto(courseUrl(base, COURSE_WITH_NOTES), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitMap(page);
      await waitCanonical(page, SITE + NOTE_PAGES[COURSE_WITH_NOTES], 10000);
      const before = await metaOf(page);
      await page.click('#themeToggle');
      const after = await metaOf(page);
      check('T8 主题已切到深色', after.theme === 'dark', after.theme);
      check('T8 深色模式不改变标题', after.title === before.title, after.title);
      check('T8 深色模式不改变 canonical', after.canonical === before.canonical, after.canonical);
      check('T8 深色模式不改变 og:url', after.ogUrl === before.ogUrl, after.ogUrl);
      check('T8 canonical 仍唯一', after.canonicalCount === 1, after.canonicalCount);
      await ctx.close();
    });

    // ---------------------------------------------------------------- T9 多课程冷启动
    await runScenario('T9 多课程冷启动', async () => {
      reset();
      const ids = Object.keys(NOTE_PAGES).sort().slice(0, 3);
      for (const id of ids) {
        const { ctx, page } = await newPage(browser);
        await page.goto(courseUrl(base, id), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitMap(page);
        const expect = SITE + NOTE_PAGES[id];
        const ok = await waitCanonical(page, expect, 10000);
        const meta = await metaOf(page);
        check('T9 冷启动 canonical 正确：' + id.slice(0, 18), ok && meta.canonical === expect,
          meta.canonical);
        check('T9 canonical 唯一且含 /blog/：' + id.slice(0, 18),
          meta.canonicalCount === 1 && meta.canonical.indexOf(SITE) === 0, meta.canonical);
        await ctx.close();
      }
    });
  } finally {
    await browser.close();
    server.close();
  }

  fs.writeFileSync(EVIDENCE, JSON.stringify({
    results, evidence,
    meta: { channel: CHANNEL, site: SITE, generatedAt: new Date().toISOString() }
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
