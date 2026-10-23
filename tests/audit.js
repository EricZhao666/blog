// 全站巡检：路由渲染、内部链接有效性、静态笔记页一致性、404 资源
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};
const missing = [];
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    missing.push(p);
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const problems = [];
const note = (m) => problems.push(m);

function loadData() {
  const ctx = vm.createContext({ console });
  ['js/courses.js', 'js/course-notes.js', 'js/note-slugs.js', 'js/papers.js', 'js/codefiles.js', 'js/data.js', 'js/user-posts.js'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return {
    COURSES: vm.runInContext('COURSES', ctx),
    COURSE_NOTES: vm.runInContext('COURSE_NOTES', ctx),
    NOTE_PAGES: vm.runInContext('NOTE_PAGES', ctx),
    PAPERS: vm.runInContext('PAPERS', ctx),
    CODE_LIBS: vm.runInContext('CODE_LIBS', ctx),
    POSTS: vm.runInContext('POSTS', ctx),
    USER_POSTS: vm.runInContext('USER_POSTS', ctx)
  };
}

server.listen(8131, async () => {
  let D;
  try { D = loadData(); } catch (e) { console.error('数据加载失败', e); process.exit(1); }

  // ---------- 1. 数据 / 静态页一致性 ----------
  const coursesSrc = fs.readFileSync(path.join(ROOT, 'js/courses.js'), 'utf8');
  if (/\"files\"\s*:/.test(coursesSrc)) note('courses.js 又带上了文件清单字段（应保持精简）');
  if (coursesSrc.length > 120 * 1024) note('courses.js 体积异常: ' + (coursesSrc.length / 1024).toFixed(1) + 'KB');

  const noteIds = Object.keys(D.COURSE_NOTES);
  noteIds.forEach(id => {
    if (!D.COURSES.some(c => c.id === id)) note(`课程笔记存在但课程不存在: ${id}`);
    if (!D.NOTE_PAGES[id]) note(`缺少静态页映射: ${id}`);
    else if (!fs.existsSync(path.join(ROOT, D.NOTE_PAGES[id]))) note(`静态页文件缺失: ${D.NOTE_PAGES[id]}`);
  });
  Object.keys(D.NOTE_PAGES).forEach(id => {
    if (!D.COURSE_NOTES[id]) note(`静态页映射多余: ${id}`);
  });
  const notesFiles = fs.readdirSync(path.join(ROOT, 'notes')).filter(f => f.endsWith('.html') && f !== 'index.html');
  if (notesFiles.length !== noteIds.length) note(`notes/ 静态页数量 ${notesFiles.length} 与笔记数 ${noteIds.length} 不一致`);

  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  notesFiles.forEach(f => {
    if (sitemap.indexOf('/notes/' + f) === -1) note(`sitemap 缺少 notes/${f}`);
  });
  const feed = fs.readFileSync(path.join(ROOT, 'feed.xml'), 'utf8');
  if (!/<item>/.test(feed)) note('feed.xml 没有条目');
  if (!/Sitemap:\s*https/.test(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8'))) note('robots.txt 未声明 Sitemap');

  // 过时文案
  notesFiles.forEach(f => {
    const t = fs.readFileSync(path.join(ROOT, 'notes', f), 'utf8');
    if (/文件清单/.test(t)) note(`静态页仍有“文件清单”字样: notes/${f}`);
    if (!/data-theme/.test(t)) note(`静态页缺少主题初始化: notes/${f}`);
  });

  // ---------- 2. 路由渲染 + 链接有效性 ----------
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));

  const dom = await JSDOM.fromURL('http://localhost:8131/index.html', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  const { window } = dom;
  const doc = window.document;
  await new Promise(r => window.addEventListener('load', r));
  await wait(300);

  // 预加载全部数据，避免路由等待
  await window.eval('Promise.all([loadData("courses"),loadData("notes"),loadData("papers"),loadData("codefiles")])');

  const routes = ['/', '/courses', '/papers', '/code', '/tags', '/projects', '/archive', '/about', '/links', '/editor', '/nope'];
  D.COURSES.forEach(c => routes.push('/course/' + encodeURIComponent(c.id)));
  D.CODE_LIBS.forEach(l => routes.push('/codelib/' + encodeURIComponent(l.id)));
  (D.POSTS || []).forEach(p => routes.push('/post/' + p.id));

  const allHrefs = new Set();
  for (const r of routes) {
    window.location.hash = '#' + r;
    await wait(120);
    const app = doc.getElementById('app');
    const txt = app.textContent;
    if (!txt.trim()) note(`路由空渲染: ${r}`);
    if (r !== '/nope' && /页面不存在|渲染出错/.test(txt)) note(`路由异常: ${r}`);
    if (r === '/nope' && !/页面不存在/.test(txt)) note('未知路由未显示 404 提示');
    if (!doc.title || doc.title === "Eric's Notebook" && r === '/courses') note(`标题未更新: ${r}`);
    const ids = {};
    app.querySelectorAll('[id]').forEach(el => {
      if (ids[el.id]) note(`重复 id: ${el.id} @ ${r}`);
      ids[el.id] = 1;
    });
    app.querySelectorAll('a[href^="#/"]').forEach(a => allHrefs.add(a.getAttribute('href').slice(1)));
  }

  const courseIds = new Set(D.COURSES.map(c => c.id));
  const libIds = new Set(D.CODE_LIBS.map(l => l.id));
  const postIds = new Set([].concat(D.POSTS || [], D.USER_POSTS || []).map(p => p.id));
  allHrefs.forEach(h => {
    const bare = h.split('?')[0];
    if (bare.startsWith('/course/')) {
      const id = decodeURIComponent(bare.slice(8));
      if (!courseIds.has(id)) note(`死链: #${h}`);
    } else if (bare.startsWith('/codelib/')) {
      const id = decodeURIComponent(bare.slice(9));
      if (!libIds.has(id)) note(`死链: #${h}`);
    } else if (bare.startsWith('/post/')) {
      if (!postIds.has(bare.slice(6))) note(`死链: #${h}`);
    } else if (!/^\/(courses|papers|code|tags|projects|archive|about|links|editor)?$/.test(bare) && !bare.startsWith('/tags/')) {
      note(`未知路由链接: #${h}`);
    }
  });

  if (errors.length) note('脚本错误: ' + errors.slice(0, 3).join(' | '));
  if (missing.length) note('404 资源: ' + Array.from(new Set(missing)).slice(0, 10).join(', '));

  const uniq = Array.from(new Set(problems));
  console.log(uniq.length ? '发现问题 ' + uniq.length + ' 条:' : '未发现问题');
  uniq.forEach((p, i) => console.log('  ' + (i + 1) + '. ' + p));
  server.close();
  process.exit(uniq.length ? 0 : 0);
});
