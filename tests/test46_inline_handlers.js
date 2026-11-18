// Batch 8E-2：inline 事件处理编码回归（jsdom）
// 覆盖 B8E1-001 / B8E1-002：含单引号等特殊字符的标签 chip 在首页、文章详情、
// 标签列表页、标签页文章列表中都能正确导航并还原原始标签；卡片导航不受影响。
// 使用合成 USER_POSTS 夹具，不修改任何正式文章数据。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
let PORT = Number(process.env.TEST_PORT || 0); // 默认由操作系统分配；TEST_PORT 仅用于显式覆盖
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
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await wait(step || 50);
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

const FIXTURE_TAGS = ['Robotics', '机械臂', 'Computer Vision', "O'Brien", 'He said "hi"', '100% #1 & more?'];
const FIXTURE = {
  id: 'b8e2-inline-fixture',
  title: '标签编码夹具文章',
  date: '2026-11-18',
  tags: FIXTURE_TAGS,
  excerpt: '夹具摘要',
  content: '# 夹具正文\n\n用于验证标签 chip 的 inline 事件编码。'
};

async function newPage() {
  const errors = [];
  const vc = new VirtualConsole();
  const collect = s => {
    if (/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) return;
    if (/Could not parse CSS stylesheet/.test(s)) return;   // jsdom CSS 解析告警，与本用例无关
    errors.push(s);
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  const resources = {
    interceptors: [requestInterceptor(async (request) => {
      if (String(request.url).indexOf(BASE) === 0) return undefined;
      return new Response('/* blocked by test46 */', {
        status: 200, headers: { 'Content-Type': 'application/javascript' }
      });
    })]
  };
  const dom = await JSDOM.fromURL(BASE + '/index.html#/', {
    runScripts: 'dangerously', resources: resources, pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(150);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

function fixtureCard(doc) {
  return Array.prototype.slice.call(doc.querySelectorAll('#app .article-card'))
    .find(card => {
      const h2 = card.querySelector('.article-card-title');
      return h2 && h2.textContent.trim() === FIXTURE.title;
    }) || null;
}

function chipByText(card, tag) {
  if (!card) return null;
  return Array.prototype.slice.call(card.querySelectorAll('.tag'))
    .find(el => el.textContent === tag) || null;
}

async function go(win, hash) {
  win.history.replaceState(null, '', hash);
  win.eval('router()');
  await wait(220);
}

async function clickAndWait(win, el) {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(250);
}

function tagPageState(win, doc, tag) {
  const h = win.location.hash;
  const titleEl = doc.querySelector('#app .page-title');
  return {
    hash: h,
    decoded: h.indexOf('#/tags/') === 0 ? decodeURIComponent(h.slice('#/tags/'.length)) : null,
    title: titleEl ? titleEl.textContent.trim() : '',
    onTagPage: h.indexOf('#/tags/') === 0,
    onPostPage: h.indexOf('#/post/') === 0
  };
}

// 直接编译 inline handler 源码：能通过 new Function 即证明无语法错误
function handlerCompiles(src) {
  if (!src) return false;
  try { new Function('event', 'location', 'document', src); return true; }
  catch (e) { return false; }
}

function allTagHandlersCompile(doc) {
  return Array.prototype.slice.call(doc.querySelectorAll('#app .tag[onclick]'))
    .every(el => handlerCompiles(el.getAttribute('onclick')));
}

(async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = 'http://localhost:' + PORT;

  let dom = null, win = null, doc = null;
  const allErrors = [];
  let failedByException = null;

  try {
    const ctx = await newPage();
    dom = ctx.dom; win = ctx.win; doc = ctx.doc;
    allErrors.push.apply(allErrors, ctx.errors);

    // 注入夹具并提供跳转工具（历史用 replaceState + router，与既有测试一致）
    win.eval('USER_POSTS.push(' + JSON.stringify(FIXTURE) + ');');
    await go(win, '#/');

    // H0：夹具与六个标签 chip 渲染正常
    const homeCard = fixtureCard(doc);
    const homeChips = homeCard ? Array.prototype.slice.call(homeCard.querySelectorAll('.tag')) : [];
    check('T0 首页夹具文章与六个标签 chip', !!homeCard && homeChips.length === FIXTURE_TAGS.length,
      homeChips.length + ' chips');

    // T1-T6：六个标签依次点击（普通英文 / 中文 / 空格 / 单引号 / 双引号 / 百分号与特殊字符）
    const tagCases = [
      ['T1 首页标签导航（普通英文）', 'Robotics'],
      ['T2 首页标签导航（中文）', '机械臂'],
      ['T3 首页标签导航（含空格）', 'Computer Vision'],
      ['T4 首页标签导航（单引号）', "O'Brien"],
      ['T5 首页标签导航（双引号）', 'He said "hi"'],
      ['T6 首页标签导航（百分号与特殊字符）', '100% #1 & more?']
    ];
    for (let i = 0; i < tagCases.length; i++) {
      const name = tagCases[i][0], tag = tagCases[i][1];
      await go(win, '#/');
      const card = fixtureCard(doc);
      const chip = chipByText(card, tag);
      if (!chip) { check(name, false, 'chip not found'); continue; }
      await clickAndWait(win, chip);
      const st = tagPageState(win, doc, tag);
      check(name,
        st.onTagPage && st.decoded === tag && st.title === '标签: ' + tag && !st.onPostPage,
        st.hash + ' | ' + st.title);
    }

    // D1/D2：文章详情页标签 chip
    await go(win, '#/post/' + FIXTURE.id);
    const detailCard = doc.querySelector('#app .article-detail');
    check('T7 文章详情页渲染夹具', !!detailCard);

    let detailChip = chipByText(detailCard, "O'Brien");
    if (detailChip) {
      await clickAndWait(win, detailChip);
      const st = tagPageState(win, doc);
      check('T8 文章详情标签 chip（单引号）',
        st.onTagPage && st.decoded === "O'Brien" && st.title === "标签: O'Brien", st.hash + ' | ' + st.title);
    } else {
      check('T8 文章详情标签 chip（单引号）', false, 'chip not found');
    }

    await go(win, '#/post/' + FIXTURE.id);
    detailChip = chipByText(doc.querySelector('#app .article-detail'), '机械臂');
    if (detailChip) {
      await clickAndWait(win, detailChip);
      const st = tagPageState(win, doc);
      check('T9 文章详情标签 chip（中文对照）',
        st.onTagPage && st.decoded === '机械臂' && st.title === '标签: 机械臂', st.hash + ' | ' + st.title);
    } else {
      check('T9 文章详情标签 chip（中文对照）', false, 'chip not found');
    }

    // L1：标签列表页（/tags）标签云交互（数据属性 + 事件委托路径）
    await go(win, '#/tags');
    const cloud = Array.prototype.slice.call(doc.querySelectorAll('[data-tag-link]'))
      .find(el => el.getAttribute('data-tag-link') === "O'Brien");
    if (cloud) {
      await clickAndWait(win, cloud);
      const st = tagPageState(win, doc);
      check('T10 标签列表页标签云（单引号）',
        st.onTagPage && st.decoded === "O'Brien" && st.title === "标签: O'Brien", st.hash + ' | ' + st.title);
    } else {
      check('T10 标签列表页标签云（单引号）', false, 'tag cloud item not found');
    }

    // L2：标签页内文章卡片的标签 chip
    await go(win, '#/tags/' + encodeURIComponent("O'Brien"));
    await wait(150);
    const tagPageCard = fixtureCard(doc);
    const chipCV = chipByText(tagPageCard, 'Computer Vision');
    if (chipCV) {
      await clickAndWait(win, chipCV);
      const st = tagPageState(win, doc);
      check('T11 标签页内文章卡片标签 chip',
        st.onTagPage && st.decoded === 'Computer Vision' && st.title === '标签: Computer Vision',
        st.hash + ' | ' + st.title);
    } else {
      check('T11 标签页内文章卡片标签 chip', false, 'chip not found');
    }

    // C1：首页文章卡片点击导航不受影响
    await go(win, '#/');
    const card = fixtureCard(doc);
    if (card) {
      await clickAndWait(win, card);
      check('T12 文章卡片导航不变', win.location.hash === '#/post/' + FIXTURE.id, win.location.hash);
    } else {
      check('T12 文章卡片导航不变', false, 'fixture card missing');
    }

    // C2：课程卡片导航不受影响
    await go(win, '#/courses');
    const courseReady = await waitFor(() => doc.querySelector('#app .course-card[data-course-id]'), 5000, 60);
    const courseCard = doc.querySelector('#app .course-card[data-course-id]');
    if (courseReady && courseCard) {
      const courseId = courseCard.getAttribute('data-course-id');
      await clickAndWait(win, courseCard);
      check('T13 课程卡片导航不变',
        win.location.hash === '#/course/' + encodeURIComponent(courseId), win.location.hash);
    } else {
      check('T13 课程卡片导航不变', false, 'course card missing');
    }

    // C3：代码库卡片导航不受影响
    await go(win, '#/code');
    const codeReady = await waitFor(() => {
      return Array.prototype.slice.call(doc.querySelectorAll('#app .course-card'))
        .some(el => (el.getAttribute('data-href') || '').indexOf('#/codelib/') === 0);
    }, 8000, 80);
    const codeCard = Array.prototype.slice.call(doc.querySelectorAll('#app .course-card'))
      .find(el => (el.getAttribute('data-href') || '').indexOf('#/codelib/') === 0);
    if (codeReady && codeCard) {
      const expected = codeCard.getAttribute('data-href');
      await clickAndWait(win, codeCard);
      check('T14 代码库卡片导航不变', win.location.hash === expected, win.location.hash);
    } else {
      check('T14 代码库卡片导航不变', false, 'codelib card missing');
    }

    // E1：全程无脚本错误（含 SyntaxError）
    // E2：三处页面上全部标签 chip 的 inline handler 均可通过 JS 编译（无 SyntaxError 的硬证据）
    const scriptErrors = allErrors.filter(e => /SyntaxError|Uncaught/i.test(e));
    check('T15 全程无 SyntaxError 或未捕获异常',
      allErrors.length === 0 && scriptErrors.length === 0,
      'total=' + allErrors.length + (allErrors.length ? ' | ' + allErrors.slice(0, 2).join(' | ') : ''));

    await go(win, '#/');
    const homeCompiles = allTagHandlersCompile(doc);
    await go(win, '#/post/' + FIXTURE.id);
    const detailCompiles = allTagHandlersCompile(doc);
    await go(win, '#/tags/' + encodeURIComponent("O'Brien"));
    const tagPageCompiles = allTagHandlersCompile(doc);
    check('T16 全部标签 chip 的 inline handler 可编译（首页/详情/标签页）',
      homeCompiles && detailCompiles && tagPageCompiles,
      'home=' + homeCompiles + ' detail=' + detailCompiles + ' tagPage=' + tagPageCompiles);
  } catch (e) {
    failedByException = e && (e.stack || e.message || String(e));
    console.log('EXCEPTION: ' + failedByException);
    fail++;
  } finally {
    try { if (dom) dom.window.close(); } catch (e) {}
    await new Promise(r => server.close(r));
    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
    if (failures.length) console.log('失败项：' + failures.join(' / '));
    process.exit(fail ? 1 : 0);
  }
})();
