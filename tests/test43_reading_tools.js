// Batch 8D-1：阅读工具（目录 / 正文进度 / 代码复制 / 表格滚动）（jsdom）
//
// 使用合成 Markdown Fixture，不修改正式文章数据。
// 每个场景使用独立页面，导航用 replaceState + router()，避免 jsdom 连续 hash 跳转的环境差异。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8145;
const BASE = 'http://localhost:' + PORT;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
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
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

const LONG_MD = [
  '# 合成阅读文章',
  '',
  '开篇正文。',
  '',
  '## 第一节',
  '',
  '第一节内容。',
  '',
  '### 1.1 子节',
  '',
  '子节内容。',
  '',
  '```python',
  'print("hello")',
  '```',
  '',
  '## 第二节',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '### 2.1 子节',
  '',
  '更多内容。',
  '',
  '## 第三节',
  '',
  '```',
  'no-language-block',
  '```',
  '',
  '## 第四节',
  '',
  '结尾正文。'
].join('\n');

const SHORT_MD = '# 只有两个标题\n\n## 一\n\n内容。\n\n## 二\n\n内容。\n';
const SECOND_MD = '# 第二篇\n\n## 甲\n\n内容。\n\n## 乙\n\n内容。\n\n## 丙\n\n内容。\n';
const CUSTOM_ID_MD = [
  '# 自定义锚点',
  '',
  '## 普通标题',
  '',
  '内容。',
  '',
  '<h2 id="custom-anchor">自定义锚点标题</h2>',
  '',
  '内容。',
  '',
  '### 子标题',
  '',
  '内容。'
].join('\n');
const DUP_ID_MD = [
  '# 重复 id',
  '',
  '<h2 id="dup">重复一</h2>',
  '',
  '内容。',
  '',
  '<h2 id="dup">重复二</h2>',
  '',
  '内容。',
  '',
  '## 第三'
].join('\n');
const XSS_MD = [
  '# 安全测试',
  '',
  '## 标题 &lt;script&gt;alert(1)&lt;/script&gt;',
  '',
  '内容。',
  '',
  '## 第二个标题',
  '',
  '内容。',
  '',
  '## 第三个标题',
  '',
  '内容。'
].join('\n');

async function newPage() {
  const errors = [];
  const vc = new VirtualConsole();
  const collect = s => {
    if (/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) return;
    errors.push(s);
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  const resources = {
    interceptors: [requestInterceptor(async (request) => {
      if (String(request.url).indexOf(BASE) === 0) return undefined;
      return new Response('/* blocked by test43 */', {
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

function mkPost(id, content) {
  return {
    id: id, title: '合成文章 ' + id, date: '2026-11-16',
    tags: ['测试'], excerpt: '合成测试', content: content
  };
}

function linksOf(doc) {
  const toc = doc.getElementById('tocPanel');
  return toc ? Array.prototype.slice.call(toc.querySelectorAll('.toc-link')) : [];
}

(async function main() {
  await new Promise(r => server.listen(PORT, r));
  let dom = null;
  let win = null, doc = null;
  const allErrors = [];

  async function openPage() {
    if (dom) { try { dom.window.close(); } catch (e) { /* 忽略 */ } }
    const ctx = await newPage();
    dom = ctx.dom; win = ctx.win; doc = ctx.doc;
    allErrors.push.apply(allErrors, ctx.errors);
    return ctx;
  }

  async function openPost(post) {
    await openPage();
    win.eval('USER_POSTS.push(' + JSON.stringify(post) + ');');
    win.history.replaceState(null, '', '#/post/' + post.id);
    win.eval('router()');
    await wait(750);
  }

  async function switchPost(post) {
    win.eval('USER_POSTS.push(' + JSON.stringify(post) + ');');
    win.history.replaceState(null, '', '#/post/' + post.id);
    win.eval('router()');
    await wait(750);
  }

  try {
    // ---------------------------------------------------------- 目录生成
    await openPost(mkPost('b8d1-long', LONG_MD));
    const heads = Array.prototype.slice.call(
      doc.querySelectorAll('.article-detail-body h2, .article-detail-body h3'));
    const links = linksOf(doc);
    check('T1 目录条目与正文 H2/H3 一一对应',
      links.length === heads.length && heads.length === 6, links.length + '/' + heads.length);
    check('T2 目录顺序、文本、H3 层级正确', links.every(function (a, i) {
      return a.textContent.trim() === heads[i].textContent.trim() &&
        a.classList.contains('toc-h3') === (heads[i].tagName === 'H3');
    }), links.map(a => a.textContent.trim()).join(' | '));
    check('T3 data-target 精确指向对应标题 id',
      links.every(function (a, i) { return a.getAttribute('data-target') === heads[i].id; }) &&
      heads.every(h => !!h.id));
    check('T4 目录分为桌面侧栏与移动端折叠入口',
      !!doc.getElementById('tocPanel') && !!doc.getElementById('tocMobile') &&
      doc.getElementById('tocMobile').tagName === 'DETAILS');
    const activeOnEnter = doc.querySelectorAll('#tocPanel .toc-link.active');
    check('T5 进入页面立即高亮当前章节',
      activeOnEnter.length === 1 && activeOnEnter[0].getAttribute('aria-current') === 'true',
      'active=' + activeOnEnter.length +
      ' aria=' + (activeOnEnter[0] && activeOnEnter[0].getAttribute('aria-current')));
    win.eval('_readingState.headTops = [400, 900, 1400, 1900, 2400, 2900]; _readingLastActive = -2;');
    Object.defineProperty(win, 'scrollY', { value: 0, configurable: true });
    win.eval('updateReadingUi(true);');
    check('T5b 正文顶部时高亮第一项',
      links[0].classList.contains('active') &&
      !links[1].classList.contains('active') &&
      links[0].getAttribute('aria-current') === 'true');

    // ---------------------------------------------------------- 标题 id 安全
    await openPost(mkPost('b8d1-custom', CUSTOM_ID_MD));
    const customLinks = linksOf(doc);
    const customHeads = Array.prototype.slice.call(
      doc.querySelectorAll('.article-detail-body h2, .article-detail-body h3'));
    check('T6 保留 Markdown 自带标题 id，不覆盖正文锚点',
      doc.getElementById('custom-anchor') !== null &&
      customLinks.some(a => a.getAttribute('data-target') === 'custom-anchor') &&
      customHeads.every(h => doc.getElementById(h.id) === h));
    await openPost(mkPost('b8d1-dup', DUP_ID_MD));
    const dupLinks = linksOf(doc);
    check('T7 重复 id 自动生成唯一后缀', (function () {
      const targets = dupLinks.map(a => a.getAttribute('data-target'));
      return new Set(targets).size === targets.length &&
        targets.indexOf('dup') !== -1 && targets.indexOf('dup-1') !== -1 &&
        doc.querySelectorAll('#dup').length === 1;
    })(), dupLinks.map(a => a.getAttribute('data-target')).join(','));

    // ---------------------------------------------------------- 点击 / 键盘 / 高亮
    await openPost(mkPost('b8d1-nav', LONG_MD));
    const navLinks = linksOf(doc);
    const navHeads = Array.prototype.slice.call(
      doc.querySelectorAll('.article-detail-body h2, .article-detail-body h3'));
    const scrollCalls = [];
    win.scrollTo = function (opts) { scrollCalls.push(opts); };
    Object.defineProperty(win, 'scrollY', { value: 0, configurable: true });
    navHeads[1].getBoundingClientRect = function () {
      return { top: 1200, bottom: 1300, left: 0, right: 0, width: 0, height: 100 };
    };
    navLinks[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('T8 点击目录滚动到目标标题且避开固定导航',
      scrollCalls.length === 1 && scrollCalls[0].behavior === 'smooth' &&
      Math.abs(scrollCalls[0].top - (1200 - win.eval('readingHeaderOffset()'))) <= 2,
      JSON.stringify(scrollCalls[0]));
    check('T9 目录点击不改变 SPA hash',
      win.location.hash === '#/post/b8d1-nav', win.location.hash);
    const spaceBefore = scrollCalls.length;
    navLinks[2].dispatchEvent(new win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    check('T10 Space 键可激活目录项', scrollCalls.length === spaceBefore + 1);

    // jsdom 没有布局：给正文一个随滚动变化的真实坐标，验证缓存坐标的实时平移
    const bodyEl = doc.querySelector('.article-detail-body');
    bodyEl.getBoundingClientRect = function () {
      const y = win.scrollY || 0;
      return { top: -y, bottom: 4000 - y, height: 4000, left: 0, right: 0, width: 800, x: 0, y: -y };
    };
    win.eval('_readingState.headTops = [0, 900, 1800]; _readingState.bodyTop = 0; _readingState.bodyHeight = 4000;');
    Object.defineProperty(win, 'scrollY', { value: 950, configurable: true });
    win.eval('_readingLastActive = -2; updateReadingUi(true);');
    check('T11 滚动时高亮跟随当前章节',
      navLinks[1].classList.contains('active') &&
      navLinks[1].getAttribute('aria-current') === 'true' &&
      !navLinks[0].classList.contains('active') &&
      !navLinks[2].classList.contains('active'));
    win.eval('_readingState.headTops = [0, 900, 1800]; _readingLastActive = -2;');
    Object.defineProperty(win, 'scrollY', { value: 2000, configurable: true });
    win.eval('updateReadingUi(true);');
    check('T12 滚动到最后一节高亮最后一项',
      navLinks[2].classList.contains('active') &&
      doc.querySelectorAll('#tocPanel .toc-link.active').length === 1);

    // ---------------------------------------------------------- 进度（正文区间）
    const pct = fn => win.eval(fn);
    check('P1 正文开始时进度为 0%',
      pct("readingProgressPercent({bodyTop:1000, bodyHeight:5000}, 1000, 800)") === 0);
    check('P2 正文一半约 50%',
      Math.abs(pct("readingProgressPercent({bodyTop:1000, bodyHeight:5000}, 3100, 800)") - 50) < 0.1);
    check('P3 到达正文底部为 100%',
      pct("readingProgressPercent({bodyTop:1000, bodyHeight:5000}, 5200, 800)") === 100);
    check('P4 短正文一屏内可见视为已读完',
      pct("readingProgressPercent({bodyTop:1000, bodyHeight:500}, 1000, 800)") === 100);
    check('P5 评论区 / 页脚不会把进度拉回',
      pct("readingProgressPercent({bodyTop:1000, bodyHeight:5000}, 99999, 800)") === 100);
    check('P6 未进入正文时保持 0%',
      pct("readingProgressPercent({bodyTop:3000, bodyHeight:5000}, 900, 800)") === 0);

    // ---------------------------------------------------------- 少于三个标题
    await openPost(mkPost('b8d1-short', SHORT_MD));
    check('T13 少于三个标题不生成目录', !doc.getElementById('tocPanel') && !doc.getElementById('tocMobile'));
    check('T14 但阅读进度条仍然存在且已初始化',
      !!doc.getElementById('readingProgress') &&
      doc.querySelector('#readingProgress i').style.width !== '',
      'bar=' + !!doc.getElementById('readingProgress') +
      ' w=' + (doc.querySelector('#readingProgress i') || { style: {} }).style.width);

    // ---------------------------------------------------------- 代码块复制
    await openPost(mkPost('b8d1-code', LONG_MD));
    check('C1 每个代码块一个工具条且不重复创建',
      doc.querySelectorAll('.code-toolbar').length === 2, doc.querySelectorAll('.code-toolbar').length);
    const beforeEnhance = doc.querySelectorAll('.code-toolbar').length;
    win.enhanceCodeBlocks(doc.getElementById('app'));
    check('C2 重复初始化不会重复创建工具条',
      doc.querySelectorAll('.code-toolbar').length === beforeEnhance);
    check('C3 无语言标记的代码块只显示复制按钮',
      doc.querySelectorAll('.code-lang').length === 1 &&
      doc.querySelectorAll('.code-toolbar .copy-btn').length === 2);
    check('C4 代码原文仍完整保留',
      doc.querySelector('.article-detail-body pre code').textContent.indexOf('print("hello")') !== -1);

    const btnOk = doc.querySelectorAll('.copy-btn')[0];
    const copiedTexts = [];
    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: function (t) { copiedTexts.push(t); return Promise.resolve(); } }
    });
    btnOk.click();
    await wait(80);
    check('C5 Clipboard 成功才显示「已复制」',
      btnOk.textContent.indexOf('已复制') !== -1 &&
      btnOk.getAttribute('data-copy-state') === 'ok' &&
      copiedTexts.length === 1 && copiedTexts[0].indexOf('print("hello")') !== -1,
      btnOk.textContent);

    const btnFail = doc.querySelectorAll('.copy-btn')[1];
    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: function () { return Promise.reject(new Error('denied')); } }
    });
    doc.execCommand = function () { return false; };
    btnFail.click();
    await wait(120);
    check('C6 Clipboard 失败且回退失败时明确报错，不假报成功',
      btnFail.textContent === '复制失败' &&
      btnFail.getAttribute('data-copy-state') === 'error' &&
      btnFail.textContent.indexOf('已复制') === -1,
      btnFail.textContent);

    const btnNoApi = doc.querySelectorAll('.copy-btn')[0];
    Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: undefined });
    doc.execCommand = function () { return true; };
    btnNoApi.click();
    await wait(80);
    check('C7 Clipboard API 不可用时安全回退成功',
      btnNoApi.textContent.indexOf('已复制') !== -1 &&
      btnNoApi.getAttribute('data-copy-state') === 'ok');
    check('C8 复制按钮具备可访问名称',
      Array.prototype.every.call(doc.querySelectorAll('.copy-btn'), b => !!b.getAttribute('aria-label')));

    // ---------------------------------------------------------- 表格局部滚动
    check('T15 宽表格被局部滚动容器包裹',
      doc.querySelectorAll('.markdown-body .table-scroll > table').length === 1);
    win.enhanceTables(doc.getElementById('app'));
    check('T16 重复初始化不会重复包裹表格',
      doc.querySelectorAll('.markdown-body .table-scroll').length === 1);
    check('T17 表格容器可键盘聚焦',
      doc.querySelector('.table-scroll').getAttribute('tabindex') === '0');

    // ---------------------------------------------------------- XSS
    await openPost(mkPost('b8d1-xss', XSS_MD));
    const tocPanel = doc.getElementById('tocPanel');
    check('X1 恶意标题在目录中被转义',
      tocPanel.innerHTML.indexOf('<script') === -1 &&
      tocPanel.textContent.indexOf('<script>') !== -1 &&
      doc.querySelectorAll('#tocPanel script').length === 0);
    check('X2 目录文本仍与标题一致', linksOf(doc).length === 3);

    // ---------------------------------------------------------- 移动端目录 / Esc
    const mobile = doc.getElementById('tocMobile');
    mobile.open = true;
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check('M1 Esc 关闭移动端目录且同步 aria-expanded',
      mobile.open === false &&
      mobile.querySelector('summary').getAttribute('aria-expanded') === 'false');
    mobile.open = true;
    mobile.dispatchEvent(new win.Event('toggle'));
    check('M2 展开时 aria-expanded 同步为 true',
      mobile.querySelector('summary').getAttribute('aria-expanded') === 'true');

    // ---------------------------------------------------------- 减少动态效果
    const reduceCalls = [];
    win.scrollTo = function (opts) { reduceCalls.push(opts); };
    win.matchMedia = function () { return { matches: true, addEventListener: function () {}, removeEventListener: function () {} }; };
    win.eval('_readingState.headTops = [0, 1200];');
    linksOf(doc)[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('M3 prefers-reduced-motion 时使用即时滚动',
      reduceCalls.length === 1 && reduceCalls[0].behavior === 'instant',
      JSON.stringify(reduceCalls[0]));

    // ---------------------------------------------------------- 文章切换清理
    await openPost(mkPost('b8d1-first', LONG_MD));
    await switchPost(mkPost('b8d1-second', SECOND_MD));
    const secondLinks = linksOf(doc);
    check('T18 切换文章后旧目录被清理，只保留新目录',
      doc.querySelectorAll('#tocPanel').length === 1 &&
      doc.querySelectorAll('#tocMobile').length === 1 &&
      secondLinks.length === 3 &&
      secondLinks[0].textContent.trim() === '甲',
      'toc=' + !!doc.getElementById('tocPanel') + ' links=' + secondLinks.length +
      ' hash=' + win.location.hash);
    check('T19 切换后进度条重新初始化',
      !!doc.getElementById('readingProgress') &&
      doc.querySelectorAll('#readingProgress').length === 1);

    check('G1 无脚本错误', allErrors.length === 0, allErrors.slice(0, 2).join(' | '));
    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
    if (failures.length) console.log('失败项：' + failures.join(' / '));
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  } finally {
    if (dom) dom.window.close();
    server.close();
    process.exit(fail ? 1 : 0);
  }
})();
