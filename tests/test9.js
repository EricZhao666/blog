// S0 第一批 Bug 回归测试
//   A. #/about 冷加载时 COURSES 未定义
//   B. 全局搜索异步/延迟重绘覆盖其他路由
//   C. 课程/论文/代码库搜索框重绘后丢失监听器
//   D. 懒加载资源失败后的页面渲染异常（需 BLOCK 环境变量，单独跑一次）
//
// 用法:
//   node test9.js                        # A/B/C
//   set BLOCK=js/courses.js && node test9.js   # D
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const BLOCK = process.env.BLOCK || '';
// 让笔记数据慢一点返回，稳定复现“异步加载完成后覆盖当前路由”
const SLOW = { 'js/course-notes.js': 400 };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const rel = p.replace(/^\//, '');
  if (BLOCK && rel.indexOf(BLOCK) !== -1) {
    res.writeHead(404); res.end('blocked'); return;
  }
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const body = fs.readFileSync(file);
  const delay = SLOW[rel] || 0;
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  }, delay);
});

const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = true;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
  if (!cond) pass = false;
};

function makeDom(url) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));
  return JSDOM.fromURL(url, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  }).then(dom => ({ dom, errors }));
}

server.listen(8134, async () => {
  const unhandled = [];
  process.on('unhandledRejection', e => unhandled.push(String(e && e.message || e)));

  try {
    // ---------- A. #/about 冷加载 ----------
    {
      const { dom, errors } = await makeDom('http://localhost:8134/index.html#/about');
      const doc = dom.window.document;
      await new Promise(r => dom.window.addEventListener('load', r));
      await wait(600);
      const text = doc.getElementById('app').textContent;
      check('A1 #/about 冷加载不出现渲染错误页', !/页面渲染出错/.test(text), text.trim().slice(0, 60));
      check('A2 #/about 正常渲染关于页', /关于这个博客/.test(text));
      check('A3 #/about 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));

      // A4: 数据就绪后仍应显示真实课程数（修复不能把统计信息永久藏掉）
      if (!BLOCK) {
        dom.window.location.hash = '#/courses';
        await wait(1500);
        dom.window.location.hash = '#/about';
        await wait(400);
        const t2 = doc.getElementById('app').textContent;
        check('A4 数据就绪后显示真实课程数', /覆盖 45 门课程/.test(t2), t2.match(/覆盖[^，]*门/));
      }
      dom.window.close();
    }

    // ---------- B. 全局搜索覆盖其他路由 ----------
    {
      const { dom } = await makeDom('http://localhost:8134/index.html#/');
      const doc = dom.window.document;
      await new Promise(r => dom.window.addEventListener('load', r));
      await wait(400);

      // B1: 输入后在防抖窗口内跳转（180ms 内）
      const si = doc.getElementById('searchInput');
      si.value = '机器人';
      si.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      dom.window.location.hash = '#/papers';
      await wait(600);
      const app = doc.getElementById('app');
      check('B1 防抖重绘不覆盖已跳转的论文页',
        !!doc.getElementById('paperSearchInput') && !/search-results-count/.test(app.innerHTML),
        app.textContent.trim().slice(0, 50));

      // B2: 全局搜索触发按需加载，加载完成后不得覆盖后来进入的路由
      dom.window.location.hash = '#/';
      await wait(500);
      const si2 = doc.getElementById('searchInput');
      si2.value = '卡尔曼';       // 只有正文命中的关键词，确保会拉取 courses/papers/notes
      si2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await wait(300);            // 防抖已触发，course-notes.js 仍在慢速返回（400ms）
      dom.window.location.hash = '#/papers';
      await wait(1200);           // 等所有懒加载完成
      check('B2 异步数据到齐后不覆盖当前路由',
        !!doc.getElementById('paperSearchInput'),
        doc.getElementById('app').textContent.trim().slice(0, 50));
      dom.window.close();
    }

    // ---------- C. 搜索框重绘后丢失监听器 ----------
    if (!BLOCK) {
      const { dom, errors } = await makeDom('http://localhost:8134/index.html#/courses');
      const doc = dom.window.document;
      await new Promise(r => dom.window.addEventListener('load', r));
      await wait(1500);           // 等待 courses + 慢速 notes

      const i1 = doc.getElementById('courseSearchInput');
      check('C0 课程页搜索框存在', !!i1);
      i1.value = '机器';
      i1.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await wait(700);

      const i2 = doc.getElementById('courseSearchInput');
      check('C1 搜索触发重绘（输入框被替换）', i2 && i2 !== i1);
      check('C2 重绘后的输入框重新绑定监听', i2 && i2.dataset.liveSearch === '1',
        i2 && String(i2.dataset.liveSearch));

      i2.value = '微系统';
      i2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await wait(700);
      const cards = doc.querySelectorAll('.course-card').length;
      check('C3 重绘后继续输入仍能过滤', cards === 1, cards + ' 张卡片');
      check('C4 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      dom.window.close();
    }
  } catch (e) {
    console.error('SMOKE ERROR:', e);
    pass = false;
  }

  // ---------- D. 懒加载失败 ----------
  if (BLOCK) {
    try {
      const { dom, errors } = await makeDom('http://localhost:8134/index.html#/courses');
      const doc = dom.window.document;
      await new Promise(r => dom.window.addEventListener('load', r));
      await wait(1500);
      const text = doc.getElementById('app').textContent;
      check('D1 资源加载失败不抛渲染异常', !/页面渲染出错/.test(text), text.trim().slice(0, 70));
      check('D2 提供重试入口', /重试/.test(text));
      // 模拟的 404 网络错误本身会被 jsdom 记录，这里只关心脚本逻辑错误
      const filtered = errors.filter(m => !/404|Not implemented|Could not load script/i.test(m));
      check('D3 无未捕获脚本错误', filtered.length === 0, filtered.slice(0, 2).join(' | '));
      dom.window.close();
    } catch (e) {
      console.error('SMOKE ERROR(D):', e);
      pass = false;
    }
  }

  if (unhandled.length) {
    check('Z 无未处理的 Promise 拒绝', false, unhandled.slice(0, 2).join(' | '));
  }

  console.log(pass ? 'ALL PASS' : 'HAS FAILURES');
  server.close();
  process.exit(pass ? 0 : 1);
});
