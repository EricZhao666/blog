// Batch 8C-2：最近搜索历史 / localStorage 降级 / 竞态 / 部分失败 / 前进后退（jsdom）
//
// 全部使用公开产物 + 合成 Fixture；不上传服务器、不触碰草稿 IndexedDB、不访问私人数据。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
let PORT = Number(process.env.TEST_PORT || 0);
let BASE = '';
const HISTORY_KEY = 'blog.searchHistory.v1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};
const state = { faults: {}, delays: {}, hits: {} };
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

function fakeStorage(broken) {
  const data = {};
  const boom = () => { if (broken) throw new Error('localStorage blocked by test42'); };
  return {
    _data: data,
    getItem(k) { boom(); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { boom(); data[k] = String(v); },
    removeItem(k) { boom(); delete data[k]; },
    key(i) { boom(); return Object.keys(data)[i] || null; },
    get length() { boom(); return Object.keys(data).length; }
  };
}

async function openPage(opts) {
  const o = opts || {};
  const errors = [];
  const vc = new VirtualConsole();
  const collect = s => {
    if (/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) return;
    if (/Could not load script/.test(s) && (state.faults['/js/papers.js'] || state.faults['/data/search-index.json'])) {
      if (s.indexOf('/js/papers.js') !== -1 || s.indexOf('/data/search-index.json') !== -1) return;
    }
    errors.push(s);
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  const resources = {
    interceptors: [requestInterceptor(async (request) => {
      if (String(request.url).indexOf(BASE) === 0) return undefined;
      return new Response('/* blocked by test42 */', {
        status: 200, headers: { 'Content-Type': 'application/javascript' }
      });
    })]
  };
  const dom = await JSDOM.fromURL(BASE + '/index.html#/', {
    runScripts: 'dangerously', resources: resources, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      if (o.storage) Object.defineProperty(w, 'localStorage', { value: o.storage, configurable: true });
    }
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(120);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

function resetState() { state.faults = {}; state.delays = {}; state.hits = {}; }
function type(win, doc, text) {
  const input = doc.getElementById('searchInput');
  input.value = text;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  return input;
}
function confirmSearch(win, doc, text) {
  const input = type(win, doc, text);
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return input;
}
function clickEl(win, el) {
  if (!el) return false;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}
// 历史 chip 的属性存的是百分号编码键，比较前先解码
function chipValue(n, attr) {
  let raw = n.getAttribute(attr);
  try { raw = decodeURIComponent(raw); } catch (e) { /* 原样返回 */ }
  return raw;
}
function historyChip(doc, win, attr, value) {
  const nodes = doc.querySelectorAll('[' + attr + ']');
  for (let i = 0; i < nodes.length; i++) {
    if (chipValue(nodes[i], attr) === value) { clickEl(win, nodes[i]); return true; }
  }
  return false;
}
function terms(storage) {
  const raw = storage._data[HISTORY_KEY];
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
function appText(doc) { return doc.getElementById('app').textContent; }
function queryKey(doc) {
  const root = doc.querySelector('[data-search-root]');
  if (!root) return null;
  try { return decodeURIComponent(root.getAttribute('data-query')); }
  catch (e) { return root.getAttribute('data-query'); }
}

(async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = 'http://localhost:' + PORT;

  const unhandled = [];
  process.on('unhandledRejection', e => unhandled.push(String(e && e.message || e)));
  let opened = null;
  const closeOpened = () => { if (opened) { opened.dom.window.close(); opened = null; } };

  try {
    // ------------------------------------------------ H1–H12 正常 localStorage
    resetState();
    const storage = fakeStorage(false);
    opened = await openPage({ storage });
    {
      const { win, doc, errors } = opened;
      type(win, doc, 'warmup-not-found');       // 让按需数据就绪，且不按 Enter（不记历史）
      await wait(1400);

      type(win, doc, '机');
      await wait(230);
      type(win, doc, '机器');
      await wait(230);
      type(win, doc, '机器人');
      await wait(230);
      check('H1 逐字输入不保存历史',
        terms(storage).length === 0 && !doc.getElementById('searchHistoryPanel'));

      confirmSearch(win, doc, '机器人');
      await wait(120);
      check('H2 只有用户确认搜索（Enter）才记录',
        terms(storage).join('|') === '机器人' && !!doc.getElementById('searchHistoryPanel'),
        terms(storage).join('|'));
      check('H2b 明确说明历史仅保存在当前浏览器',
        /最近搜索（仅保存在此浏览器）/.test(appText(doc)));

      confirmSearch(win, doc, '机器人');
      await wait(120);
      check('H3 相同关键词去重', terms(storage).length === 1, terms(storage).join('|'));

      confirmSearch(win, doc, '卡尔曼');
      await wait(120);
      confirmSearch(win, doc, 'VLA');
      await wait(120);
      check('H4 最近使用的排最前',
        terms(storage).join('|') === 'VLA|卡尔曼|机器人', terms(storage).join('|'));

      const removed = historyChip(doc, win, 'data-search-history-remove', '卡尔曼');
      const stillThere = Array.prototype.some.call(doc.querySelectorAll('[data-search-history]'),
        n => chipValue(n, 'data-search-history') === '卡尔曼');
      check('H6 单条删除',
        removed && terms(storage).join('|') === 'VLA|机器人' && !stillThere,
        terms(storage).join('|'));

      check('H7 点击历史关键词重新搜索',
        historyChip(doc, win, 'data-search-history', '机器人') &&
        doc.getElementById('searchInput').value === '机器人' &&
        queryKey(doc) === '机器人' && terms(storage)[0] === '机器人' &&
        /找到\s*\d+\s*条/.test(appText(doc)), queryKey(doc));

      check('H8 一键清空且不自动写回旧记录',
        clickEl(win, doc.querySelector('[data-search-history-clear]')) &&
        terms(storage).length === 0 && !doc.getElementById('searchHistoryPanel'));
      clickEl(win, doc.querySelector('[data-search-filter="post"]'));
      check('H8b 后续重绘不会写回已清空的历史',
        !doc.getElementById('searchHistoryPanel') && terms(storage).length === 0 &&
        !Object.prototype.hasOwnProperty.call(storage._data, HISTORY_KEY));
      clickEl(win, doc.querySelector('[data-search-filter="all"]'));

      confirmSearch(win, doc, '共现标记');
      await wait(120);
      check('H10 搜索历史不覆盖 history.state 的回退状态',
        win.eval('history.state && history.state.search') === '共现标记');
      win.location.hash = '#/about';
      await wait(300);
      win.history.back();
      await wait(500);
      check('H10b 前进/后退仍可恢复搜索状态',
        doc.getElementById('searchInput').value === '共现标记' &&
        /找到\s*\d+\s*条/.test(appText(doc)), doc.getElementById('searchInput').value);

      const evil = '<img src=x onerror=alert(1)>';
      confirmSearch(win, doc, evil);
      await wait(150);
      const html = doc.getElementById('app').innerHTML;
      const evilNodes = doc.querySelectorAll('#app img, #app script, #app [onerror]').length;
      check('H11 恶意历史关键词被转义',
        evilNodes === 0 && html.indexOf('<img') === -1 && html.indexOf('&lt;img') !== -1,
        'nodes=' + evilNodes + ' rawImg=' + html.indexOf('<img') + ' escaped=' + html.indexOf('&lt;img'));
      check('H11b 点击恶意历史关键词仍安全',
        historyChip(doc, win, 'data-search-history', evil) &&
        queryKey(doc) === evil &&
        doc.querySelectorAll('#app img, #app [onerror]').length === 0);

      const rawHist = storage._data[HISTORY_KEY] || '[]';
      check('H12 历史数据结构是独立 key 下的纯关键词数组',
        Array.isArray(JSON.parse(rawHist)) &&
        JSON.parse(rawHist).every(x => typeof x === 'string') &&
        !/draft|content|body|indexedDB/i.test(rawHist) &&
        !Object.keys(storage._data).some(k => /draft|history/i.test(k) && k !== HISTORY_KEY),
        Object.keys(storage._data).join(','));

      // ------------------------------------------------ H5 上限 10
      clickEl(win, doc.querySelector('[data-search-history-clear]'));
      for (let i = 1; i <= 12; i++) {
        confirmSearch(win, doc, '关键词-' + i);
        await wait(60);
      }
      check('H5 最多保留 10 条且最新在前',
        terms(storage).length === 10 && terms(storage)[0] === '关键词-12',
        terms(storage).length + ' / ' + terms(storage)[0]);
      check('H5b 清空后重新确认不会带回旧记录',
        terms(storage).every(x => x.indexOf('关键词-') === 0));
      check('H1–H12 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    }
    closeOpened();

    // ------------------------------------------------ H9 localStorage 不可用
    resetState();
    const broken = fakeStorage(true);
    opened = await openPage({ storage: broken });
    {
      const { win, doc, errors } = opened;
      type(win, doc, 'warmup-not-found');
      await wait(1300);
      confirmSearch(win, doc, '机器人');
      await wait(250);
      check('H9 localStorage 不可用时搜索仍正常',
        /找到\s*\d+\s*条/.test(appText(doc)) && !!doc.querySelector('[data-search-root]'));
      check('H9b 明确提示本地存储不可用（内存降级）',
        /无法写入本地存储/.test(appText(doc)) && !!doc.getElementById('searchHistoryPanel'),
        appText(doc).slice(0, 110));
      check('H9c 内存历史仍可用且不影响搜索',
        /机器人/.test(appText(doc)) &&
        doc.querySelectorAll('[data-search-history]').length >= 1);
      check('H9d 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    }
    closeOpened();

    // ------------------------------------------------ H13 数据源部分失败 + 筛选零结果
    resetState();
    state.faults['/js/papers.js'] = 500;
    opened = await openPage();
    {
      const { win, doc, errors } = opened;
      type(win, doc, '机器人');
      await wait(1300);
      check('H13 单源失败不阻断其它类别',
        /📝 文章/.test(appText(doc)) && /📚 课程/.test(appText(doc)) &&
        /论文 \/ 学习资料 ⚠ 加载失败/.test(appText(doc)));
      clickEl(win, doc.querySelector('[data-search-filter="paper"]'));
      const t = appText(doc);
      check('H13b 数据未加载完成时不把临时零结果当最终零结果',
        /该分类的数据源尚未加载完成/.test(t) && !/没有匹配结果/.test(t) &&
        !/没有找到相关内容/.test(t), t.slice(-90));
      delete state.faults['/js/papers.js'];
      check('H13c 失败源仍提供重试入口',
        !!doc.querySelector('[data-retry-search-source="papers"]'));
      clickEl(win, doc.querySelector('[data-retry-search-source="papers"]'));
      await wait(1000);
      check('H13d 重试后数据源恢复',
        win.eval('searchSourceStatus().papers') === 'ready');
      check('H13e 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    }
    closeOpened();

    // ------------------------------------------------ H14 快速输入竞态
    resetState();
    state.delays['/data/search-index.json'] = 800;
    opened = await openPage();
    {
      const { win, doc } = opened;
      type(win, doc, '机器人');
      await wait(300);
      type(win, doc, '最终查询词XYZ');
      await wait(1400);
      check('H14 快速连续输入只显示最新查询',
        queryKey(doc) === '最终查询词XYZ' &&
        doc.getElementById('searchInput').value === '最终查询词XYZ' &&
        appText(doc).indexOf('最终查询词XYZ') !== -1, queryKey(doc));
      check('H14b 快速输入不等于确认搜索，不写历史',
        !doc.getElementById('searchHistoryPanel'));
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
