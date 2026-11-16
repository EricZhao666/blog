// Batch 8C-2：分类筛选 / 排序 / 折叠 / 键盘导航 / 安全与稳定深链（jsdom）
//
// 全部使用公开产物 + 合成 Fixture，不访问私人 Zotero / Registry。
// 复用 collectSearchResults()，验证本轮只做 UI 层交互，不改评分公式。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8143;
const BASE = 'http://localhost:' + PORT;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};
const state = { hits: {}, faults: {}, delays: {} };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  state.hits[p] = (state.hits[p] || 0) + 1;
  if (state.faults[p]) { res.writeHead(state.faults[p]); res.end('injected'); return; }
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const send = () => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  };
  if (state.delays[p]) setTimeout(send, state.delays[p]); else send();
});
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

function fixture() {
  const mk = (id, title, date, excerpt) => ({
    id: id, title: title, date: date, tags: ['共现标记'], excerpt: excerpt || '普通摘要', content: '普通正文'
  });
  const posts = [
    mk('p-exact', '共现标记', '2026-01-05', '仅文章词 出现在摘要里'),
    mk('p-alpha', 'Alpha 共现标记', '2026-03-01'),
    mk('p-beta', 'Beta 共现标记', '2026-02-01'),
    mk('p-chinese', '中文 共现标记', '2026-05-01'),
    mk('p-delta', '共现标记 Delta', '2026-04-01'),
    mk('p-echo', '共现标记 Echo', '2026-06-01'),
    mk('p-foxtrot', '共现标记 Foxtrot', '2026-07-01'),
    mk('p-golf', '共现标记 Golf', '2026-08-01'),
    mk('p-nodate', '共现标记 无日期', '')
  ];
  const courses = [
    { id: 'c-one', name: '共现标记 课程一', category: '机器人与自动化', description: '课程简介' },
    { id: 'c-two', name: '共现标记 课程二', category: '控制', description: '课程简介' }
  ];
  const notes = { 'c-one': { summary: '课程笔记', notes: '共现标记的推导过程。' } };
  const papers = [
    { id: 'paper-fixture-1', title: '共现标记 论文一', authors: 'Alpha Author', category: '双足机器人', abstract: '摘要内容' },
    { id: 'paper-fixture-2', title: '共现标记 论文二', authors: 'Beta Author', category: '具身智能', abstract: '摘要内容' }
  ];
  const materials = [
    { id: 'lm-fixture-001', name: '共现标记 资料一.pdf', category: 'ANSYS仿真', subcategory: '有限元分析', type: 'PDF' },
    { id: 'lm-fixture-002', name: '共现标记 资料二.pdf', category: 'CAD建模', subcategory: '第一课', type: 'PDF' }
  ];
  return { posts, courses, notes, papers, materials };
}

function injectFixture(win, f) {
  win.eval('POSTS.splice(0, POSTS.length); USER_POSTS.length = 0;' +
    'COURSES.splice(0, COURSES.length); PAPERS.splice(0, PAPERS.length);' +
    'LEARNING_MATERIALS.splice(0, LEARNING_MATERIALS.length);' +
    'Object.keys(COURSE_NOTES).forEach(function (k) { delete COURSE_NOTES[k]; });');
  [['POSTS', f.posts], ['COURSES', f.courses], ['PAPERS', f.papers],
    ['LEARNING_MATERIALS', f.materials]].forEach(function (pair) {
    win.eval(pair[0] + '.push.apply(' + pair[0] + ', ' + JSON.stringify(pair[1]) + ');');
  });
  Object.keys(f.notes).forEach(function (k) {
    win.eval('COURSE_NOTES[' + JSON.stringify(k) + '] = ' + JSON.stringify(f.notes[k]) + ';');
  });
}

async function openPage() {
  const errors = [];
  const vc = new VirtualConsole();
  const collect = s => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) errors.push(s);
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  // 键盘导航会真正进入文章路由；拦截第三方（giscus）请求，全程只用本地数据
  const resources = {
    interceptors: [requestInterceptor(async (request) => {
      if (String(request.url).indexOf(BASE) === 0) return undefined;
      return new Response('/* blocked by test41 */', {
        status: 200, headers: { 'Content-Type': 'application/javascript' }
      });
    })]
  };
  const dom = await JSDOM.fromURL(BASE + '/index.html#/', {
    runScripts: 'dangerously', resources: resources, pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(120);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

function type(win, doc, text) {
  const input = doc.getElementById('searchInput');
  input.value = text;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  return input;
}
function click(doc, win, sel) {
  const el = doc.querySelector(sel);
  if (!el) return false;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}
function key(win, input, k, props) {
  const ev = new win.KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true,
    ctrlKey: !!(props && props.ctrlKey), metaKey: !!(props && props.metaKey),
    shiftKey: !!(props && props.shiftKey), altKey: !!(props && props.altKey)
  });
  if (props) Object.keys(props).forEach(function (p) {
    if (p !== 'ctrlKey' && p !== 'metaKey' && p !== 'shiftKey' && p !== 'altKey') {
      Object.defineProperty(ev, p, { value: props[p], configurable: true });
    }
  });
  input.dispatchEvent(ev);
  return ev;
}
function resultIds(doc, type) {
  const sel = type === 'post' ? '.article-card[data-search-result]'
    : type === 'course' ? '.search-course-item[data-search-result]'
      : '.search-paper-item[data-search-result]';
  return Array.prototype.map.call(doc.querySelectorAll(sel), n => n.getAttribute('data-href'));
}
function appText(doc) { return doc.getElementById('app').textContent; }
// 控件每次局部重绘都会换节点，必须现取现用
function setSort(win, doc, value) {
  const sel = doc.getElementById('searchSortSelect');
  if (!sel) return false;
  sel.value = value;
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  return true;
}

(async function main() {
  await new Promise(r => server.listen(PORT, r));
  let dom = null;
  try {
    const ctx = await openPage();
    const { win, doc, errors } = ctx;
    dom = ctx.dom;

    // 让按需数据源全部就绪后再换成合成数据（保证状态条不是临时态）
    type(win, doc, 'warmup-not-found');
    await wait(1400);
    check('前置：四类数据源均已就绪',
      ['posts', 'courses', 'notes', 'papers', 'docs'].every(k => win.eval('searchSourceStatus()')[k] === 'ready'));
    injectFixture(win, fixture());
    type(win, doc, '共现标记');
    await wait(450);

    // ---------------------------------------------------------- 1. 筛选与数量
    const buttons = Array.prototype.map.call(doc.querySelectorAll('[data-search-filter]'), function (n) {
      return { key: n.getAttribute('data-search-filter'), pressed: n.getAttribute('aria-pressed'), text: n.textContent };
    }).filter(x => x.key !== 'all' || x.pressed === 'true');
    check('F1 默认选中「全部」且具备 aria-pressed',
      doc.querySelector('[data-search-filter="all"][aria-pressed="true"]') !== null &&
      doc.querySelectorAll('#searchFilterBar [aria-pressed="true"]').length === 1);
    const counts = {};
    doc.querySelectorAll('#searchFilterBar [data-search-filter]').forEach(function (n) {
      const m = /\((\d+)\)/.exec(n.textContent);
      counts[n.getAttribute('data-search-filter')] = m ? Number(m[1]) : -1;
    });
    const bundle = win.eval("collectSearchResults('共现标记')");
    check('F2 各分类数量来自筛选之前的结果',
      counts.all === bundle.total && counts.post === bundle.groups.post.length &&
      counts.course === bundle.groups.course.length && counts.paper === bundle.groups.paper.length &&
      counts.material === bundle.groups.material.length, JSON.stringify(counts));
    check('F3 四类结果默认都在',
      doc.querySelectorAll('.search-section-title').length === 4,
      Array.prototype.map.call(doc.querySelectorAll('.search-section-title'), n => n.textContent).join('|'));

    const hitsBefore = JSON.stringify(state.hits);
    const rootBefore = doc.querySelector('[data-search-root]');
    const inputBefore = doc.getElementById('searchInput');
    click(doc, win, '[data-search-filter="paper"]');
    check('F4 切换分类立即生效且只显示该分类',
      doc.querySelectorAll('.search-section-title').length === 1 &&
      /论文/.test(doc.querySelector('.search-section-title').textContent) &&
      doc.querySelectorAll('.article-card[data-search-result]').length === 0,
      appText(doc).slice(0, 80));
    check('F5 切换分类不重新请求数据', JSON.stringify(state.hits) === hitsBefore);
    check('F6 切换分类只局部刷新结果区，输入框未重建',
      doc.querySelector('[data-search-root]') === rootBefore &&
      doc.getElementById('searchInput') === inputBefore);
    const paperLinksAfter = resultIds(doc, 'paper');
    check('F7 筛选不改变论文持久深链',
      paperLinksAfter.length === 2 && paperLinksAfter.every(h => /target=paper-fixture-/.test(h)) &&
      paperLinksAfter.join('|') === bundle.groups.paper.map(r => r.targetUrl).join('|'),
      paperLinksAfter.join(' | '));

    click(doc, win, '[data-search-filter="material"]');
    check('F8 学习资料筛选保持持久 ID',
      doc.querySelectorAll('.search-paper-item[data-search-result]').length === 2 &&
      resultIds(doc, 'paper').every(h => /target=lm-fixture-/.test(h) && !/target=\d+(&|$)/.test(h)));
    click(doc, win, '[data-search-filter="all"]');

    // 选中分类无结果
    type(win, doc, '仅文章词');
    await wait(350);
    click(doc, win, '[data-search-filter="paper"]');
    check('F9 选中分类无结果时给出明确提示',
      /当前分类「论文」没有匹配结果/.test(appText(doc)) &&
      !/没有找到相关内容/.test(appText(doc)) &&
      !!doc.querySelector('[data-search-filter="all"].search-expand-btn'), appText(doc).slice(-80));
    click(doc, win, '[data-search-filter="all"]');
    check('F10 一键切回全部', doc.querySelectorAll('[data-search-filter="all"][aria-pressed="true"]').length === 1);
    type(win, doc, '共现标记');
    await wait(350);

    // ---------------------------------------------------------- 2. 排序
    const relOrder = win.eval("collectSearchResults('共现标记').groups.post.map(function(r){return r.id;})");
    const domRel = Array.prototype.map.call(doc.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
      n => n.getAttribute('href'));
    check('S1 相关性排序完全沿用 B8C-1 的 score 顺序',
      domRel.slice(0, 6).join('|') === relOrder.slice(0, 6).map(id => '#/post/' + id).join('|'),
      domRel.slice(0, 3).join(','));
    const select = doc.getElementById('searchSortSelect');
    check('S2 排序控件有三种选项且默认相关性',
      select && select.value === 'relevance' && select.querySelectorAll('option').length === 3);

    const postsBefore = win.eval('POSTS.map(function(p){return p.id;}).join("|")');
    const fixturePosts = win.eval('POSTS.map(function(p){return {id:p.id,title:p.title,date:p.date};})');
    const titleOf = id => (fixturePosts.filter(function (p) { return p.id === id; })[0] || {}).title || '';
    setSort(win, doc, 'title');
    const titleOrder = Array.prototype.map.call(doc.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
      n => n.getAttribute('href').slice(7));
    check('S3 标题排序改变了顺序且使用字符/拼音序',
      titleOrder.join('|') !== relOrder.slice(0, 6).join('|') &&
      titleOrder.join('|') === titleOrder.slice().sort(function (a, b) {
        return titleOf(a).localeCompare(titleOf(b), 'zh-Hans-CN', { sensitivity: 'base' });
      }).join('|'), titleOrder.join(','));
    setSort(win, doc, 'title');
    check('S4 标题排序同分结果确定且可复现',
      Array.prototype.map.call(doc.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
        n => n.getAttribute('href')).join('|') === titleOrder.map(id => '#/post/' + id).join('|'));

    click(doc, win, '[data-search-expand="post"]');   // 展开后才能看到全部 9 条
    setSort(win, doc, 'date');
    const dateOrder = Array.prototype.map.call(doc.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
      n => n.getAttribute('href').slice(7));
    check('S5 最新优先按可靠日期倒序，无日期文章稳定回退到末尾',
      dateOrder[0] === 'p-golf' && dateOrder.indexOf('p-nodate') === dateOrder.length - 1,
      dateOrder.join(','));
    check('S6 日期排序不影响其它类型（保持相关性）',
      Array.prototype.map.call(doc.querySelectorAll('.search-paper-item[data-search-result]'),
        n => n.getAttribute('data-href')).slice(0, 2).join('|') ===
      bundle.groups.paper.map(r => r.targetUrl).join('|'));
    check('S7 UI 明确说明日期排序仅对文章生效',
      /最新文章优先.*只对有可靠发布日期的文章生效/.test(appText(doc)));
    check('S8 排序不改变原始数据数组',
      win.eval('POSTS.map(function(p){return p.id;}).join("|")') === postsBefore);
    check('S9 排序不触发额外网络请求', JSON.stringify(state.hits) === hitsBefore);

    click(doc, win, '[data-search-filter="post"]');
    // 切换分类会重置展开状态，因此比较当前可见的日期排序前缀
    check('S10 排序与分类筛选共同生效（切换分类重置展开）',
      doc.querySelectorAll('.search-section-title').length === 1 &&
      Array.prototype.map.call(doc.querySelectorAll('.article-card[data-search-result] .article-card-title a'),
        n => n.getAttribute('href').slice(7)).join('|') === dateOrder.slice(0, 6).join('|'));
    click(doc, win, '[data-search-filter="all"]');
    setSort(win, doc, 'relevance');
    if (doc.querySelector('[data-search-expand="post"][aria-expanded="true"]')) {
      click(doc, win, '[data-search-expand="post"]');   // 恢复折叠，便于下面验证默认 6 条
    }

    // ---------------------------------------------------------- 3. 折叠
    const beforeExpand = doc.querySelectorAll('.article-card[data-search-result]').length;
    check('C1 每类默认只渲染 6 条',
      beforeExpand === 6 && /显示 6 \/ 共 9/.test(appText(doc)), beforeExpand);
    check('C2 显示可见数量与总命中数量', /显示 \d+ \/ 共 \d+/.test(appText(doc)));
    const expandBtn = doc.querySelector('[data-search-expand="post"]');
    check('C3 超过上限显示展开更多', !!expandBtn && /展开更多 \(3\)/.test(expandBtn.textContent));
    click(doc, win, '[data-search-expand="post"]');
    check('C4 展开后显示全部且可折叠',
      doc.querySelectorAll('.article-card[data-search-result]').length === 9 &&
      !!doc.querySelector('[data-search-expand="post"][aria-expanded="true"]') &&
      /收起/.test(doc.querySelector('[data-search-expand="post"]').textContent));
    click(doc, win, '[data-search-expand="post"]');
    check('C5 折叠回到 6 条', doc.querySelectorAll('.article-card[data-search-result]').length === 6);
    check('C6 折叠只限制渲染，不截断搜索计算',
      win.eval("collectSearchResults('共现标记').groups.post.length") === 9);
    click(doc, win, '[data-search-expand="post"]');
    type(win, doc, '共现标记 新词');
    await wait(350);
    type(win, doc, '共现标记');
    await wait(350);
    check('C7 关键词变化后重置展开状态',
      doc.querySelectorAll('.article-card[data-search-result]').length === 6 &&
      !win.eval('!!_searchExpanded.post'));
    const indices = Array.prototype.map.call(doc.querySelectorAll('[data-search-result]'),
      n => n.getAttribute('data-result-index'));
    check('C8 切换类型不产生重复条目 / 重复 id',
      new Set(indices).size === indices.length &&
      win.eval("(function(){var ids=[].slice.call(document.querySelectorAll('#app [id]'));var s={},dup=0;ids.forEach(function(n){if(s[n.id])dup++;s[n.id]=1;});return dup;})()") === 0);

    // ---------------------------------------------------------- 4. 键盘导航
    const input = doc.getElementById('searchInput');
    input.focus();
    key(win, input, 'ArrowDown');
    let active = doc.querySelectorAll('.search-result-active');
    check('K1 ↓ 选中第一条并同步 aria-activedescendant',
      active.length === 1 && active[0].getAttribute('aria-selected') === 'true' &&
      input.getAttribute('aria-activedescendant') === active[0].id &&
      input.getAttribute('role') === 'combobox' && input.getAttribute('aria-controls') === 'searchResults',
      active[0] && active[0].id);
    const firstHref = active[0].getAttribute('data-href');
    key(win, input, 'ArrowDown');
    check('K2 ↓ 移到下一条', doc.querySelectorAll('.search-result-active').length === 1 &&
      doc.querySelector('.search-result-active').getAttribute('data-href') !== firstHref);
    key(win, input, 'ArrowUp');
    check('K3 ↑ 回到上一条', doc.querySelector('.search-result-active').getAttribute('data-href') === firstHref);
    key(win, input, 'Escape');
    check('K4 Esc 有选中项时只退出选择、不清空搜索',
      doc.querySelectorAll('.search-result-active').length === 0 &&
      !input.hasAttribute('aria-activedescendant') && input.value === '共现标记' &&
      /找到 \d+ 条/.test(appText(doc)));
    key(win, input, 'Escape');
    check('K5 无选中项时 Esc 沿用原有清空行为', input.value === '' && !/search-results-count/.test(doc.getElementById('app').innerHTML));

    type(win, doc, '共现标记');
    await wait(350);
    const input2 = doc.getElementById('searchInput');
    input2.focus();
    key(win, input2, 'ArrowDown', { isComposing: true });
    check('K6 isComposing 时不执行导航', doc.querySelectorAll('.search-result-active').length === 0);
    key(win, input2, 'ArrowDown', { keyCode: 229 });
    check('K7 keyCode 229 时不执行导航', doc.querySelectorAll('.search-result-active').length === 0);
    key(win, input2, 'ArrowDown', { ctrlKey: true });
    check('K8 系统快捷键不被拦截', doc.querySelectorAll('.search-result-active').length === 0);
    key(win, input2, 'ArrowDown');
    const chosenHref = doc.querySelector('.search-result-active').getAttribute('data-href');
    key(win, input2, 'Enter');
    await wait(250);
    check('K9 Enter 打开选中结果且与鼠标点击同一链接',
      win.location.hash === chosenHref, win.location.hash + ' / ' + chosenHref);

    // 返回首页，验证重绘后不保留失效焦点引用
    win.location.hash = '#/';
    await wait(300);
    type(win, doc, '共现标记');
    await wait(350);
    const input3 = doc.getElementById('searchInput');
    input3.focus();
    key(win, input3, 'ArrowDown');
    const staleId = input3.getAttribute('aria-activedescendant');
    click(doc, win, '[data-search-filter="course"]');
    check('K10 重绘后不保留指向已删除 DOM 的引用',
      !input3.hasAttribute('aria-activedescendant') &&
      (!staleId || !doc.getElementById(staleId) || !doc.getElementById(staleId).classList.contains('search-result-active')));
    click(doc, win, '[data-search-filter="all"]');

    type(win, doc, '绝无此词XYZ');
    await wait(350);
    const input4 = doc.getElementById('searchInput');
    input4.focus();
    const hashBefore = win.location.hash;
    key(win, input4, 'ArrowDown');
    key(win, input4, 'Enter');
    await wait(200);
    check('K11 无可选结果时 Enter 不产生错误跳转',
      win.location.hash === hashBefore && doc.querySelectorAll('.search-result-active').length === 0);

    // ---------------------------------------------------------- 5. 安全 / 竞态 / 失败
    type(win, doc, '<img src=x onerror=alert(1)>');
    await wait(300);
    const evilHtml = doc.getElementById('app').innerHTML;
    check('X1 恶意查询不创建元素',
      doc.querySelectorAll('#app img, #app script, #app [onerror]').length === 0 && evilHtml.indexOf('<img') === -1);
    check('X2 恶意查询被转义', evilHtml.indexOf('&lt;img') !== -1);
    click(doc, win, '[data-search-filter="all"]');
    type(win, doc, '共现标记');
    await wait(300);
    click(doc, win, '[data-search-filter="material"]');
    const linksAfterFilter = resultIds(doc, 'paper');
    check('X3 筛选后资料深链仍稳定',
      linksAfterFilter.length === 2 && linksAfterFilter.every(h => /target=lm-fixture-/.test(h)),
      linksAfterFilter.join(' | '));
    click(doc, win, '[data-search-filter="all"]');
    check('X4 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));

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
