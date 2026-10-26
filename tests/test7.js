// 验证本轮新增：笔记全文搜索、笔记上下篇/相关、键盘快捷键、canonical、静态页与 SW
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

let pass = true;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + extra + ')' : ''));
  if (!cond) pass = false;
};

server.listen(8132, async () => {
  // ---------- 静态文件检查 ----------
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  // Batch 6B：入口页分支改为 shellNavigate（仍以 './index.html' 为缓存键），
  // 静态笔记页仍按自身 URL 缓存、兜底用离线页 —— 断言意图不变，只是跟着实现改名。
  check('SW 只把入口页写成 index.html 缓存',
    /isAppShell\(url\.pathname\)/.test(sw) &&
    /putRuntime\('\.\/index\.html'/.test(sw) &&
    /putRuntime\(req, resp\.clone\(\)\)/.test(sw) &&
    /offlineResponse\(\)/.test(sw));
  check('SW 运行期缓存有条数上限', /RUNTIME_CACHE_CAP/.test(sw) && /CACHE_RT/.test(sw));
  check('SW 安装期不预取大体积数据脚本', !/CORE_ASSETS\.concat\(OPTIONAL_ASSETS\)/.test(sw));

  const noteFiles = fs.readdirSync(path.join(ROOT, 'notes')).filter(f => f.endsWith('.html'));
  const badCopy = noteFiles.filter(f => /文件清单/.test(fs.readFileSync(path.join(ROOT, 'notes', f), 'utf8')));
  check('静态页不再提“文件清单”', badCopy.length === 0, badCopy.join(','));

  const noTheme = noteFiles.filter(f => !/data-theme/.test(fs.readFileSync(path.join(ROOT, 'notes', f), 'utf8')));
  check('静态页内联主题初始化', noTheme.length === 0, noTheme.join(','));

  const noToggle = noteFiles.filter(f => !/id="themeToggle"/.test(fs.readFileSync(path.join(ROOT, 'notes', f), 'utf8')));
  check('静态页有主题切换按钮', noToggle.length === 0, noToggle.join(','));

  const notePage = fs.readFileSync(path.join(ROOT, 'notes', 'cs422.html'), 'utf8');
  check('静态笔记页有上下篇导航', /post-nav note-nav/.test(notePage));
  const noteIndex = fs.readFileSync(path.join(ROOT, 'notes', 'index.html'), 'utf8');
  check('笔记索引按学科分组', /course-section-title/.test(noteIndex));
  check('笔记索引显示总字数', /共 .* 字/.test(noteIndex));

  const feed = fs.readFileSync(path.join(ROOT, 'feed.xml'), 'utf8');
  check('RSS 有条目', (feed.match(/<item>/g) || []).length > 0, (feed.match(/<item>/g) || []).length + ' 条');

  // ---------- 运行时检查 ----------
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));

  try {
    const dom = await JSDOM.fromURL('http://localhost:8132/index.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
    });
    const { window } = dom;
    const doc = window.document;
    await new Promise(r => window.addEventListener('load', r));
    await wait(400);

    // 1) 课程列表：只存在于笔记正文中的关键词也能搜到，并给出命中片段
    window.location.hash = '#/courses';
    await wait(900);

    const term = window.eval(`(function(){
      var ids = Object.keys(COURSE_NOTES || {});
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var c = COURSES.filter(function(x){ return x.id === id; })[0] || {};
        var text = ((COURSE_NOTES[id] && COURSE_NOTES[id].notes) || '');
        var head = ((c.name || '') + (c.description || '')).toLowerCase();
        var words = text.match(/[A-Za-z][A-Za-z+#.-]{5,}/g) || [];
        for (var j = 0; j < words.length; j++) {
          var w = words[j].toLowerCase();
          if (head.indexOf(w) === -1) return words[j];
        }
      }
      return null;
    })()`);
    check('取自笔记正文的测试关键词', !!term, term);

    const courseInput = doc.getElementById('courseSearchInput');
    courseInput.value = term;
    courseInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(700);
    const cards = doc.querySelectorAll('.course-card').length;
    const hits = doc.querySelectorAll('.course-card-hit').length;
    check('笔记正文可被课程搜索命中', cards >= 1 && hits >= 1, cards + ' 门 / ' + hits + ' 段片段');
    check('命中片段显示次数', /笔记命中 \d+ 处/.test(doc.getElementById('app').textContent));

    // 2) 课程卡片显示笔记字数与阅读时长
    window.location.hash = '#/courses';
    await wait(600);
    check('卡片显示笔记规模', /千字|字 · 约 \d+ 分钟/.test(doc.getElementById('app').textContent));

    // 3) 笔记详情：上下篇 + 同方向推荐 + canonical 指向静态页
    window.location.hash = '#/course/' + encodeURIComponent('香港大学|材料科学');
    await wait(800);
    const app = doc.getElementById('app');
    check('详情页有上下篇导航', !!app.querySelector('.note-nav .post-nav-item'));
    check('详情页有同方向推荐', !!app.querySelector('.related-posts .related-item'));
    check('详情页显示阅读时长', /约 \d+ 分钟/.test(app.textContent));
    const canonical = doc.querySelector('link[rel="canonical"]').getAttribute('href');
    check('canonical 指向静态笔记页', /\/notes\/materials\.html$/.test(canonical), canonical);

    // 4) 快捷键：/ 聚焦搜索，Esc 清空
    window.location.hash = '#/';
    await wait(500);
    doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    await wait(200);
    check('按 / 聚焦搜索框', doc.activeElement && doc.activeElement.id === 'searchInput', doc.activeElement && doc.activeElement.id);

    const searchInput = doc.getElementById('searchInput');
    searchInput.value = '机器人';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(500);
    check('全局搜索有结果', /找到 \d+ 条/.test(doc.getElementById('app').textContent));
    searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(300);
    check('Esc 清空搜索', searchInput.value === '' && !/找到 \d+ 条/.test(doc.getElementById('app').textContent));

    // 5) 主题快捷键 t
    const before = doc.documentElement.getAttribute('data-theme');
    doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 't', bubbles: true }));
    await wait(150);
    check('按 t 切换主题', doc.documentElement.getAttribute('data-theme') !== before,
      before + ' → ' + doc.documentElement.getAttribute('data-theme'));

    check('无脚本运行错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    // 6) 静态笔记页：可正常渲染，主题按钮可用
    const staticErrors = [];
    const vc2 = new VirtualConsole();
    vc2.on('jsdomError', e => staticErrors.push(e.message));
    vc2.on('error', (...a) => staticErrors.push(String(a[0])));
    const dom2 = await JSDOM.fromURL('http://localhost:8132/notes/cs422.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc2
    });
    await new Promise(r => dom2.window.addEventListener('load', r));
    await wait(300);
    const d2 = dom2.window.document;
    check('静态页有正文标题', d2.querySelectorAll('.markdown-body h2').length >= 3, d2.querySelectorAll('.markdown-body h2').length + ' 个');
    const t0 = d2.documentElement.getAttribute('data-theme');
    d2.getElementById('themeToggle').dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true }));
    check('静态页主题按钮生效', d2.documentElement.getAttribute('data-theme') !== t0,
      t0 + ' → ' + d2.documentElement.getAttribute('data-theme'));
    const filtered = staticErrors.filter(m => !/Not implemented|css|Could not parse CSS/i.test(m));
    check('静态页无脚本错误', filtered.length === 0, filtered.slice(0, 2).join(' | '));
  } catch (e) {
    console.error('SMOKE ERROR:', e);
    pass = false;
  } finally {
    console.log(pass ? 'ALL PASS' : 'HAS FAILURES');
    server.close();
    process.exit(pass ? 0 : 1);
  }
});
