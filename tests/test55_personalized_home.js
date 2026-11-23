#!/usr/bin/env node
'use strict';
/**
 * Batch 9F：个性化首页专项（jsdom，无真实浏览器）
 *
 * 覆盖：无个人记录、模块组合与顺序、偏好读写/损坏/不可用、模块隐藏与恢复、
 * 失效内容、读取失败降级、搜索与个人模块交替、首页文章列表不受影响。
 *
 * 用法：node tests/test55_personalized_home.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PREFS_KEY = 'blog.home.prefs.v1';
let PORT = Number(process.env.TEST_PORT || 0);
let BASE = '';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 4000)) {
    if (fn()) return true;
    await wait(step || 40);
  }
  return false;
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

async function newPage() {
  const errors = [];
  const vc = new VirtualConsole();
  const collect = s => {
    if (/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) return;
    if (/Could not parse CSS stylesheet/.test(s)) return;
    errors.push(String(s));
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  const resources = {
    interceptors: [requestInterceptor(async (request) => {
      if (String(request.url).indexOf(BASE) === 0) return undefined;
      return new Response('/* blocked by test55 */', {
        status: 200, headers: { 'Content-Type': 'application/javascript' }
      });
    })]
  };
  const dom = await JSDOM.fromURL(BASE + '/index.html#/', {
    runScripts: 'dangerously', resources: resources, pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  const win = dom.window;
  await waitFor(() => win.document.querySelectorAll('#app .article-card').length > 0, 8000);
  await waitFor(() => win.Knowledge && win.Knowledge.status().ready, 8000);
  await wait(200);
  return { dom, win, doc: win.document, errors };
}

function homeState(doc) {
  const host = doc.getElementById('homePersonal');
  return host ? host.getAttribute('data-home-state') : null;
}

async function seedPersonal(win) {
  await win.eval(`(async () => {
    await Knowledge.recordView('post', 'vla-model-intro', { title: 'VLA模型入门：从RT-1到OpenVLA' });
    await Knowledge.recordView('post', 'rl-from-mdp-to-ppo', { title: '强化学习入门：从MDP到PPO' });
    await Knowledge.recordView('post', 'slam-overview-filtering-to-graph', { title: 'SLAM技术全景：从滤波到图优化' });
    await Knowledge.saveProgress('post', 'vla-model-intro', 0.42);
    await Knowledge.setFlag('post', 'rl-from-mdp-to-ppo', 'fav', true);
    await Knowledge.setFlag('course', '本科课程|机器人与自动化-(CS422)', 'later', true);
    await Knowledge.setReadState('post', 'slam-overview-filtering-to-graph', 'done');
  })()`);
  await wait(120);
  win.eval('homeRefreshPersonal()');
  await waitFor(() => homeState(win.document) === 'ready', 8000);
  // 方向是第二阶段（空闲时）加载，等它落定再断言，避免把 pending 当结果
  await waitFor(() => {
    const block = win.document.querySelector('[data-home-block="directions"]');
    if (!block) return false;
    return block.querySelectorAll('.hp-dir').length > 0 ||
      /没有可以归纳|暂时不可用/.test(block.textContent || '');
  }, 8000);
}

(async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = 'http://127.0.0.1:' + PORT;

  let ctx = null;
  try {
    ctx = await newPage();
    const win = ctx.win;
    const doc = ctx.doc;

    // ---------------------------------------------------------------- P1 无个人记录
    check('P1.1 首页存在个人模块容器且设置入口可用',
      !!doc.getElementById('homePersonal') && !!doc.getElementById('homePrefsBtn'),
      homeState(doc));
    await waitFor(() => homeState(doc) !== 'loading', 6000);
    check('P1.2 无个人记录时不渲染任何模块（首页保持原样）',
      homeState(doc) === 'empty' && doc.querySelectorAll('#homePersonal [data-home-block]').length === 0,
      homeState(doc));
    const homeCards = doc.querySelectorAll('#app .article-card').length;
    const postsCount = win.eval('getAllPosts().length');
    check('P1.3 文章列表完整且数量与数据源一致', homeCards === postsCount && homeCards > 0,
      homeCards + '/' + postsCount);
    check('P1.4 原有首页标题与篇数仍在',
      /共 \d+ 篇/.test(doc.querySelector('.home-meta').textContent) &&
      doc.querySelector('.home-head .page-title').textContent.trim() === '文章');
    check('P1.5 搜索框仍可用', !!doc.getElementById('searchInput'));

    // ---------------------------------------------------------------- P2 偏好纯逻辑
    const norm = win.eval(`(function () {
      return {
        empty: homeNormalizePrefs(null),
        wrongVersion: homeNormalizePrefs({ v: 2, hidden: ['recent'] }),
        unknownKeys: homeNormalizePrefs({ v: 1, hidden: ['nope', 'recent', 'recent'], order: ['x', 'favorites'] }),
        allHidden: homeNormalizePrefs({ v: 1, hidden: ['continue','recent','favorites','directions'], order: [] })
      };
    })()`);
    check('P2.1 空/异常输入回退默认偏好',
      JSON.stringify(norm.empty.order) === JSON.stringify(['continue', 'recent', 'favorites', 'directions']) &&
      norm.empty.hidden.length === 0 && norm.wrongVersion.v === 1 && norm.wrongVersion.hidden.length === 0,
      JSON.stringify(norm.wrongVersion));
    check('P2.2 未知键被丢弃、缺失键补齐、隐藏去重',
      norm.unknownKeys.hidden.length === 1 && norm.unknownKeys.hidden[0] === 'recent' &&
      JSON.stringify(norm.unknownKeys.order) === JSON.stringify(['favorites', 'continue', 'recent', 'directions']),
      JSON.stringify(norm.unknownKeys));
    check('P2.3 允许全部隐藏但顺序仍然完整', norm.allHidden.hidden.length === 4 && norm.allHidden.order.length === 4);

    const roundTrip = win.eval(`(function () {
      homeWritePrefs({ v: 1, hidden: ['favorites'], order: ['recent','continue','directions','favorites'] });
      var stored = localStorage.getItem('${PREFS_KEY}');
      var read = homeReadPrefs();
      return { stored: stored, read: read };
    })()`);
    check('P2.4 偏好写入独立键并可读回',
      !!roundTrip.stored && roundTrip.read.hidden[0] === 'favorites' && roundTrip.read.order[0] === 'recent',
      String(roundTrip.stored).slice(0, 60));
    check('P2.5 偏好键与主题/搜索历史隔离',
      win.eval('String(localStorage.getItem("theme"))') === 'null' ||
      win.eval('localStorage.getItem("theme")') !== roundTrip.stored);

    win.eval('homeResetPrefs()');                 // 清掉会话内缓存，确保读的是存储里的坏数据
    win.eval(`localStorage.setItem('${PREFS_KEY}', '{broken json')`);
    check('P2.6 损坏的偏好数据安全回退默认',
      win.eval('homeReadPrefs().hidden.length') === 0 &&
      win.eval('homeReadPrefs().order[0]') === 'continue');
    win.eval('homeResetPrefs()');
    check('P2.7 恢复默认会清除存储键', win.eval(`localStorage.getItem('${PREFS_KEY}')`) === null);

    const storageBroken = win.eval(`(function () {
      var raw = window.localStorage;
      var ok = { get: raw.getItem, set: raw.setItem, remove: raw.removeItem };
      try {
        Object.defineProperty(raw, 'getItem', { configurable: true, value: function () { throw new Error('blocked'); } });
        Object.defineProperty(raw, 'setItem', { configurable: true, value: function () { throw new Error('blocked'); } });
      } catch (e) { return { skipped: true }; }
      var defaults = homeReadPrefs();
      var wrote = homeWritePrefs({ v: 1, hidden: ['recent'], order: ['continue','recent','favorites','directions'] });
      var after = homeReadPrefs();
      Object.defineProperty(raw, 'getItem', { configurable: true, value: ok.get });
      Object.defineProperty(raw, 'setItem', { configurable: true, value: ok.set });
      homeResetPrefs();
      return { defaults: defaults, wrote: wrote, after: after };
    })()`);
    check('P2.8 localStorage 不可用时使用默认值且不抛错',
      storageBroken.skipped ? true : (storageBroken.defaults.hidden.length === 0 && storageBroken.wrote.hidden[0] === 'recent'),
      JSON.stringify(storageBroken.skipped ? 'skipped' : storageBroken.wrote));

    // ---------------------------------------------------------------- P3 模块组合
    await seedPersonal(win);
    const blocks = Array.from(doc.querySelectorAll('#homePersonal [data-home-block]'))
      .map(el => el.getAttribute('data-home-block'));
    check('P3.1 默认顺序：继续阅读 → 最近浏览 → 我的收藏 → 最近学习方向',
      JSON.stringify(blocks) === JSON.stringify(['continue', 'recent', 'favorites', 'directions']),
      blocks.join(','));
    const overview = doc.querySelectorAll('#homePersonal .hp-chip').length;
    check('P3.2 顶部个人概览显示收藏/待读/阅读中/已完成', overview === 4, overview);

    const continueRows = doc.querySelectorAll('[data-home-block="continue"] .hp-row').length;
    const resumeBtn = doc.querySelector('[data-home-block="continue"] [data-km-resume]');
    check('P3.3 继续阅读最多 3 条且带恢复按钮', continueRows <= 3 && continueRows >= 1 && !!resumeBtn,
      'rows=' + continueRows);
    check('P3.4 继续阅读按钮指向真实文章进度', resumeBtn &&
      resumeBtn.getAttribute('data-km-resume') === 'post:vla-model-intro', resumeBtn && resumeBtn.getAttribute('data-km-resume'));

    const recentRows = doc.querySelectorAll('[data-home-block="recent"] .hp-row').length;
    const recentMeta = (doc.querySelector('[data-home-block="recent"] .hp-row-meta') || {}).textContent || '';
    check('P3.5 最近浏览最多 6 条且按浏览时间排序', recentRows >= 1 && recentRows <= 6, 'rows=' + recentRows);
    check('P3.6 最近浏览使用 lastSeenAt 的相对时间而不是更新时间', /前|刚刚|\d{4}-\d{2}-\d{2}/.test(recentMeta),
      recentMeta);

    const favRows = doc.querySelectorAll('[data-home-block="favorites"] .hp-row').length;
    const favMore = doc.querySelector('[data-home-block="favorites"] .hp-more');
    check('P3.7 我的收藏最多 4 条并提供查看全部入口',
      favRows >= 1 && favRows <= 4 && favMore && favMore.getAttribute('href') === '#/knowledge?tab=favorites',
      'rows=' + favRows + ' href=' + (favMore && favMore.getAttribute('href')));
    check('P3.8 收藏区显示收藏总数',
      /共 \d+ 条收藏/.test((doc.querySelector('[data-home-block="favorites"] .hp-block-hint') || {}).textContent || ''));

    const dirRows = doc.querySelectorAll('[data-home-block="directions"] .hp-dir').length;
    const dirNote = (doc.querySelector('[data-home-block="directions"] .hp-note') || {}).textContent || '';
    check('P3.9 最近学习方向有数据时最多 4 项', dirRows >= 1 && dirRows <= 4,
      'rows=' + dirRows + ' text=' + ((doc.querySelector('[data-home-block="directions"]') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 80));
    check('P3.10 方向区说明多归属、计数不可当唯一内容数',
      /可大于唯一内容数/.test(dirNote), dirNote.slice(0, 40));
    const dirHref = doc.querySelector('[data-home-block="directions"] .hp-dir-link');
    check('P3.11 方向入口指向真实存在的标签页或保持静态',
      !dirHref || dirHref.tagName !== 'A' || /^#\/tags\//.test(dirHref.getAttribute('href')),
      dirHref ? dirHref.tagName + ' ' + (dirHref.getAttribute('href') || '') : 'static');
    check('P3.12 方向统计入口指向知识库统计页',
      (doc.querySelector('[data-home-block="directions"] .hp-more') || {}).getAttribute('href') === '#/knowledge?tab=stats');

    // 首页文章列表在个人模块之后仍然完整
    check('P3.13 个人模块渲染后文章列表数量不变',
      doc.querySelectorAll('#app .article-card').length === homeCards, doc.querySelectorAll('#app .article-card').length);

    // ---------------------------------------------------------------- P4 失效内容
    win.eval("Knowledge.setFlag('post', 'b9f-missing-post', 'fav', true, { title: '已删除的合成内容' })");
    await wait(150);
    win.eval('homeRefreshPersonal()');
    await waitFor(() => doc.querySelectorAll('[data-home-block="favorites"] .hp-row').length > 0, 6000);
    const broken = doc.querySelector('[data-home-block="favorites"] .hp-row-broken');
    check('P4.1 失效收藏有明确提示', !!broken && /内容已删除/.test(broken.textContent),
      broken ? broken.textContent.slice(0, 40) : 'none');
    check('P4.2 失效内容不生成任何链接', !!broken && broken.querySelectorAll('a').length === 0);

    // ---------------------------------------------------------------- P5 模块隐藏与顺序
    const btn = doc.getElementById('homePrefsBtn');
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(120);
    const panel = doc.getElementById('homePrefsPanel');
    check('P5.1 设置面板可打开且包含四个模块开关',
      !panel.hidden && panel.querySelectorAll('[data-home-module]').length === 4 &&
      btn.getAttribute('aria-expanded') === 'true', panel.hidden);

    const recentBox = panel.querySelector('[data-home-module="recent"]');
    recentBox.checked = false;
    recentBox.dispatchEvent(new win.Event('change', { bubbles: true }));
    await waitFor(() => !doc.querySelector('[data-home-block="recent"]'), 6000);
    check('P5.2 取消勾选后模块立即隐藏且记录保留',
      !doc.querySelector('[data-home-block="recent"]') &&
      win.eval("Knowledge.list({flag:'history'}).then(function (r) { window.__hist = r.length; })") !== undefined,
      'hidden');
    await wait(150);
    check('P5.3 隐藏模块不删除任何记录', win.eval('window.__hist') >= 1, String(win.eval('window.__hist')));
    check('P5.4 隐藏写入偏好且复选框焦点不丢',
      JSON.parse(win.eval(`localStorage.getItem('${PREFS_KEY}')`)).hidden.indexOf('recent') !== -1,
      win.eval(`localStorage.getItem('${PREFS_KEY}')`));

    const presetBtn = panel.querySelector('[data-home-preset="collection"]');
    presetBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => {
      const first = doc.querySelector('#homePersonal [data-home-block]');
      return first && first.getAttribute('data-home-block') === 'favorites';
    }, 6000);
    const orderAfterPreset = Array.from(doc.querySelectorAll('#homePersonal [data-home-block]'))
      .map(el => el.getAttribute('data-home-block'));
    check('P5.5 预设顺序生效（收藏优先）', orderAfterPreset[0] === 'favorites', orderAfterPreset.join(','));
    check('P5.6 预设按钮 aria-pressed 同步',
      panel.querySelector('[data-home-preset="collection"]').getAttribute('aria-pressed') === 'true' &&
      panel.querySelector('[data-home-preset="default"]').getAttribute('aria-pressed') === 'false');

    const resetBtn = panel.querySelector('[data-home-reset]');
    resetBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => {
      const first = doc.querySelector('#homePersonal [data-home-block]');
      return first && first.getAttribute('data-home-block') === 'continue';
    }, 6000);
    const orderAfterReset = Array.from(doc.querySelectorAll('#homePersonal [data-home-block]'))
      .map(el => el.getAttribute('data-home-block'));
    check('P5.7 恢复默认布局：顺序与显示全部还原',
      JSON.stringify(orderAfterReset) === JSON.stringify(['continue', 'recent', 'favorites', 'directions']) &&
      win.eval(`localStorage.getItem('${PREFS_KEY}')`) === null,
      orderAfterReset.join(','));
    check('P5.8 面板仍打开且焦点保持在当前操作按钮附近',
      !doc.getElementById('homePrefsPanel').hidden);

    // 全部隐藏
    win.eval(`homeWritePrefs({ v: 1, hidden: ['continue','recent','favorites','directions'], order: ['continue','recent','favorites','directions'] })`);
    win.eval('homeRefreshPersonal()');
    await waitFor(() => !!doc.querySelector('#homePersonal .hp-collapsed'), 6000);
    check('P5.9 全部隐藏时给出可恢复提示而不是空白区块',
      !!doc.querySelector('#homePersonal .hp-collapsed') &&
      !!doc.querySelector('#homePersonal [data-home-reset]'));
    win.eval('homeResetPrefs(); homeRefreshPersonal()');
    await waitFor(() => homeState(doc) === 'ready', 6000);

    // ---------------------------------------------------------------- P6 读取失败降级
    const cardsBeforeFail = doc.querySelectorAll('#app .article-card').length;
    win.eval(`(function () {
      window.__origSnapshot = Knowledge.snapshot;
      Knowledge.snapshot = function () { return Promise.reject(new Error('注入读取失败')); };
      homeRefreshPersonal();
    })()`);
    await waitFor(() => homeState(doc) === 'error', 6000);
    check('P6.1 读取失败时显示错误而不是旧数据',
      homeState(doc) === 'error' && doc.querySelectorAll('#homePersonal .hp-block').length === 0,
      homeState(doc));
    check('P6.2 失败时文章列表仍然完整可用',
      doc.querySelectorAll('#app .article-card').length === cardsBeforeFail && cardsBeforeFail > 0,
      doc.querySelectorAll('#app .article-card').length);
    check('P6.3 错误态提供重试入口', !!doc.querySelector('#homePersonal [data-home-retry]'));
    win.eval('Knowledge.snapshot = window.__origSnapshot;');
    doc.querySelector('#homePersonal [data-home-retry]')
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => homeState(doc) === 'ready', 6000);
    check('P6.4 重试后恢复正常渲染', homeState(doc) === 'ready' && doc.querySelectorAll('#homePersonal .hp-block').length >= 3,
      homeState(doc));

    // ---------------------------------------------------------------- P7 搜索兼容
    const input = doc.getElementById('searchInput');
    input.value = '机器人';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await waitFor(() => !!doc.querySelector('#app [data-search-root]'), 8000);
    check('P7.1 输入搜索词后显示搜索结果且不再渲染个人模块',
      !!doc.querySelector('#app [data-search-root]') && !doc.getElementById('homePersonal'),
      'search-root=' + !!doc.querySelector('#app [data-search-root]'));
    input.value = '';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await waitFor(() => !!doc.getElementById('homePersonal'), 8000);
    await waitFor(() => homeState(doc) === 'ready', 8000);
    check('P7.2 清空搜索词后个人模块正确恢复',
      homeState(doc) === 'ready' && doc.querySelectorAll('#homePersonal .hp-block').length >= 3,
      homeState(doc));
    check('P7.3 清空后文章列表与搜索框均恢复',
      doc.querySelectorAll('#app .article-card').length === cardsBeforeFail && !!doc.getElementById('searchInput'),
      doc.querySelectorAll('#app .article-card').length);

    // ---------------------------------------------------------------- P8 路由往返
    win.eval("location.hash = '#/post/vla-model-intro'");
    await waitFor(() => !!doc.querySelector('.article-detail'), 8000);
    const personalOnPost = doc.querySelectorAll('#homePersonal').length;
    win.eval("location.hash = '#/'");
    await waitFor(() => !!doc.getElementById('homePersonal'), 8000);
    await waitFor(() => homeState(doc) === 'ready', 8000);
    check('P8.1 从文章返回首页后个人模块重新挂载',
      personalOnPost === 0 && homeState(doc) === 'ready' &&
      doc.querySelectorAll('#homePersonal .hp-block').length >= 3, homeState(doc));
    check('P8.2 返回首页后文章列表完整',
      doc.querySelectorAll('#app .article-card').length === cardsBeforeFail);

    check('P9 全流程无未捕获异常', ctx.errors.length === 0, ctx.errors.slice(0, 2).join(' | ') || 'none');
    ctx.dom.window.close();
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
  }

  console.log('\n合计 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (failures.length) console.log('失败项：' + failures.join(' / '));
  server.close();
  process.exit(fail ? 1 : 0);
})();
