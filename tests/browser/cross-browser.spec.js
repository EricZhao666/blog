#!/usr/bin/env node
'use strict';
/**
 * Batch 8E-4：跨浏览器核心功能兼容性矩阵（C1–C5）
 *
 * 引擎：Chromium / Firefox / WebKit（Playwright 锁定版本自带浏览器）
 * 入口独立于既有 64 套回归：默认 full 与 CI 行为不变。
 *
 * 用法：
 *   node tests/browser/cross-browser.spec.js                       # 三个引擎依次串行
 *   node tests/browser/cross-browser.spec.js --engines=firefox
 *   node tests/browser/cross-browser.spec.js --engines=webkit --scenario=C2
 *
 * 退出码：0 全部通过；1 有 FAIL；2 有引擎无法启动（BLOCKED），不伪造通过。
 *
 * 说明：Playwright WebKit 只代表 WebKit 引擎，不等同真实 macOS Safari / iOS 设备验收。
 *       中文输入法只验证合成事件与组合期守卫，不宣称已验证真实 IME。
 */
const { createServer, listen } = require('./helpers/server');
const {
  ROOT, PREFIX, parseArgs, runEngines, blockExternal, sleep
} = require('./helpers/cross-browser');

const args = parseArgs(process.argv.slice(2));
const SPEC = 'cross-browser';

let serverHandle = null;
let BASE = '';

function mdLong() {
  const parts = ['# 合成长文', '', '开篇正文，用于跨浏览器阅读体验验证。', ''];
  for (let i = 1; i <= 7; i++) {
    parts.push('## 第 ' + i + ' 节', '', '第 ' + i + ' 节正文。' + '跨浏览器内容'.repeat(20), '');
    if (i === 2) {
      parts.push('```js', 'const browser = "engine";', 'console.log(browser);', '```', '');
    }
    if (i === 3) {
      parts.push('![测试图](icons/icon-192.png)', '');
    }
    if (i === 4) parts.push('### 4.1 子节', '', '子节内容。', '');
  }
  return parts.join('\n');
}

function mkPost(id, extra) {
  const e = extra || {};
  return {
    id: id,
    title: e.title || ('跨浏览器合成 ' + id),
    date: '2026-11-19',
    tags: e.tags || ['测试'],
    excerpt: e.excerpt || '合成测试文章',
    content: e.content || mdLong()
  };
}

async function newSession(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1440, height: 900 },
    serviceWorkers: 'block'
  });
  await blockExternal(ctx);
  if (o.initScript) await ctx.addInitScript(o.initScript);
  if (o.permissions) {
    try { await ctx.grantPermissions(o.permissions, { origin: BASE }); } catch (e) { /* 引擎可能不支持 */ }
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });
  await page.goto(BASE + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible', timeout: 30000 });
  return { ctx: ctx, page: page, errors: errors };
}

async function mountPost(page, post) {
  await page.evaluate(function (p) {
    window.eval('USER_POSTS.push(' + JSON.stringify(p) + ');');
    window.eval("location.hash = '#/post/" + p.id + "'");
  }, post);
  await page.waitForSelector('.article-detail-body', { timeout: 20000 });
  await sleep(400);
}

async function homeReady(page) {
  await page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
  await page.waitForSelector('#app a[href^="#/post/"]', { timeout: 20000 });
}

// 取一条真实文章链接（排除本轮注入的合成文章，保证深链接命中真实数据）
async function realPostHref(page) {
  return page.evaluate(function () {
    const links = Array.prototype.slice.call(document.querySelectorAll('#app a[href^="#/post/"]'));
    const real = links.filter(function (a) {
      return (a.getAttribute('href') || '').indexOf('b8e4-') === -1;
    });
    const target = real[0] || links[0];
    return target ? target.getAttribute('href') : '';
  });
}

// 桌面宽屏下编辑/预览切换按钮被 CSS 隐藏（双栏同时可见），
// 这里直接触发同一个按钮的 click 处理器，避免把“按钮不可见”误判为功能缺陷。
async function switchEditorView(page, view) {
  await page.evaluate(function (v) {
    const btn = document.querySelector('[data-view="' + v + '"]');
    if (btn) btn.click();
  }, view);
}

// ---------------------------------------------------------------- C1 页面与导航
async function scenarioC1(env) {
  const r = env.reporter;
  const s = await newSession(env.browser);

  const cards = await s.page.locator('#app a[href^="#/post/"]').count();
  r.check('C1', '首页正常加载并渲染文章卡片', cards > 0, 'post_links=' + cards);

  await s.page.locator('#app a[href^="#/post/"]').first().click();
  await s.page.waitForSelector('.article-detail-body', { timeout: 20000 });
  const articleLen = await s.page.evaluate(function () {
    const b = document.querySelector('.article-detail-body');
    return b ? (b.textContent || '').length : 0;
  });
  r.check('C1', '文章详情正常渲染', articleLen > 100, 'body_chars=' + articleLen);

  // 中文文章 + 特殊字符标签 + O'Brien 标签导航
  const tagPost = mkPost('b8e4-tags', {
    title: '中文标题 O\'Brien 与特殊字符',
    tags: ["O'Brien", '中文 标签', 'a&b'],
    content: '# 中文正文\n\n正文内容。\n'
  });
  await mountPost(s.page, tagPost);
  const titleOk = (await s.page.locator('.article-detail-body').innerText()).indexOf('中文正文') >= 0;
  const chips = await s.page.locator('.tag').count();
  r.check('C1', '中文文章渲染', titleOk, 'chips=' + chips);
  r.check('C1', '特殊字符标签渲染', chips >= 3, 'chips=' + chips);

  const obrien = s.page.locator('.tag', { hasText: "O'Brien" }).first();
  const hasObrien = (await obrien.count()) > 0;
  if (hasObrien) {
    await obrien.click();
    await s.page.waitForFunction(function () {
      return location.hash.indexOf('#/tags/') === 0;
    }, null, { timeout: 10000 });
    const hash = decodeURIComponent(await s.page.evaluate(function () { return location.hash; }));
    r.check('C1', 'O\'Brien 标签导航到标签页（未冒泡到文章）', hash.indexOf('#/tags/') === 0 && hash.indexOf("O'Brien") >= 0, hash);
    const tagText = await s.page.evaluate(function () { return (document.querySelector('#app') || {}).innerText || ''; });
    r.check('C1', '标签页内容包含该标签', tagText.indexOf("O'Brien") >= 0);
  } else {
    r.fail('C1', 'O\'Brien 标签导航到标签页（未冒泡到文章）', '未渲染含 O\'Brien 的标签 chip');
  }

  // 课程 / 代码库
  await s.page.evaluate(function () { location.hash = '#/courses'; });
  await s.page.waitForSelector('.course-card', { timeout: 20000 });
  const courseCards = await s.page.locator('.course-card').count();
  r.check('C1', '课程页面渲染', courseCards > 0, 'cards=' + courseCards);

  await s.page.evaluate(function () { location.hash = '#/code'; });
  await s.page.waitForFunction(function () { return location.hash === '#/code'; }, null, { timeout: 15000 });
  // 代码库数据按需加载（js/codefiles.js），各引擎加载时序不同：有界等待卡片出现
  let codeCards = 0;
  for (let i = 0; i < 40; i++) {
    codeCards = await s.page.locator('.course-card').count();
    if (codeCards > 0) break;
    await sleep(250);
  }
  r.check('C1', '代码库页面渲染', codeCards > 0, 'cards=' + codeCards);

  // 深链接直接访问（独立页面，走真实 hash 入口）
  await s.page.evaluate(function () { location.hash = '#/'; });
  await homeReady(s.page);
  const href = await realPostHref(s.page);
  const s2 = await newSession(env.browser);
  try {
    await s2.page.goto(BASE + PREFIX + '/index.html' + href, { waitUntil: 'load', timeout: 60000 });
    await s2.page.waitForSelector('.article-detail-body', { timeout: 20000 });
    const deepLen = await s2.page.evaluate(function () {
      const b = document.querySelector('.article-detail-body');
      return b ? (b.textContent || '').length : 0;
    });
    r.check('C1', '深链接直接访问文章', deepLen > 100, href + ' chars=' + deepLen);
  } catch (e) {
    const diag = await s2.page.evaluate(function () {
      return {
        url: location.href,
        hash: location.hash,
        text: ((document.querySelector('#app') || {}).innerText || '').slice(0, 120)
      };
    }).catch(function () { return {}; });
    r.fail('C1', '深链接直接访问文章', 'href=' + href + ' ' + JSON.stringify(diag) + ' err=' + e.message.split('\n')[0]);
  } finally {
    await s2.ctx.close();
  }

  // 前进 / 后退 / 刷新
  try {
    await s.page.evaluate(function () { location.hash = '#/'; });
    await homeReady(s.page);
    const realHref = await realPostHref(s.page);
    await s.page.locator('#app a[href="' + realHref + '"]').first().click();
    await s.page.waitForSelector('.article-detail-body', { timeout: 20000 });
    await s.page.goBack();
    await s.page.waitForFunction(function () {
      return location.hash === '#/' || location.hash === '';
    }, null, { timeout: 15000 });
    await homeReady(s.page);
    r.pass('C1', '浏览器后退回到首页');

    await s.page.goForward();
    await s.page.waitForSelector('.article-detail-body', { timeout: 20000 });
    r.pass('C1', '浏览器前进回到文章');

    await s.page.reload({ waitUntil: 'load', timeout: 60000 });
    await s.page.waitForSelector('.article-detail-body', { timeout: 20000 });
    r.pass('C1', '刷新后文章仍渲染');
  } catch (e) {
    const diag = await s.page.evaluate(function () {
      return { url: location.href, hash: location.hash };
    }).catch(function () { return {}; });
    r.fail('C1', '前进/后退/刷新', JSON.stringify(diag) + ' err=' + e.message.split('\n')[0]);
  }

  r.check('C1', '无未处理运行时异常', s.errors.length === 0, s.errors.slice(0, 3).join(' | ') || 'none');
  await s.ctx.close();
}

// ---------------------------------------------------------------- C2 搜索体验
async function scenarioC2(env) {
  const r = env.reporter;
  const s = await newSession(env.browser);

  const firstTitle = await s.page.locator('#app .article-card-title').first().innerText();
  const cn = firstTitle.replace(/\s/g, '').slice(0, 3) || '文章';
  const enMatch = /[A-Za-z]{4,}/.exec(firstTitle);
  const en = enMatch ? enMatch[0] : 'Batch';

  async function runQuery(q) {
    const input = s.page.locator('#searchInput');
    await input.fill('');
    await input.fill(q);
    await sleep(500);
    return {
      results: await s.page.locator('[data-search-result]').count(),
      sections: await s.page.locator('.search-section-title').count(),
      titles: await s.page.locator('.search-section-title').allInnerTexts()
    };
  }

  const cnRes = await runQuery(cn);
  r.check('C2', '中文搜索返回结果', cnRes.results > 0, 'q=' + cn + ' results=' + cnRes.results);

  const enRes = await runQuery(en);
  r.check('C2', '英文搜索返回结果', enRes.results > 0, 'q=' + en + ' results=' + enRes.results);

  // 不同类型结果渲染：探测数据集，取分类最多的查询
  let best = { q: '', sections: 0, titles: [] };
  const probes = ['模型', '笔记', '论文', 'P17', 'VLA', '性能', cn];
  for (const q of probes) {
    const res = await runQuery(q);
    if (res.sections > best.sections) best = { q: q, sections: res.sections, titles: res.titles };
    if (best.sections >= 3) break;
  }
  r.check('C2', '多种类型结果同时渲染', best.sections >= 2,
    'q=' + best.q + ' sections=' + best.sections + ' ' + best.titles.join('/'));

  // 分类筛选
  await runQuery(best.q || cn);
  const filters = s.page.locator('[data-search-filter]');
  const filterCount = await filters.count();
  if (filterCount > 0) {
    const postFilter = s.page.locator('[data-search-filter="post"]');
    const target = (await postFilter.count()) > 0 ? postFilter : filters.first();
    await target.click();
    await sleep(300);
    const pressed = await target.getAttribute('aria-pressed');
    const afterCount = await s.page.locator('[data-search-result]').count();
    r.check('C2', '搜索分类筛选生效', pressed === 'true' && afterCount > 0,
      'filters=' + filterCount + ' pressed=' + pressed + ' results=' + afterCount);
  } else {
    r.skip('C2', '搜索分类筛选生效', '当前查询未渲染筛选条');
  }

  // 键盘交互：ArrowDown 选中 + Enter 打开
  const keyboardQuery = (best.q || cn);
  await runQuery(keyboardQuery);
  await s.page.locator('#searchInput').focus();
  await s.page.keyboard.press('ArrowDown');
  const selected = await s.page.evaluate(function () {
    const n = document.querySelector('[data-search-result][aria-selected="true"]');
    return n ? n.getAttribute('data-href') : '';
  });
  r.check('C2', '键盘 ArrowDown 选中首条结果', !!selected, 'href=' + selected);
  if (selected) {
    await s.page.keyboard.press('Enter');
    await s.page.waitForFunction(function (h) { return location.hash === h; }, selected, { timeout: 15000 })
      .catch(function () { /* 交给下面的断言 */ });
    const hash = await s.page.evaluate(function () { return location.hash; });
    r.check('C2', '键盘 Enter 打开选中结果', hash === selected, 'hash=' + hash);
  } else {
    r.fail('C2', '键盘 Enter 打开选中结果', '没有选中项');
  }

  // 鼠标点击结果跳转
  await s.page.evaluate(function () { location.hash = '#/'; });
  await homeReady(s.page);
  await runQuery(keyboardQuery);
  const before = await s.page.locator('[data-search-result]').count();
  if (before > 0) {
    const targetHref = await s.page.locator('[data-search-result]').first().getAttribute('data-href');
    await s.page.locator('[data-search-result]').first().click();
    await s.page.waitForFunction(function (h) { return location.hash === h; }, targetHref, { timeout: 15000 })
      .catch(function () { /* 交给断言 */ });
    const hash = await s.page.evaluate(function () { return location.hash; });
    r.check('C2', '点击搜索结果跳转', hash === targetHref, 'hash=' + hash);
  } else {
    r.fail('C2', '点击搜索结果跳转', '无结果可点击');
  }

  r.skip('C2', '真实操作系统输入法', '本轮只验证合成键盘事件与组合期守卫；真实 IME 输入未在自动化环境验证');

  r.check('C2', '搜索流程无未处理运行时异常', s.errors.length === 0, s.errors.slice(0, 3).join(' | ') || 'none');
  await s.ctx.close();
}

// ---------------------------------------------------------------- C3 编辑器
async function scenarioC3(env) {
  const r = env.reporter;
  const s = await newSession(env.browser);
  await s.page.evaluate(function () { location.hash = '#/editor'; });
  await s.page.waitForSelector('#editorContent', { state: 'visible', timeout: 20000 });
  r.pass('C3', '编辑器页面加载');

  // Markdown 编辑与预览
  await s.page.fill('#editorContent', '# 预览标题\n\n**加粗内容**\n\n- 列表项一\n- 列表项二\n\n```js\nconsole.log(1);\n```\n');
  await switchEditorView(s.page, 'preview');
  await s.page.waitForSelector('#editorPreview h1', { timeout: 15000 });
  const preview = await s.page.evaluate(function () {
    const p = document.querySelector('#editorPreview');
    return {
      view: (document.querySelector('#editorSplit') || {}).getAttribute
        ? document.querySelector('#editorSplit').getAttribute('data-view') : '',
      h1: !!p.querySelector('h1'),
      strong: !!p.querySelector('strong'),
      li: p.querySelectorAll('li').length,
      code: !!p.querySelector('pre code')
    };
  });
  r.check('C3', 'Markdown 预览渲染标题/加粗/列表/代码', preview.h1 && preview.strong && preview.li >= 2 && preview.code,
    JSON.stringify(preview));

  // 工具栏基本功能
  await switchEditorView(s.page, 'edit');
  await s.page.fill('#editorContent', '工具栏文本');
  await s.page.locator('#editorContent').focus();
  await s.page.keyboard.press('Control+A');
  await s.page.locator('[data-md="bold"]').click();
  const boldValue = await s.page.inputValue('#editorContent');
  r.check('C3', '工具栏加粗插入标记', boldValue.indexOf('**') >= 0, boldValue.slice(0, 40));

  await s.page.fill('#editorContent', '');
  await s.page.locator('#editorContent').focus();
  await s.page.locator('[data-md="h2"]').click();
  const h2Value = await s.page.inputValue('#editorContent');
  r.check('C3', '工具栏标题插入标记', h2Value.indexOf('## ') >= 0, JSON.stringify(h2Value.slice(0, 20)));

  // 草稿保存与刷新恢复
  const marker = '跨浏览器草稿 ' + Date.now();
  await s.page.fill('#editorTitle', '跨浏览器草稿标题');
  await s.page.fill('#editorContent', '# 草稿\n\n' + marker + '\n');
  let draftSaved = false;
  try {
    await s.page.waitForFunction(function (m) {
      try {
        const raw = localStorage.getItem('blog_draft');
        return !!raw && raw.indexOf(m) >= 0;
      } catch (e) { return false; }
    }, marker, { timeout: 8000 });
    draftSaved = true;
  } catch (e) { draftSaved = false; }
  r.check('C3', '草稿写入 localStorage', draftSaved, 'key=blog_draft');

  if (draftSaved) {
    await s.page.reload({ waitUntil: 'load', timeout: 60000 });
    await s.page.waitForSelector('#editorContent', { state: 'visible', timeout: 20000 });
    const restored = await s.page.inputValue('#editorContent');
    r.check('C3', '刷新后草稿恢复', restored.indexOf(marker) >= 0, 'chars=' + restored.length);
  } else {
    r.fail('C3', '刷新后草稿恢复', '前置草稿未写入');
  }

  // IndexedDB 历史记录（能力缺失记为 SKIP，不伪造通过）
  const idb = await s.page.evaluate(function () {
    return new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve({ ok: false, reason: 'indexedDB 不可用' });
      if (typeof indexedDB.databases !== 'function') return resolve({ ok: false, reason: 'indexedDB.databases 不支持' });
      indexedDB.databases().then(function (list) {
        resolve({ ok: true, names: (list || []).map(function (d) { return d.name; }) });
      }).catch(function (e) { resolve({ ok: false, reason: e.message }); });
    });
  });
  if (!idb.ok) {
    r.skip('C3', 'IndexedDB 历史库创建', idb.reason);
  } else {
    r.check('C3', 'IndexedDB 历史库创建', idb.names.indexOf('blog-draft-history') >= 0, idb.names.join(','));
  }

  // 导出文件内容与编码（通过替换 download 钩子，避免依赖各引擎下载事件）
  const exportProbe = await s.page.evaluate(function () {
    let captured = null;
    const orig = window.__downloadText;
    window.__downloadText = function (text, filename) { captured = { text: text, filename: filename }; };
    try {
      window.exportPost();
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      window.__downloadText = orig;
    }
    if (!captured) return { ok: false, reason: '未触发下载' };
    let parsed = null;
    try { parsed = JSON.parse(captured.text); } catch (e) { return { ok: false, reason: 'JSON 解析失败: ' + e.message }; }
    return {
      ok: true, filename: captured.filename, title: parsed.title, content: parsed.content || '',
      hasCjk: /[\u4e00-\u9fa5]/.test(captured.text)
    };
  });
  r.check('C3', '导出 JSON 内容与中文编码正确',
    exportProbe.ok && exportProbe.hasCjk && /\.json$/.test(exportProbe.filename || '') &&
    (exportProbe.content || '').indexOf(marker) >= 0,
    exportProbe.ok ? (exportProbe.filename + ' hasCjk=' + exportProbe.hasCjk) : exportProbe.reason);

  // 特殊字符与长文本
  const longText = '# 长文本\n\n' + ('特殊字符 “引号” O\'Brien <标签> & 符号 🚀 '.repeat(120));
  await s.page.fill('#editorContent', longText);
  await switchEditorView(s.page, 'preview');
  await sleep(500);
  const longPreview = await s.page.evaluate(function () {
    const p = document.querySelector('#editorPreview');
    return p ? (p.textContent || '').length : 0;
  });
  const stats = await s.page.evaluate(function () {
    const el = document.querySelector('[data-stat="chars"]');
    return el ? el.textContent : '';
  });
  r.check('C3', '特殊字符与长文本预览渲染', longPreview > 1000, 'preview_chars=' + longPreview + ' stats=' + stats);

  r.check('C3', '编辑器流程无未处理运行时异常', s.errors.length === 0, s.errors.slice(0, 3).join(' | ') || 'none');
  await s.ctx.close();
}

// ---------------------------------------------------------------- C4 阅读体验
async function scenarioC4(env) {
  const r = env.reporter;
  const s = await newSession(env.browser, { viewport: { width: 1440, height: 900 } });
  const post = mkPost('b8e4-reading', { title: '跨浏览器阅读体验', tags: ['阅读'] });
  await mountPost(s.page, post);

  const tocLinks = await s.page.locator('#tocPanel .toc-link').count();
  r.check('C4', '目录生成', tocLinks >= 5, 'links=' + tocLinks);

  if (tocLinks >= 3) {
    await s.page.locator('#tocPanel .toc-link').nth(2).click();
    await sleep(500);
    const scrolled = await s.page.evaluate(function () { return window.scrollY; });
    r.check('C4', '目录点击跳转', scrolled > 50, 'scrollY=' + Math.round(scrolled));
  } else {
    r.fail('C4', '目录点击跳转', '目录项不足');
  }

  await s.page.evaluate(function () { window.scrollTo(0, document.body.scrollHeight); });
  await sleep(600);
  const progress = await s.page.evaluate(function () {
    const bar = document.querySelector('#readingProgress i');
    if (!bar) return { found: false };
    const w = bar.style.width || getComputedStyle(bar).width;
    return { found: true, width: w, ratio: parseFloat(w) };
  });
  r.check('C4', '阅读进度条更新', progress.found && progress.ratio > 0, JSON.stringify(progress));

  // 代码块复制（不支持剪贴板时必须是可见降级，不允许静默失败）
  const copy = await s.page.evaluate(function () {
    const btn = document.querySelector('.copy-btn');
    return btn ? { exists: true } : { exists: false };
  });
  if (copy.exists) {
    await s.page.locator('.copy-btn').first().click();
    let state = '';
    try {
      await s.page.waitForFunction(function () {
        const b = document.querySelector('.copy-btn');
        return !!b && (b.getAttribute('data-copy-state') === 'ok' || b.getAttribute('data-copy-state') === 'error');
      }, null, { timeout: 5000 });
      state = await s.page.evaluate(function () {
        return document.querySelector('.copy-btn').getAttribute('data-copy-state');
      });
    } catch (e) { state = 'timeout'; }
    r.check('C4', '代码复制有明确成功/降级反馈', state === 'ok' || state === 'error', 'state=' + state);
  } else {
    r.fail('C4', '代码复制有明确成功/降级反馈', '未渲染复制按钮');
  }

  // 图片灯箱 + Esc 关闭 + 焦点恢复
  const lightbox = await s.page.evaluate(function () {
    const img = document.querySelector('.article-detail-body img.zoomable-image');
    return img ? { ok: true } : { ok: false };
  });
  if (lightbox.ok) {
    await s.page.locator('.article-detail-body img.zoomable-image').first().click();
    await s.page.waitForFunction(function () {
      const d = document.querySelector('#imageLightbox');
      return !!d && d.open === true;
    }, null, { timeout: 10000 });
    r.pass('C4', '图片灯箱打开');
    await s.page.keyboard.press('Escape');
    await s.page.waitForFunction(function () {
      const d = document.querySelector('#imageLightbox');
      return !d || d.open !== true;
    }, null, { timeout: 10000 });
    r.pass('C4', 'Esc 关闭灯箱');
    const focus = await s.page.evaluate(function () {
      const a = document.activeElement;
      return a ? { tag: a.tagName, cls: a.className || '' } : { tag: '' };
    });
    r.check('C4', '关闭后焦点回到触发图片', focus.tag === 'IMG', JSON.stringify(focus));
  } else {
    r.fail('C4', '图片灯箱打开', '合成文章图片未生成 zoomable-image');
  }

  // 静态笔记页
  const notes = await newSession(env.browser);
  try {
    await notes.page.goto(BASE + PREFIX + '/notes/capd.html', { waitUntil: 'load', timeout: 60000 });
    const notesInfo = await notes.page.evaluate(function () {
      return {
        title: document.title || '',
        h1: document.querySelectorAll('h1').length,
        chars: (document.body.innerText || '').length
      };
    });
    r.check('C4', '静态笔记页可读', notesInfo.title.length > 0 && notesInfo.chars > 200,
      JSON.stringify(notesInfo));
    r.check('C4', '静态笔记页无未处理异常', notes.errors.length === 0, notes.errors.slice(0, 2).join(' | ') || 'none');
  } finally {
    await notes.ctx.close();
  }

  r.check('C4', '阅读流程无未处理运行时异常', s.errors.length === 0, s.errors.slice(0, 3).join(' | ') || 'none');
  await s.ctx.close();
}

// ---------------------------------------------------------------- C5 响应式与主题
async function scenarioC5(env) {
  const r = env.reporter;
  const widths = [390, 768, 1440];
  const post = mkPost('b8e4-responsive', { title: '响应式合成文章', tags: ['响应式'] });

  for (const w of widths) {
    const s = await newSession(env.browser, { viewport: { width: w, height: 900 } });
    const homeOverflow = await s.page.evaluate(function () {
      return { doc: document.documentElement.scrollWidth, win: window.innerWidth };
    });
    r.check('C5', '首页无横向溢出 @' + w + 'px', homeOverflow.doc <= homeOverflow.win + 1,
      'doc=' + homeOverflow.doc + ' win=' + homeOverflow.win);

    await mountPost(s.page, post);
    const artOverflow = await s.page.evaluate(function () {
      return { doc: document.documentElement.scrollWidth, win: window.innerWidth };
    });
    r.check('C5', '文章页无横向溢出 @' + w + 'px', artOverflow.doc <= artOverflow.win + 1,
      'doc=' + artOverflow.doc + ' win=' + artOverflow.win);

    const readable = await s.page.evaluate(function () {
      const b = document.querySelector('.article-detail-body');
      if (!b) return { chars: 0, font: 0 };
      return { chars: (b.innerText || '').length, font: parseFloat(getComputedStyle(b).fontSize) };
    });
    r.check('C5', '正文可读 @' + w + 'px', readable.chars > 200 && readable.font >= 12, JSON.stringify(readable));

    if (w === 390) {
      const toggle = s.page.locator('#themeToggle');
      r.check('C5', '移动端主题按钮可见', await toggle.isVisible());

      // 移动端导航折叠为菜单按钮：点击后展开并可跳转
      const menu = s.page.locator('#menuToggle');
      r.check('C5', '移动端菜单按钮可见', await menu.isVisible());
      await menu.click();
      await sleep(300);
      const navState = await s.page.evaluate(function () {
        const nav = document.getElementById('siteNav');
        const btn = document.getElementById('menuToggle');
        return {
          open: !!nav && nav.classList.contains('open'),
          expanded: btn ? btn.getAttribute('aria-expanded') : '',
          visible: !!nav && getComputedStyle(nav).visibility === 'visible'
        };
      });
      r.check('C5', '移动端菜单可展开', navState.open && navState.visible,
        JSON.stringify(navState));
      await s.page.locator('#siteNav a[href="#/courses"]').click();
      await s.page.waitForFunction(function () { return location.hash === '#/courses'; }, null, { timeout: 15000 });
      await s.page.waitForSelector('.course-card', { timeout: 20000 });
      r.pass('C5', '移动端菜单可导航');
      await s.page.evaluate(function () { location.hash = '#/'; });
      await homeReady(s.page);
      const first = s.page.locator('#app a[href^="#/post/"]').first();
      const target = await first.getAttribute('href');
      await first.click();
      await s.page.waitForFunction(function (h) { return location.hash === h; }, target, { timeout: 15000 })
        .catch(function () { /* 交给断言 */ });
      const h = await s.page.evaluate(function () { return location.hash; });
      r.check('C5', '移动端文章卡片可点击', h === target, 'hash=' + h);
    }
    await s.ctx.close();
  }

  // 深浅色主题切换与持久化
  const s = await newSession(env.browser, { viewport: { width: 1440, height: 900 } });
  const before = await s.page.evaluate(function () {
    return document.documentElement.getAttribute('data-theme');
  });
  await s.page.locator('#themeToggle').click();
  await sleep(200);
  const after = await s.page.evaluate(function () {
    return document.documentElement.getAttribute('data-theme');
  });
  r.check('C5', '主题切换生效', before !== after && (after === 'dark' || after === 'light'),
    before + ' -> ' + after);
  await s.page.reload({ waitUntil: 'load', timeout: 60000 });
  await homeReady(s.page);
  const persisted = await s.page.evaluate(function () {
    return document.documentElement.getAttribute('data-theme');
  });
  r.check('C5', '主题选择刷新后保持', persisted === after, 'persisted=' + persisted);
  r.check('C5', '响应式/主题流程无未处理异常', s.errors.length === 0, s.errors.slice(0, 3).join(' | ') || 'none');
  await s.ctx.close();
}

// ---------------------------------------------------------------- K1 知识库（Batch 9A-1）
// 三引擎一致：详情页收藏 → 知识页出现 → 取消收藏 → 空状态
async function scenarioK1(env) {
  const r = env.reporter;
  const s = await newSession(env.browser);
  const post = mkPost('b9a1-k1', {
    title: '知识库跨引擎验收',
    tags: ['知识库'],
    content: '# 跨引擎\n\n正文内容。\n'
  });
  try {
    await mountPost(s.page, post);
    await s.page.waitForSelector('.km-actions [data-km-toggle="fav"]', { timeout: 20000 });
    const fav = s.page.locator('.km-actions [data-km-toggle="fav"]').first();
    await fav.click();
    await sleep(400);
    r.check('K1', '详情页收藏状态生效', (await fav.getAttribute('aria-pressed')) === 'true');

    await s.page.evaluate(function () { location.hash = '#/knowledge?tab=favorites'; });
    await s.page.waitForSelector('#kmList', { timeout: 20000 });
    await sleep(800);
    const items = await s.page.locator('.km-item').count();
    r.check('K1', '收藏出现在知识中心', items >= 1, 'items=' + items);

    const remove = s.page.locator('[data-km-remove="fav"]').first();
    if ((await remove.count()) > 0) {
      await remove.click();
      await sleep(700);
    }
    r.check('K1', '取消收藏后回到空状态', (await s.page.locator('.km-empty').count()) === 1);
    r.check('K1', '知识库流程无未处理异常', s.errors.length === 0, s.errors.slice(0, 2).join(' | ') || 'none');
  } finally {
    await s.ctx.close();
  }
}

const SCENARIOS = { C1: scenarioC1, C2: scenarioC2, C3: scenarioC3, C4: scenarioC4, C5: scenarioC5, K1: scenarioK1 };

(async function main() {
  serverHandle = createServer(ROOT, PREFIX);
  const port = await listen(serverHandle.server, 0);
  BASE = 'http://127.0.0.1:' + port;
  console.log('SERVER ' + BASE + PREFIX);

  const names = args.scenario ? [args.scenario] : Object.keys(SCENARIOS);
  const unknown = names.filter(function (n) { return !SCENARIOS[n]; });
  if (unknown.length) {
    console.error('未知场景: ' + unknown.join(', '));
    process.exit(1);
  }

  const code = await runEngines({
    specName: SPEC,
    args: args,
    run: async function (env) {
      for (const name of names) {
        try {
          await SCENARIOS[name](env);
        } catch (err) {
          env.reporter.fail(name, '场景执行异常',
            (err && err.message ? err.message : String(err)));
        }
      }
    }
  });
  try { serverHandle.server.close(); } catch (e) { /* 忽略 */ }
  serverHandle = null;
  process.exit(code);
})().catch(function (err) {
  console.error('FATAL ' + (err && err.stack ? err.stack : err));
  if (serverHandle) { try { serverHandle.server.close(); } catch (e) { /* 忽略 */ } }
  process.exit(2);
});
