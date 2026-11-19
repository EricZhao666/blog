// Batch 8C-1：全站搜索 2.0 —— 统一结果模型 / 相关性排序 / 安全高亮 / 深链稳定性
//
// 使用公开数据与合成 Fixture（不访问私人 Zotero / Registry）：
//   通过本地静态服务器加载真实站点，再在内存里替换四类数据数组，
//   断言 collectSearchResults()（纯计算）与 applyGlobalSearch()（DOM 渲染）的行为。
//
// 用法：node tests/test39_search_ranking.js
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

// ---------------------------------------------------------------- 合成 Fixture
function fixture() {
  const D = '2026-05-01';
  const posts = [
    { id: 'rank-exact', title: '机器人', date: D, tags: ['控制'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'rank-prefix', title: '机器人控制综述', date: D, tags: ['控制'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'rank-partial', title: '浅谈机器人学', date: D, tags: ['控制'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'rank-tag', title: '控制理论入门', date: D, tags: ['机器人'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'rank-excerpt', title: '控制理论入门', date: D, tags: ['控制'], excerpt: '这篇摘要提到机器人运动学', content: '普通正文' },
    { id: 'rank-body', title: '控制理论入门', date: D, tags: ['控制'], excerpt: '普通摘要', content: '机器人 机器人 机器人 普通正文' },
    { id: 'rank-body-long', title: '控制理论入门', date: D, tags: ['控制'], excerpt: '普通摘要', content: '机器人'.repeat(80) + ' 收尾' },
    { id: 'rank-stable-a', title: '同分甲', date: D, tags: ['机器人'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'rank-stable-b', title: '同分乙', date: D, tags: ['机器人'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'case-en', title: 'Embodied AI 机器人', date: D, tags: ['英文'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'mix-zh-en', title: 'VLA 模型中文指南', date: D, tags: ['模型'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'mix-cross', title: '控制理论', date: D, tags: ['VLA'], excerpt: '中文入门材料', content: '普通正文' },
    { id: 'xss-post', title: '<img src=x onerror=alert(1)> 机器人', date: D, tags: ['安全'], excerpt: '普通摘要', content: '普通正文' },
    { id: 'uniq-body', title: '唯一正文文章', date: D, tags: ['唯一'], excerpt: '普通摘要', content: '开头若干文字……蓝鲸螺栓校准……结尾若干文字' },
    { id: 'common-post', title: '共现标记 文章', date: D, tags: ['公共'], excerpt: '摘要', content: '正文' }
  ];
  const courses = [
    { id: 'course-robot', name: '机器人学导论', category: '机器人与自动化', description: '课程简介' },
    { id: 'course-note', name: '控制课程', category: '控制', description: '课程简介' },
    { id: 'course-common', name: '共现标记 课程', category: '综合', description: '课程简介' }
  ];
  const notes = {
    'course-note': { summary: '课程笔记摘要', notes: '## 状态估计\n\n卡尔曼滤波与粒子滤波的推导过程。' },
    'course-robot': { summary: '机器人学笔记', notes: '正逆运动学。' }
  };
  const papers = [
    { id: 'paper-robot-1', title: '机器人步态控制论文', authors: 'Zhang San', category: '双足机器人', abstract: 'This work studies 势函数塑形奖励 for locomotion.' },
    { id: 'paper-common', title: '共现标记 论文', authors: 'Li Si', category: '综合', abstract: '普通摘要' }
  ];
  const materials = [
    { id: 'lm-900001', name: '有限元讲义.pdf', category: 'ANSYS仿真', subcategory: '有限元分析', type: 'PDF' },
    { id: 'lm-900002', name: '共现标记 资料.pdf', category: 'CAD建模', subcategory: '第一课', type: 'PDF' },
    { name: '无ID旧资料.pdf', category: 'CAD建模', subcategory: '旧分类', type: 'PDF' }
  ];
  return { posts, courses, notes, papers, materials };
}

function injectFixture(win, f) {
  // const 数组可以 splice/push；COURSE_NOTES 是 const 对象，按 key 替换
  win.eval('POSTS.splice(0, POSTS.length); USER_POSTS.length = 0;' +
    'COURSES.splice(0, COURSES.length); PAPERS.splice(0, PAPERS.length);' +
    'LEARNING_MATERIALS.splice(0, LEARNING_MATERIALS.length);' +
    'Object.keys(COURSE_NOTES).forEach(function (k) { delete COURSE_NOTES[k]; });');
  const arrays = [
    ['POSTS', f.posts], ['COURSES', f.courses],
    ['PAPERS', f.papers], ['LEARNING_MATERIALS', f.materials]
  ];
  arrays.forEach(function (pair) {
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
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(s)) {
      errors.push(s);
    }
  };
  vc.on('jsdomError', e => collect(e.message));
  vc.on('error', (...a) => collect(String(a[0])));
  const dom = await JSDOM.fromURL(BASE + '/index.html#/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  await new Promise(r => dom.window.addEventListener('load', r));
  await wait(120);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

function idsOf(bundle, type) {
  return bundle.groups[type].map(r => r.id);
}

function scoreOf(bundle, type, id) {
  const r = bundle.groups[type].filter(x => x.id === id)[0];
  return r ? r.score : -1;
}

const REQUIRED_FIELDS = ['type', 'id', 'title', 'description', 'matchedFields', 'score', 'targetUrl', 'snippet'];

(async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  PORT = server.address().port;
  BASE = 'http://localhost:' + PORT;

  let dom = null;
  try {
    const ctx = await openPage();
    const { win, doc, errors } = ctx;
    dom = ctx.dom;

    // 首次搜索按需加载四类数据源，之后注入合成 Fixture 做确定性断言
    const warm = doc.getElementById('searchInput');
    warm.value = 'warmup-not-found';
    warm.dispatchEvent(new win.Event('input', { bubbles: true }));
    await wait(1400);
    const warmStatus = win.eval('searchSourceStatus()');
    check('四类按需数据源均已就绪',
      ['posts', 'courses', 'notes', 'papers', 'docs'].every(k => warmStatus[k] === 'ready'),
      JSON.stringify(warmStatus));

    injectFixture(win, fixture());

    // ---------------------------------------------------------- 1. 统一结果模型
    const all = win.collectSearchResults('共现标记');
    const flat = [].concat(all.groups.post, all.groups.course, all.groups.paper, all.groups.material);
    check('统一模型：四类结果都有记录',
      ['post', 'course', 'paper', 'material'].every(t => all.groups[t].length >= 1),
      ['post', 'course', 'paper', 'material'].map(t => t + '=' + all.groups[t].length).join(' '));
    check('统一模型：字段完整且类型正确', flat.length > 0 && flat.every(function (r) {
      return REQUIRED_FIELDS.every(k => Object.prototype.hasOwnProperty.call(r, k)) &&
        typeof r.score === 'number' && Array.isArray(r.matchedFields) &&
        typeof r.targetUrl === 'string' && r.targetUrl.length > 0 && typeof r.id === 'string';
    }), flat.length + ' 条');
    check('统一模型：跨类型结果未被破坏', all.total === flat.length && all.total >= 4, all.total);

    // ---------------------------------------------------------- 2. 相关性排序
    const rank = win.collectSearchResults('机器人');
    const ids = idsOf(rank, 'post');
    const chain = ['rank-exact', 'rank-prefix', 'rank-partial', 'rank-tag', 'rank-excerpt', 'rank-body'];
    const chainOk = chain.every(function (id, i) {
      if (i === 0) return ids[0] === id;
      return ids.indexOf(chain[i - 1]) !== -1 && ids.indexOf(id) !== -1 &&
        ids.indexOf(chain[i - 1]) < ids.indexOf(id);
    });
    check('标题完整匹配排第一', ids[0] === 'rank-exact', ids.slice(0, 4).join(','));
    check('标题 > 标签 > 摘要 > 正文 的确定性优先级', chainOk, ids.slice(0, 10).join(','));
    const scores = chain.map(id => scoreOf(rank, 'post', id));
    check('评分严格递减', scores.every((v, i) => i === 0 || scores[i - 1] > v), scores.join(' > '));
    check('标题命中优于普通正文命中',
      scoreOf(rank, 'post', 'rank-partial') > scoreOf(rank, 'post', 'rank-body'));

    // ---------------------------------------------------------- 3. 稳定排序 / 命中封顶
    check('同分结果保持原始顺序',
      ids.indexOf('rank-tag') < ids.indexOf('rank-stable-a') &&
      ids.indexOf('rank-stable-a') < ids.indexOf('rank-stable-b'),
      [ids.indexOf('rank-tag'), ids.indexOf('rank-stable-a'), ids.indexOf('rank-stable-b')].join(','));
    check('长文重复命中不无限加分',
      scoreOf(rank, 'post', 'rank-body') === scoreOf(rank, 'post', 'rank-body-long') &&
      scoreOf(rank, 'post', 'rank-body-long') < scoreOf(rank, 'post', 'rank-excerpt'),
      scoreOf(rank, 'post', 'rank-body') + ' / ' + scoreOf(rank, 'post', 'rank-excerpt'));
    check('同分长文按原始顺序排列',
      ids.indexOf('rank-body') < ids.indexOf('rank-body-long'));
    const again = win.collectSearchResults('机器人');
    check('重复查询结果顺序一致',
      idsOf(again, 'post').join('|') === ids.join('|'));

    // ---------------------------------------------------------- 4. 中文 / 大小写 / 中英混合
    check('中文关键词命中（不区分语言）', ids.indexOf('rank-partial') !== -1);
    check('英文大小写不敏感',
      idsOf(win.collectSearchResults('embodied ai'), 'post').indexOf('case-en') !== -1);
    check('中英文混合关键词（标题多词）',
      idsOf(win.collectSearchResults('VLA 中文'), 'post').indexOf('mix-zh-en') !== -1);
    const mixed = win.collectSearchResults('VLA 中文');
    check('中英文混合跨字段 AND 也命中，且优先级最低',
      idsOf(mixed, 'post').indexOf('mix-cross') !== -1 &&
      scoreOf(mixed, 'post', 'mix-cross') < scoreOf(mixed, 'post', 'mix-zh-en'),
      scoreOf(mixed, 'post', 'mix-cross') + ' < ' + scoreOf(mixed, 'post', 'mix-zh-en'));

    // ---------------------------------------------------------- 5. 正文 / 笔记 / 摘要 / 类别
    const body = win.collectSearchResults('蓝鲸螺栓校准');
    check('文章正文全文搜索', idsOf(body, 'post').join(',') === 'uniq-body', idsOf(body, 'post').join(','));
    check('正文片段带来源且限长',
      body.groups.post[0] && body.groups.post[0].snippet &&
      body.groups.post[0].snippet.source === '正文' &&
      body.groups.post[0].snippet.text.length <= 160 &&
      body.groups.post[0].snippet.html.indexOf('<mark') !== -1);
    const note = win.collectSearchResults('卡尔曼滤波');
    check('课程笔记正文搜索', idsOf(note, 'course').indexOf('course-note') !== -1);
    check('课程笔记命中片段',
      note.groups.course[0] && note.groups.course[0].snippet &&
      note.groups.course[0].snippet.source === '课程笔记');
    const paper = win.collectSearchResults('势函数塑形奖励');
    check('论文 Abstract 搜索', idsOf(paper, 'paper').indexOf('paper-robot-1') !== -1);
    check('论文显示作者与摘要片段',
      paper.groups.paper[0] && paper.groups.paper[0].description === 'Zhang San' &&
      paper.groups.paper[0].snippet.source === '论文摘要');
    const mat = win.collectSearchResults('有限元分析');
    check('学习资料类别匹配', idsOf(mat, 'material').indexOf('lm-900001') !== -1);
    check('学习资料显示资料类别',
      mat.groups.material[0] && mat.groups.material[0].matchedFields.indexOf('subcategory') !== -1 &&
      mat.groups.material[0].description.indexOf('ANSYS仿真') !== -1);

    // ---------------------------------------------------------- 6. 安全高亮 / XSS
    const payload = '<img src=x onerror=alert(1)>';
    win.applyGlobalSearch(payload);
    const appHtml = doc.getElementById('app').innerHTML;
    const evilNodes = doc.querySelectorAll('#app img, #app script, #app [onerror]');
    check('XSS：未创建可执行元素',
      evilNodes.length === 0 && appHtml.indexOf('<img') === -1,
      'nodes=' + evilNodes.length + ' rawImg=' + appHtml.indexOf('<img') +
      ' sample=' + appHtml.slice(Math.max(0, appHtml.indexOf('<img') - 40), appHtml.indexOf('<img') + 60));
    check('XSS：用户输入被 HTML 转义', appHtml.indexOf('&lt;img') !== -1);
    check('XSS：转义后仍安全高亮',
      doc.querySelectorAll('#app mark.search-hit').length > 0);
    check('XSS：无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    // ---------------------------------------------------------- 7. 深链与稳定 ID
    check('文章使用原有 #/post/<id> 路由',
      all.groups.post[0].targetUrl === '#/post/' + all.groups.post[0].id,
      all.groups.post[0].targetUrl);
    check('课程使用原有 #/course/<id> 路由',
      all.groups.course[0].targetUrl.indexOf('#/course/') === 0,
      all.groups.course[0].targetUrl);
    check('论文深链使用持久 ID（Batch 7B-2）',
      /kind=paper&target=paper-common/.test(all.groups.paper[0].targetUrl),
      all.groups.paper[0].targetUrl);
    check('资料深链使用持久 ID（Batch 7B-2）',
      /kind=material&target=lm-900002/.test(all.groups.material[0].targetUrl),
      all.groups.material[0].targetUrl);
    const legacy = win.collectSearchResults('无ID旧资料');
    check('旧资料回退稳定键而非数组下标',
      legacy.groups.material[0] && legacy.groups.material[0].id.indexOf('lgx:') === 0 &&
      !/^\d+$/.test(legacy.groups.material[0].id),
      legacy.groups.material[0] && legacy.groups.material[0].id);
    check('所有结果 ID 都不是纯数字下标',
      flat.every(r => !/^\d+$/.test(String(r.id))));
    win.eval('LEARNING_MATERIALS.reverse();');
    const reordered = win.collectSearchResults('有限元分析');
    check('数据重排后资料 ID 与深链不变',
      reordered.groups.material[0].id === 'lm-900001' &&
      /target=lm-900001/.test(reordered.groups.material[0].targetUrl),
      reordered.groups.material[0].targetUrl);

    // ---------------------------------------------------------- 8. 性能（计算不重复解析语料）
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) win.collectSearchResults('机器人');
    const elapsed = Date.now() - t0;
    check('100 次相关性计算耗时可控（< 800ms）', elapsed < 800, elapsed + 'ms');
    check('搜索结果区只生成一次容器',
      doc.querySelectorAll('#app [data-search-root]').length === 1);

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
