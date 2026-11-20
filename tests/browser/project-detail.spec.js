#!/usr/bin/env node
'use strict';
/**
 * Batch 9D：项目作品集详情页浏览器专项
 *
 * 覆盖：6 个项目详情 / 列表→详情 / 直接访问 / 刷新 / 前进后退 / 无效 ID 与特殊字符 /
 * 可选字段缺失与存在 / 示例标记 / 外链协议过滤 / 恶意文本转义 / 三档视口 / 深浅色 /
 * 键盘操作 / 知识库收藏待读与历史 / 知识页回跳 / 双标签同步 / 推荐联动 / 快速切换。
 *
 * 用法：node tests/browser/project-detail.spec.js
 * 退出码：0 通过；1 失败；2 环境不可用。
 */
const path = require('path');
const { chromium } = require('playwright');
const { createServer, listen } = require('./helpers/server');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = '/blog';
const CHANNEL = process.env.PW_CHANNEL || 'chrome';

// 真实数据里的 6 个稳定 ID（与 js/projects.js 一致）
const PROJECT_IDS = [
  'arm-visual-grasping', 'digital-twin-line', 'slam-agv',
  'vla-industrial', 'force-assembly', 'defect-inspection'
];

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
    colorScheme: o.colorScheme || 'light'
  });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + PREFIX + '/index.html#/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#searchInput', { state: 'visible', timeout: 30000 });
  return { ctx, page, errors };
}

async function gotoHash(page, hash) {
  await page.evaluate(h => { location.hash = h; }, hash);
  await sleep(120);
}

async function openProject(page, id) {
  await gotoHash(page, '#/project/' + encodeURIComponent(id));
  await page.waitForSelector('.project-detail, .empty-state', { timeout: 20000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-related]');
    return !s || s.getAttribute('data-related-filled') === '1' || s.hidden === true;
  }, null, { timeout: 20000 }).catch(() => { });
  await sleep(150);
}

async function readDetail(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.project-detail');
    if (!root) {
      const empty = document.querySelector('.empty-state');
      return { ok: false, text: empty ? empty.textContent.replace(/\s+/g, ' ').trim() : '' };
    }
    const q = s => root.querySelector(s);
    return {
      ok: true,
      id: root.getAttribute('data-project-id'),
      title: (q('.article-detail-title') || {}).textContent || '',
      badges: Array.from(root.querySelectorAll('.project-detail-badges .project-card-status')).map(x => x.textContent.trim()),
      // 只统计详情头部/横幅的示例标记；推荐卡片里的"示例"属于候选自身的身份，不能算进来
      demoBadges: root.querySelectorAll('.project-detail-badges .project-demo-badge').length
        + root.querySelectorAll('.project-demo-banner .project-demo-badge').length,
      demoBanner: !!q('.project-demo-banner'),
      sectionTitles: Array.from(root.querySelectorAll('.project-section-title')).map(x => x.textContent.trim()),
      kmBar: !!q('.km-actions'),
      externalLinks: Array.from(root.querySelectorAll('.project-ext-link')).map(a => a.getAttribute('href')),
      badHrefs: Array.from(root.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).filter(h => /^\s*javascript:/i.test(h)),
      relatedCount: root.querySelectorAll('.related-reading-item').length,
      relatedTitles: Array.from(root.querySelectorAll('.related-card-title')).map(a => a.textContent.trim()),
      relatedReasons: Array.from(root.querySelectorAll('.related-reason')).map(a => a.textContent.trim()),
      html: root.innerHTML
    };
  });
}

// 注入一个"字段齐全"的合成项目（验证可选区块渲染，不污染真实数据文件）
async function injectFixtureProject(page) {
  await page.evaluate(() => {
    PROJECTS.push({
      id: 'zz-fixture-project',
      example: false,
      name: '合成夹具项目',
      description: '用于验证可选字段渲染的夹具项目。',
      tech: ['ROS2', 'Python'],
      tags: ['机械臂'],
      icon: '🧪',
      link: 'https://example.com/project',
      repository: 'https://example.com/repo',
      status: '已完成',
      year: '2026',
      highlights: ['夹具亮点一'],
      background: '夹具背景说明。',
      objectives: ['目标一', '目标二'],
      architecture: '夹具架构说明。',
      approach: ['做法一'],
      timeline: [{ time: '2026 Q1', text: '启动' }],
      results: ['夹具结果一'],
      limitations: ['夹具限制一'],
      references: [{ label: '参考资料', url: 'https://example.com/ref' }],
      relatedKeys: ['post:rl-from-mdp-to-ppo'],
      visibility: 'public'
    });
  });
}

(async function main() {
  const server = createServer(ROOT, PREFIX);
  const port = await listen(server.server, 0);
  const base = 'http://127.0.0.1:' + port;
  let browser;
  try {
    browser = await chromium.launch(Object.assign({ headless: true }, CHANNEL !== 'chromium' ? { channel: CHANNEL } : {}));
  } catch (e) {
    console.error('无法启动浏览器（' + CHANNEL + '）：' + String(e.message).split('\n')[0]);
    server.server.close();
    process.exit(2);
  }
  console.log('浏览器: ' + CHANNEL + ' ' + browser.version());

  try {
    // P1 六个项目详情都能打开
    const s1 = await newSession(browser, base);
    const p1 = s1.page;
    const seen = [];
    for (const id of PROJECT_IDS) {
      await openProject(p1, id);
      const d = await readDetail(p1);
      seen.push({ id: id, ok: d.ok && d.id === id, title: d.title, sections: d.sectionTitles.length });
    }
    check('P1 6 个项目详情全部可打开且标题非空',
      seen.length === 6 && seen.every(x => x.ok && x.title.length > 2),
      seen.map(x => x.id + ':' + (x.ok ? 'ok' : 'FAIL')).join(' '));

    // P2 列表 → 详情
    await gotoHash(p1, '#/projects');
    await p1.waitForSelector('.project-card', { timeout: 20000 });
    const cardCount = await p1.locator('.project-card').count();
    const listDemo = await p1.evaluate(() => ({
      badges: document.querySelectorAll('.project-card .project-demo-badge').length,
      notice: !!document.querySelector('.project-demo-notice'),
      links: document.querySelectorAll('.project-card-link').length,
      kmButtons: document.querySelectorAll('.project-card [data-km-toggle]').length
    }));
    check('P2.1 列表保留原有 6 张卡片', cardCount === 6, 'cards=' + cardCount);
    check('P2.2 每张卡片都有示例标记与详情入口',
      listDemo.badges === 6 && listDemo.links === 6 && listDemo.notice === true, JSON.stringify(listDemo));
    check('P2.3 列表卡片带收藏/待读（复用知识管理按钮）', listDemo.kmButtons === 12, 'btns=' + listDemo.kmButtons);

    await p1.locator('.project-card-link').first().click();
    await p1.waitForSelector('.project-detail', { timeout: 20000 });
    const afterClick = await p1.evaluate(() => ({ hash: location.hash, id: document.querySelector('.project-detail').getAttribute('data-project-id') }));
    check('P2.4 点击"查看详情"进入对应项目',
      afterClick.hash === '#/project/' + PROJECT_IDS[0] && afterClick.id === PROJECT_IDS[0], JSON.stringify(afterClick));

    // P2.5 点收藏不触发卡片跳转（回列表点卡片上的收藏）
    await gotoHash(p1, '#/projects');
    await p1.waitForSelector('.project-card', { timeout: 20000 });
    const beforeNav = await p1.evaluate(() => location.hash);
    await p1.locator('.project-card [data-km-toggle="fav"]').first().click();
    await sleep(350);
    const afterFav = await p1.evaluate(() => location.hash);
    const favPressed = await p1.locator('.project-card [data-km-toggle="fav"]').first().getAttribute('aria-pressed');
    check('P2.5 卡片收藏按钮不触发跳转且状态同步',
      beforeNav === afterFav && favPressed === 'true', beforeNav + ' / ' + afterFav + ' / ' + favPressed);

    // P3 直接访问 + 刷新 + 前进后退
    const s2 = await newSession(browser, base);
    const p2 = s2.page;
    await p2.goto(base + PREFIX + '/index.html#/project/' + PROJECT_IDS[1], { waitUntil: 'load', timeout: 60000 });
    await p2.waitForSelector('.project-detail', { timeout: 20000 });
    const direct = await readDetail(p2);
    check('P3.1 直接访问项目详情可用', direct.ok && direct.id === PROJECT_IDS[1], direct.id);

    await p2.reload({ waitUntil: 'load' });
    await p2.waitForSelector('.project-detail', { timeout: 20000 });
    const reloaded = await readDetail(p2);
    check('P3.2 刷新后仍是同一个项目', reloaded.ok && reloaded.id === PROJECT_IDS[1], reloaded.id);

    await gotoHash(p2, '#/project/' + PROJECT_IDS[2]);
    await p2.waitForSelector('.project-detail', { timeout: 20000 });
    await p2.goBack();
    await p2.waitForSelector('.project-detail', { timeout: 20000 });
    const backId = await p2.evaluate(() => document.querySelector('.project-detail').getAttribute('data-project-id'));
    await p2.goForward();
    await p2.waitForSelector('.project-detail', { timeout: 20000 });
    const fwdId = await p2.evaluate(() => document.querySelector('.project-detail').getAttribute('data-project-id'));
    check('P3.3 浏览器前进/后退落到正确项目', backId === PROJECT_IDS[1] && fwdId === PROJECT_IDS[2], backId + ' -> ' + fwdId);

    // P3.4 导航 active 状态 + 文档标题
    const navState = await p2.evaluate(() => {
      const active = document.querySelector('nav a.active');
      return { active: active ? active.getAttribute('href') : '', title: document.title };
    });
    check('P3.4 项目详情时导航高亮"项目"且标题正确',
      navState.active === '#/projects' && navState.title.indexOf('AGV') !== -1 &&
      navState.title.indexOf('示例项目') !== -1,
      JSON.stringify(navState));

    // P4 无效 ID / 特殊字符
    await gotoHash(p2, '#/project/not-a-real-project');
    await p2.waitForSelector('.empty-state', { timeout: 20000 });
    const missing = await readDetail(p2);
    check('P4.1 无效 ID 显示友好提示并可返回列表',
      missing.ok === false && /没有找到这个项目/.test(missing.text), missing.text.slice(0, 60));

    await gotoHash(p2, '#/project/%E4%B8%8D%E5%AD%98%E5%9C%A8-%EF%BC%88x%EF%BC%89');
    await p2.waitForSelector('.empty-state', { timeout: 20000 });
    const missing2 = await readDetail(p2);
    check('P4.2 特殊字符/URL 编码 ID 不抛错', missing2.ok === false, missing2.text.slice(0, 40));

    await gotoHash(p2, '#/project/%E0%A4%A');
    await sleep(300);
    const broken = await p2.evaluate(() => ({
      text: (document.getElementById('app').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      crashed: /页面渲染出错/.test(document.getElementById('app').textContent || '')
    }));
    check('P4.3 非法编码退化为未找到而不是渲染异常', broken.crashed === false && broken.text.length > 0, broken.text);
    check('P4.4 以上流程无未捕获异常', s2.errors.length === 0, s2.errors.slice(0, 2).join(' | ') || 'none');

    // P5 可选字段缺失 → 区块隐藏
    await openProject(p2, PROJECT_IDS[0]);
    const bare = await readDetail(p2);
    check('P5.1 缺少可选字段时不渲染对应区块',
      bare.sectionTitles.indexOf('项目背景') === -1 &&
      bare.sectionTitles.indexOf('时间线') === -1 &&
      bare.sectionTitles.indexOf('结果与指标') === -1 &&
      bare.sectionTitles.indexOf('已知限制') === -1, bare.sectionTitles.join(' | '));
    check('P5.2 有数据的基础区块仍然渲染',
      bare.sectionTitles.indexOf('技术栈') !== -1 && bare.sectionTitles.indexOf('技术方向') !== -1,
      bare.sectionTitles.join(' | '));
    check('P5.3 示例项目有标记 + 横幅 + 指标口径说明',
      bare.demoBadges >= 1 && bare.demoBanner === true &&
      bare.sectionTitles.some(t => t.indexOf('示例文案') !== -1), bare.sectionTitles.join(' | '));

    // P6 可选字段齐全 → 区块渲染 + 外链协议校验
    await injectFixtureProject(p2);
    await openProject(p2, 'zz-fixture-project');
    const rich = await readDetail(p2);
    check('P6.1 可选字段齐全时按序渲染全部区块',
      ['项目背景', '目标', '技术方案', '关键做法', '时间线', '结果与指标', '已知限制', '参考']
        .every(t => rich.sectionTitles.indexOf(t) !== -1), rich.sectionTitles.join(' | '));
    check('P6.2 非示例项目不显示示例标记',
      rich.demoBadges === 0 && rich.demoBanner === false, 'badges=' + rich.demoBadges);
    check('P6.3 合法 http(s) 外链渲染为按钮',
      rich.externalLinks.length === 2 && rich.externalLinks.every(h => /^https?:\/\//.test(h)),
      rich.externalLinks.join(' | '));

    // 危险协议必须被过滤
    await p2.evaluate(() => {
      PROJECTS.push({
        id: 'zz-danger-project', example: true, name: '危险链接项目', description: '协议过滤夹具。',
        tech: [], tags: [], icon: '⚠️', link: 'javascript:alert(1)', repository: 'data:text/html,<script>1</script>',
        status: '进行中', year: '2026', highlights: [],
        references: [{ label: '坏链', url: 'javascript:alert(2)' }],
        visibility: 'public'
      });
    });
    await openProject(p2, 'zz-danger-project');
    const danger = await readDetail(p2);
    check('P6.4 javascript:/data: 链接不生成按钮也不进 href',
      danger.externalLinks.length === 0 && danger.badHrefs.length === 0,
      danger.externalLinks.join(' | ') + ' / bad=' + danger.badHrefs.length);

    // P7 恶意文本安全渲染
    await p2.evaluate(() => {
      PROJECTS.push({
        id: 'zz-xss-project', example: true,
        name: '<img src=x onerror=window.__pwned=1>',
        description: '"><script>window.__pwned2=1</script>',
        tech: ['<b>x</b>'], tags: ['<i>y</i>'], icon: '<svg onload=window.__pwned3=1>',
        link: '', repository: '', status: '已完成', year: '2026',
        highlights: ['<script>window.__pwned4=1</script>'],
        background: '<img src=x onerror=window.__pwned5=1>'
      });
    });
    await openProject(p2, 'zz-xss-project');
    const xss = await p2.evaluate(() => ({
      pwned: [1, 2, 3, 4, 5].map(i => !!window['__pwned' + (i === 1 ? '' : i)]),
      imgs: document.querySelectorAll('.project-detail img').length,
      scripts: document.querySelectorAll('.project-detail script').length,
      text: (document.querySelector('.article-detail-title') || {}).textContent || ''
    }));
    check('P7.1 恶意标题/字段被转义且不执行',
      xss.pwned.every(v => v === false) && xss.imgs === 0 && xss.scripts === 0 &&
      xss.text.indexOf('<img') !== -1, JSON.stringify(xss));

    // P8 键盘可操作
    await gotoHash(p2, '#/projects');
    await p2.waitForSelector('.project-card', { timeout: 20000 });
    await p2.evaluate(() => document.querySelectorAll('.project-card')[1].focus());
    await p2.keyboard.press('Enter');
    await sleep(400);
    const kbHash = await p2.evaluate(() => location.hash);
    check('P8.1 焦点在卡片上按 Enter 可进入详情',
      kbHash === '#/project/' + PROJECT_IDS[1], kbHash);

    // P9 三档视口无横向溢出
    const widths = [];
    for (const w of [390, 768, 1440]) {
      await p2.setViewportSize({ width: w, height: 900 });
      await openProject(p2, PROJECT_IDS[3]);
      const r = await p2.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bars: document.querySelectorAll('.project-section-title').length
      }));
      widths.push({ w: w, overflow: r.overflow, bars: r.bars });
    }
    check('P9 手机/平板/桌面均无横向溢出',
      widths.every(x => x.overflow <= 1 && x.bars >= 2), JSON.stringify(widths));

    // P10 深色主题
    const s3 = await newSession(browser, base, { colorScheme: 'dark' });
    const p3 = s3.page;
    await openProject(p3, PROJECT_IDS[4]);
    const dark = await p3.evaluate(() => {
      const el = document.querySelector('.project-detail-body');
      const title = document.querySelector('.project-section-title');
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        color: title ? getComputedStyle(title).color : ''
      };
    });
    check('P10 深色主题下项目详情可读',
      dark.theme === 'dark' && dark.color && dark.color !== dark.bg, JSON.stringify(dark));
    await s3.ctx.close();

    // P11 知识库联动：收藏/待读 + 历史 + 回跳 + 刷新保留
    await openProject(p2, PROJECT_IDS[2]);
    const detail = await readDetail(p2);
    check('P11.1 详情页有收藏/待读操作条', detail.kmBar === true);
    const favBtn = p2.locator('.project-detail .km-actions [data-km-toggle="fav"]').first();
    const laterBtn = p2.locator('.project-detail .km-actions [data-km-toggle="later"]').first();
    await favBtn.click();
    await sleep(250);
    await laterBtn.click();
    await sleep(300);
    const pressed = await p2.evaluate(() => ({
      fav: document.querySelector('.project-detail [data-km-toggle="fav"]').getAttribute('aria-pressed'),
      later: document.querySelector('.project-detail [data-km-toggle="later"]').getAttribute('aria-pressed'),
      hash: location.hash
    }));
    check('P11.2 收藏与待读可切换且不导航',
      pressed.fav === 'true' && pressed.later === 'true' && pressed.hash === '#/project/' + PROJECT_IDS[2],
      JSON.stringify(pressed));

    await p2.reload({ waitUntil: 'load' });
    await p2.waitForSelector('.project-detail .km-actions [data-km-toggle="fav"]', { timeout: 20000 });
    await sleep(400);
    const afterReload = await p2.evaluate(() => ({
      fav: document.querySelector('.project-detail [data-km-toggle="fav"]').getAttribute('aria-pressed'),
      later: document.querySelector('.project-detail [data-km-toggle="later"]').getAttribute('aria-pressed')
    }));
    check('P11.3 刷新后收藏/待读状态保留',
      afterReload.fav === 'true' && afterReload.later === 'true', JSON.stringify(afterReload));

    await gotoHash(p2, '#/knowledge?tab=favorites');
    await p2.waitForSelector('#kmList', { timeout: 20000 });
    await sleep(600);
    const favRow = await p2.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.km-item'));
      const row = rows.find(r => (r.textContent || '').indexOf('AGV') !== -1);
      const link = row ? row.querySelector('a.km-item-main') : null;
      return {
        count: rows.length,
        label: row ? row.querySelector('.km-item-type').textContent.trim() : '',
        hasLink: !!link,
        href: link ? link.getAttribute('href') : ''
      };
    });
    check('P11.4 知识页把项目显示为"项目"类型且链接指向项目详情',
      favRow.count >= 1 && favRow.label === '项目' && favRow.href === '#/project/' + PROJECT_IDS[2],
      JSON.stringify(favRow));

    if (favRow.hasLink) {
      await p2.locator('#kmList .km-item a.km-item-main').first().click();
      await p2.waitForSelector('.project-detail', { timeout: 20000 });
      const backHash = await p2.evaluate(() => location.hash);
      check('P11.5 从知识页可跳回同一项目详情', backHash === '#/project/' + PROJECT_IDS[2], backHash);
    } else {
      check('P11.5 从知识页可跳回同一项目详情', false, 'row 无 data-href');
    }

    // P11.6 历史记录里也应有该项目
    await gotoHash(p2, '#/knowledge?tab=history');
    await p2.waitForSelector('#kmList', { timeout: 20000 });
    await sleep(500);
    const histHasProject = await p2.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.km-item'));
      return rows.some(r => (r.textContent || '').indexOf('AGV') !== -1);
    });
    check('P11.6 访问后写入浏览历史', histHasProject === true);

    // P11.7 双标签同步
    const B = await s2.ctx.newPage();
    await B.goto(base + PREFIX + '/index.html#/knowledge?tab=favorites', { waitUntil: 'load', timeout: 60000 });
    await B.waitForSelector('#kmList', { timeout: 20000 });
    await sleep(700);
    const bBefore = await B.locator('.km-item').count();
    await p2.evaluate(() => { location.hash = '#/project/' + 'force-assembly'; });
    await p2.waitForSelector('.project-detail', { timeout: 20000 });
    await p2.locator('.project-detail .km-actions [data-km-toggle="fav"]').first().click();
    let synced = false;
    try {
      await B.waitForFunction(n => document.querySelectorAll('.km-item').length > n, bBefore, { timeout: 5000 });
      synced = true;
    } catch (e) { synced = false; }
    check('P11.7 两个标签页的收藏同步', synced === true, 'before=' + bBefore + ' synced=' + synced);
    await B.close();
    check('P11.8 知识联动流程无未捕获异常', s2.errors.length === 0, s2.errors.slice(0, 2).join(' | ') || 'none');

    // P12 推荐联动
    await openProject(p2, 'arm-visual-grasping');
    const rec = await readDetail(p2);
    check('P12.1 项目详情页显示相关阅读',
      rec.relatedCount >= 1 && rec.relatedCount <= 5, 'count=' + rec.relatedCount);
    check('P12.2 每条推荐都有理由且不含自身',
      rec.relatedReasons.length === rec.relatedCount &&
      rec.relatedReasons.every(r => !!r) &&
      rec.relatedTitles.indexOf('六轴机械臂视觉抓取系统') === -1,
      rec.relatedReasons.join(' | ').slice(0, 100));

    const firstHref = await p2.evaluate(() => {
      const a = document.querySelector('.related-reading-item .related-card-title');
      return a ? a.getAttribute('href') : '';
    });
    if (firstHref) {
      await p2.locator('.related-reading-item .related-card-title').first().click();
      await p2.waitForFunction(h => location.hash === h, firstHref, { timeout: 20000 });
      check('P12.3 推荐卡片跨类型跳转正确',
        (await p2.evaluate(() => location.hash)) === firstHref, firstHref);
    } else {
      check('P12.3 推荐卡片跨类型跳转正确', false, 'no related link');
    }

    // P12.4 文章页可以推荐项目，且带示例标记
    await gotoHash(p2, '#/post/arm-trajectory-planning');
    await p2.waitForSelector('.article-detail-body', { timeout: 20000 });
    await p2.waitForFunction(() => {
      const s = document.querySelector('[data-related]');
      return !!s && (s.getAttribute('data-related-filled') === '1' || s.hidden === true);
    }, null, { timeout: 20000 });
    const postRelated = await p2.evaluate(() => {
      const box = document.querySelector('[data-related]');
      const items = Array.from(box ? box.querySelectorAll('.related-reading-item') : []);
      return {
        count: items.length,
        projectItems: items.filter(li => /项目/.test((li.querySelector('.related-type') || {}).textContent || '')).length,
        demoOnProject: items.filter(li => /项目/.test((li.querySelector('.related-type') || {}).textContent || ''))
          .map(li => li.querySelectorAll('.project-demo-badge').length)
      };
    });
    check('P12.4 文章页不会强行把项目排到首位（示例身份可辨）',
      postRelated.projectItems === 0 || postRelated.demoOnProject.every(n => n >= 1),
      JSON.stringify(postRelated));

    // P12.5 快速切换：项目 → 文章 → 项目，推荐不串台
    await gotoHash(p2, '#/project/digital-twin-line');
    await gotoHash(p2, '#/post/slam-overview-filtering-to-graph');
    await openProject(p2, 'digital-twin-line');
    const afterFast = await p2.evaluate(() => {
      const s = document.querySelector('[data-related]');
      return {
        source: s ? s.getAttribute('data-related') : '',
        html: s ? s.innerHTML : ''
      };
    });
    check('P12.5 快速切换后推荐挂载点属于当前项目且不残留旧内容',
      afterFast.source === 'project:digital-twin-line' &&
      afterFast.html.indexOf('SLAM技术全景') === -1, afterFast.source);

    check('P12.6 项目流程全程无未处理运行时异常', s1.errors.length === 0, s1.errors.slice(0, 2).join(' | ') || 'none');
    await s2.ctx.close();

    // P13 离线打开项目详情（SW 已缓存 shell + projects.js 属首屏资源）
    const s4 = await newSession(browser, base, { sw: true });
    const p4 = s4.page;
    let swReady = false;
    try {
      await p4.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 25000 });
      swReady = true;
    } catch (e) { swReady = false; }
    await openProject(p4, 'defect-inspection');
    await sleep(600);
    await s4.ctx.setOffline(true);
    let offlineOk = false;
    try {
      await p4.goto(base + PREFIX + '/index.html#/project/defect-inspection', { waitUntil: 'load', timeout: 30000 });
      await p4.waitForSelector('.project-detail', { timeout: 20000 });
      offlineOk = true;
    } catch (e) { offlineOk = false; }
    const offlineDetail = offlineOk ? await readDetail(p4) : { ok: false };
    check('P13 离线仍能打开项目详情', swReady && offlineOk && offlineDetail.ok === true,
      JSON.stringify({ swReady: swReady, offlineOk: offlineOk }));
    await s4.ctx.setOffline(false);
    await s4.ctx.close();

    await s1.ctx.close();
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
