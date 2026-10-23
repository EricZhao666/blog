// 验证：课程区只展示笔记，不再出现文件清单/文件统计
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const wait = ms => new Promise(r => setTimeout(r, ms));

server.listen(8130, async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));

  let pass = true;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
    if (!cond) pass = false;
  };

  try {
    const dom = await JSDOM.fromURL('http://localhost:8130/index.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
    });
    const { window } = dom;
    const { document } = window;
    await new Promise(r => window.addEventListener('load', r));
    await wait(400);

    // 1) 课程列表默认只显示有笔记的课程
    window.location.hash = '#/courses';
    await wait(1000);
    const text = document.getElementById('app').textContent;
    const cards = document.querySelectorAll('.course-card').length;
    check('默认只展示有笔记的课程', cards === 14, cards + ' 门');
    check('页面不再出现“个文件”', !/个文件/.test(text));
    check('页面不再出现总大小', !/GB|总大小/.test(text));
    check('统计改为篇笔记', /篇笔记/.test(text) && /门课程/.test(text));

    // 2) 切换到全部课程
    const chips = document.querySelectorAll('.category-chip');
    const allChip = Array.prototype.find.call(chips, el => /全部课程/.test(el.textContent));
    check('存在“全部课程”切换', !!allChip);
    allChip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(400);
    const allCards = document.querySelectorAll('.course-card').length;
    check('切换后显示全部 45 门', allCards === 45, allCards + ' 门');
    check('无笔记课程标注“暂无笔记”', /暂无笔记/.test(document.getElementById('app').textContent));

    // 3) 课程详情：有笔记 → 只有笔记，没有文件列表
    window.location.hash = '#/course/' + encodeURIComponent('香港大学|材料科学');
    await wait(800);
    const d1 = document.getElementById('app');
    check('详情页有笔记正文', d1.querySelectorAll('.course-notes h2').length >= 5, d1.querySelectorAll('.course-notes h2').length + ' 个标题');
    check('详情页无文件列表', !d1.querySelector('.file-list') && !/文件列表/.test(d1.textContent));
    check('详情页元信息无文件数/大小', !/个文件|GB/.test(d1.querySelector('.course-detail-meta').textContent), d1.querySelector('.course-detail-meta').textContent.replace(/\s+/g, ' ').trim());
    check('详情页保留静态页入口', !!d1.querySelector('.notes-permalink'));

    // 4) 课程详情：无笔记 → 空状态
    const noNoteId = window.eval('COURSES').find(c => !(window.eval('COURSE_NOTES') || {})[c.id]).id;
    window.location.hash = '#/course/' + encodeURIComponent(noNoteId);
    await wait(800);
    check('无笔记课程显示空状态', /还没有整理笔记/.test(document.getElementById('app').textContent));

    // 5) 全局搜索：课程结果显示笔记状态
    window.location.hash = '#/';
    await wait(400);
    const input = document.getElementById('searchInput');
    input.value = '机器人';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(1200);
    const st = document.getElementById('app').textContent;
    check('搜索结果含课程笔记状态', /有笔记|暂无笔记/.test(st));
    check('搜索结果不再显示文件数', !/个文件/.test(st));

    check('无脚本运行错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    console.log(pass ? 'ALL PASS' : 'HAS FAILURES');
  } catch (e) {
    console.error('SMOKE ERROR:', e);
    pass = false;
  } finally {
    server.close();
    process.exit(pass ? 0 : 1);
  }
});
