// Batch 8C-1：多数据源加载状态、失败恢复、竞态与输入法保护
//
// 使用公开数据与合成 Fixture（不访问私人 Zotero / Registry）：
//   本地服务器按路径注入 500 / 延迟 / 内存内容，覆盖按需加载、单源失败、
//   失败重试、临时零结果、快速输入、路由切换、IME 组合、历史恢复与深链。
//
// 用法：node tests/test40_search_sources.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
let PORT = Number(process.env.TEST_PORT || 0);
let BASE = '';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};

const state = { faults: {}, delays: {}, overrides: {}, hits: {} };
// 注入故障的资源会触发 jsdom 的 "Could not load script"，这是预期现象；
// 只豁免这些明确注入的路径，其它脚本异常一律计入失败。
let expectedLoadErrors = [];
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  state.hits[p] = (state.hits[p] || 0) + 1;
  if (state.faults[p]) {
    res.writeHead(state.faults[p], { 'Cache-Control': 'no-store' });
    res.end('injected ' + state.faults[p]); return;
  }
  const send = function (body) {
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  };
  let body = null;
  if (Object.prototype.hasOwnProperty.call(state.overrides, p)) {
    body = Buffer.from(String(state.overrides[p]), 'utf8');
  } else {
    const file = path.join(ROOT, p);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    body = fs.readFileSync(file);
  }
  const delay = state.delays[p] || 0;
  if (delay) setTimeout(function () { send(body); }, delay);
  else send(body);
});

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  const ok = !!cond;
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

function resetState() {
  state.faults = {}; state.delays = {}; state.overrides = {}; state.hits = {};
  expectedLoadErrors = [];
}

async function openPage() {
  const errors = [];
  const suppressed = [];
  const vc = new VirtualConsole();
  const collect = s => {
    if (/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) return;
    if (/Could not load script/.test(s) &&
        expectedLoadErrors.some(u => s.indexOf(u) !== -1)) { suppressed.push(s); return; }
    errors.push(s);
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  const dom = await JSDOM.fromURL(BASE + '/index.html#/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(120);
  return { dom, win: dom.window, doc: dom.window.document, errors, suppressed };
}

function type(win, doc, text) {
  const input = doc.getElementById('searchInput');
  input.value = text;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  return input;
}

function queryKey(doc) {
  const root = doc.querySelector('[data-search-root]');
  if (!root) return null;
  try { return decodeURIComponent(root.getAttribute('data-query')); }
  catch (e) { return root.getAttribute('data-query'); }
}

function appText(doc) { return doc.getElementById('app').textContent; }

(async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = 'http://localhost:' + PORT;

  const unhandled = [];
  process.on('unhandledRejection', e => unhandled.push(String(e && e.message || e)));
  let opened = null;
  const closeOpened = () => { if (opened) { opened.dom.window.close(); opened = null; } };

  try {
    // ------------------------------------------------ S1 按需加载 / 不重复请求 / 部分失败 / 重试
    resetState();
    state.faults['/js/papers.js'] = 500;
    expectedLoadErrors = ['/js/papers.js'];
    opened = await openPage();
    {
      const { win, doc, errors, suppressed } = opened;
      const before = ['/js/courses.js', '/js/course-notes.js', '/js/papers.js', '/data/search-index.json']
        .map(p => state.hits[p] || 0);
      check('S1 首次搜索前不加载按需数据', before.every(n => n === 0), before.join(','));

      type(win, doc, '机器人');
      await wait(60);
      type(win, doc, '机器人控制');           // 快速连续输入：不能重复发起请求
      await wait(1500);

      const counts = ['/js/courses.js', '/js/course-notes.js', '/data/search-index.json']
        .map(p => state.hits[p] || 0);
      check('S1 正在加载的资源不被重复请求', counts.every(n => n === 1), counts.join(','));
      check('S1 失败源也只请求一次', (state.hits['/js/papers.js'] || 0) === 1,
        state.hits['/js/papers.js'] || 0);

      const txt = appText(doc);
      check('S1 明确列出已加载类别', /已加载 \d+\/5 类/.test(txt) && /文章 ✓ 已加载/.test(txt),
        txt.slice(0, 90));
      check('S1 明确标出失败类别', /论文 \/ 学习资料 ⚠ 加载失败/.test(txt));
      const groups = win.eval("(function(){var r=collectSearchResults('机器人');return {post:r.groups.post.length,course:r.groups.course.length};})()");
      check('S1 单个数据源失败不阻断其他来源', groups.post > 0 && groups.course > 0,
        JSON.stringify(groups));
      check('S1 提供失败源重试入口',
        !!doc.querySelector('[data-retry-search-source="papers"]'));

      delete state.faults['/js/papers.js'];
      const retry = doc.querySelector('[data-retry-search-source="papers"]');
      retry.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await wait(1300);
      check('S1 失败后重试可恢复该数据源',
        win.eval('searchSourceStatus().papers') === 'ready',
        JSON.stringify(win.eval('searchSourceStatus()')));
      check('S1 重试确实重新发起请求', (state.hits['/js/papers.js'] || 0) >= 2,
        state.hits['/js/papers.js'] || 0);
      check('S1 重试后论文 / 学习资料可搜索',
        win.eval("collectSearchResults('Benchmarking').groups.paper.length") > 0 ||
        /论文 \/ 学习资料 ✓ 已加载/.test(appText(doc)));
      check('S1 除注入故障外无脚本错误', errors.length === 0 && suppressed.length >= 1,
        'errors=' + errors.length + ' suppressed=' + suppressed.length);
    }
    closeOpened();

    // ------------------------------------------------ S2 多源失败 / 无未处理 rejection
    resetState();
    state.faults['/js/papers.js'] = 500;
    state.faults['/data/search-index.json'] = 500;
    expectedLoadErrors = ['/js/papers.js', '/data/search-index.json'];
    opened = await openPage();
    {
      const { win, doc, errors, suppressed } = opened;
      type(win, doc, '机器人');
      await wait(1300);
      const groups = win.eval("(function(){var r=collectSearchResults('机器人');return {post:r.groups.post.length,course:r.groups.course.length};})()");
      check('S2 两个源失败时文章 / 课程仍可用', groups.post > 0 && groups.course > 0,
        JSON.stringify(groups));
      const txt = appText(doc);
      check('S2 两个失败源都被明确列出',
        /论文 \/ 学习资料 ⚠ 加载失败/.test(txt) && /正文检索语料 ⚠ 加载失败/.test(txt));
      check('S2 失败不显示最终"无结果"', !/没有找到相关内容/.test(txt));
      check('S2 无未处理的 Promise rejection', unhandled.length === 0,
        unhandled.slice(0, 2).join(' | '));
      check('S2 除注入故障外无脚本错误', errors.length === 0 && suppressed.length >= 1,
        'errors=' + errors.length + ' suppressed=' + suppressed.length);
    }
    closeOpened();

    // ------------------------------------------------ S3 临时零结果 / 加载完成后补全
    resetState();
    state.overrides['/data/search-index.json'] = JSON.stringify({
      'embodied-ai-notes': '正文里有一个唯一标记：蓝鲸螺栓校准测试词。'
    });
    state.delays['/data/search-index.json'] = 900;
    opened = await openPage();
    {
      const { win, doc } = opened;
      type(win, doc, '蓝鲸螺栓校准测试词');
      await wait(320);
      const interim = appText(doc);
      check('S3 数据未加载时的零结果不显示最终"无结果"',
        !/没有找到相关内容/.test(interim) && /尚未加载完成|正在加载/.test(interim),
        interim.slice(0, 100));
      await wait(1500);
      const done = appText(doc);
      check('S3 正文语料到齐后结果自动补全',
        /找到\s*[1-9]\d*\s*条/.test(done) && /具身智能/.test(done), done.slice(0, 90));
      check('S3 补全后状态条显示全部已加载', /已加载 5\/5 类/.test(done));
    }
    closeOpened();

    // ------------------------------------------------ S3b 快速输入竞态（慢语料 + 切词）
    resetState();
    state.overrides['/data/search-index.json'] = JSON.stringify({
      'embodied-ai-notes': '正文里有一个唯一标记：蓝鲸螺栓校准测试词。'
    });
    state.delays['/data/search-index.json'] = 800;
    opened = await openPage();
    {
      const { win, doc } = opened;
      type(win, doc, '蓝鲸螺栓校准测试词');
      await wait(260);
      type(win, doc, '最终查询词XYZ');
      await wait(1400);
      check('S3b 只显示最新查询对应的结果',
        queryKey(doc) === '最终查询词XYZ' && appText(doc).indexOf('最终查询词XYZ') !== -1 &&
        appText(doc).indexOf('蓝鲸螺栓校准测试词') === -1,
        queryKey(doc));
      check('S3b 输入框保留最新输入',
        doc.getElementById('searchInput').value === '最终查询词XYZ');
    }
    closeOpened();

    // ------------------------------------------------ S4 路由切换后旧请求不重绘
    resetState();
    state.delays['/js/course-notes.js'] = 800;
    opened = await openPage();
    {
      const { win, doc } = opened;
      type(win, doc, '机器人');
      await wait(240);
      win.location.hash = '#/papers';
      await wait(1600);
      check('S4 旧请求不重绘新页面',
        !/search-results-count/.test(doc.getElementById('app').innerHTML) &&
        /论文与学习资料/.test(appText(doc)),
        appText(doc).trim().slice(0, 60));
    }
    closeOpened();

    // ------------------------------------------------ S5 中文输入法组合期间
    resetState();
    opened = await openPage();
    {
      const { win, doc } = opened;
      const input = doc.getElementById('searchInput');
      const original = input;
      type(win, doc, '机器人');
      await wait(1000);
      input.dispatchEvent(new win.Event('compositionstart', { bubbles: true }));
      input.value = '机器';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      await wait(280);
      check('S5 组合期间不触发搜索重绘', queryKey(doc) === '机器人', queryKey(doc));
      check('S5 组合期间输入框不被重建',
        doc.getElementById('searchInput') === original && input.value === '机器');
      input.value = '机器人控制';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      await wait(280);
      check('S5 组合期间连续输入仍不重绘', queryKey(doc) === '机器人', queryKey(doc));
      input.dispatchEvent(new win.Event('compositionend', { bubbles: true }));
      await wait(500);
      check('S5 组合结束后显示最终查询', queryKey(doc) === '机器人控制', queryKey(doc));
      check('S5 组合结束后输入框节点未变',
        doc.getElementById('searchInput') === original &&
        doc.getElementById('searchInput').value === '机器人控制');
    }
    closeOpened();

    // ------------------------------------------------ S6 前进 / 后退恢复搜索状态
    resetState();
    opened = await openPage();
    {
      const { win, doc } = opened;
      type(win, doc, '机器人');
      await wait(1000);
      check('S6 搜索状态已写入当前历史条目',
        win.eval('history.state && history.state.search') === '机器人');
      win.location.hash = '#/about';
      await wait(350);
      check('S6 离开首页时输入框清空', doc.getElementById('searchInput').value === '');
      win.history.back();
      await wait(700);
      check('S6 后退恢复搜索关键词',
        doc.getElementById('searchInput').value === '机器人',
        doc.getElementById('searchInput').value);
      check('S6 后退恢复搜索结果', /找到\s*\d+\s*条/.test(appText(doc)),
        appText(doc).trim().slice(0, 60));
    }
    closeOpened();

    // ------------------------------------------------ S7 搜索结果深链稳定
    resetState();
    opened = await openPage();
    {
      const { win, doc } = opened;
      type(win, doc, 'ANSYS');
      await wait(1300);
      const hrefs = Array.prototype.map.call(
        doc.querySelectorAll('.search-paper-item[data-href]'),
        el => el.getAttribute('data-href'));
      check('S7 学习资料深链使用持久 ID',
        hrefs.some(h => /kind=material&target=lm-/.test(h)), hrefs.slice(0, 2).join(' | '));
      check('S7 深链不使用数组下标',
        hrefs.length > 0 && hrefs.every(h => !/target=\d+(&|$)/.test(h)));
      check('S7 深链参数经 URLSearchParams 编码',
        hrefs.every(h => h.indexOf('#/papers?kind=') === 0));
    }
    closeOpened();

    check('全局：无未处理的 Promise rejection', unhandled.length === 0,
      unhandled.slice(0, 3).join(' | '));
    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
    if (failures.length) console.log('失败项：' + failures.join(' / '));
  } catch (e) {
    console.error('SPEC ERROR:', e && e.stack || e);
    fail++;
    console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  } finally {
    closeOpened();
    server.close();
    process.exit(fail ? 1 : 0);
  }
})();
