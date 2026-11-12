/**
 * Batch 7C-1：发布链路专项复现（P1–P16）—— Batch 8A 起为**历史取证脚本**
 *
 * 状态（Batch 8A）：编辑器已删除 publishPost() 与整条 GitHub Contents API 直写链路，
 * 因此本脚本的 A 部分（P1–P9）**无法再运行**，也不会被 scripts/run_tests.py 收录。
 * 保留原因：它是 BATCH7C1_REPRODUCTION.md 的取证材料，删除会让历史报告失去可追溯性。
 * 新契约的等价保障见 tests/test24_publish_queue.js（入口下线）与 tests/test32_editor_export.js（导出契约）。
 *
 * 这是一份**审计取证**脚本，不是回归门禁：它按现状跑真实代码，把"能复现/不能复现"打印出来，
 * 供 BATCH7C1_REPRODUCTION.md 引用。因此它不会被 scripts/run_tests.py 收录
 * （其中若干场景的当前结果就是缺陷，收录进去会让 CI 常红）。
 *
 * 两部分：
 *   A. P1–P9   ：jsdom 里跑**真实的 publishPost()**，fetch 全量替换为内存版 GitHub Contents API
 *                （不访问网络、不需要 Token、不触碰真实仓库）。
 *   B. P10–P16 ：在临时目录里跑**真实的生成器**（gen_feed.py / scripts/split_posts.py），
 *                用真实仓库文件的副本做 Fixture。
 *
 * 用法：node tests/batch7c1/publish_scenarios.js
 * 退出码：0 = 取证跑完（不代表全部场景通过）；2 = 环境不可用（jsdom 缺失等）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8141;
const BASE = 'http://localhost:' + PORT;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8'
};

const wait = ms => new Promise(r => setTimeout(r, ms));
const sha256 = p => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let pass = 0, fail = 0;
const rows = [];

/**
 * @param {string} id     场景编号
 * @param {string} name   场景名
 * @param {boolean} ok    预期是否成立
 * @param {string} detail 观测
 * @param {string} verdict 'defect' | 'ok' | 'na'
 */
function record(id, name, ok, detail, verdict) {
  if (ok) pass++; else fail++;
  rows.push({ id, name, ok, detail: String(detail), verdict: verdict || (ok ? 'ok' : 'defect') });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag} ${id} ${name}  (${detail})`);
}

// ------------------------------------------------------------------ 静态服务（只读真实仓库）
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// ------------------------------------------------------------------ 内存版 GitHub Contents API
function makeRepo(initialText) {
  return { 'js/user-posts.js': { text: initialText, sha: 'sha-1', v: 1 } };
}

function jsonResp(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

/**
 * modes:
 *   ok           正常
 *   get-corrupt  200 但 content 不是合法 base64/JSON
 *   get-404      GET 404（当作新建）
 *   get-large    200 + encoding:none（模拟 >1MB）
 *   get-500      GET 500
 *   put-409      PUT 409（并发写）
 *   put-500      PUT 500
 *   network      fetch 直接 reject
 */
function makeFetch(repo, modes) {
  const m = modes || {};
  const hits = { get: 0, put: 0, paths: [] };
  const fetchImpl = (url, init) => {
    const method = ((init && init.method) || 'GET').toUpperCase();
    const u = String(url);
    if (m.network) return Promise.reject(new TypeError('Failed to fetch'));
    if (u.indexOf('api.github.com') === -1) return Promise.reject(new Error('unexpected url ' + u));

    if (method === 'GET') {
      hits.get++;
      if (m.getStatus === 500) return jsonResp(500, { message: 'Server Error' });
      const rec = repo['js/user-posts.js'];
      if (!rec || m.getStatus === 404) return jsonResp(404, { message: 'Not Found' });
      if (m.getLarge) return jsonResp(200, { sha: rec.sha, size: 2000000, encoding: 'none', content: '' });
      if (m.getCorrupt) {
        return jsonResp(200, { sha: rec.sha, size: rec.text.length, encoding: 'base64', content: Buffer.from('const USER_POSTS = [{{{;', 'utf8').toString('base64') });
      }
      return jsonResp(200, {
        sha: rec.sha, size: rec.text.length, encoding: 'base64',
        content: Buffer.from(rec.text, 'utf8').toString('base64')
      });
    }

    if (method === 'PUT') {
      hits.put++;
      hits.paths.push('js/user-posts.js');
      if (m.putStatus === 409) return jsonResp(409, { message: 'sha does not match' });
      if (m.putStatus === 500) return jsonResp(500, { message: 'Server Error' });
      const body = JSON.parse(init.body);
      if (body.sha && repo['js/user-posts.js'] && body.sha !== repo['js/user-posts.js'].sha) {
        return jsonResp(409, { message: 'sha does not match' });
      }
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      repo['js/user-posts.js'] = { text, sha: 'sha-' + (++repo['js/user-posts.js'].v || 2), v: (repo['js/user-posts.js'].v || 1) + 1 };
      return jsonResp(200, { content: { sha: repo['js/user-posts.js'].sha } });
    }
    return jsonResp(405, { message: 'Method Not Allowed' });
  };
  fetchImpl.hits = hits;
  return fetchImpl;
}

function openPage(hash) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView|window\.scroll)/.test(e.message)) {
      errors.push(e.message);
    }
  });
  vc.on('error', (...a) => errors.push(String(a[0])));
  const dom = JSDOM.fromURL(BASE + '/index.html' + (hash || ''), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: {
      interceptors: [requestInterceptor(async request => {
        const url = String(request.url);
        if (url.indexOf(BASE) === 0) return undefined;
        return new Response('/* blocked by 7c1 */', { status: 200, headers: { 'Content-Type': 'application/javascript' } });
      })]
    }
  });
  return Promise.resolve(dom).then(async d => {
    await new Promise(r => d.window.addEventListener('load', r));
    await wait(350);
    return { dom: d, window: d.window, doc: d.window.document, errors };
  });
}

async function publish(window, doc, title, content) {
  window.sessionStorage.setItem('gh_token', 'fake-token');
  window.localStorage.setItem('gh_owner', 'demo');
  window.localStorage.setItem('gh_repo', 'demo-blog');
  window.location.hash = '#/editor';
  await wait(260);
  doc.getElementById('editorTitle').value = title;
  doc.getElementById('editorExcerpt').value = '摘要（与正文关键词无关）';
  doc.getElementById('editorContent').value = content;
  await window.publishPost();
  await wait(120);
}

function statusText(doc) {
  const el = doc.getElementById('editorStatus');
  return el ? el.textContent : '(no status)';
}

// ------------------------------------------------------------------ B 部分：Fixture 目录
function makeFixture(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7c1-' + tag + '-'));
  const copy = (rel) => {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dst);
  };
  ['js/data.js', 'js/user-posts.js', 'data/search-index.json', 'data/posts/manifest.json', 'feed.xml'].forEach(copy);
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'posts'))) {
    if (f.endsWith('.md')) copy(path.join('data', 'posts', f));
  }
  return dir;
}

function py(args, cwd) {
  const r = spawnSync('python', args, {
    cwd: cwd || ROOT,
    encoding: 'utf8',
    // Windows 下子进程默认按 cp936 写管道，Node 按 utf8 解会变乱码（会误判"有没有警告"）
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function genFeed(dir, check) {
  const args = ['gen_feed.py',
    '--data', path.join(dir, 'js', 'data.js'),
    '--user-posts', path.join(dir, 'js', 'user-posts.js'),
    '--out', path.join(dir, 'feed.xml'),
    '--now', '2026-11-09T00:00:00Z'];
  if (check) args.push('--check');
  return py(args, ROOT);
}

function splitCheck(dir) {
  return py(['scripts/split_posts.py', '--check', '--root', dir], ROOT);
}

function splitSync(dir, prune) {
  const args = ['scripts/split_posts.py', '--sync', '--root', dir];
  if (prune) args.push('--prune');
  return py(args, ROOT);
}

// ------------------------------------------------------------------ 主流程
(async () => {
  await new Promise(r => server.listen(PORT, r));

  // ============================================================ A. 编辑器发布 P1–P9
  const originUserPosts = fs.readFileSync(path.join(ROOT, 'js', 'user-posts.js'), 'utf8');

  // ---------- P1 新增文章：写哪儿、没写哪儿
  {
    const repo = makeRepo(originUserPosts);
    const fetchImpl = makeFetch(repo, {});
    const { dom, window, doc } = await openPage('#/editor');
    window.fetch = fetchImpl;
    await publish(window, doc, 'Batch7C1 新增文章', '# 新增\n\n正文唯一词：蓝鲸螺栓校准。\n');
    const after = repo['js/user-posts.js'].text;
    const parsed = window.eval('USER_POSTS.length');
    record('P1', '新增文章：只写 js/user-posts.js，md/搜索语料/清单/feed 全未更新',
      fetchImpl.hits.put === 1 && fetchImpl.hits.paths.length === 1 &&
      fetchImpl.hits.paths[0] === 'js/user-posts.js' && parsed === 1 &&
      /const USER_POSTS = \[/.test(after) && /蓝鲸螺栓校准/.test(after) &&
      !/data\/posts|search-index|manifest/.test(fetchImpl.hits.paths.join(',')),
      `PUT=${fetchImpl.hits.put} path=${fetchImpl.hits.paths.join(',')} 内存=${parsed} 条`, 'defect');
    dom.window.close();
  }

  // ---------- P2 修改已有文章：编辑器没有更新路径
  {
    const repo = makeRepo(originUserPosts);
    const fetchImpl = makeFetch(repo, {});
    const { dom, window, doc } = await openPage('#/editor');
    window.fetch = fetchImpl;
    await publish(window, doc, 'Batch7C1 同名文章', '# 第一版\n\n正文词：甲版内容。\n');
    await publish(window, doc, 'Batch7C1 同名文章', '# 第二版\n\n正文词：乙版内容。\n');
    const parsed = window.eval('USER_POSTS.map(function(p){return p.id})');
    const sameTitle = window.eval('USER_POSTS.filter(function(p){return p.title==="Batch7C1 同名文章"}).length');
    record('P2', '同标题再发布 = 新增一条（无"更新"路径，产生重复文章）',
      parsed.length === 2 && sameTitle === 2 && parsed[0] !== parsed[1],
      `条数=${parsed.length} 同标题=${sameTitle} id不同=${parsed[0] !== parsed[1]}`, 'defect');
    dom.window.close();
  }

  // ---------- P3 删除：无 UI/无 API 调用
  {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    const hasDelete = /method:\s*'DELETE'/.test(src) || /删除文章|deletePost/.test(src);
    record('P3', '编辑器没有删除文章的能力（只能手改文件）', !hasDelete,
      hasDelete ? '发现 DELETE/删除入口' : 'app.js 中无 DELETE 请求、无删除入口', 'defect');
  }

  // ---------- P4 文章 ID 冲突（同毫秒 + 无查重）
  {
    const { dom, window } = await openPage('#/');
    const ids = window.eval(`(function () {
      var realNow = Date.now;
      Date.now = function () { return 1700000000000; };
      var a = generatePostId('同一个标题');
      var b = generatePostId('同一个标题');
      var c = generatePostId('Embodied AI Notes');
      Date.now = realNow;
      return { a: a, b: b, c: c, taken: POSTS.map(function (p) { return p.id; }).indexOf(c) !== -1 };
    })()`);
    record('P4', 'ID = slug + 毫秒时间戳；同毫秒生成同一个 ID，且不与内置文章查重',
      ids.a === ids.b && ids.c === ids.c.toLowerCase(),
      `a=${ids.a} b=${ids.b} 与内置同名=${ids.c} 冲突=${ids.taken}`, 'defect');
    dom.window.close();
  }

  // ---------- P5 GET 200 但内容损坏
  {
    const repo = makeRepo(originUserPosts);
    const fetchImpl = makeFetch(repo, { getCorrupt: true });
    const { dom, window, doc } = await openPage('#/editor');
    window.fetch = fetchImpl;
    await publish(window, doc, 'P5 损坏内容', '# x\n');
    record('P5', 'GET 200 + 内容损坏 → 中止且不发 PUT（历史未被覆盖）',
      fetchImpl.hits.put === 0 && /发布失败/.test(statusText(doc)),
      `PUT=${fetchImpl.hits.put} status=${statusText(doc).slice(0, 40)}`, 'ok');
    dom.window.close();
  }

  // ---------- P6 GET 404 → 当作新建（无 sha 覆盖已有文件的风险）
  {
    const repo = makeRepo(originUserPosts);
    const fetchImpl = makeFetch(repo, { getStatus: 404 });
    const { dom, window, doc } = await openPage('#/editor');
    window.fetch = fetchImpl;
    await publish(window, doc, 'P6 404', '# x\n');
    const body = repo['js/user-posts.js'].text;
    record('P6', 'GET 404 → 按新建提交（不带 sha），若 404 是误判会覆盖历史',
      fetchImpl.hits.put === 1 && /P6 404/.test(body) && !/const USER_POSTS = \[\s*\];/.test(body),
      `PUT=${fetchImpl.hits.put} 结果含旧内容=${/embodied|第一版/.test(body)}`, 'defect');
    dom.window.close();
  }

  // ---------- P7 超过 Contents API 读取上限
  {
    const repo = makeRepo(originUserPosts);
    const fetchImpl = makeFetch(repo, { getLarge: true });
    const { dom, window, doc } = await openPage('#/editor');
    window.fetch = fetchImpl;
    await publish(window, doc, 'P7 超大文件', '# x\n');
    record('P7', 'encoding=none（>1MB）→ 中止且不发 PUT',
      fetchImpl.hits.put === 0 && /1MB|无法完整读取/.test(statusText(doc)),
      `PUT=${fetchImpl.hits.put} status=${statusText(doc).slice(0, 50)}`, 'ok');
    dom.window.close();
  }

  // ---------- P8 并发写 → 409
  {
    const repo = makeRepo(originUserPosts);
    const fetchImpl = makeFetch(repo, { putStatus: 409 });
    const { dom, window, doc } = await openPage('#/editor');
    window.fetch = fetchImpl;
    await publish(window, doc, 'P8 并发冲突', '# x\n');
    record('P8', 'PUT 409 → 提示版本冲突并保留历史（不重试、不覆盖）',
      fetchImpl.hits.put === 1 && /冲突/.test(statusText(doc)),
      `PUT=${fetchImpl.hits.put} status=${statusText(doc).slice(0, 40)}`, 'ok');
    dom.window.close();
  }

  // ---------- P9 网络中断 / 5xx
  {
    const repo = makeRepo(originUserPosts);
    const f1 = makeFetch(repo, { getStatus: 500 });
    const s1 = await openPage('#/editor');
    s1.window.fetch = f1;
    await publish(s1.window, s1.doc, 'P9 5xx', '# x\n');
    const st1 = statusText(s1.doc);
    s1.dom.window.close();

    const repo2 = makeRepo(originUserPosts);
    const f2 = makeFetch(repo2, { network: true });
    const s2 = await openPage('#/editor');
    s2.window.fetch = f2;
    await publish(s2.window, s2.doc, 'P9 断网', '# x\n');
    const st2 = statusText(s2.doc);
    const draft = s2.window.localStorage.getItem('blog_draft') || '';
    s2.dom.window.close();

    record('P9', 'GET 5xx / 网络中断 → 中止、不发 PUT、草稿保留',
      f1.hits.put === 0 && f2.hits.put === 0 && /网络请求失败/.test(st2) && /P9 断网/.test(draft),
      `5xx: PUT=${f1.hits.put} "${st1.slice(0, 24)}"; 断网: PUT=${f2.hits.put} 草稿=${!!draft}`, 'ok');
  }

  // ============================================================ B. 生成器链路 P10–P16
  const fixture = makeFixture('main');

  // ---------- P10 提交成功但 RSS 未生成
  {
    const before = genFeed(fixture, true);
    // 模拟"刚发布但没跑生成器"
    const upText = originUserPosts.replace('const USER_POSTS = [];',
      'const USER_POSTS = [{"id":"batch7c1-new","title":"刚发布的文章","date":"2026-11-09","tags":["测试"],"excerpt":"e","content":"# n\\n"}];');
    fs.writeFileSync(path.join(fixture, 'js', 'user-posts.js'), upText);
    const after = genFeed(fixture, true);
    record('P10', '文章已提交、RSS 未重生成 → feed --check 失败（CI 会红）',
      before.code === 0 && after.code !== 0,
      `提交前 check=${before.code} 提交后 check=${after.code}`, 'defect');
  }

  // ---------- P11 RSS 生成失败不落盘
  {
    const feedPath = path.join(fixture, 'feed.xml');
    const h0 = sha256(feedPath);
    fs.writeFileSync(path.join(fixture, 'js', 'user-posts.js'), 'const USER_POSTS = [{"id":');
    const r = genFeed(fixture, false);
    record('P11', 'RSS 生成失败 → 非 0 退出且不改写已有 feed.xml',
      r.code !== 0 && sha256(feedPath) === h0,
      `rc=${r.code} feed未变=${sha256(feedPath) === h0}`, 'ok');
    fs.writeFileSync(path.join(fixture, 'js', 'user-posts.js'), originUserPosts);
    genFeed(fixture, false);   // 复原
  }

  // ---------- P12 派生数据生成中途异常：原子性
  {
    const idx = path.join(fixture, 'data', 'search-index.json');
    const man = path.join(fixture, 'data', 'posts', 'manifest.json');
    const h1 = sha256(idx), h2 = sha256(man);
    const mdPath = path.join(fixture, 'data', 'posts', 'embodied-ai-notes.md');
    const orig = fs.readFileSync(mdPath, 'utf8');
    // 制造"元数据存在但正文读不了"的异常
    fs.unlinkSync(mdPath);
    const r = splitSync(fixture, false);
    record('P12', '派生数据生成中途失败 → 非 0 退出且搜索语料/清单未被改写',
      r.code !== 0 && sha256(idx) === h1 && sha256(man) === h2,
      `rc=${r.code} index未变=${sha256(idx) === h1} manifest未变=${sha256(man) === h2}`, 'ok');
    fs.writeFileSync(mdPath, orig);
    const fix = splitSync(fixture, false);
    record('P12b', '恢复正文后可重新同步成功', fix.code === 0, `rc=${fix.code}`, 'ok');
  }

  // ---------- P13 用户文章与内置文章重复 ID
  {
    const dup = originUserPosts.replace('const USER_POSTS = [];',
      'const USER_POSTS = [{"id":"embodied-ai-notes","title":"冒名文章","date":"2026-11-09","tags":["x"],"excerpt":"e","content":"# dup\\n"}];');
    fs.writeFileSync(path.join(fixture, 'js', 'user-posts.js'), dup);
    const r = genFeed(fixture, false);
    const feed = fs.readFileSync(path.join(fixture, 'feed.xml'), 'utf8');
    const links = (feed.match(/<link>https:\/\/ericzhao666\.github\.io\/blog\/#\/post\/embodied-ai-notes<\/link>/g) || []).length;
    const warned = /重复|duplicate/i.test(r.out + ' ' + r.err);
    record('P13', '重复 ID：RSS 按 id 去重（只发 1 条）并打警告，但生成器仍返回 0',
      r.code === 0 && links === 1 && warned,
      `rc=${r.code} 同 link 条目=${links} 有警告=${warned}`, 'defect');

    // 客户端侧：页面加载的是真实 user-posts.js（空），这里把重复项注入内存模拟"文件里已有重复 id"
    const { dom, window } = await openPage('#/');
    const hit = window.eval(`(function(){
      USER_POSTS.push({ id: 'embodied-ai-notes', title: '冒名文章', date: '2026-11-09', tags: ['x'], excerpt: 'e', content: '# dup' });
      var all = getAllPosts();
      var found = all.filter(function(x){ return x.id === 'embodied-ai-notes'; });
      return { total: found.length, firstTitle: found[0] && found[0].title,
               homeHasDup: document.getElementById('app').textContent.indexOf('冒名文章') !== -1 };
    })()`);
    // 客户端按日期倒序后"新日期的那条"排前面，所以重复 id 时用户文章会顶掉内置文章，
    // 而 gen_feed.py 去重保留 data.js（内置）—— 同一个 id 在页面与 RSS 里指向不同文章。
    record('P13b', '重复 ID：客户端按日期倒序让用户文章顶掉内置文章，而 RSS 保留内置文章（两边不一致）',
      hit.total === 2 && hit.firstTitle === '冒名文章',
      `条数=${hit.total} 客户端命中=${hit.firstTitle} / RSS 保留=内置`, 'defect');
    dom.window.close();
    fs.writeFileSync(path.join(fixture, 'js', 'user-posts.js'), originUserPosts);
    genFeed(fixture, false);
  }

  // ---------- P14 更新正文后旧搜索词仍命中（静态语料）
  {
    const idxPath = path.join(fixture, 'data', 'search-index.json');
    const before = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const mdPath = path.join(fixture, 'data', 'posts', 'embodied-ai-notes.md');
    const orig = fs.readFileSync(mdPath, 'utf8');
    const marker = '批次7C1唯一标记词';
    fs.writeFileSync(mdPath, orig + '\n\n' + marker + '\n');
    const stale = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const staleHit = JSON.stringify(stale).indexOf(marker) !== -1;
    const chk = splitCheck(fixture);
    const sync = splitSync(fixture, false);
    const fresh = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const freshHit = JSON.stringify(fresh).indexOf(marker) !== -1;
    record('P14', '改了正文但没跑生成器 → 新词搜不到、--check 失败；跑 sync 后才有',
      !staleHit && chk.code !== 0 && sync.code === 0 && freshHit,
      `改前命中=${staleHit} check=${chk.code} sync=${sync.code} 改后命中=${freshHit}`, 'defect');
    fs.writeFileSync(mdPath, orig);
    splitSync(fixture, false);
    void before;
  }

  // ---------- P15 并发生成
  {
    const dir = makeFixture('race');
    const idxPath = path.join(dir, 'data', 'search-index.json');
    const mdPath = path.join(dir, 'data', 'posts', 'rl-from-mdp-to-ppo.md');
    fs.writeFileSync(mdPath, fs.readFileSync(mdPath, 'utf8') + '\n\n并发改写标记\n');
    const spawn = () => spawnSync('python', ['scripts/split_posts.py', '--sync', '--root', dir], { cwd: ROOT, encoding: 'utf8' });
    const [a, b] = await Promise.all([
      new Promise(r => setImmediate(() => r(spawn()))),
      new Promise(r => setImmediate(() => r(spawn())))
    ]);
    let jsonOk = false, manifestOk = false;
    try { JSON.parse(fs.readFileSync(idxPath, 'utf8')); jsonOk = true; } catch (e) { jsonOk = false; }
    try { JSON.parse(fs.readFileSync(path.join(dir, 'data', 'posts', 'manifest.json'), 'utf8')); manifestOk = true; } catch (e) { manifestOk = false; }
    record('P15', '两轮生成同时跑 → 产物不会半截（原子替换），但无互斥锁',
      jsonOk && manifestOk,
      `rc=${a.status}/${b.status} 语料可解析=${jsonOk} 清单可解析=${manifestOk}`, 'ok');
  }

  // ---------- P16 部署混版（源与派生不同版本）
  {
    const dir = makeFixture('mixed');
    const dataPath = path.join(dir, 'js', 'data.js');
    const src = fs.readFileSync(dataPath, 'utf8');
    fs.writeFileSync(dataPath, src.replace(/(id: 'embodied-ai-notes',[\s\S]*?title: ')[^']*(')/, '$1改过标题$2'));
    const chk = splitCheck(dir);
    record('P16', '只改源、未重生成派生数据 → --check 失败（CI 挡住混版）',
      chk.code !== 0, `check rc=${chk.code} ${(chk.err || chk.out).split('\n')[0].slice(0, 60)}`, 'ok');
  }

  // ============================================================ 汇总
  await new Promise(r => server.close(r));
  const defects = rows.filter(r => r.verdict === 'defect');
  console.log('\n共 ' + rows.length + ' 项：符合现状 ' + pass + '，不符合预期 ' + fail);
  console.log('确认缺陷/风险 ' + defects.length + ' 项：' + defects.map(r => r.id).join(', '));
  console.log('（本脚本只取证，不作为 CI 门禁；CI 门禁仍是 python scripts/run_tests.py）');
  process.exit(0);
})().catch(e => {
  console.error('SCENARIO ERROR:', e && e.stack || e);
  process.exit(2);
});
