#!/usr/bin/env node
'use strict';
/**
 * Batch 9B-2：知识图谱 / 反向链接 / WikiLink 真实浏览器验收
 *
 * 覆盖：图谱加载与真实数据一致、节点选择与关系来源、类型/关系筛选、中文搜索定位、
 * 一跳局部、缩放/平移/重置、键盘列表等价视图、390px 触摸布局、深色主题、
 * WikiLink 渲染（隔离 fixture：HTTP 层注入，不改仓库正式文章）、未解析状态、
 * 编辑器预览一致、反向链接区（fixture 索引）与相关阅读分离、索引/脚本缺失降级、
 * 离线（真实 SW 缓存）、快速路由切换清理、首页首屏零新增请求、三引擎代表性场景。
 *
 * 用法：node tests/browser/graph-experience.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const fs = require('fs');
const { chromium, firefox, webkit } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';
const REAL_INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'content-links.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newSession(browser, base, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1440, height: 900 },
    serviceWorkers: o.sw ? 'allow' : 'block',
    colorScheme: o.colorScheme || 'light',
    hasTouch: !!o.hasTouch
  });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + PREFIX + '/index.html#' + (o.route || '/graph'), { waitUntil: 'load', timeout: 60000 });
  if ((o.route || '/graph') === '/graph' && !o.noWait) await waitGraph(page);
  return { ctx, page, errors };
}
async function waitGraph(page, timeout) {
  await page.waitForSelector('.graph-svg', { state: 'visible', timeout: timeout || 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.graph-node').length > 0, null, { timeout: timeout || 30000 });
}
const clickNode = (page, key) => page.evaluate(k => {
  const g = document.querySelector('.graph-node[data-key="' + k + '"]');
  if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return !!g;
}, key);

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: CHANNEL });
  } catch (e) {
    try { browser = await chromium.launch({ headless: true }); }
    catch (e2) { console.log('环境不可用：' + e2.message); process.exit(2); }
  }
  const server = createServer(ROOT, PREFIX);
  const port = await listen(server.server, 0);
  const base = 'http://127.0.0.1:' + port;

  try {
    // ---------------------------------------------------------------- R1 加载与真实数据
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    const vbInit = await p1.evaluate(() => document.querySelector('.graph-svg').getAttribute('viewBox'));
    const r1 = await p1.evaluate(() => ({
      nodes: document.querySelectorAll('.graph-node').length,
      explicit: document.querySelectorAll('.graph-edge-explicit').length,
      series: document.querySelectorAll('.graph-edge-series').length,
      inferred: document.querySelectorAll('.graph-edge-inferred').length,
      arrows: document.querySelectorAll('.graph-edge-explicit[marker-end]').length,
      stats: document.querySelector('.graph-stats').textContent,
      notice: document.querySelector('.graph-notice').textContent,
      noticeHidden: document.querySelector('.graph-notice').hidden,
      perf: window.__graphPerf
    }));
    const st = REAL_INDEX.stats;
    check('R1.1 节点数与真实索引一致（195）', r1.nodes === st.nodes, r1.nodes);
    check('R1.2 显式边=6 且全部带方向箭头', r1.explicit === st.explicitEdges && r1.arrows === r1.explicit, r1.explicit + '/' + r1.arrows);
    check('R1.3 同系列边=4', r1.series === st.seriesEdges, r1.series);
    check('R1.4 统计行如实报告（含孤立 183）', r1.stats.indexOf('节点 ' + st.nodes) !== -1 && r1.stats.indexOf('孤立节点 ' + st.isolated) !== -1, r1.stats);
    check('R1.5 推断边展示层裁剪如实标注（可见≤300，提示含裁剪数与总数）',
      r1.explicit + r1.series + r1.inferred <= 300 && !r1.noticeHidden && /已裁剪/.test(r1.notice) && /依然存在/.test(r1.notice), r1.notice.slice(0, 80));
    check('R1.6 图谱性能埋点存在且布局有限', r1.perf && r1.perf.nodes === st.nodes && r1.perf.layoutMs < 2000, JSON.stringify(r1.perf));
    check('R1.7 加载无运行时异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');

    // ---------------------------------------------------------------- R2 选择与关系来源
    const okClick = await clickNode(p1, 'lib:matlab_backup');
    await sleep(150);
    const r2 = await p1.evaluate(() => ({
      title: document.querySelector('.graph-detail-title') && document.querySelector('.graph-detail-title').textContent,
      rels: Array.from(document.querySelectorAll('.graph-detail-rel')).map(li => li.textContent),
      link: document.querySelector('.graph-detail-link') && document.querySelector('.graph-detail-link').getAttribute('href'),
      hidden: document.querySelector('.graph-detail').hidden
    }));
    check('R2.1 点击节点显示详情（标题/有效跳转）', okClick && !r2.hidden && /matlab/i.test(r2.title || '') && r2.link === '#/codelib/matlab_backup', JSON.stringify(r2).slice(0, 140));
    check('R2.2 反向显式引用标注方向与来源（← 引用本文 · 正文站内链接）',
      r2.rels.filter(t => /← 引用本文/.test(t) && /正文站内链接/.test(t)).length === 2, r2.rels.length);
    await clickNode(p1, 'post:rl-from-mdp-to-ppo');
    await sleep(150);
    const r2c = await p1.evaluate(() => Array.from(document.querySelectorAll('.graph-detail-rel')).map(li => li.textContent));
    check('R2.3 推断关联明确标注非正文引用', r2c.some(t => /算法推荐，非正文引用/.test(t)), r2c.length);
    await clickNode(p1, 'lib:matlab_backup');
    await sleep(150);
    await p1.evaluate(() => { const b = document.querySelector('.graph-rel-btn'); if (b) b.click(); });
    await sleep(150);
    const r2b = await p1.evaluate(() => document.querySelector('.graph-detail-title').textContent);
    check('R2.4 关系列表可跳转到关联节点详情', /机器人学导论|SLAM/.test(r2b), r2b);

    // ---------------------------------------------------------------- R3 筛选与搜索
    await p1.click('.graph-chip[data-type="post"]');
    await sleep(150);
    const f1 = await p1.evaluate(() => document.querySelectorAll('.graph-node').length);
    check('R3.1 类型筛选：仅 post（18）', f1 === 18, f1);
    await p1.click('.graph-chip[data-type="post"]');
    await p1.click('.graph-chip-kind-explicit');
    await sleep(150);
    const f2 = await p1.evaluate(() => ({
      edges: document.querySelectorAll('.graph-edges line').length,
      nonExplicit: document.querySelectorAll('.graph-edge-series, .graph-edge-inferred').length
    }));
    check('R3.2 关系筛选：仅显式边（6）', f2.edges === 6 && f2.nonExplicit === 0, JSON.stringify(f2));
    await p1.click('.graph-chip-kind-explicit');
    await p1.fill('.graph-search-input', 'SLAM');
    await p1.press('.graph-search-input', 'Enter');
    await sleep(200);
    const f3 = await p1.evaluate(() => ({
      title: document.querySelector('.graph-detail-title') && document.querySelector('.graph-detail-title').textContent,
      matches: document.querySelectorAll('.graph-node.match').length
    }));
    check('R3.3 搜索定位：Enter 选中首个命中并高亮', /SLAM/i.test(f3.title || '') && f3.matches > 0, JSON.stringify(f3));
    await p1.fill('.graph-search-input', '机器人');
    await sleep(200);
    const f4 = await p1.evaluate(() => document.querySelectorAll('.graph-node.match').length);
    check('R3.4 中文搜索命中', f4 > 0, f4);
    await p1.fill('.graph-search-input', '');

    // ---------------------------------------------------------------- R4 一跳局部
    await clickNode(p1, 'post:rl-from-mdp-to-ppo');
    await sleep(120);
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.graph-actions button')).find(x => x.textContent === '一跳邻居'); b.click(); });
    await sleep(200);
    const r4 = await p1.evaluate(() => ({
      nodes: document.querySelectorAll('.graph-node').length,
      stats: document.querySelector('.graph-stats').textContent,
      pressed: Array.from(document.querySelectorAll('.graph-actions button')).find(x => x.textContent === '一跳邻居').getAttribute('aria-pressed')
    }));
    check('R4.1 一跳局部视图：节点收缩且如实标注', r4.nodes < 30 && r4.nodes >= 2 && /一跳局部视图/.test(r4.stats) && r4.pressed === 'true', JSON.stringify(r4));
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.graph-actions button')).find(x => x.textContent === '一跳邻居'); b.click(); });

    // ---------------------------------------------------------------- R5 缩放/平移/重置
    const vb0 = await p1.evaluate(() => document.querySelector('.graph-svg').getAttribute('viewBox'));
    const box = await p1.locator('.graph-svg').boundingBox();
    await p1.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p1.mouse.wheel(0, -240);
    await sleep(150);
    const vb1 = await p1.evaluate(() => document.querySelector('.graph-svg').getAttribute('viewBox'));
    check('R5.1 滚轮缩放改变视图', vb1 !== vb0, vb0 + ' → ' + vb1);
    await p1.mouse.move(box.x + 20, box.y + 20);
    await p1.mouse.down();
    await p1.mouse.move(box.x + 120, box.y + 80, { steps: 5 });
    await p1.mouse.up();
    await sleep(200);
    const vb2 = await p1.evaluate(() => document.querySelector('.graph-svg').getAttribute('viewBox'));
    check('R5.2 拖动平移改变视图', vb2 !== vb1, vb2);
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.graph-actions button')).find(x => x.textContent === '重置视图'); b.click(); });
    await sleep(150);
    const vb3 = await p1.evaluate(() => document.querySelector('.graph-svg').getAttribute('viewBox'));
    check('R5.3 重置视图恢复初始', vb3 === vbInit, vb3 + ' vs ' + vbInit);

    // ---------------------------------------------------------------- R6 键盘列表等价视图
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.graph-actions button')).find(x => x.textContent === '列表视图'); b.click(); });
    await sleep(150);
    const r6a = await p1.evaluate(() => ({
      svgHidden: document.querySelector('.graph-svg').style.display === 'none',
      items: document.querySelectorAll('.graph-list-item').length,
      focused: document.activeElement && document.activeElement.classList.contains('graph-list-item')
    }));
    check('R6.1 列表视图：SVG 隐藏、节点全列出、首项获焦', r6a.svgHidden && r6a.items === st.nodes && r6a.focused, JSON.stringify(r6a));
    await p1.keyboard.press('ArrowDown');
    const r6b = await p1.evaluate(() => Array.from(document.querySelectorAll('.graph-list-item')).indexOf(document.activeElement));
    check('R6.2 方向键在列表中移动焦点', r6b === 1, r6b);
    await p1.keyboard.press('Enter');
    await sleep(150);
    const r6c = await p1.evaluate(() => !document.querySelector('.graph-detail').hidden);
    check('R6.3 Enter 选中节点并显示详情（纯键盘可达）', r6c);
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.graph-actions button')).find(x => x.textContent === '列表视图'); b.click(); });
    check('R6.4 键盘操作全程无异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');
    await s1.ctx.close();

    // ---------------------------------------------------------------- R7 390px 触摸
    const s7 = await newSession(browser, base, { viewport: { width: 390, height: 844 }, hasTouch: true });
    const p7 = s7.page;
    const r7 = await p7.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      chips: document.querySelectorAll('.graph-chip').length,
      svgW: document.querySelector('.graph-svg').getBoundingClientRect().width
    }));
    check('R7.1 390px 无横向溢出且筛选 chips 可用', r7.overflow && r7.chips >= 9 && r7.svgW <= 390, JSON.stringify(r7));
    await p7.locator('.graph-node[data-key="post:rl-from-mdp-to-ppo"]').tap();
    await sleep(200);
    const r7b = await p7.evaluate(() => !document.querySelector('.graph-detail').hidden);
    check('R7.2 触摸点选节点显示详情', r7b);
    check('R7.3 移动端无运行时异常', s7.errors.length === 0, s7.errors.slice(0, 2).join(' | ') || 'none');
    await s7.ctx.close();

    // ---------------------------------------------------------------- R8 深色主题
    const s8 = await newSession(browser, base, { colorScheme: 'dark' });
    const p8 = s8.page;
    await p8.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(150);
    const r8 = await p8.evaluate(() => {
      const dot = document.querySelector('.graph-node-post .graph-dot');
      const bg = document.querySelector('.graph-svg');
      return { fill: getComputedStyle(dot).fill, bg: getComputedStyle(bg).backgroundColor };
    });
    check('R8.1 深色主题下图谱正常渲染（颜色变量生效）', !!r8.fill && r8.fill !== 'rgb(37, 99, 235)' && !!r8.bg, JSON.stringify(r8));
    await s8.ctx.close();

    // ---------------------------------------------------------------- R9 WikiLink 渲染（隔离 fixture）
    const origBody = fs.readFileSync(path.join(ROOT, 'data', 'posts', 'robotics-textbook-notes.md'), 'utf8');
    server.state.overrides['/data/posts/robotics-textbook-notes.md'] = origBody +
      '\n\n## 9B-2 验收夹具（仅测试注入）\n\n' +
      '合法引用 [[post:rl-from-mdp-to-ppo]] 与显示文本 [[post:rl-from-mdp-to-ppo|自定义别名]]。\n\n' +
      '未解析 [[post:zz-nonexistent-target]]。\n\n' +
      '围栏不解析：\n```\n[[post:rl-from-mdp-to-ppo]]\n```\n\n' +
      '行内不解析：`[[post:rl-from-mdp-to-ppo]]`。\n\n' +
      '恶意显示文本 [[post:rl-from-mdp-to-ppo|<img src=x onerror=alert(1)>]]。\n';
    const s9 = await newSession(browser, base, { route: '/post/robotics-textbook-notes' });
    const p9 = s9.page;
    await p9.waitForSelector('.article-detail-body', { timeout: 30000 });
    await p9.waitForSelector('.wikilink', { timeout: 30000 });
    const r9 = await p9.evaluate(() => ({
      links: Array.from(document.querySelectorAll('.article-detail-body .wikilink')).map(a => ({ href: a.getAttribute('href'), text: a.textContent })),
      unresolved: document.querySelectorAll('.article-detail-body .wikilink-unresolved').length,
      unresolvedKey: document.querySelector('.wikilink-unresolved') && document.querySelector('.wikilink-unresolved').getAttribute('data-wikilink-unresolved'),
      injectedImg: document.querySelectorAll('.article-detail-body img[src="x"]').length,
      bodyText: document.querySelector('.article-detail-body').textContent
    }));
    check('R9.1 合法 WikiLink 渲染为真实站内链接（含显示文本）',
      r9.links.length === 3 && r9.links.every(l => l.href === '#/post/rl-from-mdp-to-ppo') &&
      r9.links.some(l => l.text === '自定义别名'), JSON.stringify(r9.links));
    check('R9.2 未解析目标明确标注且不产生链接', r9.unresolved === 1 && r9.unresolvedKey === 'post:zz-nonexistent-target', r9.unresolvedKey);
    check('R9.3 围栏/行内代码中的 WikiLink 保留原文', (r9.bodyText.match(/\[\[post:rl-from-mdp-to-ppo\]\]/g) || []).length >= 2);
    check('R9.4 恶意显示文本被转义（无 HTML 注入）', r9.injectedImg === 0 && /<img src=x/.test(r9.bodyText));
    await p9.evaluate(() => document.querySelector('.article-detail-body .wikilink').click());
    await sleep(400);
    const r9b = await p9.evaluate(() => location.hash);
    check('R9.5 WikiLink 点击跳转到真实目标文章', r9b === '#/post/rl-from-mdp-to-ppo', r9b);
    check('R9.6 WikiLink 场景无运行时异常', s9.errors.length === 0, s9.errors.slice(0, 2).join(' | ') || 'none');
    await s9.ctx.close();
    delete server.state.overrides['/data/posts/robotics-textbook-notes.md'];

    // ---------------------------------------------------------------- R10 编辑器预览一致
    const s10 = await newSession(browser, base, { route: '/editor' });
    const p10 = s10.page;
    await p10.waitForSelector('#editorContent', { timeout: 30000 });
    await p10.fill('#editorContent', '预览 [[post:rl-from-mdp-to-ppo]] 与 [[post:zz-nope]]');
    await p10.waitForSelector('#editorPreview .wikilink', { timeout: 30000 });
    const r10 = await p10.evaluate(() => ({
      link: document.querySelector('#editorPreview .wikilink').getAttribute('href'),
      unresolved: document.querySelectorAll('#editorPreview .wikilink-unresolved').length
    }));
    check('R10.1 编辑器预览与正式文章同一契约（合法链接+未解析状态）',
      r10.link === '#/post/rl-from-mdp-to-ppo' && r10.unresolved === 1, JSON.stringify(r10));
    check('R10.2 预览无运行时异常', s10.errors.length === 0, s10.errors.slice(0, 2).join(' | ') || 'none');
    await s10.ctx.close();

    // ---------------------------------------------------------------- R11 反向链接（fixture 索引）
    const fixtureIndex = JSON.parse(JSON.stringify(REAL_INDEX));
    fixtureIndex.explicit.push({ source: 'post:rl-from-mdp-to-ppo', target: 'post:robotics-textbook-notes', via: 'wikilink' });
    fixtureIndex.byTarget['post:robotics-textbook-notes'] = ['post:rl-from-mdp-to-ppo'];
    fixtureIndex.bySource['post:rl-from-mdp-to-ppo'] = (fixtureIndex.bySource['post:rl-from-mdp-to-ppo'] || []).concat(['post:robotics-textbook-notes']);
    server.state.overrides['/data/content-links.json'] = JSON.stringify(fixtureIndex);
    const s11 = await newSession(browser, base, { route: '/post/robotics-textbook-notes' });
    const p11 = s11.page;
    await p11.waitForSelector('.backlinks:not([hidden])', { timeout: 30000 });
    const r11 = await p11.evaluate(() => ({
      title: document.querySelector('.backlinks-title').textContent,
      items: Array.from(document.querySelectorAll('.backlink-item')).map(li => ({
        text: li.textContent, href: li.querySelector('a').getAttribute('href')
      })),
      separate: !!document.querySelector('.related-reading') && !document.querySelector('.related-reading').contains(document.querySelector('.backlinks'))
    }));
    check('R11.1 反向链接区显示真实显式引用来源（类型+WikiLink 标注）',
      /引用本文的内容/.test(r11.title) && r11.items.length === 1 &&
      /文章 · WikiLink/.test(r11.items[0].text) && r11.items[0].href === '#/post/rl-from-mdp-to-ppo', JSON.stringify(r11.items));
    check('R11.2 与相关阅读区域完全分离', r11.separate);
    await p11.evaluate(() => document.querySelector('.backlink-item a').click());
    await sleep(400);
    check('R11.3 反向链接正确跳转源内容', await p11.evaluate(() => location.hash) === '#/post/rl-from-mdp-to-ppo');
    await s11.ctx.close();
    delete server.state.overrides['/data/content-links.json'];

    // 无反向引用时隐藏（真实数据里文章无入边）
    const s11b = await newSession(browser, base, { route: '/post/rl-from-mdp-to-ppo' });
    await sleep(800);
    const r11b = await s11b.page.evaluate(() => ({
      hidden: document.querySelector('.backlinks').hidden,
      body: !!document.querySelector('.article-detail-body')
    }));
    check('R11.4 无反向引用时合理隐藏且正文不受影响', r11b.hidden && r11b.body);
    await s11b.ctx.close();

    // ---------------------------------------------------------------- R12 降级
    server.state.faults['/data/content-links.json'] = 500;
    const s12 = await newSession(browser, base, { route: '/post/robotics-textbook-notes' });
    await sleep(800);
    const r12 = await s12.page.evaluate(() => ({
      body: !!document.querySelector('.article-detail-body'),
      backlinksHidden: document.querySelector('.backlinks').hidden
    }));
    check('R12.1 索引缺失：正文正常、反向链接局部降级', r12.body && r12.backlinksHidden && s12.errors.length === 0);
    await s12.ctx.close();
    const s12b = await newSession(browser, base, { noWait: true });
    await s12b.page.waitForSelector('.graph-degraded', { timeout: 30000 });
    check('R12.2 索引缺失：图谱明确降级提示', /索引缺失|加载失败/.test(await s12b.page.evaluate(() => document.querySelector('.graph-degraded').textContent)));
    await s12b.ctx.close();
    delete server.state.faults['/data/content-links.json'];
    server.state.faults['/js/graph-demo.js'] = 500;
    const s12c = await newSession(browser, base, { noWait: true });
    await s12c.page.waitForSelector('.graph-degraded', { timeout: 30000 });
    check('R12.3 图谱脚本失败：明确降级且不影响首页', /脚本加载失败/.test(await s12c.page.evaluate(() => document.querySelector('.graph-degraded').textContent)));
    await s12c.page.evaluate(() => { location.hash = '#/'; });
    await s12c.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    check('R12.4 降级后首页文章列表正常', await s12c.page.evaluate(() => document.querySelectorAll('#app .article-card').length) > 5);
    await s12c.ctx.close();
    delete server.state.faults['/js/graph-demo.js'];

    // ---------------------------------------------------------------- R13 离线（真实 SW 缓存）
    const s13 = await newSession(browser, base, { sw: true });
    const p13 = s13.page;
    await p13.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load' });
    await p13.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    await p13.evaluate(() => { location.hash = '#/graph'; });
    await waitGraph(p13);
    await sleep(800);
    const cached = await p13.evaluate(async () => {
      const keys = ['/blog/js/knowledge-graph.js', '/blog/js/graph-demo.js', '/blog/js/content-links.js', '/blog/data/content-links.json'];
      const out = {};
      for (const k of keys) out[k.split('/').pop()] = !!(await caches.match(k));
      return out;
    });
    check('R13.1 图谱脚本与索引进入 SW 缓存（OPTIONAL 预热）', Object.values(cached).every(Boolean), JSON.stringify(cached));
    await s13.ctx.setOffline(true);
    let offlineOk = false, offlineInfo = null;
    try {
      await p13.reload({ waitUntil: 'load', timeout: 30000 });
      await waitGraph(p13, 20000);
      offlineInfo = await p13.evaluate(() => ({ nodes: document.querySelectorAll('.graph-node').length, stats: document.querySelector('.graph-stats').textContent }));
      offlineOk = offlineInfo.nodes === st.nodes;
    } catch (e) { offlineInfo = String(e.message).split('\n')[0]; }
    check('R13.2 离线重载：图谱完整渲染（节点数一致）', offlineOk, JSON.stringify(offlineInfo));
    await s13.ctx.setOffline(false);
    await s13.ctx.close();

    // ---------------------------------------------------------------- R14 快速路由切换与清理
    const s14 = await newSession(browser, base);
    const p14 = s14.page;
    for (const h of ['#/', '#/graph', '#/post/rl-from-mdp-to-ppo', '#/graph', '#/', '#/graph']) {
      await p14.evaluate(hh => { location.hash = hh; }, h);
      await sleep(60);
    }
    await waitGraph(p14);
    const r14 = await p14.evaluate(() => ({
      svgs: document.querySelectorAll('.graph-svg').length,
      roots: document.querySelectorAll('#graphRoot').length
    }));
    check('R14.1 快速切换 6 次：单实例无串页', r14.svgs === 1 && r14.roots === 1, JSON.stringify(r14));
    await p14.evaluate(() => { location.hash = '#/'; });
    await p14.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    await sleep(200);
    const r14b = await p14.evaluate(() => document.querySelectorAll('.graph-svg').length);
    check('R14.2 离开图谱后画布移除（生命周期清理）', r14b === 0, r14b);
    check('R14.3 快速切换全程无运行时异常', s14.errors.length === 0, s14.errors.slice(0, 2).join(' | ') || 'none');
    await s14.ctx.close();

    // ---------------------------------------------------------------- R15 首页首屏零新增请求
    for (const k of Object.keys(server.state.hits)) delete server.state.hits[k];
    const s15 = await newSession(browser, base, { route: '/' });
    await s15.page.waitForSelector('#searchInput', { state: 'visible', timeout: 20000 });
    await sleep(500);
    const hits = server.state.hits;
    const graphReqs = ['/js/knowledge-graph.js', '/js/graph-demo.js', '/js/content-links.js', '/data/content-links.json']
      .filter(k => hits[k]);
    check('R15.1 首页不请求任何图谱/索引资源（首屏零新增）', graphReqs.length === 0, JSON.stringify(graphReqs));
    check('R15.2 首页文章列表正常', await s15.page.evaluate(() => document.querySelectorAll('#app .article-card').length) > 5);
    await s15.ctx.close();

    // ---------------------------------------------------------------- R16 三引擎代表性场景
    for (const eng of [{ name: 'firefox', launcher: firefox }, { name: 'webkit', launcher: webkit }]) {
      let eb = null;
      try { eb = await eng.launcher.launch({ headless: true }); }
      catch (e) { console.log('SKIP ' + eng.name + ' 不可用：' + String(e.message).split('\n')[0]); continue; }
      try {
        const ctx = await eb.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        await ctx.route('**/*', route => {
          const u = route.request().url();
          if (u.startsWith('http://127.0.0.1') || u.startsWith('data:')) return route.continue();
          return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
        });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(e.message));
        await page.goto(base + PREFIX + '/index.html#/graph', { waitUntil: 'load', timeout: 60000 });
        await waitGraph(page);
        await clickNode(page, 'lib:matlab_backup');
        await sleep(250);
        const r = await page.evaluate(() => ({
          nodes: document.querySelectorAll('.graph-node').length,
          detail: !document.querySelector('.graph-detail').hidden,
          overflow: document.documentElement.scrollWidth <= window.innerWidth + 1
        }));
        check('R16.1 ' + eng.name + ' 390px：渲染/选择/无溢出', r.nodes === st.nodes && r.detail && r.overflow, JSON.stringify(r));
        check('R16.2 ' + eng.name + ' 无运行时异常', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
        await ctx.close();
      } catch (e) {
        check('R16.1 ' + eng.name + ' 390px：渲染/选择/无溢出', false, String(e.message).split('\n')[0]);
      } finally { await eb.close(); }
    }
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  await browser.close();
  server.server.close();
  process.exit(fail ? 1 : 0);
})();