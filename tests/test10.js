// B2-01 发布历史数据保护回归（Batch 8A：契约改为「导出」，保护强度只增不减）
//
// 历史意图（保持不变）：**只要无法确认"历史内容不会被破坏"，就绝不写远端。**
//   * Batch 2   ：编辑器整文件读写 js/user-posts.js → 必须模拟 GitHub API 才敢发布；
//   * Batch 7C-3A：改成只往 content/queue/<id>.json 写一个文件；
//   * Batch 8A  ：编辑器彻底不联网 —— 导出只是本地文件，发布改由
//                  scripts/import_post.py 在本地完成（它自己保证不覆盖历史正文）。
//
// 因此这里把 10 个场景改成验证新契约下的**更强**保证：
//   C1  正常导出：零网络请求、零历史写入、载荷只有这一篇
//   C2  导出物字段固定且可被 JSON.parse
//   C3  空标题 → 本地拦截，不产生文件、不发请求
//   C4  空正文 → 本地拦截
//   C5  非法 id → 本地拦截
//   C6  与已发布文章同 id → 本地拦截
//   C7  导出失败（下载异常）→ 明确报错且草稿保留
//   C8  导出成功 → 草稿仍然保留（8A 不再静默删稿，用户可继续编辑）
//   C9  历史文章集合（POSTS / USER_POSTS）在导出前后完全不变
//   C10 断网（fetch 全部拒绝）也能导出；重复导出同一篇 → 同一 id（幂等）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8135;
const BASE = 'http://localhost:' + PORT;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = true;
let total = 0;
const check = (name, cond, extra) => {
  total++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  (' + String(extra).slice(0, 90) + ')' : ''));
  if (!cond) pass = false;
};

function readDraft(window) {
  try { return JSON.parse(window.localStorage.getItem('blog_draft') || 'null'); } catch (e) { return null; }
}

async function openEditor() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented: (window\.scrollTo|Window's scrollTo|scrollIntoView)/.test(e.message)) errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(String(a[0])));
  const dom = await JSDOM.fromURL(BASE + '/index.html#/editor', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
  });
  const { window } = dom;
  const doc = window.document;
  await new Promise(r => window.addEventListener('load', r));
  await wait(450);
  window.localStorage.removeItem('blog_draft');
  return { dom, window, doc, errors };
}

// 任何网络请求都算违规：计数并让请求失败（提示"断网也能导出"）
function blockNetwork(window) {
  const state = { calls: 0, urls: [] };
  window.fetch = function (url) {
    state.calls++;
    state.urls.push(String(url));
    return Promise.reject(new TypeError('Failed to fetch (network disabled by test10)'));
  };
  return state;
}

function captureDownloads(window) {
  const out = [];
  window.__downloadText = function (text, filename) { out.push({ text: text, filename: filename }); };
  return out;
}

function fill(doc, title, content) {
  doc.getElementById('editorTitle').value = title;
  doc.getElementById('editorTags').value = '测试, 技术笔记';
  doc.getElementById('editorExcerpt').value = '摘要（与正文关键词无关）';
  doc.getElementById('editorContent').value = content;
}

const snapshotPosts = window0 => window0.eval(
  'JSON.stringify({ posts: POSTS.map(function (p) { return p.id; }),' +
  ' user: USER_POSTS.map(function (p) { return p.id; }) })');

server.listen(PORT, async () => {
  try {
    // ---------------------------------------------------------------- C1/C2/C9/C10
    {
      const { dom, window, doc, errors } = await openEditor();
      const net = blockNetwork(window);
      const downloads = captureDownloads(window);
      const before = snapshotPosts(window);

      fill(doc, '历史保护测试文章', '# 历史保护\n\n正文只属于这篇文章。\n');
      const ok = window.exportPost();
      await wait(60);

      check('C1 导出成功', ok === true);
      check('C1 全程零网络请求（不再有 GitHub API 调用）', net.calls === 0, net.urls.slice(0, 1).join(','));
      check('C1 只产生一个文件', downloads.length === 1, downloads.length);

      const payload = JSON.parse(downloads[0].text);
      check('C2 导出物字段顺序固定',
        Object.keys(payload).join(',') === 'id,title,date,tags,excerpt,content', Object.keys(payload).join(','));
      check('C2 载荷只有这一篇（不含历史文章）',
        typeof payload.id === 'string' && typeof payload.content === 'string' &&
        !Array.isArray(payload), payload.id);
      check('C2 正文与输入一致（trim 规范后）',
        payload.content === '# 历史保护\n\n正文只属于这篇文章。');

      check('C9 POSTS / USER_POSTS 在导出前后完全不变', snapshotPosts(window) === before);

      // 重复导出同一篇：id 必须稳定（避免在 data/posts 里留下两份正文）
      const again = window.buildExportPayload();
      check('C10 重复导出使用同一 id（幂等）', again.ok && again.post.id === payload.id, again.post.id);
      check('C10 文件名仍是 <id>.json', downloads[0].filename === payload.id + '.json', downloads[0].filename);

      check('C1 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
      dom.window.close();
    }

    // ---------------------------------------------------------------- C3/C4 空标题/空正文
    {
      const { dom, window, doc } = await openEditor();
      const net = blockNetwork(window);
      const downloads = captureDownloads(window);

      fill(doc, '', '# 有正文\n');
      check('C3 空标题被本地拦截', window.exportPost() === false &&
        /标题不能为空/.test(doc.getElementById('editorStatus').textContent));
      check('C3 空标题不产生文件、不发请求', downloads.length === 0 && net.calls === 0);

      fill(doc, '有标题但没正文', '   \n');
      check('C4 空正文被本地拦截', window.exportPost() === false &&
        /正文不能为空/.test(doc.getElementById('editorStatus').textContent));
      check('C4 空正文不产生文件、不发请求', downloads.length === 0 && net.calls === 0);
      dom.window.close();
    }

    // ---------------------------------------------------------------- C5 非法 id
    {
      const { dom, window, doc } = await openEditor();
      const net = blockNetwork(window);
      const downloads = captureDownloads(window);
      window.eval("generatePostId = function () { return 'Bad_ID!'; };");
      fill(doc, '非法 id', '# x\n');
      check('C5 非法 id 被本地拦截', window.exportPost() === false &&
        /id 非法/.test(doc.getElementById('editorStatus').textContent));
      check('C5 非法 id 不产生文件、不发请求', downloads.length === 0 && net.calls === 0);
      dom.window.close();
    }

    // ---------------------------------------------------------------- C6 与已有文章同 id
    {
      const { dom, window, doc } = await openEditor();
      const net = blockNetwork(window);
      const downloads = captureDownloads(window);
      const existing = window.eval('POSTS[0].id');
      window.eval("generatePostId = function () { return '" + existing + "'; };");
      fill(doc, '撞已有 id', '# x\n');
      check('C6 同 id 被本地拦截', window.exportPost() === false &&
        /id 冲突/.test(doc.getElementById('editorStatus').textContent));
      check('C6 同 id 不产生文件、不发请求', downloads.length === 0 && net.calls === 0);
      dom.window.close();
    }

    // ---------------------------------------------------------------- C7 导出失败保草稿
    {
      const { dom, window, doc } = await openEditor();
      const net = blockNetwork(window);
      window.__downloadText = function () { throw new Error('download blocked'); };
      fill(doc, '导出会失败', '# 这段内容不能丢\n\n正文。\n');
      const ok = window.exportPost();
      await wait(60);
      check('C7 导出失败返回 false', ok === false);
      check('C7 导出失败有明确提示', /导出失败/.test(doc.getElementById('editorStatus').textContent));
      check('C7 导出失败草稿保留', /这段内容不能丢/.test((readDraft(window) || {}).content || ''));
      check('C7 导出失败也没有发请求', net.calls === 0);
      dom.window.close();
    }

    // ---------------------------------------------------------------- C8 导出成功保留草稿
    {
      const { dom, window, doc } = await openEditor();
      blockNetwork(window);
      captureDownloads(window);
      fill(doc, '导出成功也要留草稿', '# 可继续编辑\n');
      window.exportPost();
      await wait(60);
      const draft = readDraft(window);
      check('C8 导出成功后草稿仍在（8A 不再静默删稿）', draft !== null);
      check('C8 草稿内容可用于继续编辑', (draft || {}).content === '# 可继续编辑\n', (draft || {}).content);
      check('C8 重新进入编辑器会回填草稿', (function () {
        window.location.hash = '#/';
        return true;
      })());
      await wait(200);
      window.location.hash = '#/editor';
      await wait(500);
      check('C8 回填后的正文与草稿一致',
        doc.getElementById('editorContent').value === '# 可继续编辑\n',
        doc.getElementById('editorContent').value.slice(0, 20));
      dom.window.close();
    }
  } catch (e) {
    console.error('SMOKE ERROR:', e && e.stack || e);
    pass = false;
  }

  console.log('\n共 ' + total + ' 项，' + (pass ? 'ALL PASS' : 'HAS FAILURES'));
  server.close();
  process.exit(pass ? 0 : 1);
});
